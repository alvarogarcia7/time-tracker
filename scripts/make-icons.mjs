#!/usr/bin/env node
// Writes the app icons as PNG files (no image library): a clock on the accent colour.
//   node scripts/make-icons.mjs            -> viewer/web/icons/*.png
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "viewer", "web", "icons");
const BACKGROUND = [0x4f, 0x8c, 0xf0];
const FACE = [0xff, 0xff, 0xff];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function png(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    rows[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Whether a point (in icon units, 0..1) is part of the clock: a ring, two hands and a centre dot.
// scale shrinks the drawing into the safe zone of a maskable icon.
function insideClock(x, y, scale) {
  const cx = 0.5;
  const cy = 0.5;
  const dx = (x - cx) / scale;
  const dy = (y - cy) / scale;
  const r = Math.hypot(dx, dy);
  if (r > 0.3 && r < 0.36) return true; // ring
  if (r <= 0.05) return true; // centre
  const inBar = (ex, ey, width) => {
    // segment from the centre to (ex, ey)
    const len = Math.hypot(ex, ey);
    const t = Math.max(0, Math.min(1, (dx * ex + dy * ey) / (len * len)));
    return Math.hypot(dx - ex * t, dy - ey * t) <= width;
  };
  if (inBar(0, -0.22, 0.035)) return true; // hour hand, to twelve
  if (inBar(0.17, 0, 0.035)) return true; // minute hand, to three
  return false;
}

function render(size, { scale = 1 } = {}) {
  const pixels = Buffer.alloc(size * size * 4);
  const samples = 4;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let hits = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = (x + (sx + 0.5) / samples) / size;
          const py = (y + (sy + 0.5) / samples) / size;
          if (insideClock(px, py, scale)) hits += 1;
        }
      }
      const coverage = hits / (samples * samples);
      const offset = (y * size + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[offset + channel] = Math.round(BACKGROUND[channel] * (1 - coverage) + FACE[channel] * coverage);
      }
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

mkdirSync(OUT, { recursive: true });
const icons = [
  ["icon-192.png", 192, {}],
  ["icon-512.png", 512, {}],
  ["maskable-512.png", 512, { scale: 0.8 }],
  ["apple-touch-icon.png", 180, {}],
];
for (const [name, size, options] of icons) {
  writeFileSync(join(OUT, name), png(size, render(size, options)));
  console.log(`wrote viewer/web/icons/${name} (${size}x${size})`);
}
