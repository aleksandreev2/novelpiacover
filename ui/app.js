"use strict";
const $ = (id) => document.getElementById(id),
  api = window.archiveAPI;
let state,
  selected = null,
  limit = 24,
  toastTimer,
  working = false,
  statusLimit = 10,
  policyTitleId = null,
  removeTitleId = null,
  view = "collection",
  pendingSelection,
  collectionRenderKey = "",
  activityLimit = 40,
  activityRenderKey = "";
const statuses = ["completed", "discontinued", "delayed", "ongoing"];
const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
const titleOrder = new Intl.Collator("ru", { numeric: true, sensitivity: "base" });
const shortDate = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });
function readPolicy(prefix, includeSound = false) {
  return {
    enabled: $(prefix + "-enabled").checked,
    targets: statuses.filter((status) => $(prefix + "-" + status).checked),
    ...(includeSound ? { sound: $(prefix + "-sound").checked } : {}),
  };
}
function fillPolicy(prefix, policy) {
  $(prefix + "-enabled").checked = policy.enabled;
  for (const status of statuses)
    $(prefix + "-" + status).checked = policy.targets.includes(status);
  if (prefix === "status") $("status-sound").checked = policy.sound;
}
const date = (value) =>
  value
    ? new Date(value).toLocaleString("ru-RU", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Ещё не было";
const image = (id, hash) =>
  api.imageUrl?.(id, hash) ??
  `cover://image/${encodeURIComponent(id)}/${encodeURIComponent(hash)}`;
function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 6500);
}
async function call(action, payload) {
  const result = await api.call(action, payload);
  if (result?.novels) updateState(result);
  return result;
}
function updateState(snapshot) {
  state = snapshot;
  if (pendingSelection != null) {
    const id = pendingSelection;
    pendingSelection = undefined;
    if (state.novels.some((n) => n.id === id)) {
      selectTitle(id);
      return;
    }
  }
  render();
}
function item(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function current() {
  return state?.novels.find((n) => n.id === selected);
}
function selectTitle(id) {
  selected = id;
  limit = 24;
  statusLimit = 10;
  showView("title", "title");
}
function showView(next, heading) {
  view = next;
  render();
  window.scrollTo({ top: 0, behavior: "instant" });
  $(heading).focus({ preventScroll: true });
}
function applyTheme() {
  const theme = state?.theme || "light";
  document.documentElement.dataset.theme =
    theme === "dark" || (theme === "system" && themeMedia.matches) ? "dark" : "light";
}
function matchesTitle(novel, query) {
  return `${novel.title} ${novel.id}`.toLocaleLowerCase("ru").includes(query);
}
function latestCover(novel) {
  return novel.history.find((entry) => entry.hash === novel.latestHash) || novel.history.at(-1);
}
function changeTimes(novels) {
  // Older profiles can supply archive and activity records before the host
  // has populated a dedicated change timestamp.
  const activityTimes = new Map();
  for (const event of state.activity || []) {
    if (!["cover_saved", "status_changed", "title_renamed"].includes(event.type)) continue;
    const at = Date.parse(event.at) || 0;
    if (at > (activityTimes.get(event.novelId) || 0)) activityTimes.set(event.novelId, at);
  }
  return novels.map((novel) => {
    let changed = Date.parse(novel.lastChangedAt);
    if (!Number.isFinite(changed)) {
      changed = activityTimes.get(novel.id) || 0;
      for (const entry of novel.history) changed = Math.max(changed, Date.parse(entry.savedAt) || 0);
      for (const entry of novel.statusHistory || []) changed = Math.max(changed, Date.parse(entry.at) || 0);
    }
    return { novel, changed, cover: latestCover(novel) };
  });
}
function collectionCard({ novel, changed, cover }) {
  const card = item("button", "collection-card");
  card.type = "button";
  card.dataset.novelId = novel.id;
  card.onclick = () => selectTitle(novel.id);
  const frame = item("span", "collection-cover");
  const placeholder = item("span", "collection-placeholder");
  placeholder.setAttribute("aria-hidden", "true");
  placeholder.append(item("span", "collection-spine"), item("span", "", "Без обложки"));
  frame.append(placeholder);
  if (cover) {
    const preview = item("img");
    preview.alt = "";
    preview.loading = "lazy";
    preview.decoding = "async";
    preview.src = image(novel.id, cover.hash);
    preview.onerror = () => { preview.hidden = true; };
    frame.append(preview);
  }
  const body = item("span", "collection-card-body");
  const title = item("span", "collection-title", novel.title);
  title.title = novel.title;
  const status = novel.status || "unknown";
  const meta = item("span", "collection-meta");
  meta.append(item("span", `collection-status lifecycle ${status}`, state.statusLabels[status] || state.statusLabels.unknown));
  if (changed) {
    const when = new Date(changed);
    const time = item("time", "collection-time", shortDate.format(when));
    time.dateTime = when.toISOString();
    time.title = `Последнее изменение: ${when.toLocaleString("ru-RU")}`;
    time.setAttribute("aria-label", time.title);
    meta.append(time);
  }
  body.append(title, meta);
  card.append(frame, body);
  const row = item("li");
  row.append(card);
  return row;
}
function renderCollection(query) {
  const active = view === "collection";
  $("collection-nav").setAttribute("aria-current", active ? "page" : "false");
  $("collection-view").hidden = !active || !state.novels.length;
  if ($("collection-view").hidden) return;
  const sort = state.collectionSort || "changed";
  const status = state.collectionStatus || "all";
  const layout = state.collectionLayout || "grid";
  $("collection-sort").value = sort;
  $("collection-status").value = status;
  for (const name of ["grid", "list"])
    $(`collection-${name}`).setAttribute("aria-pressed", String(layout === name));
  const list = $("collection-items");
  list.dataset.layout = layout;
  const matches = changeTimes(state.novels.filter((n) =>
    matchesTitle(n, query) && (status === "all" || status === (n.status || "unknown")),
  ));
  matches.sort((a, b) =>
    (sort === "changed" ? b.changed - a.changed : 0) ||
    titleOrder.compare(a.novel.title, b.novel.title) ||
    titleOrder.compare(a.novel.id, b.novel.id),
  );
  const count = matches.length === state.novels.length
    ? `Всего ${matches.length}`
    : `Найдено ${matches.length} из ${state.novels.length}`;
  if ($("collection-count").textContent !== count) $("collection-count").textContent = count;
  $("collection-empty").hidden = !!matches.length;
  const key = JSON.stringify(matches.map(({ novel, changed, cover }) =>
    [novel.id, novel.title, novel.status, changed, cover?.hash],
  ));
  if (key === collectionRenderKey) return;
  collectionRenderKey = key;
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.novelId : undefined;
  const rows = matches.map(collectionCard);
  list.replaceChildren(...rows);
  if (focused) rows.find((row) => row.firstChild.dataset.novelId === focused)?.firstChild.focus({ preventScroll: true });
}
function activityDescription(event) {
  const count = event.covers?.length || 0;
  switch (event.type) {
    case "cover_saved":
      return { label: event.initial ? "Первые обложки сохранены" : count > 1 ? "Новые обложки" : "Новая обложка", detail: `${count} PNG в архиве`, icon: "▧", group: "covers" };
    case "cover_restored":
      return { label: "PNG восстановлены", detail: `${count} PNG повторно сохранено после удаления файла`, icon: "↺", group: "covers" };
    case "status_changed":
      return { label: "Изменился статус", detail: `${state.statusLabels[event.from] || event.from} → ${state.statusLabels[event.to] || event.to}`, icon: "↗", group: "status" };
    case "title_renamed":
      return { label: "Изменилось название", detail: `${event.from} → ${event.to}`, icon: "✎", group: "titles" };
    case "watch_added":
      return { label: event.resumed ? "Наблюдение возобновлено" : "Добавлен в наблюдение", detail: "", icon: "+", group: "watch" };
    case "watch_removed":
      return { label: "Убран из наблюдения", detail: "Сохранённые обложки остаются в архиве", icon: "−", group: "watch" };
    default:
      return { label: "Изменение тайтла", detail: "", icon: "·", group: "watch" };
  }
}
function renderActivity() {
  const events = state.activity || [];
  const unread = events.filter(e => e.sequence > state.activityReadSequence).length;
  $("activity-badge").textContent = unread;
  $("activity-badge").hidden = !unread;
  $("activity-nav").setAttribute("aria-current", view === "activity" ? "page" : "false");
  $("activity-nav").setAttribute("aria-label", `Последние события${unread ? `, непрочитанных: ${unread}` : ""}`);
  $("activity-view").hidden = view !== "activity";
  if (view !== "activity") return;
  $("activity-read").disabled = !unread;
  const query = $("activity-search").value.trim().toLocaleLowerCase("ru"), filter = $("activity-filter").value;
  // Busy/check snapshots do not recreate thumbnails or move keyboard focus.
  const key = JSON.stringify([state.activitySequence, state.activityReadSequence, query, filter, activityLimit, state.novels.map(n => n.id)]);
  if (key === activityRenderKey) return;
  activityRenderKey = key;
  const matching = [...events].reverse().filter(event => {
    const description = activityDescription(event);
    return (filter === "all" || filter === description.group) && `${event.title} ${event.novelId} ${description.label} ${description.detail}`.toLocaleLowerCase("ru").includes(query);
  });
  $("activity-count").textContent = `Показано ${Math.min(activityLimit, matching.length)} из ${matching.length}`;
  $("activity-empty").hidden = !!matching.length;
  $("activity-empty-title").textContent = events.length ? "События не найдены" : "Пока нет событий";
  $("activity-empty-text").textContent = events.length ? "Попробуйте другой запрос или тип события." : "Здесь появятся новые обложки, смены статуса и другие изменения тайтлов.";
  $("activity-list").replaceChildren();
  for (const event of matching.slice(0, activityLimit)) {
    const description = activityDescription(event), active = state.novels.some(n => n.id === event.novelId);
    const row = item("li", `activity-event ${description.group}${event.sequence > state.activityReadSequence ? " unread" : ""}`);
    row.dataset.sequence = event.sequence;
    row.dataset.type = event.type;
    const icon = item("span", "activity-icon", description.icon);
    icon.setAttribute("aria-hidden", "true");
    const body = item("div", "activity-body"), head = item("div", "activity-event-heading");
    head.append(item("strong", "activity-label", description.label));
    const time = item("time", "activity-time", new Date(event.at).toLocaleString("ru-RU", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }));
    time.dateTime = event.at;
    head.append(time);
    const title = item("button", "activity-title", event.title || `Novelpia ${event.novelId}`);
    title.title = active ? "Перейти к тайтлу" : "Открыть страницу на Novelpia";
    title.onclick = () => active ? selectTitle(event.novelId) : call("open-site", event.novelId).catch(e => toast(e.message));
    body.append(head, title);
    if (description.detail) body.append(item("p", "activity-detail", description.detail));
    if (event.covers?.length) {
      const covers = item("div", "activity-covers");
      for (const entry of event.covers.slice(0, 2)) {
        const button = item("button", "activity-cover");
        button.title = "Открыть PNG";
        button.setAttribute("aria-label", `Открыть PNG: ${event.title}`);
        const preview = item("img");
        preview.src = image(event.novelId, entry.hash);
        preview.loading = "lazy";
        preview.alt = "";
        preview.onerror = () => { preview.hidden = true; };
        const info = item("span");
        info.append(item("strong", "", entry.kind === "original" ? "Оригинал" : entry.kind === "cover" ? "Обложка" : "PNG из архива"));
        info.append(item("span", "", `${entry.width} × ${entry.height} · PNG ↗`));
        button.append(preview, info);
        button.onclick = () => call("open-file", { id: event.novelId, hash: entry.hash }).catch(e => toast(e.message));
        covers.append(button);
      }
      body.append(covers);
    }
    const tags = item("div", "activity-tags");
    if (event.sequence > state.activityReadSequence) tags.append(item("span", "activity-new", "Новое"));
    if (event.imported) tags.append(item("span", "", "Из истории"));
    if (!active) tags.append(item("span", "", "Снят с наблюдения · название откроет страницу"));
    if (tags.children.length) body.append(tags);
    row.append(icon, body);
    $("activity-list").append(row);
  }
  $("activity-more").hidden = matching.length <= activityLimit;
}
function showAdd() {
  if (working) return;
  $("add-error").textContent = "";
  $("add-dialog").showModal();
  $("novel-url").focus();
  $("novel-url").select();
}
function render() {
  if (!state) return;
  applyTheme();
  if (!state.novels.some((n) => n.id === selected)) {
    selected = state.novels[0]?.id || null;
    limit = 24;
  }
  $("recovery").hidden = !state.recovered;
  $("notification-warning").hidden = !state.notificationWarning;
  $("notification-warning").textContent = state.notificationWarning || "";
  $("novel-count").textContent = state.novels.length;
  $("monitor-status").textContent = state.paused
    ? "Наблюдение на паузе"
    : state.busy.length
      ? "Проверяем тайтлы…"
      : "Наблюдение включено";
  $("monitor-status").classList.toggle("paused", state.paused);
  $("pause").textContent = state.paused ? "Продолжить" : "Пауза";
  $("check-all").disabled = !!state.busy.length || !state.novels.length;
  $("root").textContent = state.root
    ? `▱  ${state.root}`
    : "▱  Выберите папку архива";
  $("root").title = state.root || "Выбрать папку архива";
  $("interval-label").textContent =
    `v${state.appVersion} · Интервал: ${state.interval} мин`;
  $("add-root").textContent = state.root || "Папка не выбрана";
  $("settings-root").textContent = state.root || "Папка не выбрана";
  const query = $("search").value.trim().toLocaleLowerCase("ru");
  $("novels").replaceChildren();
  for (const n of state.novels.filter((n) => matchesTitle(n, query))) {
    const row = item(
      "button",
      "novel-row" + (view === "title" && n.id === selected ? " active" : ""),
    );
    row.setAttribute("aria-current", view === "title" && n.id === selected ? "page" : "false");
    const latest = latestCover(n);
    const preview = item(latest ? "img" : "span", "row-image");
    if (latest) {
      preview.src = image(n.id, latest.hash);
      preview.alt = "";
      preview.loading = "lazy";
      preview.onerror = () => preview.replaceWith(item("span", "row-image"));
    }
    const info = item("span", "row-info");
    info.append(
      item("span", "row-title", n.title),
      item(
        "span",
        "row-status",
        state.busy.includes(n.id)
          ? "Проверка…"
          : n.error
            ? "Нужна повторная проверка"
            : `${state.statusLabels[n.status] || state.statusLabels.unknown} · ${n.history.length} PNG`,
      ),
    );
    row.append(preview, info);
    row.onclick = () => selectTitle(n.id);
    $("novels").append(row);
  }
  if (!state.novels.length)
    $("novels").append(
      item("p", "muted", "Добавьте новеллы, за которыми хотите следить."),
    );
  else if (!$("novels").children.length)
    $("novels").append(item("p", "muted", "Ничего не найдено."));
  const n = current();
  renderCollection(query);
  renderActivity();
  $("empty").hidden = view === "activity" || !!n;
  $("detail").hidden = view !== "title" || !n;
  if ($("detail").hidden) return;
  $("title").textContent = n.title;
  $("novel-id").textContent = `novelpia.com / novel / ${n.id}`;
  $("title-status").textContent =
    state.statusLabels[n.status] || state.statusLabels.unknown;
  $("title-status").className = "lifecycle " + (n.status || "unknown");
  $("title-status").title = n.statusObservedAt
    ? "Проверен: " + date(n.statusObservedAt)
    : "Появится после успешного чтения статуса";
  $("status-read-warning").hidden = n.statusAvailable !== false;
  $("status-read-warning").textContent =
    (n.status ? "Показан последний известный статус. " : "") +
    (n.statusReason || "Сейчас не удалось прочитать статус страницы.");
  const changes = [...(n.statusHistory || [])].reverse();
  $("status-history-summary").textContent =
    `История статусов${changes.length ? " (" + changes.length + ")" : ""}`;
  $("status-baseline").textContent = changes.length
    ? "Время — момент обнаружения изменения."
    : n.status
      ? "Текущий статус принят за исходный. Оповестим при следующем изменении."
      : "Статус появится после успешной проверки страницы.";
  $("status-history").replaceChildren();
  for (const change of changes.slice(0, statusLimit)) {
    const row = item("li");
    row.append(
      item(
        "span",
        "status-transition",
        `${state.statusLabels[change.from]} → ${state.statusLabels[change.to]}`,
      ),
      item("time", "status-time", date(change.at)),
    );
    $("status-history").append(row);
  }
  $("status-more").hidden = changes.length <= statusLimit;
  const busy = state.busy.includes(n.id);
  $("novel-state").textContent = busy
    ? "Проверяем…"
    : n.error
      ? "Есть ошибка загрузки"
      : n.lastCheck
        ? "Всё сохранено"
        : "Ожидает проверки";
  $("novel-state").classList.toggle("warning", !!n.error);
  $("last-check").textContent = date(n.lastCheck);
  $("next-check").textContent = state.paused
    ? "После снятия паузы"
    : busy
      ? "Проверяем сейчас"
      : date(n.nextCheck);
  $("saved-count").textContent = `${n.history.length} PNG`;
  $("check-one").disabled = busy;
  $("check-one").textContent = busy ? "Проверяем…" : "Проверить сейчас";
  $("error").hidden = !n.error;
  $("error").textContent = n.error;
  const latest = latestCover(n);
  $("cover").hidden = !latest;
  $("no-cover").hidden = !!latest;
  if (latest) {
    const src = image(n.id, latest.hash);
    if ($("cover").src !== src) $("cover").src = src;
  }
  const entries = [...n.history].sort((a, b) =>
    b.savedAt.localeCompare(a.savedAt),
  );
  $("history-count").textContent = `${entries.length} сохранено`;
  $("no-history").hidden = !!entries.length;
  $("history").replaceChildren();
  for (const e of entries.slice(0, limit)) {
    const card = item("article", "history-item"),
      button = item("button", "history-cover");
    button.title = "Открыть PNG";
    button.setAttribute("aria-label", `Открыть обложку от ${date(e.savedAt)}`);
    const img = item("img");
    img.src = image(n.id, e.hash);
    img.alt = e.kind === "original" ? "Оригинал обложки" : "Обложка";
    img.loading = "lazy";
    button.append(img);
    button.onclick = () =>
      call("open-file", { id: n.id, hash: e.hash }).catch((e) =>
        toast(e.message),
      );
    const reveal = item("button", "reveal-file", "Показать в папке");
    reveal.onclick = () =>
      call("show-file", { id: n.id, hash: e.hash }).catch((e) =>
        toast(e.message),
      );
    card.append(
      button,
      item("p", "date", date(e.savedAt)),
      item("p", "meta", `${e.width} × ${e.height} · PNG`),
      item(
        "p",
        "meta",
        e.kind === "original"
          ? "Оригинал"
          : e.kind === "cover"
            ? "Обложка"
            : "Восстановлено из папки",
      ),
      reveal,
    );
    $("history").append(card);
  }
  $("more").hidden = entries.length <= limit;
}
for (const id of ["add", "empty-add"]) $(id).onclick = showAdd;
document.querySelectorAll(".close-dialog").forEach(
  (button) =>
    (button.onclick = () => {
      if (!working) button.closest("dialog").close();
    }),
);
$("search").oninput = () => {
  // Compact windows hide the sidebar title list. Keep the search results visible.
  if (!$("novels").offsetWidth) view = "collection";
  render();
};
$("collection-nav").onclick = () =>
  showView("collection", state?.novels.length ? "collection-heading" : "empty-heading");
function saveCollectionSetting(payload) {
  call("settings", payload).catch((error) => {
    renderCollection($("search").value.trim().toLocaleLowerCase("ru"));
    toast(error.message);
  });
}
$("collection-status").onchange = (event) => saveCollectionSetting({ collectionStatus: event.target.value });
$("collection-sort").onchange = (event) => saveCollectionSetting({ collectionSort: event.target.value });
for (const name of ["grid", "list"])
  $(`collection-${name}`).onclick = () => {
    if ((state.collectionLayout || "grid") !== name) saveCollectionSetting({ collectionLayout: name });
  };
$("activity-nav").onclick = () => {
  if (!state) return;
  showView("activity", "activity-heading");
  // Only acknowledge this snapshot; a later check may already be queued.
  call("activity-read", state.activitySequence).catch(e => toast(e.message));
};
for (const id of ["activity-search", "activity-filter"])
  $(id).addEventListener(id === "activity-search" ? "input" : "change", () => { activityLimit = 40; renderActivity(); });
$("activity-more").onclick = () => { activityLimit += 40; renderActivity(); };
$("activity-read").onclick = () => call("activity-read", state.activitySequence).catch(e => toast(e.message));
$("more").onclick = () => {
  limit += 24;
  render();
};
for (const id of ["choose-root", "change-root"])
  $(id).onclick = () => call("choose-root").catch((e) => toast(e.message));
$("root").onclick = () =>
  call(state.root ? "open-root" : "choose-root").catch((e) => toast(e.message));
$("pause").onclick = () =>
  call("settings", { paused: !state.paused }).catch((e) => toast(e.message));
$("check-all").onclick = () =>
  call("check", null).catch((e) => toast(e.message));
$("check-one").onclick = () =>
  call("check", selected).catch((e) => toast(e.message));
$("open-site").onclick = () =>
  call("open-site", selected).catch((e) => toast(e.message));
$("settings").onclick = () => {
  if (!state) return;
  $("theme").value = state.theme || "light";
  $("interval").value = state.interval;
  $("notifications").checked = state.notifications;
  fillPolicy("status", state.statusNotifications);
  $("login").checked = state.login;
  $("login").disabled = !state.canLogin;
  $("settings-error").textContent = "";
  $("settings-dialog").showModal();
};
$("settings-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    await call("settings", {
      theme: $("theme").value,
      interval: Number($("interval").value),
      notifications: $("notifications").checked,
      statusNotifications: readPolicy("status", true),
      ...(state.canLogin ? { login: $("login").checked } : {}),
    });
    $("settings-dialog").close();
    toast("Настройки сохранены");
  } catch (e) {
    $("settings-error").textContent = e.message;
  }
};
$("add-form").onsubmit = async (event) => {
  event.preventDefault();
  if (working) return;
  working = true;
  $("add-submit").disabled = true;
  $("add-submit").textContent = "Сохраняем…";
  $("add-error").textContent = "";
  try {
    const result = await call("add", $("novel-url").value);
    selectTitle(result.novels.at(-1)?.id);
    $("add-dialog").close();
    toast(
      current()?.error
        ? "Новелла добавлена. Не все изображения удалось загрузить."
        : "Новелла добавлена, обложки сохранены",
    );
  } catch (e) {
    $("add-error").textContent = e.message;
  } finally {
    working = false;
    $("add-submit").disabled = false;
    $("add-submit").textContent = "Добавить и сохранить";
  }
};
$("add-dialog").addEventListener("cancel", (e) => {
  if (working) e.preventDefault();
});
$("status-more").onclick = () => {
  statusLimit += 10;
  render();
};
$("test-notification").onclick = async () => {
  try {
    await call("test-notification");
    toast(
      "Тестовое уведомление отправлено. Если баннер не появился, проверьте настройки Windows.",
    );
  } catch (e) {
    toast(e.message);
  }
};
$("windows-notifications").onclick = () =>
  call("open-notification-settings").catch((e) => toast(e.message));
$("novel-notifications").onclick = () => {
  const n = current();
  policyTitleId = n.id;
  $("policy-title").textContent = n.title;
  $("policy-error").textContent = "";
  $("policy-inherit").checked = !n.statusNotifications;
  fillPolicy("policy", n.statusNotifications || state.statusNotifications);
  $("policy-fields").disabled = $("policy-inherit").checked;
  $("novel-notifications-dialog").showModal();
};
$("policy-inherit").onchange = () => {
  $("policy-fields").disabled = $("policy-inherit").checked;
};
$("novel-notifications-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    await call("novel-notifications", {
      id: policyTitleId,
      policy: $("policy-inherit").checked ? null : readPolicy("policy"),
    });
    $("novel-notifications-dialog").close();
    toast("Настройки тайтла сохранены");
  } catch (e) {
    $("policy-error").textContent = e.message;
  }
};
$("remove").onclick = () => {
  removeTitleId = selected;
  $("remove-dialog").showModal();
};
$("remove-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    await call("remove", removeTitleId);
    $("remove-dialog").close();
    toast("Наблюдение остановлено. Файлы сохранены.");
  } catch (e) {
    toast(e.message);
  }
};
themeMedia.addEventListener("change", applyTheme);
api.subscribe(updateState);
api.subscribeErrors(toast);
api.subscribeSelection((id) => {
  if (!state) {
    pendingSelection = id;
    return;
  }
  if (state?.novels.some((n) => n.id === id)) {
    selectTitle(id);
  }
});
call("snapshot").catch((e) => toast(e.message));
