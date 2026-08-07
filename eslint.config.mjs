/* ESLint config with ONE job: no-undef.
 *
 * ⚠ THIS EXISTS BECAUSE A ReferenceError SHIPPED. v292 added recordingProvenance(), which called
 * `agcOn()`; the real function is `effectiveAgc()`. Every file parsed, all 28 suites passed, the app
 * loaded — and RECORDING WAS COMPLETELY BROKEN. The take was captured, then lost behind
 * "Conversion failed: agcOn is not defined". `node --check` cannot see it (the code is
 * syntactically perfect) and no node test could reach it (the failure is inside a DOM-and-microphone
 * path). It reached staging. The same class nearly shipped once before, when convertToMp3 was
 * swapped out of an import while two other call sites still used it.
 *
 * RUN IT BEFORE ANY RELEASE:
 *     npx eslint docs/js
 *
 * The globals list below is the whole maintenance cost: a new platform API has to be added to it.
 * That is deliberate — adding a name is a two-second decision, and finding a ReferenceError from a
 * field report is not. Never add a name here to silence a genuine miss.
 */
export default [
  // Vendored third-party bundles (lamejs, libflac, wavesurfer) are minified and not ours to fix.
  { ignores: ['docs/js/vendor/**'] },
  {
  files: ['**/*.js'],
  languageOptions: {
    ecmaVersion: 2023, sourceType: 'module',
    globals: Object.fromEntries([
      'window','document','navigator','location','console','fetch','URL','URLSearchParams','Blob','File',
      'FileReader','FormData','Headers','Request','Response','AbortController','setTimeout','clearTimeout',
      'setInterval','clearInterval','requestAnimationFrame','cancelAnimationFrame','localStorage',
      'sessionStorage','indexedDB','caches','crypto','performance','Audio','Image','AudioContext',
      'webkitAudioContext','OfflineAudioContext','MediaRecorder','AudioWorkletNode','Worker','TextEncoder',
      'TextDecoder','btoa','atob','alert','confirm','prompt','history','screen','matchMedia','DOMParser',
      'XMLSerializer','Node','Element','HTMLElement','Event','CustomEvent','KeyboardEvent','MouseEvent',
      'PointerEvent','ResizeObserver','IntersectionObserver','MutationObserver','structuredClone',
      'WaveSurfer','Flac','lamejs','self','globalThis','process','queueMicrotask','ImageData','OffscreenCanvas',
      'AbortSignal','getComputedStyle','parent','AudioWorkletProcessor','registerProcessor','BroadcastChannel',
      'CSS','innerWidth','innerHeight',
    ].map((g) => [g, 'readonly'])),
  },
  linterOptions: { reportUnusedDisableDirectives: false },
  rules: { 'no-undef': 'error' },
}];
