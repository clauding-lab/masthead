import { createRequire } from 'module';
import { fetchAllFeeds } from './feedParser.js';
import { upsertArticles, prune } from './articlesWrite.js';

const require = createRequire(import.meta.url);
const catalog = require('./sources.json');

const RETENTION_DAYS = 14;

// One poll run: fetch all catalog feeds → upsert → prune (spec §5.1).
// Per-feed failures are isolated inside fetchAllFeeds; only zero-success or a
// write failure fails the run.
export async function runPoll(deps = {}) {
  const {
    fetchFeeds = fetchAllFeeds,
    upsert = upsertArticles,
    pruneStore = prune,
    sources = catalog.sources,
  } = deps;

  const { headlines, stats } = await fetchFeeds(sources);
  if (stats.total > 0 && stats.succeeded === 0) {
    return { ok: false, status: 503, stats, error: 'all feeds failed' };
  }
  const upserted = await upsert(headlines);
  const pruned = await pruneStore({ maxAgeDays: RETENTION_DAYS });
  return { ok: true, status: 200, stats, upserted, pruned };
}
