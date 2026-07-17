import { describe, it, expect } from 'vitest';
import { extractThumbnail, mapFeedItems } from './feedParser.js';

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
