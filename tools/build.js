#!/usr/bin/env node
/* Rebuilds everything DERIVED from data/projects/<slug>/index.json (and, for the
 * home, data/about.json and data/footer.json):
 *
 *   data/projects.json         the list the site reads, plus _media per project
 *                              (pixel size of each image and which smaller copies
 *                              exist in img/, for width/height and srcset)
 *   work/<slug>/index.html     one page per published project, carrying its own
 *                              <title>, description, OG tags and JSON-LD, and a
 *                              static copy of the page's text (see BUILD:BODY)
 *   index.html                 only between its BUILD:* fences: a plain list of
 *                              project links, the bio and the contact email
 *   sitemap.xml                published projects only, never a draft
 *   llms.txt                   a plain-text index of the site for AI assistants
 *
 * The folder is work/, not project/, on purpose: project.html already answers at
 * /project, and a project/ directory next to it would make that URL ambiguous.
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
 * be in the served HTML, which means one real file per project. The same goes,
 * since 2026-10-02, for the text itself: Bing and the AI crawlers (ChatGPT,
 * Perplexity, Claude) do not run JS either, and saw a page with no h1 and no words.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const crypto = require('crypto');

const SITE = 'https://kristiancimo.it';
const FALLBACK_IMAGE = SITE + '/og-image.png';
const VARIANT_WIDTHS = [640, 1280];   // must match tools/make-variants.js

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
// Site-relative form of the same, for <img src> in the static body.
const mediaPath = (value, slug) => { const u = mediaUrl(value, slug); return u && u.startsWith(SITE) ? u.slice(SITE.length) : u; };

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

/* Pixel size of a .webp from its header — enough for width/height attributes and
 * og:image:width/height without an image library. null for anything else. */
function webpSize(file) {
  let b;
  try { b = fs.readFileSync(file); } catch { return null; }
  if (b.length < 30 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
  return null;
}

/* For every .webp in a project folder: its size, and which widths exist in
 * img/<width>/<slug>/ (written by tools/make-variants.js, run locally). The pages
 * use this for width/height (no layout jump while images load) and srcset. */
let VARIANTS = {};
try { VARIANTS = JSON.parse(fs.readFileSync('img/manifest.json', 'utf8')); } catch { /* none made yet */ }
const sha1 = (file) => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');

function mediaTable(slug) {
  const dir = path.join('data/projects', slug);
  const table = {};
  for (const name of fs.readdirSync(dir)) {
    if (!/\.webp$/i.test(name)) continue;
    const size = webpSize(path.join(dir, name));
    if (!size) continue;
    // Copies count only while their original is the one they were made from: a
    // file replaced in the CMS under the same name has a new hash, and until
    // make-variants.js runs again the page serves the new original alone instead
    // of a smaller copy of the old artwork.
    const fresh = VARIANTS[`${slug}/${name}`] === sha1(path.join(dir, name));
    const v = fresh ? VARIANT_WIDTHS.filter(w => fs.existsSync(path.join('img', String(w), slug, name))) : [];
    table[name] = v.length ? { w: size.w, h: size.h, v } : { w: size.w, h: size.h };
  }
  return table;
}

// ── JSON-LD ──────────────────────────────────────────────────────────────────
/* One <script type="application/ld+json"> per generated page, inside the
 * BUILD:META fence so the noindex /project fallback never gets it. Everything is
 * derived from data/projects/<slug>/index.json — no second source of truth.
 * (Drafted by the claude-seo schema specialist in the 2026-10-02 audit.) */
const PERSON = { '@type': 'Person', '@id': SITE + '/#person', name: 'Kristian Cimò', url: SITE + '/' };
const WEBSITE = { '@type': 'WebSite', '@id': SITE + '/#website', name: 'Kristian Cimò', url: SITE + '/' };
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];

/* "September 2026" -> "2026-09", "2026" -> "2026", anything else -> null.
 * ISO 8601 reduced precision is valid for a schema.org Date; no invented day. */
function isoDate(text) {
  const m = String(text || '').trim().match(/^(?:([A-Za-z]+)\s+)?(\d{4})$/);
  if (!m) return null;
  if (!m[1]) return m[2];
  const i = MONTHS.indexOf(m[1].toLowerCase());
  return i < 0 ? null : `${m[2]}-${String(i + 1).padStart(2, '0')}`;
}

/* "Blender · After Effects", "Kenan Yildiz & Alessandro Del Piero", "A, B" */
const splitList = (s) => String(s || '').split(/\s*(?:·|&|,|\n)\s*/).map(x => x.trim()).filter(Boolean);

/* The CMS stores Instagram share links with ?igsh=<token>: a per-share id that
 * ties the URL to whoever copied it. Not needed, not worth publishing in markup. */
function cleanUrl(u) {
  try { const x = new URL(u); x.searchParams.delete('igsh'); return x.href; } catch { return null; }
}

function buildJsonLd(p, url, imageUrls) {
  const title = p.title || p.slug;
  const text = String(p.description || p.subtitle || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const roles = splitList(p.role);
  const software = splitList(p.software);
  /* Full names only: the CMS also holds mononyms ("Trent", "Raúl") that are not
   * a usable Person node, and an ambiguous node is worse than none. */
  const talent = splitList(p.talent).filter(n => /\s/.test(n));
  const others = (p.credits || []).filter(c => c && c.name && !/kristian cim/i.test(c.name));

  const credit = [
    roles.length ? `Kristian Cimò (${roles.join(', ')})` : null,
    ...others.map(c => `${c.role}: ${c.name}`),
  ].filter(Boolean).join('; ');

  const clientNode = !p.client ? null
    : { '@type': p.client === p.talent ? 'Person' : 'Organization', name: p.client };
  const pub = p.publicationUrl ? cleanUrl(p.publicationUrl) : null;
  const keywords = [...String(p.category || '').split(/\s*\/\s*/), ...software, ...roles].filter(Boolean).join(', ');
  const published = isoDate(p.year);

  const work = {
    '@type': 'CreativeWork',
    '@id': url + '#work',
    name: title,
    url,
    ...(text && { description: text }),
    image: imageUrls,
    thumbnailUrl: imageUrls[0],
    ...(published && { dateCreated: published, datePublished: published }),
    creator: PERSON,
    ...(credit && { creditText: credit }),
    ...(others.length && { contributor: others.map(c =>
      c.role === 'Agency' ? { '@type': 'Organization', name: c.name }
        : { '@type': 'Person', name: c.name, jobTitle: c.role }) }),
    ...(clientNode && { sponsor: clientNode }),
    ...(talent.length && { about: talent.map(name => ({ '@type': 'Person', name })) }),
    ...(p.category && { genre: p.category }),
    ...(keywords && { keywords }),
    ...(pub && { sameAs: pub }),
    inLanguage: 'en',
    isAccessibleForFree: true,
  };

  const page = {
    '@type': 'WebPage',
    '@id': url + '#webpage',
    url,
    name: `${title} — Kristian Cimò`,
    isPartOf: WEBSITE,
    mainEntity: { '@id': url + '#work' },
    primaryImageOfPage: { '@type': 'ImageObject', url: imageUrls[0] },
    breadcrumb: {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Work', item: SITE + '/#work' },
        { '@type': 'ListItem', position: 2, name: title, item: url },
      ],
    },
    inLanguage: 'en',
  };

  /* "<" escaped so a description can never close the <script> element early. */
  return '<script type="application/ld+json">\n'
    + JSON.stringify({ '@context': 'https://schema.org', '@graph': [page, work] }, null, 2)
        .replace(/</g, '\\u003c')
    + '\n</script>';
}

// ── Static body ──────────────────────────────────────────────────────────────
/* The page's text as plain HTML inside <main id="project-root">. renderProject()
 * in project.html overwrites root.innerHTML, so people never see this copy — the
 * intro loader covers the swap. It exists for every reader that does not run JS,
 * and it fills <main> from the first paint, so the footer no longer starts at the
 * top and jumps down when the JS arrives (that jump was a CLS of 0.44-0.48). */
function staticBody(p, next) {
  const slug = p.slug;
  const rows = [['Client', p.client], ['Talent', p.talent], ['Year', p.year], ['Role', p.role],
    ['Software', p.software], ['Format', p.format], ['Category', p.category]].filter(r => r[1]);
  const cover = p.insideCover || p.image;
  const coverSrc = cover ? mediaPath(cover, slug) : null;
  const coverSize = coverSrc && coverSrc.startsWith('/data/') ? webpSize(decodeURI(coverSrc).slice(1)) : null;
  const paragraphs = String(p.description || '').split(/\n\n+/).map(s => s.trim()).filter(Boolean);
  const credits = (p.credits || []).filter(c => c && c.name);
  const out = [];
  out.push(`<section class="project-hero">
  <div class="project-hero-meta"><span>${escapeHtml(p.client || '—')}</span><span class="sep">·</span><span>${escapeHtml(p.year || '—')}</span><span class="sep">·</span><span>${escapeHtml(p.category || '—')}</span></div>
  <h1 class="project-hero-title">${escapeHtml(p.title)}</h1>`
    + (p.subtitle ? `\n  <p class="project-hero-subtitle">${escapeHtml(p.subtitle)}</p>` : '')
    + (rows.length ? `\n  <div class="project-info-grid">\n${rows.map(([k, v]) =>
      `    <div class="row"><span>${escapeHtml(k)}</span><span>${escapeHtml(v)}</span></div>`).join('\n')}\n  </div>` : '')
    + `\n</section>`);
  if (coverSrc && !p.coverVideo) {
    // Same srcset/sizes the JS gives the cover (js/paths.js imgAttrs, sizes 100vw):
    // otherwise this eager <img> starts the full-size file and the JS version then
    // asks for the smaller copy — two downloads instead of one.
    const info = coverSrc.startsWith(`/data/projects/${slug}/`) && p._media
      ? p._media[decodeURI(coverSrc.split('/').pop())] : null;
    const srcset = info && info.v
      ? [...info.v.map(w => `${encodeURI(`/img/${w}/${slug}/${decodeURI(coverSrc.split('/').pop())}`)} ${w}w`),
         `${encodeURI(decodeURI(coverSrc))} ${info.w}w`].join(', ')
      : '';
    out.push(`<section class="project-cover"><img src="${escapeHtml(coverSrc)}" alt="${escapeHtml(p.title)}"`
      + (coverSize ? ` width="${coverSize.w}" height="${coverSize.h}"` : '')
      + (srcset ? ` srcset="${escapeHtml(srcset)}" sizes="100vw"` : '') + `></section>`);
  }
  if (paragraphs.length) {
    out.push(`<section class="p-section">
  <div class="p-section-head"><h2>Case Study</h2></div>
  <div class="p-description">
${paragraphs.map(t => `    <p>${escapeHtml(t)}</p>`).join('\n')}
  </div>
</section>`);
  }
  // The process text: on Hexagon it is most of the case study (numbered steps).
  const story = (p.storytelling || []).filter(s => s && (s.heading || s.text));
  if (story.length) {
    out.push(`<section class="p-section">
  <div class="p-section-head"><h2>Process</h2></div>
${story.map(s => `  <div class="p-story"><div class="text">`
      + (s.heading ? `<h3>${escapeHtml(s.heading)}</h3>` : '')
      + (s.text ? `<p>${escapeHtml(s.text)}</p>` : '')
      + `</div></div>`).join('\n')}
</section>`);
  }
  if (credits.length) {
    out.push(`<section class="p-section">
  <div class="p-section-head"><h2>Credits</h2></div>
  <div class="p-credits">
${credits.map(c => `    <div class="credit-row"><span>${escapeHtml(c.role)}</span><span>${escapeHtml(c.name)}</span></div>`).join('\n')}
  </div>
</section>`);
  }
  if (next && next.slug !== slug) {
    out.push(`<a href="/work/${encodeURIComponent(next.slug)}/" class="next-project">
  <div class="label">Next Project — ${escapeHtml(next.year || '')}</div>
  <h2>${escapeHtml(next.title)}</h2>
</a>`);
  }
  return out.join('\n');
}

/* Replace what sits between <!-- NAME ... --> and <!-- /NAME --> (the markers
 * stay). A function as the replacement, so "$&" or "$1" in project text are
 * written literally instead of being read as replacement patterns. */
function fill(html, name, content, file) {
  const re = new RegExp(`(<!-- ${name}[\\s\\S]*?-->)[\\s\\S]*?(<!-- /${name} -->)`);
  if (!re.test(html)) { console.error(`${file} has no ${name} block — cannot build`); process.exit(1); }
  return html.replace(re, (_, open, close) => `${open}\n${content}${content ? '\n' : ''}${close}`);
}

// ── 1. merge the project files ────────────────────────────────────────────────
const dir = 'data/projects';
const items = fs.readdirSync(dir)
  .filter(d => fs.existsSync(path.join(dir, d, 'index.json')))
  .sort()
  .map(d => {
    const p = JSON.parse(fs.readFileSync(path.join(dir, d, 'index.json'), 'utf8'));
    // Keyed by the folder: that is where the files are, whatever the slug says.
    return { ...p, _media: mediaTable(d) };
  });

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

published.forEach((p, i) => {
  const slug = p.slug;
  const title = p.title || slug;
  const url = `${SITE}/work/${slug}/`;
  const next = published[(i + 1) % published.length];

  const bits = [p.client, p.year, p.category].filter(Boolean);
  const desc = summarise(p.description)
    || summarise(p.subtitle)
    || (bits.length ? bits.join(' · ') : null)
    || `${title}, a project by Kristian Cimò.`;

  const image = mediaUrl(p.gridCover169, slug) || mediaUrl(p.image, slug) || FALLBACK_IMAGE;
  const imageUrls = [...new Set([image, mediaUrl(p.insideCover, slug), mediaUrl(p.image, slug)].filter(Boolean))];
  const imageSize = image.startsWith(`${SITE}/data/`) ? webpSize(decodeURI(image.slice(SITE.length + 1))) : null;

  const meta = [
    `<!-- BUILD:META — generated for ${escapeHtml(slug)}. Do not edit: rewritten on every build. -->`,
    `<title>${escapeHtml(title)} — Kristian Cimò</title>`,
    `<meta name="description" content="${escapeHtml(desc)}">`,
    `<link rel="canonical" href="${escapeHtml(url)}">`,
    `<meta property="og:site_name" content="Kristian Cimò">`,
    `<meta property="og:locale" content="en_US">`,
    `<meta property="og:title" content="${escapeHtml(title)} — Kristian Cimò">`,
    `<meta property="og:description" content="${escapeHtml(desc)}">`,
    `<meta property="og:type" content="article">`,
    `<meta property="og:url" content="${escapeHtml(url)}">`,
    `<meta property="og:image" content="${escapeHtml(image)}">`,
    ...(imageSize ? [`<meta property="og:image:width" content="${imageSize.w}">`,
                     `<meta property="og:image:height" content="${imageSize.h}">`] : []),
    `<meta property="og:image:alt" content="${escapeHtml(title)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    buildJsonLd(p, url, imageUrls),
    `<!-- /BUILD:META -->`,
  ].join('\n');

  let page = template.replace(BLOCK, () => meta);
  page = fill(page, 'BUILD:BODY', staticBody(p, next), 'project.html');
  fs.mkdirSync(path.join('work', slug), { recursive: true });
  fs.writeFileSync(path.join('work', slug, 'index.html'), page);
  console.log(`  page: /work/${slug}/`);
});

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

// ── 4. the home's static fallbacks ────────────────────────────────────────────
/* Same idea as BUILD:BODY: the grid, the bio and the email are built by JS, so
 * without these the home has 83 words, no link to any project and no contact. */
const about = JSON.parse(fs.readFileSync('data/about.json', 'utf8'));
const footer = JSON.parse(fs.readFileSync('data/footer.json', 'utf8'));
let home = fs.readFileSync('index.html', 'utf8');
const before = home;
home = fill(home, 'BUILD:LINKS', published.map(p =>
  `<a href="/work/${encodeURIComponent(p.slug)}/">${escapeHtml(p.title)}`
  + ([p.client, p.year].filter(Boolean).length ? ` — ${escapeHtml([p.client, p.year].filter(Boolean).join(', '))}` : '')
  + `</a>`).join('\n'), 'index.html');
home = fill(home, 'BUILD:ABOUT', (about.paragraphs || [])
  .map(t => `<p>${escapeHtml(typeof t === 'string' ? t : t.text)}</p>`).join('\n'), 'index.html');
home = fill(home, 'BUILD:CONTACT', footer.email
  ? `<a href="mailto:${escapeHtml(footer.email)}">${escapeHtml(footer.email)}</a>` : '', 'index.html');
if (home !== before) { fs.writeFileSync('index.html', home); console.log('index.html: static fallbacks updated'); }

// ── 5. sitemap — published projects only ──────────────────────────────────────
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

// ── 6. llms.txt ───────────────────────────────────────────────────────────────
/* The llmstxt.org format: a short Markdown index an AI assistant can read in one
 * request instead of rendering the JS site. Optional and ignored by Google; cheap
 * to keep honest because it comes from the same data as everything else. */
const site = JSON.parse(fs.readFileSync('data/site.json', 'utf8'));
const llms = [
  '# Kristian Cimò',
  '',
  `> ${site.description || 'Freelance VFX, CGI and 3D artist.'}`,
  '',
  'Based in Milan, Italy, working remote worldwide.',
  footer.email ? `Contact: ${footer.email}` : null,
  ...(footer.social || []).map(s => `${s.label}: ${s.url}`),
  '',
  '## Work',
  '',
  ...published.map(p => {
    const facts = [p.client, p.year, p.role].filter(Boolean).join(' · ');
    const line = summarise(p.description, 200);
    return `- [${p.title}](${SITE}/work/${p.slug}/)` + (facts ? `: ${facts}` : '') + (line ? `. ${line}` : '');
  }),
  '',
].filter(l => l !== null);
fs.writeFileSync('llms.txt', llms.join('\n'));
console.log('llms.txt: written');
