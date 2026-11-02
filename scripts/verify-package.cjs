const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
async function verifyPackage(directory) {
  const { listPackage, extractFile } = await import("@electron/asar");
  const archive = path.join(directory, "resources/app.asar"),
    files = listPackage(archive).map((p) => p.replaceAll("\\", "/"));
  assert.ok(
    !files.some((p) => /^\/(?:\.test-data|tests|\.git)(?:\/|$)/.test(p)),
    "Packaged application contains test/profile/repository data",
  );
  for (const required of [
    "/src/main.cjs",
    "/src/status.cjs",
    "/src/status-parser.cjs",
    "/ui/app.js",
  ])
    assert.ok(files.includes(required), "Missing " + required);
  assert.equal(
    JSON.parse(extractFile(archive, "package.json")).version,
    require("../package.json").version,
  );
  const native = files.filter(
    (p) => p.includes("/@img/") && /\.(node|dll)$/.test(p),
  );
  assert.ok(native.some((p) => p.endsWith(".node")));
  assert.ok(native.some((p) => p.endsWith(".dll")));
  for (const file of native)
    await fs.access(path.join(archive + ".unpacked", file.slice(1)));
  console.log(
    "PACKAGE PASS: version, required files, native libraries, no test/profile data",
  );
}
if (require.main === module)
  verifyPackage(
    path.resolve(
      process.argv[2] ||
        path.join(__dirname, "../release/NovelpiaCoverArchive-win32-x64"),
    ),
  ).catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
module.exports = { verifyPackage };
