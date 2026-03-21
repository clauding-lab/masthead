import { fetchAllFeeds } from '../lib/feedParser.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const sources = require('../lib/sources.json');

export default async function handler(req, res) {
  const start = Date.now();
  console.log(`[test-feeds-all] Starting with ${sources.sources.length} sources`);
  try {
    const headlines = await fetchAllFeeds(sources.sources);
    console.log(`[test-feeds-all] Done: ${headlines.length} items in ${Date.now() - start}ms`);
    res.status(200).json({
      ok: true,
      items: headlines.length,
      ms: Date.now() - start,
    });
  } catch (err) {
    console.error(`[test-feeds-all] Error: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message, ms: Date.now() - start });
  }
}
