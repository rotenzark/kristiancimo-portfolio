/* Shared media-path repair, imported by index.html and project.html.
 *
 * Sveltia writes media references inconsistently: sometimes a bare filename
 * ("COVER.webp"), sometimes a stray "/CLAY_2.webp", sometimes an old
 * "/media/..." (that folder no longer exists), sometimes the correct path.
 * Everything is repaired at runtime instead of trusting the JSON.
 *
 * This lived duplicated in both pages until 2026-07-25. It is one module now so
 * the two copies cannot drift apart. Paths are absolute (/data/...) because the
 * generated project pages are served from /project/<slug>/, two levels deep —
 * relative ones would resolve against the wrong folder.
 */

export function videoEmbed(url) {
  if (!url) return null;
  const v = url.match(/(?:vimeo\.com\/)(\d+)/);
  if (v) return `https://player.vimeo.com/video/${v[1]}?title=0&byline=0&portrait=0`;
  const y = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/))([\w-]+)/);
  if (y) return `https://www.youtube.com/embed/${y[1]}?rel=0`;
  return null;
}

export function mediaBaseFor(slug) {
  return '/data/projects/' + slug + '/';
}

export function fixPath(v, mediaBase) {
  if (typeof v !== 'string' || !v) return '';
  // real URLs and data URIs: leave untouched
  if (/^https?:\/\//i.test(v) || v.startsWith('data:')) return v;
  // Vimeo/YouTube links are often written without a protocol ("vimeo.com/123456").
  // They are embeds, not files — without this check the fallback below would turn
  // them into "/data/projects/<slug>/123456".
  if (videoEmbed(v)) return v;
  // already a correct project path (with or without a leading slash): normalise to absolute
  if (v.includes('data/projects/')) return '/' + v.replace(/^\/+/, '');
  // anything else — a bare filename, a stray "/name.webp", or an old "/media/name.webp"
  // — belongs in THIS project's folder. Take just the filename and prefix it, so a
  // malformed CMS path still resolves.
  return mediaBase + v.split('/').pop();
}

/* Single media reference: a string under one of these keys gets repaired.
 * If you add a new media field to the CMS, add its key here — otherwise its path
 * is never corrected. If the field can hold a URL as well as a file (coverVideo
 * does), check that fixPath leaves that URL alone first. */
const MEDIA_KEYS = ['image', 'previewVideo', 'gridCover169', 'insideCover', 'coverVideo',
                    'src', 'imageBefore', 'imageAfter', 'videoBefore', 'videoAfter', 'file'];

/* Media LISTS. Depending on how the CMS wrote them, items can be bare strings
 * (e.g. "CLAY_2.webp") OR objects like { src: "..." }. Both are handled. */
const MEDIA_ARRAY_KEYS = ['images', 'gallery'];

export function fixDeep(obj, mediaBase) {
  if (Array.isArray(obj)) return obj.map(o => fixDeep(o, mediaBase));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(obj)) {
      if (MEDIA_KEYS.includes(k) && typeof val === 'string') {
        out[k] = fixPath(val, mediaBase);
      } else if (MEDIA_ARRAY_KEYS.includes(k) && Array.isArray(val)) {
        out[k] = val.map(it => typeof it === 'string' ? fixPath(it, mediaBase) : fixDeep(it, mediaBase));
      } else {
        out[k] = fixDeep(val, mediaBase);
      }
    }
    return out;
  }
  return obj;
}
