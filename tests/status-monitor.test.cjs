const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { temporary, decoded } = require("./helpers.cjs");
const { Store } = require("../src/store.cjs");
const { Monitor } = require("../src/monitor.cjs");
const { Archive } = require("../src/archive.cjs");
const url = "https://novelpia.com/novel/1";
function page(status) {
  const badge =
    status === "completed"
      ? '<span class="b_comp">완결</span>'
      : status === "discontinued"
        ? "<span>연재중단</span>"
        : "";
  return `<div class="epnew-novel-title">Book</div>${status === "unknown" ? "" : `<div class="epnew-writer"><p class="in-writer">Author</p><p class="in-badge"><span>PLUS</span>${badge}</p></div>`}<a href="//images.novelpia.com/imagebox/cover/a.file"><img class="cover_img" src="//images.novelpia.com/imagebox/cover/a.file"></a>`;
}
async function setup(t) {
  const root = await temporary(t),
    store = await Store.open(path.join(root, "profile"));
  await store.update((s) => {
    s.root = path.join(root, "archive");
  });
  let status = "ongoing",
    failImages = false;
  const fetch = async (u) => {
    if (u === url) return Buffer.from(page(status));
    if (failImages) throw new Error("image HTTP 503");
    return Buffer.from([1]);
  };
  const monitor = new Monitor({
    store,
    archive: new Archive(),
    fetchResource: fetch,
    decode: async () => decoded(),
  });
  const events = [];
  monitor.on("status-changed", (e) => events.push(e));
  return {
    store,
    monitor,
    events,
    fetch,
    setStatus: (v) => (status = v),
    setImageFailure: (v) => (failImages = v),
  };
}
test("initial observation is baseline, changed status persists and emits once across restart", async (t) => {
  const s = await setup(t);
  await s.monitor.add(url);
  assert.equal(s.monitor.snapshot().novels[0].status, "ongoing");
  assert.equal(s.events.length, 0);
  s.setStatus("completed");
  await s.monitor.check("1");
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0].from, "ongoing");
  assert.equal(s.events[0].to, "completed");
  await s.monitor.check("1");
  assert.equal(s.events.length, 1);
  const store = await Store.open(s.store.directory),
    next = new Monitor({
      store,
      archive: new Archive(),
      fetchResource: s.fetch,
      decode: async () => decoded(),
    });
  next.on("status-changed", () => assert.fail("repeated toast"));
  await next.check("1");
  assert.equal(next.snapshot().novels[0].statusHistory.length, 1);
});
test("unknown observations preserve last known baseline and do not fabricate resume", async (t) => {
  const s = await setup(t);
  s.setStatus("discontinued");
  await s.monitor.add(url);
  s.setStatus("unknown");
  await s.monitor.check("1");
  assert.equal(s.monitor.snapshot().novels[0].status, "discontinued");
  assert.equal(s.events.length, 0);
  s.setStatus("ongoing");
  await s.monitor.check("1");
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0].from, "discontinued");
});
test("a changed terminal badge wrapper cannot emit a fabricated resume", async (t) => {
  const s = await setup(t);
  s.setStatus("completed");
  await s.monitor.add(url);
  const fetch = s.monitor.fetchResource;
  s.monitor.fetchResource = async (u, options) =>
    u === url
      ? Buffer.from(
          page("ongoing").replace("<span>PLUS</span>", "<span>PLUS</span>완결"),
        )
      : fetch(u, options);
  await s.monitor.check("1");
  assert.equal(s.monitor.snapshot().novels[0].status, "completed");
  assert.equal(s.events.length, 0);
});
test("verified status change is retained and notified even if cover download fails", async (t) => {
  const s = await setup(t);
  await s.monitor.add(url);
  s.setImageFailure(true);
  s.setStatus("completed");
  await s.monitor.check("1");
  assert.equal(s.events.length, 1);
  assert.equal(s.monitor.snapshot().novels[0].status, "completed");
  assert.match(s.monitor.snapshot().novels[0].error, /503/);
});
test("muted changes advance baseline and retain history without a later backlog", async (t) => {
  const s = await setup(t);
  await s.monitor.add(url);
  await s.monitor.update({
    statusNotifications: {
      enabled: false,
      targets: ["completed"],
      sound: true,
    },
  });
  s.setStatus("completed");
  await s.monitor.check("1");
  assert.equal(s.events.length, 0);
  assert.equal(s.monitor.snapshot().novels[0].statusHistory.length, 1);
  await s.monitor.update({
    statusNotifications: { enabled: true, targets: ["completed"], sound: true },
  });
  await s.monitor.check("1");
  assert.equal(s.events.length, 0);
});
test("per-title policy persists, validates ID and controls destinations", async (t) => {
  const s = await setup(t);
  await s.monitor.add(url);
  await s.monitor.setNovelNotifications("1", {
    enabled: true,
    targets: ["discontinued"],
  });
  s.setStatus("completed");
  await s.monitor.check("1");
  assert.equal(s.events.length, 0);
  s.setStatus("discontinued");
  await s.monitor.check("1");
  assert.equal(s.events.length, 1);
  await assert.rejects(s.monitor.setNovelNotifications("missing", null));
  await assert.rejects(
    s.monitor.setNovelNotifications("1", {
      enabled: true,
      targets: ["unknown"],
    }),
  );
  await s.monitor.setNovelNotifications("1", null);
  assert.equal(s.monitor.snapshot().novels[0].statusNotifications, null);
});
test("failed status commit never emits a toast; successful retry emits once", async (t) => {
  const s = await setup(t);
  await s.monitor.add(url);
  s.setStatus("completed");
  const update = s.store.update.bind(s.store);
  s.store.update = async () => {
    throw new Error("disk full");
  };
  await assert.rejects(s.monitor.check("1"), /disk full/);
  assert.equal(s.events.length, 0);
  s.store.update = update;
  await s.monitor.check("1");
  assert.equal(s.events.length, 1);
});
test("version 1.0 settings upgrade preserves archive and establishes silent status baseline", async (t) => {
  const s = await setup(t);
  await s.monitor.add(url);
  await s.store.update((state) => {
    delete state.statusNotifications;
    delete state.novels[0].status;
    delete state.novels[0].statusObservedAt;
  });
  const store = await Store.open(s.store.directory);
  assert.equal(store.state.statusNotifications.enabled, true);
  s.setStatus("completed");
  const next = new Monitor({
    store,
    archive: new Archive(),
    fetchResource: s.fetch,
    decode: async () => decoded(),
  });
  next.on("status-changed", () =>
    assert.fail("upgrade must not fabricate a change"),
  );
  await next.check("1");
  assert.equal(next.snapshot().novels[0].history.length, 1);
  assert.equal(next.snapshot().novels[0].status, "completed");
});
