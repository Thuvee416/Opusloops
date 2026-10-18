// Raster exports share the exact geometry of the canonical SVG mark.
// Run with sharp installed, or set OPUS_SHARP_MODULE to its module path.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const { default: sharp } = await import(process.env.OPUS_SHARP_MODULE || 'sharp');
const root = fileURLToPath(new URL('../', import.meta.url));
const assets = `${root}web-studio/assets/`;
const mark = await readFile(`${assets}opus-mark.svg`, 'utf8');
const background = '#faf7ef';
const tile = (fraction) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="${background}" d="M0 0h512v512H0z"/><svg x="${256 - 256 * fraction}" y="${256 - 256 * fraction * 388 / 524}" width="${512 * fraction}" height="${512 * fraction * 388 / 524}" viewBox="0 0 524 388">${mark.match(/<g[\s\S]*<\/g>/)[0]}</svg></svg>`;
for (const size of [16, 32]) await sharp(Buffer.from(tile(.78))).resize(size, size).png().toFile(`${assets}favicon-${size}-v3.png`);
for (const size of [192, 512]) await sharp(Buffer.from(tile(.72))).resize(size, size).png().toFile(`${assets}app-icon-${size}-v3.png`);
await sharp(Buffer.from(tile(.72))).resize(180, 180).png().toFile(`${assets}apple-touch-icon-v3.png`);
await sharp(Buffer.from(tile(.60))).resize(512, 512).png().toFile(`${assets}app-icon-maskable-v3.png`);
await writeFile(`${assets}favicon.svg`, tile(.78));
// ICO entries use PNG payloads, retaining alpha and sharp small-size rendering.
const sizes = [16, 32, 48];
const pngs = await Promise.all(sizes.map(size => sharp(Buffer.from(tile(.78))).resize(size, size).png().toBuffer()));
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((size, i) => {
  const p = 6 + 16 * i;
  header[p] = size; header[p + 1] = size;
  header.writeUInt16LE(1, p + 4); header.writeUInt16LE(32, p + 6);
  header.writeUInt32LE(pngs[i].length, p + 8); header.writeUInt32LE(offset, p + 12);
  offset += pngs[i].length;
});
await writeFile(`${root}web-studio/favicon.ico`, Buffer.concat([header, ...pngs]));
await mkdir(`${root}mobile/icons`, { recursive: true });
for (const size of [192, 512]) await writeFile(`${root}mobile/icons/icon-${size}.png`, await readFile(`${assets}app-icon-${size}-v3.png`));
await writeFile(`${root}mobile/icons/apple-touch-icon.png`, await readFile(`${assets}apple-touch-icon-v3.png`));
console.log('Built favicon, iOS, standard and maskable icons from opus-mark.svg');
