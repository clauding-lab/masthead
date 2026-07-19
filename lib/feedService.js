import { createRequire } from 'module';
import { fetchAllFeeds } from './feedParser.js';
import { selectHeadlines, storeIsWarm } from './articlesRepo.js';
import { buildCatalogIndex } from './catalogIndex.js';
import { resolvePremiumSources, fetchPremiumHeadlines } from './premiumService.js';

const require = createRequire(import.meta.url);
const catalog = require('./sources.json');
const defaultIndex = buildCatalogIndex(catalog);

const MAX_STORE_LIMIT = 200;
const FALLBACK_TTL_MS = 2 * 60 * 1000;
const ZERO_STATS = { total: 0, succeeded: 0, failed: 0 };

// Single-flight cached live fallback (spec §5.2 step 5): one fan-out per warm
// instance per TTL during a cold window or store outage — no thundering herd.
let fallbackSlot = { key: null, at: 0, promise: null };

export function resetFallbackForTests() {
  fallbackSlot = { key: null, at: 0, promise: null };
}

function defaultDeps(deps) {
  return {
    fetchFeeds: fetchAllFeeds,
    selectHeadlines,
    storeIsWarm,
    catalogIndex: defaultIndex,
    catalog,
    resolvePremiumSources,
    fetchPremiumHeadlines,
    ...deps,
  };
}

function liveFallback(sourceIds, category, d) {
  const key = `${[...sourceIds].sort().join(',')}|${category || 'all'}`;
  const now = Date.now();
  if (fallbackSlot.key === key && fallbackSlot.promise && now - fallbackSlot.at < FALLBACK_TTL_MS) {
    return fallbackSlot.promise;
  }
  // Server-side catalog definitions only — never the client's feedUrl.
  const selected = d.catalog.sources.filter((s) => sourceIds.includes(s.id));
  const promise = d
    .fetchFeeds(selected, { category })
    .then(({ headlines, stats }) => ({ headlines, served: 'fallback', stats }))
    .catch((err) => {
      console.error('[feeds] live fallback failed:', err.message);
      if (fallbackSlot.promise === promise) resetFallbackForTests();
      return { headlines: [], served: 'error', stats: { total: sourceIds.length, succeeded: 0, failed: sourceIds.length } };
    });
  fallbackSlot = { key, at: now, promise };
  return promise;
}

async function readCatalog(sourceIds, category, d) {
  try {
    if (await d.storeIsWarm()) {
      const headlines = await d.selectHeadlines({ sourceIds, category, limit: MAX_STORE_LIMIT });
      // Warm + empty is a genuinely empty slice, NOT cold — no fallback.
      return { headlines, served: 'store', stats: ZERO_STATS };
    }
  } catch (err) {
    console.error('[feeds] store read failed, falling back live:', err.message);
  }
  return liveFallback(sourceIds, category, d);
}

function sumStats(a, b) {
  return {
    total: a.total + b.total,
    succeeded: a.succeeded + b.succeeded,
    failed: a.failed + b.failed,
  };
}

function finalize(catalogResult, customResult) {
  const headlines = [...catalogResult.headlines, ...customResult.headlines].sort(
    (a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)
  );
  const live = sumStats(catalogResult.stats, customResult.stats);
  const ok =
    headlines.length > 0 ||
    catalogResult.served === 'store' ||
    live.total === 0 ||
    live.succeeded > 0;
  return {
    headlines,
    feedStats: { ...live, served: catalogResult.served },
    status: ok ? 200 : 503,
  };
}

// POST branch: split server-authoritatively; catalog ids → store (client
// feedUrl ignored — closes the catalog SSRF vector); everything else → live.
// premium (2E Task 8): a third, independent leg — resolved server-side from
// the user's owned premium feeds, never category-filtered here (the client
// already kind-selects which premium ids it asks for).
export async function getHeadlinesForSources(requestedSources, { category = null, premium = null, deps = {} } = {}) {
  const d = defaultDeps(deps);
  const catalogIds = [];
  const custom = [];
  for (const s of requestedSources) {
    const canonical = s && typeof s.id === 'string' ? d.catalogIndex.canonicalId(s.id) : null;
    if (canonical) {
      if (!catalogIds.includes(canonical)) catalogIds.push(canonical);
    } else {
      custom.push(s);
    }
  }
  const [catalogResult, customResult, premiumResult] = await Promise.all([
    catalogIds.length > 0
      ? readCatalog(catalogIds, category, d)
      : Promise.resolve({ headlines: [], served: 'none', stats: ZERO_STATS }),
    custom.length > 0
      ? d.fetchFeeds(custom, { category })
      : Promise.resolve({ headlines: [], stats: ZERO_STATS }),
    premium && premium.ids?.length > 0
      ? d.resolvePremiumSources(premium.userId, premium.ids).then((defs) => d.fetchPremiumHeadlines(defs))
      : Promise.resolve({ headlines: [], stats: ZERO_STATS, premiumStatus: [] }),
  ]);
  const merged = finalize(catalogResult, {
    headlines: [...customResult.headlines, ...premiumResult.headlines],
    stats: sumStats(customResult.stats, premiumResult.stats),
  });
  return { ...merged, premiumStatus: premiumResult.premiumStatus };
}

// GET branch: catalog only, filtered by category/source query params.
export async function getCatalogHeadlines({ category = null, source = null, deps = {} } = {}) {
  const d = defaultDeps(deps);
  let selected = d.catalog.sources;
  if (category) selected = selected.filter((s) => s.category === category);
  if (source) {
    const canonical = d.catalogIndex.canonicalId(source);
    selected = canonical ? selected.filter((s) => s.id === canonical) : [];
  }
  if (selected.length === 0) {
    return { headlines: [], feedStats: { ...ZERO_STATS, served: 'none' }, status: 200 };
  }
  const result = await readCatalog(selected.map((s) => s.id), category, d);
  return finalize(result, { headlines: [], stats: ZERO_STATS });
}
