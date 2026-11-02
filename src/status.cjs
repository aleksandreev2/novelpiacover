"use strict";
const { randomUUID } = require("node:crypto");
const { extractStatus, inspectStatus } = require("./status-parser.cjs");
const STATUS_LABELS = Object.freeze({
  ongoing: "Продолжается",
  completed: "Завершён",
  discontinued: "Выпуск остановлен",
  delayed: "Выпуск задерживается",
  unknown: "Не определён",
});
const DESTINATIONS = ["completed", "discontinued", "delayed", "ongoing"];
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
    value.targets.length > DESTINATIONS.length ||
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
          : event.to === "delayed"
            ? "Выпуск тайтла задерживается"
            : "Выпуск тайтла возобновлён",
    body: `${event.title.slice(0, 200)}\n${STATUS_LABELS[event.from]} → ${STATUS_LABELS[event.to]}`,
    silent: !sound,
  };
}
module.exports = {
  STATUS_LABELS,
  extractStatus,
  inspectStatus,
  defaultPolicy,
  validatePolicy,
  shouldNotify,
  observeStatus,
  buildStatusToast,
};
