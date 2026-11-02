const { test } = require("node:test");
const assert = require("node:assert/strict");
const { decodeImage } = require("../src/images.cjs");
const webp = Buffer.from(
  "UklGRhwAAABXRUJQVlA4TA8AAAAvAYAAAAcQ/Y/+ByKi/wEA",
  "base64",
);
test("converts lossless WebP to actual PNG at original dimensions with canonical RGBA pixels", async () => {
  const decoded = await decodeImage(webp);
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 3);
  assert.equal(decoded.png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.deepEqual([...decoded.pixels.subarray(0, 4)], [255, 0, 0, 255]);
  const roundtrip = await decodeImage(decoded.png);
  assert.deepEqual(roundtrip.pixels, decoded.pixels);
});
test("rejects over-limit dimensions before allocating a decoded bitmap", async () => {
  const header = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
    "base64",
  );
  header.writeUInt32BE(10000, 16);
  header.writeUInt32BE(10000, 20);
  header.writeUInt32BE(require("node:zlib").crc32(header.subarray(12, 29)), 29);
  await assert.rejects(decodeImage(header), /40 миллионов пикселей/);
});
test("rejects HTML masquerading as image data", async () => {
  await assert.rejects(
    decodeImage(Buffer.from("<html>Access denied</html>")),
    /Не удалось прочитать/,
  );
});
test("creates a valid preview from archive paths longer than Windows MAX_PATH", async (t) => {
  const fs = require("node:fs/promises"),
    path = require("node:path"),
    { temporary } = require("./helpers.cjs");
  const directory = path.join(
    await temporary(t),
    "a".repeat(120),
    "b".repeat(100),
  );
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, "cover.png");
  assert.ok(file.length > 260);
  await fs.writeFile(
    file,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  const preview = await require("../src/images.cjs").createPreview(file);
  assert.equal(preview.subarray(0, 3).toString("hex"), "ffd8ff");
  const metadata = await require("sharp")(preview).metadata();
  assert.equal(metadata.width, 1);
  assert.equal(metadata.height, 1);
});
