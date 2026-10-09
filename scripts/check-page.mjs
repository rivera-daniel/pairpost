#!/usr/bin/env node
// Browser checks for the site: screenshots, horizontal scroll, console errors, external requests,
// contrast, focus order, tap targets, links, copy button, reduced motion.
//
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core \
//   SHOT_DIR=/tmp/shots node scripts/check-page.mjs
//
// Env: PLAYWRIGHT_CORE (directory of playwright-core, default: resolve "playwright-core"),
//      CHROMIUM (browser binary, default /usr/bin/chromium), SHOT_DIR (default ./tmp/shots),
//      BASE_URL (check a running server instead of starting one on a random port).
// Run it through a low-priority wrapper on a shared machine. It launches one browser, one page at a time.

import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import http from 'node:http';
import { createSiteServer } from '../serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const shotDir = path.resolve(process.env.SHOT_DIR || path.join(HERE, '..', 'tmp', 'shots'));
mkdirSync(shotDir, { recursive: true });

const pwEntry = process.env.PLAYWRIGHT_CORE
  ? pathToFileURL(path.join(path.resolve(process.env.PLAYWRIGHT_CORE), 'index.mjs')).href
  : 'playwright-core';
const { chromium } = await import(pwEntry);

let server;
let base = process.env.BASE_URL;
if (!base) {
  server = createSiteServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
}
const origin = new URL(base).origin;

// The page's own Permissions-Policy denies clipboard-read, so the copied text is read back from a
// second, plain page on another loopback origin.
const reader = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>reader</title>'); });
await new Promise((resolve) => reader.listen(0, '127.0.0.1', resolve));
const readerUrl = `http://127.0.0.1:${reader.address().port}/`;

const problems = [];
const info = [];
const fail = (label, detail) => problems.push(`${label}: ${detail}`);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || '/usr/bin/chromium',
  chromiumSandbox: true,
  headless: true,
});

const combos = [
  { name: '390x844', width: 390, height: 844, mobile: true },
  { name: '1440x900', width: 1440, height: 900, mobile: false },
];

/** Runs inside the page. */
function pageChecks() {
  const parse = (value) => {
    let m = value.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      const parts = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
    }
    m = value.match(/^color\(srgb ([^)]+)\)$/);
    if (m) {
      const parts = m[1].split(/[ /]+/).filter(Boolean).map(Number);
      return { r: parts[0] * 255, g: parts[1] * 255, b: parts[2] * 255, a: parts[3] ?? 1 };
    }
    return { r: 0, g: 0, b: 0, a: 0 };
  };
  const over = (top, bottom) => {
    const a = top.a + bottom.a * (1 - top.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    const mix = (t, b) => (t * top.a + b * bottom.a * (1 - top.a)) / a;
    return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const backdrop = (el) => {
    const chain = [];
    for (let n = el; n; n = n.parentElement) chain.push(n);
    let acc = { r: 255, g: 255, b: 255, a: 1 };
    for (const n of chain.reverse()) {
      const bg = parse(getComputedStyle(n).backgroundColor);
      if (bg.a > 0) acc = over(bg, acc);
    }
    return acc;
  };

  const contrast = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (!t.textContent.trim()) continue;
    const el = t.parentElement;
    if (!el || seen.has(el)) continue;
    seen.add(el);
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const bg = backdrop(el);
    const fg = over(parse(cs.color), bg);
    const size = parseFloat(cs.fontSize);
    const bold = parseInt(cs.fontWeight, 10) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    const min = large ? 3 : 4.5;
    const r = ratio(fg, bg);
    if (r < min) contrast.push(`${el.tagName.toLowerCase()}.${el.className} "${t.textContent.trim().slice(0, 30)}" ratio ${r.toFixed(2)} < ${min}`);
  }

  const vw = document.documentElement.clientWidth;
  const offenders = [];
  for (const el of document.querySelectorAll('body *')) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) continue;
    if (rect.right > vw + 1 || rect.left < -1) {
      // Ignore content inside a horizontally scrollable container and visually hidden elements.
      let clipped = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') { clipped = true; break; }
      }
      if (!clipped && getComputedStyle(el).position !== 'absolute') offenders.push(`${el.tagName.toLowerCase()}.${el.className}`);
    }
  }

  const targets = [];
  for (const el of document.querySelectorAll('a[href], button, summary')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || el.hidden) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) continue;
    const inline = cs.display === 'inline' && el.closest('p, li');
    if (!inline && (rect.height < 43.5 || rect.width < 43.5)) targets.push(`${el.tagName.toLowerCase()} "${(el.textContent || '').trim().slice(0, 24)}" ${Math.round(rect.width)}x${Math.round(rect.height)}`);
  }

  const mascot = document.querySelector('.mascot');
  return {
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    contrast,
    offenders,
    targets,
    mascotRendering: mascot ? getComputedStyle(mascot).imageRendering : null,
    mascotAnimation: mascot ? getComputedStyle(mascot).animationName : null,
    fonts: [...document.fonts].map((f) => `${f.family}:${f.status}`),
    sectionIds: [...document.querySelectorAll('[id]')].map((e) => e.id),
    hrefs: [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')),
    landmarks: ['header', 'nav', 'main', 'footer'].map((t) => `${t}:${document.querySelectorAll(t).length}`),
    h1: document.querySelectorAll('h1').length,
  };
}

async function runViewport(combo, scheme, { screenshot, extended, pagePath = '/' }) {
  const label = pagePath === '/' ? `${combo.name}/${scheme}` : `${pagePath} ${combo.name}/${scheme}`;
  const context = await browser.newContext({
    viewport: { width: combo.width, height: combo.height },
    colorScheme: scheme,
    reducedMotion: 'no-preference',
    deviceScaleFactor: 1,
    hasTouch: combo.mobile,
  });
  await context.grantPermissions(['clipboard-read'], { origin: new URL(readerUrl).origin });
  const page = await context.newPage();
  const consoleIssues = [];
  const external = [];
  const badResponses = [];
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) consoleIssues.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => consoleIssues.push(`pageerror: ${e.message}`));
  page.on('request', (r) => {
    const url = r.url();
    if (!url.startsWith('data:') && new URL(url).origin !== origin) external.push(url);
  });
  page.on('requestfailed', (r) => consoleIssues.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => { if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`); });
  await page.addInitScript(() => {
    window.__cls = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
  });

  await page.goto(base + pagePath, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);

  if (screenshot) await page.screenshot({ path: path.join(shotDir, `${pagePath === '/' ? '' : `${pagePath.replace(/\W+/g, '')}-`}${combo.name}-${scheme}.png`), fullPage: true });

  // Open every FAQ item so the contrast check covers their text, then run the checks.
  await page.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true; }));
  const result = await page.evaluate(pageChecks);
  const cls = await page.evaluate(() => window.__cls);

  if (result.scrollWidth > result.innerWidth) fail(label, `horizontal scroll: scrollWidth ${result.scrollWidth} > ${result.innerWidth}`);
  if (result.offenders.length) fail(label, `elements outside the viewport: ${[...new Set(result.offenders)].slice(0, 8).join(', ')}`);
  if (consoleIssues.length) fail(label, `console: ${consoleIssues.join(' | ')}`);
  if (external.length) fail(label, `external requests: ${external.join(', ')}`);
  if (badResponses.length) fail(label, `bad responses: ${badResponses.join(', ')}`);
  if (result.contrast.length) fail(label, `contrast: ${result.contrast.slice(0, 10).join(' | ')}`);
  if (result.targets.length) fail(label, `small tap targets: ${result.targets.join(' | ')}`);
  if (cls > 0.02) fail(label, `layout shift ${cls.toFixed(4)}`);
  if (pagePath === '/' && result.mascotRendering !== 'pixelated') fail(label, `mascot image-rendering is ${result.mascotRendering}`);
  if (result.h1 !== 1) fail(label, `expected one h1, got ${result.h1}`);
  info.push(`${label}: scrollWidth ${result.scrollWidth}/${result.innerWidth}, CLS ${cls.toFixed(4)}, fonts ${result.fonts.join(' ')}, landmarks ${result.landmarks.join(' ')}`);

  if (extended) {
    // Links: every anchor resolves, every href is local.
    const ids = new Set(result.sectionIds);
    for (const href of new Set(result.hrefs)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) { fail(label, `external link ${href}`); continue; }
      if (href.startsWith('#')) { if (!ids.has(href.slice(1))) fail(label, `dead anchor ${href}`); continue; }
      const res = await context.request.get(new URL(href, base + '/').href);
      if (res.status() !== 200) fail(label, `link ${href} -> ${res.status()}`);
    }
    info.push(`${label}: ${new Set(result.hrefs).size} distinct links checked`);

    // Keyboard order: Tab through the page and record where focus lands.
    await page.evaluate(() => { document.querySelectorAll('details').forEach((d) => { d.open = false; }); window.scrollTo(0, 0); document.activeElement?.blur(); });
    const order = [];
    for (let i = 0; i < 80; i += 1) {
      await page.keyboard.press('Tab');
      // Let the smooth scroll settle: wait until scrollY stops changing.
      await page.evaluate(() => new Promise((resolve) => {
        let last = -1;
        const tick = () => { if (window.scrollY === last) resolve(); else { last = window.scrollY; setTimeout(tick, 120); } };
        tick();
      }));
      const stop = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return {
          desc: `${el.tagName.toLowerCase()}${el.getAttribute('href') ? `[${el.getAttribute('href')}]` : ''} "${(el.textContent || '').trim().slice(0, 22)}"`,
          outline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2,
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          vh: window.innerHeight,
          y: Math.round(window.scrollY),
        };
      });
      if (!stop) break;
      order.push(stop);
      if (order.length > 1 && order[0].desc === stop.desc) { order.pop(); break; }
    }
    const first = order[0]?.desc || '';
    if (!first.includes('Skip to content')) fail(label, `first Tab stop is ${first}`);
    const noOutline = order.filter((s) => !s.outline).map((s) => s.desc);
    if (noOutline.length) fail(label, `no visible focus outline: ${noOutline.join(' | ')}`);
    const hidden = order.filter((s) => s.bottom < 0 || s.top > s.vh).map((s) => `${s.desc} top ${s.top} bottom ${s.bottom} vh ${s.vh} y ${s.y}`);
    if (hidden.length) fail(label, `focused element not in view: ${hidden.join(' | ')}`);
    info.push(`${label}: tab order (${order.length}): ${order.map((s) => s.desc).join(' > ')}`);

    // Skip link works.
    await page.evaluate(() => { window.scrollTo(0, 0); document.activeElement?.blur(); });
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    const afterSkip = await page.evaluate(() => location.hash);
    if (afterSkip !== '#main') fail(label, `skip link hash is ${afterSkip}`);

    // Copy button under the real headers.
    await page.evaluate(() => document.querySelector('#skill').scrollIntoView());
    const copy = page.locator('button.copy');
    if (!(await copy.isVisible())) fail(label, 'copy button not visible');
    else {
      await copy.click();
      await page.waitForTimeout(200);
      const text = await copy.textContent();
      const other = await context.newPage();
      await other.goto(readerUrl);
      const clip = await other.evaluate(() => navigator.clipboard.readText()).catch((e) => `ERR ${e.message}`);
      await other.close();
      await page.bringToFront();
      if (text !== 'Copied' || !String(clip).startsWith('mkdir -p ~/.claude/skills/pairpost')) fail(label, `copy failed: button "${text}", clipboard "${String(clip).slice(0, 40)}"`);
      else info.push(`${label}: copy button works under the page headers`);
    }

    // Reduced motion removes the mascot animation.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const anim = await page.evaluate(() => getComputedStyle(document.querySelector('.mascot')).animationName);
    if (anim !== 'none') fail(label, `reduced motion still animates: ${anim}`);
  }
  await context.close();
}

try {
  for (const combo of combos) {
    for (const scheme of ['dark', 'light']) {
      await runViewport(combo, scheme, { screenshot: true, extended: scheme === 'dark' });
    }
  }
  // The mailbox preview page gets the same checks, without the home page's link and copy-button extras.
  for (const combo of combos) {
    for (const scheme of ['dark', 'light']) {
      await runViewport(combo, scheme, { screenshot: true, extended: false, pagePath: '/mailbox.html' });
    }
  }
  // Extra widths for the horizontal scroll check only.
  for (const width of [360, 768, 1024]) {
    await runViewport({ name: `${width}x800`, width, height: 800, mobile: width < 700 }, 'dark', { screenshot: false, extended: false });
  }
  // Docs index page.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const res = await page.goto(base + '/docs/', { waitUntil: 'networkidle' });
  if (res.status() !== 200) fail('docs', `status ${res.status()}`);
  const sw = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  if (sw[0] > sw[1]) fail('docs', `horizontal scroll ${sw}`);
  await page.screenshot({ path: path.join(shotDir, 'docs-390.png'), fullPage: true });
  await context.close();
} finally {
  await browser.close();
  server?.close();
  reader.close();
}

for (const line of info) console.log(line);
if (problems.length) {
  console.error(`\nFAILED (${problems.length})`);
  for (const p of problems) console.error(` - ${p}`);
  process.exit(1);
}
console.log('\ncheck-page: ok');
