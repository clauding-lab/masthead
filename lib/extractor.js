import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import crypto from 'crypto';

function hashUrl(url) {
  return crypto.createHash('md5').update(url).digest('hex').slice(0, 12);
}

export async function extractArticle(url, sourceId) {
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch article: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;

  // Extract OG image as fallback
  const ogImage =
    doc.querySelector('meta[property="og:image"]')?.content ||
    doc.querySelector('meta[name="twitter:image"]')?.content ||
    null;

  // Extract source name from OG if not provided
  const ogSiteName =
    doc.querySelector('meta[property="og:site_name"]')?.content || null;

  // Extract published date from meta
  const metaDate =
    doc.querySelector('meta[property="article:published_time"]')?.content ||
    doc.querySelector('meta[name="publishdate"]')?.content ||
    doc.querySelector('time[datetime]')?.getAttribute('datetime') ||
    null;

  const reader = new Readability(doc);
  const article = reader.parse();

  if (!article) {
    throw new Error('Could not extract article content from this URL');
  }

  // Extract all images from article content
  const contentDom = new JSDOM(article.content);
  const images = Array.from(contentDom.window.document.querySelectorAll('img'))
    .map((img) => img.src)
    .filter(Boolean);

  const wordCount = article.textContent
    ? article.textContent.split(/\s+/).filter(Boolean).length
    : 0;

  return {
    id: hashUrl(url),
    title: article.title || 'Untitled',
    byline: article.byline || null,
    url,
    sourceId: sourceId || null,
    sourceName: ogSiteName || null,
    content: article.content,
    textContent: article.textContent,
    excerpt: article.excerpt || article.textContent?.slice(0, 200) || '',
    leadImage: ogImage || images[0] || null,
    images,
    publishedAt: metaDate || null,
    wordCount,
    readingTimeMinutes: Math.max(1, Math.ceil(wordCount / 200)),
    extractedAt: new Date().toISOString(),
  };
}
