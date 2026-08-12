/**
 * Generates the PWA icons.
 *
 * Written as a dependency-free PNG encoder rather than pulling in an image library:
 * the icons change roughly never, and a native image dependency is a disproportionate
 * thing to carry (and to keep building in CI) for three small files.
 *
 *   node scripts/generate-icons.mjs
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')

/* ----------------------------------------------------------------- PNG ---- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

function encodePng(width, height, rgba) {
  const stride = width * 4
  // Each scanline is prefixed with a filter-type byte; 0 means "no filtering",
  // which costs a little size but keeps this encoder trivial.
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ------------------------------------------------------------- drawing ---- */

/** Samples per axis, per pixel. 4×4 is enough to keep the corner curves smooth. */
const SUPERSAMPLE = 4

function insideRoundedRect(px, py, x, y, w, h, r) {
  if (px < x || py < y || px > x + w || py > y + h) return false
  const left = x + r
  const right = x + w - r
  const top = y + r
  const bottom = y + h - r
  const cx = px < left ? left : px > right ? right : px
  const cy = py < top ? top : py > bottom ? bottom : py
  if (cx === px || cy === py) return true
  const dx = px - cx
  const dy = py - cy
  return dx * dx + dy * dy <= r * r
}

function createCanvas(width, height) {
  return { width, height, data: Buffer.alloc(width * height * 4) }
}

/** Alpha-composites a rounded rectangle onto the canvas, anti-aliased. */
function fillRoundedRect(canvas, x, y, w, h, r, [red, green, blue], alpha = 1) {
  const step = 1 / SUPERSAMPLE
  const samples = SUPERSAMPLE * SUPERSAMPLE

  const minX = Math.max(0, Math.floor(x))
  const maxX = Math.min(canvas.width - 1, Math.ceil(x + w))
  const minY = Math.max(0, Math.floor(y))
  const maxY = Math.min(canvas.height - 1, Math.ceil(y + h))

  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      let hits = 0
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          if (insideRoundedRect(px + (sx + 0.5) * step, py + (sy + 0.5) * step, x, y, w, h, r)) {
            hits++
          }
        }
      }
      if (hits === 0) continue

      const coverage = (hits / samples) * alpha
      const offset = (py * canvas.width + px) * 4
      const existingAlpha = canvas.data[offset + 3] / 255
      const outAlpha = coverage + existingAlpha * (1 - coverage)
      if (outAlpha === 0) continue

      for (let channel = 0; channel < 3; channel++) {
        const source = [red, green, blue][channel]
        const target = canvas.data[offset + channel]
        canvas.data[offset + channel] = Math.round(
          (source * coverage + target * existingAlpha * (1 - coverage)) / outAlpha,
        )
      }
      canvas.data[offset + 3] = Math.round(outAlpha * 255)
    }
  }
}

/* ---------------------------------------------------------------- icon ---- */

const BLUE = [74, 110, 240]
const WHITE = [255, 255, 255]

/**
 * Two offset cards with a couple of text rules on the front one.
 *
 * `inset` shrinks the artwork towards the centre for the maskable variant, whose
 * outer 20% may be cropped to whatever shape the launcher prefers.
 */
function drawIcon(size, { maskable }) {
  const canvas = createCanvas(size, size)
  const unit = size / 512

  if (maskable) {
    // Full-bleed background: the platform applies its own mask.
    fillRoundedRect(canvas, 0, 0, size, size, 0, BLUE)
  } else {
    fillRoundedRect(canvas, 0, 0, size, size, 112 * unit, BLUE)
  }

  const scale = maskable ? 0.78 : 1
  const centre = size / 2
  const place = (x, y, w, h, r) => [
    centre + (x - 256) * unit * scale,
    centre + (y - 256) * unit * scale,
    w * unit * scale,
    h * unit * scale,
    r * unit * scale,
  ]

  fillRoundedRect(canvas, ...place(136, 104, 200, 272, 22), WHITE, 0.38)
  fillRoundedRect(canvas, ...place(176, 136, 200, 272, 22), WHITE, 1)
  fillRoundedRect(canvas, ...place(206, 200, 130, 16, 8), BLUE, 1)
  fillRoundedRect(canvas, ...place(206, 236, 92, 16, 8), BLUE, 1)

  return encodePng(size, size, canvas.data)
}

mkdirSync(OUT_DIR, { recursive: true })

const outputs = [
  ['icon-192.png', drawIcon(192, { maskable: false })],
  ['icon-512.png', drawIcon(512, { maskable: false })],
  ['icon-maskable-512.png', drawIcon(512, { maskable: true })],
]

for (const [name, png] of outputs) {
  writeFileSync(join(OUT_DIR, name), png)
  console.log(`wrote public/icons/${name} (${(png.length / 1024).toFixed(1)} kB)`)
}
