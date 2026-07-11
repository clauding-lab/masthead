import sanitizeHtml from 'sanitize-html';

const OPTIONS = {
  allowedTags: [
    ...sanitizeHtml.defaults.allowedTags,
    'img', 'figure', 'figcaption', 'picture', 'source',
  ],
  allowedAttributes: {
    a: ['href', 'title'],
    img: ['src', 'srcset', 'alt', 'width', 'height', 'loading'],
    source: ['srcset', 'type', 'media'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  disallowedTagsMode: 'discard',
};

export function sanitizeExtractedHtml(html) {
  if (!html) return '';
  return sanitizeHtml(html, OPTIONS);
}
