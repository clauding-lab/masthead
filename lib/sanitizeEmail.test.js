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
  ])('strips XSS vector %#', (input, marker) => {
    expect(sanitizeEmailHtml(input)).not.toContain(marker);
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
});
