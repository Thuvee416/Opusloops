// Browser regression checks with an isolated cloud fixture; no production writes.
// Run against `python3 -m http.server 4173 --directory mobile` with Playwright installed.
// PLAYWRIGHT_MODULE may point to a separately installed playwright/index.mjs.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseURL = process.env.OPUS_QA_URL || 'http://127.0.0.1:4173';
const userId = '11111111-1111-4111-8111-111111111111';
const projectKey = `opusloops.mobile.projects.v1.user.${userId}`;
let browser;
before(async () => {
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {})
  });
});
after(async () => browser?.close());

function fixture(signedIn) {
  const user = { id: '11111111-1111-4111-8111-111111111111', email: 'test@example.com', user_metadata: {} };
  let session = signedIn ? { user } : null;
  const f = window.__createFixture = {
    rows: new Map(), jobs: new Map(), creates: [], uploads: [], finalized: [],
    rejectCreate: false, holdCreate: false, holdUpload: false, holdSync: false,
    failUpload: false
  };
  window.OpusloopsCloud = {
    configured: () => true,
    getSession: () => session,
    restoreSession: async () => session,
    signIn: async () => {
      session = { user };
      window.dispatchEvent(new CustomEvent('opusloops:auth-session-change', { detail: { user } }));
      return session;
    },
    syncProjects: async rows => {
      if (f.holdSync) await new Promise(resolve => { f.releaseSync = resolve; });
      rows.forEach(row => f.rows.set(row.id, row));
      return [...f.rows.values()];
    },
    createStemImport: async ({ projectId, file }) => {
      f.creates.push({ projectId, name: file.name });
      if (f.rejectCreate) {
        f.rejectCreate = false;
        throw Object.assign(new Error('Test import rejected'), {status: 400});
      }
      const id = crypto.randomUUID();
      const job = { id, project_id: projectId, status: 'uploading', revision: 0, source_name: file.name, source_bytes: file.size,
        source_bucket: 'opusloops-stem-uploads', source_object_path: `${projectId}/${id}/source.zip` };
      f.jobs.set(id, job);
      if (f.holdCreate) await new Promise(resolve => { f.releaseCreate = resolve; });
      return { job, upload: {endpoint: 'fixture', bucketName: 'opusloops-stem-uploads', objectName: job.source_object_path} };
    },
    uploadStemArchive: async ({ file, jobId, signal, onProgress }) => {
      f.uploads.push({ name: file.name, jobId });
      onProgress(file.size / 2, file.size);
      if (f.failUpload) {
        f.failUpload = false;
        throw new TypeError('Test connection lost');
      }
      if (f.holdUpload) await new Promise((resolve, reject) => {
        f.releaseUpload = resolve;
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {once:true});
      });
      onProgress(file.size, file.size);
    },
    finalizeStemUpload: async id => {
      f.finalized.push(id);
      const job = { ...f.jobs.get(id), status: 'inspect_queued', revision: 1 };
      f.jobs.set(id, job);
      return { job, dispatch: {state:'submitted'} };
    },
    forgetStemArchiveUpload() {},
    getStemImport: async id => ({ job: f.jobs.get(id), events: [], assets: [] }),
    dispatchStemImport: async id => ({job: f.jobs.get(id), dispatch:{state:'submitted'}})
  };
}

async function setup(t, { signedIn = true, width = 390 } = {}) {
  const context = await browser.newContext({ viewport: {width,height:844}, isMobile:width < 1024, hasTouch:width < 1024, serviceWorkers:'block' });
  t.after(() => context.close());
  await context.route('**/cloud-client.js?*', route => route.fulfill({contentType:'application/javascript',body:`(${fixture.toString()})(${signedIn})`}));
  await context.route('https://*.supabase.co/**', route => route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'No browser runtime errors'));
  await page.goto(`${baseURL}/studio.html`);
  await page.locator('#create-project-button').waitFor();
  await page.waitForFunction(() => Boolean(window.__createFixture));
  return page;
}

const rows = (page, key = projectKey) => page.evaluate(key => JSON.parse(localStorage.getItem(key) || '[]'), key);
async function createDraft(page, name) {
  await page.locator('#create-project-button').click();
  await page.locator('#new-project-name').fill(name);
  await page.locator('#composer-form button[type=submit]').click();
  await page.locator('#view-import.is-active').waitFor();
}
async function selectFile(page, name = 'Track pack.zip') {
  await page.locator('#stem-zip-input').setInputFiles({name,mimeType:'application/zip',buffer:Buffer.alloc(100,1)});
}
async function startUpload(page) {
  await selectFile(page);
  await page.locator('#stem-upload-button').click();
}

test('empty Create has two actions; cancelling setup creates nothing at 320px', async t => {
  const page = await setup(t, {width:320});
  assert.equal((await rows(page)).length, 0);
  assert.equal(await page.locator('#create-recent').isVisible(), false);
  await page.locator('#create-project-button').click();
  await page.locator('#create-close-button').click();
  assert.equal((await rows(page)).length, 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#open-stem-import').click();
  assert.equal((await rows(page)).length, 0);
  assert.equal(await page.locator('#stem-upload-panel').isVisible(), true);
});

test('named draft survives reload and uploads under the same project ID', async t => {
  const page = await setup(t);
  await createDraft(page,'Named stems');
  const draft = (await rows(page))[0];
  assert.equal(draft.kind,'stem-draft');
  await page.reload();
  await page.locator('#create-recent-list button').click();
  assert.equal(await page.locator('#import-project-name').innerText(),'Named stems');
  await startUpload(page);
  await page.waitForFunction(() => window.__createFixture.finalized.length === 1);
  const projects = await rows(page);
  assert.equal(projects.length,1);
  assert.equal(projects[0].id,draft.id);
  assert.equal(projects[0].name,'Named stems');
  assert.equal(projects[0].kind,'stem-import');
  assert.equal(projects[0].stemImport.status,'inspect_queued');
  await page.evaluate(() => {
    const f = window.__createFixture;
    const [id, job] = [...f.jobs][0];
    f.jobs.set(id,{...job,status:'ready',revision:2});
  });
  await page.locator('#stem-ready-panel:not([hidden])').waitFor();
  await page.locator('#open-ready-stems').click();
  assert.equal(await page.locator('#view-studio').getAttribute('class'),'view is-stem-project is-active');
});

test('fresh upload does not resume or overwrite the previous import', async t => {
  const page = await setup(t);
  await createDraft(page,'Original project');
  await startUpload(page);
  await page.waitForFunction(() => window.__createFixture.finalized.length === 1);
  const original = (await rows(page))[0];
  await page.locator('.nav-item[data-view-target=create]').click();
  await page.locator('#open-stem-import').click();
  assert.equal(await page.locator('#stem-process-panel').isVisible(),false);
  assert.equal(await page.locator('#stem-file-name').innerText(),'No file selected');
  await selectFile(page,'Second pack.zip');
  await page.locator('#stem-upload-button').click();
  await page.waitForFunction(() => window.__createFixture.finalized.length === 2);
  const projects = await rows(page);
  assert.equal(projects.length,2);
  assert.equal(projects.find(p=>p.id===original.id).name,'Original project');
  assert.equal(projects.find(p=>p.id!==original.id).name,'Second pack');
});

test('create rejection retains named draft and file; retry succeeds once', async t => {
  const page = await setup(t);
  await createDraft(page,'Retry project');
  const id = (await rows(page))[0].id;
  await page.evaluate(() => { window.__createFixture.rejectCreate = true; });
  await startUpload(page);
  await page.locator('#stem-upload-error:not([hidden])').waitFor();
  assert.equal((await rows(page)).length,1);
  assert.equal((await rows(page))[0].id,id);
  assert.match(await page.locator('#stem-file-name').innerText(),/Track pack.zip/);
  await page.locator('#stem-upload-button').click();
  await page.waitForFunction(() => window.__createFixture.finalized.length === 1);
  assert.equal((await rows(page)).length,1);
  assert.equal((await rows(page))[0].id,id);
});

test('interrupted transfer resumes the original job without another project', async t => {
  const page = await setup(t);
  await page.locator('#open-stem-import').click();
  await page.evaluate(() => { window.__createFixture.failUpload = true; });
  await startUpload(page);
  await page.locator('#stem-process-error:not([hidden])').waitFor();
  await page.locator('#stem-upload-button').click();
  await page.waitForFunction(() => window.__createFixture.finalized.length === 1);
  assert.equal((await rows(page)).length,1);
  assert.equal(await page.evaluate(() => window.__createFixture.creates.length),1);
});

test('failed quick upload shows an error and retry creates only one saved project', async t => {
  const page = await setup(t);
  await page.locator('#open-stem-import').click();
  await page.evaluate(() => { window.__createFixture.rejectCreate = true; });
  await startUpload(page);
  await page.locator('#stem-upload-error:not([hidden])').waitFor();
  assert.equal((await rows(page)).length,0);
  await page.locator('#stem-upload-button').click();
  await page.waitForFunction(() => window.__createFixture.finalized.length === 1);
  assert.equal((await rows(page)).length,1);
});

test('switching during transfer isolates old callbacks from the new upload', async t => {
  const page = await setup(t);
  await page.locator('#open-stem-import').click();
  await page.evaluate(() => { window.__createFixture.holdUpload = true; });
  await startUpload(page);
  await page.waitForFunction(() => window.__createFixture.uploads.length === 1);
  const firstJob = await page.evaluate(() => window.__createFixture.uploads[0].jobId);
  await page.locator('.nav-item[data-view-target=create]').click();
  await page.locator('#open-stem-import').click();
  await selectFile(page,'Fresh stems.zip');
  await page.locator('#stem-upload-button').click();
  await page.waitForFunction(() => window.__createFixture.uploads.length === 2);
  assert.equal(await page.locator('#stem-upload-button').isDisabled(),true);
  assert.equal(await page.locator('#stem-process-error').isVisible(),false);
  await page.evaluate(() => window.__createFixture.releaseUpload());
  await page.waitForFunction(() => window.__createFixture.finalized.length === 1);
  assert.notEqual(await page.evaluate(() => window.__createFixture.finalized[0]),firstJob);
  assert.equal((await rows(page)).length,2);
});

test('connection recovery does not reopen the old import over a fresh ZIP', async t => {
  const page = await setup(t);
  await createDraft(page,'Original');
  await startUpload(page);
  await page.waitForFunction(() => window.__createFixture.finalized.length === 1);
  await page.locator('.nav-item[data-view-target=create]').click();
  await page.locator('#open-stem-import').click();
  await selectFile(page,'Next stems.zip');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(150);
  assert.equal(await page.locator('#stem-process-panel').isVisible(),false);
  assert.match(await page.locator('#stem-file-name').innerText(),/Next stems.zip/);
});

test('late creation response stays attached to its project after switching', async t => {
  const page = await setup(t);
  await createDraft(page,'First');
  const first = (await rows(page))[0];
  await page.locator('.nav-item[data-view-target=create]').click();
  await createDraft(page,'Second');
  const second = (await rows(page)).find(p=>p.id!==first.id);
  await page.evaluate(() => { window.__createFixture.holdCreate = true; });
  await startUpload(page);
  await page.waitForFunction(() => Boolean(window.__createFixture.releaseCreate));
  await page.locator('.nav-item[data-view-target=create]').click();
  await page.locator(`#create-recent-list [data-load-project="${first.id}"]`).click();
  await page.evaluate(() => window.__createFixture.releaseCreate());
  await page.waitForFunction(id => JSON.parse(localStorage.getItem('opusloops.mobile.projects.v1.user.11111111-1111-4111-8111-111111111111')).find(p=>p.id===id).kind==='stem-import', second.id);
  assert.equal(await page.locator('#import-project-name').innerText(),'First');
  assert.equal(await page.evaluate(() => window.__createFixture.uploads.length),0);
  assert.equal((await rows(page)).find(p=>p.id===first.id).kind,'stem-draft');
});

test('guest cannot initialize the application or create local projects', async t => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  t.after(() => context.close());
  await context.route('**/cloud-client.js?*', route => route.fulfill({contentType:'application/javascript',body:`(${fixture.toString()})(false)`}));
  const page = await context.newPage();
  await page.goto(`${baseURL}/studio.html`);
  await page.waitForURL('**/account.html?access=required');
  assert.equal(await page.locator('#create-project-button').count(), 0);
  assert.equal(await page.evaluate(() => localStorage.getItem('opusloops.mobile.projects.v1')), null);
});

for (const width of [1024, 1440, 1920]) test(`desktop workspace fits ${width}px with functional navigation and mixer`, async t => {
  const page = await setup(t, { width });
  const rail = await page.locator('.bottom-nav').boundingBox();
  assert.equal(rail.x, 0);
  assert.equal(rail.width, 112);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#create-project-button').click();
  await page.locator('#new-project-kind').selectOption('loop');
  await page.locator('#new-project-name').fill('Desktop session');
  await page.locator('#idea-input').fill('Warm house groove');
  await page.locator('#composer-form button[type=submit]').click();
  await page.locator('#view-studio.is-active').waitFor();
  const grid = await page.locator('.step-grid').first().boundingBox();
  assert.ok(grid.width > 500);
  assert.equal(await page.locator('.steps-scroll').first().evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
  await page.screenshot({path: `/tmp/opusloops-desktop-studio-${width}.png`, animations: 'disabled'});
  await page.locator('#play-button').click();
  await page.waitForFunction(() => document.querySelector('#persistent-player').dataset.playbackState === 'playing');
  const player = await page.locator('#persistent-player').boundingBox();
  assert.equal(Math.round(player.x), 112);
  assert.equal(Math.round(player.width), width - 112);
  await page.keyboard.press('Alt+3');
  await page.locator('#view-mix.is-active').waitFor();
  await page.locator('#view-mix').evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
  const tiles = await page.locator('.mixer-tile').all();
  const first = await tiles[0].boundingBox(), second = await tiles[1].boundingBox();
  assert.equal(first.y, second.y);
  const range = tiles[0].locator('input[type=range]');
  const before = await range.inputValue();
  const gesture = await tiles[0].locator('.mixer-gesture').boundingBox();
  await page.mouse.move(gesture.x + gesture.width/2, gesture.y + gesture.height/2);
  await page.mouse.down();
  await page.mouse.move(gesture.x + gesture.width/2, gesture.y + gesture.height/2 + 45, {steps: 8});
  await page.mouse.up();
  assert.notEqual(await range.inputValue(), before);
  await page.locator('#view-mix').focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('#persistent-player').dataset.playbackState !== 'playing');
  await page.screenshot({path: `/tmp/opusloops-desktop-${width}.png`});
  await page.keyboard.press('Alt+4');
  await page.locator('#view-projects.is-active').waitFor();
  await page.locator('#account-card-button').click();
  await page.locator('#profile-dialog[open]').waitFor();
  await page.locator('#profile-dialog').evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
  const dialog = await page.locator('#profile-dialog').boundingBox();
  assert.ok(dialog.y >= 0 && dialog.y + dialog.height <= 844);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Alt+1');
  await page.locator('#view-create.is-active').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

test('loop setup creates a single playable project with fresh mix defaults', async t => {
  const page = await setup(t);
  await page.locator('#create-project-button').click();
  await page.locator('#new-project-kind').selectOption('loop');
  await page.locator('#new-project-name').fill('Loop test');
  await page.locator('#idea-input').fill('A warm house groove');
  await page.locator('#composer-form button[type=submit]').click();
  await page.locator('#view-studio.is-active').waitFor();
  assert.equal((await rows(page)).length,1);
  assert.equal((await rows(page))[0].kind,'generated');
  await page.locator('#play-button').click();
  await page.waitForFunction(() => document.querySelector('#persistent-player').dataset.playbackState==='playing');
  assert.equal(await page.locator('#persistent-player').isVisible(),true);
  await page.locator('.nav-item[data-view-target=create]').click();
  assert.equal(await page.locator('#persistent-player').isVisible(),true);
});
