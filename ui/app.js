"use strict";
const $ = (id) => document.getElementById(id),
  api = window.archiveAPI;
let state,
  selected = null,
  limit = 24,
  toastTimer,
  working = false,
  removing = false,
  statusLimit = 10,
  policyTitleId = null,
  removeTitleId = null,
  view = "collection",
  pendingSelection,
  activityLimit = 40,
  activityRenderKey = "",
  savingCollection = false;
const pendingCollection = new Map();
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
  if (snapshot.revision <= state?.revision) return;
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
function setText(el, text) {
  text = String(text ?? "");
  if (el.textContent !== text) el.textContent = text;
}
function setAttribute(el, name, value) {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS(svg.namespaceURI, "use");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("viewBox", "0 0 24 24");
  use.setAttribute("href", `#icon-${name}`);
  svg.append(use);
  return svg;
}
function reconcileRows(parent, entries, keyOf, renderRow) {
  const previous = new Map(Array.from(parent.children, (row) => [row.dataset.key, row]));
  const rows = entries.map((entry) => {
    const key = keyOf(entry);
    const existing = previous.get(key);
    const row = renderRow(entry, existing);
    if (row.dataset.key !== key) row.dataset.key = key;
    if (row === existing) previous.delete(key);
    return row;
  });
  for (const row of previous.values()) row.remove();
  let cursor = parent.firstElementChild;
  for (const row of rows) {
    if (row === cursor) {
      cursor = cursor.nextElementSibling;
    } else if (row.parentNode === parent) {
      const focused = row.contains(document.activeElement) ? document.activeElement : null;
      const selection = window.getSelection();
      const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
      const selectedText = row.contains(anchorNode) || row.contains(focusNode);
      if (parent.moveBefore) parent.moveBefore(row, cursor);
      else parent.insertBefore(row, cursor);
      if (focused && document.activeElement !== focused) focused.focus({ preventScroll: true });
      if (selectedText && (anchorNode !== selection.anchorNode || focusNode !== selection.focusNode)) {
        selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
      }
    } else {
      parent.insertBefore(row, cursor);
    }
  }
}
function isSelectingText(event) {
  const selection = window.getSelection();
  return event.detail && selection.rangeCount && !selection.isCollapsed &&
    selection.getRangeAt(0).intersectsNode(event.currentTarget);
}
function titleClick(event, id) {
  if (!isSelectingText(event)) selectTitle(id);
}
function markTitle(button, id, page = false) {
  const active = id === selected;
  setAttribute(button, "aria-current", active ? (page ? "page" : "true") : "false");
  button.classList.toggle("active", active && page);
  button.classList.toggle("checking", state.busy.includes(id));
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
  if (!query) return true;
  const titles = (novel.titleHistory || []).flatMap(({ from, to }) => [from, to]);
  return [novel.title, novel.id, ...titles].join(" ").toLocaleLowerCase("ru").includes(query);
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
      for (const entry of novel.titleHistory || []) changed = Math.max(changed, Date.parse(entry.at) || 0);
    }
    return { novel, changed, cover: latestCover(novel) };
  });
}
function syncPreview(frame, id, hash) {
  const src = hash ? image(id, hash) : null;
  let preview = frame.querySelector("img");
  if (!src) {
    preview?.remove();
    return;
  }
  if (!preview) {
    preview = item("img");
    preview.alt = "";
    preview.loading = "lazy";
    preview.decoding = "async";
    preview.onerror = () => { preview.hidden = true; };
    frame.append(preview);
  }
  if (preview.getAttribute("src") !== src) {
    preview.hidden = false;
    preview.src = src;
  }
}
function createCollectionCard(id) {
  const card = item("button", "collection-card");
  card.type = "button";
  card.dataset.novelId = id;
  card.onclick = (event) => titleClick(event, id);
  const frame = item("span", "collection-cover");
  const placeholder = item("span", "collection-placeholder");
  placeholder.setAttribute("aria-hidden", "true");
  placeholder.append(icon("book"), item("span", "", "Без обложки"));
  frame.append(placeholder);
  const body = item("span", "collection-card-body");
  const meta = item("span", "collection-meta");
  meta.append(item("span", "collection-status"), item("time", "collection-time"));
  body.append(item("span", "collection-title"), meta);
  card.append(frame, body);
  const row = item("li");
  row.append(card);
  return row;
}
function collectionCard({ novel, changed, cover }, row = createCollectionCard(novel.id)) {
  const card = row.firstElementChild;
  markTitle(card, novel.id);
  syncPreview(card.firstElementChild, novel.id, cover?.hash);
  const title = card.querySelector(".collection-title");
  setText(title, novel.title);
  setAttribute(title, "title", novel.title);
  const status = novel.status || "unknown";
  const badge = card.querySelector(".collection-status");
  setAttribute(badge, "class", `collection-status lifecycle ${status}`);
  setText(badge, state.statusLabels[status] || state.statusLabels.unknown);
  const time = card.querySelector("time");
  time.hidden = !changed;
  if (changed && changed !== Number(time.dataset.changed)) {
    const when = new Date(changed);
    time.dataset.changed = changed;
    setText(time, shortDate.format(when));
    time.dateTime = when.toISOString();
    time.title = `Последнее изменение: ${when.toLocaleString("ru-RU")}`;
    time.setAttribute("aria-label", time.title);
  }
  return row;
}
function collectionValue(name, fallback) {
  return pendingCollection.get(name) ?? state[name] ?? fallback;
}
function renderCollection(query) {
  const active = view === "collection";
  setAttribute($("collection-nav"), "aria-current", active ? "page" : "false");
  $("collection-view").hidden = !active || !state.novels.length;
  if ($("collection-view").hidden) return;
  const sort = collectionValue("collectionSort", "changed");
  const status = collectionValue("collectionStatus", "all");
  const layout = collectionValue("collectionLayout", "grid");
  if ($("collection-sort").value !== sort) $("collection-sort").value = sort;
  if ($("collection-status").value !== status) $("collection-status").value = status;
  for (const name of ["grid", "list"])
    setAttribute($(`collection-${name}`), "aria-pressed", String(layout === name));
  const list = $("collection-items");
  if (list.dataset.layout !== layout) list.dataset.layout = layout;
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
  setText($("collection-count"), count);
  $("collection-empty").hidden = !!matches.length;
  reconcileRows(list, matches, ({ novel }) => novel.id, collectionCard);
}
function activityDescription(event) {
  const count = event.covers?.length || 0;
  const archiveDetail = "Архив перемещён в корзину Windows";
  switch (event.type) {
    case "cover_saved":
      return { label: event.initial ? "Первые обложки сохранены" : count === 1 ? "Новая обложка" : "Новые обложки", detail: event.archiveDeleted ? archiveDetail : `${count} PNG в архиве`, icon: "image", group: "covers" };
    case "cover_restored":
      return { label: "PNG восстановлены", detail: event.archiveDeleted ? archiveDetail : `${count} PNG повторно сохранено после удаления файла`, icon: "refresh", group: "covers" };
    case "status_changed":
      return { label: "Изменился статус", detail: `${state.statusLabels[event.from] || event.from} → ${state.statusLabels[event.to] || event.to}`, icon: "arrow-right", group: "status" };
    case "title_renamed":
      return { label: "Изменилось название", detail: `${event.from} ${event.to}`, icon: "pencil", group: "titles" };
    case "watch_added":
      return { label: event.resumed ? "Наблюдение возобновлено" : "Добавлен в наблюдение", detail: "", icon: "plus", group: "watch" };
    case "watch_removed":
      return { label: "Убран из наблюдения", detail: event.archiveDeleted ? archiveDetail : "Сохранённые обложки остаются в архиве", icon: "minus", group: "watch" };
    default:
      return { label: "Изменение тайтла", detail: "", icon: "clock", group: "watch" };
  }
}
function titleTransition(from, to) {
  const transition = item("dl", "title-transition");
  for (const [label, title] of [["Было", from], ["Стало", to]]) {
    const field = item("div");
    field.append(item("dt", "", label), item("dd", "", title));
    transition.append(field);
  }
  return transition;
}
function renderActivity() {
  const events = state.activity || [];
  const unread = events.filter(e => e.sequence > state.activityReadSequence).length;
  setText($("activity-badge"), unread);
  $("activity-badge").hidden = !unread;
  setAttribute($("activity-nav"), "aria-current", view === "activity" ? "page" : "false");
  setAttribute($("activity-nav"), "aria-label", `Последние события${unread ? `, непрочитанных: ${unread}` : ""}`);
  $("activity-view").hidden = view !== "activity";
  if (view !== "activity") return;
  $("activity-read").disabled = !unread;
  const query = $("activity-search").value.trim().toLocaleLowerCase("ru"), filter = $("activity-filter").value;
  // Busy/check snapshots do not recreate thumbnails or move keyboard focus.
  const active = new Set(state.novels.map((n) => n.id));
  const key = JSON.stringify([state.activitySequence, state.activityReadSequence, query, filter, activityLimit, [...active]]);
  if (key === activityRenderKey) return;
  activityRenderKey = key;
  const matching = [...events].reverse().filter(event => {
    const description = activityDescription(event);
    return (filter === "all" || filter === description.group) && `${event.title} ${event.novelId} ${description.label} ${description.detail}`.toLocaleLowerCase("ru").includes(query);
  });
  setText($("activity-count"), `Показано ${Math.min(activityLimit, matching.length)} из ${matching.length}`);
  $("activity-empty").hidden = !!matching.length;
  setText($("activity-empty-title"), events.length ? "События не найдены" : "Пока нет событий");
  setText($("activity-empty-text"), events.length ? "Попробуйте другой запрос или тип события." : "Здесь появятся новые обложки, смены статуса и другие изменения тайтлов.");
  reconcileRows($("activity-list"), matching.slice(0, activityLimit), (event) => String(event.sequence),
    (event, existing) => activityRow(event, existing, active.has(event.novelId)));
  $("activity-more").hidden = matching.length <= activityLimit;
}
function activityRow(event, existing, active) {
    const description = activityDescription(event);
    const key = `${active}:${!!event.archiveDeleted}`;
    const unread = event.sequence > state.activityReadSequence;
    if (existing?.dataset.version === key) {
      existing.classList.toggle("unread", unread);
      existing.querySelector(".activity-new").hidden = !unread;
      existing.querySelector(".activity-tags").hidden = !unread && !event.imported && active;
      return existing;
    }
    const row = item("li", `activity-event ${description.group}${unread ? " unread" : ""}`);
    row.dataset.version = key;
    row.dataset.sequence = event.sequence;
    row.dataset.type = event.type;
    const badge = item("span", "activity-icon");
    badge.append(icon(description.icon));
    const body = item("div", "activity-body"), head = item("div", "activity-event-heading");
    head.append(item("strong", "activity-label", description.label));
    const time = item("time", "activity-time", new Date(event.at).toLocaleString("ru-RU", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }));
    time.dateTime = event.at;
    head.append(time);
    const title = item("button", "activity-title", event.title || `Novelpia ${event.novelId}`);
    title.title = active ? "Перейти к тайтлу" : "Открыть страницу на Novelpia";
    title.onclick = (click) => {
      if (isSelectingText(click)) return;
      if (active) selectTitle(event.novelId);
      else call("open-site", event.novelId).catch(e => toast(e.message));
    };
    body.append(head, title);
    if (event.type === "title_renamed") body.append(titleTransition(event.from, event.to));
    else if (description.detail) body.append(item("p", "activity-detail", description.detail));
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
        info.append(item("span", "", `${entry.width} × ${entry.height} · PNG`));
        button.append(preview, info);
        button.onclick = () => call("open-file", { id: event.novelId, hash: entry.hash }).catch(e => toast(e.message));
        covers.append(button);
      }
      body.append(covers);
    }
    const tags = item("div", "activity-tags");
    const newTag = item("span", "activity-new", "Новое");
    newTag.hidden = !unread;
    tags.append(newTag);
    if (event.imported) tags.append(item("span", "", "Из истории"));
    if (!active) tags.append(item("span", "", "Снят с наблюдения · название откроет страницу"));
    tags.hidden = !unread && !event.imported && active;
    body.append(tags);
    row.append(badge, body);
    return row;
}
function showAdd() {
  if (working) return;
  $("add-error").textContent = "";
  $("add-dialog").showModal();
  $("novel-url").focus();
  $("novel-url").select();
}
function createSidebarRow(id) {
  const row = item("button", "novel-row");
  row.type = "button";
  row.dataset.novelId = id;
  row.onclick = (event) => titleClick(event, id);
  const preview = item("span", "row-image");
  preview.setAttribute("aria-hidden", "true");
  preview.append(icon("book"));
  const info = item("span", "row-info");
  info.append(item("span", "row-title"), item("span", "row-status"));
  row.append(preview, info);
  return row;
}
function renderSidebar(query) {
  const matching = state.novels.filter((n) => matchesTitle(n, query));
  reconcileRows($("novels"), matching, (n) => n.id, (n, row = createSidebarRow(n.id)) => {
    markTitle(row, n.id, view === "title");
    syncPreview(row.firstElementChild, n.id, latestCover(n)?.hash);
    setText(row.querySelector(".row-title"), n.title);
    setText(row.querySelector(".row-status"), state.busy.includes(n.id)
      ? "Проверка…"
      : state.queued?.includes(n.id)
        ? "В очереди"
        : n.error
          ? "Нужна повторная проверка"
          : `${state.statusLabels[n.status] || state.statusLabels.unknown} · ${n.history.length} PNG`);
    return row;
  });
  $("sidebar-empty").hidden = !!matching.length;
  setText($("sidebar-empty"), state.novels.length
    ? "Ничего не найдено."
    : "Добавьте новеллы, за которыми хотите следить.");
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
  setText($("notification-warning"), state.notificationWarning);
  setText($("novel-count"), state.novels.length);
  const progress = state.checkProgress;
  const checking = !!progress || !!state.busy.length;
  setText($("monitor-label"), checking ? "Проверяем тайтлы…" : state.paused
    ? "Наблюдение на паузе"
    : "Наблюдение включено");
  setText($("check-progress"), progress ? `[${progress.completed}/${progress.total}]` : "");
  $("check-progress").hidden = !progress;
  $("monitor-status").classList.toggle("paused", state.paused && !checking);
  setText($("pause-label"), state.paused ? "Продолжить" : "Пауза");
  setAttribute($("pause").querySelector("use"), "href", state.paused ? "#icon-play" : "#icon-pause");
  $("check-all").disabled = checking || !state.novels.length;
  setText($("root-path"), state.root || "Выберите папку архива");
  setAttribute($("root"), "title", state.root || "Выбрать папку архива");
  setText($("interval-label"), `v${state.appVersion} · Интервал: ${state.interval} мин`);
  setText($("add-root"), state.root || "Папка не выбрана");
  setText($("settings-root"), state.root || "Папка не выбрана");
  const query = $("search").value.trim().toLocaleLowerCase("ru");
  renderSidebar(query);
  const n = current();
  renderCollection(query);
  renderActivity();
  $("empty").hidden = view === "activity" || !!n;
  $("detail").hidden = view !== "title" || !n;
  if ($("detail").hidden) return;
  setText($("title"), n.title);
  setText($("novel-id"), `novelpia.com / novel / ${n.id}`);
  setText($("title-status"), state.statusLabels[n.status] || state.statusLabels.unknown);
  setAttribute($("title-status"), "class", "lifecycle " + (n.status || "unknown"));
  setAttribute($("title-status"), "title", n.statusObservedAt
    ? "Проверен: " + date(n.statusObservedAt)
    : "Появится после успешного чтения статуса");
  $("status-read-warning").hidden = n.statusAvailable !== false;
  setText($("status-read-warning"),
    (n.status ? "Показан последний известный статус. " : "") +
    (n.statusReason || "Сейчас не удалось прочитать статус страницы."));
  const changes = [...(n.statusHistory || [])].reverse();
  setText($("status-history-summary"), `История статусов${changes.length ? " (" + changes.length + ")" : ""}`);
  setText($("status-baseline"), changes.length
    ? "Время — момент обнаружения изменения."
    : n.status
      ? "Текущий статус принят за исходный. Оповестим при следующем изменении."
      : "Статус появится после успешной проверки страницы.");
  reconcileRows($("status-history"), changes.slice(0, statusLimit),
    (change) => JSON.stringify([n.id, change.at, change.from, change.to]), (change, existing) => {
      if (existing) return existing;
      const row = item("li");
      row.append(
        item("span", "status-transition", `${state.statusLabels[change.from]} → ${state.statusLabels[change.to]}`),
        item("time", "status-time", date(change.at)),
      );
      return row;
    });
  $("status-more").hidden = changes.length <= statusLimit;
  const names = [...(n.titleHistory || [])].reverse();
  $("title-history-panel").hidden = !names.length;
  setText($("title-history-summary"), `История названий (${names.length})`);
  reconcileRows($("title-history"), names,
    (change) => JSON.stringify([n.id, change.at, change.from, change.to]), (change, existing) => {
      if (existing) return existing;
      const row = item("li");
      const time = item("time", "status-time", date(change.at));
      time.dateTime = change.at;
      row.append(titleTransition(change.from, change.to), time);
      return row;
    });
  const busy = state.busy.includes(n.id);
  const queued = state.queued?.includes(n.id);
  setText($("novel-state"), busy
    ? "Проверяем…"
    : queued
      ? "В очереди на проверку"
      : n.error
        ? "Есть ошибка загрузки"
        : n.lastCheck
          ? "Всё сохранено"
          : "Ожидает проверки");
  $("novel-state").classList.toggle("warning", !!n.error);
  setText($("last-check"), date(n.lastCheck));
  setText($("next-check"), busy ? "Проверяем сейчас" : queued ? "В очереди"
    : state.paused ? "После снятия паузы" : date(n.nextCheck));
  setText($("saved-count"), `${n.history.length} PNG`);
  $("check-one").disabled = busy || !!queued;
  setText($("check-one-label"), busy ? "Проверяем…" : queued ? "В очереди" : "Проверить сейчас");
  $("error").hidden = !n.error;
  setText($("error"), n.error);
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
  setText($("history-count"), `${entries.length} сохранено`);
  $("no-history").hidden = !!entries.length;
  reconcileRows($("history"), entries.slice(0, limit), (e) => `${n.id}/${e.hash}`, (e, existing) => {
    if (existing) return existing;
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
    return card;
  });
  $("more").hidden = entries.length <= limit;
}
for (const id of ["add", "empty-add"]) $(id).onclick = showAdd;
document.querySelectorAll(".close-dialog").forEach(
  (button) =>
    (button.onclick = () => {
      const dialog = button.closest("dialog");
      if ((dialog.id === "add-dialog" && working) || (dialog.id === "remove-dialog" && removing)) return;
      dialog.close();
    }),
);
$("search").oninput = () => {
  // Compact windows hide the sidebar title list. Keep the search results visible.
  if (!$("novels").offsetWidth) view = "collection";
  render();
};
$("collection-nav").onclick = () =>
  showView("collection", state?.novels.length ? "collection-heading" : "empty-heading");
async function saveCollectionSetting(name, value) {
  pendingCollection.set(name, value);
  const renderPreferences = () => renderCollection($("search").value.trim().toLocaleLowerCase("ru"));
  renderPreferences();
  if (savingCollection) return;
  savingCollection = true;
  while (pendingCollection.size) {
    const changes = [...pendingCollection];
    try {
      await call("settings", Object.fromEntries(changes));
    } catch (error) {
      toast(error.message);
    }
    for (const [name, value] of changes) {
      if (pendingCollection.get(name) === value) pendingCollection.delete(name);
    }
    renderPreferences();
  }
  savingCollection = false;
}
$("collection-status").onchange = (event) => saveCollectionSetting("collectionStatus", event.target.value);
$("collection-sort").onchange = (event) => saveCollectionSetting("collectionSort", event.target.value);
for (const name of ["grid", "list"])
  $(`collection-${name}`).onclick = () => {
    if (collectionValue("collectionLayout", "grid") !== name) saveCollectionSetting("collectionLayout", name);
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
  setText($("add-submit"), "Добавляем…");
  $("add-error").textContent = "";
  try {
    const url = $("novel-url").value;
    const result = await call("add", url);
    const id = result.addedId ?? new URL(url.trim()).pathname.match(/^\/novel\/(\d+)\/?$/)?.[1];
    $("add-dialog").close();
    if (state.novels.some((n) => n.id === id)) selectTitle(id);
    toast("Новелла добавлена. Первая проверка запланирована.");
  } catch (e) {
    $("add-error").textContent = e.message;
  } finally {
    working = false;
    $("add-submit").disabled = false;
    setText($("add-submit"), "Добавить");
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
  setText($("remove-title"), current().title);
  setText($("remove-error"), "");
  $("remove-archive").checked = false;
  $("remove-dialog").showModal();
};
$("remove-dialog").addEventListener("cancel", (event) => {
  if (removing) event.preventDefault();
});
$("remove-form").onsubmit = async (event) => {
  event.preventDefault();
  if (removing) return;
  removing = true;
  const deleteArchive = $("remove-archive").checked;
  $("remove-submit").disabled = true;
  $("remove-archive").disabled = true;
  setText($("remove-error"), "");
  try {
    await call("remove", { id: removeTitleId, deleteArchive });
    $("remove-dialog").close();
    toast(deleteArchive
      ? "Наблюдение остановлено. Архив перемещён в корзину Windows."
      : "Наблюдение остановлено. Файлы сохранены.");
  } catch (e) {
    setText($("remove-error"), e.message);
  } finally {
    removing = false;
    $("remove-submit").disabled = false;
    $("remove-archive").disabled = false;
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
