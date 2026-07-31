import sanitizeHtml from 'sanitize-html';

// Email-tuned server sanitiser (spec §8.3). Newsletters need tables + inline
// styles; the style allowlist excludes every overlay/positioning vector.
//
// CSS escape sequences resolve *before* a browser interprets keywords/functions,
// so a backslash anywhere in a style value can smuggle content the regex below
// never literally sees (`\75 rl(...)` renders as `url(...)`; `\6e one` renders as
// `none`). Newsletter inline styles have no legitimate use for CSS escapes, so
// every property rejects a value containing a backslash, full stop — not just
// the properties that also need a `url(`/`none` keyword guard.
const SAFE = /^(?!.*\\).*$/;
const SAFE_NO_URL = /^(?!.*\\)(?!.*url\().*$/i; // color-family: also no url() (background image beacon)
const SAFE_NOT_NONE = /^(?!.*\\)(?!none).*$/i; // display: also no display:none (content-hiding)

const ALLOWED_STYLES = {
  '*': {
    color: [SAFE_NO_URL], 'background-color': [SAFE_NO_URL], background: [SAFE_NO_URL],
    'font-family': [SAFE], 'font-size': [SAFE], 'font-weight': [SAFE],
    'font-style': [SAFE], 'line-height': [SAFE], 'letter-spacing': [SAFE],
    'text-align': [SAFE], 'text-decoration': [SAFE], 'text-transform': [SAFE],
    padding: [SAFE], 'padding-top': [SAFE], 'padding-right': [SAFE],
    'padding-bottom': [SAFE], 'padding-left': [SAFE],
    margin: [SAFE], 'margin-top': [SAFE], 'margin-right': [SAFE],
    'margin-bottom': [SAFE], 'margin-left': [SAFE],
    border: [SAFE], 'border-radius': [SAFE], 'border-collapse': [SAFE],
    width: [SAFE], 'max-width': [SAFE], height: [SAFE], display: [SAFE_NOT_NONE],
    'vertical-align': [SAFE], 'white-space': [SAFE],
  },
};

// Declared px dimension for `prop` (width/height) inside a raw `style="..."`
// attribute value, or NaN if absent/not a plain px value. Used by the tracker-
// pixel check below since exclusiveFilter must catch dimensions set via style=
// as well as the width/height attributes.
function stylePx(styleAttr, prop) {
  const match = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([0-9.]+)px`, 'i').exec(styleAttr || '');
  return match ? parseFloat(match[1]) : NaN;
}

const OPTIONS = {
  allowedTags: [
    // table/thead/tbody/tfoot/tr/td/th are already in sanitizeHtml.defaults
    // .allowedTags (probe-confirmed against v2.17.5) — not re-listed here,
    // since doing so would be a no-op that misstates what this config adds
    // on top of the defaults.
    ...sanitizeHtml.defaults.allowedTags,
    'img', 'figure', 'figcaption', 'picture', 'source', 'center',
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
    if ((Number.isFinite(w) && w <= 2) || (Number.isFinite(h) && h <= 2)) return true; // tracker pixels (attrs)
    const styleAttr = frame.attribs?.style;
    const sw = stylePx(styleAttr, 'width');
    const sh = stylePx(styleAttr, 'height');
    return (Number.isFinite(sw) && sw <= 2) || (Number.isFinite(sh) && sh <= 2); // tracker pixels (style=)
  },
};

export function sanitizeEmailHtml(html) {
  if (!html) return '';
  return sanitizeHtml(String(html).replace(/\0/g, ''), OPTIONS);
}
