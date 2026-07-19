import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./supabase', () => ({
  supabase: { auth: { getSession: vi.fn() } },
}));

import { supabase } from './supabase';
import {
  getAccessToken,
  listPremiumFeeds,
  addPremiumFeed,
  patchPremiumFeed,
  deletePremiumFeed,
  fetchPremiumBody,
} from './premiumApi';

const TOKEN = 'tok-abc123';

function mockFetchOnce(status, body) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
  globalThis.fetch = fn;
  return fn;
}

function mockFetchJsonFailure(status) {
  const fn = vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.reject(new Error('not json')),
  });
  globalThis.fetch = fn;
  return fn;
}

beforeEach(() => {
  supabase.auth.getSession.mockReset();
  supabase.auth.getSession.mockResolvedValue({ data: { session: { access_token: TOKEN } } });
});

describe('getAccessToken', () => {
  it('returns the access token from the current session', async () => {
    expect(await getAccessToken()).toBe(TOKEN);
  });

  it('returns null when there is no session', async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: null } });
    expect(await getAccessToken()).toBeNull();
  });
});

describe('authed requests', () => {
  it('listPremiumFeeds sends a GET with a bearer token and returns the feeds array', async () => {
    const fetchMock = mockFetchOnce(200, { feeds: [{ id: 'A' }] });
    const feeds = await listPremiumFeeds();
    expect(feeds).toEqual([{ id: 'A' }]);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/premium-feeds');
    expect(opts.method).toBe('GET');
    expect(opts.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('listPremiumFeeds returns [] when the server omits feeds', async () => {
    mockFetchOnce(200, {});
    expect(await listPremiumFeeds()).toEqual([]);
  });

  it('addPremiumFeed POSTs the input as the JSON body and returns the created row', async () => {
    const fetchMock = mockFetchOnce(201, { id: 'N', kind: 'news' });
    const input = { url: 'https://x.example/feed', kind: 'news', label: 'X', category: 'c' };
    const row = await addPremiumFeed(input);
    expect(row).toEqual({ id: 'N', kind: 'news' });
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual(input);
  });

  it('patchPremiumFeed PATCHes {id, ...patch} and returns the updated row', async () => {
    const fetchMock = mockFetchOnce(200, { id: 'A', label: 'new' });
    const row = await patchPremiumFeed('A', { label: 'new' });
    expect(row).toEqual({ id: 'A', label: 'new' });
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body)).toEqual({ id: 'A', label: 'new' });
  });

  it('deletePremiumFeed DELETEs {id} and returns the response', async () => {
    const fetchMock = mockFetchOnce(200, { deleted: true });
    const result = await deletePremiumFeed('A');
    expect(result).toEqual({ deleted: true });
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.method).toBe('DELETE');
    expect(JSON.parse(opts.body)).toEqual({ id: 'A' });
  });

  it('fetchPremiumBody GETs with url-encoded feed and article query params and returns the article', async () => {
    const fetchMock = mockFetchOnce(200, { article: { title: 'T', url: 'u', content: 'c' } });
    const article = await fetchPremiumBody('feed/1', 'article id');
    expect(article).toEqual({ title: 'T', url: 'u', content: 'c' });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/premium-feeds?feed=feed%2F1&article=article%20id');
  });

  it('throws with the server error string on a non-ok response', async () => {
    mockFetchOnce(409, { error: 'Already added' });
    await expect(addPremiumFeed({ url: 'https://x' })).rejects.toThrow('Already added');
  });

  it('throws a generic "Request failed" message when the error body is not JSON', async () => {
    mockFetchJsonFailure(500);
    await expect(listPremiumFeeds()).rejects.toThrow('Request failed: 500');
  });

  it('throws "Sign in required" and never calls fetch when there is no access token', async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: null } });
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    await expect(listPremiumFeeds()).rejects.toThrow('Sign in required');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
