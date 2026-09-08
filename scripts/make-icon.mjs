#!/usr/bin/env node
/**
 * make-icon.mjs — turn any PNG into the app's icons.
 *
 *   node scripts/make-icon.mjs <source.png> [--keep-background] [--pad <0..40>]
 *
 * Writes `public/icon.png` (256×256, used by the page and by Electron off
 * Windows) and `public/icon.ico` (16/32/48/64/128/256, used by the Windows
 * taskbar and title bar).
 *
 * What it does to the source, and why an app icon needs all of it:
 *   - trims the uniform border a logo export always comes with, so the mark
 *     fills the tile instead of floating in the middle of it;
 *   - makes that border colour transparent, so the icon does not show up as a
 *     white tile on a dark taskbar (`--keep-background` opts out);
 *   - squares it by padding the short side, never by cutting the mark;
 *   - resizes to every size Windows asks for, instead of shipping one bitmap
 *     and letting the shell resample it at 16×16.
 *
 * No image dependency: PNG is inflate + a per-scanline filter byte, and an ICO
 * entry is allowed to hold a PNG as is. Adding sharp/jimp to a project whose
 * whole point is "no bundler, no build step" was the worse trade.
 *
 * Reads 8-bit greyscale/RGB/RGBA and palette PNGs, non-interlaced — which is
 * every logo export in practice. Anything else fails with a message instead of
 * writing a wrong icon.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { deflateSync, inflateSync, crc32 } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Every size the Windows shell picks from: the taskbar takes 32 (48 at 150%
// scaling), alt-tab and the title bar 16, the "extra large icons" view 256.
const ICO_SIZES = [16, 32, 48, 64, 128, 256];
const PNG_SIZE = 256;
// How far from the border colour a pixel may be and still count as background.
// Generous enough for the JPEG-ish speckle around an exported logo, far too
// small to eat into the mark itself.
const BACKGROUND_TOLERANCE = 12;

// ---- PNG decoding ----------------------------------------------------------

/** @typedef {{ width: number, height: number, data: Buffer }} Bitmap RGBA8, row-major. */

function* chunks(buf) {
  let at = 8;
  while (at + 8 <= buf.length) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString("ascii", at + 4, at + 8);
    yield { type, data: buf.subarray(at + 8, at + 8 + length) };
    at += 12 + length;
  }
}

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Undo the per-scanline filter, in place, and drop the filter bytes. */
function unfilter(raw, width, height, bytesPerPixel) {
  const stride = width * bytesPerPixel;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const target = out.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bytesPerPixel ? target[x - bytesPerPixel] : 0;
      const b = prior ? prior[x] : 0;
      const c = prior && x >= bytesPerPixel ? prior[x - bytesPerPixel] : 0;
      const v = line[x];
      target[x] = 0xff & (
        filter === 0 ? v
        : filter === 1 ? v + a
        : filter === 2 ? v + b
        : filter === 3 ? v + ((a + b) >> 1)
        : filter === 4 ? v + paeth(a, b, c)
        : (() => { throw new Error(`unknown PNG filter ${filter}`); })()
      );
    }
  }
  return out;
}

/** @returns {Bitmap} */
function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("not a PNG file");
  let header = null;
  let palette = null;
  let alpha = null;
  const idat = [];
  for (const chunk of chunks(buf)) {
    if (chunk.type === "IHDR") {
      header = {
        width: chunk.data.readUInt32BE(0),
        height: chunk.data.readUInt32BE(4),
        depth: chunk.data[8],
        colorType: chunk.data[9],
        interlace: chunk.data[12],
      };
    } else if (chunk.type === "PLTE") palette = Buffer.from(chunk.data);
    else if (chunk.type === "tRNS") alpha = Buffer.from(chunk.data);
    else if (chunk.type === "IDAT") idat.push(chunk.data);
    else if (chunk.type === "IEND") break;
  }
  if (!header) throw new Error("PNG without an IHDR chunk");
  if (header.depth !== 8) throw new Error(`only 8-bit PNGs are supported, this one is ${header.depth}-bit`);
  if (header.interlace) throw new Error("interlaced PNGs are not supported");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header.colorType];
  if (!channels) throw new Error(`unsupported PNG colour type ${header.colorType}`);

  const { width, height } = header;
  const flat = unfilter(inflateSync(Buffer.concat(idat)), width, height, channels);
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0, o = 0; o < data.length; i += channels, o += 4) {
    if (header.colorType === 6) {
      data[o] = flat[i]; data[o + 1] = flat[i + 1]; data[o + 2] = flat[i + 2]; data[o + 3] = flat[i + 3];
    } else if (header.colorType === 2) {
      data[o] = flat[i]; data[o + 1] = flat[i + 1]; data[o + 2] = flat[i + 2]; data[o + 3] = 255;
    } else if (header.colorType === 0) {
      data[o] = data[o + 1] = data[o + 2] = flat[i]; data[o + 3] = 255;
    } else if (header.colorType === 4) {
      data[o] = data[o + 1] = data[o + 2] = flat[i]; data[o + 3] = flat[i + 1];
    } else {
      if (!palette) throw new Error("palette PNG without a PLTE chunk");
      const p = flat[i] * 3;
      data[o] = palette[p]; data[o + 1] = palette[p + 1]; data[o + 2] = palette[p + 2];
      data[o + 3] = alpha?.[flat[i]] ?? 255;
    }
  }
  return { width, height, data };
}

// ---- PNG encoding ----------------------------------------------------------

function chunk(type, body) {
  const out = Buffer.alloc(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "ascii");
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)) >>> 0, 8 + body.length);
  return out;
}

/** @param {Bitmap} img */
function encodePng({ width, height, data }) {
  const stride = width * 4;
  // Filter 0 on every row: the mark is flat colour, so deflate does the work
  // and picking filters per row would buy bytes nobody counts.
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- the pixel work --------------------------------------------------------

const pixel = (img, x, y) => {
  const o = (y * img.width + x) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
};
const near = (p, q) => Math.abs(p[0] - q[0]) <= BACKGROUND_TOLERANCE
  && Math.abs(p[1] - q[1]) <= BACKGROUND_TOLERANCE
  && Math.abs(p[2] - q[2]) <= BACKGROUND_TOLERANCE
  && Math.abs(p[3] - q[3]) <= BACKGROUND_TOLERANCE;

/**
 * The background colour, or null when the four corners disagree — which is what
 * a mark bleeding off the edge looks like, and there is nothing to trim there.
 */
function backgroundOf(img) {
  const corners = [
    pixel(img, 0, 0),
    pixel(img, img.width - 1, 0),
    pixel(img, 0, img.height - 1),
    pixel(img, img.width - 1, img.height - 1),
  ];
  if (corners[0][3] === 0) return corners[0]; // already transparent: nothing to do
  return corners.every((c) => near(c, corners[0])) ? corners[0] : null;
}

/** Box of everything that is not the background. @returns {Bitmap} */
function trim(img, background) {
  let top = 0, left = 0, right = img.width - 1, bottom = img.height - 1;
  const rowIsBackground = (y) => {
    for (let x = left; x <= right; x++) if (!near(pixel(img, x, y), background)) return false;
    return true;
  };
  const colIsBackground = (x) => {
    for (let y = top; y <= bottom; y++) if (!near(pixel(img, x, y), background)) return false;
    return true;
  };
  while (top < bottom && rowIsBackground(top)) top++;
  while (bottom > top && rowIsBackground(bottom)) bottom--;
  while (left < right && colIsBackground(left)) left++;
  while (right > left && colIsBackground(right)) right--;
  const width = right - left + 1;
  const height = bottom - top + 1;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    img.data.copy(data, y * width * 4, ((top + y) * img.width + left) * 4, ((top + y) * img.width + right + 1) * 4);
  }
  return { width, height, data };
}

/** Square canvas, mark centred, `pad` percent of breathing room around it. */
function square(img, pad) {
  const side = Math.round(Math.max(img.width, img.height) * (1 + pad / 100));
  const data = Buffer.alloc(side * side * 4); // zeroed = fully transparent
  const dx = Math.round((side - img.width) / 2);
  const dy = Math.round((side - img.height) / 2);
  for (let y = 0; y < img.height; y++) {
    img.data.copy(data, ((dy + y) * side + dx) * 4, y * img.width * 4, (y + 1) * img.width * 4);
  }
  return { width: side, height: side, data };
}

/** Every pixel within tolerance of `background` becomes fully transparent. */
function dropBackground(img, background) {
  for (let o = 0; o < img.data.length; o += 4) {
    const p = [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
    if (near(p, background)) img.data.writeUInt32LE(0, o);
  }
  return img;
}

/**
 * Box downscale, averaging in premultiplied alpha: without the premultiply the
 * transparent pixels drag their (white) colour into the edge of the mark and
 * every shape ends up with a pale halo.
 */
function resize(img, side) {
  const data = Buffer.alloc(side * side * 4);
  const scaleX = img.width / side;
  const scaleY = img.height / side;
  for (let y = 0; y < side; y++) {
    const y0 = Math.floor(y * scaleY), y1 = Math.max(y0 + 1, Math.floor((y + 1) * scaleY));
    for (let x = 0; x < side; x++) {
      const x0 = Math.floor(x * scaleX), x1 = Math.max(x0 + 1, Math.floor((x + 1) * scaleX));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < Math.min(y1, img.height); sy++) {
        for (let sx = x0; sx < Math.min(x1, img.width); sx++) {
          const o = (sy * img.width + sx) * 4;
          const alpha = img.data[o + 3] / 255;
          r += img.data[o] * alpha; g += img.data[o + 1] * alpha; b += img.data[o + 2] * alpha;
          a += img.data[o + 3];
          n++;
        }
      }
      const o = (y * side + x) * 4;
      const alpha = a / n / 255;
      data[o] = alpha ? Math.round(r / n / alpha) : 0;
      data[o + 1] = alpha ? Math.round(g / n / alpha) : 0;
      data[o + 2] = alpha ? Math.round(b / n / alpha) : 0;
      data[o + 3] = Math.round(a / n);
    }
  }
  return { width: side, height: side, data };
}

// ---- ICO -------------------------------------------------------------------

/** ICONDIR + one ICONDIRENTRY per size + the PNGs themselves. */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  const bodies = [];
  let offset = 6 + images.length * 16;
  for (const { side, png } of images) {
    const entry = Buffer.alloc(16);
    // A side of 256 is written as 0: the format spells it in a single byte.
    entry.writeUInt8(side >= 256 ? 0 : side, 0);
    entry.writeUInt8(side >= 256 ? 0 : side, 1);
    entry.writeUInt8(0, 2);     // palette: none, it is truecolor
    entry.writeUInt16LE(1, 4);  // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(entry);
    bodies.push(png);
  }
  return Buffer.concat([header, ...entries, ...bodies]);
}

// ---- the script itself -----------------------------------------------------

function parseArgs(argv) {
  const args = { source: null, keepBackground: false, pad: 6 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--keep-background") args.keepBackground = true;
    else if (argv[i] === "--pad") args.pad = Number(argv[++i]);
    else if (!args.source) args.source = argv[i];
  }
  if (!Number.isFinite(args.pad) || args.pad < 0 || args.pad > 40) throw new Error("--pad must be between 0 and 40");
  return args;
}

const hex = (c) => "#" + [c[0], c[1], c[2]].map((v) => v.toString(16).padStart(2, "0")).join("");

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(String(err.message ?? err));
    process.exit(2);
  }
  if (!args.source) {
    console.error("usage: node scripts/make-icon.mjs <source.png> [--keep-background] [--pad <0..40>]");
    process.exit(2);
  }

  let img = decodePng(await readFile(args.source));
  console.log(`source: ${img.width}×${img.height}`);
  const background = backgroundOf(img);
  if (background) {
    const before = `${img.width}×${img.height}`;
    img = trim(img, background);
    if (`${img.width}×${img.height}` !== before) console.log(`trimmed: ${img.width}×${img.height} (border ${hex(background)})`);
    if (!args.keepBackground && background[3] !== 0) {
      img = dropBackground(img, background);
      console.log(`background ${hex(background)} → transparent (--keep-background to keep it)`);
    }
  } else {
    console.log("no uniform border: nothing trimmed");
  }
  if (img.width !== img.height || args.pad > 0) {
    img = square(img, args.pad);
    console.log(`squared: ${img.width}×${img.height} (${args.pad}% padding)`);
  }

  await mkdir(PUBLIC_DIR, { recursive: true });
  await writeFile(path.join(PUBLIC_DIR, "icon.png"), encodePng(resize(img, PNG_SIZE)));
  await writeFile(path.join(PUBLIC_DIR, "icon.ico"), ico(
    ICO_SIZES.map((side) => ({ side, png: encodePng(resize(img, side)) })),
  ));
  console.log(`wrote public/icon.png (${PNG_SIZE}px) and public/icon.ico (${ICO_SIZES.join(", ")})`);
}

await main();
