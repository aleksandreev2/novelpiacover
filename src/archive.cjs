"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { atomicWrite } = require("./store.cjs");
const { safeFolder } = require("./novelpia.cjs");
const exists = async (file) => {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
};
class Archive {
  async directory(novel, root) {
    const base = path.resolve(root),
      folder = novel.folder || safeFolder(novel.title, novel.id),
      directory = path.resolve(base, folder);
    if (path.dirname(directory) !== base)
      throw new Error("Недопустимое имя папки архива.");
    await fs.mkdir(directory, { recursive: true });
    const realBase = await fs.realpath(base),
      realDir = await fs.realpath(directory);
    if (path.dirname(realDir).toLowerCase() !== realBase.toLowerCase())
      throw new Error("Папка архива ссылается за пределы выбранной папки.");
    return directory;
  }
  async recover(novel, root) {
    const directory = await this.directory(novel, root);
    let entries = [];
    try {
      const m = JSON.parse(
        await fs.readFile(path.join(directory, "archive.json"), "utf8"),
      );
      if (m.novelId === novel.id && Array.isArray(m.entries))
        entries = m.entries.filter(
          (e) =>
            typeof e.file === "string" &&
            path.dirname(path.resolve(e.file)) === directory &&
            /^[a-f\d]{64}$/.test(e.hash),
        );
    } catch (e) {
      if (!["ENOENT", "EISDIR"].includes(e.code) && !(e instanceof SyntaxError))
        throw e;
    }
    // Reconstruct an orphan saved before its manifest/settings could be committed.
    for (const file of await fs.readdir(directory)) {
      const match = /^(\d{4}-\d\d-\d\dT[\d-]+Z)_([a-f\d]{64})\.png$/.exec(file);
      if (!match || entries.some((e) => e.hash === match[2])) continue;
      const full = path.join(directory, file);
      const fh = await fs.open(full, "r");
      const head = Buffer.alloc(24);
      try {
        await fh.read(head, 0, 24, 0);
      } finally {
        await fh.close();
      }
      if (head.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") continue;
      const stat = await fs.stat(full);
      entries.push({
        hash: match[2],
        file: full,
        savedAt: new Date(stat.mtimeMs).toISOString(),
        width: head.readUInt32BE(16),
        height: head.readUInt32BE(20),
        bytes: stat.size,
        kind: "recovered",
        source: "",
      });
    }
    return entries;
  }
  async save(novel, source, decoded, root) {
    const { width, height, pixels, png } = decoded;
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width * height > 40000000 ||
      !pixels?.length ||
      !png?.length
    )
      throw new Error("Неверный или слишком большой размер изображения.");
    const hash = createHash("sha256")
      .update(`${width}x${height}:`)
      .update(pixels)
      .digest("hex");
    const known = novel.history.find((e) => e.hash === hash && e.file);
    if (known && (await exists(known.file)))
      return { saved: false, entry: known };
    const directory = await this.directory(novel, root);
    const entries = await this.recover(novel, root);
    const old = entries.find((e) => e.hash === hash),
      savedAt = old?.savedAt || new Date().toISOString();
    const file =
      old?.file ||
      path.join(directory, `${savedAt.replace(/[:.]/g, "-")}_${hash}.png`);
    const present = await exists(file);
    if (!present) await atomicWrite(file, png);
    const entry = {
      hash,
      file,
      savedAt,
      width,
      height,
      bytes: png.length,
      kind: source.kind,
      source: source.url,
    };
    const merged = [...entries.filter((e) => e.hash !== hash), entry];
    await atomicWrite(
      path.join(directory, "archive.json"),
      JSON.stringify(
        { version: 1, novelId: novel.id, title: novel.title, entries: merged },
        null,
        2,
      ),
    );
    return { saved: !present, entry };
  }
}
module.exports = { Archive };
