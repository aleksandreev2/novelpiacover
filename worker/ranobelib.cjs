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
// Leave room in the API quota for the browser's own requests.
const REQUEST_SPACING_MS = 1_150;
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
	constructor(code, message = MESSAGES[code], context = {}) {
		super(message);
		this.code = code;
		this.context = context;
	}
}

function tagError(error, context) {
	if (error instanceof WorkerError) error.context = { ...context, ...error.context };
	return error;
}

async function atStage(stage, run, context = {}) {
	try {
		return await run();
	} catch (error) {
		throw tagError(error, { stage, ...context });
	}
}

function diagnostic(error) {
	return { stage: 'worker', ...error.context, code: error.code, message: error.message };
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
	let seed;
	for (let page = 1; page <= 100; page++) {
		const requestUrl = new URL(url);
		if (paginated || page > 1) requestUrl.searchParams.set('page', String(page));
		if (seed) requestUrl.searchParams.set('seed', seed);
		const result = await get(requestUrl).catch(error => { throw tagError(error, { page }); });
		const invalid = message => new WorkerError('schema', message, { page });
		if (!Array.isArray(result?.data)) throw invalid('В ответе RanobeLIB нет списка записей.');
		rows.push(...result.data);
		const meta = result.meta;
		const hasPageInfo = meta?.current_page !== undefined || meta?.last_page !== undefined || meta?.has_next_page !== undefined;
		if (!paginated && !hasPageInfo && result.links?.next == null) return rows;
		if (String(meta?.current_page) !== String(page)) throw invalid('В ответе указан неверный номер страницы.');

		let hasNext = meta.has_next_page;
		if (meta.last_page !== undefined) {
			const lastPage = safeId(meta.last_page);
			if (lastPage > 100 || page > lastPage || (pageCount && pageCount !== lastPage)) {
				throw invalid('Число страниц изменилось во время проверки.');
			}
			if (hasNext !== undefined && hasNext !== (page < lastPage)) throw invalid('Данные о следующей странице противоречат друг другу.');
			pageCount = lastPage;
			hasNext = page < lastPage;
		}
		if (typeof hasNext !== 'boolean') throw invalid('В ответе нет признака следующей страницы.');
		// Keep the ordering from page one and build every URL with the original filters.
		if (page === 1 && paginated && typeof meta.seed === 'string' && meta.seed) seed = meta.seed;
		if (meta.total !== undefined) {
			const currentTotal = Number(meta.total);
			if (!Number.isSafeInteger(currentTotal) || currentTotal < 0 || (total !== undefined && total !== currentTotal)) {
				throw invalid('Число записей изменилось во время проверки.');
			}
			total = currentTotal;
		}
		if ((hasNext || page > 1) && result.data.length === 0) throw invalid('RanobeLIB вернул пустую страницу внутри списка.');
		if (!hasNext) {
			if (total !== undefined && total !== rows.length) throw invalid('В загруженном списке не хватает записей.');
			return rows;
		}
	}
	throw new WorkerError('schema', 'В списке больше 100 страниц.');
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
		if (!slug || !title) throw new WorkerError('schema', 'В каталоге отсутствует название или ссылка тайтла.', { titleId: id });
		if (seen.has(id)) throw new WorkerError('schema', 'Один тайтл повторяется на страницах каталога.', { titleId: id });
		seen.add(id);
		return { id, slug, title: title.trim(), status };
	});
}

function publicationTime(value) {
	// This field can be absent on published chapters. Only explicit, time-zoned values
	// show an upcoming release. A missing branch or malformed date invalidates the count.
	if (value == null) return undefined;
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
		throw new WorkerError('schema', 'У главы некорректная дата запланированной публикации.');
	}
	const millis = Date.parse(value);
	if (!Number.isFinite(millis)) throw new WorkerError('schema', 'У главы некорректная дата запланированной публикации.');
	return millis;
}

function teamIds(record) {
	if (!Array.isArray(record.teams)) throw new WorkerError('schema', 'RanobeLIB не указал список команд для ветки или главы.');
	return record.teams.map(team => safeId(team?.id));
}

async function readBranchTeams(get, item) {
	const branchRows = await readAll(get, new URL(`/api/branches/${item.id}`, API_ORIGIN));
	const branchTeams = new Map();
	for (const row of branchRows) {
		const id = safeId(row?.id);
		if (branchTeams.has(id)) throw new WorkerError('schema', 'Одна ветка повторяется в списке.');
		branchTeams.set(id, teamIds(row));
	}
	return branchTeams;
}

async function readChapterSchedule(get, item, now, branchTeams) {
	const chapterRows = await readAll(get, new URL(`/api/manga/${encodeURIComponent(item.slug)}/chapters`, API_ORIGIN));
	if (chapterRows.length === 0) {
		return {
			state: 'empty',
			checkedAt: now.toISOString(),
			nextCheckAt: new Date(now.getTime() + 2 * DAY).toISOString(),
		};
	}
	let shared = [...branchTeams.values()].some(teams => teams.some(id => id !== TEAM_ID));
	let ownsChapters = false;
	let earliestFuture = Infinity;
	let lastRelease = -Infinity;
	const scheduled = new Set();
	for (const row of chapterRows) {
		const chapterId = safeId(row?.id);
		if (!Array.isArray(row.branches) || row.branches.length === 0) throw new WorkerError('schema', 'У главы нет данных о ветке или команде.');
		for (const branch of row.branches) {
			// RanobeLIB stores team attribution on the chapter when it has no separate branch.
			const unbranched = branch?.branch_id === null;
			const teams = unbranched ? teamIds(branch) : branchTeams.get(safeId(branch?.branch_id));
			if (!teams) throw new WorkerError('schema', 'В списке глав обнаружена неизвестная ветка.');
			if (unbranched && teams.some(id => id !== TEAM_ID)) shared = true;
			if (!teams.includes(TEAM_ID)) continue;
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
	if (!ownsChapters) throw new WorkerError('schema', 'В списке не найдены главы команды.');

	return {
		state: 'known',
		scheduled: scheduled.size,
		lastPublishAt: Number.isFinite(lastRelease) ? new Date(lastRelease).toISOString() : undefined,
		checkedAt: now.toISOString(),
		nextCheckAt: new Date(Math.min(now.getTime() + DAY, earliestFuture + 2 * MINUTE)).toISOString(),
		shared,
	};
}

async function readObservation(get, item, now) {
	const title = { titleId: item.id };
	const branches = await atStage('branches', () => readBranchTeams(get, item), title);
	return atStage('chapters', () => readChapterSchedule(get, item, now, branches), title);
}

async function scanTeam(get, input, now = new Date()) {
	const ongoing = await atStage('catalog-ongoing', () => readCatalog(get, 'ongoing'));
	const completed = await atStage('catalog-completed', () => readCatalog(get, 'completed'));
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
				if (consecutiveNetworkErrors >= 3) {
					throw new WorkerError('network', 'Тайтл отложен после повторных ошибок сети.', { stage: 'queue', titleId: item.id });
				}
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
					diagnostic: diagnostic(error),
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
				const http = { httpStatus: status };
				if (status === 401 || status === 403) throw new WorkerError('login_required', undefined, http);
				if (status === 429 || status >= 500) {
					delay = retryDelay(response.headers()['retry-after']);
					if (attempt !== 0 || delay > 3000) throw new WorkerError(status === 429 ? 'rate_limited' : 'network', undefined, http);
				} else {
					if (status !== 200) throw new WorkerError('schema', `RanobeLIB ответил кодом HTTP ${status}.`, http);
					try {
						return await response.json();
					} catch {
						throw new WorkerError('schema', 'Ответ RanobeLIB не удалось прочитать как JSON.', http);
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
		const status = response?.status();
		const http = { httpStatus: status };
		if (status === 429) throw new WorkerError('rate_limited', undefined, http);
		if (status >= 500) throw new WorkerError('network', undefined, http);
		if (status >= 400) throw new WorkerError('schema', `Страница команды ответила кодом HTTP ${status}.`, http);
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
	const context = await atStage('browser', () => launchBrowser(profilePath, headless));
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
		await atStage('team-page', () => openTeamPage(page));

		const deadline = Date.now() + (headless ? 15_000 : 10 * MINUTE);
		while (Date.now() < deadline) {
			const pages = context.pages();
			for (const candidate of pages) {
				if (!(await accountVisible(candidate)) || !authorization) continue;
				// The account can sign in through another tab and return to the homepage.
				if (!isTeamPage(candidate)) await atStage('team-page', () => openTeamPage(candidate));
				await atStage('team-access', () => waitForTeamEdit(candidate));
				if (!headless) return { ok: true };
				let nextRequestAt = 0;
				const get = apiReader(async url => {
					let delay = nextRequestAt - Date.now();
					while (delay > 0) {
						await sleep(delay, undefined, { signal });
						delay = nextRequestAt - Date.now();
					}
					signal.throwIfAborted();
					nextRequestAt = Date.now() + REQUEST_SPACING_MS;
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
		throw new WorkerError('login_required', undefined, { stage: 'session' });
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
		result = { ok: false, code: failure.code, message: failure.message, diagnostic: diagnostic(failure) };
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
