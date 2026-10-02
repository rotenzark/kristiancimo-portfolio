/* 3D ring view of the work section — "3D" in the view switch, an opt-in third view
 * next to Classic and 16:9.
 *
 * A plain-JS port of a React "circular gallery" (shadcn/Tailwind). The site has no
 * framework and no build step (CLAUDE.md §1), so only the idea came across: cards
 * standing on a cylinder, turned with rotateY under a perspective.
 *
 * The page owns the data: sorting, drafts and fixPath all happen in index.html,
 * which hands over finished items. This module only owns geometry, motion and input.
 *
 * What it deliberately does NOT do: pin the section while scrolling. The original
 * demo turns the ring with a 500vh sticky track, which would have put three or four
 * extra screens of scroll between the work and the contacts. Here the ring is one
 * screen tall, the page scrolls through it untouched, and page scroll only nudges
 * the ring (SCROLL_SWEEP) as the section passes.
 */

const DEG = 180 / Math.PI;
const AUTO_SPEED = 4;        // deg/s when idle — a full turn in about 90 s
const SCROLL_SWEEP = 90;     // deg the ring turns while the section crosses the viewport
const DRAG_THRESHOLD = 6;    // px before a press counts as a drag (and stops being a click)
const FRICTION = 3;          // inertia decay per second, exponential
const MAX_FLICK = 720;       // deg/s cap on a flick
const SETTLE_MS = 150;       // the ring must be still this long before a hover clip plays
const RESUME_MS = 900;       // idle time after an interaction before auto-rotation resumes

// Angle to (-180, 180]: how far a card is from facing the viewer, either way round.
const norm = a => ((a % 360) + 540) % 360 - 180;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* items: [{ href, title, info, tag, img, srcset, video, video169, ratio }]
   ratio is width/height from the CMS "Card Orientation"; null = take it from the cover.
   video / video169 are the vertical and horizontal hover clips; the card picks one
   by its shape when it plays, since an "Auto" card only knows its shape once the
   cover has loaded. */
export function createWorkRing(root) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  // Hover clips only where a real pointer hovers. Touch devices fire mouseenter on
  // tap, which would freeze the ring until the next tap somewhere else.
  const hoverable = window.matchMedia('(hover: hover) and (pointer: fine)');

  const stage = document.createElement('div');
  stage.className = 'ring-stage';
  root.appendChild(stage);

  let cards = [];
  let radius = 0;
  let theta = 0;          // rotation from time and input, deg
  let scrollOffset = 0;   // rotation from page scroll, deg
  let shown = NaN;        // rotation last written to the DOM
  let velocity = 0;       // deg/s left over from a flick
  let focused = null;     // card holding keyboard focus: kept at the front
  let hovered = null, playing = null;
  let resumeAt = 0, lastMove = 0;
  let active = false, inView = false, hydrated = false;
  let raf = 0, lastT = 0;
  let suppressClick = false;
  const drag = { id: null, on: false, x: 0, start: 0, lastX: 0, lastT: 0, v: 0 };

  /* ─── Build ─── */
  function render(items) {
    stopVideo();
    hovered = null;
    focused = null;
    stage.innerHTML = items.map(it => `
      <a class="ring-card interactive" href="${esc(it.href)}" draggable="false">
        ${it.tag ? `<span class="ring-tag">${esc(it.tag)}</span>` : ''}
        <img class="ring-img" data-src="${esc(it.img)}"${it.srcset ? ` data-srcset="${esc(it.srcset)}"` : ''} alt="${esc(it.title)}" draggable="false" decoding="async">
        ${it.video || it.video169 ? `<video class="ring-video" data-src="${esc(it.video)}" data-src169="${esc(it.video169)}" muted loop playsinline preload="none" aria-hidden="true"></video>` : ''}
        <div class="ring-meta">
          <div class="ring-title">${esc(it.title)}</div>
          ${it.info ? `<div class="ring-info">${esc(it.info)}</div>` : ''}
        </div>
        <span class="ring-shade" aria-hidden="true"></span>
      </a>`).join('');

    cards = [...stage.children].map((el, i) => {
      const c = {
        el,
        img: el.querySelector('.ring-img'),
        video: el.querySelector('.ring-video'),
        shade: el.querySelector('.ring-shade'),
        ratio: items[i].ratio || 0.75,
        auto: !items[i].ratio,
        angle: 0, w: 0, h: 0, o: -1, near: null, back: null,
      };
      if (hoverable.matches) {
        el.addEventListener('mouseenter', () => { hovered = c; });
        el.addEventListener('mouseleave', () => {
          if (hovered === c) { hovered = null; resumeAt = performance.now() + RESUME_MS; }
        });
      }
      return c;
    });
    if (hydrated) hydrate();
    layout();
  }

  /* Covers load only once the section is close to the viewport — the ring sits
     below the hero, and a visitor who never scrolls there should not pay for it. */
  function hydrate() {
    hydrated = true;
    cards.forEach(c => {
      if (c.img.getAttribute('src')) return;
      if (c.auto) {
        c.img.addEventListener('load', () => {
          if (!c.img.naturalWidth || !c.img.naturalHeight) return;
          c.ratio = c.img.naturalWidth / c.img.naturalHeight;
          layout();
        }, { once: true });
      }
      // srcset before src, and sizes from layout(): the browser then fetches the
      // smallest copy that fills the card instead of the full-size cover.
      if (c.img.dataset.srcset) { c.img.sizes = Math.max(1, c.w) + 'px'; c.img.srcset = c.img.dataset.srcset; }
      c.img.src = c.img.dataset.src;
    });
  }

  /* ─── Geometry ───
     Every card has the same height and its own width, so no cover is cropped to a
     shape it was not made for. The radius is whatever makes that row of widths
     (plus gaps) close into exactly one circle. */
  function layout() {
    const W = root.clientWidth, Hs = root.clientHeight;
    if (!W || !Hs || !cards.length) return;
    const H = clamp(Hs * 0.66, 220, 500);
    // A 16:9 card at full height is wider than a phone; past this it shrinks instead,
    // keeping its ratio, so its title is never off-screen when it comes to the front.
    const maxW = W * 0.86;
    const gap = Math.round(H * 0.08);

    let total = 0;
    cards.forEach(c => {
      c.w = H * c.ratio; c.h = H;
      if (c.w > maxW) { c.w = maxW; c.h = maxW / c.ratio; }
      c.w = Math.round(c.w); c.h = Math.round(c.h);
      total += c.w + gap;
    });
    radius = total / (2 * Math.PI);
    // Far enough that the near cards don't balloon, close enough that the ring reads as one.
    root.style.perspective = Math.round(Math.max(1400, radius * 2.4)) + 'px';

    // Card 0 at angle 0: in front when the ring is at rest.
    let acc = 0;
    cards.forEach((c, i) => {
      if (i) acc += (cards[i - 1].w + c.w) / 2 + gap;
      c.angle = acc / radius * DEG;
      const s = c.el.style;
      s.width = c.w + 'px';
      s.height = c.h + 'px';
      s.marginLeft = -c.w / 2 + 'px';
      s.marginTop = -c.h / 2 + 'px';
      s.transform = `rotateY(${c.angle}deg) translateZ(${radius}px)`;
      if (c.img.srcset) c.img.sizes = c.w + 'px';
    });
    shown = NaN;
    draw();
  }

  /* ─── Paint ─── */
  function draw() {
    const rot = theta + scrollOffset;
    if (rot === shown || !radius) return;
    shown = rot;
    // Pushed back by the radius, so the card in front renders at its real size.
    stage.style.transform = `translateZ(${-radius}px) rotateY(${rot}deg)`;
    for (const c of cards) {
      const rel = Math.abs(norm(rot + c.angle));   // 0 = facing the viewer
      // Darkened with a black layer rather than faded with opacity: a translucent
      // card would show the mirrored backs of the far side through itself.
      const o = Math.round((1 - Math.max(0.25, 1 - rel / 180)) * 100) / 100;
      if (o !== c.o) { c.shade.style.opacity = o; c.o = o; }
      const near = rel < 50, back = rel > 95;
      if (near !== c.near) { c.el.classList.toggle('is-near', near); c.near = near; }
      // The far side can't be clicked: a link you can barely see, mirrored, through a gap.
      if (back !== c.back) { c.el.classList.toggle('is-back', back); c.back = back; }
    }
  }

  /* ─── Motion ─── */
  function frame(t) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, lastT ? (t - lastT) / 1000 : 0);
    lastT = t;
    if (drag.on) {
      // theta follows the pointer in pointermove
    } else if (focused) {
      // Re-aimed every frame, not once: focusing a card can make the browser scroll
      // the page to it (smoothly), and that scroll keeps turning the ring after the
      // card was aimed at — a one-off target ended up several degrees off-centre.
      const goal = theta + norm(-(theta + scrollOffset + focused.angle));
      theta += (goal - theta) * (reduced.matches ? 1 : 1 - Math.exp(-dt * 9));
    } else if (Math.abs(velocity) > 1 && !reduced.matches) {
      theta += velocity * dt;
      velocity *= Math.exp(-dt * FRICTION);
    } else {
      velocity = 0;
      if (!hovered && !reduced.matches && t >= resumeAt) theta -= AUTO_SPEED * dt;
    }
    const before = shown;
    draw();
    if (shown !== before) lastMove = t;
    updateVideo(t);
  }

  /* Scrolling down turns the ring the same way auto-rotation does, so the next
     cards come in from the right. Centred on the section: the sweep is zero when
     the ring sits in the middle of the window. */
  function measureScroll() {
    if (!active || reduced.matches) { scrollOffset = 0; return; }
    const r = root.getBoundingClientRect(), vh = window.innerHeight;
    const p = clamp((vh - r.top) / (vh + r.height), 0, 1);
    scrollOffset = (0.5 - p) * SCROLL_SWEEP;
  }

  /* ─── Hover clip ───
     Plays only while the ring is still. A <video> inside a moving 3D transform gets
     resampled on a new grid every frame and visibly crawls — the same reason
     .cover-video in the grid never animates its scale (CLAUDE.md §7). */
  function updateVideo(t) {
    const want = hovered && hovered.video && !drag.on && t - lastMove > SETTLE_MS ? hovered : null;
    if (want === playing) return;
    if (playing) {
      playing.el.classList.remove('is-playing');
      playing.video.pause();
      if (playing !== hovered) playing.video.currentTime = 0;   // left the card: rewind
    }
    playing = want;
    if (want) {
      const v = want.video;
      const src = want.ratio > 1 ? (v.dataset.src169 || v.dataset.src) : (v.dataset.src || v.dataset.src169);
      if (v.getAttribute('src') !== src) v.src = src;
      // The cover gives way only once the clip is actually running: not while it is
      // still loading, and never if autoplay is refused or the file fails.
      v.play().then(() => {
        if (playing === want) want.el.classList.add('is-playing');
      }).catch(() => { /* the still stays */ });
    }
  }
  function stopVideo() {
    if (!playing) return;
    playing.el.classList.remove('is-playing');
    playing.video.pause();
    playing.video.currentTime = 0;
    playing = null;
  }

  /* ─── Run only when shown and on screen ─── */
  function sync() {
    const run = active && inView;
    if (run && !raf) {
      lastT = 0;
      measureScroll();
      raf = requestAnimationFrame(frame);
    } else if (!run && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
      hovered = null;
      stopVideo();
    }
  }

  function setActive(on) {
    active = on;
    if (on) { measureScroll(); layout(); }
    sync();
  }

  /* ─── Input ─── */
  root.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    suppressClick = false;
    Object.assign(drag, { id: e.pointerId, on: false, x: e.clientX, lastX: e.clientX,
                          start: theta, lastT: performance.now(), v: 0 });
    focused = null;   // the pointer takes over from the keyboard
    velocity = 0;
  });
  root.addEventListener('pointermove', e => {
    if (e.pointerId !== drag.id || !radius) return;
    // A press released outside the ring before it became a drag never reaches our
    // pointerup (no capture yet). Without this, plain mouse movement afterwards
    // would turn the ring as if the button were still held.
    if (e.pointerType === 'mouse' && !(e.buttons & 1)) { drag.id = null; drag.on = false; return; }
    const dx = e.clientX - drag.x;
    if (!drag.on) {
      if (Math.abs(dx) < DRAG_THRESHOLD) return;
      drag.on = true;
      suppressClick = true;
      root.setPointerCapture(e.pointerId);
      root.classList.add('is-dragging');
    }
    // 1:1 at the front: the card under the finger moves exactly as far as the finger.
    theta = drag.start + dx / radius * DEG;
    const now = performance.now(), dts = (now - drag.lastT) / 1000;
    if (dts > 0) drag.v = 0.8 * ((e.clientX - drag.lastX) / radius * DEG / dts) + 0.2 * drag.v;
    drag.lastX = e.clientX;
    drag.lastT = now;
  });
  function endDrag(e) {
    if (e.pointerId !== drag.id) return;
    if (drag.on) {
      // A flick keeps spinning; a drag that came to rest before release does not.
      velocity = performance.now() - drag.lastT < 80 ? clamp(drag.v, -MAX_FLICK, MAX_FLICK) : 0;
      root.classList.remove('is-dragging');
      resumeAt = performance.now() + RESUME_MS;
    }
    drag.id = null;
    drag.on = false;
  }
  root.addEventListener('pointerup', endDrag);
  root.addEventListener('pointercancel', endDrag);
  // A drag must not also open the project it was released on.
  root.addEventListener('click', e => {
    if (!suppressClick) return;
    e.preventDefault();
    e.stopPropagation();
    suppressClick = false;
  }, true);

  // Horizontal trackpad swipes (and shift+wheel) turn the ring; vertical ones are
  // left alone so the page always scrolls.
  root.addEventListener('wheel', e => {
    if (!radius || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    e.preventDefault();
    const dx = e.deltaMode === 1 ? e.deltaX * 16 : e.deltaX;
    focused = null;
    velocity = 0;
    theta -= dx / radius * DEG;
    resumeAt = performance.now() + RESUME_MS;
  }, { passive: false });

  // Keyboard: Tab reaches each card and brings it to the front; arrows step between them.
  // Only keyboard focus counts. A link also takes focus when it is pressed with the
  // mouse, and treating that as "bring to front" would swing the ring back to the
  // card a drag started on, the moment the drag was released.
  root.addEventListener('focusin', e => {
    const c = cards.find(c => c.el === e.target);
    focused = c && c.el.matches(':focus-visible') ? c : null;
    if (focused) velocity = 0;
  });
  root.addEventListener('focusout', e => {
    if (root.contains(e.relatedTarget)) return;
    focused = null;
    resumeAt = performance.now() + RESUME_MS;
  });
  root.addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = cards.findIndex(c => c.el === document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const n = cards.length;
    cards[(i + (e.key === 'ArrowRight' ? 1 : -1) + n) % n].el.focus({ preventScroll: true });
  });

  window.addEventListener('scroll', measureScroll, { passive: true });
  new ResizeObserver(() => layout()).observe(root);
  new IntersectionObserver(([e]) => { inView = e.isIntersecting; sync(); }, { rootMargin: '100px' }).observe(root);
  const near = new IntersectionObserver(([e]) => {
    if (!e.isIntersecting) return;
    hydrate();
    near.disconnect();
  }, { rootMargin: '800px' });
  near.observe(root);

  return { render, setActive };
}
