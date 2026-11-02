"use strict";
const sharp = require("sharp");
sharp.cache({ memory: 16, files: 0, items: 16 });
sharp.concurrency(1);
async function decodeImage(bytes) {
  try {
    const { data: pixels, info } = await sharp(bytes, {
      limitInputPixels: 40000000,
      failOn: "error",
      animated: false,
    })
      .rotate()
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    const png = await sharp(pixels, {
      raw: { width, height, channels },
      limitInputPixels: 40000000,
    })
      .png({ compressionLevel: 6, adaptiveFiltering: true })
      .toBuffer();
    return { width, height, pixels, png };
  } catch (e) {
    if (/pixel limit|exceeds.*limit/i.test(e.message))
      throw new Error("Изображение превышает 40 миллионов пикселей.");
    throw new Error(
      "Не удалось прочитать изображение. Ожидается PNG, JPEG, WebP или другой поддерживаемый формат. " +
        e.message,
    );
  }
}
function makeIcon() {
  const { nativeImage } = require("electron");
  const size = 32,
    pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const book = x >= 8 && x <= 24 && y >= 6 && y <= 26;
      const line =
        book &&
        (x === 11 ||
          (x >= 15 && x <= 21 && (y === 12 || y === 17 || y === 22)));
      pixels[i] = line ? 255 : book ? 240 : 214;
      pixels[i + 1] = line ? 255 : book ? 173 : 98;
      pixels[i + 2] = line ? 255 : book ? 85 : 40;
      pixels[i + 3] = 255;
    }
  return nativeImage.createFromBitmap(pixels, {
    width: size,
    height: size,
    scaleFactor: 1,
  });
}
module.exports = { decodeImage, makeIcon };
