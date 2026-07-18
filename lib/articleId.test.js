import { describe, it, expect } from 'vitest';
import { canonicalizeUrl, articleId } from './articleId.js';

describe('canonicalizeUrl', () => {
  it('returns null on empty, junk, and non-http(s) input instead of throwing', () => {
    expect(canonicalizeUrl('')).toBeNull();
    expect(canonicalizeUrl(null)).toBeNull();
    expect(canonicalizeUrl('not a url')).toBeNull();
    expect(canonicalizeUrl('tag:blogger.com,1999:blog-123.post-456')).toBeNull();
  });
  it('is stable across scheme, www, trailing slash, and param order', () => {
    const a = canonicalizeUrl('http://www.example.com/story/?b=2&a=1');
    expect(a).toBe(canonicalizeUrl('https://example.com/story?a=1&b=2'));
  });
  it('strips tracking params but keeps meaningful ones', () => {
    expect(canonicalizeUrl('https://x.com/p?utm_source=t&fbclid=z&id=7'))
      .toBe(canonicalizeUrl('https://x.com/p?id=7'));
    expect(canonicalizeUrl('https://x.com/p?id=7'))
      .not.toBe(canonicalizeUrl('https://x.com/p?id=8'));
  });
});

describe('articleId', () => {
  it('is total: never throws, null only when no key exists', () => {
    expect(articleId({})).toBeNull();
    expect(articleId(null)).toBeNull();
    expect(articleId({ guid: '', title: '' })).toBeNull();
    expect(typeof articleId({ guid: 'tag:site,2026:1' })).toBe('string');
    expect(typeof articleId({ title: 'Only a title' })).toBe('string');
  });
  it('gives two different link-less items two different ids', () => {
    expect(articleId({ guid: 'g-1' })).not.toBe(articleId({ guid: 'g-2' }));
  });
  it('returns a 16-hex id, identical for url-variant inputs, and accepts a bare string', () => {
    const id = articleId({ link: 'https://www.example.com/a/' });
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(id).toBe(articleId('http://example.com/a'));
  });
  it('prefers link over guid over title', () => {
    const linked = articleId({ link: 'https://x.com/a', guid: 'g', title: 't' });
    expect(linked).toBe(articleId({ link: 'https://x.com/a' }));
    expect(articleId({ guid: 'g', title: 't' })).toBe(articleId({ guid: 'g' }));
  });
});
