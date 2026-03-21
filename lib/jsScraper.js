import puppeteer from 'puppeteer-core';
import * as cheerio from 'cheerio';

let browserInstance = null;
let browserCloseTimer = null;

async function findChromePath() {
  const paths = [
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];

  const { existsSync } = await import('fs');
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}

async function getBrowser() {
  if (browserInstance?.isConnected()) {
    // Reset the auto-close timer
    if (browserCloseTimer) clearTimeout(browserCloseTimer);
    browserCloseTimer = setTimeout(closeBrowser, 60_000);
    return browserInstance;
  }

  let executablePath;
  let args;

  // Try local Chrome first
  const localChrome = await findChromePath();
  if (localChrome) {
    executablePath = localChrome;
    args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ];
  } else {
    // Fall back to serverless chromium (Vercel/Lambda)
    try {
      const chromium = await import('@sparticuz/chromium');
      executablePath = await chromium.default.executablePath();
      args = chromium.default.args;
    } catch {
      throw new Error('No Chrome/Chromium found. Install Chrome or set CHROME_PATH.');
    }
  }

  browserInstance = await puppeteer.launch({
    executablePath,
    headless: 'new',
    args,
  });

  // Auto-close browser after 60s of inactivity
  browserCloseTimer = setTimeout(closeBrowser, 60_000);

  return browserInstance;
}

async function closeBrowser() {
  if (browserInstance) {
    try { await browserInstance.close(); } catch {}
    browserInstance = null;
  }
}

export async function scrapeWithJS(url, selectors, baseUrl) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 15_000,
    });

    // Wait for article elements to appear
    await page.waitForSelector(selectors.articleList, { timeout: 10_000 }).catch(() => {});

    const html = await page.content();
    const $ = cheerio.load(html);
    const items = [];

    $(selectors.articleList).each((_, el) => {
      const $el = $(el);
      const titleSel = selectors.title;
      const linkSel = selectors.link;

      const title = $el.find(titleSel.replace(/@.*$/, '')).text().trim();
      let link = '';
      if (linkSel.includes('@')) {
        const [sel, attr] = linkSel.split('@');
        link = $el.find(sel).attr(attr) || '';
      } else {
        link = $el.find(linkSel).attr('href') || '';
      }

      if (link && !link.startsWith('http')) {
        link = new URL(link, baseUrl).href;
      }

      if (!title || !link) return;

      let thumbnail = null;
      if (selectors.thumbnail) {
        const thumbSel = selectors.thumbnail;
        if (thumbSel.includes('@')) {
          const [sel, attr] = thumbSel.split('@');
          thumbnail = $el.find(sel).attr(attr) || null;
        }
        if (thumbnail && !thumbnail.startsWith('http')) {
          thumbnail = new URL(thumbnail, baseUrl).href;
        }
      }

      items.push({ title, link, thumbnail });
    });

    return items.slice(0, 20);
  } finally {
    await page.close();
  }
}
