import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.OPUS_QA_URL || 'http://127.0.0.1:4173';
let browser;
before(async () => {
  browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}) });
});
after(async () => browser?.close());

async function pageFor(options = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', ...options });
  const page = await context.newPage();
  return { context, page };
}

async function mockAuth(page, signedIn = false) {
  await page.route('**/cloud-client.js?*', route => route.fulfill({ contentType: 'text/javascript', body: `
    let session = ${signedIn ? '{user:{id:"qa",email:"qa@example.com"}}' : 'null'};
    window.OpusloopsCloud = {
      configured: () => true, getSession: () => session, restoreSession: async () => session,
      signIn: async (email, password) => {
        if (password !== 'correct-password') throw new Error('Invalid email or password');
        sessionStorage.setItem('qa-signed-in', email);
        return session = { user: { id: 'qa', email } };
      },
      signOut: async () => { session = null; sessionStorage.setItem('qa-signed-out', 'yes'); }
    };
  ` }));
}

test('landing fits small/mobile/desktop screens and opens the existing studio', async () => {
  for (const width of [320, 390, 1440]) {
    const { context, page } = await pageFor({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.locator('[data-pixel-wave]').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.getByRole('link', { name: 'Open studio' }).getAttribute('href'), './studio.html');
    assert.equal(await page.getByRole('link', { name: 'Sign in' }).getAttribute('href'), './account.html');
    await page.screenshot({ path: `/tmp/opusloops-landing-${width}.png`, fullPage: true, animations: 'disabled' });
    assert.deepEqual(errors, []);
    await context.close();
  }
});

test('pixels animate normally but freeze for reduced motion', async () => {
  const { context, page } = await pageFor();
  await page.goto(base);
  const pixels = () => page.locator('[data-pixel-wave]').evaluate(canvas => canvas.toDataURL());
  const initial = await pixels();
  await page.waitForTimeout(150);
  assert.notEqual(await pixels(), initial);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(100);
  const still = await pixels();
  await page.waitForTimeout(150);
  assert.equal(await pixels(), still);
  await context.close();
});

test('sign-in errors are visible and a successful retry enters the studio', async () => {
  const { context, page } = await pageFor();
  await mockAuth(page);
  await page.goto(`${base}/account.html`);
  await page.getByLabel('Email', { exact: true }).fill('qa@example.com');
  await page.getByLabel('Password', { exact: true }).fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').textContent(), /Invalid email/);
  await page.screenshot({ path: '/tmp/opusloops-account.png', fullPage: true });
  await page.getByLabel('Password', { exact: true }).fill('correct-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/studio.html');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('qa-signed-in')), 'qa@example.com');
  await context.close();
});

test('all pixel surfaces animate without hover and stop for reduced motion', async () => {
  for (const [path, selectors] of [
    ['/', ['[data-pixel-wave]', '[data-pixel-button]']],
    ['/account.html', ['[data-pixel-wave]', '[data-pixel-button]']],
    ['/studio.html', ['.nav-item.is-active .pixel-canvas']]
  ]) {
    const { context, page } = await pageFor();
    await page.goto(`${base}${path}`);
    await page.waitForTimeout(650);
    for (const selector of selectors) {
      const pixels = () => page.locator(selector).evaluate(canvas => canvas.toDataURL());
      const initial = await pixels();
      await page.waitForTimeout(350);
      assert.notEqual(await pixels(), initial, `${path} ${selector} should animate without hover`);
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(100);
    for (const selector of selectors) {
      const pixels = () => page.locator(selector).evaluate(canvas => canvas.toDataURL());
      const still = await pixels();
      await page.waitForTimeout(150);
      assert.equal(await pixels(), still, `${path} ${selector} should respect reduced motion`);
    }
    await context.close();
  }
});

test('sign-out requires a click, clears the session, and retains local project data', async () => {
  const { context, page } = await pageFor();
  await mockAuth(page, true);
  await page.goto(`${base}/account.html`);
  await page.getByRole('button', { name: 'Sign out on this device' }).waitFor();
  assert.equal(await page.evaluate(() => sessionStorage.getItem('qa-signed-out')), null);
  await page.evaluate(() => localStorage.setItem('qa-project', 'preserve'));
  await page.getByRole('button', { name: 'Sign out on this device' }).click();
  await page.getByRole('heading', { name: 'Signed out.' }).waitFor();
  assert.equal(await page.evaluate(() => sessionStorage.getItem('qa-signed-out')), 'yes');
  assert.equal(await page.evaluate(() => localStorage.getItem('qa-project')), 'preserve');
  await context.close();
});

test('offline navigation preserves the requested studio or account screen', async () => {
  const { context, page } = await pageFor({ serviceWorkers: 'allow' });
  await page.goto(base);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.goto(`${base}/studio.html`);
  await page.getByRole('heading', { name: 'Create', exact: true }).waitFor();
  await page.goto(`${base}/account.html?signedout=1`);
  await page.getByRole('heading', { name: 'Signed out.' }).waitFor();
  await context.close();
});
