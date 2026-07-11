import { describe, it, expect, vi } from 'vitest';
import { isPrivateAddress, assertPublicUrl, safeFetch, UrlGuardError } from './urlGuard.js';

const publicLookup = vi.fn(async () => ({ address: '93.184.216.34', family: 4 }));
const privateLookup = vi.fn(async () => ({ address: '10.0.0.5', family: 4 }));

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fe80::1', 'fd12::1',
    '::ffff:127.0.0.1', 'not-an-ip',
  ])('treats %s as private/unroutable', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(['93.184.216.34', '8.8.8.8', '2606:2800:220:1:248:1893:25c8:1946'])(
    'treats %s as public', (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    });
});

describe('assertPublicUrl', () => {
  it.each([
    'file:///etc/passwd', 'ftp://example.com/x', 'javascript:alert(1)',
  ])('rejects non-http(s) scheme: %s', async (url) => {
    await expect(assertPublicUrl(url)).rejects.toThrow(UrlGuardError);
  });

  it.each([
    'http://localhost/x', 'http://127.0.0.1/x', 'http://[::1]/x',
    'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/x',
    'http://metadata.internal/x', 'http://printer.local/x',
  ])('rejects internal target: %s', async (url) => {
    await expect(assertPublicUrl(url, { lookup: publicLookup })).rejects.toThrow(UrlGuardError);
  });

  it('rejects a hostname that resolves to a private address', async () => {
    await expect(assertPublicUrl('https://evil.example.com/', { lookup: privateLookup }))
      .rejects.toThrow(UrlGuardError);
  });

  it('accepts a hostname that resolves publicly', async () => {
    const url = await assertPublicUrl('https://example.com/feed', { lookup: publicLookup });
    expect(url.href).toBe('https://example.com/feed');
  });
});

describe('safeFetch', () => {
  it('re-validates redirect hops and rejects redirect into private space', async () => {
    const redirectRes = {
      status: 302,
      headers: new Headers({ location: 'http://169.254.169.254/steal' }),
    };
    vi.stubGlobal('fetch', vi.fn(async () => redirectRes));
    await expect(safeFetch('https://example.com/', { lookup: publicLookup }))
      .rejects.toThrow(UrlGuardError);
    vi.unstubAllGlobals();
  });

  it('caps body size via text()', async () => {
    const big = new Uint8Array(2048).fill(65);
    const res = {
      status: 200,
      headers: new Headers(),
      body: new ReadableStream({
        start(c) { c.enqueue(big); c.close(); },
      }),
    };
    vi.stubGlobal('fetch', vi.fn(async () => res));
    const { text } = await safeFetch('https://example.com/', { lookup: publicLookup, maxBytes: 1024 });
    await expect(text()).rejects.toThrow(UrlGuardError);
    vi.unstubAllGlobals();
  });
});
