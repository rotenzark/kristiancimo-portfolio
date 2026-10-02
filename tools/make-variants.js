#!/usr/bin/env node
/* Smaller copies of the project images, for srcset — run LOCALLY, by hand:
 *
 *   node tools/make-variants.js
 *
 * For every .webp in data/projects/<slug>/ it writes img/<width>/<slug>/<same name>
 * at 640 and 1280 px wide (only the widths smaller than the original). The originals
 * are never touched: these are extra files the browser can pick instead of the full
 * size when the slot on screen is small — a phone grid, a gallery thumbnail.
 *
 * Why a separate img/ tree and not next to the originals: data/projects/<slug>/ is
 * also the CMS media folder, and every copy would show up in Kristian's media
 * picker. Why not in the GitHub Action: it needs ffmpeg, and the build must stay
 * zero-dependency (CLAUDE.md §1). The site works without these files — build.js
 * lists only what exists, and the pages fall back to the original — so a project
 * published before this is run simply has no srcset yet.
 *
 * Re-running is cheap: img/manifest.json records a hash of each original, so a
 * copy is only rebuilt when its original changed, and copies whose original is
 * gone are deleted. tools/build.js reads the same manifest and lists a copy only
 * if its hash still matches: an image replaced in the CMS under the same name
 * falls back to the new original until this is run again, instead of showing the
 * old artwork from a stale copy.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const crypto = require('crypto');

const WIDTHS = [640, 1280];
const QUALITY = 82;                 // the lossy WebP range CLAUDE.md §9 uses
const SRC_DIR = 'data/projects';
const OUT_DIR = 'img';
const MANIFEST = path.join(OUT_DIR, 'manifest.json');
const hashOf = (file) => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');

function webpWidth(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') return b.readUInt16LE(26) & 0x3fff;
  if (chunk === 'VP8L') return 1 + (((b[22] & 0x3f) << 8) | b[21]);
  if (chunk === 'VP8X') return 1 + b.readUIntLE(24, 3);
  return null;
}

try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  console.error('ffmpeg not found on PATH — install it, or skip: the site works without variants.');
  process.exit(1);
}

let made = 0, skipped = 0, removed = 0;
const wanted = new Set([path.resolve(MANIFEST)]);
let oldManifest = {};
try { oldManifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { /* first run */ }
const manifest = {};

for (const slug of fs.readdirSync(SRC_DIR)) {
  const dir = path.join(SRC_DIR, slug);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const name of fs.readdirSync(dir)) {
    if (!/\.webp$/i.test(name)) continue;
    const src = path.join(dir, name);
    const width = webpWidth(src);
    if (!width) continue;
    const key = `${slug}/${name}`;
    const hash = hashOf(src);
    const changed = oldManifest[key] !== hash;
    let any = false;
    for (const w of WIDTHS) {
      if (width <= w * 1.15) continue;          // not worth a copy this close to the original
      const out = path.join(OUT_DIR, String(w), slug, name);
      wanted.add(path.resolve(out));
      any = true;
      if (fs.existsSync(out) && !changed) { skipped++; continue; }
      fs.mkdirSync(path.dirname(out), { recursive: true });
      // -pix_fmt bgra hands RGB to libwebp, which does its own RGB->YUV conversion:
      // the same path cwebp and Squoosh use, so colours match the originals.
      execFileSync('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-i', src,
        '-vf', `scale=${w}:-2:flags=lanczos`, '-pix_fmt', 'bgra',
        '-c:v', 'libwebp', '-lossless', '0', '-quality', String(QUALITY), '-compression_level', '6', out]);
      made++;
    }
    if (any) manifest[key] = hash;
  }
}
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1) + '\n');

// Drop variants whose original was deleted or renamed.
if (fs.existsSync(OUT_DIR)) {
  (function sweep(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { sweep(p); if (!fs.readdirSync(p).length) fs.rmdirSync(p); }
      else if (!wanted.has(path.resolve(p))) { fs.rmSync(p); removed++; }
    }
  })(OUT_DIR);
}

console.log(`variants: ${made} written, ${skipped} up to date, ${removed} removed`);
console.log('Now run: node tools/build.js  (it lists the variants in data/projects.json)');
