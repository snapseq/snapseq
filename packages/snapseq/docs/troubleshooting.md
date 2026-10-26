# Troubleshooting

Symptom, cause, fix. Error text is quoted as the terminal prints it.

## Injected styles do nothing

**Symptom.** Animations still run after `disableTransitions`, or
`addPersistentStyle` / `page.addStyleTag` throws. With `stabilize` on, every
sequence on that site fails before its body with `snapseq: stabilize threw in begin: …`.
**Cause.** The site's `Content-Security-Policy` has a strict `style-src`, which
rejects an injected `<style>` element. `stabilize`'s `motion` step injects the same
element in every sequence.
**Fix.** `use: { bypassCSP: true }` for that site, on the env or composed over
the config ([Config](config.md#overriding-playwright-options)). Or turn the step off
with `stabilize: { motion: false }` ([Config](config.md#stabilize)).

## ReferenceError: __name is not defined

**Symptom.** A `page.evaluate` fails inside the page with that error.
**Cause.** A named function (`function helper() {}`, or a method) was defined
inside the evaluated callback. `tsx` and esbuild wrap named functions in a
`__name()` helper that exists in Node, not in the page.
**Fix.** Arrow functions only inside `page.evaluate`, `locator.evaluate` and
`addInitScript`.

## The sequence dies 10 minutes after its last shot, inside an evaluate

**Symptom.** `No shot for 10 min.` in the live terminal view (the list
reporter prints `Test timeout of …ms exceeded.`), and the stack points into a
`page.evaluate`.
**Cause.** The callback awaited a DOM event (`seeked`, `load`, a custom event)
that never fired. `page.evaluate` has no timeout of its own, so the sequence
waits until the shot timeout ends it.
**Fix.** Race every in-page wait against a timer.
[Example 8](examples.md#8-a-state-that-arrives-later) shows the pattern.

## A page that works in a browser shows a 403 or an error page in the shot

**Cause.** Headless Chromium announces itself as `HeadlessChrome`, and some
WAFs and APIs reject that token. Snapseq rewrites it to `Chrome` unless
`userAgent` is set in the config.
**Fix.** If you set `userAgent` yourself, keep it realistic. If the page's own
API calls fail, see the CORS entry below and [Example 9](examples.md#9-an-api-without-cors-on-dev).

## `playwright install chromium` hangs

**Cause.** Node 26. The browser archive extraction deadlocks.
**Fix.** Run the install under Node 20 or 22 (`nvm use 22`), once per machine.
Sequences themselves run under any supported Node.

## A `goto` times out after 120 s

**Symptom.** `page.goto: Timeout 120000ms exceeded.`
**Cause.** Usually `waitUntil: "networkidle"` on a page that polls, streams or
keeps a socket open: it never goes idle. Or a dev server doing a cold build.
**Fix.** Drop `networkidle` and wait for what the shot needs, a locator or a
heading, after the `goto`. For a slow build, warm the server before the run or
raise `navigationTimeout` on the env's `use`.

## The terminal says a wait ran out

**Symptom.** A line like `snapseq: 03.png taken with 2 images still loading after 5 s (first: http://…/hero.jpg)  http://…`,
or the same line with `font readiness still pending after 5 s` or `DOM still changing after 3 s (most changed: div#ticker)` as the note.
**Cause.** The readiness wait hit its cap and took the shot anyway. Images:
a stalled or very slow asset, the first one named. Fonts: a face that never
arrives, or a page whose load event is still pending. DOM: something mutates
the document every frame, a clock, a ticker, an infinite loader; the note names
the element that changed most.
**Fix.** The shot may be fine; check it. If not, hide or stop the moving part
with `addPersistentStyle`, route the stalled asset with `page.route`, or wait
for the specific state before the shot. [Sequences](sequences.md#readiness) lists
what the wait does and does not see.

An image in the initial HTML that never answers is the exception: it holds the
page's load event, which Playwright's screenshot waits for. Where the sequence
fails depends on its `goto`:

- A plain `goto(url)` waits for the load event, so it fails at the navigation
  timeout (120 s by default) with no readiness note.
- `goto(url, { waitUntil: "domcontentloaded" })` gets past the navigation. The
  sequence then fails at the shot, with the notes at the end of its message
  (`page.screenshot: Timeout 30000ms exceeded. … ; readiness: 1 image still
  loading after 5 s (first: http://…/hero.jpg)`), so the image is named.

The `timeout` screenshot option (`seq.snap({ timeout: 5000 })`) only makes the
sequence fail sooner. To make it pass, answer the URL: a `page.route` in
the sequence, before the `goto`, that aborts it
(`page.route("**/hero.jpg", (route) => route.abort())`; the shot then notes one
image that failed to load) or fulfills it with a small image of your own.

## The terminal says `N images failed to load (first: …)`

**Cause.** An image the shot shows finished loading with no pixels: a 404, a
file that is not an image, or a URL the browser blocks, such as one with a
user and password in it. Hidden images do not count. The note names the first
one, without its query.
**Fix.** Open the URL from the note. Fix the URL or answer it with
`page.route`; if the shot does not need the image, hide it with
`addPersistentStyle`.

## The terminal says `the page scrolls inside <…> not the document: scrollable content may be omitted`

**Cause.** The page is about one screen tall to the document, and its content
scrolls inside an element: `html` and `body` at 100% height with `overflow:
hidden`, a scrolling `main`. A taller viewport shows nothing more, so
`snapPage` takes the device's viewport and names the element.
**Fix.** `snap({ fullPage: true })` shows the viewport only too. If the layout
allows, let the content flow in the document for the shot, then `snapPage`:
`addPersistentStyle(page, "html, body, main.content { height: auto !important; overflow: visible !important }")`.
Otherwise shoot it section by section, scrolling the element between shots:
`await page.locator("main.content").evaluate((el) => el.scrollBy(0, el.clientHeight))`.

## The terminal says `scroll pass stopped after N steps`

**Cause.** `stabilize` with `scroll: true` scrolls a native full page
(`snap({ fullPage: true })`) from its top to its end, to wake lazy content, and
stops at 60 steps or 5 s. The page is longer than that, or grows as it
scrolls, like an infinite feed.
**Fix.** Check the lower part of the shot. For a feed, take the part you need:
scroll to it yourself and `snap()`. See [Config](config.md#scroll).

## The terminal says `cannot read <url>: its viewport units stay live`

**Cause.** `stabilize` could not read the rules of a stylesheet from
another origin, so its viewport units were not frozen. The note is on every
shot taken while the sheet is unreadable. It fetches such a sheet again
as a CORS request; that fails when the server refuses, the sheet redirects, a
script imports it with `@import`, or a `replay` entry or HAR route serves it.
A `100vh` section from that sheet can make `snapPage` refuse the page, and the
refusal ends with this note.
**Fix.** Serve the stylesheet without a redirect, or from the page's own
origin. If the page does not depend on that sheet's viewport units, ignore the
note. See [Config](config.md#viewport-units).

## `snapPage: the document grew from … px after the viewport was set to its height`

**Cause.** The page's layout follows the viewport height: `100vh` sections, a
footer or loader pinned to the page end. Every taller viewport makes it taller
again, so no viewport could ever contain it. Or the device has `isMobile:
true` and the page has no viewport meta, or a fixed-width one: the layout
viewport scales with the grown viewport ([Config](config.md#devices)), and
`stabilize` does not change that. When the shot has notes before the
refusal, `stabilize`'s (such as `cannot read <url>`) or a
readiness note (such as `DOM still changing after 3 s`), the message ends with
`Notes: …`.
**Fix.** `stabilize` freezes viewport-height units to px before the viewport
grows, so a `100vh` section stays one screen tall. It is on by default: check
that the config has neither `stabilize: false` nor `stabilize: { viewportUnits: false }`
([Config](config.md#stabilize)). If the page is still refused, something
`stabilize` cannot freeze follows the viewport
([what it does not do](config.md#what-stabilize-does-not-do)); use
`seq.snap({ fullPage: true })` for that page, Playwright's native full page.
Sticky elements stay pinned where the scroll left them. For `isMobile` on a
page without a viewport meta, use `snap({ fullPage: true })` or a device
without `isMobile`.
[Example 6](examples.md#6-a-sticky-tray) shows both.

## A sticky bar sits mid-page in a full-page shot

**Cause.** `seq.snap({ fullPage: true })` keeps the viewport, so a sticky or
fixed element is drawn where the current scroll position pins it.
**Fix.** `seq.snapPage()`, which grows the viewport so sticky elements rest in
flow and a tray lands in its slot.

## A shot caught an animation mid-frame

**Cause.** `stabilize` is off (`stabilize: false` or `motion: false`), and
`disableTransitions` was not called, or was called after the `goto` of a later
document, and the motion comes from the Web Animations API, which the readiness
wait cannot see.
**Fix.** Leave `stabilize` on, as it is by default: its `motion` step finishes or
cancels Web Animations before each shot and turns transitions off, so a sequence
need not call `disableTransitions` ([Config](config.md#motion)). With it off, call
`disableTransitions(page)` once at the top of the sequence, before the first
`goto`. For Web Animations API motion, wait for the element's final
state with a locator, or `await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))` raced against a timer.

## An element that fades in is missing from the shot

**Cause.** `disableTransitions` sets `animation: none`. That leaves an element
at its base state, so a `.hero` with base `opacity: 0` and
`animation: fadeIn 1s forwards` stays hidden.
**Fix.** `stabilize`'s `motion` step, on by default, instead of
`disableTransitions`: it finishes the animation, so a `forwards` fade-in ends
visible. Take the `disableTransitions` call out of the sequence. Or
`addPersistentStyle(page, ".hero { opacity: 1 !important }")`, or the page's own
revealed class.

## Basic auth credentials are not sent, or are sent to the wrong host

**Cause.** Sent to the resolved host's origin only, `--host` included. A
redirect to a second origin gets none, and an `origin` set on the env wins over
`--host`.
**Fix.** For a redirect, set `origin` to the origin that challenges. With
`--host`, drop a fixed `origin`. See [Config](config.md#envs).

## `snapseq: unknown env "…"`

**Cause.** `--env` or `SNAPSEQ_ENV` names an env that is not in `envs`. The
message lists the available ones.
**Fix.** Use a listed name, or `--env ""` for the default.

## `snapseq: --run must be …` or `SNAPSEQ_RUN must be …`

**Cause.** The run name contains a slash or backslash, or is `.` or `..`, or `--run` is empty. The
run's sequence directories are wiped, so the name may not point outside the
screenshots dir.
**Fix.** A plain name: `--run review-1` or `SNAPSEQ_RUN=review-1`.

## `snapseq: no snapseq.config.ts in …; pass -c <path>`

**Cause.** The current directory has no `snapseq.config.{ts,mts,cts,js,mjs,cjs}`
and `-c` was not given, or, in an orchestration run, `-c` names a folder without one.
**Fix.** Run from the app's directory, or pass `-c <path>`.

## `snapseq: no sequence matches "…"`

**Cause.** A filter word selected no sequence id. A word is an id (`cll/dosing`)
or a glob over ids (`'cll/*'`), matched against the whole id and case-sensitively;
`cll` alone is not the folder's sequences, and `dosing` is not a substring. The
lines under the message say what it may have meant: a folder, an orchestration, ids
that differ only in case, ids that end in or contain the word, else every id.
**Fix.** Use the id or the glob the message suggests, or `snapseq` alone for
everything. A regular expression or `file:42` goes after `--`.
See [Running](running.md#running).

## `snapseq: … is not a sequence file; quote a glob so the shell leaves it`

**Cause.** The word names a file that exists, other than a sequence file in
`sequencesDir` (in a repair, other than any sequence file). Usually an unquoted glob
that your shell expanded into file names before snapseq saw it, because the working
directory holds a matching folder. For a file inside `sequencesDir` the message ends
with the glob over ids to quote.
**Fix.** Quote the glob: `pnpm snapseq 'cll/*'`. (Stock zsh also stops with `no
matches found` for an unquoted glob that matches nothing.)

## `snapseq: <flag> requires a value`

**Cause.** A flag that takes a value (`--env`, `--host`, `--device`, `--run`, `-c`,
`--config`) is the last argument. Often `--env $ENV` with an empty `ENV`: the
word vanishes.
**Fix.** `--env staging` or `--env=staging`. Quote a variable that may be
empty, `--env "$ENV"`: an empty `--env` or `--host` means unset.

## `snapseq: --record must be 1 or 0, got ""`

**Cause.** `--record=` with nothing after the equals sign, often an empty
variable (`--record=$FLAG`). The flag refuses it, since a bare `--record`
records; an empty `SNAPSEQ_RECORD` means unset.
**Fix.** `--record` to record, `--record=0` to replay, or leave the flag out.
`--record 0` with a space is not the same: it records, and `0` is read as a
sequence word, so the run stops with `snapseq: no sequence matches "0"` unless a
sequence is named `0`, and then it records that one.

## `snapseq: numbering must be zeros, like "00", not "…"`

**Cause.** The config's `numbering` holds anything but zeros, or is empty.
**Fix.** Zeros only; their count is the width. `"000"` gives `001.png`.

## `snapseq: a device name must be a directory name, not a path: "…"`

**Cause.** A key in `devices` is empty, has a slash or backslash, or is `.` or
`..`. The device name is a directory that gets wiped.
**Fix.** A plain key: `phone`, `"300x250"`.

## `snapseq: a shot is already in progress; await each snap before the next`

**Cause.** A `snap` or `snapPage` started before the previous one resolved: a
missing `await` or a `Promise.all`. A shot still running when the body returns
gives `a shot was still being taken when the sequence ended; await each snap`.
**Fix.** Await each shot.

## `snapPage: the page has no viewport size`

**Cause.** The device sets `viewport: null`, so the page has no fixed size to
grow from.
**Fix.** Give the device a `viewport`, or use `snap({ fullPage: true })` for
that device.

## `snapseq: refusing to wipe …: not inside …`

**Cause.** A `describe` or test title with `..` in it points the sequence's
directory outside the screenshots dir, or a symlink inside the screenshots dir
(`a symlink leads it to …`) does. That directory is wiped when the sequence
starts, so snapseq refuses.
**Fix.** Plain titles, no `..`. Replace the symlink with a real folder; the
screenshots dir itself may be a symlink.

## `snapseq: refusing to wipe …: … writes inside it; rename one of the sequences`

**Cause.** One sequence's directory sits inside another's. `home.seq.ts` on
device `mobile` writes `home/mobile/`; `home/mobile.seq.ts` on `desktop`
writes `home/mobile/desktop/`, and so does every sequence under `home/mobile/`.
A sequence's directory is wiped when it starts, so snapseq refuses first,
naming the id of the sequence that writes inside it (`home/mobile`), and nothing
is deleted. On a file system that ignores case (macOS, Windows), `home/Mobile.seq.ts`
writes into the same folder once its output exists, and is named the same way. A subfolder a step made in it, such as `labelled/`, is wiped with the
rest.
**Fix.** Rename one of the sequences so its name is not a device's, such as
`home/mobile-menu.seq.ts`.

## `snapseq: --repeat-each and retries are not supported`

**Cause.** A second run of the same sequence would wipe and overwrite the
first run's numbered shots.
**Fix.** Run again with a new run directory instead. For a flaky step, wait
for the state the shot needs rather than retrying the sequence.

## `snapseq: the Playwright config must come from snapseq's defineConfig()`

**Cause.** The sequence ran under a config that did not come from
`defineConfig`, usually the wrong `-c <path>` or a plain Playwright
config picked up from the directory.
**Fix.** Point the command at `snapseq.config.ts`, and pass extra Playwright
options as a second argument to snapseq's `defineConfig`. See
[Config](config.md#overriding-playwright-options).

## The dev server starts although one is already running, or never starts

**Cause.** The readiness check is Playwright's: a 2xx, 3xx or 400–403 at
`host` after redirects means "already up". A server on another port, or one
answering 404 or 5xx at the root, does not count. With a `--host` or
`SNAPSEQ_HOST` different from the env's `host` the command never starts, by
design.
**Fix.** Make `host` match where the server listens, or start the server
yourself and pass `--host`. `DEBUG=pw:webserver` shows the server's output.

## No live terminal view, just one line per shot

**Cause.** Stdout is not a terminal, or a flag or variable turned the view off;
[Running](running.md#the-terminal) lists them.
**Fix.** None needed; the list output has the same information. For the frame,
run in a terminal without piping. Words instead of marks (`ok`, `FAIL`) mean
the terminal cannot draw them; `NO_COLOR` drops colors on purpose.

## `snapseq: no replay file for …`

The env has a `replay` entry whose file does not exist yet. Record it with
`pnpm snapseq --record` against a host where the request succeeds
(`--host` points the env there for that one run), check the shot, and keep
the file. See [Config](config.md#replay).

## `snapseq: --record got … not written`

**Cause.** The live response was not a 2xx or not JSON (a 403 from a bot check,
an HTML error page). Saving it would replay it as a 200 on every later run, so
the sequence fails at that request (shots already taken stay) and the existing
file is left as it was for that response.
**Fix.** Record against a host where the request succeeds (`--host`). A page
that renders a 4xx on purpose needs `page.route` or a HAR. See
[Config](config.md#replay).

## `snapseq: replay file … is not JSON: …`

**Cause.** A replay file does not parse as JSON, usually after a hand edit (a
trailing comma, a cut-off paste). Replay serves it as `application/json`, so the
page's widget would break without a word. The message ends with the parser's
reason and position. The sequence stops before its first shot.
**Fix.** Correct the file, or record it again with `pnpm snapseq --record`.
See [Config](config.md#replay).

## `snapseq: --record: … matched a second request …; … already written from …`

**Cause.** One `replay` pattern matched two different requests in one device's
run, and both would write the same file. One file holds one response, so a
different method, URL or POST body counts as a second request: a search for
"lamps" and then one for "chairs" at the same URL. A glob like `**/api/search`
matches any host, so a third-party request can match too; a cache-busting query
differs on every request and counts as a second URL. A `FormData` body is
compared without its random boundary, so the same form sent twice is one
request. When the method and URL are the same, the message ends with `(the
bodies differ)`.
**Fix.** When the API has a host of its own, pin the pattern to it, and to
the query when it matters (`https://api.example.com/search?q=shoes`). When the
API is same-origin and you record with `--host`, a pinned pattern never
matches: keep the glob and tighten its path or query until only your request
matches, or record one request per file. POSTs to one URL that differ by body
cannot be split by pattern (Playwright routes by URL, and the later pattern
answers them all): record one, serve the other with a `page.route` that checks
`route.request().postData()`, or use a HAR. See [Config](config.md#replay).

## `snapseq: host must be an http(s) URL` or `SNAPSEQ_RECORD must be 1 or 0`

**Cause.** The resolved host (`host`, `--host`, `SNAPSEQ_HOST`) has no
`http://` or `https://`, so `localhost:3000` is read as a scheme. Or
`SNAPSEQ_RECORD` holds something other than `1`, `true`, `0`, `false` or empty
(`--record=<value>` sets it).
**Fix.** `http://localhost:3000`; `SNAPSEQ_RECORD=1` to record, unset to replay.

## The whole widget is missing on dev, present on staging

**Cause.** CORS. The dev page on localhost calls an API that sends no
`access-control-allow-origin` for that origin, so the browser drops the
response.
**Fix.** Re-serve the API through `page.route` on dev.
[Example 9](examples.md#9-an-api-without-cors-on-dev).
