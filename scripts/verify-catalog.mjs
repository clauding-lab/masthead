// scripts/verify-catalog.mjs
// Manual catalog health check (2D spec §8): every feedUrl must return
// HTTP 200, parseable-looking XML, and at least one item. Run before
// merge and paste the output into the PR. Deliberately NOT wired into
// CI or the build: 36 network calls make a flaky gate.
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const catalog = require('../lib/sources.json');

const results = await Promise.all(
  catalog.sources.map(async (s) => {
    try {
      const res = await fetch(s.feedUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Masthead/1.0)',
          Accept: 'application/rss+xml, application/xml, text/xml',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
      });
      const body = await res.text();
      const isXml = /<\?xml|<rss|<feed/.test(body.slice(0, 300));
      const items = (body.match(/<item>|<entry[\s>]/g) || []).length;
      return { id: s.id, status: res.status, items, ok: res.status === 200 && isXml && items > 0 };
    } catch (err) {
      return { id: s.id, status: 'ERR', items: 0, ok: false, err: err.message };
    }
  })
);

for (const r of results) {
  console.log(
    `${r.ok ? 'PASS' : 'FAIL'}  ${String(r.status).padStart(3)}  ${String(r.items).padStart(3)} items  ${r.id}${r.err ? `  (${r.err})` : ''}`
  );
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} feeds healthy`);
process.exit(failed.length > 0 ? 1 : 0);
