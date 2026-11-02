"use strict";
const $ = (id) => document.getElementById(id),
  api = window.archiveAPI;
let state,
  selected = null,
  limit = 24,
  toastTimer,
  working = false;
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
  `cover://image/${encodeURIComponent(id)}/${encodeURIComponent(hash)}`;
function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 6500);
}
async function call(action, payload) {
  const result = await api.call(action, payload);
  if (result?.novels) {
    state = result;
    render();
  }
  return result;
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
function showAdd() {
  if (working) return;
  $("add-error").textContent = "";
  $("add-dialog").showModal();
  $("novel-url").focus();
  $("novel-url").select();
}
function render() {
  if (!state) return;
  if (!state.novels.some((n) => n.id === selected)) {
    selected = state.novels[0]?.id || null;
    limit = 24;
  }
  $("recovery").hidden = !state.recovered;
  $("novel-count").textContent = state.novels.length;
  $("monitor-status").textContent = state.paused
    ? "Наблюдение на паузе"
    : state.busy.length
      ? "Проверяем обложки…"
      : "Наблюдение включено";
  $("monitor-status").classList.toggle("paused", state.paused);
  $("pause").textContent = state.paused ? "Продолжить" : "Пауза";
  $("check-all").disabled = !!state.busy.length || !state.novels.length;
  $("root").textContent = state.root
    ? `▱  ${state.root}`
    : "▱  Выберите папку архива";
  $("root").title = state.root || "Выбрать папку архива";
  $("interval-label").textContent = `Интервал: ${state.interval} мин`;
  $("add-root").textContent = state.root || "Папка не выбрана";
  $("settings-root").textContent = state.root || "Папка не выбрана";
  const query = $("search").value.trim().toLowerCase();
  $("novels").replaceChildren();
  for (const n of state.novels.filter((n) =>
    (n.title + " " + n.id).toLowerCase().includes(query),
  )) {
    const row = item(
      "button",
      "novel-row" + (n.id === selected ? " active" : ""),
    );
    row.setAttribute("aria-current", n.id === selected ? "true" : "false");
    const preview = item("img", "row-image");
    const latest =
      n.history.find((e) => e.hash === n.latestHash) || n.history.at(-1);
    if (latest) preview.src = image(n.id, latest.hash);
    preview.alt = "";
    preview.loading = "lazy";
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
            : `${n.history.length} PNG в архиве`,
      ),
    );
    row.append(preview, info);
    row.onclick = () => {
      selected = n.id;
      limit = 24;
      render();
    };
    $("novels").append(row);
  }
  if (!state.novels.length)
    $("novels").append(
      item("p", "muted", "Добавьте новеллы, за которыми хотите следить."),
    );
  else if (!$("novels").children.length)
    $("novels").append(item("p", "muted", "Ничего не найдено."));
  const n = current();
  $("empty").hidden = !!n;
  $("detail").hidden = !n;
  if (!n) return;
  $("title").textContent = n.title;
  $("novel-id").textContent = `novelpia.com / novel / ${n.id}`;
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
  const latest =
    n.history.find((e) => e.hash === n.latestHash) || n.history.at(-1);
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
$("search").oninput = render;
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
  $("interval").value = state.interval;
  $("notifications").checked = state.notifications;
  $("login").checked = state.login;
  $("login").disabled = !state.canLogin;
  $("settings-error").textContent = "";
  $("settings-dialog").showModal();
};
$("settings-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    await call("settings", {
      interval: Number($("interval").value),
      notifications: $("notifications").checked,
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
    selected = result.novels.at(-1)?.id;
    render();
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
$("remove").onclick = () => $("remove-dialog").showModal();
$("remove-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    await call("remove", selected);
    $("remove-dialog").close();
    toast("Наблюдение остановлено. Файлы сохранены.");
  } catch (e) {
    toast(e.message);
  }
};
api.subscribe((value) => {
  state = value;
  render();
});
api.subscribeErrors(toast);
call("snapshot").catch((e) => toast(e.message));
