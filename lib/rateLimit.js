import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

const memoryHits = new Map();
const limiters = new Map();

function hasUpstash() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

function getUpstashLimiter(limit, windowSec) {
  const cacheKey = `${limit}:${windowSec}`;
  if (!limiters.has(cacheKey)) {
    limiters.set(
      cacheKey,
      new Ratelimit({
        redis: Redis.fromEnv(),
        limiter: Ratelimit.slidingWindow(limit, `${windowSec} s`),
        prefix: 'masthead-rl',
      })
    );
  }
  return limiters.get(cacheKey);
}

function memoryCheck(key, limit, windowSec) {
  const now = Date.now();
  const windowStart = now - windowSec * 1000;
  const hits = (memoryHits.get(key) || []).filter((t) => t > windowStart);
  if (hits.length >= limit) {
    memoryHits.set(key, hits);
    return { allowed: false };
  }
  memoryHits.set(key, [...hits, now]);
  return { allowed: true };
}

export async function checkRateLimit(key, { limit = 20, windowSec = 60 } = {}) {
  if (hasUpstash()) {
    try {
      const { success } = await getUpstashLimiter(limit, windowSec).limit(key);
      return { allowed: success };
    } catch (err) {
      console.error('Rate limit backend error (failing open):', err.message);
      return { allowed: true };
    }
  }
  return memoryCheck(key, limit, windowSec);
}
