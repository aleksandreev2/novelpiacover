const path = require("node:path");
(async () => {
  const entry = require.resolve("electron-builder", {
    paths: [process.env.NOVELPIA_BUILD_DEPS || process.cwd(), __dirname],
  });
  const { build, Platform } = require(entry);
  const projectDir = path.resolve(__dirname, "..");
  const prepackaged =
    process.env.NOVELPIA_PREPACKAGED ||
    path.join(projectDir, "release/NovelpiaCoverArchive-win32-x64");
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
        oneClick: true,
        perMachine: false,
        allowElevation: false,
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
