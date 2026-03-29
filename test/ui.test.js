'use strict';

/**
 * UI integration tests — real Chromium browser, real git repo, real server.
 * Run with: npm run test:ui
 *
 * Each test navigates to the running server and interacts via Playwright.
 * The fixture has two patch commits so patch tabs, sidebar, diffs, and all
 * interactive controls are exercised against real rendered HTML.
 *
 * Tests within each describe block are stateful (they share the same page
 * and build on each other). The general-feedback and expand-context describes
 * use fresh pages so their state is clean and unaffected by prior interactions.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { chromium } = require('playwright');
const { createApp, findAvailablePort } = require('../src/server');
const { git } = require('./helpers');

// ── Shared fixtures ────────────────────────────────────────────────────────

let tmpDir, mainRepoPath, workRepoPath;
let server, baseUrl;
let browser, page;

async function openFreshPage() {
  const p = await browser.newPage();
  await p.goto(baseUrl);
  await p.waitForSelector('.patch-heading', { state: 'visible' });
  return p;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'revue-ui-'));
  mainRepoPath = path.join(tmpDir, 'main-repo');
  workRepoPath = path.join(tmpDir, 'work-repo');

  fs.mkdirSync(mainRepoPath);
  git(mainRepoPath, 'init');
  git(mainRepoPath, 'config user.email "test@test.com"');
  git(mainRepoPath, 'config user.name "Test"');
  fs.writeFileSync(path.join(mainRepoPath, 'base.txt'), 'base content\n');
  git(mainRepoPath, 'add .');
  git(mainRepoPath, 'commit -m "initial commit"');

  execSync(`git clone "${mainRepoPath}" "${workRepoPath}"`, { encoding: 'utf8' });
  git(workRepoPath, 'config user.email "test@test.com"');
  git(workRepoPath, 'config user.name "Test"');

  fs.writeFileSync(
    path.join(workRepoPath, 'feature.js'),
    'function hello() {\n  return "hello";\n}\n\nmodule.exports = hello;\n'
  );
  git(workRepoPath, 'add .');
  git(workRepoPath, 'commit -m "feat: add hello function"');

  fs.writeFileSync(
    path.join(workRepoPath, 'utils.js'),
    'function add(a, b) {\n  return a + b;\n}\n\nfunction mul(a, b) {\n  return a * b;\n}\n\nmodule.exports = { add, mul };\n'
  );
  git(workRepoPath, 'add .');
  git(workRepoPath, 'commit -m "feat: add math utilities"');

  const app = createApp({
    worktreeName: 'work-repo',
    worktreePath: workRepoPath,
    mainRepoPath,
  });
  const port = await findAvailablePort(19400);
  await new Promise((resolve) => { server = app.listen(port, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${port}`;

  browser = await chromium.launch({ headless: true });
  page = await openFreshPage();
}, 30000);

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
}, 15000);

// ── Page structure ─────────────────────────────────────────────────────────

describe('page structure', () => {
  test('page title reflects repo and worktree', async () => {
    const title = await page.title();
    expect(title).toContain('main-repo');
    expect(title).toContain('work-repo');
  });

  test('header shows app name and worktree', async () => {
    const h1 = await page.textContent('h1');
    expect(h1).toContain('Revue');
    const wtPath = await page.textContent('#worktree-path');
    expect(wtPath).toContain('work-repo');
  });

  test('loading indicator is hidden after content loads', async () => {
    const display = await page.$eval('#loading', (el) => getComputedStyle(el).display);
    expect(display).toBe('none');
  });

  test('submit button is initially disabled', async () => {
    expect(await page.$eval('#btn-submit', (el) => el.disabled)).toBe(true);
  });

  test('submit warning message is shown initially', async () => {
    const warn = await page.textContent('#submit-warning');
    expect(warn.trim().length).toBeGreaterThan(0);
  });
});

// ── Patch tabs ─────────────────────────────────────────────────────────────

describe('patch tabs', () => {
  test('tabs bar is visible with multiple patches', async () => {
    const display = await page.$eval('#patch-tabs-bar', (el) => el.style.display);
    expect(display).not.toBe('none');
  });

  test('renders one tab per patch', async () => {
    expect((await page.$$('.patch-tab')).length).toBe(2);
  });

  test('first tab is active on load', async () => {
    const [t1, t2] = await page.$$('.patch-tab');
    expect(await t1.evaluate((el) => el.classList.contains('active'))).toBe(true);
    expect(await t2.evaluate((el) => el.classList.contains('active'))).toBe(false);
  });

  test('tab labels contain commit messages', async () => {
    const [t1, t2] = await page.$$('.patch-tab');
    expect(await t1.textContent()).toContain('feat: add hello function');
    expect(await t2.textContent()).toContain('feat: add math utilities');
  });

  test('clicking second tab makes it active', async () => {
    const [t1, t2] = await page.$$('.patch-tab');
    await t2.click();
    await page.waitForFunction(() => document.querySelectorAll('.patch-tab')[1]?.classList.contains('active'));
    expect(await t2.evaluate((el) => el.classList.contains('active'))).toBe(true);
    await t1.click();
    await page.waitForFunction(() => document.querySelectorAll('.patch-tab')[0]?.classList.contains('active'));
  });
});

// ── Sidebar (file nav) ─────────────────────────────────────────────────────

describe('sidebar', () => {
  test('file-nav is visible', async () => {
    const display = await page.$eval('#file-nav', (el) => el.style.display);
    expect(display).not.toBe('none');
  });

  test('shows "Files changed" label', async () => {
    expect(await page.textContent('.file-nav-label')).toBe('Files changed');
  });

  test('lists the file changed in the current patch', async () => {
    const items = await page.$$('.file-nav-item');
    expect(items.length).toBeGreaterThan(0);
    expect(await items[0].textContent()).toContain('feature.js');
  });

  test('collapse toggle button is present', async () => {
    expect(await page.$('.file-nav-toggle')).not.toBeNull();
  });

  test('clicking toggle collapses the sidebar', async () => {
    await page.click('.file-nav-toggle');
    await page.waitForFunction(() => document.querySelector('#file-nav')?.classList.contains('collapsed'));
    expect(await page.$eval('#file-nav', (el) => el.classList.contains('collapsed'))).toBe(true);
  });

  test('clicking toggle again expands the sidebar', async () => {
    await page.click('.file-nav-toggle');
    await page.waitForFunction(() => !document.querySelector('#file-nav')?.classList.contains('collapsed'));
    expect(await page.$eval('#file-nav', (el) => el.classList.contains('collapsed'))).toBe(false);
  });
});

// ── Diff rendering ──────────────────────────────────────────────────────────

describe('diff rendering', () => {
  test('file block is rendered with the filename', async () => {
    const text = await page.textContent('.file-header');
    expect(text).toContain('feature.js');
  });

  test('file header shows +/- stats', async () => {
    expect(await page.textContent('.file-stats .stat-add')).toMatch(/^\+\d+$/);
    expect(await page.textContent('.file-stats .stat-del')).toMatch(/^-\d+$/);
  });

  test('diff table renders added lines', async () => {
    expect((await page.$$('.line-added')).length).toBeGreaterThan(0);
  });

  test('added lines show + prefix', async () => {
    const text = await page.textContent('.line-added .ln-content');
    expect(text).toContain('+');
  });

  test('hunk header row is visible', async () => {
    const hunkHeader = await page.$('.hunk-header');
    expect(hunkHeader).not.toBeNull();
  });

  test('clicking file header collapses the diff body', async () => {
    await page.click('.file-header');
    await page.waitForFunction(() =>
      getComputedStyle(document.querySelector('.diff-body')).display === 'none'
    );
    expect(await page.$eval('.diff-body', (el) => getComputedStyle(el).display)).toBe('none');
  });

  test('clicking file header again expands the diff body', async () => {
    await page.click('.file-header');
    await page.waitForFunction(() =>
      getComputedStyle(document.querySelector('.diff-body')).display !== 'none'
    );
    expect(await page.$eval('.diff-body', (el) => getComputedStyle(el).display)).not.toBe('none');
  });
});

// ── Approve / Deny ─────────────────────────────────────────────────────────

describe('approve and deny', () => {
  test('Approve button is displayed on patch heading', async () => {
    const btn = await page.$('.btn-approve');
    expect(btn).not.toBeNull();
    expect(await btn.textContent()).toBe('Approve');
  });

  test('Deny button is displayed on patch heading', async () => {
    const btn = await page.$('.btn-deny');
    expect(btn).not.toBeNull();
    expect(await btn.textContent()).toBe('Deny');
  });

  test('clicking Approve changes button to "Approved ✓" and enables submit', async () => {
    await page.click('.btn-approve');
    await page.waitForSelector('.btn-unapprove');
    expect(await page.textContent('.btn-unapprove')).toBe('Approved ✓');
    expect(await page.$eval('#btn-submit', (el) => el.disabled)).toBe(false);
  });

  test('approved patch tab gets approved class', async () => {
    const tab = (await page.$$('.patch-tab'))[0];
    expect(await tab.evaluate((el) => el.classList.contains('approved'))).toBe(true);
  });

  test('clicking "Approved ✓" un-approves the patch', async () => {
    await page.click('.btn-unapprove');
    await page.waitForSelector('.btn-approve');
    expect(await page.textContent('.btn-approve')).toBe('Approve');
  });

  test('clicking Deny changes button to "Denied ✗"', async () => {
    await page.click('.btn-deny');
    await page.waitForSelector('.btn-undeny');
    expect(await page.textContent('.btn-undeny')).toBe('Denied ✗');
  });

  test('deny notice appears below the general comment box', async () => {
    expect(await page.$('.deny-notice')).not.toBeNull();
  });

  test('clicking "Denied ✗" un-denies and removes deny notice', async () => {
    await page.click('.btn-undeny');
    await page.waitForSelector('.btn-deny');
    expect(await page.textContent('.btn-deny')).toBe('Deny');
    expect(await page.$('.deny-notice')).toBeNull();
  });
});

// ── Commit message section ──────────────────────────────────────────────────

describe('commit message section', () => {
  test('commit message block is rendered', async () => {
    expect(await page.$('.commit-msg-block')).not.toBeNull();
  });

  test('commit message subject matches the patch commit', async () => {
    expect(await page.textContent('.commit-msg-subject')).toContain('feat: add hello function');
  });

  test('clicking commit subject opens a comment form', async () => {
    await page.click('.commit-msg-subject');
    await page.waitForSelector('.comment-form-inner');
    expect(await page.$('.comment-form-inner')).not.toBeNull();
  });

  test('comment form has Cancel, Discard draft, and Save comment buttons', async () => {
    expect(await page.$('.btn-cancel')).not.toBeNull();
    expect(await page.$('.btn-discard')).not.toBeNull();
    expect(await page.$('.btn-save')).not.toBeNull();
  });

  test('Cancel button closes the form', async () => {
    await page.click('.btn-cancel');
    await page.waitForFunction(() => !document.querySelector('.comment-form-inner'));
    expect(await page.$('.comment-form-inner')).toBeNull();
  });

  test('saving a commit message comment shows comment display', async () => {
    await page.click('.commit-msg-subject');
    await page.waitForSelector('.comment-form-inner textarea');
    await page.fill('.comment-form-inner textarea', 'Commit message needs a bug link.');
    await page.click('.btn-save');
    await page.waitForSelector('.comment-display-row');
    expect(await page.textContent('.comment-body')).toBe('Commit message needs a bug link.');
  });

  test('commit comment enables submit button', async () => {
    expect(await page.$eval('#btn-submit', (el) => el.disabled)).toBe(false);
  });

  test('deleting the commit comment removes it', async () => {
    await page.click('.btn-delete-comment');
    await page.waitForFunction(() => !document.querySelector('.comment-display-row'));
    expect(await page.$('.comment-display-row')).toBeNull();
  });
});

// ── Inline line comments ───────────────────────────────────────────────────

describe('inline line comments', () => {
  test('clicking a diff line opens the comment form', async () => {
    await page.click('.line-added .ln-content');
    await page.waitForSelector('.comment-form-row');
    expect(await page.$('.comment-form-row')).not.toBeNull();
  });

  test('comment form textarea receives focus', async () => {
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
  });

  test('Cancel button closes the inline form', async () => {
    await page.click('.btn-cancel');
    await page.waitForFunction(() => !document.querySelector('.comment-form-row'));
    expect(await page.$('.comment-form-row')).toBeNull();
  });

  test('typing and saving a comment shows comment display', async () => {
    await page.click('.line-added .ln-content');
    await page.waitForSelector('.comment-form-row textarea');
    await page.fill('.comment-form-row textarea', 'This line needs a test.');
    await page.click('.btn-save');
    await page.waitForSelector('.comment-display-row');
    expect(await page.textContent('.comment-body')).toBe('This line needs a test.');
  });

  test('saved comment enables the submit button', async () => {
    expect(await page.$eval('#btn-submit', (el) => el.disabled)).toBe(false);
  });

  test('clicking × deletes the comment', async () => {
    await page.click('.btn-delete-comment');
    await page.waitForFunction(() => !document.querySelector('.comment-display-row'));
    expect(await page.$('.comment-display-row')).toBeNull();
  });
});

// ── General feedback textarea ──────────────────────────────────────────────
// Uses a fresh page so submit-button state starts clean (no prior approvals/comments).

describe('general feedback', () => {
  let cleanPage;

  beforeAll(async () => { cleanPage = await openFreshPage(); }, 15000);
  afterAll(async () => { await cleanPage.close(); });

  test('general comment textarea is visible', async () => {
    const ta = await cleanPage.$('.general-comment-textarea');
    expect(ta).not.toBeNull();
    expect(await ta.evaluate((el) => getComputedStyle(el).display)).not.toBe('none');
  });

  test('typing in general comment enables submit', async () => {
    await cleanPage.fill('.general-comment-textarea', 'Overall this looks risky.');
    await cleanPage.waitForFunction(() => !document.querySelector('#btn-submit').disabled);
    expect(await cleanPage.$eval('#btn-submit', (el) => el.disabled)).toBe(false);
  });

  test('clearing general comment (only activity) disables submit', async () => {
    await cleanPage.fill('.general-comment-textarea', '');
    await cleanPage.dispatchEvent('.general-comment-textarea', 'input');
    await cleanPage.waitForFunction(() => document.querySelector('#btn-submit').disabled);
    expect(await cleanPage.$eval('#btn-submit', (el) => el.disabled)).toBe(true);
  });
});

// ── Expand context ─────────────────────────────────────────────────────────
// Uses a fresh page so the diff DOM is in its initial state (not rebuilt by
// approve/deny/comment cycles which call renderCurrentPatch multiple times).

describe('expand context', () => {
  let expandPage;

  beforeAll(async () => { expandPage = await openFreshPage(); }, 15000);
  afterAll(async () => { await expandPage.close(); });

  test('expand-context row is present in the diff', async () => {
    expect(await expandPage.$('.expand-context-row')).not.toBeNull();
  });

  test('expand button renders with a line count label', async () => {
    const btn = await expandPage.$('.btn-exp');
    expect(btn).not.toBeNull();
    expect(await btn.textContent()).toMatch(/Lines?/);
  });

  test('clicking expand button fires a /api/filecontext request and server responds', async () => {
    // Register the listener before the click so the response isn't missed.
    const responsePromise = expandPage.waitForResponse(
      (r) => r.url().includes('/api/filecontext'),
      { timeout: 8000 }
    );
    await expandPage.evaluate(() => document.querySelector('.btn-exp').click());
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(typeof body.totalLines).toBe('number');
    expect(Array.isArray(body.lines)).toBe(true);
  });
});
