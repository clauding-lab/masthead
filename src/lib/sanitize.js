import DOMPurify from 'dompurify';

const CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['iframe', 'object', 'embed', 'form', 'input', 'button', 'style', 'svg', 'math'],
  FORBID_ATTR: ['style'],
  ADD_ATTR: ['loading'],
};

export function sanitizeArticleHtml(html) {
  if (!html) return '';
  return DOMPurify.sanitize(html, CONFIG);
}

// Client-side re-sanitisation of newsletter HTML at render time (defence in
// depth alongside the server-side lib/sanitizeEmail.js — AGENTS.md's
// "two sanitisation layers by design" convention). Deliberately a SEPARATE
// profile from CONFIG above, not a shared one with an override: email needs
// the `style` ATTRIBUTE (newsletters are table-and-inline-style HTML; most
// go unreadable without it), which article bodies never need and must keep
// stripping. The `style` ELEMENT is explicitly listed in FORBID_TAGS below
// (Opus fix round 1, F2): DOMPurify's `html` profile ALLOWS <style> by
// default, same as sanitizeArticleHtml's CONFIG must also explicitly forbid
// it — an earlier version of this list omitted 'style', and a TOP-LEVEL
// `<style>...</style><p>hi</p>` test happened to pass anyway, but only
// because the HTML parser hoists a leading <style> (before any other body
// content) into an implicit <head>, which never reaches the serialized body
// output — a position artifact, not policy. A NESTED `<style>` (e.g.
// `<div><style>...</style></div>`) stays in normal body flow and would have
// survived, letting a newsletter inject document-wide CSS (including a
// url() background beacon). An allowed style ATTRIBUTE is scoped per-node;
// an allowed <style> ELEMENT is a global CSS injection vector — the two are
// not equivalent, and only the attribute should ever be allowed.
const EMAIL_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['iframe', 'object', 'embed', 'form', 'input', 'button', 'style', 'svg', 'math'],
  ADD_ATTR: ['target', 'rel', 'loading'],
};

export function sanitizeEmailHtml(html) {
  if (!html) return '';
  return DOMPurify.sanitize(html, EMAIL_CONFIG);
}
