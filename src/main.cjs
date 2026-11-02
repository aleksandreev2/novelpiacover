"use strict";
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  dialog,
  shell,
  net,
  protocol,
  Notification,
  powerMonitor,
  nativeImage,
} = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { Store, atomicWrite } = require("./store.cjs");
const { Archive } = require("./archive.cjs");
const { Monitor } = require("./monitor.cjs");
const { fetchResource } = require("./http.cjs");
const { decodeImage, makeIcon } = require("./images.cjs");
protocol.registerSchemesAsPrivileged([
  {
    scheme: "cover",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
async function startApplication({ show = true, autoStart = true } = {}) {
  await app.whenReady();
  app.setAppUserModelId("com.novelpia.coverarchive");
  const store = await Store.open(app.getPath("userData"));
  const monitor = new Monitor({
    store,
    archive: new Archive(),
    fetchResource: (url, opts) =>
      fetchResource(url, { ...opts, fetchImpl: net.fetch }),
    decode: decodeImage,
  });
  const icon = makeIcon();
  const uiPath = path.join(__dirname, "../ui/index.html");
  let quitting = false,
    window,
    timer;
  const snapshot = () => ({ ...monitor.snapshot(), canLogin: app.isPackaged });
  const cache = path.join(app.getPath("userData"), "previews");
  await fs.mkdir(cache, { recursive: true });
  const getEntry = (id, hash) => {
    if (typeof id !== "string" || typeof hash !== "string")
      throw new Error("Неверный файл.");
    const n = store.state.novels.find((n) => n.id === id),
      entry = n?.history.find((e) => e.hash === hash);
    if (!entry) throw new Error("Изображение не найдено в архиве.");
    return entry;
  };
  await protocol.handle("cover", async (request) => {
    try {
      const u = new URL(request.url);
      if (u.hostname !== "image") return new Response("", { status: 404 });
      const [id, hash] = u.pathname.slice(1).split("/");
      const entry = getEntry(id, hash);
      const file = path.join(cache, hash + ".jpg");
      let bytes;
      try {
        bytes = await fs.readFile(file);
      } catch {
        const image = nativeImage.createFromPath(entry.file);
        if (image.isEmpty()) return new Response("", { status: 404 });
        const size = image.getSize();
        bytes = image
          .resize({ width: Math.min(size.width, 560), quality: "good" })
          .toJPEG(85);
        await atomicWrite(file, bytes);
      }
      return new Response(bytes, {
        headers: {
          "Content-Type": "image/jpeg",
          "Cache-Control": "public,max-age=31536000,immutable",
        },
      });
    } catch {
      return new Response("", { status: 404 });
    }
  });
  window = new BrowserWindow({
    width: 1180,
    height: 810,
    minWidth: 900,
    minHeight: 650,
    show: false,
    title: "Novelpia Cover Archive",
    backgroundColor: "#f3f6fa",
    icon,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (e) => e.preventDefault());
  window.webContents.session.setPermissionRequestHandler(
    (_wc, _permission, callback) => callback(false),
  );
  window.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      window.hide();
    }
  });
  const reveal = () => {
    if (!window.isDestroyed()) {
      window.show();
      window.restore();
      window.focus();
    }
  };
  const report = (e) => {
    if (!window.isDestroyed())
      window.webContents.send("archive:error", e.message);
  };
  const tray = new Tray(icon);
  tray.setToolTip("Novelpia • Архив обложек");
  const trayMenu = () =>
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Открыть архив обложек", click: reveal },
        {
          label: store.state.paused
            ? "Продолжить наблюдение"
            : "Приостановить наблюдение",
          click: () =>
            monitor.update({ paused: !store.state.paused }).catch(report),
        },
        {
          label: "Проверить все сейчас",
          click: () => monitor.checkAll().catch(report),
        },
        { type: "separator" },
        { label: "Выход", click: () => app.quit() },
      ]),
    );
  trayMenu();
  tray.on("click", reveal);
  tray.on("double-click", reveal);
  monitor.on("changed", () => {
    trayMenu();
    if (!window.isDestroyed() && !window.webContents.isLoadingMainFrame())
      window.webContents.send("archive:changed", snapshot());
  });
  monitor.on("saved", (event) => {
    if (store.state.notifications && Notification.isSupported())
      new Notification({
        title: "Сохранены новые обложки",
        body: `${event.title}: ${event.count}`,
        icon,
        silent: true,
      }).show();
  });
  ipcMain.handle("archive:action", async (event, action, payload) => {
    try {
      if (
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        event.senderFrame.url !== pathToFileURL(uiPath).href
      )
        throw new Error("Недопустимый источник запроса.");
      let value;
      switch (action) {
        case "snapshot":
          value = snapshot();
          break;
        case "add":
          await monitor.add(payload);
          value = snapshot();
          break;
        case "check":
          if (payload === null || payload === undefined)
            await monitor.checkAll();
          else {
            if (
              typeof payload !== "string" ||
              !store.state.novels.some((n) => n.id === payload)
            )
              throw new Error("Новелла не найдена.");
            await monitor.check(payload);
          }
          value = snapshot();
          break;
        case "remove":
          if (typeof payload !== "string") throw new Error("Неверная новелла.");
          await monitor.remove(payload);
          value = snapshot();
          break;
        case "choose-root": {
          const result = await dialog.showOpenDialog(window, {
            title: "Папка для архива обложек",
            properties: ["openDirectory", "createDirectory"],
            defaultPath: store.state.root || app.getPath("pictures"),
          });
          if (!result.canceled)
            await monitor.update({ root: result.filePaths[0] });
          value = snapshot();
          break;
        }
        case "settings": {
          if (
            !payload ||
            Object.keys(payload).some(
              (k) =>
                !["interval", "paused", "notifications", "login"].includes(k),
            )
          )
            throw new Error("Недопустимая настройка.");
          if ("login" in payload) {
            if (typeof payload.login !== "boolean")
              throw new Error("Неверное значение автозапуска.");
            if (!app.isPackaged)
              throw new Error("Автозапуск доступен в готовой сборке.");
            app.setLoginItemSettings({
              openAtLogin: payload.login,
              args: ["--hidden"],
            });
          }
          await monitor.update(payload);
          value = snapshot();
          break;
        }
        case "open-site": {
          const n = store.state.novels.find((n) => n.id === payload);
          if (!n) throw new Error("Новелла не найдена.");
          const { parseNovelUrl } = require("./novelpia.cjs");
          await shell.openExternal(parseNovelUrl(n.url).url);
          break;
        }
        case "open-file": {
          const entry = getEntry(payload?.id, payload?.hash);
          const error = await shell.openPath(entry.file);
          if (error)
            throw new Error(
              "Файл недоступен. Запустите проверку, чтобы восстановить его.",
            );
          break;
        }
        case "show-file": {
          const entry = getEntry(payload?.id, payload?.hash);
          await fs.access(entry.file);
          shell.showItemInFolder(entry.file);
          break;
        }
        case "open-root": {
          if (!store.state.root) throw new Error("Сначала выберите папку.");
          const error = await shell.openPath(store.state.root);
          if (error) throw new Error(error);
          break;
        }
        default:
          throw new Error("Неизвестное действие.");
      }
      return { ok: true, value };
    } catch (e) {
      return {
        ok: false,
        error: e.message || "Не удалось выполнить действие.",
      };
    }
  });
  await window.loadFile(uiPath);
  if (show) reveal();
  const tick = () => monitor.tick().catch(report);
  if (autoStart) {
    timer = setInterval(tick, 15000);
    tick();
  }
  powerMonitor.on("resume", tick);
  const shutdown = async () => {
    if (quitting) return;
    quitting = true;
    clearInterval(timer);
    powerMonitor.removeListener("resume", tick);
    await monitor.queue;
    ipcMain.removeHandler("archive:action");
    protocol.unhandle("cover");
    tray.destroy();
    if (!window.isDestroyed()) window.destroy();
  };
  app.on("before-quit", (event) => {
    if (!quitting) {
      event.preventDefault();
      shutdown()
        .then(() => app.quit())
        .catch(() => app.exit(1));
    }
  });
  app.on("activate", reveal);
  return { window, monitor, tray, shutdown };
}
if (require.main === module) {
  if (process.env.NOVELPIA_PROFILE) {
    const profile = process.env.NOVELPIA_PROFILE;
    if (!path.isAbsolute(profile))
      throw new Error("NOVELPIA_PROFILE должен быть абсолютным путём.");
    app.setPath("userData", profile);
  }
  if (!app.requestSingleInstanceLock()) app.quit();
  else {
    let running;
    app.on("second-instance", () => {
      running?.window.show();
      running?.window.restore();
      running?.window.focus();
    });
    startApplication({ show: !process.argv.includes("--hidden") })
      .then((result) => {
        running = result;
      })
      .catch((e) => {
        dialog.showErrorBox("Не удалось открыть архив", e.message);
        app.exit(1);
      });
  }
}
module.exports = { startApplication };
