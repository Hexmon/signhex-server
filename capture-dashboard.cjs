const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

// Lovable preview with token
const domain = "https://preview--signhex-nexus-core.lovable.app";
const tokenQuery =
  "/?__lovable_token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoiQnhSd2RudFZxcVcxZTFMSndabzE3dmpQTjYzMiIsInByb2plY3RfaWQiOiI4YzNhZGRmNC0yYzUyLTRlZmYtOWE0OC1jZTUyNGIxYjQ5MmEiLCJub25jZSI6IjliZDY5YTMzNGUyN2MwNGVkY2FhYjZmZWEzZGQ1NTM0IiwiaXNzIjoibG92YWJsZS1hcGkiLCJzdWIiOiI4YzNhZGRmNC0yYzUyLTRlZmYtOWE0OC1jZTUyNGIxYjQ5MmEiLCJhdWQiOlsibG92YWJsZS1hcHAiXSwiZXhwIjoxNzYzOTc1NzY3LCJuYmYiOjE3NjMzNzA5NjcsImlhdCI6MTc2MzM3MDk2N30.JhUNag7KDPzx4lP3NaHYOcR0rWdq_8eg5SbjJ0QnSko";

// Additional routes after the token-based landing page
const routes = [
  "/media",
  "/screens",
  "/schedule",
  "/requests",
  "/departments",
  "/operators",
  "/proof-of-play",
  "/reports",
  "/api-keys",
  "/webhooks",
  "/sso-config",
  "/settings",
  "/conversations"
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const outDir = path.join(process.cwd(), "artifacts");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

  // Capture landing page with token
  const rootSafe = "root";
  const rootFile = path.join(outDir, `dashboard-${rootSafe}.png`);
  const rootUrl = domain + tokenQuery;
  console.log("Capturing", rootUrl, "->", rootFile);
  await page.goto(rootUrl, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: rootFile, fullPage: true });

  // Capture remaining routes (token should persist via cookie/localStorage)
  for (const route of routes) {
    const url = domain + route;
    const safe = route.replace(/\//g, "").replace(/[^a-zA-Z0-9_-]/g, "-") || "root";
    const file = path.join(outDir, `dashboard-${safe}.png`);
    console.log("Capturing", url, "->", file);
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: file, fullPage: true });
  }

  await browser.close();
})();
