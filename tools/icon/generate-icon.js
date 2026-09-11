const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const pngToIco = require('png-to-ico').default;

const SOURCE = path.join(__dirname, '..', '..', 'assets', 'logo-source.png');
const OUT_DIR = path.join(__dirname, '..', '..', 'assets');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

async function removeWhiteBackground(inputPath) {
  const image = sharp(inputPath).ensureAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const whiteness = Math.min(r, g, b);
    const newAlpha = 255 - whiteness;
    data[i + 3] = Math.min(data[i + 3], newAlpha);
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).png();
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const transparent = await removeWhiteBackground(SOURCE);
  const meta = await transparent.metadata();
  const side = Math.max(meta.width, meta.height);

  const squareBuffer = await transparent
    .resize(side, side, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  await sharp(squareBuffer).png().toFile(path.join(OUT_DIR, 'icon-source.png'));

  const sizedBuffers = await Promise.all(
    SIZES.map((size) =>
      sharp(squareBuffer)
        .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer()
    )
  );

  const icoBuffer = await pngToIco(sizedBuffers);
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), icoBuffer);

  await sharp(squareBuffer)
    .resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(path.join(OUT_DIR, 'icon-256.png'));

  console.log('Готово: assets/icon.ico, assets/icon-source.png, assets/icon-256.png');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
