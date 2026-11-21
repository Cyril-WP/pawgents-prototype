# Pawgents — prototype

> Throwaway prototype by Webpuppies (21 Nov 2026). It answers one question: can a one-line embed on a client's site turn real visitor errors into a tested draft pull request, safely?

**Live demo:** https://cyril-wp.github.io/pawgents-prototype/ · break the shop at https://cyril-wp.github.io/pawgents-prototype/demo-shop/

## Put it on a site

```html
<script src="https://cyril-wp.github.io/pawgents-prototype/embed/pawgents.js"
        data-relay="https://YOUR-RELAY.workers.dev/js"></script>
```

As high in `<head>` as possible. Visitors see nothing. Add `?pawgents` to any page to see what was caught there.

| Attribute | Effect |
| --- | --- |
| `data-relay` | Where reports go. Without it nothing leaves the page (demo mode). |
| `data-site` | Site id the relay maps to a repo. Default: the page's host. |
| `data-release` | Deploy version, so the fixer reads the right code. |
| `data-friendly="true"` | Visitors get a calm "we have been told" note when something breaks. |
| `data-panel="always"` | Owner panel for everyone (demos). |

WordPress: copy `wordpress/pawgents-watch.php` to `wp-content/mu-plugins/` and set `PAWGENTS_RELAY_URL` and `PAWGENTS_SECRET` in `wp-config.php`. It adds PHP crash capture and the browser beacon.

## The loop

1. **Catch** — `embed/pawgents.js`: script errors, unhandled promises, failed requests, broken files. Secrets, emails, JWTs and card numbers are removed in the browser. The last 12 visitor steps travel with the report.
2. **Relay** — `relay/worker.js` (Cloudflare Worker): checks origin (browser) or HMAC (WordPress, Sentry/GlitchTip), redacts again, fingerprints, allows one fix attempt per problem per 24 h, maps site to repo, sends `repository_dispatch`.
3. **Fix** — `.github/workflows/pawgents-fix.yml`: `anthropics/claude-code-action@v1` writes a failing test, the smallest fix, runs tests three times, opens a **draft** PR labelled `pawgents`, or an issue when it cannot reproduce. Never merges. Without an `ANTHROPIC_API_KEY` secret the run records the report in its summary and stops.

## Run it locally

```sh
npm run demo                                   # shop on :8732, relay on :8787, dry run
GITHUB_TOKEN=$(gh auth token) npm run demo     # really dispatches to Cyril-WP/pawgents-prototype
npm run smoke                                  # relay checks: signatures, dedupe, origin, redaction
```

Open http://localhost:8732/demo-shop/ and break something. `demo-shop/cart.js` contains a real bug (unpublished product breaks the cart total) for the fixer to fix.

## Known limits

- The Sentry webhook field paths in `relay/worker.js` are unconfirmed; capture one real delivery first.
- Dedupe lives in KV per relay; a busy site needs a per-site daily budget too.
- Browser reports are unauthenticated by nature; the relay only accepts them for known sites with a matching `Origin`.
