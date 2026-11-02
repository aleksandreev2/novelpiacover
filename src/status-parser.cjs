"use strict";
const { parseDocument } = require("htmlparser2");
const LIFECYCLE = new Map([
  ["연재중", "ongoing"],
  ["완결", "completed"],
  ["연재중단", "discontinued"],
  ["연재지연", "delayed"],
]);
const NORMAL_LABELS = new Set([
  "PLUS",
  "독점",
  "자유",
  "무료",
  "유료",
  "15",
  "19",
  "전체",
  "전체이용가",
  "공모전",
  "우주최강",
  "챌린지",
  "연재",
  "신작",
  "선독점",
  "독점공개",
]);
const METADATA_CLASSES = new Set([
  "b_plus",
  "b_mono",
  "b_free",
  "b_15",
  "b_19",
  "b_million_class",
  "b_contest",
  "b_challenge",
]);
const IGNORED = new Set(["script", "style", "template", "noscript"]);
const classes = (node) =>
  new Set((node.attribs?.class || "").split(/\s+/).filter(Boolean));
const hasClass = (node, name) => classes(node).has(name);
const hidden = (node) =>
  node.attribs &&
  (Object.hasOwn(node.attribs, "hidden") ||
    /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test(
      node.attribs.style || "",
    ));
function find(root, predicate) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (IGNORED.has(node.name) || hidden(node)) continue;
    if (predicate(node)) return node;
    if (node.children)
      for (let i = node.children.length - 1; i >= 0; i--)
        stack.push(node.children[i]);
  }
  return null;
}
function closed(node, input) {
  // EOF-implied closures use input.length, not the index of a real end tag.
  if (node.endIndex >= input.length) return false;
  if (!Number.isInteger(node.startIndex) || !Number.isInteger(node.endIndex))
    return false;
  const end = input
    .slice(Math.max(node.startIndex, node.endIndex - 100), node.endIndex + 1)
    .match(/<\/([a-z][\w:-]*)\s*>$/i);
  return end?.[1].toLowerCase() === node.name;
}
const compact = (text) =>
  text.normalize("NFKC").replace(/[\s\u200b\ufeff]+/g, "");
function awardImage(node) {
  try {
    const url = new URL(node.attribs.src || "", "https://novelpia.com");
    return (
      ["images.novelpia.com", "image.novelpia.com", "novelpia.com"].includes(
        url.hostname,
      ) &&
      /^\/img\/new\/icon\/[\w-]*pencil[\w-]*\.(?:png|gif|webp|svg)$/i.test(
        url.pathname,
      )
    );
  } catch {
    return false;
  }
}
function readBadge(badge) {
  let opaqueMedia = false;
  const classify = (text) => {
    const value = compact(text);
    if (!value || NORMAL_LABELS.has(value)) return [];
    if (LIFECYCLE.has(value)) return [LIFECYCLE.get(value)];
    const parts = text.trim().split(/\s+/).filter(Boolean);
    if (
      parts.length > 1 &&
      parts.every(
        (p) => LIFECYCLE.has(compact(p)) || NORMAL_LABELS.has(compact(p)),
      )
    ) {
      return parts
        .filter((p) => LIFECYCLE.has(compact(p)))
        .map((p) => LIFECYCLE.get(compact(p)));
    }
    return null;
  };
  const empty = Object.freeze({
    text: "",
    rest: "",
    textCodes: [],
    structuralCodes: [],
  });
  function visit(node, depth = 0) {
    if (depth > 40) {
      opaqueMedia = true;
      return empty;
    }
    if (node.type === "comment" || IGNORED.has(node.name) || hidden(node))
      return empty;
    if (node.type === "text")
      return { ...empty, text: node.data, rest: node.data };
    if (node.type !== "tag") return empty;
    const ownClasses = classes(node);
    if ([...ownClasses].some((c) => METADATA_CLASSES.has(c))) return empty;
    const ownCodes = ownClasses.has("b_comp") ? ["completed"] : [];
    if (node.name === "img") {
      if (awardImage(node)) return empty;
      const alternative = compact(node.attribs.alt || "");
      if (LIFECYCLE.has(alternative)) ownCodes.push(LIFECYCLE.get(alternative));
      else opaqueMedia = true;
      return { ...empty, structuralCodes: ownCodes };
    }
    if (["svg", "canvas", "object", "iframe", "video"].includes(node.name)) {
      opaqueMedia = true;
      return { ...empty, structuralCodes: ownCodes };
    }
    const children = (node.children || []).map((child) =>
      visit(child, depth + 1),
    );
    const text = children.map((child) => child.text).join("");
    const structuralCodes = [
      ...ownCodes,
      ...children.flatMap((child) => child.structuralCodes),
    ];
    const whole = classify(text);
    // A complete enclosing word supersedes text-only prefixes inside formatting
    // tags. Independent class/image evidence and sibling labels remain distinct.
    let textCodes =
      whole && whole.length
        ? whole
        : children.flatMap((child) => child.textCodes);
    let rest = "";
    if (whole === null) {
      rest = children.map((child) => child.rest).join("");
      const remainder = classify(rest);
      if (remainder !== null) {
        textCodes = [...textCodes, ...remainder];
        rest = "";
      }
    }
    return { text, rest, textCodes, structuralCodes };
  }
  const parsed = visit(badge);
  const statuses = new Set([...parsed.textCodes, ...parsed.structuralCodes]);
  const residue = parsed.rest.replace(/\s+/g, " ").trim();
  if (statuses.size > 1)
    return {
      status: "unknown",
      reason: "На странице обнаружены противоречивые метки статуса.",
    };
  const explicit = [...statuses][0];
  if (explicit && explicit !== "ongoing")
    return { status: explicit, reason: "", evidence: explicit };
  if (opaqueMedia)
    return {
      status: "unknown",
      reason: "В блоке статуса обнаружен незнакомый графический значок.",
    };
  if (residue)
    return {
      status: "unknown",
      reason: "Не распознаны метки страницы: " + residue.slice(0, 100),
    };
  return {
    status: "ongoing",
    reason: "",
    evidence: explicit || "no-terminal-or-delay-label",
  };
}
function inspectStatus(input) {
  const document = parseDocument(input, {
    decodeEntities: true,
    withStartIndices: true,
    withEndIndices: true,
  });
  const title = find(
    document,
    (node) => node.type === "tag" && hasClass(node, "epnew-novel-title"),
  );
  if (!title || !closed(title, input))
    return {
      status: "unknown",
      reason: "На странице не найден полный заголовок тайтла.",
    };
  let writer = title.next;
  while (
    writer &&
    !(writer.type === "tag" && hasClass(writer, "epnew-writer"))
  ) {
    if (writer.type === "tag" && hasClass(writer, "epnew-novel-title"))
      return { status: "unknown", reason: "Не найден основной блок автора." };
    if (
      writer.type === "tag" &&
      !IGNORED.has(writer.name) &&
      !hidden(writer) &&
      !["br", "hr", "meta"].includes(writer.name)
    )
      return {
        status: "unknown",
        reason: "Между заголовком и автором находится другая секция страницы.",
      };
    if (writer.type === "text" && writer.data.trim())
      return {
        status: "unknown",
        reason: "Не распознана структура основного блока тайтла.",
      };
    writer = writer.next;
  }
  if (
    !writer ||
    !closed(writer, input) ||
    !find(writer, (node) => node.type === "tag" && hasClass(node, "in-writer"))
  )
    return {
      status: "unknown",
      reason: "Не найден полный основной блок автора.",
    };
  const badge = find(
    writer,
    (node) => node.type === "tag" && hasClass(node, "in-badge"),
  );
  const byline = find(
    writer,
    (node) => node.type === "tag" && hasClass(node, "in-writer"),
  );
  const author =
    find(
      byline,
      (node) => node.type === "tag" && hasClass(node, "writer-name"),
    ) || byline;
  if (
    !find(
      author,
      (node) =>
        node.type === "text" &&
        compact(node.data) &&
        compact(node.data) !== "작가명",
    )
  )
    return { status: "unknown", reason: "Основной блок автора не заполнен." };
  if (!badge || !closed(badge, input))
    return {
      status: "unknown",
      reason: "Блок меток статуса отсутствует или не полностью загружен.",
    };
  return readBadge(badge);
}
const extractStatus = (input) => inspectStatus(input).status;
module.exports = { extractStatus, inspectStatus };
