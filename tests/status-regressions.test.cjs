const { test } = require("node:test");
const assert = require("node:assert/strict");
const { extractStatus, inspectStatus } = require("../src/status.cjs");
const pages = require("./fixtures/novelpia-status-pages.json");
test("unknown recognition explains the cause without exposing a raw page", () => {
  const html =
    '<div class="epnew-novel-title">Book</div><div class="epnew-writer"><p class="in-writer">Author</p><p class="in-badge"><span>Новая метка</span></p></div>';
  const result = inspectStatus(html);
  assert.equal(result.status, "unknown");
  assert.match(result.reason, /Не распознаны метки страницы/);
  assert.ok(result.reason.length < 200);
  assert.ok(!result.reason.includes("<span>"));
});
const header = (badges) =>
  `<div class="epnew-novel-title">Book</div><div class="epnew-writer"><p class="in-writer">Author</p><p class="in-badge">${badges}</p></div>`;
for (const page of pages)
  test(`actual Novelpia header ${page.id}: ${page.expected}`, () =>
    assert.equal(extractStatus(page.html), page.expected));
test("author award images do not erase a completed or stopped lifecycle label", () => {
  for (const [label, status] of [
    ["완결", "completed"],
    ["연재중단", "discontinued"],
    ["연재지연", "delayed"],
  ])
    assert.equal(
      extractStatus(
        header(
          `<img src="//images.novelpia.com/img/new/icon/gold_pencil.png"><span>${label}</span>`,
        ),
      ),
      status,
    );
});
test("recognises explicit lifecycle words across markup wrappers and HTML entities", () => {
  for (const markup of [
    "완결",
    "<b>완결</b>",
    "<span>완<b>결</b></span>",
    "<span>&#50756;&#44208;</span>",
    "<a><em>완결</em></a>",
  ])
    assert.equal(extractStatus(header(markup)), "completed");
});
test("formatting inside the shared serialization prefix preserves delayed/stopped labels", () => {
  for (const [suffix, status] of [
    ["지연", "delayed"],
    ["중단", "discontinued"],
    ["중", "ongoing"],
  ])
    for (const markup of [
      `<span>연재<b>${suffix}</b></span>`,
      `<b>연재</b>${suffix}`,
    ])
      assert.equal(extractStatus(header(markup)), status);
});
test("does not read lifecycle words from image URLs or tooltip announcements", () => {
  assert.equal(
    extractStatus(
      header(
        '<span class="b_plus">PLUS</span><img src="//images.novelpia.com/img/new/icon/bronze_pencil.png" title="완결 작가의 배지">',
      ),
    ),
    "ongoing",
  );
  assert.equal(
    extractStatus(header("<span>PLUS</span><span hidden>완결</span>")),
    "ongoing",
  );
  assert.equal(
    extractStatus(
      header('<span>PLUS</span><span style="display:none">연재중단</span>'),
    ),
    "ongoing",
  );
  assert.equal(
    extractStatus(
      header(
        '<span>PLUS</span><img src="//images.novelpia.com/img/new/icon/silver_pencil.png" alt="완결">',
      ),
    ),
    "ongoing",
  );
  assert.equal(
    extractStatus(
      header(
        '<span>PLUS</span><span class="b_million_class"><span>완결</span><img src="//images.novelpia.com/img/new/event/reward.gif"></span>',
      ),
    ),
    "ongoing",
  );
});
test("does not cross unrelated sections to find a recommendation author block", () => {
  assert.equal(
    extractStatus(
      '<div class="epnew-novel-title">Book</div><section class="recommendations">Recommendations</section><div class="epnew-writer"><p class="in-writer">Other author</p><p class="in-badge"><span>완결</span></p></div>',
    ),
    "unknown",
  );
});
test("unknown status words and opaque media remain unknown rather than fabricate resume", () => {
  for (const markup of [
    "<span>새로운상태</span>",
    "<span>휴재</span>",
    '<img src="//images.novelpia.com/img/status/new-state.png">',
  ])
    assert.equal(extractStatus(header(markup)), "unknown");
});
test("an ongoing marker does not overrule unknown lifecycle content", () => {
  for (const rest of [
    "<span>휴재</span>",
    '<img src="/img/status/new-state.png">',
  ])
    assert.equal(
      extractStatus(header("<span>연재중</span>" + rest)),
      "unknown",
    );
});
test("nested writer/badge blocks implicitly closed at EOF remain unknown", () => {
  const prefix =
    '<div class="epnew-novel-title">Book</div><div class="epnew-writer">';
  for (const rest of [
    '<div class="author-wrap"><p class="in-writer">Author</p><p class="in-badge"><span>PLUS</span></p></div>',
    '<p class="in-writer">Author</p><div class="in-badge"><div>PLUS</div>',
  ])
    assert.equal(extractStatus(prefix + rest), "unknown");
});
test("a nested ongoing word that is only a prefix of stopped does not conflict with its full label", () => {
  assert.equal(
    extractStatus(header("<span><b>연재중</b>단</span>")),
    "discontinued",
  );
});
test("an empty author template is not enough evidence for ongoing publication", () => {
  assert.equal(
    extractStatus(
      '<div class="epnew-novel-title">Book</div><div class="epnew-writer"><p class="in-writer"><span class="category-title">작가명</span><a class="writer-name"></a></p><p class="in-badge"></p></div>',
    ),
    "unknown",
  );
});
test("class attributes, harmless nested metadata and intervening comments are supported", () => {
  const html =
    "<DIV class='epnew-novel-title'>Book</DIV><!-- author --><DIV class='ep-info-line epnew-writer'><div class='author-wrap'><p class='in-writer'>Author</p><div class='in-badge'><span>PLUS</span><span><b>연재지연</b></span></div></div></DIV>";
  assert.equal(extractStatus(html), "delayed");
});
