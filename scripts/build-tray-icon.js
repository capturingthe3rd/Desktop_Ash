#!/usr/bin/env node
/**
 * Generates tray icon PNGs for Desktop Ash.
 * Renders a simple paw silhouette in pure black on transparent background.
 * Outputs:
 *   assets/tray-icon-Template.png     (16x16 — standard)
 *   assets/tray-icon-Template@2x.png  (32x32 — HiDPI)
 *
 * macOS auto-inverts Template-suffixed icons for dark/light mode.
 * Run: node scripts/build-tray-icon.js
 */

const fs = require("fs");
const path = require("path");

// Minimal PNG encoder — no dependencies required.
// Writes an RGBA PNG from a flat Uint8Array of [r,g,b,a, r,g,b,a, ...] pixels.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c;
  }
  return t;
})();

function crc32(data) {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32be(n) {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function chunk(type, data) {
  const typeBytes = [...type].map((c) => c.charCodeAt(0));
  const len = u32be(data.length);
  const crcInput = [...typeBytes, ...data];
  const crc = u32be(crc32(crcInput));
  return [...len, ...typeBytes, ...data, ...crc];
}

function deflateRaw(data) {
  // Minimal zlib: uncompressed deflate (type=0 blocks) — valid but not compressed.
  // PNG decoders accept this. Fine for tiny icons.
  const BLOCK = 65535;
  const out = [0x78, 0x01]; // zlib header: deflate, default compression
  let adler_s1 = 1;
  let adler_s2 = 0;
  for (const b of data) {
    adler_s1 = (adler_s1 + b) % 65521;
    adler_s2 = (adler_s2 + adler_s1) % 65521;
  }
  let offset = 0;
  while (offset < data.length) {
    const end = Math.min(offset + BLOCK, data.length);
    const isLast = end === data.length ? 1 : 0;
    const blockLen = end - offset;
    out.push(isLast); // BFINAL + BTYPE=00
    out.push(blockLen & 0xff, (blockLen >>> 8) & 0xff);
    out.push((~blockLen) & 0xff, ((~blockLen) >>> 8) & 0xff);
    for (let i = offset; i < end; i++) out.push(data[i]);
    offset = end;
  }
  out.push(
    (adler_s2 >>> 8) & 0xff,
    adler_s2 & 0xff,
    (adler_s1 >>> 8) & 0xff,
    adler_s1 & 0xff
  );
  return out;
}

function encodePNG(width, height, rgba) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];

  // IHDR
  const ihdr = [
    ...u32be(width),
    ...u32be(height),
    8,  // bit depth
    6,  // color type: RGBA
    0, 0, 0,
  ];

  // Raw scanlines with filter byte 0 (None) prepended to each row
  const scanlines = [];
  for (let y = 0; y < height; y++) {
    scanlines.push(0); // filter type None
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      scanlines.push(rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]);
    }
  }

  const idat = deflateRaw(scanlines);

  const bytes = [
    ...sig,
    ...chunk("IHDR", ihdr),
    ...chunk("IDAT", idat),
    ...chunk("IEND", []),
  ];

  return Buffer.from(bytes);
}

// Draw a paw silhouette onto an RGBA buffer.
// Design: 4 toe pads (circles) above 1 large heel pad (ellipse).
// Pure black on transparent — macOS Template icon convention.
function drawPaw(size) {
  const rgba = new Uint8Array(size * size * 4); // all transparent

  function setPixel(x, y, alpha) {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const i = (y * size + x) * 4;
    rgba[i] = 0;
    rgba[i + 1] = 0;
    rgba[i + 2] = 0;
    rgba[i + 3] = Math.max(rgba[i + 3], alpha);
  }

  // Anti-aliased circle fill
  function fillCircle(cx, cy, r) {
    const ix0 = Math.floor(cx - r - 1);
    const ix1 = Math.ceil(cx + r + 1);
    const iy0 = Math.floor(cy - r - 1);
    const iy1 = Math.ceil(cy + r + 1);
    for (let py = iy0; py <= iy1; py++) {
      for (let px = ix0; px <= ix1; px++) {
        const d = Math.hypot(px - cx, py - cy);
        if (d < r - 0.5) {
          setPixel(px, py, 255);
        } else if (d < r + 0.5) {
          const alpha = Math.round((r + 0.5 - d) * 255);
          setPixel(px, py, alpha);
        }
      }
    }
  }

  // Anti-aliased ellipse fill
  function fillEllipse(cx, cy, rx, ry) {
    const ix0 = Math.floor(cx - rx - 1);
    const ix1 = Math.ceil(cx + rx + 1);
    const iy0 = Math.floor(cy - ry - 1);
    const iy1 = Math.ceil(cy + ry + 1);
    for (let py = iy0; py <= iy1; py++) {
      for (let px = ix0; px <= ix1; px++) {
        const nx = (px - cx) / rx;
        const ny = (py - cy) / ry;
        const d = Math.hypot(nx, ny);
        if (d < 1 - 0.5 / Math.min(rx, ry)) {
          setPixel(px, py, 255);
        } else if (d < 1 + 0.5 / Math.min(rx, ry)) {
          const alpha = Math.round((1 + 0.5 / Math.min(rx, ry) - d) * 255 * Math.min(rx, ry));
          setPixel(px, py, Math.min(255, alpha));
        }
      }
    }
  }

  const s = size / 16; // scale factor (1 at 16px, 2 at 32px)

  // Heel pad: centered horizontally, lower third of icon
  const heelCx = size / 2;
  const heelCy = size * 0.68;
  const heelRx = size * 0.30;
  const heelRy = size * 0.24;
  fillEllipse(heelCx, heelCy, heelRx, heelRy);

  // 4 toe pads: arranged in an arc above the heel
  const toeY = size * 0.32;
  const toeR = size * 0.115;
  // Spread: outer toes angled slightly, inner toes closer together
  const toePositions = [
    { cx: size * 0.21, cy: toeY + size * 0.055 },
    { cx: size * 0.38, cy: toeY },
    { cx: size * 0.62, cy: toeY },
    { cx: size * 0.79, cy: toeY + size * 0.055 },
  ];
  for (const { cx, cy } of toePositions) {
    fillCircle(cx, cy, toeR);
  }

  return rgba;
}

const assetsDir = path.join(__dirname, "..", "assets");
fs.mkdirSync(assetsDir, { recursive: true });

// 16x16
const rgba16 = drawPaw(16);
const png16 = encodePNG(16, 16, rgba16);
fs.writeFileSync(path.join(assetsDir, "tray-icon-Template.png"), png16);
console.log("wrote assets/tray-icon-Template.png (16x16)");

// 32x32 @2x
const rgba32 = drawPaw(32);
const png32 = encodePNG(32, 32, rgba32);
fs.writeFileSync(path.join(assetsDir, "tray-icon-Template@2x.png"), png32);
console.log("wrote assets/tray-icon-Template@2x.png (32x32)");
