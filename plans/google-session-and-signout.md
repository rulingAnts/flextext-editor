# Signing out of the app cannot sign anyone out of Google (SHIPPED, v686)

**Status: shipped 2026-09-22 in v686.** The client half is in `docs/js/researcher-panel.js` +
`docs/js/i18n.js`; the one-parameter half is in `worker/src/v1.js` and needs a WORKER deploy to take
effect. Pinned by `test/google-session-truth.test.mjs`. The same section is appended to this
machine's `notes/auth-google-signin-plan.md`, which is gitignored — this file is the tracked copy.

## The hazard, and why no amount of code fixes it

Our sign-out ends this app's session and nothing else. The Google session in that browser survives
it, so on a shared, public or lab computer the next person can open Gmail or Drive as the researcher
who just signed out. Our sign-out looked complete and was not.

**The app cannot fix this by signing them out of Google, and that is not a gap to engineer around.**
Measured against `accounts.google.com/.well-known/openid-configuration` on 2026-09-22:

| advertised? | what it does |
|---|---|
| `end_session_endpoint` | **not advertised** — Google does not support RP-initiated logout |
| `frontchannel_logout_supported` / `backchannel_logout_supported` | **not advertised** |
| `revocation_endpoint` | `https://oauth2.googleapis.com/revoke` — revokes OUR tokens, not their browser session |

No site may end another site's session in any case; that is the browser's rule. Nor is this
Google-specific — signing out of an application never signs you out of the identity provider, the
same with Cloudflare Access, Microsoft or GitHub. So the copy speaks of signing in with an account,
and the key names (`panel.signin.sharedNote`, `panel.signout.*`) name no provider.

**What v686 ships instead — the three things actually available:**
1. A warning ABOVE the "Sign in with Google" button, never behind a disclosure. It also says to
   leave "stay signed in" unticked, because our OWN long session compounds the hazard:
   `staySignedIn()` puts the token in localStorage and the server session becomes 90 days sliding,
   against 24 hours in sessionStorage when unticked.
2. The same truth on the screen a sign-out lands on, with a link to Google's account settings — and
   a choice on the deliberate sign-out: the panel only, or on to Google's own sign-out page.
3. `prompt=select_account consent` on the authorization request. ⚠ BOTH values: dropping `consent`
   stops the refresh token coming back, and that refresh token IS the Drive connection
   (`drive_refresh_enc` → `driveAccessToken`). ⚠ NOT `prompt=login`: a forced re-authentication on
   every sign-in is paid over village connections by everyone, to protect the minority on a
   borrowed machine.

**Measured about Google's own sign-out URL before shipping a link to it** — a discovery document
states an intention, only a request states a fact:
- `accounts.google.com/Logout` answers 302 and ends on Google's own "Sign in — Google Accounts"
  page, which gives the same advice we do ("Not your computer? Use a private browsing window").
- `?continue=` pointing at one of our hosts is refused with **400**, so that page can never bring
  anyone back to the panel.
- It is Google's UI, not an API, so the copy says it OPENS Google's page and promises no outcome.
  Whether it ends a LIVE session cannot be tested from a session holding no Google cookies: that
  one check belongs to a human in a signed-in browser.
- It is a CHOICE, never a consequence. On someone's own laptop, signing them out of every Google
  service would be hostile.
- Both Google links are ordinary offsite `<a>` elements, so `external-link.js` routes them — an
  `intent://` VIEW on Android, so the DEFAULT BROWSER opens them in its own task rather than a
  Custom Tab inside the PWA — and a PAIRED device has them removed with every other offsite link.
  ⚠ The profile is the point, not the window: an installed PWA shares cookies with the browser it
  was installed from, so a Google sign-out clears the session this app uses only when it happens
  there.

Pinned by `test/google-session-truth.test.mjs`, including the sentence that must never be written
("…signs you out of Google", in either language).
