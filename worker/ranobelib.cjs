const path = require('node:path');
const readline = require('node:readline');
const { setTimeout: sleep } = require('node:timers/promises');

const WEB_ORIGIN = 'https://ranobelib.me';
const API_ORIGIN = 'https://api.cdnlibs.org';
const TEAM_ID = 11969;
const TEAM_PATH = '/ru/team/11969--dom-nekromanta';
const TEAM_URL = WEB_ORIGIN + TEAM_PATH;
const SITE_ID = '3';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const POSITIVE_ID = /^[1-9]\d*$/;
const SLUG = /^[\p{L}\p{N}_-]{1,250}$/u;
const MESSAGES = {
	login_required: 'Войдите в RanobeLIB в окне приложения и проверьте, что аккаунту доступны запланированные главы команды.',
	team_access: 'Войдите в аккаунт, у которого есть доступ к управлению командой «Дом некроманта» на RanobeLIB.',
	browser_missing: 'Для проверки RanobeLIB требуются установленный Microsoft Edge или Google Chrome и браузерный помощник приложения.',
	rate_limited: 'RanobeLIB ограничил частоту запросов. Повторите проверку позже.',
	network: 'Не удалось связаться с RanobeLIB. Повторите проверку позже.',
	schema: 'RanobeLIB вернул неполные или неподдерживаемые данные.',
	cancelled: 'Проверка остановлена.',
};

class WorkerError extends Error {
	constructor(code, message = MESSAGES[code]) {
		super(message);
		this.code = code;
	}
}

function safeId(value) {
	if (typeof value !== 'number' && (typeof value !== 'string' || !POSITIVE_ID.test(value))) {
		throw new WorkerError('schema');
	}
	const integer = Number(value);
	if (!Number.isSafeInteger(integer) || integer <= 0) throw new WorkerError('schema');
	return integer;
}

function catalogUrl(status) {
	const url = new URL('/api/manga', API_ORIGIN);
	url.searchParams.set('target_id', String(TEAM_ID));
	url.searchParams.set('target_model', 'team');
	url.searchParams.set('site_id[0]', SITE_ID);
	url.searchParams.set('scanlate_status[0]', status === 'ongoing' ? '1' : '2');
	return url;
}

async function readAll(get, url, paginated = false) {
	const rows = [];
	let pageCount;
	let total;
	for (let page = 1; ; page++) {
		const requestUrl = new URL(url);
		if (paginated || page > 1) requestUrl.searchParams.set('page', String(page));
		const result = await get(requestUrl);
		if (!Array.isArray(result?.data)) throw new WorkerError('schema');
		rows.push(...result.data);
		const hasPageInfo = result.meta?.current_page !== undefined || result.meta?.last_page !== undefined;
		if (!paginated && !hasPageInfo && result.links?.next == null) return rows;
		const currentPage = safeId(result.meta?.current_page);
		const lastPage = safeId(result.meta?.last_page);
		if (currentPage !== page || lastPage > 100 || page > lastPage || (pageCount && pageCount !== lastPage)) {
			throw new WorkerError('schema');
		}
		pageCount = lastPage;
		if (result.meta.total !== undefined) {
			const currentTotal = Number(result.meta.total);
			if (!Number.isSafeInteger(currentTotal) || currentTotal < 0 || (total !== undefined && total !== currentTotal)) {
				throw new WorkerError('schema');
			}
			total = currentTotal;
		}
		if (page === lastPage) {
			if (total !== undefined && total !== rows.length) throw new WorkerError('schema');
			return rows;
		}
		if (result.data.length === 0) throw new WorkerError('schema');
	}
}

async function readCatalog(get, status) {
	const rows = await readAll(get, catalogUrl(status), true);
	const seen = new Set();
	return rows.map(row => {
		const id = safeId(row?.id);
		const prefix = `${id}--`;
		const slug = [row.slug_url, row.slug].find(value => typeof value === 'string' && value.startsWith(prefix) && SLUG.test(value.slice(prefix.length)))
			?? (typeof row.slug === 'string' && SLUG.test(row.slug) ? prefix + row.slug : undefined);
		const title = [row.rus_name, row.name, row.eng_name].find(value => typeof value === 'string' && value.trim());
		if (!slug || !title || seen.has(id)) throw new WorkerError('schema');
		seen.add(id);
		return { id, slug, title: title.trim(), status };
	});
}

function publicationTime(value) {
	// This field can be absent on published chapters. Only explicit, time-zoned values
	// show an upcoming release. A missing branch or malformed date invalidates the count.
	if (value == null) return undefined;
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
		throw new WorkerError('schema');
	}
	const millis = Date.parse(value);
	if (!Number.isFinite(millis)) throw new WorkerError('schema');
	return millis;
}

async function readObservation(get, item, now) {
	const branchRows = await readAll(get, new URL(`/api/branches/${item.id}`, API_ORIGIN));
	const ourBranches = new Set();
	const branchIds = new Set();
	let shared = false;
	for (const row of branchRows) {
		const id = safeId(row?.id);
		if (!Array.isArray(row.teams) || branchIds.has(id)) throw new WorkerError('schema');
		branchIds.add(id);
		const teamIds = new Set(row.teams.map(team => safeId(team?.id)));
		if (teamIds.has(TEAM_ID)) ourBranches.add(id);
		if ([...teamIds].some(teamId => teamId !== TEAM_ID)) shared = true;
	}
	if (ourBranches.size === 0) throw new WorkerError('schema', 'В списке веток не найдена ветка команды.');

	const chapterRows = await readAll(get, new URL(`/api/manga/${encodeURIComponent(item.slug)}/chapters`, API_ORIGIN));
	let ownsChapters = false;
	let earliestFuture = Infinity;
	let lastRelease = -Infinity;
	const scheduled = new Set();
	for (const row of chapterRows) {
		const chapterId = safeId(row?.id);
		if (!Array.isArray(row.branches) || row.branches.length === 0) throw new WorkerError('schema');
		for (const branch of row.branches) {
			const branchId = safeId(branch?.branch_id);
			if (!branchIds.has(branchId)) throw new WorkerError('schema');
			if (!ourBranches.has(branchId)) continue;
			ownsChapters = true;
			const time = publicationTime(branch.publish_at);
			if (time === undefined) continue;
			if (time > now.getTime()) {
				scheduled.add(chapterId);
				earliestFuture = Math.min(earliestFuture, time);
			} else {
				lastRelease = Math.max(lastRelease, time);
			}
		}
	}
	if (!ownsChapters) throw new WorkerError('schema', 'В списке глав не найдена ветка команды.');

	return {
		state: 'known',
		scheduled: scheduled.size,
		lastPublishAt: Number.isFinite(lastRelease) ? new Date(lastRelease).toISOString() : undefined,
		checkedAt: now.toISOString(),
		nextCheckAt: new Date(Math.min(now.getTime() + DAY, earliestFuture + 2 * MINUTE)).toISOString(),
		shared,
	};
}

async function scanTeam(get, input, now = new Date()) {
	const ongoing = await readCatalog(get, 'ongoing');
	const completed = await readCatalog(get, 'completed');
	const completedIds = new Set(completed.map(item => item.id));
	const knownById = new Map(input.known.map(item => [item.id, item]));
	const items = ongoing.filter(item => !completedIds.has(item.id)).concat(completed);
	const due = items.filter(item => {
		if (item.status !== 'ongoing') return false;
		const prior = knownById.get(item.id);
		return input.force || prior?.status !== 'ongoing' || !(Date.parse(prior.nextCheckAt) > now.getTime());
	});
	let nextTitle = 0;
	let consecutiveNetworkErrors = 0;
	let fatalError;
	const guardedGet = async url => {
		if (fatalError) throw fatalError;
		return get(url);
	};
	const checkTitles = async () => {
		while (!fatalError && nextTitle < due.length) {
			const item = due[nextTitle++];
			try {
				// Repeated transport failures indicate the service is unavailable.
				if (consecutiveNetworkErrors >= 3) throw new WorkerError('network');
				item.observation = await readObservation(guardedGet, item, now);
				consecutiveNetworkErrors = 0;
			} catch (error) {
				if (!(error instanceof WorkerError) || (error.code !== 'network' && error.code !== 'schema')) {
					fatalError ??= error;
					return;
				}
				consecutiveNetworkErrors = error.code === 'network' ? consecutiveNetworkErrors + 1 : 0;
				item.observation = {
					state: 'unknown',
					checkedAt: now.toISOString(),
					nextCheckAt: new Date(now.getTime() + 15 * MINUTE).toISOString(),
					message: error.message,
				};
			}
		}
	};
	await Promise.all([checkTitles(), checkTitles()]);
	if (fatalError) throw fatalError;
	return { ok: true, scannedAt: now.toISOString(), items };
}

function retryDelay(header) {
	if (!header) return 750;
	const seconds = Number(header);
	if (Number.isFinite(seconds)) return Math.max(750, seconds * 1000);
	const retryAt = Date.parse(header);
	return Number.isFinite(retryAt) ? Math.max(750, retryAt - Date.now()) : 750;
}

function apiReader(read, wait = sleep) {
	return async url => {
		if (url.origin !== API_ORIGIN || url.username || url.password || !(
			url.pathname === '/api/manga' ||
			/^\/api\/branches\/[1-9]\d*$/.test(url.pathname) ||
			/^\/api\/manga\/[1-9]\d*--[^/]+\/chapters$/.test(url.pathname)
		)) {
			throw new WorkerError('schema');
		}
		for (let attempt = 0; attempt < 2; attempt++) {
			let response;
			try {
				response = await read(url);
			} catch (error) {
				if (error instanceof WorkerError) throw error;
				if (attempt !== 0) throw new WorkerError('network');
				await wait(750);
				continue;
			}
			let delay;
			try {
				const status = response.status();
				if (status === 401 || status === 403) throw new WorkerError('login_required');
				if (status === 429 || status >= 500) {
					delay = retryDelay(response.headers()['retry-after']);
					if (attempt !== 0 || delay > 3000) throw new WorkerError(status === 429 ? 'rate_limited' : 'network');
				} else {
					if (status !== 200) throw new WorkerError('schema');
					try {
						return await response.json();
					} catch {
						throw new WorkerError('schema');
					}
				}
			} finally {
				await response.dispose().catch(() => {});
			}
			await wait(delay);
		}
	};
}

async function readBrowserAuthorization(response) {
	try {
		const url = new URL(response.url());
		if (url.origin !== API_ORIGIN || url.pathname !== '/api/auth/me' || response.status() !== 200) return;
		const request = response.request();
		if (request.method() !== 'GET') return;
		const frame = request.frame();
		if (frame.parentFrame() || new URL(frame.url()).origin !== WEB_ORIGIN || request.redirectedFrom?.()) return;
		const authorization = await request.headerValue('authorization');
		if (typeof authorization === 'string' && /^Bearer [^\s]+$/i.test(authorization)) return authorization;
	} catch {
		// Service-worker responses or pages closed during navigation lack a usable frame.
	}
}

async function launchBrowser(profilePath, headless) {
	let chromium;
	try {
		({ chromium } = require('playwright-core'));
	} catch {
		throw new WorkerError('browser_missing');
	}
	for (const channel of ['msedge', 'chrome']) {
		try {
			return await chromium.launchPersistentContext(profilePath, {
				channel,
				headless,
				timeout: 12_000,
				acceptDownloads: false,
				serviceWorkers: headless ? 'block' : 'allow',
			});
		} catch (error) {
			if (!/executable (?:doesn't exist|not found)|distribution .* is not found/i.test(error.message)) {
				throw new WorkerError('network', 'Не удалось открыть выделенный профиль браузера RanobeLIB.');
			}
		}
	}
	throw new WorkerError('browser_missing');
}

async function accountVisible(page) {
	try {
		if (new URL(page.url()).origin !== WEB_ORIGIN) return false;
		return await page.locator('a[href*="/ru/user/"]:has(img[alt="Аватар пользователя"]):visible').evaluateAll(anchors => (
			anchors.some(anchor => anchor.origin === location.origin && /^\/ru\/user\/\d+(?:--[^/]+)?\/?$/.test(anchor.pathname))
		));
	} catch {
		return false;
	}
}

async function openTeamPage(page) {
	try {
		const response = await page.goto(TEAM_URL, { waitUntil: 'domcontentloaded', timeout: 18_000 });
		if (response?.status() === 429) throw new WorkerError('rate_limited');
		if (response?.status() >= 500) throw new WorkerError('network');
		if (response?.status() >= 400) throw new WorkerError('schema');
		const url = new URL(page.url());
		if (url.origin !== WEB_ORIGIN) throw new WorkerError('login_required');
	} catch (error) {
		if (error instanceof WorkerError) throw error;
		throw new WorkerError('network');
	}
}

function isTeamPage(page) {
	const url = new URL(page.url());
	return url.origin === WEB_ORIGIN && url.pathname.replace(/\/$/, '') === TEAM_PATH;
}

async function waitForTeamEdit(page) {
	try {
		if (!isTeamPage(page)) throw new WorkerError('team_access');
		await page.locator(`a[href="${TEAM_PATH}/edit"]`).first().waitFor({ state: 'visible', timeout: 5_000 });
	} catch {
		throw new WorkerError('team_access');
	}
}

async function runBrowser(command, profilePath, request, signal) {
	signal.throwIfAborted();
	const headless = command === 'scan';
	const context = await launchBrowser(profilePath, headless);
	const closeContext = () => { void context.close().catch(() => {}); };
	signal.addEventListener('abort', closeContext, { once: true });
	try {
		signal.throwIfAborted();
		context.setDefaultTimeout(3_000);
		if (headless) {
			await context.route('**/*', route => {
				const method = route.request().method();
				return method === 'GET' || method === 'HEAD' || method === 'OPTIONS' ? route.continue() : route.abort();
			});
		}

		let authorization;
		context.on('response', async response => {
			const observed = await readBrowserAuthorization(response);
			if (observed) authorization = observed;
		});
		const page = context.pages()[0] ?? await context.newPage();
		await openTeamPage(page);

		const deadline = Date.now() + (headless ? 15_000 : 10 * MINUTE);
		while (Date.now() < deadline) {
			const pages = context.pages();
			for (const candidate of pages) {
				if (!(await accountVisible(candidate)) || !authorization) continue;
				// The account can sign in through another tab and return to the homepage.
				if (!isTeamPage(candidate)) await openTeamPage(candidate);
				await waitForTeamEdit(candidate);
				if (!headless) return { ok: true };
				let nextRequestAt = 0;
				const get = apiReader(async url => {
					let delay = nextRequestAt - Date.now();
					while (delay > 0) {
						await sleep(delay, undefined, { signal });
						delay = nextRequestAt - Date.now();
					}
					signal.throwIfAborted();
					nextRequestAt = Date.now() + 180;
					return context.request.get(url.href, {
						headers: {
							accept: 'application/json',
							authorization,
							origin: WEB_ORIGIN,
							referer: TEAM_URL,
						},
						timeout: 7_000,
						maxRedirects: 0,
					});
				}, delay => {
					// Backoff applies to both title readers.
					nextRequestAt = Math.max(nextRequestAt, Date.now() + delay);
					return sleep(delay, undefined, { signal });
				});
				return await scanTeam(get, request);
			}
			if (!pages.length) break;
			await sleep(300, undefined, { signal });
		}
		throw new WorkerError('login_required');
	} finally {
		signal.removeEventListener('abort', closeContext);
		await context.close().catch(() => {});
	}
}

function scanInput(line) {
	try {
		const input = JSON.parse(line);
		if (!Array.isArray(input?.known) || typeof input.force !== 'boolean') throw new WorkerError('schema');
		for (const item of input.known) {
			if (typeof item?.id !== 'number' || typeof item.status !== 'string') throw new WorkerError('schema');
			safeId(item.id);
		}
		return input;
	} catch {
		throw new WorkerError('schema', 'Не удалось прочитать команду проверки.');
	}
}

async function runWorker([command, profilePath], input, output) {
	const abort = new AbortController();
	const lines = readline.createInterface({ input, terminal: false, crlfDelay: Infinity });
	const firstLine = command === 'scan' ? new Promise(resolve => {
		lines.once('line', resolve);
		lines.once('close', () => resolve(''));
	}) : Promise.resolve(undefined);
	let waitingForScanInput = command === 'scan';
	lines.on('line', line => {
		if (waitingForScanInput) {
			waitingForScanInput = false;
			return;
		}
		// The parent owns this pipe and can stop a worker without waiting for a site timeout.
		if (/^\s*\{\s*"cancel"\s*:\s*true\s*\}\s*$/.test(line)) abort.abort(new WorkerError('cancelled'));
	});
	lines.once('close', () => abort.abort(new WorkerError('cancelled')));

	let result;
	try {
		if ((command !== 'scan' && command !== 'login') || typeof profilePath !== 'string' || !path.isAbsolute(profilePath)) {
			throw new WorkerError('schema', 'Некорректная команда браузерного помощника.');
		}
		const request = command === 'scan' ? scanInput(await firstLine) : undefined;
		result = await runBrowser(command, profilePath, request, abort.signal);
	} catch (error) {
		const failure = abort.signal.aborted && !(error instanceof WorkerError && error.code === 'schema')
			? abort.signal.reason
			: error instanceof WorkerError ? error : new WorkerError('network');
		result = { ok: false, code: failure.code, message: failure.message };
	} finally {
		lines.close();
		input.pause();
	}
	output.write(JSON.stringify(result) + '\n');
}

if (require.main === module) {
	void runWorker(process.argv.slice(2), process.stdin, process.stdout);
}

module.exports = { apiReader, readBrowserAuthorization, runWorker, scanTeam, waitForTeamEdit };
