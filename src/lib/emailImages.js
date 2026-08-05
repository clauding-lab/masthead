// src/lib/emailImages.js — post-processes ALREADY-SANITIZED email HTML (a
// string, output of sanitizeEmailHtml) to neutralize remote requests before
// the HTML ever renders. Security carry-forward from the 3A final review,
// extended by Opus fix round 1 (F1/F1b) on Task 16's first pass:
//
// F1 — the original version tested `/https?:/i` against each candidate
// value, which is a SCHEME allowlist masquerading as a block list: a
// protocol-relative URL (`//tracker.example/beacon.jpg`) has NO scheme at
// all, so it matched neither `http:` nor `https:` and sailed through
// unblocked — yet on an https page it resolves to a live https request,
// defeating blocking end-to-end. The fix inverts the test: a value is
// treated as REMOTE (blocked) UNLESS it resolves to something PROVABLY
// safe — a `data:` URI (the bytes are inline, no network request) or the
// page's own origin (nothing third-party learns anything). Everything
// else, including anything that fails to parse, is blocked by default.
//
// F1 also extends vector coverage beyond img/picture>source to every
// element the reviewer proved survives sanitizeEmailHtml and can trigger a
// remote fetch: `<source>` ANYWHERE (not just inside `<picture>` — also a
// direct child of `<audio>`/`<video>`), `<video poster>`, `<track src>`,
// and the legacy `background` attribute on `<table>`/`<td>`/`<th>`/`<tr>`
// (obsolete HTML, still rendered by every major engine).
//
// F1b — blockedCount now increments once per ELEMENT that had anything
// neutralized (any tag, not just <img>), so a bare `<picture><source>`
// with no fallback `<img>` still surfaces a "Load images" affordance
// instead of staying silently, permanently blocked.
//
// Known residual vector (Ruling 1, Opus fix round 1): the `style`
// ATTRIBUTE survives sanitizeEmailHtml by design (newsletters need inline
// styles for tables/layout), so a browser could in principle fetch a
// remote image via five CSS properties that accept url(...):
// background-image, background, list-style-image, border-image, cursor.
// This module does NOT parse or strip CSS values — that vector is closed
// one layer earlier, at the ONLY path that writes html_body: the
// server-side sanitizer (lib/sanitizeEmail.js) allows NONE of the five to
// carry a working url() in its ALLOWED_STYLES config (background-image/
// list-style-image/border-image/cursor are simply absent from the
// allowlist — sanitize-html drops any style property not explicitly
// listed; `background` IS listed but restricted to SAFE_NO_URL, which
// rejects any value containing "url("). Pinned server-side in
// lib/sanitizeEmail.test.js, not here.
const PLACEHOLDER_SRC =
  'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22%3E%3C/svg%3E';

// A value is remote unless it is PROVABLY safe: a data: URI (bytes are
// inline) or same-origin (the app's own server, not a third party who'd
// learn anything from the request). Everything else — including anything
// that fails to parse even against a base — is treated as remote and
// blocked. This is the inverted, default-closed test F1 requires; the
// previous `/https?:/i` scheme allowlist missed protocol-relative URLs
// entirely, and `new URL()` normalizes scheme case and resolves a
// protocol-relative value against the current origin, so uppercase/
// whitespace-padded/scheme-less inputs are all caught the same way.
function isRemote(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  const origin = typeof window !== 'undefined' ? window.location.origin : undefined;
  let resolved;
  try {
    resolved = new URL(trimmed, origin);
  } catch {
    return true; // unparseable — not provably safe, block by default
  }
  if (resolved.protocol === 'data:') return false;
  if (origin && resolved.origin === origin) return false;
  return true;
}

// srcset is a comma-separated list of "<url> <descriptor>?" candidates
// (e.g. "a.jpg 1x, b.jpg 2x") — a naive whole-string test would miss a
// remote URL sitting after the first candidate. Splits on commas, then
// strips each candidate's optional trailing descriptor (the first
// whitespace run) to isolate just the URL.
function srcsetUrls(srcset) {
  return srcset
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const idx = part.search(/\s/);
      return idx === -1 ? part : part.slice(0, idx);
    });
}

function srcsetIsRemote(srcset) {
  return srcsetUrls(srcset).some((url) => isRemote(url));
}

// Neutralizes `attr` on `el` if it carries a remote reference, stashing
// the original value under `data-masthead-<attr>` first so "Load images"
// can restore it verbatim. Returns true when it blocked something, so
// callers can count the ELEMENT once regardless of how many of its
// attributes were touched (F1b).
function blockAttr(el, attr, { isSrcset = false, replacement } = {}) {
  const value = el.getAttribute(attr);
  if (!value) return false;
  const remote = isSrcset ? srcsetIsRemote(value) : isRemote(value);
  if (!remote) return false;
  el.setAttribute(`data-masthead-${attr}`, value);
  if (replacement === undefined) {
    el.removeAttribute(attr);
  } else {
    el.setAttribute(attr, replacement);
  }
  return true;
}

/**
 * @param {string} html sanitized email HTML (already run through
 *   sanitizeEmailHtml)
 * @returns {{ html: string, blockedCount: number }} `blockedCount` is the
 *   number of ELEMENTS that had a remote reference neutralized on ANY of
 *   their tracked attributes — the user-facing "N" for a "Load images (N)"
 *   control.
 */
export function blockRemoteImages(html) {
  if (!html) return { html: '', blockedCount: 0 };

  const doc = new DOMParser().parseFromString(String(html), 'text/html');
  let blockedCount = 0;

  doc.querySelectorAll('img').forEach((img) => {
    const blockedSrc = blockAttr(img, 'src', { replacement: PLACEHOLDER_SRC });
    const blockedSrcset = blockAttr(img, 'srcset', { isSrcset: true });
    if (blockedSrc || blockedSrcset) blockedCount += 1;
  });

  // <source> is a remote-fetch vector wherever it appears — inside
  // <picture> (image candidates) AND as a direct child of <audio>/<video>
  // (media candidates). One unified pass, not scoped to `picture source`.
  doc.querySelectorAll('source').forEach((source) => {
    const blockedSrcset = blockAttr(source, 'srcset', { isSrcset: true });
    const blockedSrc = blockAttr(source, 'src');
    if (blockedSrcset || blockedSrc) blockedCount += 1;
  });

  doc.querySelectorAll('video').forEach((video) => {
    if (blockAttr(video, 'poster')) blockedCount += 1;
  });

  doc.querySelectorAll('track').forEach((track) => {
    if (blockAttr(track, 'src')) blockedCount += 1;
  });

  // Legacy `background` attribute (pre-CSS table backgrounds) — obsolete
  // but still rendered by every major engine.
  doc.querySelectorAll('table, td, th, tr').forEach((el) => {
    if (blockAttr(el, 'background')) blockedCount += 1;
  });

  return { html: doc.body.innerHTML, blockedCount };
}
