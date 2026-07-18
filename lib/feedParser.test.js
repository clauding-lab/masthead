import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import Parser from 'rss-parser';
import { extractThumbnail, mapFeedItems, parserOptions } from './feedParser.js';

const SOURCE = { id: 's1', name: 'Src', shortName: 'S', color: '#000', category: 'world' };

describe('extractThumbnail', () => {
  it('reads single media:content object', () => {
    expect(extractThumbnail({ 'media:content': { $: { url: 'https://img/1.jpg' } } })).toBe('https://img/1.jpg');
  });
  it('reads first entry when media:content is an array', () => {
    expect(extractThumbnail({
      'media:content': [{ $: { url: 'https://img/a.jpg' } }, { $: { url: 'https://img/b.jpg' } }],
    })).toBe('https://img/a.jpg');
  });
  it('survives media:content without $', () => {
    expect(extractThumbnail({ 'media:content': {} })).toBeNull();
  });
  it('falls back to content <img>', () => {
    expect(extractThumbnail({ content: '<img src="https://img/c.jpg">' })).toBe('https://img/c.jpg');
  });
});

describe('mapFeedItems', () => {
  it('skips a poisoned item instead of dropping the whole feed', () => {
    const poisoned = new Proxy({}, { get: () => { throw new Error('boom'); } });
    const good = { title: 'ok', link: 'https://x.example/a', pubDate: '2026-01-01' };
    const result = mapFeedItems([good, poisoned], SOURCE);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('ok');
  });
  it('emits the shared 16-hex articleId and keeps guid-only items stable', () => {
    const item = { title: 'ok', link: 'https://x.example/a', pubDate: '2026-01-01' };
    const [mapped] = mapFeedItems([item], SOURCE);
    expect(mapped.id).toMatch(/^[0-9a-f]{16}$/);
    const guidOnly = { title: 'no link', guid: 'tag:site,2026:99' };
    const [g1] = mapFeedItems([guidOnly], SOURCE);
    const [g2] = mapFeedItems([guidOnly], SOURCE);
    expect(g1.id).toBe(g2.id);
  });
  it('drops an item with no link, guid, or title instead of inventing an id', () => {
    expect(mapFeedItems([{ pubDate: '2026-01-01' }], SOURCE)).toHaveLength(0);
  });
});

const SOCIAL_SOURCE = { id: 'verge-bsky', name: 'The Verge 🦋', shortName: 'TV', color: '#5100FF', category: 'tech' };

async function parseFixture(name) {
  const xml = readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');
  const feed = await new Parser(parserOptions).parseString(xml);
  return feed.items;
}

describe('social feed fixtures (2D spec §8)', () => {
  it('Bluesky posts get the post text as title, not Untitled', async () => {
    const items = await parseFixture('bluesky-rss.xml');
    const mapped = mapFeedItems(items, SOCIAL_SOURCE);
    expect(mapped.length).toBeGreaterThan(0);
    for (const m of mapped) {
      expect(m.title).not.toBe('Untitled');
      expect(m.title.length).toBeLessThanOrEqual(140);
      expect(m.id).toMatch(/^[0-9a-f]{16}$/);
      expect(m.url).toMatch(/^https:\/\/bsky\.app\//);
    }
  });
  it('Mastodon posts get text titles and keep their media thumbnail', async () => {
    const items = await parseFixture('mastodon-rss.xml');
    const mapped = mapFeedItems(items, { ...SOCIAL_SOURCE, id: 'ars-mastodon' });
    expect(mapped.length).toBeGreaterThan(0);
    expect(mapped[0].title).not.toBe('Untitled');
    expect(mapped[0].thumbnail).toMatch(/^https:\/\/files\.mastodon\.social\//);
  });
});
