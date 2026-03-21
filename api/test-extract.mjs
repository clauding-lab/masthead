import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

export default async function handler(req, res) {
  const start = Date.now();
  try {
    const response = await fetch('https://www.bbc.com/news/articles/cwy5x0g52p4o', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Masthead/1.0)' },
      signal: AbortSignal.timeout(8000),
    });
    const html = await response.text();
    const fetchMs = Date.now() - start;

    const dom = new JSDOM(html, { url: 'https://www.bbc.com/news/articles/cwy5x0g52p4o' });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    const parseMs = Date.now() - start - fetchMs;

    res.status(200).json({
      ok: true,
      title: article?.title || 'no title',
      fetchMs,
      parseMs,
      totalMs: Date.now() - start,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, stack: err.stack?.slice(0, 500), ms: Date.now() - start });
  }
}
