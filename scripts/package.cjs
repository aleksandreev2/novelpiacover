const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { version } = require("../package.json");
(async () => {
  const entry = require.resolve("@electron/packager", {
    paths: [process.env.NOVELPIA_BUILD_DEPS || process.cwd(), __dirname],
  });
  const { packager } = await import(pathToFileURL(entry).href);
  const results = await packager({
    dir: path.resolve(__dirname, ".."),
    out:
      process.env.NOVELPIA_BUILD_OUT || path.resolve(__dirname, "../release"),
    platform: "win32",
    arch: "x64",
    electronVersion: "45.2.1",
    name: "NovelpiaCoverArchive",
    icon: path.resolve(__dirname, "../assets/icon.ico"),
    appVersion: version,
    buildVersion: version,
    overwrite: true,
    prune: true,
    asar: { unpack: "**/*.{node,dll}" },
    ignore: [
      /^\/tests($|\/)/,
      /^\/docs($|\/)/,
      /^\/scripts($|\/)/,
      /^\/release($|\/)/,
      /^\/\.git/,
      /^\/\.test-data($|\/)/,
    ],
    win32metadata: {
      CompanyName: "Novelpia Cover Archive",
      FileDescription: "Novelpia Cover Archive",
      ProductName: "Novelpia Cover Archive",
      InternalName: "NovelpiaCoverArchive",
    },
  });
  for (const directory of results)
    await require("./verify-package.cjs").verifyPackage(directory);
  console.log(results.join("\n"));
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
