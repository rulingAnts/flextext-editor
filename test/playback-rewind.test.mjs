/* Playback ALWAYS rewinds to the start of what was playing when it reaches the end.
 *
 * WHY THIS TEST EXISTS (Seth's v331 test round): "when it reaches the end of the selected audio
 * waveform/player (end of segment or end of file), it should rewind to the start. Right now it
 * restarts from wherever the playhead was last placed by a click."
 *
 * The cause was subtle and would come back the moment anyone touched playSpan. The strip buttons
 * RESUME from a parked playhead — click halfway down a segment, press ▶, and playback starts there
 * — by calling `playSpan(clickPosition, seg.end)`. v326's "a finished span rewinds to its own
 * start" then rewound to `startMs`, which in that call IS the click position. So the segment
 * replayed from halfway forever, and the whole-file player rewound nowhere at all.
 *
 * The fix separates "where playback starts" from "where it goes home to" (the third argument), and
 * gives the whole-file player a home of 0 via the 'finish' event. Both halves are asserted here:
 * the span behaviour by driving a fake wavesurfer, the 'finish' wiring structurally (registering it
 * needs a real WaveSurfer over a real DOM container, which node has not got).
 *
 * Run: node test/playback-rewind.test.mjs
 */
import { readFileSync } from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

/* ---- minimum DOM for importing audio.js + constructing a Player ---- */
const stubEl = () => ({
  style: {}, classList: { add() {}, remove() {} }, hidden: false, textContent: '', value: '',
  addEventListener() {}, querySelector: () => stubEl(), getBoundingClientRect: () => ({ left: 0, width: 100 }),
});
globalThis.window = globalThis.window || { addEventListener() {}, location: { hostname: 'localhost', search: '' } };
globalThis.document = globalThis.document || {
  querySelector: () => null, createElement: () => stubEl(), addEventListener() {},
};

const { Player } = await import('../docs/js/audio.js');

/* A wavesurfer stand-in that records everything the transport does to it. */
function fakeWs() {
  const handlers = {};
  return {
    calls: [], time: 0, handlers,
    on(ev, fn) { (handlers[ev] ||= []).push(fn); return () => { handlers[ev] = handlers[ev].filter(h => h !== fn); }; },
    un(ev, fn) { handlers[ev] = (handlers[ev] || []).filter(h => h !== fn); },
    emit(ev, ...a) { (handlers[ev] || []).slice().forEach(h => h(...a)); },
    setTime(s) { this.time = s; this.calls.push(['setTime', s]); },
    getCurrentTime() { return this.time; },
    getDuration() { return 10; },
    play() { this.calls.push(['play']); this.emit('play'); },
    pause() { this.calls.push(['pause']); },
    isPlaying() { return false; },
  };
}
const mkPlayer = () => {
  const p = new Player(stubEl(), { labels: {}, onPeaks() {}, onRemove() {} });
  p.ws = fakeWs();
  return p;
};
// Advance the fake transport and fire the timeupdate the span watcher listens on.
const tickTo = (p, seconds) => { p.ws.time = seconds; p.ws.emit('timeupdate'); };

console.log('\na segment resumed from a parked playhead goes home to the SEGMENT');
{
  const p = mkPlayer();
  p.playSpan(2500, 4000, 2000);        // clicked at 2.5s inside the 2.0–4.0s segment
  ok(p.ws.time === 2.5, 'playback starts at the click, not at the segment start');
  tickTo(p, 3.0);
  ok(p.ws.time === 3.0, 'mid-span ticks leave the transport alone');
  tickTo(p, 3.99);
  ok(p.ws.time === 2.0, 'reaching the end rewinds to the SEGMENT start, not to the click');
  ok(p.ws.calls.some(c => c[0] === 'pause'), 'and pauses there');
  ok(!p._spanTick && !p._spanOff, 'the span watcher is unsubscribed once it has fired');
  tickTo(p, 9.9);
  ok(p.ws.time === 9.9, 'a dead watcher cannot pause a later continuous play');
}

console.log('\nomitting the home argument keeps the old behaviour (home == start)');
{
  const p = mkPlayer();
  p.playSpan(2000, 4000);
  tickTo(p, 3.99);
  ok(p.ws.time === 2.0, 'rewinds to the span start');
}

console.log('\nthe whole file goes home to 0 — via the finish handler, so the SOURCE is checked');
{
  const src = readFileSync(new URL('../docs/js/audio.js', import.meta.url), 'utf8');
  const finish = src.match(/this\.ws\.on\('finish', \(\) => \{[\s\S]*?\n    \}\);/);
  ok(!!finish, "the 'finish' handler is findable");
  const body = finish ? finish[0] : '';
  ok(/setTime\(Number\.isFinite\(home\) \? home : 0\)/.test(body),
     'it seeks to the span home when there is one, and to 0 for the whole file');
  ok(/if \(this\._rewound\) return;/.test(body),
     'and defers to the span watcher, which already rewound (a span ending at the file end hits both)');
  ok(/this\.ws\.on\('play', \(\) => \{[^}]*this\._rewound = false;/.test(src),
     "_rewound is reset on every 'play', so the guard is per playback run");
  ok(/this\._rewound = true;/.test(src), 'and the span watcher sets it when it rewinds');
}

console.log('\nevery resume-from-playhead call site passes the real start as home');
{
  const strips = readFileSync(new URL('../docs/js/segment-strips.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../docs/js/app.js', import.meta.url), 'utf8');
  const resumes = [...strips.matchAll(/playSpan\(from,[^)]*\)/g)].map(m => m[0]);
  ok(resumes.length === 2, 'both strip transports found (baseline + gloss), got ' + resumes.length);
  ok(resumes.every(c => /seg\.start\)/.test(c)), 'both pass seg.start as home: ' + resumes.join(' | '));
  const space = app.match(/playSpan\(inside \? at : [^)]*\)/);
  ok(!!space && /lastPlayTarget\.start\)$/.test(space[0]),
     'the Space key resumes in span but goes home to the segment: ' + (space ? space[0] : 'NOT FOUND'));
}

console.log(fail ? `\n${fail} FAILED\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
