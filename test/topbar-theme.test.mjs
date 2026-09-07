/* Seth, 2026-09-07, with the Consent Collector and the Audio Segmenter installed as apps: "let's
 * make sure our top heading bars match the title bar theme color." The window chrome of an installed
 * PWA is painted from theme-color; the in-app header was a hard-coded blue, so a violet or amber
 * title bar sat directly above a blue bar.
 *
 * The researcher panel already carried this fix alone (.rp-head, 2026-08-28). These tests keep the
 * generalised version honest: for every shell, the meta theme-color, the manifest's theme_color and
 * the --topbar the header actually paints with must be the SAME colour. Three places is two too many
 * to keep in step by hand, which is exactly why it drifted. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const CSS = rd('../docs/css/app.css');
const shells = ['../docs/index.html', '../paragraph-analysis/index.html',
  ...readdirSync(new URL('../satellites/', import.meta.url)).map((d) => `../satellites/${d}/index.html`)]
  .filter((p) => existsSync(new URL(p, import.meta.url)));

const themeOf = (h) => (h.match(/name="theme-color"\s+content="(#[0-9a-fA-F]{6})"/) || [])[1];
const topbarOf = (h) => (h.match(/--topbar:\s*(#[0-9a-fA-F]{6})/) || [])[1];
const inkOf = (h) => (h.match(/--topbar-ink:\s*(#[0-9a-fA-F]{6})/) || [])[1];

test('the header paints with the app\'s own colour, not a hard-coded blue', () => {
  assert.match(CSS, /#topbar \{\s*\n\s*background: var\(--topbar, var\(--blue\)\);/);
  assert.match(CSS, /color: var\(--topbar-ink, var\(--topbar, var\(--blue-dark\)\)\);/,
    'and so does the selected tab, which is that colour on white');
});

test('every shell with a coloured header declares --topbar, and it equals its theme-color', () => {
  let checked = 0;
  for (const p of shells) {
    const h = rd(p);
    if (!/id="topbar"/.test(h)) continue;          // the tool and the panel have their own headers
    const theme = themeOf(h), bar = topbarOf(h);
    assert.ok(theme, `${p}: no theme-color`);
    assert.ok(bar, `${p}: has the shared header but sets no --topbar`);
    assert.equal(bar.toLowerCase(), theme.toLowerCase(), `${p}: the bar and the window chrome disagree`);
    checked++;
  }
  assert.ok(checked >= 5, `expected every shared-header shell, saw ${checked}`);
});

test('the manifest agrees with the meta, so the installed app matches the browser tab', () => {
  for (const p of shells) {
    const h = rd(p);
    const theme = themeOf(h);
    const mref = (h.match(/rel="manifest"\s+href="([^"]+)"/) || [])[1];
    if (!theme || !mref) continue;
    const url = new URL(mref.replace(/^\//, ''), new URL(p.replace(/index\.html$/, ''), import.meta.url));
    if (!existsSync(url)) continue;
    const m = JSON.parse(readFileSync(url, 'utf8'));
    assert.equal(String(m.theme_color).toLowerCase(), theme.toLowerCase(), `${p}: manifest theme_color differs`);
  }
});

/* ⚠ CONTRAST IS PART OF THE CHOICE, not an afterthought: these bars carry white text, and the
 * selected tab puts the same colour on white. The crowd recorder's green is 4.08:1 on white — under
 * the 4.5 a 15px semibold label needs — which is why it, alone, sets --topbar-ink. */
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

test('white reads on every bar, and the tab label reads on white', () => {
  for (const p of shells) {
    const h = rd(p);
    if (!/id="topbar"/.test(h)) continue;
    const bar = topbarOf(h);
    // the title on the bar is large and bold: 3:1 is the bar it must clear
    assert.ok(ratio('#ffffff', bar) >= 3, `${p}: white on ${bar} is ${ratio('#ffffff', bar).toFixed(2)}:1`);
    // the selected tab's label is 15px/600 on white: 4.5:1
    const ink = inkOf(h) || bar;
    assert.ok(ratio(ink, '#ffffff') >= 4.5,
      `${p}: tab label ${ink} on white is ${ratio(ink, '#ffffff').toFixed(2)}:1 — set --topbar-ink darker`);
  }
});
