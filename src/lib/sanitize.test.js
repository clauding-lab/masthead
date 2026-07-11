// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { sanitizeArticleHtml } from './sanitize.js';

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
});
