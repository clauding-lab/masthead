import { fetchAllFeeds } from '../lib/feedParser.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const sources = require('../lib/sources.json');

export default async function handler(req, res) {
  const start = Date.now();
  console.log(`[test-feeds-lite] Starting with ${sources.sources.length} sources`);
  try {
    // Only fetch first 3 sources to test
    const subset = sources.sources.slice(0, 3);
    console.log(`[test-feeds-lite] Fetching: ${subset.map(s => s.id).join(', ')}`);
    const headlines = await fetchAllFeeds(subset);
    console.log(`[test-feeds-lite] Done: ${headlines.length} items in ${Date.now() - start}ms`);
    res.status(200).json({
      ok: true,
      items: headlines.length,
      ms: Date.now() - start,
      sources: subset.map(s => s.id),
    });
  } catch (err) {
    console.error(`[test-feeds-lite] Error: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message, ms: Date.now() - start });
  }
}
