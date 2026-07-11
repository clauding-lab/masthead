import { describe, it, expect } from 'vitest';
import { checkRateLimit } from './rateLimit.js';

describe('checkRateLimit (in-memory fallback)', () => {
  it('allows up to the limit within a window, then blocks', async () => {
    const key = `test-${Math.random()}`;
    for (let i = 0; i < 5; i++) {
      expect((await checkRateLimit(key, { limit: 5, windowSec: 60 })).allowed).toBe(true);
    }
    expect((await checkRateLimit(key, { limit: 5, windowSec: 60 })).allowed).toBe(false);
  });

  it('tracks keys independently', async () => {
    const a = `a-${Math.random()}`;
    const b = `b-${Math.random()}`;
    await checkRateLimit(a, { limit: 1, windowSec: 60 });
    expect((await checkRateLimit(b, { limit: 1, windowSec: 60 })).allowed).toBe(true);
  });
});
