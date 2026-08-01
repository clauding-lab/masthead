// lib/inboxSize.js — the ONLY producer of a byte figure in the inbox slice.
// Postgres length() counts characters; JS .length counts UTF-16 units.
// Anything named *bytes* must come from here (spec §5.1).
export function messageBytes(html, text) {
  return Buffer.byteLength(html ?? '', 'utf8') + Buffer.byteLength(text ?? '', 'utf8');
}
