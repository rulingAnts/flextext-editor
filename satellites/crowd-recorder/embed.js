/* Embed helper for the FlexText crowd recorder. Site owners drop ONE tag into
 * their page (e.g. a website builder's custom-HTML block):
 *
 *   <script src="https://rulingants.github.io/crowd-recorder/embed.js"
 *           data-recorder="RECORDER_ID"></script>
 *
 * and this script replaces itself (well, follows itself) with an <iframe> of the
 * crowd recorder for that recorder id. Classic script on purpose (NOT a module):
 * document.currentScript is null inside modules, and builders' HTML blocks choke
 * on module semantics. The host page must allow the iframe microphone access —
 * we request it via the `allow` attribute, but a builder/CSP that strips
 * `allow="microphone"` breaks recording (see docs/crowd-recorder.md in the
 * editor repo). */
(function () {
  'use strict';
  var tag = document.currentScript;
  if (!tag) return; // re-executed / injected without a script context — nothing to anchor to
  var id = tag.getAttribute('data-recorder');
  if (!id) {
    console.warn('crowd-recorder embed.js: missing data-recorder="<id>" attribute — no recorder embedded.');
    return;
  }
  var f = document.createElement('iframe');
  f.src = 'https://rulingants.github.io/crowd-recorder/?c=' + encodeURIComponent(id) + '&embed=1';
  f.allow = 'microphone; autoplay';
  f.title = 'Voice recorder';
  f.style.cssText = 'width:100%;max-width:480px;height:640px;border:0;border-radius:12px';
  // Insert immediately after our own tag, so the recorder appears exactly where
  // the site owner placed the snippet.
  tag.parentNode.insertBefore(f, tag.nextSibling);
  // What makes this snippet BETTER than pasting the raw iframe: the recorder posts
  // its content height and we fit the frame to it (no fixed 640px box, no inner
  // scrollbars), and the page background is transparent so the host theme shows
  // through. Height messages carry no data and are matched to OUR frame + origin.
  window.addEventListener('message', function (e) {
    if (e.source !== f.contentWindow) return;
    if (e.origin !== 'https://rulingants.github.io') return;
    if (e.data && e.data.fxCrowd === 'height' && e.data.h > 0) f.style.height = Math.min(e.data.h, 1200) + 'px';
  });
})();
