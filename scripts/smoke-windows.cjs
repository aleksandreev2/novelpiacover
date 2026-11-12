"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const net = require("node:net");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createHash } = require("node:crypto");
const exec = promisify(execFile);
const repo = path.resolve(__dirname, "..");
const exe = path.resolve(process.env.NOVELPIA_EXE || path.join(repo, "src-tauri/target/release/NovelpiaCoverArchive.exe"));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let child, socket;
const pending = new Map();
let requestId = 0;

async function until(check, description, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(75);
  }
  assert.fail(description);
}

function cdp(method, params = {}) {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("CDP timeout: " + method));
    }, 10000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await cdp("Runtime.evaluate", {
    expression, awaitPromise: true, returnByValue: true,
  });
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  return response.result.value;
}

function call(action, payload = null) {
  return evaluate(`window.archiveAPI.call(${JSON.stringify(action)},${JSON.stringify(payload)})`);
}

async function start(profile, args, extraEnv = {}) {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  child = spawn(exe, args, {
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      NOVELPIA_PROFILE: profile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=" + port,
      ...extraEnv,
    },
  });
  let target;
  await until(async () => {
    assert.equal(child.exitCode, null, "Windows app exited before creating its WebView");
    try {
      const targets = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json();
      target = targets.find((t) => t.type === "page" && t.url.startsWith("http://tauri.localhost"));
    } catch {
      // WebView2 has not opened the loopback endpoint yet.
    }
    return target;
  }, "WebView2 did not start", 20000);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const done = pending.get(message.id);
    if (done) {
      pending.delete(message.id);
      done(message);
    }
  };
  await until(() => evaluate("!!window.archiveAPI && document.readyState === 'complete'"), "Archive bridge did not start");
}

async function stop() {
  socket?.close();
  socket = null;
  if (child?.exitCode === null) {
    await exec("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }).catch(() => {});
  }
  child = null;
}

async function fixture(profile, archive) {
  const folder = "Книга [434103]";
  await fs.mkdir(path.join(archive, folder), { recursive: true });
  const hash = createHash("sha256").update("1x1:").update(Buffer.from([255, 0, 0, 255])).digest("hex");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
  const file = path.join(archive, folder, "2026-11-01T10-00-00-000Z_" + hash + ".png");
  await fs.writeFile(file, png);
  await fs.writeFile(path.join(profile, "settings.json"), JSON.stringify({
    version: 1, root: archive, interval: 30, paused: true, login: false,
    notifications: false,
    activitySequence: 1,
    activity: [{ sequence: 1, type: "title_renamed", novelId: "391344",
      title: "Второй тайтл", from: "Прежнее название", to: "Второй тайтл", at: "2026-11-02T10:10:00Z" }],
    statusNotifications: { enabled: false, targets: ["completed", "discontinued", "ongoing"], sound: false },
    novels: [
      {
        id: "434103", url: "https://novelpia.com/novel/434103", title: "Книга из старого архива", folder,
        history: [{ hash, file, savedAt: "2026-11-01T10:00:00.000Z", width: 1, height: 1, bytes: png.length, kind: "original", source: "" }],
        latestHash: hash, status: "ongoing", statusHistory: [],
      },
      {
        id: "391344", url: "https://novelpia.com/novel/391344", title: "Второй тайтл",
        folder: "", history: [], status: "completed",
        statusHistory: [{ id: "old-1", novelId: "391344", title: "Второй тайтл", from: "ongoing", to: "completed", at: "2026-11-02T10:00:00Z" }],
      },
    ],
    retired: {},
  }));
  return file;
}

async function checkInProgress(base) {
  const profile = path.join(base, "profile-check");
  await fs.mkdir(profile);
  const png = await fixture(profile, path.join(base, "archive-check"));
  const connections = [];
  const proxy = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", (request) => {
      if (/^CONNECT novelpia\.com:443 HTTP\//.test(request.toString())) connections.push(socket);
      else socket.destroy();
    });
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = "http://127.0.0.1:" + proxy.address().port;
  const failRequest = (index) => connections[index].end("HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n");
  const card = '[data-novel-id="391344"] .collection-title';
  try {
    await start(profile, ["--hidden"], { HTTPS_PROXY: address, ALL_PROXY: address, NO_PROXY: "127.0.0.1,localhost" });
    await until(() => evaluate(`!!document.querySelector(${JSON.stringify(card)})`), "Collection did not load");
    await evaluate(`(() => {
      const title = document.querySelector(${JSON.stringify(card)});
      const range = document.createRange();
      range.selectNodeContents(title);
      window.getSelection().addRange(range);
      window.smokeTitle = title;
    })()`);
    const started = await call("check");
    assert.equal(started.checkProgress.total, 2);
    await until(() => connections.length === 1, "The first check did not reach the local proxy");
    await until(() => evaluate("document.querySelector('#monitor-status').textContent.includes('[0/2]')"), "Initial progress did not render");
    await until(() => evaluate("!!document.querySelector('.collection-card.checking[data-novel-id=\"434103\"]')"), "The active title was not highlighted");
    assert.equal(await evaluate("window.getSelection().toString()"), "Второй тайтл");
    assert.equal(await evaluate(`window.smokeTitle === document.querySelector(${JSON.stringify(card)})`), true);
    await evaluate("document.querySelector('#collection-list').click()");
    await until(async () => (await call("snapshot")).collectionLayout === "list", "Layout did not save while the network was held", 2500);
    const added = await call("add", "https://novelpia.com/novel/434104");
    assert.ok(added.novels.some((novel) => novel.id === "434104"));
    assert.deepEqual(added.busy, ["434103"]);
    assert.deepEqual(added.queued, ["434104", "391344"]);
    assert.deepEqual(added.checkProgress, { completed: 0, total: 3 });
    failRequest(0);
    await until(async () => connections.length === 2 && (await call("snapshot")).busy.includes("434104"), "The newly added title was not checked next");
    await until(() => evaluate("document.querySelector('#monitor-status').textContent.includes('[1/3]')"), "The progress counter did not advance");
    failRequest(1);
    await until(() => connections.length === 3, "The rest of the batch did not resume");
    failRequest(2);
    await until(async () => (await call("snapshot")).checkProgress === null, "Check progress did not clear");
    if (process.env.NOVELPIA_SMOKE_RECYCLE === "1") {
      const archive = path.dirname(png);
      const unrelated = path.join(archive, "notes.txt");
      await fs.writeFile(unrelated, "unrelated test file");
      await assert.rejects(call("remove", { id: "434103", deleteArchive: true }));
      await fs.access(png);
      assert.ok((await call("snapshot")).novels.some((novel) => novel.id === "434103"));
      await fs.unlink(unrelated);
      await evaluate("document.querySelector('.collection-card[data-novel-id=\"434103\"]').click()");
      await evaluate("document.querySelector('#remove').click()");
      assert.equal(await evaluate("document.querySelector('#remove-archive').checked"), false);
      await evaluate("document.querySelector('#remove-archive').click(); document.querySelector('#remove-form').requestSubmit()");
      await until(async () => !!(await call("snapshot")).retired["434103"], "Confirmed archive removal did not finish");
      const removed = await call("snapshot");
      assert.deepEqual(removed.retired["434103"].history, []);
      assert.equal(removed.activity.findLast((event) => event.type === "watch_removed").archiveDeleted, true);
      await assert.rejects(fs.access(archive), { code: "ENOENT" });
      console.log("RECYCLE PASS: mixed archive rejected, confirmed fixture folder recycled");
    }
    console.log("ACTIVE CHECK PASS: UI selection, live collection changes, queued addition and progress");
  } finally {
    for (const socket of connections) socket.destroy();
    proxy.close();
    await stop();
  }
}

async function main() {
  await fs.access(exe);
  const scratch = path.join(repo, ".test-data/rust-smoke");
  await fs.mkdir(scratch, { recursive: true });
  const base = await fs.mkdtemp(path.join(scratch, "run-"));
  const profile = path.join(base, "profile");
  await fs.mkdir(profile);
  const png = await fixture(profile, path.join(base, "archive"));
  await start(profile, ["--hidden", "novelpia-archive://title/391344"]);
  await until(() => evaluate("!document.querySelector('#detail').hidden && document.querySelector('#title').textContent === 'Второй тайтл'"), "Cold notification activation did not open the title");
  const initial = await call("snapshot");
  assert.equal(initial.appVersion, require("../package.json").version);
  assert.equal(initial.activity.length, 3);
  assert.equal(initial.activityReadSequence, initial.activitySequence);
  assert.ok(initial.statusNotifications.targets.includes("delayed"));
  assert.equal(initial.novels[1].titleHistory[0].from, "Прежнее название");
  assert.ok(await evaluate("document.querySelector('#title-history').textContent.includes('Прежнее название')"));
  await evaluate("document.querySelector('#collection-nav').click()");
  assert.equal(await evaluate("document.querySelectorAll('.collection-card').length"), 2);
  assert.equal(await evaluate("document.querySelector('.collection-card').textContent.includes('Второй тайтл')"), true);
  await evaluate("document.querySelector('#search').value = 'Прежнее название'; document.querySelector('#search').dispatchEvent(new Event('input'))");
  assert.equal(await evaluate("document.querySelectorAll('.collection-card').length"), 1);
  await evaluate("document.querySelector('#search').value = ''; document.querySelector('#search').dispatchEvent(new Event('input'))");
  await call("settings", { theme: "dark", collectionStatus: "completed", collectionLayout: "list" });
  await until(() => evaluate("document.querySelectorAll('.collection-card').length === 1"), "Status filter did not apply");
  await evaluate("document.querySelector('#activity-nav').click()");
  assert.equal(await evaluate("document.querySelectorAll('.activity-event').length"), 3);
  await until(() => evaluate("document.querySelector('.activity-cover img')?.naturalWidth > 0"), "Legacy PNG preview did not load");
  if (process.env.NOVELPIA_SMOKE_CLICK_TOAST === "1") {
    await stop();
    await start(profile, ["--hidden"]);
    await call("test-notification", "434103");
    console.log("Native test toast submitted. Click it to verify title activation.");
  } else if (process.env.NOVELPIA_SMOKE_REGISTERED_PROTOCOL === "1") {
    if (process.env.NOVELPIA_SMOKE_TOAST === "1") {
      await stop();
      await start(profile, ["--hidden"]);
      await call("test-notification", "434103");
      console.log("Native test toast submitted by the hidden installed app.");
    }
    await exec("rundll32.exe", ["url.dll,FileProtocolHandler", "novelpia-archive://title/434103"], { windowsHide: true });
  } else {
    await exec(exe, ["novelpia-archive://title/434103"], { windowsHide: true });
  }
  await until(() => evaluate("!document.querySelector('#detail').hidden && document.querySelector('#title').textContent === 'Книга из старого архива'"), "Existing instance did not navigate to the requested title", process.env.NOVELPIA_SMOKE_CLICK_TOAST === "1" ? 90000 : 10000);
  await call("remove", "434103");
  await evaluate("document.querySelector('#activity-nav').click()");
  assert.equal(await evaluate("document.querySelector('[data-type=watch_removed] .activity-title')?.textContent"), "Книга из старого архива");
  await fs.access(png);
  await stop();
  await start(profile, []);
  const reopened = await call("snapshot");
  assert.equal(reopened.theme, "dark");
  assert.equal(reopened.collectionLayout, "list");
  assert.equal(reopened.activity.length, 4);
  assert.ok(reopened.retired["434103"]);
  await stop();
  await checkInProgress(base);
  console.log("RUST WEBVIEW PASS: legacy migration, PNG preview, collection sort/filter, theme, recent activity, cold/warm title activation, restart");
}

main().catch(async (error) => {
  console.error(error);
  await stop();
  process.exitCode = 1;
});
