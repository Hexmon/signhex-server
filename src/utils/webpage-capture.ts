import type { Browser } from 'playwright';

type CapturedWebpage = {
  finalUrl: string;
  contentType?: string;
  title: string | null;
  screenshot: Buffer;
};

let browserPromise: Promise<Browser> | null = null;

function isHtmlContentType(contentType?: string | null) {
  if (!contentType) return true;
  const normalized = contentType.toLowerCase();
  return normalized.includes('text/html') || normalized.includes('application/xhtml+xml');
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = import('playwright')
      .then(async ({ chromium }) => {
        const browser = await chromium.launch({
          headless: true,
          executablePath: process.env.HEXMON_WEBPAGE_CAPTURE_EXECUTABLE_PATH || undefined,
          args: ['--no-sandbox', '--disable-dev-shm-usage'],
        });

        browser.on('disconnected', () => {
          browserPromise = null;
        });

        return browser;
      })
      .catch((error) => {
        browserPromise = null;
        throw error;
      });
  }

  return browserPromise;
}

export async function captureWebpagePreview(sourceUrl: string): Promise<CapturedWebpage> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    javaScriptEnabled: true,
    userAgent: 'HexmonSignage/1.0 (+webpage-capture)',
  });

  const page = await context.newPage();

  try {
    const response = await page.goto(sourceUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 15_000,
    });

    if (!response) {
      throw new Error('Webpage request failed with status 0');
    }

    if (!response.ok()) {
      throw new Error(`Webpage request failed with status ${response.status()}`);
    }

    const contentType = response.headers()['content-type'];
    if (!isHtmlContentType(contentType)) {
      throw new Error(`Webpage URL did not return HTML content (${contentType})`);
    }

    await page.waitForTimeout(750);
    await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => {});

    const finalUrl = page.url() || response.url() || sourceUrl;
    const title = ((await page.title()) || '').trim() || null;
    const screenshot = (await page.screenshot({
      type: 'png',
      fullPage: false,
    })) as Buffer;

    return {
      finalUrl,
      contentType,
      title,
      screenshot,
    };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}
