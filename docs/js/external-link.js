/* external-link.js — ONE WAY OUT OF THE APP, AND IT LEAVES.
 *
 * Seth, 2026-09-09: "my user just brought up an in-app browser (I think by clicking on the GitHub
 * link or something). That's not supposed to be possible. Can you make sure that our app has all
 * offsite hyperlinks open in such a way that Android OS will direct them to the default browser in
 * a new app window and fail if that's blocked?"
 *
 * ⚠ WHY AN IN-APP BROWSER IS A SAFETY BUG HERE, not a cosmetic one. These devices are managed, and
 * the filtering that governs them is applied to the DEFAULT BROWSER. A Chrome Custom Tab opened by
 * an installed PWA is a browser that never passes through it — so a link the app renders becomes a
 * way around the accountability the device is under. The requirement is therefore not "open it
 * nicely", it is "hand it to the OS, and if the OS refuses, LET IT FAIL". A fallback to an in-app
 * view would defeat the whole point, so there is deliberately no fallback.
 *
 * ⚠ target="_blank" IS NOT ENOUGH, which is what the report proves: all twenty offsite links in
 * this suite already had it. In an installed PWA (WebAPK) Chrome answers an off-origin _blank with
 * a Custom Tab — an in-app browser wearing the app's own colours.
 *
 * WHAT ACTUALLY LEAVES: an `intent://` URL. Android resolves it through the ordinary VIEW intent —
 * the default browser, in its own task — and with NO `S.browser_fallback_url` there is nothing for
 * it to fall back to, so a device that blocks browsing simply does nothing. That is the required
 * failure mode, stated out loud rather than discovered.
 *
 * ⚠ UA SNIFFING IS CORRECT HERE and is pre-approved (Seth, 2026-09-08: "sometimes UA sniffing is
 * actually a good way to get at that, especially if it's a capability that really is Android/mobile
 * specific"). `intent://` is Android-only by construction — there is no capability to feature-detect. */

export function isAndroid() {
  return typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent || '');
}

/* True for anything that is not this app's own origin. Relative and same-origin URLs are the app's
 * own navigation and must be left completely alone. */
export function isOffsite(url) {
  try {
    const u = new URL(String(url), location.href);
    if (!/^https?:$/.test(u.protocol)) return false;   // mailto:, tel:, blob:, data: — not ours to route
    return u.origin !== location.origin;
  } catch { return false; }
}

/* An Android VIEW intent for an http(s) URL, with NO browser_fallback_url.
 *
 * ⚠ A URL WITH ITS OWN FRAGMENT PRODUCES TWO `#`, AND THAT IS FINE — Android's Intent.parseUri
 * looks for the literal marker `#Intent;`, so it splits at the second hash and the original
 * fragment survives as part of the data URI. It is written down because it looks wrong at a glance
 * and someone will otherwise "fix" it by stripping the fragment, which would silently break any
 * deep link to a section. No offsite link in the suite carries a fragment today; the first one
 * that does is worth confirming on a real device.
 *
 * ⚠ Nothing here can reach an INVITE link (`…?invite=…#k=…`), whose fragment carries key material:
 * invites are same-origin, so isOffsite() returns false and they never enter this function. Keep it
 * that way — an invite must never be handed to another app. */
function intentUrl(u) {
  const url = new URL(u);
  const rest = url.href.slice(url.protocol.length + 2);   // strip "https://"
  return 'intent://' + rest + '#Intent;scheme=' + url.protocol.replace(':', '')
       + ';action=android.intent.action.VIEW;end';
}

/* The only sanctioned way to send someone offsite. Returns true if a hand-off was attempted. */
export function openExternal(url) {
  if (!isOffsite(url)) return false;
  if (isAndroid()) {
    /* A top-level assignment is what Chrome intercepts to fire the intent; the page itself does not
     * navigate. If nothing can handle it — a kiosk, a blocked browser — nothing happens, which is
     * exactly the outcome asked for. */
    try { location.href = intentUrl(url); return true; } catch { return false; }
  }
  // Desktop and iOS: a normal new window/tab is the OS's own browser already.
  try { window.open(url, '_blank', 'noopener,noreferrer'); return true; } catch { return false; }
}

/* ⚠ DELEGATED, ON CAPTURE, ON document — so it covers every offsite <a> in the suite including the
 * ones rendered from i18n HTML strings and the ones inside views that re-render themselves. A rule
 * that had to be remembered at each of twenty call sites is a rule that will be missed at the
 * twenty-first. Install once, at startup, in every app. */
export function wireExternalLinks(root = document, opts = {}) {
  /* ⚠ A PAIRED DEVICE HAS NO WAY OFF THE SITE AT ALL (Seth, 2026-09-09: "paired devices should have
   * NO clickable hyperlinks that lead off the site"). Handing the URL to the OS is the right answer
   * for somebody working alone on their own phone; it is NOT the right answer on a device a
   * researcher manages, where the link is simply an exit that should not exist. Unpaired devices
   * keep the links — that is somebody's own machine and none of our business.
   *
   * `allowOffsite` is a PREDICATE, evaluated per click, not a value captured at wiring time: the
   * app wires this at startup, long before a device knows whether it is paired, and a device can be
   * paired or released while the page is open. */
  const allowOffsite = opts.allowOffsite || (() => true);
  root.addEventListener('click', (e) => {
    const a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (!isOffsite(href)) return;
    e.preventDefault();          // in BOTH cases — the app itself never navigates offsite
    if (!allowOffsite()) { if (opts.onBlocked) opts.onBlocked(a.href); return; }
    openExternal(a.href);
  }, true);
}

/* ─────────────────────────────────────────────────────────────────────────────
 * ZERO ESCAPE HOLES ON A PAIRED DEVICE (Seth, 2026-09-09: "I don't want there to be ANY escape hole
 * in the hyperlinks that can end up opening a web browser on another site (or an in app browser)").
 *
 * ⚠ INTERCEPTING `click` IS NOT ENOUGH, and this is the whole reason this function exists rather
 * than just the handler above. A link can be followed without ever firing a `click`:
 *   • middle-click, and Ctrl/Cmd+click, fire `auxclick` — a different event
 *   • long-press (Android) or right-click → "Open link in new tab" is the BROWSER's own menu and
 *     never reaches JavaScript at all
 *   • drag-and-drop of a link, and keyboard menus, likewise
 * Each of those is a separate hole, and a list of holes is not a guarantee.
 *
 * So we do not defend the link — we REMOVE it. An <a> with no href is not a link by definition:
 * nothing to click, nothing to middle-click, no context menu entry, no keyboard activation, no
 * drag target. One removal closes every vector at once, including the ones nobody has thought of.
 *
 * ⚠ THE LINK GOES, THE WORDS STAY (Seth, 2026-09-09, settling it: "I think copyright notice and
 * license with no links should display. But no links"). Removing the href is what closes the
 * middle-click and long-press holes; rendering the remains as ordinary text is what stops it
 * looking like something to press. The footer therefore still reads its licence notice in full —
 * "free, open-source software (AGPL-3.0). © 2026 Seth Johnston. Source & contributions welcome on
 * GitHub." — with nothing clickable anywhere in it.
 *
 * The href is stashed on the element, so a device that is later released gets its links back.
 *
 * On the licence notice: the footer carries the AGPL-3.0 link and the source credit, and hiding a
 * licence notice would normally be a compliance question. It is not one here — Seth is the sole
 * copyright holder of this work, the notices remain in the source and on every unpaired device and
 * on the public site, so this is a presentation choice by the licensor rather than a licensee
 * stripping someone else's notice.
 *
 * ⚠ A MutationObserver, because the views re-render. The Paragraph Analysis Tool rebuilds its whole
 * UI on every edit, help text arrives from i18n HTML strings, and the gloss view repaints per
 * keystroke — a one-shot pass at startup would protect only the first paint. */
export function enforceNoOffsiteLinks(isPaired, root = document) {
  const strip = (el) => {
    const links = el.querySelectorAll ? el.querySelectorAll('a[href], area[href]') : [];
    for (const a of links) {
      const href = a.getAttribute('href');
      if (!isOffsite(href)) continue;
      a.dataset.offsiteHref = href;          // remembered, so releasing the device restores it
      a.removeAttribute('href');
      a.removeAttribute('target');
      a.classList.add('offsite-off');
    }
  };
  const restore = (el) => {
    for (const a of el.querySelectorAll('a.offsite-off[data-offsite-href], area.offsite-off[data-offsite-href]')) {
      a.setAttribute('href', a.dataset.offsiteHref);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer external');
      delete a.dataset.offsiteHref;
      a.classList.remove('offsite-off');
    }
  };

  if (enforceNoOffsiteLinks._obs) { enforceNoOffsiteLinks._obs.disconnect(); enforceNoOffsiteLinks._obs = null; }
  const host = root.body || root;
  if (!isPaired) { restore(host); return; }

  strip(host);
  /* Re-strip whatever appears later. Attribute changes matter too: a re-render can set href on an
   * element that already existed. */
  const obs = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes' && r.target) strip(r.target.parentNode || host);
      for (const n of r.addedNodes || []) if (n.nodeType === 1) { strip(n); if (n.matches && n.matches('a[href], area[href]')) strip(host); }
    }
  });
  obs.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
  enforceNoOffsiteLinks._obs = obs;
}
