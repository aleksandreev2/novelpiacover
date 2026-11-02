const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { temporary, decoded } = require("./helpers.cjs");
const { Store } = require("../src/store.cjs");
const { Archive } = require("../src/archive.cjs");
const source = {
  kind: "original",
  url: "https://images.novelpia.com/imagebox/cover/a.file",
};
function novel() {
  return { id: "1", title: "Book", folder: "Book [1]", history: [] };
}
test("deduplicates pixels across URLs but detects replacement at same URL", async (t) => {
  const root = await temporary(t),
    archive = new Archive(),
    n = novel();
  const a = await archive.save(n, source, decoded(1), root);
  n.history.push(a.entry);
  assert.equal(a.saved, true);
  assert.equal(
    (await fs.readFile(a.entry.file)).subarray(0, 8).toString("hex"),
    "89504e470d0a1a0a",
  );
  assert.equal(
    (
      await archive.save(
        n,
        { ...source, url: source.url + "?v=2" },
        decoded(1),
        root,
      )
    ).saved,
    false,
  );
  const b = await archive.save(n, source, decoded(2), root);
  assert.equal(b.saved, true);
  assert.notEqual(a.entry.hash, b.entry.hash);
});
test("restores deleted PNG and recovers manifest history after interrupted settings write", async (t) => {
  const root = await temporary(t),
    a = new Archive(),
    n = novel();
  const r = await a.save(n, source, decoded(), root);
  assert.equal((await a.recover(n, root)).length, 1);
  n.history.push(r.entry);
  await fs.unlink(r.entry.file);
  const restored = await a.save(n, source, decoded(), root);
  assert.equal(restored.saved, true);
  await fs.access(restored.entry.file);
});
test("manifest failure leaves recoverable PNG and stable folder survives title change", async (t) => {
  const root = await temporary(t),
    a = new Archive(),
    n = novel();
  await fs.mkdir(path.join(root, n.folder, "archive.json"), {
    recursive: true,
  });
  await assert.rejects(a.save(n, source, decoded(), root));
  await fs.rm(path.join(root, n.folder, "archive.json"), { recursive: true });
  n.title = "New title";
  const entries = await a.recover(n, root);
  assert.equal(entries.length, 1);
  assert.equal(path.dirname(entries[0].file), path.join(root, "Book [1]"));
});
test("new root affects new files and keeps old archives intact", async (t) => {
  const root = await temporary(t),
    a = new Archive(),
    n = novel();
  const first = await a.save(n, source, decoded(), path.join(root, "old"));
  n.history.push(first.entry);
  const second = await a.save(n, source, decoded(2), path.join(root, "new"));
  await fs.access(first.entry.file);
  assert.ok(second.entry.file.startsWith(path.join(root, "new")));
});
test("settings survive restart and recover from corrupted primary using backup", async (t) => {
  const root = await temporary(t),
    store = await Store.open(root);
  await store.update((s) => {
    s.root = "chosen";
  });
  await store.update((s) => {
    s.paused = true;
  });
  assert.equal((await Store.open(root)).state.paused, true);
  await fs.writeFile(path.join(root, "settings.json"), "{broken");
  const recovered = await Store.open(root);
  assert.equal(recovered.state.root, "chosen");
  assert.equal(recovered.recovered, true);
});
test("failed settings write does not publish an unpersisted state", async (t) => {
  const root = await temporary(t),
    store = await Store.open(root);
  await fs.mkdir(path.join(root, "settings.json"), { recursive: true });
  await assert.rejects(
    store.update((s) => {
      s.interval = 60;
    }),
  );
  assert.equal(store.state.interval, 30);
});
test("missing primary settings still restores backup instead of empty defaults", async (t) => {
  const root = await temporary(t),
    store = await Store.open(root);
  await store.update((s) => {
    s.root = "chosen";
  });
  await store.update((s) => {
    s.paused = true;
  });
  await fs.unlink(path.join(root, "settings.json"));
  assert.equal((await Store.open(root)).state.root, "chosen");
});
