const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { temporary, decoded } = require("./helpers.cjs");
const { Store } = require("../src/store.cjs");
const { Archive } = require("../src/archive.cjs");
const { Monitor } = require("../src/monitor.cjs");
const url = "https://novelpia.com/novel/1";
const html =
  '<a href="//images.novelpia.com/imagebox/cover/orig.file"><img class="cover_img" src="//images.novelpia.com/imagebox/cover/thumb.file"></a><div class="epnew-novel-title">My Book</div>';
async function setup(t, fetch) {
  const dir = await temporary(t),
    store = await Store.open(path.join(dir, "data"));
  await store.update((s) => {
    s.root = path.join(dir, "archive");
  });
  const monitor = new Monitor({
    store,
    archive: new Archive(),
    fetchResource: fetch,
    decode: async (b) => decoded(b[0]),
  });
  return { store, monitor };
}
test("keeps successful original if thumbnail fails; retries with backoff and persists history", async (t) => {
  const { store, monitor } = await setup(t, async (u) => {
    if (u === url) return Buffer.from(html);
    if (u.includes("thumb")) throw new Error("HTTP 503");
    return Buffer.from([7]);
  });
  await monitor.add(url);
  const n = monitor.snapshot().novels[0];
  assert.equal(n.history.length, 1);
  assert.match(n.error, /503/);
  assert.ok(n.nextCheck > Date.now());
  const restarted = await Store.open(store.directory);
  assert.equal(restarted.state.novels[0].history.length, 1);
});
test("serializes concurrent manual checks and avoids duplicate files", async (t) => {
  let active = 0,
    max = 0;
  const { monitor } = await setup(t, async (u) => {
    active++;
    max = Math.max(max, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return u === url ? Buffer.from(html) : Buffer.from([1]);
  });
  await monitor.add(url);
  await Promise.all([monitor.check("1"), monitor.check("1")]);
  assert.equal(max, 1);
  assert.equal(monitor.snapshot().novels[0].history.length, 1);
});
test("pause prevents automatic checks and resume checks overdue items", async (t) => {
  let pages = 0;
  const { monitor, store } = await setup(t, async (u) => {
    if (u === url) {
      pages++;
      return Buffer.from(html);
    }
    return Buffer.from([1]);
  });
  await monitor.add(url);
  await store.update((s) => {
    s.paused = true;
    s.novels[0].nextCheck = 0;
  });
  await monitor.tick();
  assert.equal(pages, 1);
  await monitor.update({ paused: false });
  await monitor.tick();
  assert.equal(pages, 2);
});
test("removing and re-adding a novel retains previous files and history", async (t) => {
  const { monitor } = await setup(t, async (u) =>
    u === url ? Buffer.from(html) : Buffer.from([1]),
  );
  await monitor.add(url);
  await monitor.remove("1");
  assert.equal(monitor.snapshot().novels.length, 0);
  await monitor.add(url);
  assert.equal(monitor.snapshot().novels[0].history.length, 1);
});
test("requires selected root, rejects duplicates and invalid intervals", async (t) => {
  const { monitor, store } = await setup(t, async (u) =>
    u === url ? Buffer.from(html) : Buffer.from([1]),
  );
  await monitor.add(url);
  await assert.rejects(monitor.add(url), /добавлен/);
  await assert.rejects(monitor.update({ interval: 0 }));
  await assert.rejects(monitor.update({ interval: Infinity }));
  await store.update((s) => {
    s.root = "";
  });
  await assert.rejects(monitor.check("1"), /папк/i);
});
test("prefers successfully downloaded original for main preview", async (t) => {
  const { monitor } = await setup(t, async (u) =>
    u === url ? Buffer.from(html) : Buffer.from([u.includes("orig") ? 2 : 1]),
  );
  await monitor.add(url);
  const n = monitor.snapshot().novels[0];
  assert.equal(n.history.find((e) => e.hash === n.latestHash).kind, "original");
});
test("pausing during one automatic check prevents the next queued novel request", async (t) => {
  const url2 = "https://novelpia.com/novel/2";
  let phase = false,
    release,
    startedResolve,
    requests = [];
  const started = new Promise((r) => (startedResolve = r)),
    gate = new Promise((r) => (release = r));
  const { monitor, store } = await setup(t, async (u) => {
    if (u === url || u === url2) {
      if (phase) {
        requests.push(u);
        if (u === url) {
          startedResolve();
          await gate;
        }
      }
      return Buffer.from(html);
    }
    return Buffer.from([1]);
  });
  await monitor.add(url);
  await monitor.add(url2);
  await store.update((s) => s.novels.forEach((n) => (n.nextCheck = 0)));
  phase = true;
  const ticking = monitor.tick();
  await started;
  const pausing = monitor.update({ paused: true });
  release();
  await Promise.all([ticking, pausing]);
  assert.deepEqual(requests, [url]);
});
test("first folder survives failed final settings write and later remote title change", async (t) => {
  let title = "My Book";
  const { monitor, store } = await setup(t, async (u) =>
    u === url ? Buffer.from(html.replace("My Book", title)) : Buffer.from([1]),
  );
  const actualUpdate = store.update.bind(store);
  store.update = async (fn) => {
    const next = structuredClone(store.state);
    fn(next);
    if (next.novels[0]?.history.length) throw new Error("disk full");
    return actualUpdate(fn);
  };
  await assert.rejects(monitor.add(url), /disk full/);
  assert.equal(store.state.novels[0].folder, "My Book [1]");
  store.update = actualUpdate;
  title = "New Book";
  await monitor.check("1");
  const n = monitor.snapshot().novels[0];
  assert.equal(n.folder, "My Book [1]");
  assert.equal(n.history.length, 1);
});
