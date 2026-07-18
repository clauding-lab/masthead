// lib/catalogIndex.test.js
import { describe, it, expect } from 'vitest';
import { buildCatalogIndex } from './catalogIndex.js';

const CATALOG = {
  sources: [
    { id: 'new-slug', name: 'A', aliases: ['old-slug', 'older-slug'] },
    { id: 'plain', name: 'B' },
    { id: 'taken', name: 'C', aliases: ['plain'] }, // collision: live id must win
  ],
};

describe('buildCatalogIndex', () => {
  const idx = buildCatalogIndex(CATALOG);
  it('resolves a canonical id to itself', () => {
    expect(idx.canonicalId('new-slug')).toBe('new-slug');
  });
  it('resolves an alias to its canonical id', () => {
    expect(idx.canonicalId('old-slug')).toBe('new-slug');
    expect(idx.canonicalId('older-slug')).toBe('new-slug');
  });
  it('returns null for an unknown id', () => {
    expect(idx.canonicalId('nope')).toBeNull();
  });
  it('a live id always beats an alias claiming it', () => {
    expect(idx.canonicalId('plain')).toBe('plain');
  });
  it('has() covers live ids and aliases', () => {
    expect(idx.has('old-slug')).toBe(true);
    expect(idx.has('nope')).toBe(false);
  });
});
