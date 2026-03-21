import { parseHTML } from 'linkedom';
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
  const { document: doc } = parseHTML(html);

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

  let articleContent = article.content || '';

  // Extract all images from article content
  const imgRegex = /<img[^>]+src="([^"]+)"/g;
  const images = [];
  let match;
  while ((match = imgRegex.exec(articleContent)) !== null) {
    images.push(match[1]);
  }

  // Determine lead image
  const leadImage = ogImage || images[0] || null;

  // Remove duplicate lead image from article body
  if (leadImage && articleContent) {
    const leadBase = leadImage.split('?')[0];
    // Remove first <figure>, <picture>, or <img> that contains the lead image
    articleContent = articleContent.replace(
      new RegExp(`<(figure|picture)[^>]*>([\\s\\S]*?)<\\/\\1>`, 'i'),
      (fullMatch) => {
        const srcMatch = fullMatch.match(/src="([^"]+)"/);
        if (srcMatch) {
          const imgBase = srcMatch[1].split('?')[0];
          if (imgBase === leadBase || imgBase.includes(leadBase) || leadBase.includes(imgBase)) {
            return '';
          }
        }
        return fullMatch;
      }
    );
  }

  // Fallback: if HTML content is empty but textContent exists, wrap in paragraphs
  let cleanedContent = articleContent;
  if (!cleanedContent && article.textContent) {
    cleanedContent = article.textContent
      .split(/\n\n+/)
      .filter((p) => p.trim())
      .map((p) => `<p>${p.trim()}</p>`)
      .join('\n');
  }

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
    content: cleanedContent,
    textContent: article.textContent,
    excerpt: article.excerpt || article.textContent?.slice(0, 200) || '',
    leadImage,
    images,
    publishedAt: metaDate || null,
    wordCount,
    readingTimeMinutes: Math.max(1, Math.ceil(wordCount / 200)),
    extractedAt: new Date().toISOString(),
  };
}
