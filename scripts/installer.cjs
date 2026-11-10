const path = require("node:path");
const fs = require("node:fs/promises");
(async () => {
  const entry = require.resolve("electron-builder", {
    paths: [process.env.NOVELPIA_BUILD_DEPS || process.cwd(), __dirname],
  });
  const { build, Platform } = require(entry);
  const projectDir = path.resolve(__dirname, "..");
  const prepackaged = path.join(projectDir, "release/rust-windows-x64");
  const exe = path.join(projectDir, "src-tauri/target/release/NovelpiaCoverArchive.exe");
  const bootstrap = path.join(projectDir, "assets/WebView2Setup.exe");
  await fs.access(bootstrap);
  process.env.NOVELPIA_WEBVIEW_BOOTSTRAP = bootstrap;
  await fs.mkdir(prepackaged, { recursive: true });
  await fs.copyFile(exe, path.join(prepackaged, "NovelpiaCoverArchive.exe"));
  const results = await build({
    projectDir,
    prepackaged,
    targets: Platform.WINDOWS.createTarget("nsis", "x64"),
    publish: "never",
    config: {
      appId: "com.novelpia.coverarchive",
      productName: "Novelpia Cover Archive",
      executableName: "NovelpiaCoverArchive",
      electronVersion: "45.2.1",
      artifactName: "NovelpiaCoverArchive-Setup-${version}.${ext}",
      directories: {
        output:
          process.env.NOVELPIA_INSTALLER_OUT ||
          path.join(projectDir, "release/installer"),
        buildResources: path.join(projectDir, "assets"),
      },
      win: {
        icon: path.join(projectDir, "assets/icon.ico"),
        signAndEditExecutable: false,
      },
      nsis: {
        include: path.join(projectDir, "scripts/installer.nsh"),
        oneClick: true,
        perMachine: false,
        allowElevation: false,
        packElevateHelper: false,
        createDesktopShortcut: "always",
        createStartMenuShortcut: true,
        shortcutName: "Novelpia — Архив обложек",
        runAfterFinish: true,
        deleteAppDataOnUninstall: false,
        installerLanguages: ["ru_RU"],
        language: "1049",
        displayLanguageSelector: false,
      },
    },
  });
  console.log(results.join("\n"));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
