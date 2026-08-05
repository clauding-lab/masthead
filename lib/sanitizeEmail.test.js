import { describe, it, expect } from 'vitest';
import { sanitizeEmailHtml } from './sanitizeEmail.js';

describe('sanitizeEmailHtml', () => {
  it.each([
    ['<script>alert(1)</script><p>hi</p>', 'script'],
    ['<p onclick="x()">hi</p>', 'onclick'],
    ['<iframe src="https://x.test"></iframe>', 'iframe'],
    ['<form action="https://x.test"><input name="a"></form>', 'form'],
    ['<a href="javascript:alert(1)">x</a>', 'javascript:'],
    ['<img src="cid:part1">', 'cid:'],
    ['<svg onload="x()"></svg>', 'svg'],
    ['<img src="https://a.test/x.jpg" srcset="cid:p1 1x">', 'cid:'],
  ])('strips XSS vector %#', (input, marker) => {
    expect(sanitizeEmailHtml(input)).not.toContain(marker);
  });

  // Not a plain it.each marker row: 'rel="noopener noreferrer"' itself contains
  // the substring 'opener', so a bare `not.toContain('opener')` would always
  // fail regardless of whether the attacker-supplied rel="opener" survived.
  // Needs the precise assertion below to actually pin the override.
  it('overwrites an attacker-supplied rel, not just missing rel', () => {
    const out = sanitizeEmailHtml('<a href="https://x.test" rel="opener">x</a>');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).not.toContain('rel="opener"');
  });

  it('keeps tables and allowlisted inline styles', () => {
    const out = sanitizeEmailHtml(
      '<table><tr><td style="color:#333;font-size:14px;padding:8px">x</td></tr></table>');
    expect(out).toContain('<table>');
    expect(out).toContain('color');
    expect(out).toContain('font-size');
  });
  it('strips overlay-capable style properties, keeps benign ones', () => {
    const out = sanitizeEmailHtml('<div style="position:fixed;z-index:9999;color:red">x</div>');
    expect(out).not.toContain('position');
    expect(out).not.toContain('z-index');
    expect(out).toContain('color');
  });
  it('strips tracker pixels (declared dims <= 2) but keeps real images', () => {
    const out = sanitizeEmailHtml(
      '<img src="https://t.test/p.gif" width="1" height="1"><img src="https://t.test/photo.jpg" width="600" height="400">');
    expect(out).not.toContain('p.gif');
    expect(out).toContain('photo.jpg');
  });
  it('strips tracker pixels declared via style= as well as width/height attrs', () => {
    const out = sanitizeEmailHtml(
      '<img src="https://t.test/p.gif" style="width:1px;height:1px">' +
      '<img src="https://t.test/photo.jpg" style="width:600px;height:400px">');
    expect(out).not.toContain('p.gif');
    expect(out).toContain('photo.jpg');
  });
  it('strips a CSS-escaped url() smuggled through the background property', () => {
    // \75 rl(...) is the CSS-escaped form of url(...) — browsers decode the
    // escape before parsing, so a literal-substring "url" check alone misses it.
    const out = sanitizeEmailHtml('<div style="background:\\75 rl(https://t.test/beacon.gif)">x</div>');
    expect(out).not.toContain('beacon.gif');
    expect(out).not.toContain('background');
  });
  it('strips a CSS-escaped none smuggled through the display property', () => {
    // \6e one is the CSS-escaped form of none.
    const out = sanitizeEmailHtml('<div style="display:\\6e one">x</div>');
    expect(out).not.toContain('display');
  });
  it('forces link target+rel', () => {
    const out = sanitizeEmailHtml('<a href="https://x.test/a">x</a>');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('noopener');
  });
  it('strips NUL characters (Postgres rejects them)', () => {
    expect(sanitizeEmailHtml('a\0b')).not.toContain('\0');
  });
  it('returns empty string for null/empty input', () => {
    expect(sanitizeEmailHtml(null)).toBe('');
  });

  // Ruling 1 (Opus fix round 1, Task 16): the client's `style` ATTRIBUTE
  // allowance (src/lib/sanitize.js#sanitizeEmailHtml) means a newsletter
  // could try to fetch a remote image via any of five CSS properties that
  // accept url(...): background-image, background, list-style-image,
  // border-image, cursor. The client does NOT parse CSS values — this
  // vector is closed HERE, at the only path that writes html_body:
  // ALLOWED_STYLES either omits the property entirely (stripped
  // unconditionally, any value) or — for `background` — restricts it to
  // SAFE_NO_URL (which rejects any value containing "url("). These tests
  // pin that closure directly against the current unchanged config.
  describe('Ruling 1 — the five url()-capable style properties never survive', () => {
    it.each([
      ['background-image', 'background-image:url(https://t.test/beacon.gif)'],
      ['background', 'background:url(https://t.test/beacon.gif)'],
      ['list-style-image', 'list-style-image:url(https://t.test/beacon.gif)'],
      ['border-image', 'border-image:url(https://t.test/beacon.gif) 30 fill'],
      ['cursor', 'cursor:url(https://t.test/beacon.gif),pointer'],
    ])('strips %s entirely', (_label, styleValue) => {
      const out = sanitizeEmailHtml(`<div style="${styleValue}">x</div>`);
      expect(out).not.toContain('beacon.gif');
    });
  });
});
