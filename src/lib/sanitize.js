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
