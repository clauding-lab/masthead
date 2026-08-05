// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { sanitizeArticleHtml, sanitizeEmailHtml } from './sanitize.js';

describe('sanitizeArticleHtml', () => {
  it.each([
    ['<img src=x onerror="alert(1)">', 'onerror'],
    ['<p onclick="alert(1)">hi</p>', 'onclick'],
    ['<script>alert(1)</script><p>hi</p>', '<script'],
    ['<iframe src="https://evil.example"></iframe>', '<iframe'],
    ['<a href="javascript:alert(1)">x</a>', 'javascript:'],
    ['<svg><script>alert(1)</script></svg>', '<script'],
    ['<form action="https://evil.example"><input></form>', '<form'],
  ])('neutralizes %s', (payload, marker) => {
    expect(sanitizeArticleHtml(payload)).not.toContain(marker);
  });

  it('keeps normal article markup', () => {
    const html = '<p>Hello <strong>world</strong></p><figure><img src="https://cdn.example/x.jpg" alt=""><figcaption>cap</figcaption></figure>';
    const out = sanitizeArticleHtml(html);
    expect(out).toContain('<strong>world</strong>');
    expect(out).toContain('src="https://cdn.example/x.jpg"');
  });

  it('returns empty string for null/undefined', () => {
    expect(sanitizeArticleHtml(null)).toBe('');
    expect(sanitizeArticleHtml(undefined)).toBe('');
  });

  // Task 16 pin: the style ATTRIBUTE must NOT survive the article profile —
  // pinned from both directions alongside sanitizeEmailHtml's pin below so a
  // shared-config regression (accidentally dropping 'style' from
  // sanitizeArticleHtml's FORBID_ATTR, or accidentally adding it back) shows
  // up as a failure on exactly one side.
  it('strips the style attribute (article profile keeps FORBID_ATTR: style)', () => {
    const out = sanitizeArticleHtml('<p style="color:red">hi</p>');
    expect(out).not.toContain('style=');
  });
});

describe('sanitizeEmailHtml', () => {
  it.each([
    ['<img src=x onerror="alert(1)">', 'onerror'],
    ['<p onclick="alert(1)">hi</p>', 'onclick'],
    ['<script>alert(1)</script><p>hi</p>', '<script'],
    ['<iframe src="https://evil.example"></iframe>', '<iframe'],
    ['<object data="https://evil.example"></object>', '<object'],
    ['<embed src="https://evil.example">', '<embed'],
    ['<form action="https://evil.example"><input></form>', '<form'],
    ['<button onclick="x()">go</button>', '<button'],
    ['<a href="javascript:alert(1)">x</a>', 'javascript:'],
    ['<svg><script>alert(1)</script></svg>', '<script'],
    ['<math><mtext>x</mtext></math>', '<math'],
  ])('neutralizes %s', (payload, marker) => {
    expect(sanitizeEmailHtml(payload)).not.toContain(marker);
  });

  // F2 (Opus fix round 1): a TOP-LEVEL `<style>...</style><p>hi</p>` passes
  // `.not.toContain('<style')` for the WRONG reason — the HTML parser hoists
  // a leading <style> (before any other body content) into an implicit
  // <head>, and DOMPurify's serialized output only reflects body content, so
  // the tag "disappears" as a position artifact, not because FORBID_TAGS
  // actually excluded it. A NESTED `<style>` (inside a <div>, forcing normal
  // "in body" flow — never hoisted) is the only fixture that genuinely
  // exercises the policy: without 'style' in EMAIL_CONFIG.FORBID_TAGS, this
  // survives and lets a newsletter inject document-wide CSS, including a
  // url() background beacon.
  it('forbids a NESTED style element, not just a top-level one', () => {
    const out = sanitizeEmailHtml('<div><style>body{display:none}</style><p>hi</p></div>');
    expect(out).not.toContain('<style');
    expect(out).not.toContain('display:none');
  });

  // The core Task 16 spec pin: the style ATTRIBUTE (not element) survives
  // the email profile — newsletters are table-and-inline-style HTML and go
  // unreadable without it — while sanitizeArticleHtml (above) keeps
  // stripping it. Both pinned in this one file so the two profiles can
  // never silently converge back onto a single shared config.
  it('keeps the style attribute (email profile omits FORBID_ATTR: style)', () => {
    const out = sanitizeEmailHtml('<p style="color:red">hi</p>');
    expect(out).toContain('style="color:red"');
  });

  it('keeps tables — the reason the email profile needs a separate config from the article one', () => {
    const out = sanitizeEmailHtml('<table><tr><td style="padding:8px">x</td></tr></table>');
    expect(out).toContain('<table>');
    expect(out).toContain('<td');
  });

  it('adds target/rel/loading to the allowed-attribute set (ADD_ATTR)', () => {
    const out = sanitizeEmailHtml('<a href="https://x.test" target="_blank" rel="noopener noreferrer">x</a><img src="https://x.test/a.jpg" loading="lazy">');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('loading="lazy"');
  });

  it('returns empty string for null/undefined', () => {
    expect(sanitizeEmailHtml(null)).toBe('');
    expect(sanitizeEmailHtml(undefined)).toBe('');
  });
});
