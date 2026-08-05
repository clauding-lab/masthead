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
// stripping. The `style` ELEMENT stays forbidden either way — an allowed
// style attribute is scoped per-node; an allowed <style> element is a global
// CSS injection vector that could reach outside the message body.
const EMAIL_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['iframe', 'object', 'embed', 'form', 'input', 'button', 'svg', 'math'],
  ADD_ATTR: ['target', 'rel', 'loading'],
};

export function sanitizeEmailHtml(html) {
  if (!html) return '';
  return DOMPurify.sanitize(html, EMAIL_CONFIG);
}
