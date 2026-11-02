const { app, Notification } = require("electron");
const nativeNotifications = [],
  nativeFailures = [];
let nativeShows = 0;
const actualShow = Notification.prototype.show;
Notification.prototype.show = function () {
  nativeNotifications.push(this);
  this.on("show", () => nativeShows++);
  this.on("failed", (_event, error) => nativeFailures.push(error));
  return actualShow.call(this);
};
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const testRoot = path.resolve(__dirname, "../.test-data/status-electron");
require("node:fs").mkdirSync(testRoot, { recursive: true });
const base = require("node:fs").mkdtempSync(path.join(testRoot, "run-"));
require("node:fs").mkdirSync(path.join(base, "profile"));
app.setPath("userData", path.join(base, "profile"));
const { startApplication } = require("../src/main.cjs");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const { window, monitor, shutdown } = await startApplication({
    show: false,
    autoStart: false,
  });
  const ui = (expression) => window.webContents.executeJavaScript(expression);
  await monitor.update({
    root: path.join(base, "archive"),
    paused: true,
    notifications: false,
    statusNotifications: {
      enabled: true,
      targets: ["completed", "discontinued", "ongoing"],
      sound: false,
    },
  });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
    "base64",
  );
  let status = "ongoing";
  monitor.fetchResource = async (u, options) =>
    options.kind === "image"
      ? png
      : Buffer.from(
          `<div class="epnew-novel-title">Status integration test</div><div class="epnew-writer"><p class="in-writer">Author</p><p class="in-badge"><span>PLUS</span>${status === "completed" ? '<span class="b_comp">완결</span>' : ""}</p></div><a href="//images.novelpia.com/imagebox/cover/test.file"><img class="cover_img" src="//images.novelpia.com/imagebox/cover/test.file"></a>`,
        );
  if (monitor.snapshot().novels.some((n) => n.id === "1"))
    await monitor.remove("1");
  await monitor.add("https://novelpia.com/novel/1");
  await delay(100);
  assert.equal(
    await ui('document.getElementById("title-status").textContent'),
    "Продолжается",
  );
  await ui('document.getElementById("novel-notifications").click()');
  assert.equal(
    await ui('document.getElementById("novel-notifications-dialog").open'),
    true,
  );
  await ui(
    'document.getElementById("policy-inherit").click(); document.getElementById("policy-discontinued").checked=false; document.getElementById("novel-notifications-form").requestSubmit()',
  );
  await delay(150);
  assert.deepEqual(
    monitor.snapshot().novels.find((n) => n.id === "1").statusNotifications,
    { enabled: true, targets: ["completed", "ongoing"] },
  );
  status = "completed";
  await monitor.check("1");
  await delay(100);
  assert.equal(
    await ui('document.getElementById("title-status").textContent'),
    "Завершён",
  );
  assert.ok(
    (
      await ui('document.getElementById("status-history").textContent')
    ).includes("Продолжается → Завершён"),
  );
  await ui('document.getElementById("settings").click()');
  assert.equal(
    await ui('document.getElementById("status-enabled").checked'),
    true,
  );
  await ui(
    'document.getElementById("status-sound").checked=true; document.getElementById("settings-form").requestSubmit()',
  );
  await delay(150);
  assert.equal(monitor.snapshot().statusNotifications.sound, true);
  assert.equal(
    (await ui('window.archiveAPI.call("test-notification")')).requested,
    true,
  );
  const notification = nativeNotifications.find(
    (n) => n.title === "Тайтл завершён",
  );
  assert.ok(notification, "Native transition notification must exist");
  notification.emit("click");
  await delay(50);
  assert.equal(
    await ui('document.getElementById("title").textContent'),
    "Status integration test",
  );
  await delay(1500);
  console.log(JSON.stringify({ nativeShows, nativeFailures }));
  console.log(
    "STATUS ELECTRON PASS: native notification request, status UI, per-title and global settings, history, click selection",
  );
  await shutdown();
  app.exit(0);
})().catch((e) => {
  console.error(e.stack);
  app.exit(1);
});
