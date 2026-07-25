#!/usr/bin/env node
/* Rebuilds everything DERIVED from data/projects/<slug>/index.json:
 *
 *   data/projects.json         the list the site reads
 *   work/<slug>/index.html     one page per published project, carrying its own
 *                              <title>, description and OG tags
 *
 * The folder is work/, not project/, on purpose: project.html already answers at
 * /project, and a project/ directory next to it would make that URL ambiguous.
 *   sitemap.xml                published projects only, never a draft
 *
 * Run it from the repo root:  node tools/build.js
 *
 * The GitHub Action runs this exact file, so what you see locally is what CI
 * produces. Plain Node, no dependencies, no install step — the site stays a pile
 * of static files, this only writes them.
 *
 * Why the pages exist at all: social crawlers (WhatsApp, LinkedIn, Slack,
 * iMessage) do not execute JavaScript. Meta tags set from JS are invisible to
 * them, so every shared project link showed the same generic card. They have to
 * be in the served HTML, which means one real file per project.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SITE = 'https://kristiancimo.it';
const FALLBACK_IMAGE = SITE + '/og-image.png';

const escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* Same repair as js/paths.js, for the OG image: the CMS may write a bare
 * filename, a stray "/name.webp", or an already-correct path. OG needs absolute. */
function mediaUrl(value, slug) {
  if (!value || typeof value !== 'string') return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (value.includes('data/projects/')) return SITE + '/' + value.replace(/^\/+/, '');
  return `${SITE}/data/projects/${slug}/` + value.split('/').pop();
}

/* One clean line, cut on a word boundary — this is the text under the link in a
 * search result or a chat preview. */
function summarise(text, limit = 160) {
  if (!text) return null;
  const flat = String(text).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  if (flat.length <= limit) return flat;
  return flat.slice(0, limit).replace(/\s+\S*$/, '').replace(/[,.;:]+$/, '') + '…';
}

function lastCommitDate(file) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cs', '--', file],
      { encoding: 'utf8' }).trim();
    if (out) return out;
  } catch { /* no history (shallow clone, or file never committed) */ }
  return new Date().toISOString().slice(0, 10);
}

// ── 1. merge the project files ────────────────────────────────────────────────
const dir = 'data/projects';
const items = fs.readdirSync(dir)
  .filter(d => fs.existsSync(path.join(dir, d, 'index.json')))
  .sort()
  .map(d => JSON.parse(fs.readFileSync(path.join(dir, d, 'index.json'), 'utf8')));

items.sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
fs.writeFileSync('data/projects.json', JSON.stringify({ items }, null, 2) + '\n');
console.log(`projects.json: ${items.length} projects`);

/* Drafts are excluded from everything public. The site filters them at runtime
 * too (index.html and project.html), but they must never reach the sitemap and
 * must not get a generated page at all. */
const published = items.filter(p => !p.draft && p.slug);
console.log(`published: ${published.length} of ${items.length}`);

// ── 2. one page per published project ─────────────────────────────────────────
const template = fs.readFileSync('project.html', 'utf8');
const BLOCK = /<!-- BUILD:META[\s\S]*?<!-- \/BUILD:META -->/;
if (!BLOCK.test(template)) {
  console.error('project.html has no BUILD:META block — cannot generate pages');
  process.exit(1);
}

for (const p of published) {
  const slug = p.slug;
  const title = p.title || slug;
  const url = `${SITE}/work/${slug}/`;

  const bits = [p.client, p.year, p.category].filter(Boolean);
  const desc = summarise(p.description)
    || summarise(p.subtitle)
    || (bits.length ? bits.join(' · ') : null)
    || `${title}, a project by Kristian Cimò.`;

  const image = mediaUrl(p.gridCover169, slug) || mediaUrl(p.image, slug) || FALLBACK_IMAGE;

  const meta = [
    `<!-- BUILD:META — generated for ${escapeHtml(slug)}. Do not edit: rewritten on every build. -->`,
    `<title>${escapeHtml(title)} — Kristian Cimò</title>`,
    `<meta name="description" content="${escapeHtml(desc)}">`,
    `<link rel="canonical" href="${escapeHtml(url)}">`,
    `<meta property="og:title" content="${escapeHtml(title)} — Kristian Cimò">`,
    `<meta property="og:description" content="${escapeHtml(desc)}">`,
    `<meta property="og:type" content="article">`,
    `<meta property="og:url" content="${escapeHtml(url)}">`,
    `<meta property="og:image" content="${escapeHtml(image)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<!-- /BUILD:META -->`,
  ].join('\n');

  fs.mkdirSync(path.join('work', slug), { recursive: true });
  fs.writeFileSync(path.join('work', slug, 'index.html'), template.replace(BLOCK, meta));
  console.log(`  page: /work/${slug}/`);
}

// ── 3. drop pages for projects deleted or turned back to draft ────────────────
const keep = new Set(published.map(p => p.slug));
if (fs.existsSync('work')) {
  for (const name of fs.readdirSync('work')) {
    const full = path.join('work', name);
    if (fs.statSync(full).isDirectory() && !keep.has(name)) {
      fs.rmSync(full, { recursive: true, force: true });
      console.log(`  removed stale page: /work/${name}/`);
    }
  }
}

// ── 4. sitemap — published projects only ──────────────────────────────────────
const dates = Object.fromEntries(
  published.map(p => [p.slug, lastCommitDate(`data/projects/${p.slug}/index.json`)]));
const values = Object.values(dates);
const homeDate = values.length ? values.slice().sort().pop() : new Date().toISOString().slice(0, 10);

const lines = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  `  <url><loc>${SITE}/</loc><lastmod>${homeDate}</lastmod><priority>1.0</priority></url>`,
  ...published.map(p =>
    `  <url><loc>${SITE}/work/${p.slug}/</loc>` +
    `<lastmod>${dates[p.slug]}</lastmod><priority>0.8</priority></url>`),
  '</urlset>',
];
fs.writeFileSync('sitemap.xml', lines.join('\n') + '\n');
console.log(`sitemap.xml: ${published.length + 1} URLs`);
