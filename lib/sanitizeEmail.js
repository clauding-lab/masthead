import sanitizeHtml from 'sanitize-html';

// Email-tuned server sanitiser (spec §8.3). Newsletters need tables + inline
// styles; the style allowlist excludes every overlay/positioning vector.
const ALLOWED_STYLES = {
  '*': {
    color: [/^.*$/], 'background-color': [/^.*$/], background: [/^(?!.*url).*$/i],
    'font-family': [/^.*$/], 'font-size': [/^.*$/], 'font-weight': [/^.*$/],
    'font-style': [/^.*$/], 'line-height': [/^.*$/], 'letter-spacing': [/^.*$/],
    'text-align': [/^.*$/], 'text-decoration': [/^.*$/], 'text-transform': [/^.*$/],
    padding: [/^.*$/], 'padding-top': [/^.*$/], 'padding-right': [/^.*$/],
    'padding-bottom': [/^.*$/], 'padding-left': [/^.*$/],
    margin: [/^.*$/], 'margin-top': [/^.*$/], 'margin-right': [/^.*$/],
    'margin-bottom': [/^.*$/], 'margin-left': [/^.*$/],
    border: [/^.*$/], 'border-radius': [/^.*$/], 'border-collapse': [/^.*$/],
    width: [/^.*$/], 'max-width': [/^.*$/], height: [/^.*$/], display: [/^(?!none).*$/i],
    'vertical-align': [/^.*$/], 'white-space': [/^.*$/],
  },
};

const OPTIONS = {
  allowedTags: [
    ...sanitizeHtml.defaults.allowedTags,
    'img', 'figure', 'figcaption', 'picture', 'source', 'center',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  ],
  allowedAttributes: {
    '*': ['style'],
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'srcset', 'alt', 'width', 'height', 'loading'],
    source: ['srcset', 'type', 'media'],
    td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'],
  },
  allowedStyles: ALLOWED_STYLES,
  allowedSchemes: ['http', 'https'],
  disallowedTagsMode: 'discard',
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }),
  },
  exclusiveFilter(frame) {
    if (frame.tag !== 'img') return false;
    const w = parseInt(frame.attribs?.width, 10);
    const h = parseInt(frame.attribs?.height, 10);
    return (Number.isFinite(w) && w <= 2) || (Number.isFinite(h) && h <= 2); // tracker pixels
  },
};

export function sanitizeEmailHtml(html) {
  if (!html) return '';
  return sanitizeHtml(String(html).replace(/\0/g, ''), OPTIONS);
}
