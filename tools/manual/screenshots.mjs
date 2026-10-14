// Takes the user manual's screenshots from a demo TextBoss ("The Business
// Factory", all fictional). Re-run after UI changes:
//
//   npm run manual:screenshots
//
// Seeds demo-data/ fresh, starts a server on port 3100, drives Chrome with
// Puppeteer and writes JPEGs to public/manual/img/.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer';

const root = path.resolve(import.meta.dirname, '../..');
const out = path.join(root, 'public/manual/img');
const PORT = 3100;
const BASE = `http://localhost:${PORT}`;
const only = process.argv.slice(2); // optional: names of shots to take

fs.mkdirSync(out, { recursive: true });
execFileSync(process.execPath, [path.join(root, 'tools/manual/seed-demo.mjs'), path.join(root, 'demo-data')], { stdio: 'inherit' });

const server = spawn(process.execPath, [path.join(root, 'src/server.js')], {
  cwd: root,
  env: { ...process.env, DATA_DIR: 'demo-data', IMPORT_DIR: 'demo-data/import', PORT: String(PORT), PUBLIC_URL: BASE, WEBHOOK_SECRET: 'demo0secret0for0screenshots', NODE_ENV: 'production' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve) => server.stdout.on('data', (d) => String(d).includes('listening') && resolve()));

process.on('exit', () => server.kill());
process.on('uncaughtException', (err) => { console.error(err); process.exit(1); });
process.on('unhandledRejection', (err) => { console.error(err); process.exit(1); });
const browser = await puppeteer.launch({ args: ['--font-render-hinting=none'] });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let taken = 0;

async function session(username, { width = 1440, height = 900, scale = 2, mobile = false } = {}) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setViewport({ width, height, deviceScaleFactor: scale, isMobile: mobile, hasTouch: mobile });
  // The demo staff use two-factor sign-in, so use the sessions the seed made
  if (username) await page.setCookie({ name: 'tb_session', value: `demo-session-${username}`, url: BASE });
  await page.goto(BASE, { waitUntil: 'load' });
  if (username) await page.waitForSelector('.conv-list .conv');
  await wait(800);
  return page;
}

async function go(page, hash, selector) {
  await closeOverlays(page);
  await page.evaluate((h) => (location.hash = h), hash);
  if (selector) await page.waitForSelector(selector, { visible: true });
  await wait(700);
}

// Union of several elements' boxes, padded, clamped to the viewport
async function clipOf(page, selectors, pad = 0) {
  const boxes = [];
  for (const s of selectors) {
    const el = await page.$(s);
    const b = el && (await el.boundingBox());
    if (b) boxes.push(b);
  }
  if (!boxes.length) throw new Error(`nothing to capture for ${selectors.join(', ')}`);
  const vp = page.viewport();
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
  const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
  const right = Math.min(vp.width, Math.max(...boxes.map((b) => b.x + b.width)) + pad);
  const bottom = Math.min(vp.height, Math.max(...boxes.map((b) => b.y + b.height)) + pad);
  return { x, y, width: right - x, height: bottom - y };
}

async function shot(page, name, target) {
  if (only.length && !only.includes(name)) return;
  const file = path.join(out, `${name}.jpg`);
  const opts = { path: file, type: 'jpeg', quality: 84 };
  if (!target) await page.screenshot(opts);
  else if (target.x !== undefined) await page.screenshot({ ...opts, clip: target });
  else await page.screenshot({ ...opts, clip: await clipOf(page, [].concat(target)) });
  taken++;
  console.log(`  ${name}.jpg`);
}

const clickText = async (page, text, scope = '') => {
  const el = await page.waitForSelector(`${scope} ::-p-text(${text})`, { visible: true });
  await el.click();
  await wait(500);
};
// Dialogs, menus and pickers left open by a previous shot
const closeOverlays = (page) => page.evaluate(() => {
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  document.querySelectorAll('.picker, .menu').forEach((el) => el.remove());
  document.body.click();
});

const ids = await (async () => {
  const p = await session('morgan');
  const r = await p.evaluate(async () => {
    const convs = await (await fetch('/api/conversations')).json();
    const contacts = (await (await fetch('/api/contacts?limit=50&status=all')).json()).contacts;
    return { convs, contacts };
  });
  await p.browserContext().close();
  const conv = (phones) => r.convs.find((c) => c.participants.join(',') === phones)?.id;
  const contact = (first, last) => r.contacts.find((c) => c.firstName === first && c.lastName === last)?.id;
  return {
    thornton: conv('3125550142'), mo: conv('3125550133'), grace: conv('3125550127'), sofia: conv('3125550164'),
    group: conv('3125550171,3125550176'), stranger: conv('3125550177'),
    ava: contact('Ava', 'Thornton'), henry: contact('Henry', 'Walsh'),
  };
})();

console.log('Taking screenshots…');

// ---------- Everyday use (as Morgan, an admin, at 1440×900) ----------
{
  const page = await session('morgan');
  await go(page, `#/c/${ids.thornton}`, '.client-panel .cp-card');
  await shot(page, 'overview');
  await shot(page, 'inbox', { x: 0, y: 0, width: 340, height: 620 });
  await shot(page, 'conversation', '.pane');
  await shot(page, 'client-panel', '.client-panel');

  await page.click('.pane .thread-head [title="Contacts at this number"]');
  await page.waitForSelector('.menu', { visible: true });
  await shot(page, 'shared-number-menu', await clipOf(page, ['.pane .thread-head', '.menu'], 8));
  await closeOverlays(page);
  await page.keyboard.press('Escape');

  await page.click('.pane .thread-head [title="More"]');
  await page.waitForSelector('.menu', { visible: true });
  await shot(page, 'conversation-menu', await clipOf(page, ['.pane .thread-head', '.menu'], 8));
  await page.keyboard.press('Escape');
  await closeOverlays(page);

  await go(page, `#/c/${ids.mo}`, '.pane .composer');
  await page.click('.pane .composer [title="Canned responses"]');
  await page.waitForSelector('.picker', { visible: true });
  await shot(page, 'canned-picker', await clipOf(page, ['.picker', '.pane .composer'], 10));
  await page.keyboard.press('Escape');
  await closeOverlays(page);
  await shot(page, 'picture-message', await clipOf(page, ['.pane .messages .msg:first-of-type', '.pane .messages .media-item'], 16));

  await go(page, `#/c/${ids.grace}+${ids.thornton}`, '.panes.multi');
  await shot(page, 'side-by-side');

  await go(page, '#/new', 'main');
  await shot(page, 'new-message', 'main');

  await go(page, `#/contacts/${ids.ava}`, '.shared-phone');
  await shot(page, 'contact-page');
  await go(page, '#/contacts', '.contact-row, .contacts-list, .sidebar');
  await wait(400);
  // Ticking redraws the list, so find each checkbox fresh
  for (let i = 1; i <= 3; i++) {
    await page.evaluate((n) => document.querySelectorAll('.sidebar input[type=checkbox]')[n]?.click(), i);
    await wait(250);
  }
  await shot(page, 'contacts-select', { x: 0, y: 0, width: 340, height: 760 });

  await go(page, '#/bulk/1', 'main');
  await shot(page, 'bulk-progress', 'main');

  await go(page, '#/canned', 'main');
  await shot(page, 'canned-page', 'main');

  await go(page, '#/security', '.admin-page .card');
  await shot(page, 'security');

  await page.click('.side-top [title="Menu"]');
  await page.waitForSelector('.menu', { visible: true });
  await shot(page, 'main-menu', await clipOf(page, ['.side-top', '.menu'], 8));
  await clickText(page, 'Appearance', '.menu');
  await page.waitForSelector('dialog[open]', { visible: true });
  await page.setViewport({ width: 1440, height: 1500, deviceScaleFactor: 2 });
  await wait(500);
  // From the top of the dialog down to the "show my name" option, above the icon designer
  const appearanceClip = await page.evaluate(() => {
    const d = document.querySelector('dialog[open]').getBoundingClientRect();
    const label = [...document.querySelectorAll('dialog[open] label')].find((l) => l.textContent.includes('Show my name'));
    const bottom = label.getBoundingClientRect().bottom + 18;
    return { x: d.x, y: d.y, width: d.width, height: bottom - d.y };
  });
  await shot(page, 'appearance', appearanceClip);
  await page.keyboard.press('Escape');
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });

  await go(page, `#/c/${ids.thornton}`, '.pane .composer');
  await page.click('.side-top [title="Menu"]');
  await clickText(page, 'Take the tour', '.menu');
  await page.waitForSelector('.tour-card', { visible: true });
  await wait(500);
  await shot(page, 'tour');
  await page.keyboard.press('Escape');

  // ---------- Admin settings (tall window so whole pages fit) ----------
  await page.setViewport({ width: 1440, height: 2400, deviceScaleFactor: 2 });
  for (const [section, name] of [['bulkvs', 'admin-provider'], ['numbers', 'admin-numbers'], ['users', 'admin-users'], ['email', 'admin-email'],
    ['hours', 'admin-hours'], ['contacts', 'admin-contacts'], ['blocked', 'admin-blocked'], ['backup', 'admin-backup']]) {
    await go(page, `#/admin/${section}`, '.admin-page .card');
    await wait(600);
    await shot(page, name, await clipOf(page, ['.pane-head, .thread-head', '.admin-tabs', '.admin-page > *:last-child'], 0));
  }
  await go(page, '#/admin/contacts', '.admin-page .card');
  await clickText(page, 'View problems');
  await page.waitForSelector('dialog[open]', { visible: true });
  await shot(page, 'admin-problems', 'dialog[open]');
  await closeOverlays(page);
  await page.keyboard.press('Escape');

  // An import preview: a short client list dropped on the upload area
  await go(page, '#/admin/contacts', '.dropzone');
  await page.evaluate(() => {
    const csv = 'First Name,Last Name,Cell Phone,Email,Client ID\nAva,Thornton,3125550142,ava.thornton@example.com,BF-1001\nLeo,Thornton,3125550142,,BF-1002\nMaurice,Bell,3125550133,mo.bell@example.com,BF-1003\nGrace,Kim,3125550127,grace.kim@example,BF-1004\nSofia,Marquez,3125550164,sofia.m@example.com,BF-1006\nNora,Patel,3125550171,,BF-1007\nElijah,Brooks,3125550176,,BF-1008\nChloe,Nguyen,3125550183,chloe.n@example.com,BF-1009\nHenry,Walsh,3125550189,,BF-1010\nRuth,Albright,3125550196,,BF-1013\nPeter,Lang,3125550138,,BF-1014\nOlivia,Grant,3125550145,olivia.g@example.com,BF-1040\n';
    const dt = new DataTransfer();
    dt.items.add(new File([csv], 'ClientList-today.csv', { type: 'text/csv' }));
    document.querySelector('.dropzone').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForSelector('.import-report', { visible: true });
  await wait(600);
  await shot(page, 'admin-import-preview', '.import-report');
  await page.browserContext().close();
}

// ---------- Two-factor reminder (Priya has none yet) ----------
{
  const page = await session('priya');
  await shot(page, 'reminder-banner', { x: 0, y: 0, width: 340, height: 330 });
  await page.browserContext().close();
}

// ---------- Sign in ----------
{
  const page = await session(null, { width: 900, height: 720 });
  await page.waitForSelector('.auth form');
  await shot(page, 'sign-in', '.auth form');
  await page.browserContext().close();
}

// ---------- Phone ----------
{
  const page = await session('jamie', { width: 390, height: 844, scale: 3, mobile: true });
  await shot(page, 'phone-inbox');
  await go(page, `#/c/${ids.thornton}`, '.pane .composer');
  await shot(page, 'phone-conversation');
  await page.browserContext().close();
}

await browser.close();
server.kill();
console.log(`Done: ${taken} screenshots in ${path.relative(root, out)}`);
