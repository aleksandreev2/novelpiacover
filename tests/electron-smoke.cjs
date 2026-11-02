const { app, nativeImage, net } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { startApplication } = require("../src/main.cjs");
const base = path.resolve(__dirname, "../../../work/electron-smoke");
app.setPath("userData", path.join(base, "profile"));
(async () => {
  await app.whenReady();
  const { window, monitor, tray, shutdown } = await startApplication({
    show: false,
    autoStart: false,
  });
  assert.equal(
    window.webContents.getLastWebPreferences().contextIsolation,
    true,
  );
  assert.equal(
    window.webContents.getLastWebPreferences().nodeIntegration,
    false,
  );
  assert.equal(window.webContents.getLastWebPreferences().sandbox, true);
  const ui = await window.webContents.executeJavaScript(
    "({title:document.title,api:typeof window.archiveAPI, node:typeof window.require})",
  );
  assert.equal(ui.api, "object");
  assert.equal(ui.node, "undefined");
  assert.ok(ui.title.includes("Novelpia"));
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
    "base64",
  );
  assert.equal(nativeImage.createFromBuffer(png).isEmpty(), false);
  assert.ok(tray);
  window.show();
  window.close();
  assert.equal(window.isDestroyed(), false);
  assert.equal(window.isVisible(), false);
  window.show();
  assert.equal(window.isVisible(), true);
  await monitor.update({ root: path.join(base, "archive"), paused: true });
  const { decodeImage } = require("../src/images.cjs");
  assert.equal((await decodeImage(png)).width, 1);
  const webp = Buffer.from(
    "UklGRhwAAABXRUJQVlA4TA8AAAAvAYAAAAcQ/Y/+ByKi/wEA",
    "base64",
  );
  assert.equal((await decodeImage(webp)).width, 2);
  if (process.env.NOVELPIA_LIVE_TEST === "1") {
    const url = "https://novelpia.com/novel/434103";
    if (!monitor.snapshot().novels.length) await monitor.add(url);
    else await monitor.check("434103");
    let n = monitor.snapshot().novels[0];
    assert.ok(!n.error, n.error);
    assert.ok(n.history.length >= 1);
    const count = n.history.length;
    await monitor.check("434103");
    n = monitor.snapshot().novels[0];
    assert.equal(n.history.length, count);
    for (const entry of n.history) {
      const bytes = await fs.readFile(entry.file);
      assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.equal(
        nativeImage.createFromBuffer(bytes).getSize().width,
        entry.width,
      );
    }
    console.log(
      JSON.stringify({
        live: true,
        title: n.title,
        count: n.history.length,
        images: n.history.map((e) => ({
          kind: e.kind,
          width: e.width,
          height: e.height,
          bytes: e.bytes,
        })),
      }),
    );
    const rendered = await window.webContents.executeJavaScript(
      'new Promise(r=>setTimeout(()=>r({cards:document.querySelectorAll(".history-item").length,body:document.body.innerText.slice(0,500)}),300))',
    );
    assert.ok(rendered.cards >= 1, JSON.stringify(rendered));
  }
  await window.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');
  await fs.mkdir(base, { recursive: true });
  await fs.writeFile(
    path.join(base, "preview.png"),
    (await window.webContents.capturePage()).toPNG(),
  );
  console.log(
    "Electron smoke PASS: sandbox, IPC, window, tray, PNG conversion, renderer",
  );
  await shutdown();
  app.exit(0);
})().catch((e) => {
  console.error(e.stack);
  app.exit(1);
});
