import Parser from 'rss-parser';

const parser = new Parser();

export default async function handler(req, res) {
  const start = Date.now();
  try {
    const response = await fetch('https://hnrss.org/frontpage', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Masthead/1.0)' },
      signal: AbortSignal.timeout(5000),
    });
    const xml = await response.text();
    const fetchMs = Date.now() - start;

    const feed = await parser.parseString(xml);
    const parseMs = Date.now() - start - fetchMs;

    res.status(200).json({
      ok: true,
      items: feed.items?.length || 0,
      fetchMs,
      parseMs,
      totalMs: Date.now() - start,
      firstTitle: feed.items?.[0]?.title,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
      ms: Date.now() - start,
    });
  }
}
