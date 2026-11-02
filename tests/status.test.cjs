const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  extractStatus,
  validatePolicy,
  defaultPolicy,
  shouldNotify,
  buildStatusToast,
  observeStatus,
} = require("../src/status.cjs");
function page(badges = "", outside = "") {
  return `<div class="ep-info-line epnew-novel-title">완결이라는 이름(휴재)</div><div class="ep-info-line epnew-writer"><p class="in-writer"><a class="writer-name">Author</a></p><p class="in-badge"><span class="b_plus">PLUS</span>${badges}</p></div>${outside}`;
}
test("recognises main Novelpia completed, stopped and ongoing badge patterns", () => {
  assert.equal(
    extractStatus(page('<span class="b_comp s_inv">완결</span>')),
    "completed",
  );
  assert.equal(
    extractStatus(
      page(
        '<span class="s_inv" style="background-color:#ea4a4a">연재중단</span>',
      ),
    ),
    "discontinued",
  );
  assert.equal(
    extractStatus(page('<span class="b_mono">독점</span>')),
    "ongoing",
  );
});
test("ignores titles, comments, recommendations, scripts and commented-out badges", () => {
  assert.equal(
    extractStatus(
      page(
        "<!-- <span>완결</span> -->",
        '<p class="in-badge"><span>완결</span></p><script>연재중단</script>',
      ),
    ),
    "ongoing",
  );
  assert.equal(
    extractStatus('<h1>Login</h1><p class="in-badge"><span>완결</span></p>'),
    "unknown",
  );
  assert.equal(
    extractStatus(
      '<div class="epnew-novel-title">Book</div><p class="in-badge"><span>완결</span></p>',
    ),
    "unknown",
  );
});
test("ambiguous, incomplete or new lifecycle markup preserves unknown", () => {
  assert.equal(
    extractStatus(page("<span>완결</span><span>연재중단</span>")),
    "unknown",
  );
  assert.equal(extractStatus(page("<span>휴재</span>")), "unknown");
  assert.equal(
    extractStatus(
      '<div class="epnew-novel-title">Book</div><div class="epnew-writer"><p class="in-badge"><span>PLUS</span>',
    ),
    "unknown",
  );
});
test("unrecognised terminal badge wrappers never imply an ongoing title", () => {
  for (const badges of [
    "완결",
    "<b>완결</b>",
    "<span>PLUS</span>완결",
    "<span>PLUS</span><strong>연재중단</strong>",
  ])
    assert.equal(extractStatus(page(badges)), "unknown");
});
test("validates notification policy shape and accepted destination states", () => {
  assert.deepEqual(
    validatePolicy({ enabled: true, targets: ["completed"], sound: false }),
    { enabled: true, targets: ["completed"], sound: false },
  );
  for (const p of [
    null,
    {},
    [],
    { enabled: "true", targets: [] },
    { enabled: true, targets: ["unknown"] },
    { enabled: true, targets: ["completed", "completed"] },
    { enabled: true, targets: [], command: "bad" },
    { enabled: true, targets: [], sound: 1 },
  ])
    assert.throws(() => validatePolicy(p));
});
test("per-title mute and destinations override global preferences", () => {
  const global = defaultPolicy();
  assert.equal(shouldNotify(global, null, "completed"), true);
  assert.equal(
    shouldNotify(
      global,
      { enabled: false, targets: ["completed"] },
      "completed",
    ),
    false,
  );
  assert.equal(
    shouldNotify(
      { ...global, enabled: false },
      { enabled: true, targets: ["completed"] },
      "completed",
    ),
    true,
  );
  assert.equal(
    shouldNotify(
      global,
      { enabled: true, targets: ["completed"] },
      "discontinued",
    ),
    false,
  );
});
test("native toast text describes actual transition and sound setting", () => {
  const toast = buildStatusToast(
    { title: "My Book", from: "ongoing", to: "completed" },
    true,
  );
  assert.match(toast.body, /My Book/);
  assert.match(toast.body, /Продолжается → Завершён/);
  assert.equal(toast.silent, false);
  assert.equal(
    buildStatusToast(
      { title: "Book", from: "discontinued", to: "ongoing" },
      false,
    ).silent,
    true,
  );
});
test("status history retains the latest 200 changes without growing indefinitely", () => {
  const novel = { id: "1", title: "Book", status: "ongoing" };
  for (let i = 0; i < 250; i++)
    observeStatus(
      novel,
      i % 2 === 0 ? "completed" : "ongoing",
      new Date(1000 + i * 1000).toISOString(),
    );
  assert.equal(novel.statusHistory.length, 200);
  assert.equal(novel.statusHistory[0].at, new Date(51000).toISOString());
  assert.equal(novel.statusHistory.at(-1).at, new Date(250000).toISOString());
});
