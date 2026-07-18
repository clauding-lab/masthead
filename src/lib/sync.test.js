// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const upsertCalls = [];
const updateCalls = [];
let cloudRows = [];

vi.mock('./supabase', () => ({
  supabase: {
    from: (table) => ({
      select: () => ({ eq: () => Promise.resolve({ data: table === 'user_saved_articles' ? cloudRows : [] }) }),
      upsert: (rows, opts) => { upsertCalls.push({ table, rows, opts }); return Promise.resolve({ error: null }); },
      update: (patch) => ({ eq: () => ({ eq: () => { updateCalls.push({ table, patch }); return Promise.resolve({ error: null }); } }) }),
      delete: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
    }),
  },
}));

import { buildSourceRows, pushSaved, removeSaved, syncOnSignIn } from './sync.js';
import { saveFavorite, getFavorite } from './db.js';
import sourcesData from '../../lib/sources.json';

const LOCAL = (over = {}) => ({
  id: 'a'.repeat(16), url: 'https://x.example/a', title: 'T', excerpt: 'e',
  content: '<p>body</p>', contentTruncated: false, leadImage: null, wordCount: 5,
  sourceId: 's1', sourceName: 'S', sourceColor: '#000', isPaywall: false,
  savedAt: '2026-07-01T00:00:00.000Z', updatedAtLocal: '2026-07-02T00:00:00.000Z', ...over,
});
const CLOUD = (over = {}) => ({
  article_id: 'a'.repeat(16), url: 'https://x.example/a', title: 'T', byline: null, excerpt: 'e',
  content: '<p>cloud</p>', content_truncated: false, lead_image: null, word_count: 5,
  source_id: 's1', source_name: 'S', source_color: '#000', is_paywall: false,
  saved_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T12:00:00.000Z', deleted_at: null, ...over,
});

beforeEach(() => { upsertCalls.length = 0; updateCalls.length = 0; cloudRows = []; });

describe('buildSourceRows (unchanged)', () => {
  it('maps only the selected known source ids to user_sources rows', () => {
    const first = sourcesData.sources[0];
    const rows = buildSourceRows('user-1', [first.id, 'nonexistent-id']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: 'user-1', source_id: first.id, name: first.name });
  });
});

describe('pushSaved', () => {
  it('sends the full row for a body-bearing record, with updated_at + deleted_at null', async () => {
    await pushSaved('u1', LOCAL());
    const { table, rows } = upsertCalls[0];
    expect(table).toBe('user_saved_articles');
    expect(rows.content).toBe('<p>body</p>');
    expect(rows.deleted_at).toBeNull();
    expect(typeof rows.updated_at).toBe('string');
  });
  it('OMITS content columns for a shell so ON CONFLICT can never null a stored body', async () => {
    await pushSaved('u1', LOCAL({ content: null }));
    const { rows } = upsertCalls[0];
    expect('content' in rows).toBe(false);
    expect('content_truncated' in rows).toBe(false);
    expect(rows.title).toBe('T');
  });
  it('skips link-less records entirely — the url CHECK would reject them', async () => {
    await pushSaved('u1', LOCAL({ url: '' }));
    expect(upsertCalls).toHaveLength(0);
  });
  it('clamps oversized sibling text fields to the DB size checks', async () => {
    await pushSaved('u1', LOCAL({ excerpt: 'x'.repeat(20000), title: 'y'.repeat(5000) }));
    const { rows } = upsertCalls[0];
    expect(rows.excerpt).toHaveLength(10000);
    expect(rows.title).toHaveLength(2000);
  });
});

describe('removeSaved', () => {
  it('tombstones via upsert (deleted_at set) when the record has an http(s) url', async () => {
    await removeSaved('u1', { id: 'x'.repeat(16), url: 'https://x.example/a' });
    const { rows } = upsertCalls[0];
    expect(typeof rows.deleted_at).toBe('string');
    expect(rows.article_id).toBe('x'.repeat(16));
  });
  it('falls back to update-only for a link-less record', async () => {
    await removeSaved('u1', { id: 'y'.repeat(16), url: '' });
    expect(upsertCalls).toHaveLength(0);
    expect(typeof updateCalls[0].patch.deleted_at).toBe('string');
  });
});

describe('syncOnSignIn three-pass merge', () => {
  it('pass 1: a cloud tombstone removes the local copy and is never re-pushed', async () => {
    await saveFavorite(LOCAL({ id: 'd'.repeat(16), url: 'https://x.example/del' }));
    cloudRows = [CLOUD({ article_id: 'd'.repeat(16), url: 'https://x.example/del', deleted_at: '2026-07-03T00:00:00.000Z' })];
    await syncOnSignIn('u1');
    expect(await getFavorite('d'.repeat(16))).toBeUndefined();
    for (const c of upsertCalls) {
      const arr = Array.isArray(c.rows) ? c.rows : [c.rows];
      expect(arr.some((r) => r.article_id === 'd'.repeat(16))).toBe(false);
    }
  });
  it('pass 2: pushes local-only records up and pulls live cloud-only records down', async () => {
    await saveFavorite(LOCAL({ id: 'l'.repeat(16), url: 'https://x.example/local' }));
    cloudRows = [CLOUD({ article_id: 'c'.repeat(16), url: 'https://x.example/cloud' })];
    await syncOnSignIn('u1');
    const pushed = upsertCalls.flatMap((c) => (Array.isArray(c.rows) ? c.rows : [c.rows]));
    expect(pushed.some((r) => r.article_id === 'l'.repeat(16))).toBe(true);
    const pulled = await getFavorite('c'.repeat(16));
    expect(pulled.content).toBe('<p>cloud</p>');
    expect(pulled.isFavorite).toBe(true);
  });
  it('pass 2: one link-less record cannot poison the upload batch — it is skipped, the rest upload', async () => {
    await saveFavorite(LOCAL({ id: 'g'.repeat(16), url: 'https://x.example/good' }));
    await saveFavorite(LOCAL({ id: 'z'.repeat(16), url: '' })); // link-less heart
    await syncOnSignIn('u1');
    const pushed = upsertCalls.flatMap((c) => (Array.isArray(c.rows) ? c.rows : [c.rows]));
    expect(pushed.some((r) => r.article_id === 'g'.repeat(16))).toBe(true);
    expect(pushed.some((r) => r.article_id === 'z'.repeat(16))).toBe(false);
  });
  it('pass 3: body beats shell in BOTH directions', async () => {
    await saveFavorite(LOCAL({ id: 'b'.repeat(16), url: 'https://x.example/b' })); // local body
    await saveFavorite(LOCAL({ id: 'e'.repeat(16), url: 'https://x.example/e', content: null })); // local shell
    cloudRows = [
      CLOUD({ article_id: 'b'.repeat(16), url: 'https://x.example/b', content: null }), // cloud shell
      CLOUD({ article_id: 'e'.repeat(16), url: 'https://x.example/e' }), // cloud body
    ];
    await syncOnSignIn('u1');
    const pushed = upsertCalls.flatMap((c) => (Array.isArray(c.rows) ? c.rows : [c.rows]));
    expect(pushed.some((r) => r.article_id === 'b'.repeat(16) && r.content === '<p>body</p>')).toBe(true);
    const upgraded = await getFavorite('e'.repeat(16));
    expect(upgraded.content).toBe('<p>cloud</p>');
    expect(upgraded.bodyFailed).toBe(false);
  });
  it('pass 3: two bodies → newer updated_at wins (cloud newer pulls down)', async () => {
    await saveFavorite(LOCAL({ id: 'n'.repeat(16), url: 'https://x.example/n', updatedAtLocal: '2026-07-01T00:00:00.000Z' }));
    cloudRows = [CLOUD({ article_id: 'n'.repeat(16), url: 'https://x.example/n', content: '<p>newer</p>', updated_at: '2026-07-05T00:00:00.000Z' })];
    await syncOnSignIn('u1');
    const local = await getFavorite('n'.repeat(16));
    expect(local.content).toBe('<p>newer</p>');
  });
});
