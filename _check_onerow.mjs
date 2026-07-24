import { chromium } from 'playwright';

const EMAIL = process.env.PA_TEST_EMAIL;
const PASS = process.env.PA_TEST_PASSWORD;

const browser = await chromium.launch();

async function check(width) {
  const ctx = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  const page = await ctx.newPage();
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
  await page.fill('#loginEmail', EMAIL);
  await page.fill('#loginPass', PASS);
  await page.click('#btnSignIn');
  await page.waitForSelector('#dashMap', { timeout: 15000 }).catch(()=>{});
  await page.waitForTimeout(1200);
  const info = await page.evaluate(() => {
    const brand = document.querySelector('.header-brand').getBoundingClientRect();
    const actions = document.querySelector('.header-actions').getBoundingClientRect();
    return { brandTop: brand.top, brandBottom: brand.bottom, actionsTop: actions.top, actionsBottom: actions.bottom, sameRow: Math.abs(brand.top - actions.top) < 3 };
  });
  console.log(`width=${width}: sameRow=${info.sameRow}  brand(top=${info.brandTop.toFixed(0)}) actions(top=${info.actionsTop.toFixed(0)})`);
  await ctx.close();
}

await check(375);
await check(390);
await check(414);
await check(430);
await check(480);

await browser.close();
console.log('done');
