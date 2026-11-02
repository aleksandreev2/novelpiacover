const fs = require("node:fs/promises");
const path = require("node:path");
async function temporary(t) {
  const base = path.resolve(__dirname, "../../../work/test-data");
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, "case-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
function decoded(value = 1) {
  return {
    width: 1,
    height: 1,
    pixels: Buffer.from([value, 0, 0, 255]),
    png: Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex"),
  };
}
module.exports = { temporary, decoded };
