/* The researcher app's BOOT SCREEN (Seth, 2026-10-04: "researcher PWA shows a blank screen until the
 * app code is at least partially loaded"). The engine is ~2.5 MB of modules; until it has run nothing
 * draws. So the shell carries an inline screen that paints from the parse and that the panel's first
 * render replaces (root.innerHTML). These pins keep it independent of everything that arrives later. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../satellites/flextext-researcher/index.html', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../docs/js/researcher-panel.js', import.meta.url), 'utf8');
const section = (html.match(/<section id="view-researcher" class="view">([\s\S]*?)<\/section>/) || [])[1] || '';

test('the boot screen lives INSIDE #view-researcher, so the first panel render replaces it', () => {
  assert.ok(section.includes('id="fx-boot"'), 'boot screen inside the view the panel renders into');
  const renders = (panel.match(/root\.innerHTML = /g) || []).length;
  assert.ok(renders >= 5, `the panel assigns root.innerHTML on every state (${renders}) — that is what removes the screen`);
  assert.doesNotMatch(panel, /fx-boot/, 'the engine knows nothing about it: no removal code to keep in step');
});

test('it depends on nothing that downloads later: inline style, inline svg, no engine, no app.css class', () => {
  assert.doesNotMatch(section, /<link|<img|url\(/, 'no external asset');
  assert.match(section, /<svg[^>]*viewBox="0 0 512 512"/, 'the icon is inline svg');
  assert.match(section, /<style>[\s\S]*#fx-boot-bar[\s\S]*<\/style>/, 'its animation is inline too');
  assert.doesNotMatch(section, /class="(rp-|banner|note|primary-btn)/, 'no app.css classes: it must look right before app.css arrives');
  assert.match(section, /prefers-reduced-motion: reduce/, 'the bar stops moving for people who ask for that');
});

test('its script is plain ES5 and picks the language the apps do', () => {
  const script = (section.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
  assert.ok(script.length > 0);
  assert.doesNotMatch(script, /=>|\bconst\b|\blet\b|`|\.\.\./, 'ES5 only: it must run in a browser too old for the engine');
  assert.match(script, /localStorage\.getItem\('flextext-lang'\)/, "the apps' saved language first");
  assert.match(script, /navigator\.languages/, 'then the browser\'s preferences');
  assert.match(script, /b === 'in'\) b = 'id'/, 'the old Android code for Indonesian');
  assert.match(section, /<span lang="en">Loading the app…<\/span> <span lang="id">Memuat aplikasi…<\/span>/, 'both languages in the markup; the script hides the other');
});

test('after 20 s without the panel it says so, in both languages, and offers a reload', () => {
  const script = (section.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
  assert.match(script, /setTimeout\(function \(\) \{[\s\S]*\}, 20000\)/);
  assert.match(script, /if \(!slow\) return;/, 'if the panel replaced the screen meanwhile, nothing happens');
  assert.match(script, /Still loading\. On a slow connection this can take a while\./);
  assert.match(script, /Masih memuat\. Pada koneksi lambat ini bisa memakan waktu\./);
  assert.match(script, /location\.reload\(\)/);
});

test('it never shadows the service worker\'s offline page, and says "offline" when the link dropped later', () => {
  /* sw.js (Seth, 2026-08-31): navigations only, network first, NO cache store; when the page itself
   * cannot be fetched it serves the inline OFFLINE_HTML. So offline you get that page, never this
   * screen; this screen can only be on screen when index.html DID arrive. Pinned so nobody adds a
   * cached index.html that would put the boot screen in front of the offline page. */
  const sw = readFileSync(new URL('../satellites/flextext-researcher/sw.js', import.meta.url), 'utf8');
  assert.match(sw, /const OFFLINE_HTML = `<!doctype html>/, 'the inline offline page is still there');
  assert.match(sw, /e\.respondWith\(fetch\(e\.request\)\.catch\(\(\) =>/, 'network first; the offline page only when the fetch fails');
  assert.doesNotMatch(sw, /cache\.addAll|caches\.open\(/, 'no cache store: index.html is never served from a cache');
  const script = (section.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
  assert.match(script, /!navigator\.onLine/, 'at 20 s, offline is told apart from slow');
  assert.match(script, /You appear to be offline\. The researcher panel needs an internet connection\./);
  assert.match(script, /Anda tampaknya sedang offline\. Panel peneliti memerlukan koneksi internet\./);
});

test('the shell still passes its other pins: no refresh button, the staging ribbon untouched', () => {
  assert.doesNotMatch(html, /id="btn-refresh"/);
  assert.match(html, /id="fx-staging"/);
});
