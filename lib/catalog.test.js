// lib/catalog.test.js
// Structural gate for lib/sources.json (2D spec §8). No network — the
// live-feed check is scripts/verify-catalog.mjs, run manually.
import { describe, it, expect } from 'vitest';
import catalog from './sources.json';

const REQUIRED = ['id', 'name', 'shortName', 'url', 'feedUrl', 'feedType', 'category', 'color'];
const KINDS = [undefined, 'news', 'blog', 'social'];

describe('catalog structure', () => {
  it('has 36 sources (2D slate)', () => {
    expect(catalog.sources).toHaveLength(36);
  });
  it('ids are unique', () => {
    const ids = catalog.sources.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('every source has the required fields', () => {
    for (const s of catalog.sources) {
      for (const f of REQUIRED) expect(s[f], `${s.id}.${f}`).toBeTruthy();
    }
  });
  it('kind, when present, is news|blog|social', () => {
    for (const s of catalog.sources) expect(KINDS, s.id).toContain(s.kind);
  });
  it('categories are single lowercase words', () => {
    for (const s of catalog.sources) expect(s.category, s.id).toMatch(/^[a-z]+$/);
  });
  it('feed URLs are well-formed https', () => {
    for (const s of catalog.sources) {
      expect(() => new URL(s.feedUrl), s.id).not.toThrow();
      expect(s.feedUrl.startsWith('https://'), s.id).toBe(true);
    }
  });
  it('aliases never collide with a live id or another alias', () => {
    const liveIds = new Set(catalog.sources.map((s) => s.id));
    const seenAliases = new Set();
    for (const s of catalog.sources) {
      for (const a of s.aliases ?? []) {
        expect(liveIds.has(a), `alias ${a} shadows a live id`).toBe(false);
        expect(seenAliases.has(a), `alias ${a} duplicated`).toBe(false);
        seenAliases.add(a);
      }
    }
  });
  it('the (unconsumed) categories array does not contradict itself', () => {
    const ids = catalog.categories.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z]+$/);
  });
  it('the slate has the expected kind counts (15 news / 15 blog / 6 social)', () => {
    const kind = (s) => s.kind ?? 'news';
    expect(catalog.sources.filter((s) => kind(s) === 'news')).toHaveLength(15);
    expect(catalog.sources.filter((s) => kind(s) === 'blog')).toHaveLength(15);
    expect(catalog.sources.filter((s) => kind(s) === 'social')).toHaveLength(6);
  });
});
