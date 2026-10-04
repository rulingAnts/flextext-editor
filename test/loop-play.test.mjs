/* 🔁 REPEAT (Seth, 2026-10-04: "a way for a segment to play on loop … not the default behavior … set the
 * default in device settings (unpaired device OR researcher panel) … a toggle on the big/overview player
 * at the top, but when it's on, it applies to ALL play buttons, looping within the scope of that button …
 * engine wide"). The state lives on the shared Player; this drives it with a fake wavesurfer. */
/* ⚠ A PLAIN SCRIPT, NOT node:test — importing audio.js (for the real Player class) leaves a handle
 * open, and the test runner waits on a child that never exits. Same shape as guess-splits.test.mjs:
 * print, count, exit. Every other test only READS audio.js as text, which is why none of them hang. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Player, LOOP_MIN_LAP_S } from '../docs/js/audio.js';

let fail = 0;
const test = (name, f) => { try { f(); console.log(`  ok    ${name}`); } catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n')[0]}`); } };

const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
function fakeWs() {
  const ws = { t: 0, played: 0, paused: 0, seeks: [], handlers: {},
    duration: 60, isPlaying() { return true; }, getCurrentTime() { return ws.t; }, getDuration() { return ws.duration; },
    setTime(s) { ws.seeks.push(s); ws.t = s; },
    play() { ws.played++; return Promise.resolve(); }, pause() { ws.paused++; },
    on(ev, fn) { (ws.handlers[ev] ||= []).push(fn); return () => { ws.handlers[ev] = ws.handlers[ev].filter((f) => f !== fn); }; } };
  return ws;
}
function bare(loop) {
  const p = Object.create(Player.prototype);
  p.ws = fakeWs(); p.el = { loop: null }; p._loop = loop; p._spanTick = null; p._spanOff = null; p._spanHome = null;
  return p;
}

test('Repeat off: a line stops at its end and rewinds home, as it always has', () => {
  const p = bare(false);
  p.playSpan(1000, 3000, 1000);
  p.ws.t = 2.99; p.ws.handlers.timeupdate[0]();
  assert.equal(p.ws.paused, 1);
  assert.equal(p.ws.seeks.at(-1), 1, 'parked at home');
  assert.equal(p._spanTick, null, 'the watcher is dropped');
});

test('Repeat on: the line plays again from ITS start, the watcher stays, nothing pauses', () => {
  const p = bare(true);
  p.playSpan(1500, 3000, 1000);          // resumed mid-line: home is the line's start, not the click
  const tick = p.ws.handlers.timeupdate[0];
  p.ws.t = 2.99; tick();
  assert.equal(p.ws.paused, 0, 'not paused');
  assert.equal(p.ws.seeks.at(-1), 1, 'back to the LINE\'s start');
  assert.ok(p._spanTick, 'the watcher is kept for the next lap');
  p.ws.t = 2.995; tick();
  assert.equal(p.ws.seeks.length, 3, 'a lap per end: setTime(start) at play, then one per lap');
  p.pause();
  assert.equal(p.ws.paused, 1, 'pausing is the user\'s job (the same ▶ or Space) and it clears the span');
  assert.equal(p._spanTick, null);
});

test('bounded: a sliver of a line does not loop (it would be a seek per tick), an empty file does not spin', () => {
  const p = bare(true);
  p.playSpan(1000, 1000 + LOOP_MIN_LAP_S * 1000 - 50, 1000);   // shorter than the shortest lap
  p.ws.t = 1.3; p.ws.handlers.timeupdate[0]();              // past the sliver's end
  assert.equal(p.ws.paused, 1, 'falls back to stop-and-park');
  assert.equal(p._spanTick, null, 'and drops the watcher');
  const q = bare(true);
  q.ws.duration = 0.1; assert.equal(q.loopableDuration(), false, 'a 100 ms "recording" is not repeated from finish');
  q.ws.duration = 60; assert.equal(q.loopableDuration(), true);
  assert.equal(LOOP_MIN_LAP_S, 0.3);
});

test('setLoop/loop and the button reflect each other', () => {
  const p = bare(false);
  const attrs = {};
  p.el = { loop: { setAttribute: (k, v) => { attrs[k] = v; } } };
  p.setLoop(true); assert.equal(p.loop(), true); assert.equal(attrs['aria-pressed'], 'true');
  p.setLoop(0); assert.equal(p.loop(), false); assert.equal(attrs['aria-pressed'], 'false');
});

/* ── the wiring: dock, finish handler, device setting, strings ── */
const AUDIO = rd('../docs/js/audio.js'), APP = rd('../docs/js/app.js'), PANEL = rd('../docs/js/researcher-panel.js');
const I18N = rd('../docs/js/i18n.js'), CSS = rd('../docs/css/app.css');

test('the whole recording repeats from the finish handler, and the button is the Player\'s own', () => {
  assert.match(AUDIO, /this\.ws\.on\('finish', \(\) => \{\n\s+this\.el\.play\.textContent = '▶';\n[\s\S]{0,700}?if \(this\._loop && this\.loopableDuration\(\)\) \{\n\s+const again = Number\.isFinite\(this\._spanHome\) \? this\._spanHome : 0;/, 'the whole recording repeats only when it has a real length');
  assert.match(AUDIO, /loop: root\.querySelector\('\.player-loop'\),/);
  assert.match(AUDIO, /if \(this\.el\.loop\) this\.el\.loop\.addEventListener\('click', \(\) => this\.setLoop\(!this\._loop\)\);/);
  assert.match(AUDIO, /this\._loop = false;/, 'never the default');
  for (const shell of ['../docs/index.html', '../satellites/audio-segmenter/index.html']) {
    assert.match(rd(shell), /<button class="player-loop icon-btn2" data-i18n-title="player\.loop" data-i18n-aria="player\.loop"\n\s+aria-label="Repeat" aria-pressed="false">🔁<\/button>/, `${shell} carries the toggle on the dock`);
  }
  assert.match(CSS, /\.player-loop\[aria-pressed="true"\] \{/, 'on-state styling');
});

test('the device setting is the STARTING state, on both settings surfaces, and reported to the panel', () => {
  assert.match(APP, /function loopPlayDefault\(\) \{ return settings\.loopPlay === true; \}/);
  assert.match(APP, /p\.setLoop\?\.\(loopPlayDefault\(\)\);/, 'applied when a text opens (refreshPlayer\'s doc-switch branch)');
  const FIELD = "{ k: 'loopPlay', type: 'checkbox', note: 'panel.f.loopPlayNote' },";
  assert.ok(APP.includes(FIELD), 'unpaired Settings tab'); assert.ok(PANEL.includes(FIELD), 'researcher panel');
  assert.match(APP, /'glossBreak', 'loopPlay'\]\) \{/, 'in the snapshot the panel reads back');
  for (const k of ['player.loop', 'panel.f.loopPlay', 'panel.f.loopPlayNote', 'panel.rel.new.loopPlay']) {
    assert.equal((I18N.match(new RegExp(`'${k.replace(/\./g, '\\.')}': '`, 'g')) || []).length, 2, `${k} in EN and ID`);
  }
  assert.match(PANEL, /\{ k: 'panel\.rel\.new\.loopPlay' \},/);
});

console.log(fail ? `\nFAILED (${fail})` : '\nPASSED');
process.exit(fail ? 1 : 0);
