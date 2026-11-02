const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseNovelUrl,
  extractNovel,
  imageUrl,
  safeFolder,
} = require("../src/novelpia.cjs");
const url = "https://novelpia.com/novel/434103";
test("accepts only numeric Novelpia novel links and normalizes them", () => {
  assert.deepEqual(parseNovelUrl(url + "?foo=bar#cover"), {
    id: "434103",
    url,
  });
  for (const bad of [
    "file:///a",
    "https://novelpia.com.evil/novel/1",
    "https://u:p@novelpia.com/novel/1",
    "https://novelpia.com/novel/../admin",
    "http://novelpia.com/novel/1",
    "https://novelpia.com/novel/abc",
  ])
    assert.throws(() => parseNovelUrl(bad));
});
test("extracts title, thumbnail and linked full-resolution cover from actual Novelpia pattern", () => {
  const html = `<meta property="og:image" content="https://novelpia.com/imagebox/cover/thumb.file"><a class="venobox" href="//images.novelpia.com/imagebox/cover/original.file"><img class="cover_img s_inv" src="//images.novelpia.com/imagebox/cover/thumb.file" onerror="ignored"></a><div class="ep-info-line epnew-novel-title">소꿉친구와 우결한다 &amp; &#x41;</div>`;
  const r = extractNovel(html, url);
  assert.equal(r.title, "소꿉친구와 우결한다 & A");
  assert.deepEqual(r.sources, [
    {
      kind: "original",
      url: "https://images.novelpia.com/imagebox/cover/original.file",
    },
    {
      kind: "cover",
      url: "https://images.novelpia.com/imagebox/cover/thumb.file",
    },
  ]);
});
test("uses metadata fallback and rejects a login/error page without cover", () => {
  const r = extractNovel(
    `<meta content="노벨피아 - 웹소설로 꿈꾸는 세상! - My book" property="og:title"><meta property="og:image" content="//images.novelpia.com/imagebox/cover/a.wimg">`,
    url,
  );
  assert.equal(r.title, "My book");
  assert.equal(r.sources.length, 1);
  assert.throws(() => extractNovel("<h1>Login</h1>", url), /обложк/i);
});
test("never accepts external image sources or lookalike hosts", () => {
  for (const bad of [
    "https://images.novelpia.com.evil/imagebox/cover/x",
    "https://evil.com/imagebox/cover/x",
    "file:///x",
    "https://images.novelpia.com/img/logo.png",
  ])
    assert.throws(() => imageUrl(bad));
  assert.equal(
    imageUrl("//image.novelpia.com/imagebox/cover/x"),
    "https://image.novelpia.com/imagebox/cover/x",
  );
});
test("folder names cannot escape selected root and retain Korean text and ID", () => {
  assert.equal(
    safeFolder("소꿉친구와 우결한다", "434103"),
    "소꿉친구와 우결한다 [434103]",
  );
  const folder = safeFolder("../CON: x?*\\y.", "1");
  assert.ok(!/[\\/:?*]/.test(folder));
  assert.ok(folder.endsWith("[1]"));
});
