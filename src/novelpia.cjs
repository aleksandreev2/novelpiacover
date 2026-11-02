"use strict";
const PAGE_HOSTS = new Set(["novelpia.com", "www.novelpia.com"]);
const IMAGE_HOSTS = new Set([
  ...PAGE_HOSTS,
  "images.novelpia.com",
  "image.novelpia.com",
]);
function parseNovelUrl(input) {
  if (typeof input !== "string" || input.length > 2048)
    throw new Error("Введите ссылку на новеллу Novelpia.");
  let u;
  try {
    u = new URL(input.trim());
  } catch {
    throw new Error("Неверная ссылка Novelpia.");
  }
  const m = /^\/novel\/([1-9]\d{0,11})\/?$/.exec(u.pathname);
  if (
    u.protocol !== "https:" ||
    !PAGE_HOSTS.has(u.hostname) ||
    u.port ||
    u.username ||
    u.password ||
    !m
  )
    throw new Error("Нужна ссылка вида https://novelpia.com/novel/434103");
  return { id: m[1], url: `https://novelpia.com/novel/${m[1]}` };
}
function imageUrl(input) {
  const u = new URL(input, "https://novelpia.com");
  if (
    u.protocol !== "https:" ||
    !IMAGE_HOSTS.has(u.hostname) ||
    u.port ||
    u.username ||
    u.password ||
    !/^\/imagebox\/cover\/[^/]+$/.test(u.pathname)
  )
    throw new Error("Недопустимая ссылка или домен изображения.");
  u.hash = "";
  return u.href;
}
function entities(s) {
  return s.replace(
    /&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi,
    (whole, name) => {
      const table = {
        amp: "&",
        quot: '"',
        apos: "'",
        lt: "<",
        gt: ">",
        nbsp: " ",
      };
      if (name[0] !== "#") return table[name.toLowerCase()] ?? whole;
      const n =
        name[1].toLowerCase() === "x"
          ? parseInt(name.slice(2), 16)
          : Number(name.slice(1));
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "�";
    },
  );
}
function attrs(tag) {
  const result = {};
  for (const m of tag.matchAll(
    /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g,
  ))
    result[m[1].toLowerCase()] = entities(m[2] ?? m[3] ?? m[4]);
  return result;
}
function extractNovel(html, input) {
  const novel = parseNovelUrl(input);
  // Ignore executable and commented fragments; only use published cover markup.
  html = html.replace(
    /<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script>/gi,
    "",
  );
  const meta = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    meta[a.property || a.name] = a.content;
  }
  const titleMatch =
    /<(?:div|h1|span)\b[^>]*class\s*=\s*["'][^"']*\bepnew-novel-title\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|h1|span)>/i.exec(
      html,
    );
  const rawTitle = titleMatch
    ? entities(titleMatch[1].replace(/<[^>]*>/g, ""))
    : (meta["og:title"] || "").replace(
        /^노벨피아\s*-\s*웹소설로 꿈꾸는 세상!\s*-\s*/,
        "",
      );
  const title =
    rawTitle.replace(/\s+/g, " ").trim().slice(0, 300) ||
    `Novelpia ${novel.id}`;
  const coverTag = [...html.matchAll(/<img\b[^>]*>/gi)]
    .map((m) => attrs(m[0]))
    .find((a) => (a.class || "").split(/\s+/).includes("cover_img"));
  let original;
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (/<img\b[^>]*class\s*=\s*["'][^"']*\bcover_img\b/i.test(m[2])) {
      original = attrs(m[1]).href;
      break;
    }
  }
  const sources = [];
  for (const [kind, candidate] of [
    ["original", original],
    ["cover", coverTag?.src || meta["og:image"]],
  ]) {
    if (!candidate) continue;
    try {
      const url = imageUrl(candidate);
      if (!sources.some((s) => s.url === url)) sources.push({ kind, url });
    } catch {
      /* never follow unrelated links */
    }
  }
  if (!sources.length)
    throw new Error(
      "Обложка не найдена. Проверьте ссылку: страница может требовать входа или её разметка изменилась.",
    );
  return { ...novel, title, sources };
}
function safeFolder(title, id) {
  const name =
    title
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^[. ]+|[. ]+$/g, "")
      .slice(0, 90)
      .trim() || "Novelpia";
  return `${name} [${id}]`;
}
module.exports = { parseNovelUrl, extractNovel, imageUrl, safeFolder };
