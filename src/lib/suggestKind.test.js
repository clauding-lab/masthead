// src/lib/suggestKind.test.js
import { describe, it, expect } from 'vitest';
import { suggestKind } from './suggestKind';

describe('suggestKind (2D spec §4.5)', () => {
  it.each([
    ['https://stratechery.substack.com/feed', 'blog'],
    ['sub.example.beehiiv.com', 'blog'],
    ['https://medium.com/@someone', 'blog'],
    ['https://ghost.io/blog', 'blog'],
    ['https://buttondown.email/writer', 'blog'],
    ['https://reuters.com', 'news'],
    ['https://notsubstack.com', 'news'],
    ['', 'news'],
    ['not a url at all %%%', 'news'],
  ])('%s → %s', (input, expected) => {
    expect(suggestKind(input)).toBe(expected);
  });
});
