const { app } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "../.test-data/live-status");
require("node:fs").mkdirSync(root, { recursive: true });
const base = require("node:fs").mkdtempSync(path.join(root, "run-"));
require("node:fs").mkdirSync(path.join(base, "profile"));
app.setPath("userData", path.join(base, "profile"));
const { startApplication } = require("../src/main.cjs");
(async () => {
  const { window, monitor, shutdown } = await startApplication({
    show: false,
    autoStart: false,
  });
  await monitor.update({
    root: path.join(base, "archive"),
    paused: true,
    notifications: false,
    statusNotifications: {
      enabled: false,
      targets: ["completed", "discontinued", "delayed", "ongoing"],
      sound: false,
    },
  });
  for (const [id, expected] of [
    ["363368", "ongoing"],
    ["418139", "ongoing"],
    ["439936", "ongoing"],
    ["391344", "delayed"],
    ["434103", "ongoing"],
    ["211530", "completed"],
    ["330733", "discontinued"],
  ]) {
    await monitor.add("https://novelpia.com/novel/" + id);
    const novel = monitor.snapshot().novels.find((n) => n.id === id);
    assert.equal(novel.status, expected, novel.error);
    assert.equal(novel.error, "");
    console.log(
      JSON.stringify({
        id,
        status: novel.status,
        title: novel.title,
        covers: novel.history.length,
      }),
    );
  }
  const before = monitor.snapshot().novels.find((n) => n.id === "434103")
    .history.length;
  await monitor.check("434103");
  assert.equal(
    monitor.snapshot().novels.find((n) => n.id === "434103").history.length,
    before,
  );
  window.show();
  window.webContents.send("archive:select", "391344");
  await new Promise((r) => setTimeout(r, 500));
  const broken = await window.webContents.executeJavaScript(
    "Promise.all([...document.images].filter(i=>i.src&&i.getBoundingClientRect().top<innerHeight).map(async i=>{try{await i.decode();return null;}catch{return i.src;}})).then(items=>items.filter(Boolean))",
  );
  assert.deepEqual(broken, [], "Visible cover previews must decode");
  await window.webContents.executeJavaScript(
    "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))",
  );
  await fs.writeFile(
    path.join(base, "overview.png"),
    (await window.webContents.capturePage()).toPNG(),
  );
  await window.webContents.executeJavaScript(
    'document.getElementById("settings").click();document.getElementById("status-enabled").checked=true;',
  );
  await window.webContents.executeJavaScript(
    "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))",
  );
  await fs.writeFile(
    path.join(base, "settings.png"),
    (await window.webContents.capturePage()).toPNG(),
  );
  console.log(
    "LIVE STATUS PASS: all 4 lifecycle states, 4 user-reported titles, real cover previews, no duplicate saves. Screenshots: " +
      base,
  );
  await shutdown();
  app.exit(0);
})().catch((e) => {
  console.error(e.stack);
  app.exit(1);
});
