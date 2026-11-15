const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { test } = require('node:test');

const { apiReader, readBrowserAuthorization, runWorker, scanTeam, waitForTeamEdit } = require('./ranobelib.cjs');

const now = new Date('2026-11-15T10:00:00Z');
const earlier = '2026-11-15T08:00:00Z';
const later = '2026-11-16T08:00:00.000000Z';
const slug = 'example';

function title(id, properties = {}) {
	return { id, slug, slug_url: `${id}--${slug}`, rus_name: 'Пример', name: 'Example', ...properties };
}

function listing(data, current_page = 1, last_page = 1) {
	return {
		data,
		links: { next: current_page < last_page ? 'https://api.cdnlibs.org/api/manga?page=2' : null },
		meta: { current_page, last_page },
	};
}

function branch(id, ...teams) {
	return { id, teams: teams.map(teamId => ({ id: teamId, name: 'Example' })) };
}

function chapter(id, ...branches) {
	return {
		id,
		branches: branches.map(([branch_id, publish_at], index) => ({ id: id * 10 + index, branch_id, publish_at })),
	};
}

function records(data) {
	return { data };
}

function fixture({
	ongoing = { 1: listing([title(11)]) },
	completed = { 1: listing([]) },
	branches = { 11: records([branch(5, 11969)]) },
	chapters = { 11: records([chapter(101, [5, earlier])]) },
} = {}) {
	const calls = [];
	return {
		calls,
		get: async url => {
			assert.equal(url.origin, 'https://api.cdnlibs.org');
			if (url.pathname === '/api/manga') {
				assert.equal(url.searchParams.get('target_id'), '11969');
				assert.equal(url.searchParams.get('target_model'), 'team');
				assert.equal(url.searchParams.get('site_id[0]'), '3');
				const status = url.searchParams.get('scanlate_status[0]');
				assert.match(status, /^[12]$/);
				const page = Number(url.searchParams.get('page'));
				calls.push(`list:${status}:${page}`);
				return (status === '1' ? ongoing : completed)[page];
			}
			const branchPath = url.pathname.match(/^\/api\/branches\/(\d+)$/);
			const chapterPath = url.pathname.match(/^\/api\/manga\/(\d+)--example\/chapters$/);
			assert.ok(branchPath || chapterPath, url.pathname);
			const id = Number((branchPath || chapterPath)[1]);
			calls.push(`${branchPath ? 'branches' : 'chapters'}:${id}`);
			return (branchPath ? branches : chapters)[id];
		},
	};
}

test('paginates both catalog filters and only reads chapter lists for due ongoing titles', async () => {
	const { get, calls } = fixture({
		ongoing: { 1: listing([title(11)], 1, 2), 2: listing([title(12)], 2, 2) },
		completed: { 1: listing([title(13)], 1, 2), 2: listing([title(14)], 2, 2) },
	});
	const result = await scanTeam(get, { known: [{ id: 12, status: 'ongoing', nextCheckAt: later }], force: false }, now);
	assert.deepEqual(calls.filter(call => call.startsWith('list:')).sort(), ['list:1:1', 'list:1:2', 'list:2:1', 'list:2:2']);
	assert.deepEqual(calls.filter(call => !call.startsWith('list:')), ['branches:11', 'chapters:11']);
	assert.deepEqual(result.items.map(({ id, slug, title, status }) => [id, slug, title, status]), [
		[11, '11--example', 'Пример', 'ongoing'],
		[12, '12--example', 'Пример', 'ongoing'],
		[13, '13--example', 'Пример', 'completed'],
		[14, '14--example', 'Пример', 'completed'],
	]);
	assert.equal(result.items[1].observation, undefined);
});

test('reads RanobeLIB has_next_page catalog and keeps its seed across active pages', async () => {
	const seed = 'd90d65203d3233a6a4af4a81b3e255cb';
	const active = Array.from({ length: 76 }, (_, index) => title(index + 1));
	const completed = Array.from({ length: 55 }, (_, index) => title(index + 100));
	const calls = [];
	const get = async url => {
		if (url.pathname !== '/api/manga') assert.fail('Only catalog requests should be due');
		assert.equal(url.origin, 'https://api.cdnlibs.org');
		assert.equal(url.searchParams.get('target_id'), '11969');
		assert.equal(url.searchParams.get('site_id[0]'), '3');
		const status = url.searchParams.get('scanlate_status[0]');
		const page = Number(url.searchParams.get('page'));
		const hasNext = status === '1' && page === 1;
		assert.equal(url.searchParams.get('seed'), page === 2 ? seed : null);
		calls.push([status, page]);
		return {
			data: status === '1' ? active.slice((page - 1) * 60, page * 60) : completed,
			links: { next: hasNext ? 'http://api.cdnlibs.org/api/manga?page=2' : null },
			meta: {
				current_page: page,
				page,
				has_next_page: hasNext,
				per_page: 60,
				seed: page === 1 ? seed : 'c1b774653c3a4b38838ddb5edc582d7c',
			},
		};
	};
	const known = active.map(({ id }) => ({ id, status: 'ongoing', nextCheckAt: later }));
	const { items } = await scanTeam(get, { known, force: false }, now);
	assert.deepEqual(calls, [['1', 1], ['1', 2], ['2', 1]]);
	assert.deepEqual(items.map(item => item.id), [...active, ...completed].map(item => item.id));
	assert.equal(items.filter(item => item.status === 'completed').length, 55);
});

test('counts future chapters once across team branches and flags a shared team branch', async () => {
	const { get } = fixture({
		branches: { 11: records([branch(5, 11969), branch(6, 11969, 10), branch(7, 10)]) },
		chapters: { 11: records([
			chapter(101, [5, earlier]), chapter(102, [5, later], [6, later]),
			chapter(103, [7, later]), chapter(104, [5, now.toISOString()]),
			chapter(105, [5, null]), chapter(106, [6, later]),
		]) },
	});
	const { items: [{ observation }] } = await scanTeam(get, { known: [], force: true }, now);
	assert.equal(observation.state, 'known');
	assert.equal(observation.scheduled, 2);
	assert.equal(observation.lastPublishAt, '2026-11-15T10:00:00.000Z');
	assert.equal(observation.shared, true);
	assert.equal(observation.checkedAt, '2026-11-15T10:00:00.000Z');
	assert.ok(Date.parse(observation.nextCheckAt) > now.getTime());
});

test('reports zero when a valid team chapter list only has past releases', async () => {
	const { get } = fixture();
	const { items: [{ observation }] } = await scanTeam(get, { known: [], force: true }, now);
	assert.equal(observation.state, 'known');
	assert.equal(observation.scheduled, 0);
	assert.equal(observation.shared, false);
});

test('flags a title with a different team on a separate branch', async () => {
	const { get } = fixture({ branches: { 11: records([branch(5, 11969), branch(8, 10)]) } });
	const { items: [{ observation }] } = await scanTeam(get, { known: [], force: true }, now);
	assert.equal(observation.shared, true);
});

test('counts team chapters published without a separate branch and excludes other teams', async () => {
	const ours = { id: 11969 };
	const other = { id: 10 };
	const { get } = fixture({
		branches: { 11: records([]) },
		chapters: { 11: records([
			{ id: 101, branches: [{ branch_id: null, teams: [ours], publish_at: later }] },
			{ id: 102, branches: [{ branch_id: null, teams: [other], publish_at: later }] },
			{ id: 103, branches: [{ branch_id: null, teams: [ours], publish_at: earlier }] },
		]) },
	});
	const { items: [{ observation }] } = await scanTeam(get, { known: [], force: false }, now);
	assert.equal(observation.state, 'known');
	assert.equal(observation.scheduled, 1);
	assert.equal(observation.shared, true);
});

test('combines identified branches with chapters attributed directly to the team', async () => {
	const { get } = fixture({
		chapters: { 11: records([
			chapter(101, [5, later]),
			{ id: 102, branches: [{ branch_id: null, teams: [{ id: 11969 }], publish_at: later }] },
		]) },
	});
	const { items: [{ observation }] } = await scanTeam(get, { known: [], force: false }, now);
	assert.equal(observation.state, 'known');
	assert.equal(observation.scheduled, 2);
	assert.equal(observation.shared, false);
});

test('marks missing ownership, malformed timestamps, and incomplete chapter pages unknown', async t => {
	const cases = {
		'no team branch': { branches: { 11: records([branch(5, 10)]) } },
		'no chapter carrying a team branch': { chapters: { 11: records([chapter(101, [6, later])]) } },
		'empty chapter list': { chapters: { 11: records([]) } },
		'no attribution on unbranched chapter': { chapters: { 11: records([chapter(101, [null, later])]) } },
		'invalid publication timestamp': { chapters: { 11: records([chapter(101, [5, 'invalid'])]) } },
		'advertised second page unavailable': { chapters: { 11: listing([chapter(101, [5, earlier])], 1, 2) } },
	};
	for (const [name, data] of Object.entries(cases)) {
		await t.test(name, async () => {
			const { get } = fixture(data);
			const { items: [{ observation }] } = await scanTeam(get, { known: [], force: false }, now);
			assert.equal(observation.state, 'unknown');
			assert.equal(observation.scheduled, undefined);
			assert.equal(observation.lastPublishAt, undefined);
		});
	}
});

test('forces refresh of a current ongoing title even before its next check', async () => {
	const { get, calls } = fixture();
	const { items: [{ observation }] } = await scanTeam(get, {
		known: [{ id: 11, status: 'ongoing', nextCheckAt: later }], force: true,
	}, now);
	assert.ok(calls.includes('chapters:11'));
	assert.equal(observation.scheduled, 0);
});

test('retains other titles and limits concurrency when one title has a network failure', async () => {
	const { get } = fixture({
		ongoing: { 1: listing([title(11), title(12), title(13)]) },
		branches: { 12: records([branch(5, 11969)]), 13: records([branch(5, 11969)]) },
		chapters: { 12: records([chapter(102, [5, later])]), 13: records([chapter(103, [5, earlier])]) },
	});
	const unavailable = apiReader(async () => { throw new Error('fixture transport failure'); }, () => {});
	let inFlight = 0;
	let peak = 0;
	const endpoint = async url => {
		if (url.pathname === '/api/manga') return get(url);
		inFlight++;
		peak = Math.max(peak, inFlight);
		try {
			await new Promise(resolve => setImmediate(resolve));
			return await (url.pathname === '/api/branches/11' ? unavailable(url) : get(url));
		} finally {
			inFlight--;
		}
	};
	const { items } = await scanTeam(endpoint, { known: [], force: true }, now);
	assert.equal(peak, 2);
	assert.deepEqual(items.map(item => [item.id, item.observation.state, item.observation.scheduled]), [
		[11, 'unknown', undefined],
		[12, 'known', 1],
		[13, 'known', 0],
	]);
});

test('drains the other in-flight title without sending its chapter request on a fatal rate limit', async () => {
	const { get } = fixture({
		ongoing: { 1: listing([title(11), title(12)]) },
		branches: { 12: records([branch(5, 11969)]) },
	});
	const rateLimited = apiReader(async () => ({
		status: () => 429,
		headers: () => ({ 'retry-after': '10' }),
		dispose: async () => {},
	}));
	let titleTwoCompleted = false;
	let requestedChapters = false;
	const endpoint = async url => {
		if (url.pathname.endsWith('/chapters')) requestedChapters = true;
		if (url.pathname === '/api/branches/11') return rateLimited(url);
		if (url.pathname === '/api/branches/12') {
			await new Promise(resolve => setImmediate(resolve));
			titleTwoCompleted = true;
		}
		return get(url);
	};
	await assert.rejects(scanTeam(endpoint, { known: [], force: true }, now), { code: 'rate_limited' });
	assert.equal(titleTwoCompleted, true);
	assert.equal(requestedChapters, false);
});

test('rejects partial catalog pagination instead of publishing a shorter team snapshot', async () => {
	const { get } = fixture({ ongoing: { 1: listing([title(11)], 1, 2), 2: listing([title(11)], 1, 2) } });
	await assert.rejects(scanTeam(get, { known: [], force: false }, now), { code: 'schema' });
});

test('does not follow pagination links outside the fixed API origin or change the catalog filters', async () => {
	const page = listing([title(11)], 1, 2);
	page.links.next = 'https://example.invalid/api/irrelevant?page=2';
	const { get } = fixture({ ongoing: { 1: page, 2: listing([title(12)], 2, 2) } });
	const { items } = await scanTeam(get, { known: [], force: false }, now);
	assert.deepEqual(items.map(item => item.id), [11, 12]);
});

test('backs off once on transient upstream errors and returns a rate-limit error when still throttled', async () => {
	const sleeps = [];
	const url = new URL('https://api.cdnlibs.org/api/branches/11');
	const response = () => ({
		status: () => 429,
		headers: () => ({ 'retry-after': '1' }),
		dispose: async () => {},
	});
	let attempts = 0;
	const get = apiReader(async () => { attempts++; return response(); }, duration => sleeps.push(duration));
	await assert.rejects(get(url), { code: 'rate_limited' });
	assert.equal(attempts, 2);
	assert.deepEqual(sleeps, [1000]);
});

test('does not retry or expose content on authentication failure', async () => {
	const url = new URL('https://api.cdnlibs.org/api/branches/11');
	let attempts = 0;
	const get = apiReader(async () => {
		attempts++;
		return { status: () => 401, dispose: async () => {}, json: () => assert.fail('Read unauthorized response') };
	}, () => assert.fail('Retried unauthorized request'));
	await assert.rejects(get(url), { code: 'login_required' });
	assert.equal(attempts, 1);
});

test('accepts authorization only from a successful account check issued by the official page', async () => {
	const testHeader = 'Bearer synthetic';
	function response({ status = 200, frame = 'https://ranobelib.me/ru/team/11969--dom-nekromanta', url = 'https://api.cdnlibs.org/api/auth/me', method = 'GET' } = {}) {
		return {
			status: () => status,
			url: () => url,
			request: () => ({
				method: () => method,
				frame: () => ({ url: () => frame, parentFrame: () => null }),
				headerValue: async key => key === 'authorization' ? testHeader : null,
			}),
		};
	}
	assert.equal(await readBrowserAuthorization(response()), testHeader);
	for (const options of [
		{ status: 401 }, { frame: 'https://example.invalid' }, { method: 'POST' },
		{ url: 'https://api.cdnlibs.org.example.invalid/api/auth/me' }, { url: 'https://api.cdnlibs.org/api/manga' },
	]) {
		assert.equal(await readBrowserAuthorization(response(options)), undefined);
	}
});

test('requires the visible edit link for the tracked RanobeLIB team', async () => {
	const ranobe = 'https://ranobelib.me/ru/team/11969--dom-nekromanta';
	function page(url, canEdit) {
		return {
			url: () => url,
			locator(selector) {
				assert.equal(selector, 'a[href="/ru/team/11969--dom-nekromanta/edit"]');
				return { first: () => ({ async waitFor({ state }) {
					assert.equal(state, 'visible');
					if (!canEdit) throw new Error('Edit link unavailable');
				} }) };
			},
		};
	}
	await waitForTeamEdit(page(ranobe, true));
	await assert.rejects(waitForTeamEdit(page(ranobe, false)), { code: 'team_access' });
	await assert.rejects(waitForTeamEdit(page('https://example.invalid/ru/team/11969--dom-nekromanta', true)), { code: 'team_access' });
});

test('emits exactly one JSON object for malformed IPC input', async () => {
	const stdout = [];
	await runWorker(['scan', __dirname], Readable.from(['{!\n']), { write: line => stdout.push(line) });
	const lines = stdout.join('').trim().split('\n');
	assert.equal(lines.length, 1);
	assert.equal(JSON.parse(lines[0]).code, 'schema');
});
