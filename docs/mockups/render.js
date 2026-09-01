const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const dir = __dirname;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const page = await browser.newPage({ viewport: { width: 1800, height: 1000 }, deviceScaleFactor: 2 });
  await page.goto('file://' + path.join(dir, 'screens.html'));
  await page.waitForTimeout(300);
  const ids = ['home', 'channels-dark', 'channels-light', 'chat', 'user-sheet', 'trust', 'audio'];
  for (const id of ids) {
    const el = await page.$('#' + id);
    await el.screenshot({ path: path.join(dir, `${id}.png`), omitBackground: false });
    console.log('wrote', id);
  }
  // Overview: all phones in one image
  const stage = await page.$('.stage');
  await page.setViewportSize({ width: 3100, height: 1000 });
  await page.waitForTimeout(200);
  await stage.screenshot({ path: path.join(dir, 'overview.png') });
  console.log('wrote overview');
  await browser.close();
})();
