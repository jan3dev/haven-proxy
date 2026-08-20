// Minimal SVG-shape rasterizer + PNG/ICO writers, with no dependencies.
//
// Why hand-rolled: the only artwork this repo rasterizes is build/haven-*.svg,
// whose paths are straight lines and nothing else (no curves, no strokes, no
// gradients). That subset is ~100 lines of scanline fill, which is cheaper than
// pulling sharp/resvg — native binaries — into a build that otherwise needs
// nothing but Node. If the artwork ever gains a curve, `parsePath` throws
// instead of silently drawing the wrong shape.
import { deflateSync } from "node:zlib";

const SUBSAMPLES = 4; // 4x4 samples per pixel; enough AA down to 16px

// --- SVG parsing -----------------------------------------------------------

// Numbers in path data may run together without separators ("l-.03-56.57"),
// so split on the sign/decimal rules rather than on whitespace.
const NUMBER = /[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g;

/** Path data -> contours (arrays of [x, y]), for the M/L/H/V/Z subset. */
export function parsePath(d) {
  const contours = [];
  let current = null;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;

  for (const [, cmd, rawArgs] of d.matchAll(/([MmLlHhVvZz])([^MmLlHhVvZzAaCcQqSsTt]*)/g)) {
    const args = (rawArgs.match(NUMBER) ?? []).map(Number);
    const rel = cmd === cmd.toLowerCase();
    const upper = cmd.toUpperCase();

    if (upper === "Z") {
      current = null;
      x = startX;
      y = startY;
      continue;
    }

    const step = upper === "H" || upper === "V" ? 1 : 2;
    for (let i = 0; i + step <= args.length; i += step) {
      if (upper === "H") x = rel ? x + args[i] : args[i];
      else if (upper === "V") y = rel ? y + args[i] : args[i];
      else {
        x = rel ? x + args[i] : args[i];
        y = rel ? y + args[i + 1] : args[i + 1];
      }
      // Only the first pair of an M starts a contour; the rest are implicit
      // lineto, per the SVG spec.
      if (upper === "M" && i === 0) {
        current = [];
        contours.push(current);
        startX = x;
        startY = y;
      }
      current?.push([x, y]);
    }
  }

  const unsupported = d.match(/[AaCcQqSsTt]/);
  if (unsupported) throw new Error(`svg-raster: unsupported path command "${unsupported[0]}" in ${d.slice(0, 40)}...`);
  return contours.filter((c) => c.length > 2);
}

/** Reads the shapes and viewBox out of a flat single-layer SVG. */
export function parseSvg(source) {
  const viewBox = source.match(/viewBox="([^"]+)"/)?.[1];
  if (!viewBox) throw new Error("svg-raster: no viewBox");
  const [vx, vy, vw, vh] = viewBox.split(/[\s,]+/).map(Number);

  const contours = [];
  for (const [, d] of source.matchAll(/<path[^>]*\sd="([^"]+)"/g)) contours.push(...parsePath(d));
  for (const [, points] of source.matchAll(/<polygon[^>]*\spoints="([^"]+)"/g)) {
    const n = (points.match(NUMBER) ?? []).map(Number);
    const contour = [];
    for (let i = 0; i + 1 < n.length; i += 2) contour.push([n[i], n[i + 1]]);
    if (contour.length > 2) contours.push(contour);
  }
  if (contours.length === 0) throw new Error("svg-raster: no fillable shapes");
  return { x: vx, y: vy, width: vw, height: vh, contours };
}

// --- rasterizing -----------------------------------------------------------

/** Rounded rectangle as a contour; corners approximated by line segments. */
export function roundedRect(x, y, w, h, radius, segments = 16) {
  const r = Math.min(radius, w / 2, h / 2);
  const corners = [
    [x + w - r, y + h - r, 0],
    [x + r, y + h - r, Math.PI / 2],
    [x + r, y + r, Math.PI],
    [x + w - r, y + r, (3 * Math.PI) / 2],
  ];
  const contour = [];
  for (const [cx, cy, from] of corners) {
    for (let i = 0; i <= segments; i++) {
      const a = from + (i / segments) * (Math.PI / 2);
      contour.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  }
  return contour;
}

/**
 * Per-pixel coverage (0..1) of `contours` in a width x height buffer, using the
 * nonzero fill rule — SVG's default, and what makes the logomark's inner
 * contour cut a hole instead of filling it.
 *
 * Analytic in x (exact span overlap per pixel), supersampled in y.
 */
export function coverage(contours, width, height) {
  const edges = [];
  for (const contour of contours) {
    for (let i = 0; i < contour.length; i++) {
      const [x0, y0] = contour[i];
      const [x1, y1] = contour[(i + 1) % contour.length];
      if (y0 !== y1) edges.push({ x0, y0, x1, y1, dir: y1 > y0 ? 1 : -1 });
    }
  }

  const cov = new Float32Array(width * height);
  const crossings = [];
  for (let sy = 0; sy < height * SUBSAMPLES; sy++) {
    const y = (sy + 0.5) / SUBSAMPLES;
    crossings.length = 0;
    for (const e of edges) {
      const top = Math.min(e.y0, e.y1);
      const bottom = Math.max(e.y0, e.y1);
      if (y < top || y >= bottom) continue;
      crossings.push({ x: e.x0 + ((y - e.y0) / (e.y1 - e.y0)) * (e.x1 - e.x0), dir: e.dir });
    }
    if (crossings.length === 0) continue;
    crossings.sort((a, b) => a.x - b.x);

    const row = (sy / SUBSAMPLES) | 0;
    let winding = 0;
    for (let i = 0; i < crossings.length - 1; i++) {
      winding += crossings[i].dir;
      if (winding === 0) continue;
      const a = Math.max(0, crossings[i].x);
      const b = Math.min(width, crossings[i + 1].x);
      for (let col = Math.floor(a); col < b; col++) {
        cov[row * width + col] += (Math.min(b, col + 1) - Math.max(a, col)) / SUBSAMPLES;
      }
    }
  }
  return cov;
}

/** Source-over composite of a flat colour masked by `cov` onto an RGBA buffer. */
export function compose(rgba, cov, [r, g, b], alpha = 1) {
  for (let i = 0; i < cov.length; i++) {
    const a = Math.min(1, cov[i]) * alpha;
    if (a <= 0) continue;
    const p = i * 4;
    const dst = rgba[p + 3] / 255;
    const out = a + dst * (1 - a);
    for (let c = 0; c < 3; c++) {
      rgba[p + c] = Math.round(([r, g, b][c] * a + rgba[p + c] * dst * (1 - a)) / out);
    }
    rgba[p + 3] = Math.round(out * 255);
  }
  return rgba;
}

/** Fits contours into `size` x `size`, scaled to `scale` of the box and centred. */
export function fitted(svg, size, scale) {
  const factor = (size * scale) / Math.max(svg.width, svg.height);
  const dx = (size - svg.width * factor) / 2 - svg.x * factor;
  const dy = (size - svg.height * factor) / 2 - svg.y * factor;
  return svg.contours.map((c) => c.map(([x, y]) => [x * factor + dx, y * factor + dy]));
}

// --- encoding --------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

export function encodePng(width, height, rgba) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 32-bit BGRA DIB, bottom-up, with the (unused but mandatory) AND mask. */
function encodeDib(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // doubled: colour rows + mask rows
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      const dst = ((size - 1 - y) * size + x) * 4;
      pixels[dst] = rgba[src + 2];
      pixels[dst + 1] = rgba[src + 1];
      pixels[dst + 2] = rgba[src];
      pixels[dst + 3] = rgba[src + 3];
    }
  }
  return Buffer.concat([header, pixels, Buffer.alloc(size * ((size + 31) >> 5) * 4)]);
}

/**
 * ICO from {size, rgba} images. Entries up to 64px are classic DIBs and larger
 * ones are PNG-compressed: NSIS and older Windows shell paths still read the
 * small sizes as DIB, while a 256px DIB would add ~256KB for nothing.
 */
export function encodeIco(images) {
  const bodies = images.map(({ size, rgba }) => (size >= 128 ? encodePng(size, size, rgba) : encodeDib(size, rgba)));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = images.map(({ size }, i) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // 0 means 256
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(bodies[i].length, 8);
    e.writeUInt32LE(offset, 12);
    offset += bodies[i].length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...bodies]);
}
