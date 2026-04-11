import type { Browser } from 'playwright';

let browserPromise: Promise<Browser> | null = null;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = import('playwright')
      .then(async ({ chromium }) => {
        const browser = await chromium.launch({
          headless: true,
          executablePath: process.env.HEXMON_REPORT_PDF_EXECUTABLE_PATH || undefined,
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

export function escapeHtml(value: unknown) {
  const input = String(value ?? '');
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export async function renderPdfDocument(html: string) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    colorScheme: 'light',
  });
  const page = await context.newPage();

  try {
    await page.setContent(html, { waitUntil: 'networkidle' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: {
        top: '16mm',
        right: '12mm',
        bottom: '16mm',
        left: '12mm',
      },
    });
    return pdf;
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}
