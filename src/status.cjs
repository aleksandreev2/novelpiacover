"use strict";
const { randomUUID } = require("node:crypto");
const STATUS_LABELS = Object.freeze({
  ongoing: "Продолжается",
  completed: "Завершён",
  discontinued: "Выпуск остановлен",
  unknown: "Не определён",
});
const DESTINATIONS = ["completed", "discontinued", "ongoing"];
function extractStatus(input) {
  const html = input.replace(
    /<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,
    "",
  );
  const title =
    /<(?:div|h1|span)\b[^>]*class\s*=\s*["'][^"']*\bepnew-novel-title\b[^"']*["'][^>]*>[\s\S]*?<\/(?:div|h1|span)>/i.exec(
      html,
    );
  if (!title) return "unknown";
  const after = html.slice(title.index + title[0].length);
  const writer =
    /^\s*<div\b[^>]*class\s*=\s*["'][^"']*\bepnew-writer\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(
      after,
    );
  if (
    !writer ||
    /<div\b/i.test(writer[1]) ||
    !/<p\b[^>]*class\s*=\s*["'][^"']*\bin-writer\b/i.test(writer[1])
  )
    return "unknown";
  const badge =
    /<p\b[^>]*class\s*=\s*["'][^"']*\bin-badge\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(
      writer[1],
    );
  if (!badge) return "unknown";
  // Any content outside recognised span wrappers is an unfamiliar schema,
  // never evidence of resumed publication.
  if (
    badge[1]
      .replace(/<span\b[^>]*>[\s\S]*?<\/span>/gi, "")
      .replace(/\s|&nbsp;/gi, "")
  )
    return "unknown";
  const labels = [...badge[1].matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)]
    .map((m) =>
      m[1]
        .replace(/<[^>]*>/g, "")
        .replace(/\s+/g, "")
        .trim(),
    )
    .filter(Boolean);
  const complete = labels.includes("완결"),
    stopped = labels.includes("연재중단");
  if (complete && stopped) return "unknown";
  if (complete) return "completed";
  if (stopped) return "discontinued";
  const normal = new Set([
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
    "연재중",
    "연재",
    "신작",
    "선독점",
    "독점공개",
  ]);
  return labels.every((label) => normal.has(label)) ? "ongoing" : "unknown";
}
function defaultPolicy() {
  return { enabled: true, targets: [...DESTINATIONS], sound: true };
}
function validatePolicy(value, { allowSound = true } = {}) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.enabled !== "boolean" ||
    !Array.isArray(value.targets) ||
    value.targets.length > 3 ||
    new Set(value.targets).size !== value.targets.length ||
    value.targets.some((s) => !DESTINATIONS.includes(s)) ||
    Object.keys(value).some(
      (k) =>
        !["enabled", "targets", ...(allowSound ? ["sound"] : [])].includes(k),
    ) ||
    ("sound" in value && typeof value.sound !== "boolean")
  )
    throw new Error("Неверные настройки уведомлений о статусах.");
  return {
    enabled: value.enabled,
    targets: [...value.targets],
    ...(allowSound ? { sound: value.sound ?? true } : {}),
  };
}
function shouldNotify(global, override, to) {
  const policy = override ?? global;
  return !!policy?.enabled && policy.targets.includes(to);
}
function observeStatus(novel, status, at = new Date().toISOString()) {
  novel.statusAvailable = status !== "unknown";
  if (status === "unknown") return null;
  const from = novel.status;
  novel.status = status;
  novel.statusObservedAt = at;
  if (!DESTINATIONS.includes(from) || from === status) return null;
  const event = {
    id: randomUUID(),
    novelId: novel.id,
    title: novel.title,
    from,
    to: status,
    at,
  };
  novel.statusHistory = [...(novel.statusHistory || []), event].slice(-200);
  return event;
}
function buildStatusToast(event, sound) {
  return {
    title:
      event.to === "completed"
        ? "Тайтл завершён"
        : event.to === "discontinued"
          ? "Выпуск тайтла остановлен"
          : "Выпуск тайтла возобновлён",
    body: `${event.title.slice(0, 200)}\n${STATUS_LABELS[event.from]} → ${STATUS_LABELS[event.to]}`,
    silent: !sound,
  };
}
module.exports = {
  STATUS_LABELS,
  extractStatus,
  defaultPolicy,
  validatePolicy,
  shouldNotify,
  observeStatus,
  buildStatusToast,
};
