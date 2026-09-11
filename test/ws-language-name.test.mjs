/* #68: the language a writing-system code names, shown under the code box. A CHECK, never a fill.
 *
 * Seth, 2026-09-11: "What we want is the user to manually enter the writing system code, and then if
 * it matches a language that langtags.json recognizes, then display that language name after the ws
 * code box." And the rule every assertion below serves: "We don't want to make it easy for the user
 * to skip noticing and checking their writing system code. By offering something that looks
 * automatic but actually isn't."
 *
 * These drive the REAL functions against the REAL generated table. The wiring checks read code with
 * comments stripped, because a comment naming a function satisfies a search for it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseWsCode, languageNameIn, spellcheckTagFor, syncLanguageNames, WS_CODE_FIELDS } from '../docs/js/typing.js';
import NAMES, { LANGTAGS_DATE } from '../docs/js/vendor/langtags-names.js';

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
/* ⚠ A block comment only where one can start: at a line start or after whitespace. The naive
 * /\/\*[\s\S]*?\*\// took `accept="audio/*,.wav"` in researcher-panel.js for a comment opener and
 * deleted every line of code down to the next real comment's end, the text-field renderer included. */
const bare = (s) => s.replace(/(^|\s)\/\*[\s\S]*?\*\//g, '$1').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

test("Seth's own codes, as FLEx exported them, name their languages", () => {
  // Every code in his "99 Already In Flex" texts, read 2026-09-11.
  assert.equal(languageNameIn(NAMES, 'fau'), 'Fayu');
  assert.equal(languageNameIn(NAMES, 'fau-fonipa-x-etic'), 'Fayu');
  assert.equal(languageNameIn(NAMES, 'id'), 'Indonesian');
  assert.equal(languageNameIn(NAMES, 'en'), 'English');
});

test('the language is found inside any well-formed code', () => {
  assert.equal(languageNameIn(NAMES, 'fau-x-ipa'), 'Fayu');
  assert.equal(languageNameIn(NAMES, 'fau-Zxxx-x-audio'), 'Fayu');
  assert.equal(languageNameIn(NAMES, 'tpi-Latn-PG'), 'Tok Pisin');
  assert.equal(languageNameIn(NAMES, 'id-ID'), 'Indonesian');
  assert.ok(NAMES.ert, 'the table knows ert');
  assert.equal(languageNameIn(NAMES, 'ert-x-MTT'), NAMES.ert, 'private use keeps its case: real FLEx data carries ert-x-MTT');
});

test('no name for a code FLEx could not have written exactly as typed', () => {
  for (const code of ['FAU', 'Fau', 'fau-latn', 'id-id', 'iau_tmu', 'zh-yue', 'x-ipa', 'fau-', 'fau x', ' ', '', null, undefined]) {
    assert.equal(languageNameIn(NAMES, code), '', JSON.stringify(code));
  }
});

test('codes BCP-47 does not use get no name, so a wrong code never looks right', () => {
  // ind/eng are ISO 639-3 but FLEx writes id/en; in/iw are withdrawn; qaa–qtz names no language.
  for (const code of ['ind', 'eng', 'in', 'iw', 'qaa', 'qaa-x-kal']) assert.equal(languageNameIn(NAMES, code), '', code);
});

test("the table: SIL's names, one per language subtag, macrolanguages under their own name", () => {
  assert.match(LANGTAGS_DATE, /^\d{4}-\d{2}-\d{2}$/);
  const keys = Object.keys(NAMES);
  assert.ok(keys.length > 7000, `${keys.length} subtags`);
  assert.ok(keys.every((k) => /^[a-z]{2,3}$/.test(k)), 'every key is a bare language subtag');
  assert.equal(NAMES.ar, 'Arabic', 'not whichever Arabic variety an extended-language tag collided into ar');
  assert.equal(NAMES.zh, 'Chinese');
  assert.equal(NAMES.yue, 'Chinese, Yue');
  assert.equal(NAMES.tmu, 'Iau');
});

test('parseWsCode splits a code into its subtags', () => {
  assert.deepEqual(parseWsCode('fau-fonipa-x-etic'), {
    language: 'fau', extlang: [], script: '', region: '', variants: ['fonipa'], extensions: [],
    privateUse: ['etic'], canonicalCase: true,
  });
  const zh = parseWsCode('zh-Hans-CN');
  assert.equal(zh.script, 'Hans');
  assert.equal(zh.region, 'CN');
  assert.equal(zh.canonicalCase, true);
  assert.equal(parseWsCode('FAU').canonicalCase, false);
  assert.equal(parseWsCode('iau_tmu'), null);
  assert.equal(parseWsCode('x-ipa'), null, 'private use alone names no language');
});

test('the spellchecker gets the standard spelling of a real language, and nothing else', () => {
  assert.equal(spellcheckTagFor('id'), 'id');
  assert.equal(spellcheckTagFor('id-ID'), 'id-ID');
  assert.equal(spellcheckTagFor('sr-Latn'), 'sr-Latn');
  assert.equal(spellcheckTagFor('id-Latn-ID'), 'id-Latn-ID');
  for (const code of ['id-fonipa', 'fau-fonipa-x-etic', 'id-x-audio', 'qaa', 'qtz-x-kal', 'zh-yue', 'ID', 'en-a-bbb', 'iau_tmu', '', undefined]) {
    assert.equal(spellcheckTagFor(code), '', JSON.stringify(code));
  }
});

test('the name is painted under the box, and the box itself is never written', async () => {
  let value = 'fau';
  const input = {};
  Object.defineProperty(input, 'value', {
    get: () => value,
    set: () => { throw new Error('the name must never write into the code box'); },
  });
  const line = { textContent: '', hidden: true };
  const warning = { hidden: true };
  const root = {   // querySelector only: a sweep with querySelectorAll is banned in typing.js
    querySelector: (sel) => ({ '[data-langname="vernLang"]': line, '[data-sf="vernLang"]': input, '[data-langwarn]': warning }[sel] || null),
  };
  const label = (n) => `Language: ${n}`;
  await syncLanguageNames(root, 'data-sf', label);   // also proves typing.js finds the table on disk
  assert.equal(line.textContent, 'Language: Fayu');
  assert.equal(line.hidden, false);
  assert.equal(warning.hidden, false, 'a name never shows without the guess warning');
  value = 'FAU';
  await syncLanguageNames(root, 'data-sf', label);
  assert.equal(line.textContent, '');
  assert.equal(line.hidden, true);
  assert.equal(warning.hidden, true, 'and the warning goes when no name is showing');
});

test('both settings forms show the name under both code boxes, painted on fill and while typing', () => {
  const surfaces = [
    ['app.js (unpaired Settings tab)', bare(rd('../docs/js/app.js')), 'data-sf', 'form', 'ds'],
    ['researcher-panel.js (device settings)', bare(rd('../docs/js/researcher-panel.js')), 'data-f', 'box', 'rp'],
  ];
  assert.deepEqual(WS_CODE_FIELDS, ['vernLang', 'analLang'], 'the two writing-system code fields');
  for (const [name, src, attr, root, prefix] of surfaces) {
    for (const k of WS_CODE_FIELDS) {
      assert.match(src, new RegExp(`\\{ k: '${k}', type: 'text',`), `${name}: ${k} is a text box the researcher types into`);
    }
    assert.match(src, /function langNameLine\(f, prefix\) \{\s*if \(!WS_CODE_FIELDS\.includes\(f\.k\)\) return '';/,
      `${name}: the line is drawn for exactly those fields`);
    assert.match(src, new RegExp(`langNameLine\\(f, '${prefix}'\\)`), `${name}: the text-field renderer draws the line`);
    assert.match(src, new RegExp(`syncLanguageNames\\(box, '${attr}', wsLangLabel\\)`), `${name}: painted when the form is filled`);
    assert.match(src, new RegExp(`wireLanguageNames\\(${root}, '${attr}', wsLangLabel\\)`), `${name}: and kept live while typing`);
  }
});

test('a name never appears without the guess warning and its more-info link, on both forms', () => {
  // Seth, 2026-09-11: "if people see something come up, they'll assume it matches and is good to go."
  const panel = bare(rd('../docs/js/researcher-panel.js')), app = bare(rd('../docs/js/app.js'));
  const i18n = rd('../docs/js/i18n.js');
  assert.ok(i18n.includes("'panel.f.wsLangGuessWarn': 'Language names are a guess. You must check and manually match writing system codes in your FieldWorks database or things will break!'"),
    "the warning says it in Seth's words");
  assert.match(panel, /export function langGuessWarningHtml\(prefix, helpAttr\)/, 'one builder, shared by both forms');
  assert.match(panel, /data-langwarn hidden>/, 'hidden until a name shows');
  assert.match(panel, /⚠<\/span> \$\{esc\(t\('panel\.f\.wsLangGuessWarn'\)\)\} /, 'the triangle, then the warning');
  assert.match(panel, /\$\{esc\(t\('panel\.grp\.moreInfo'\)\)\}<\/button><\/p>/, 'then the more info link');
  for (const [name, src, help] of [['researcher-panel.js', panel, 'data-ghelp="wscodes"'], ['app.js', app, 'data-sact="wscodesHelp"']]) {
    assert.ok(src.includes(`? line + langGuessWarningHtml(prefix, '${help}') : line`), `${name}: the warning follows the last code box`);
  }
  assert.match(panel, /if \(b\.dataset\.ghelp === 'wscodes'\) wsCodesHelpModal\(\);/, 'panel: more info opens the writing-system codes help');
  assert.match(app, /if \(which === 'wscodesHelp'\) \{ wsCodesHelpModal\(\); return; \}/, 'Settings tab: so does its own');
});
