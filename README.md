# TabFit

Describe what you're working on, choose a 25, 50 or 90 minute session, and let Jev check whether the page you're viewing supports that goal. Clear distractions get a reversible focus screen. Ambiguous pages stay accessible.

TabFit is a standalone Manifest V3 browser extension that checks whether each page supports your current task and blocks clear distractions. It needs no build step to load: a pinned copy of Mozilla PDF.js and its supporting assets is bundled for local PDF reading, and the Instrument Sans and JetBrains Mono typefaces are bundled so the popup and focus screen never fetch web fonts. The popup, focus screen and notices follow your system's light or dark appearance. No server, native helper or Node installation is needed to use the extension.

![Focus-session setup](preview/setup.png)

## Get started

You need Chrome 125 or newer (or a compatible Chromium browser such as Helium) and your own TypeSafe API key. Requests are billed to your TypeSafe account.

### 1. Load the extension

1. Open `chrome://extensions` in your browser.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this project's **`extension`** folder (the folder containing `manifest.json`).
4. Pin **TabFit** using the extensions menu.

### 2. Save your TypeSafe API key

Open TabFit, click **Add API key** in the top-right corner to open **Settings & privacy**, enter your key in **TypeSafe API key**, and click **Save settings**. The field clears after saving and displays a saved-key placeholder. Leaving it blank on later saves keeps your existing key; entering another key replaces it. **Remove** deletes it and pauses any active session.

The **Saved** status confirms local storage, not provider authentication. Saving a key and opening the popup make no API requests. Your first page check verifies that TypeSafe accepts the key. Authentication failures explain how to update it, and pages stay accessible.

The extension's background worker calls Jev directly over HTTPS. There is no terminal, background server, connection code or separate helper installation.

### 3. Focus

Describe a concrete task, for example “Build the authentication flow for my React app,” choose a duration, and click **Start focus**. Your current tab is checked, including tabs opened before the extension was loaded. Navigating, switching tabs, and client-side route changes trigger new checks; changing content is sampled every 30 seconds during a session.

- **On task:** the page stays accessible.
- **Off task:** a focus screen covers the page. Go back, allow this particular page for this session, or end the session.
- **Uncertain:** the page stays accessible with a dismissible notice.
- **PDF unreadable:** scanned, password-protected, oversized, damaged or inaccessible PDFs stay open with an extraction-specific message. Jev is not called without readable PDF text.
- **Pause:** removes all blocks and stops checks; the remaining session time is preserved.
- **End session or timer expiry:** removes all blocks and clears session decisions and overrides.
- **API failure:** pages remain accessible, with an actionable notice. Failures apply a 30-second cooldown before more requests, and the notice keeps showing the original cause during that delay.

Notices appear in the **top-right corner** and are shown only during a confirmed active session. Ending, pausing or reaching the session deadline clears them. If a content script loses its extension connection (for example after an update), it clears its UI and old session state quietly instead of repeatedly showing “TabFit is unavailable.”

An override applies to the exact URL, including its query and fragment, for this session. It survives reloading the page, and does not allow the whole website. Ending the session clears it.

### Updating an installed copy

After pulling changes, open `chrome://extensions` (or `helium://extensions`) and click **Reload** on TabFit. Your saved API key, privacy settings and last goal are preserved; reloading clears the running session.

When upgrading from the gateway/helper version, enter your TypeSafe key once in **Settings & privacy**. Old `.env` files are not imported automatically. Version 0.4 removes the gateway, helper installer and native messaging permission. Any old standalone gateway can be stopped, and the old helper's browser registration can be removed; neither is used by this version.

## PDF text extraction

During a session, a PDF opened in the browser's built-in viewer is downloaded from that tab's original URL and parsed locally with bundled [Mozilla PDF.js](https://mozilla.github.io/pdf.js/). This also supports PDF responses whose URL does not end in `.pdf`. The original site may receive its existing login cookies and query parameters for the download; TypeSafe never receives those URL parameters or the PDF file itself. Redirected downloads are rejected. Excluded domains are checked before downloading.

The reader extracts at most **4,000 characters from the first 10 pages**, with a **12 MB download limit** and **12-second reading timeout**. Jev receives the excerpt and a description of its page coverage. PDF scripts and forms are not executed. There is no OCR: image-only scans cannot be classified from their images, and password-protected files are not unlocked. An unreadable document is kept accessible rather than classified from a filename alone.

The extension temporarily keeps at most eight PDF excerpts in service-worker memory for five minutes to avoid repeated downloads. Failures can be retried after 30 seconds. This cache is never written to extension storage and is cleared on pause, session end, settings changes, extension reload or worker shutdown. Late extraction results are checked against the current session and tab before anything is sent to Jev.

## What leaves the browser

Only eligible active tabs are inspected, during running focus sessions. The background worker sends an HTTPS request directly to the TypeSafe API containing:

- The focus goal, up to 600 characters.
- The page's origin and path, up to 1,500 characters. Query strings, fragments and URL credentials are not sent.
- The title (200 characters), description (350), and up to 4,000 characters of text, preferring the main article or main region for webpages, or the first pages for PDFs.

Form controls, forms, editable regions, hidden elements, scripts and navigation are omitted from the text excerpt. This is minimization, not a guarantee that a page contains no personal information: titles, descriptions, paths and visible text can still be sensitive. Add email, banking, internal work tools or other private sites to **Never check these sites**. A domain exclusion includes all its subdomains and applies before content is extracted.

Email and sign-in domains are excluded by default. Private windows, IP addresses, local hostnames, common internal suffixes and browser-internal pages are excluded. There are no screenshots, browser-history reads, analytics or raw page-text logs. The extension doesn't retain raw page payloads after the bounded in-memory processing described above. TypeSafe's own data handling applies to requests it receives.

The API key, exclusions, last focus goal and selected duration are stored locally in Chrome, accessible only to extension-owned contexts. They are not synced. Current session state, hashes of page evidence, decisions, exact-page override hashes and the last checked hostname are held in `chrome.storage.session`, so they survive a worker suspension but are cleared on browser restart, extension reload or session completion. Page excerpts and full URLs are never stored in extension storage. Your API key is stored in `chrome.storage.local` with access restricted to trusted extension contexts. Popup state responses expose only whether a key is saved; they never return its value. Content scripts and websites cannot read the key through extension storage or messaging. The key is sent only in the Authorization header to TypeSafe. Browser storage is not an OS keychain; someone with access to your browser profile or the extension itself may retrieve it. No shared developer key is bundled with the extension.

The TypeSafe endpoint is fixed in code. Requests omit cookies and referrers, reject redirects, bound response size, and never forward raw provider error bodies. Page checks are cancelled when you pause, finish, remove the key or change settings. No requests are made without a saved key and an active session.

## How decisions work

The background worker calls `POST https://api.typesafe.ai/v1/systemone` with `model: "jev-latest"` and one `Choice` question: `on_task`, `off_task` or `uncertain`. It supplies the goal separately from page evidence and instructs Jev to treat page text as data, not instructions. A work-related video or social post can be on task; the site's general category is not enough to block it.

Only a valid `off_task` answer with probability at least **0.85** blocks. An `on_task` answer needs at least **0.70** to be shown as on task. Everything else is uncertain and allowed. These are provisional product thresholds, not measured accuracy claims. Test on representative tasks and browsing examples before treating the judgments as reliable. The displayed reason is a fixed explanation of the classification; it is not a model-generated rationale.

Decisions are cached for five minutes against the session, exact page identity and extracted evidence, with at most 100 entries. Matching concurrent requests share one call. Page changes and session transitions invalidate outdated results. The API client performs at most one delayed retry for 429/529 responses and uses an 11-second provider timeout. It allows at most four concurrent requests and 60 checks per minute while the worker is running; TypeSafe also enforces its own limits. The default model is `jev-latest`.

API contracts: [TypeSafe HTTP API](https://docs.typesafe.ai/api), [Choice](https://docs.typesafe.ai/primitives/choice), [confidence](https://docs.typesafe.ai/confidence). Browser implementation: [Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts), [session storage](https://developer.chrome.com/docs/extensions/reference/api/storage), [navigation events](https://developer.chrome.com/docs/extensions/reference/api/webNavigation).

## Development and verification

Development commands require Node.js 22 or newer.

```sh
npm test
npm run check
```

The dependency-free tests cover probability validation, data minimization, exclusions, cache restoration, request deduplication, overrides, pause/resume, expiry, navigation and session races, API authentication failures, fixed-endpoint requests, rate limits, invalid model replies, cancellation and provider timeouts. PDF tests cover download limits, excerpt limits, unreadable files, query-string minimization and stale extraction results. Provider responses are fixtures; these tests do not measure live Jev accuracy.

An optional browser smoke test uses Playwright and a Chromium build that accepts unpacked extensions:

```sh
# Install Playwright separately if it isn't already available.
npm install --no-save --package-lock=false playwright
npx playwright install chromium
node tests/browser-smoke.mjs
```

`PLAYWRIGHT_MODULE` can point to an existing Playwright module, and `CHROMIUM_PATH` can select a Chromium executable. The smoke test opens a fresh temporary browser profile and extension copy, replaces the fixed TypeSafe endpoint in that copy with a local mock provider, and exercises direct background-worker requests with fake API keys. It also serves synthetic pages and real compressed PDF fixtures locally. It does not use your browsing profile or call TypeSafe. Screenshots go to `test-results/`. `PDF_FIXTURE_PATH` can optionally select a local résumé PDF containing the word “inference” for the on-task PDF fixture.

Verified locally: unit tests, manifest/syntax checks, and browser smoke checks in an isolated Helium profile. Browser checks include key save/replace/removal, persistence across browser restart, blank-field preservation, denial of content-script storage and popup-action access, no synced credentials, session lifecycle, blocks and overrides, PDFs, late replies, provider failures, and extension reloads. A live request directly from a Helium extension worker using Jev 1.13.0 also allowed a synthetic React authentication tutorial. These checks verify integration behavior, not general model accuracy.

To refresh the bundled PDF.js assets after changing the pinned development dependency:

```sh
npm ci --ignore-scripts --omit=optional
npm run vendor:pdfjs
npm run check
```

The vendoring script copies the matching legacy API/worker builds, character maps, standard fonts and licenses into `extension/vendor/pdfjs`. No remotely hosted JavaScript is loaded at runtime. PDF.js 6.4.299 requires Node 22.13+ for dependency tooling; its legacy browser build supports Chrome 125+.

`extension/vendor/fonts` holds the latin and latin-ext subsets of Instrument Sans and JetBrains Mono (variable weight, from `@fontsource-variable/instrument-sans` and `@fontsource-variable/jetbrains-mono`); versions are in `VERSION` and the SIL Open Font License in `LICENSE`. The popup loads them with `@font-face`. Shadow roots ignore `@font-face`, so the focus screen asks the background worker for the font data and registers it with the FontFace API; the files are not web-accessible resources.

Files:

```text
extension/manifest.json  Chrome permissions and entry points
extension/background.js Session coordination, settings and private key access
extension/jev-client.js  Direct TypeSafe requests, cancellation and error handling
extension/session.js    Session lifecycle, cache and stale-result protection
extension/core.js       Page validation, Jev rubric and decision thresholds
extension/content.js    Text extraction and reversible focus screen
extension/pdf-client.js Session-scoped PDF reader coordination and memory cache
extension/pdf-reader.js Bounded PDF download and text extraction
extension/pdf-offscreen.* Hidden document hosting the local PDF.js worker
extension/vendor/pdfjs/ Pinned PDF.js runtime assets and licenses
extension/vendor/fonts/  Bundled Instrument Sans, JetBrains Mono and licenses
extension/popup.*        Focus-session, API key and privacy settings
tests/                  Unit, HTTP integration and browser smoke checks
```

## Prototype limits

This is a self-control aid. It covers a loaded page rather than preventing its network requests, and can be bypassed by disabling the extension. Pages stay usable while they are checked, so an off-task page is visible until Jev answers, usually a second or two, before the focus screen appears. Main-document audio/video is paused when the screen appears; embedded frame media and Web Audio are not controlled. Images, canvas content, cross-origin frames and transcripts that aren't in the readable DOM are not analyzed. PDFs are sampled from their first pages; scans, encrypted files and PDFs embedded inside unrelated webpage viewers may not be readable. Some protected Chrome pages cannot run content scripts.

Broad HTTP/HTTPS site access is required to inspect arbitrary browsing during a session. This version is for local unpacked use. A public release needs the Chrome Web Store privacy and permission review. Each user supplies their own TypeSafe API key; a shared product key must not be shipped in an extension.

No live TypeSafe call is required for the automated checks. Verify live behavior with your own key and representative pages before relying on automatic blocking.
