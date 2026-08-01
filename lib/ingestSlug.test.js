import { describe, it, expect } from 'vitest';
import { generateSlug, INGEST_SLUG_WORDS } from './ingestSlug.js';

const SLUG_RE = /^[a-z]{3,12}-[a-z]{3,12}-[0-9a-f]{4}$/;
const WORD_RE = /^[a-z]{3,12}$/;

describe('INGEST_SLUG_WORDS', () => {
  it('has at least 150 entries', () => {
    expect(INGEST_SLUG_WORDS.length).toBeGreaterThanOrEqual(150);
  });

  it('every entry is lowercase letters, 3-12 chars', () => {
    for (const word of INGEST_SLUG_WORDS) {
      expect(word, word).toMatch(WORD_RE);
    }
  });
});

describe('generateSlug', () => {
  it('produces the word-word-hex4 format across 200 samples', () => {
    for (let i = 0; i < 200; i++) {
      const slug = generateSlug();
      expect(slug, slug).toMatch(SLUG_RE);
    }
  });

  it('is deterministic when randomFn is injected', () => {
    const fixedBytes = Buffer.from([0x00, 0x00, 0x00, 0x01, 0xab, 0xcd]);
    const randomFn = () => fixedBytes;
    const first = generateSlug(randomFn);
    const second = generateSlug(randomFn);
    expect(first).toBe(second);
    expect(first).toMatch(SLUG_RE);
    expect(first.endsWith('-abcd')).toBe(true);
  });

  it('different injected bytes yield different words/hex', () => {
    const a = generateSlug(() => Buffer.from([0x00, 0x00, 0x00, 0x01, 0x00, 0x00]));
    const b = generateSlug(() => Buffer.from([0x00, 0x05, 0x00, 0x09, 0xff, 0xff]));
    expect(a).not.toBe(b);
  });
});
