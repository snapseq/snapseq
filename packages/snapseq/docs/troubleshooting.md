# Troubleshooting

Symptom, cause, fix. Error text is quoted as the terminal prints it.

## Injected styles do nothing

**Symptom.** Animations still run after `disableTransitions`, or
`addPersistentStyle` / `page.addStyleTag` throws.
**Cause.** The site's `Content-Security-Policy` has a strict `style-src`, which
rejects an injected `<style>` element.
**Fix.** `use: { bypassCSP: true }` for that site, on the env or composed over
the config. See [Config](config.md#overriding-playwright-options).

## ReferenceError: __name is not defined

**Symptom.** A `page.evaluate` fails inside the page with that error.
**Cause.** A named function (`function helper() {}`, or a method) was defined
inside the evaluated callback. `tsx` and esbuild wrap named functions in a
`__name()` helper that exists in Node, not in the page.
**Fix.** Arrow functions only inside `page.evaluate`, `locator.evaluate` and
`addInitScript`.

## The capture dies 10 minutes after its last shot, inside an evaluate

**Symptom.** `No shot for 10 min.` and the stack points into a `page.evaluate`.
**Cause.** The callback awaited a DOM event (`seeked`, `load`, a custom event)
that never fired. `page.evaluate` has no timeout of its own, so the capture
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
Captures themselves run under any supported Node.

## A `goto` times out after 120 s

**Symptom.** `page.goto: Timeout 120000ms exceeded.`
**Cause.** Usually `waitUntil: "networkidle"` on a page that polls, streams or
keeps a socket open: it never goes idle. Or a dev server doing a cold build.
**Fix.** Drop `networkidle` and wait for what the shot needs, a locator or a
heading, after the `goto`. For a slow build, warm the server before the run or
raise `navigationTimeout` on the env's `use`.

## `shots.txt` says a wait ran out

**Symptom.** A line like `03.png  http://…  2 images still loading after 5 s`,
`fonts still loading after 5 s` or `DOM still changing after 3 s`, printed
once in the terminal too.
**Cause.** The readiness wait hit its cap and took the shot anyway. Images:
a stalled or very slow asset. Fonts: a face that never arrives. DOM: something
mutates the document every frame, a clock, a ticker, an infinite loader.
**Fix.** The shot may be fine; check it. If not, hide or stop the moving part
with `addPersistentStyle`, route the stalled asset with `page.route`, or wait
for the specific state before the shot. [Captures](captures.md#readiness) lists
what the wait does and does not see.

## `snapPage: the document grew from … px after the viewport was set to its height`

**Cause.** The page's layout follows the viewport height: `100vh` sections, a
footer or loader pinned to the page end. Every taller viewport makes it taller
again, so no viewport could ever contain it.
**Fix.** `seq.snap({ fullPage: true })` for that page, Playwright's native full
page. Sticky elements stay pinned where the scroll left them.
[Example 6](examples.md#6-a-sticky-tray) shows both.

## A sticky bar sits mid-page in a full-page shot

**Cause.** `seq.snap({ fullPage: true })` keeps the viewport, so a sticky or
fixed element is drawn where the current scroll position pins it.
**Fix.** `seq.snapPage()`, which grows the viewport so sticky elements rest in
flow and a tray lands in its slot.

## A shot caught an animation mid-frame

**Cause.** `disableTransitions` was not called, or was called after the
`goto` of a later document and the motion comes from the Web Animations API,
which the readiness wait cannot see.
**Fix.** Call `disableTransitions(page)` once at the top of the capture, before
the first `goto`. For Web Animations API motion, wait for the element's final
state with a locator, or `await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))` raced against a timer.

## Basic auth credentials are not sent, or are sent to the wrong host

**Cause.** `httpCredentials` are offered to the configured host's origin only.
A site that redirects to another origin behind the same password, or a
`--host` override on a different origin, is another origin.
**Fix.** An overridden host counts as the origin automatically. For a redirect,
set Playwright's `origin` on the credentials to the origin that challenges.
See [Config](config.md#envs).

## `snapseq: unknown env "…"`

**Cause.** `--env` or `SNAPSEQ_ENV` names an env that is not in `envs`. The
message lists the available ones.
**Fix.** Use a listed name, or `--env ""` for the default.

## `snapseq: SNAPSEQ_RUN must be a directory name, not a path`

**Cause.** The run name contains a slash, or is `.` or `..`. The run's capture
directories are wiped, so the name may not point outside the screenshots dir.
**Fix.** A plain name: `SNAPSEQ_RUN=review-1`. The same rule applies to
device names in `devices`.

## `snapseq: --repeat-each and retries are not supported`

**Cause.** A second run of the same capture would wipe and overwrite the
first run's numbered shots.
**Fix.** Run again with a new run directory instead. For a flaky step, wait
for the state the shot needs rather than retrying the capture.

## `snapseq: the Playwright config must come from snapseq's defineConfig()`

**Cause.** The capture ran under a config that did not come from
`defineConfig`, usually the wrong `-c <path>` or a plain Playwright
config picked up from the directory.
**Fix.** Point the command at `snapseq.config.ts`, and pass extra Playwright
options as a second argument to snapseq's `defineConfig`. See
[Config](config.md#overriding-playwright-options).

## The dev server starts although one is already running, or never starts

**Cause.** The readiness check is Playwright's: a 2xx, 3xx or 400–403 at
`host` after redirects means "already up". A server on another port, or one
answering 404 or 5xx at the root, does not count. With `--host` or
`SNAPSEQ_HOST` the command never starts, by design.
**Fix.** Make `host` match where the server listens, or start the server
yourself and pass `--host`. `DEBUG=pw:webserver` shows the server's output.

## No live terminal view, just one line per shot

**Cause.** Stdout is not a terminal (CI, a pipe, `| tee`), or the run used
`--list`, `--debug` or `PWDEBUG`, or `TERM=dumb`. Those get Playwright's list
reporter instead.
**Fix.** None needed; the list output has the same information. For the frame,
run in a terminal without piping. Words instead of marks (`ok`, `FAIL`) mean
the terminal cannot draw them; `NO_COLOR` drops colors on purpose.

## `snapseq: no replay file for …`

The env has a `replay` entry whose file does not exist yet. Record it with
`pnpm screenshot --record` against a host where the request succeeds
(`--host` points the env there for that one run), check the shot, and keep
the file. See [Config](config.md#replay).

## The whole widget is missing on dev, present on staging

**Cause.** CORS. The dev page on localhost calls an API that sends no
`access-control-allow-origin` for that origin, so the browser drops the
response.
**Fix.** Re-serve the API through `page.route` on dev.
[Example 9](examples.md#9-an-api-without-cors-on-dev).
