/* EVERY HOST SAYS THE SAME THING TO CRAWLERS, AND A NEW APP CANNOT SHIP WITHOUT SAYING IT.
 *
 * Seth, 2026-09-23: the landing page should be easy to find — "I'd like people searching for a
 * tool like FlexText Editor to find it easily" — while the apps themselves are not for crawling,
 * and the search engines, social platforms and AI crawlers of states that police what their people
 * may read are asked to stay away. Seth is explicit that this is a courtesy layer and not a defence:
 * "The security of the app doesn't depend on hiding it from search engines and bots" — it is worth
 * asking anyway, and worth costing nothing when the answer is ignored.
 *
 * ⚠ A robots.txt IS ONLY READ AT A HOST'S ROOT, and this suite has eight hosts built from seven
 * different directories. A file in docs/ covers the editor and is inert on the satellites, where it
 * lands under /flextext-editor/. So the guard below is structural: it reads each app's build.sh,
 * finds the directory that becomes that host's root, and requires a robots.txt there. A new app
 * added to apps/ fails this test until it has one.
 *
 * Run: node --test test/robots-txt.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const has = (p) => existsSync(new URL(p, root));

/* The directory each app's build copies to the root of its host: `cp -R ../../<dir>/. public/`. */
function rootDirOf(app) {
  const build = read(`apps/${app}/build.sh`);
  const m = /cp -R \.\.\/\.\.\/(.+?)\/\. public\//.exec(build);
  return m && m[1];
}

const APPS = readdirSync(new URL('apps/', root), { withFileTypes: true })
  .filter((d) => d.isDirectory() && has(`apps/${d.name}/build.sh`))
  .map((d) => d.name);

test('every host built from apps/ has a robots.txt at the directory that becomes its root', () => {
  assert.ok(APPS.length >= 6, `found the apps (${APPS.join(', ')})`);
  for (const app of APPS) {
    const dir = rootDirOf(app);
    assert.ok(dir, `apps/${app}/build.sh copies a directory to the host root`);
    assert.ok(has(`${dir}/robots.txt`), `${dir}/robots.txt exists — it is ${app}'s root robots.txt`);
  }
});

test('the Paragraph Analysis Tool ships its own, and its build copies it', () => {
  assert.ok(has('paragraph-analysis/robots.txt'));
  /* ⚠ PAT copies an EXPLICIT file list rather than a whole directory, so a file that is not named
   * in that line never reaches the host — the one way this could be written and still be absent. */
  assert.match(read('paragraph-analysis/build.sh'),
    /cp index\.html manifest\.webmanifest sw\.js robots\.txt public\//,
    'robots.txt is in the copied root files');
});

const FILES = ['docs/robots.txt', 'paragraph-analysis/robots.txt',
  ...APPS.map(rootDirOf).filter(Boolean).map((d) => `${d}/robots.txt`)]
  .filter((p, i, a) => a.indexOf(p) === i);

test('each one refuses the same crawlers, by their real tokens', () => {
  for (const f of FILES) {
    const t = read(f);
    for (const ua of ['Baiduspider', 'Sogou web spider', '360Spider', 'Yisouspider', 'PetalBot',
                      'Bytespider', 'Yandex', 'YandexBot', 'Mail.RU_Bot', 'vkShare',
                      'GPTBot', 'ClaudeBot', 'CCBot', 'Google-Extended', 'Applebot-Extended']) {
      assert.match(t, new RegExp(`^User-agent: ${ua.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'),
        `${f} names ${ua}`);
    }
    /* ⚠ BOTH YANDEX LINES. Yandex documents that "Yandex" is read by their whole fleet EXCEPT the
     * main indexer, which reads only "YandexBot" — one line alone leaves half the fleet crawling. */
    assert.ok(/^User-agent: Yandex$/m.test(t) && /^User-agent: YandexBot$/m.test(t), `${f} names both`);
  }
});

test('the crawlers that make the site findable are never refused', () => {
  /* ⚠ ANCHORED, because Applebot-Extended contains "Applebot" and Google-Extended is not Googlebot.
   * Those two ARE refused (they are the AI training agents) and their search counterparts must not
   * be — an unanchored test would pass while the site quietly vanished from search. */
  for (const f of FILES) {
    const t = read(f);
    for (const ua of ['Googlebot', 'Bingbot', 'DuckDuckBot', 'Applebot', 'Slurp']) {
      assert.doesNotMatch(t, new RegExp(`^User-agent: ${ua}$`, 'm'),
        `${f} does not name ${ua} — it is never in a refused group`);
    }
  }
});

test('the editor opens its documentation and nothing else; the rest open nothing', () => {
  const editor = read('docs/robots.txt');
  const general = editor.slice(editor.indexOf('User-agent: *'), editor.indexOf('# ── States'));
  assert.match(general, /^Disallow: \/$/m, 'the app itself is not for crawling');
  assert.match(general, /^Allow: \/help\/$/m, 'but the documentation is');
  assert.match(editor, /^Sitemap: https:\/\/flextext\.app\/sitemap\.xml$/m,
    'and it names the sitemap that lists those pages — what lets a sitemap on one host speak for this one');

  for (const f of FILES.filter((x) => x !== 'docs/robots.txt')) {
    const t = read(f);
    const general2 = t.slice(t.indexOf('User-agent: *'), t.indexOf('# ── States'));
    assert.match(general2, /^Disallow: \/$/m, `${f} closes the app`);
    assert.doesNotMatch(general2, /^Allow:/m, `${f} opens nothing: these hosts have no pages to read`);
  }
});
