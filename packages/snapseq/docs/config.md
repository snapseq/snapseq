# Config

`snapseq.config.ts` exports the result of `defineConfig()`, which is a
Playwright Test config. The command finds it in the current directory, or
takes `-c <path>`.

```ts
// snapseq.config.ts
import { defineConfig } from "snapseq";

export default defineConfig({
  envs: {
    dev: { host: "http://localhost:3000", webServer: "pnpm dev" },
    staging: {
      host: "https://staging.example.com",
      httpCredentials: { username: "user", password: "pass" },
    },
  },
  devices: {
    desktop: { viewport: { width: 1920, height: 1080 } },
    mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true },
  },
});
```

## Fields

| Field            | Default                                | Notes                                                                   |
| ---------------- | -------------------------------------- | ----------------------------------------------------------------------- |
| `envs`           | required                               | One entry per environment. See "Envs".                                  |
| `defaultEnv`     | `"dev"` if present, else the first env | Used when neither `--env` nor `SNAPSEQ_ENV` is given.                |
| `devices`        | desktop and mobile as above            | One Playwright project per key. See "Devices".                          |
| `sequencesDir`   | `"snapseq"`                            | Relative to the config file. Matches `*.seq.ts` (and `.js`, `.mts`, `.cts`, `.mjs`, `.cjs`). |
| `screenshotsDir` | `"screenshots"`                        | Relative to the config file. Snapseq writes a `.gitignore` inside it. |
| `numbering`      | `"00"`                                 | The shape of a shot number: `"00"` gives `01.png`, `"000"` gives `001.png`. Zeros only. Wide enough for the longest sequence: `100.png` sorts before `99.png`. |
| `format`         | `{}` (PNG)                             | Playwright's screenshot `type` and `quality`: `{ type: "jpeg", quality: 60 }` writes `01.jpg`, … Quality is 0 to 100 and JPEG only, as in Playwright. |
| `stabilize`      | on                                     | Holds the page still for each shot, and lets `snapPage` grow pages with `vh` units. `false` turns it off; an object switches single steps. See "Stabilize". |

## Envs

An env is a host and what it takes to reach it.

| Field             | Notes                                                                                                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`            | The base URL, `http://` or `https://` (`localhost:3000` is refused). `page.goto("/pricing")` resolves against it. `--host` or `SNAPSEQ_HOST` overrides it for one run.                                                                                                    |
| `httpCredentials` | HTTP basic auth, offered to the resolved host's origin only (`--host` counts). Playwright's `origin` field sends them somewhere else instead, e.g. a host that redirects to a second origin behind the same password; an `origin` set here wins over `--host`. |
| `webServer`       | The command that serves `host`. See "Dev server".                                                                                                                                                                      |
| `use`             | This env's Playwright options, merged over the defaults below. A login in `storageState`, a `locale`, `httpCredentials` for the host's origin: whatever Playwright takes, in its own words.                                       |
| `replay`          | Requests answered from recorded files instead of this env's backend, e.g. `{ "**/api/search": "snapseq/replay/search.json" }`. See "Replay".                                                                       |

An option that differs per env goes on the env, not in a composed override:

```ts
envs: {
  dev: { host: "http://localhost:3000" },
  staging: {
    host: "https://staging.example.com",
    httpCredentials: { username: "preview", password: process.env.STAGING_PASSWORD ?? "" },
    use: { locale: "de-DE" },
  },
  prod: { host: "https://www.example.com", use: { storageState: "snapseq/prod-session.json" } },
},
```

Playwright sends `extraHTTPHeaders` to every origin the page loads,
third-party scripts and images included. A secret belongs in
`httpCredentials`, which goes to one origin, or in a `page.route` for the
host's origin, set up in the sequence.

### Dev server

Give an env the command that serves it and snapseq starts it before the run:

```ts
dev: { host: "http://localhost:3002", webServer: "pnpm dev --port 3002" },
```

This is Playwright's `webServer`. The command runs from the config file's
directory and must listen on `host`. If something at `host` already passes
Playwright's readiness check (a 2xx, 3xx or 400–403 response after
redirects; a self-signed https certificate is accepted), it is reused and the command is not started. Otherwise the command
starts, with up to 120 s to become ready, and is stopped when the run ends,
Ctrl-C included. A host different from the env's (`--host`, `SNAPSEQ_HOST`)
never starts the command; point it at a server you run yourself. The server's
stdout is hidden and its stderr shown; `DEBUG=pw:webserver` shows everything.

In an [orchestration](orchestration.md#limits) each `run()` is a run of its own, so
the command starts and stops with every one. Start the server yourself and keep it
up.

### Replay

A page state that depends on a request this env cannot answer, such as a
backend behind a bot check that rejects automated sessions, one that charges
per call, or one that is simply down, comes from a recorded response instead:

```ts
prod: {
  host: "https://www.example.com",
  replay: { "**/api/search": "snapseq/replay/search.json" },
},
```

Each key is a Playwright `page.route` URL pattern and each value a file
relative to the config file. A glob like `**/api/search` matches that path on
any host, a third-party request included; `--record` then stops the sequence
on the second, different request and names both. Pinning the host
(`https://api.example.com/search`) avoids that, but only when the API has a
host of its own. When the API is same-origin and you record with `--host`
against another host, a pinned pattern never matches, so keep the glob.
Before every sequence, snapseq routes the pattern
and answers it with the file's contents as JSON. The request never reaches the
backend; the rest of the page stays live. A run whose file is missing, or is
not valid JSON (a hand edit left a comma behind), fails before its first shot and
names the file.

`pnpm snapseq --record` (or `SNAPSEQ_RECORD=1`) fetches each request live
instead, writes its file, and answers with it. The variable takes `1` or
`true` to record, and `0`, `false` or empty not to; any other value is an
error. The flag takes the same values as `--record=0`, except that an empty
`--record=` is an error too. `--record 0`, with a space, records and hands `0`
to Playwright as a file filter. One replay file holds one response, so a
different method, URL or request body is a second request: it would write the
same file in one device's run, and stops the sequence instead of overwriting
it. Two searches that differ only in their POST body, "lamps" and "chairs",
cannot be told apart by a pattern: Playwright routes by URL, and when two
patterns match one URL only the later one answers, for both requests. Record
one of them, serve the other with a `page.route` in the sequence that checks
`route.request().postData()` (and calls `route.fallback()` for the rest), or
use a HAR. Record against a host where the
request succeeds, check the shot, and commit the file; every later run replays
it. `--host` points the env at such a host for the recording run:

```bash
pnpm snapseq --env prod --record --host https://staging.example.com
pnpm snapseq --env prod
```

Only an env with `replay` is affected. The recorder saves a JSON success body
and later serves it as a 200; a status outside 200–299 or a body that is not
JSON fails the sequence at that request (shots already taken stay), and the
file is left as it was for that response. A
response the page renders by status (a 4xx) or anything that is not JSON goes
through `page.route` or Playwright's `page.routeFromHAR` in the sequence.

## Devices

One Playwright project per key. The value is that project's `use` options, so
Playwright's own device descriptors work:

```ts
import { devices } from "@playwright/test";

devices: {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: devices["iPhone 14"],                            // WebKit: see below
  "300x250": { viewport: { width: 300, height: 250 } },   // a fixed-size page, e.g. an ad slot
},
```

The key is the directory name under each sequence (`pricing/phone/01.png`),
the value of the `device` fixture, and what `--device` selects. It must be a
directory name, not a path.

An iPhone or iPad descriptor sets `defaultBrowserType: "webkit"`, which the
install steps do not add: run `pnpm exec playwright install webkit`, or
override it with `{ ...devices["iPhone 14"], defaultBrowserType: "chromium" }`
(Safari user agent and `isMobile: true`, but not WebKit rendering).

`isMobile: true` gives phone semantics: the viewport meta is honored,
`sec-ch-ua-mobile` is `?1`, and a page without one is laid out at 980 px and
scaled down. `snapPage` refuses such a page, or one with a fixed-width meta,
because the layout viewport scales with the grown viewport; use
`snap({ fullPage: true })` there. So the default `mobile` device keeps it off.

For a mobile user agent on that device (Chromium only), add an Android Chrome
`userAgent` (Chrome version near the installed browser's). `sec-ch-ua-mobile`
stays `?0` while `isMobile` is off, so some servers may still see a desktop.

```ts
userAgent: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<version>.0.0.0 Mobile Safari/537.36",
```

## Stabilize

`stabilize` is on. It lets `snapPage` take a page with viewport-height units, and
holds the page still for each shot: motion stopped, the pointer off the content.
`stabilize: false` turns it all off. An object switches single steps; the ones you
leave out keep their defaults:

```ts
export default defineConfig({
  envs: { dev: { host: "http://localhost:3000" } },
  stabilize: { floating: false, scroll: true },
});
```

| Option          | Default | What it does                                                                                         |
| --------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `viewportUnits` | on      | Freezes `vh` and the other viewport-height units to px, so `snapPage` works on a `100vh` page.        |
| `floating`      | on      | In `snapPage`, a fixed element keeps the top it had on the first screen.                              |
| `scrollEvent`   | on      | In `snapPage`, a scroll event after the viewport grows and again once it is restored.                 |
| `motion`        | on      | Transitions off; animations finished, or cancelled, before each shot.                                 |
| `hover`         | on      | The pointer leaves the content before each shot.                                                      |
| `scroll`        | off     | A scroll pass before a native full page, so lazy content loads.                                       |
| `reducedMotion` | off     | Emulates `prefers-reduced-motion: reduce`.                                                            |

A call of an orchestration can give its own `stabilize`
([Orchestration](orchestration.md#options)). It works through the sequence's
`seq`: a sequence that uses neither `seq` nor `ctx` gets none of it. A step that
throws fails the sequence and names itself and the shot:
`snapseq: stabilize threw in beforeSnap on 01.png: <message>`. It is developed and
tested on Chromium.

### Viewport units

`snapPage` grows the viewport to the page height, and a `100vh` section grows with
it, so the page never settles and `snapPage` refuses it. Before each shot, while the
viewport is still the device's, stabilize rewrites the page's viewport-height units
to px: `vh`, `vmin`, `vmax`, `vb` and their `s`, `l` and `d` variants. The hero
stays one screen tall and sticky elements rest in flow. Width units (`vw`) are left
alone: the width never changes.

- It reaches stylesheets (media, supports, layer, container, nested rules, keyframes,
  `@import`), inline `style` attributes and custom properties (`--h: 50vh`), and
  keeps `!important`. Text in quotes and `url(...)` are not touched.
- It reaches open shadow roots and adopted stylesheets (`adoptedStyleSheets`), on the
  document and in every root, nested roots included.
- The page's own value is kept for every declaration. The next shot freezes it again
  at that shot's viewport, so a viewport you resized in between is followed. Between
  shots the page keeps the px values of the last shot's viewport.
- CSS that arrives while the viewport is grown is frozen at the viewport the shot
  started with: `<style>` and `<link>` elements added, alone or inside a subtree, the
  text of a `<style>` edited, and inline styles on added elements or written on
  elements that were already there. Open shadow roots are watched too.
- A stylesheet from another origin cannot be read by script. Before a shot, stabilize
  fetches such a stylesheet again as a CORS request, and the page's rules then become
  readable. If the server refuses, or the stylesheet redirects, it stays as the page
  had it, and each shot taken while it is unreadable carries the note
  `cannot read <url>: its viewport units stay live` (the URL without its query string,
  cut to 80 characters). See
  [Troubleshooting](troubleshooting.md#the-terminal-says-cannot-read-url-its-viewport-units-stay-live).

The refetch is tried once per page load. A stylesheet that stays unreadable is then
fetched once per page load as text, with CORS: at most 10 sheets a shot, 512 K
characters each, 3 s in all. The note is dropped only when the answer is `text/css`
and, with comments and quoted strings taken out, has no viewport unit outside
`url(...)` and no backslash escape, and every `@import` in it is a stylesheet that
passes the same check. That is one level: an `@import` inside an imported sheet keeps
the note. Each imported sheet counts toward the 10; a sheet with more than 9 imports
can never fit and keeps the note, and one whose imports are more than what is left
waits, all or nothing, for the next shot. Anything else keeps the note too: a fetch
that fails or runs out of time, another content type, a stylesheet not checked yet.
It is a best-effort look: the anonymous fetch may not get the stylesheet the page
applied (a CDN that varies by cookie, say).

The URLs to fetch again come from the page, which may name any URL. While a
cross-origin stylesheet is fetched again, a route answers that URL with a CORS header
for one `text/css` response; anything else (another content type, a redirect, an
error, a second request for the URL, a request that carries a cookie) goes on to the
browser, whose own request gets no header. A page that tampers with its own
stylesheet list can obtain a stylesheet this way, not another resource. The window
closes when every refetch has settled (the page stops waiting after 5 s) or after 6 s,
and the route is removed either way. The route's fetch sends an empty `cookie`
header, which Playwright 1.59 takes as set, so the context's cookies are not added to
it.

### Floating

`snapPage` grows the viewport to the page height, and a `position: fixed` element
follows its insets with it: a promo drawer at `bottom: 325px`, a chat bubble or a
cookie banner ends up at the page end, over the footer, where the reader saw it on the
first screen. Before each shot, at the device's viewport, stabilize records every fixed
element that is on the screen: rendered (not `display: none`, `visibility: hidden` or
`opacity: 0`, on itself or an ancestor) and inside the viewport. After each grow, once
the page has settled, it sets `top: <px> !important; bottom: auto !important` inline
on each, so it sits at the top it had. Height, width, `left`, `right` and `transform`
are not touched. Once the viewport is restored, the page's own inline `top` and
`bottom` come back, whether the shot was taken or failed. A property is restored only
while it still holds what stabilize wrote, so a value the page wrote in the meantime
stays.

It leaves alone:

- A fixed element off the screen at the device's viewport, such as a drawer parked at
  `bottom: -100%`, and one only partly on the screen, such as a bottom sheet peeking
  60 px: it stays at the page end, clipped as the device's viewport clipped it.
- An element the page removed, hid, moved off the screen or un-fixed in response to the
  grow or to the scroll event.
- An element whose size changed with the viewport, such as a `top: 10%; bottom: 0`
  panel or an `inset: 0` dimmer: it has its own layout.
- An element already at its top (a `top: 0` header).
- An element the override does not bring to where it was: a fixed element inside a
  transformed, filtered or `contain`ed ancestor, and a fixed child of a pinned fixed
  ancestor. Its inline values are put back.
- A box centred by `margin: auto`, such as a `<dialog>` opened with `showModal()` or a
  `[popover]`: it stays centred in the grown page.
- An element the page positions or restyles itself (a dropdown, a popover, a menu
  placed by a positioning library). Stabilize notes its inline style, its `transform`
  and its `class` at the device's viewport, and leaves it where the page put it when
  any of them differs once the viewport has grown. CSS anchor positioning changes none
  of them and is not detected.

It cannot see fixed elements inside iframes, in closed shadow roots, or made by
pseudo-elements. Open shadow roots are walked. `floating: false` turns the step off; a
fixed element then sits where its insets put it in the grown viewport, and a
`bottom: 0` bar is drawn at the page end.

### Scroll event

`snapPage` grows the viewport from where the page is; from the top nothing scrolls, so
no scroll event fires, and UI that follows scroll events only stays as it was: a fixed
tray that hides on scroll once its inline counterpart is in view is drawn over the
footer, a back-to-top button stays hidden. Stabilize fires one scroll event after each
grow, at the document and bubbling to the window as the browser's own does, and one
once the viewport is restored, so the page is back in its viewport state for what the
sequence does next. The event is synthetic: `isTrusted` is `false`, and a handler that
checks it ignores it. Any scroll handler runs, not only the tray's, and some react in
ways you do not want:

- A header that hides on scroll down and treats a zero delta as down is hidden in the
  full page, and the restore event has a zero delta too, so it also stays hidden
  between `snapPage` and the sequence's next step.
- A "bottom reached" handler, such as an infinite scroll that appends on each event or
  a 100 % scroll beacon, runs on each grow and on the restore. One that appends content
  every time keeps the document growing, and `snapPage` refuses the page.
- A reveal script that judges what is in view against the window height it read at load
  takes its in-view class off everything below the first screen, and an animated chart
  there goes back to its base state.

`scrollEvent: false` turns the event off.

### Motion

When the sequence begins, transitions and smooth scrolling are turned off on every
document: `disableTransitions` without its `animation: none`. Animations run. Before
each shot, and in `snapPage` after each grow once the DOM has been quiet for 200 ms
(2 s at most), CSS and Web Animations are finished, or cancelled when they cannot
finish (an infinite one), rather than removed. A `forwards` reveal, such as a bar chart
that grows in, keeps its final state, and so does a `forwards` exit animation, hidden;
one without fill goes back to its base style. Finishing runs the page's `animationend`
and `finish` handlers. After a grow this comes before `snapPage` measures the page, so a
section that opens as it comes into view is measured open. SVG animations are paused
where they are, like a video, so a draw-in that finished stays drawn; videos stop
playing.

The screenshot itself runs with Playwright's `animations: "disabled"` unless the
sequence sets its own, so an animation that starts after the pass (from a resize
handler, say) is finished or cancelled too. Playwright plays an infinite animation it
cancelled again once the shot is taken, so between shots the page holds less still than
under `animation: none`. A sequence that calls `disableTransitions` itself brings
`animation: none` back, and with it reveals held at their base state.

### Hover

After a click the pointer stays where it was, and whatever moved under it (a product
card, a menu) is drawn in `:hover`. Before each shot stabilize moves the pointer off the
viewport, so nothing is hovered. The move fires the page's `mouseleave` handlers: a menu
that opens on hover closes. The pointer leaves through the left edge at mid-height, so
exit-intent scripts that watch the top edge are not triggered. It then sits off the page
until the sequence's next action: `page.click` and locator actions move it first, a bare
`mouse.down`, `mouse.up` or `mouse.wheel` does not. For a hover state the sequence set
up on purpose, leave it for that shot:

```ts
await page.hover(".menu");
await seq.snap({ hover: "keep" });
```

### Scroll

`snap({ fullPage: true })` is Playwright's native full page: it does not scroll, so an
`IntersectionObserver` reveal stays blank and a `data-src` image stays unloaded. With
`scroll: true`, a shot with `fullPage`, after the DOM has been quiet for 200 ms (2 s at
most), scrolls the document from its top down to its end, one viewport at a time with a
frame on each stop, then restores the scroll position the page had. The end is read on
every stop, so growth that lands during the pass is followed. It stops after 60 steps or
5 s, and the shot then carries the note `scroll pass stopped after N steps`. Plain `snap`
and `snapPage` are not scrolled: `snapPage` grows the viewport to the whole page, which
shows everything already. A virtualized list, or a header that changes with the scroll
direction, is not helped. With `hover: "keep"` the pass moves content under the kept
pointer.

### Reduced motion

`reducedMotion: true` emulates `prefers-reduced-motion: reduce` for the sequence, for a
page that has a quieter variant. Off, the page's own preference is left alone.

### What stabilize does not do

- Media queries that depend on the viewport height (`min-height`, `orientation`,
  `aspect-ratio`), and the `media` attribute of a stylesheet.
- `@property` initial values.
- Closed shadow roots, a cross-origin `<link>` inside a shadow root (skipped without a
  warning), and an open shadow root attached after the shot started (the next shot
  reaches it).
- A viewport unit in a `var()` fallback inside a shorthand (`margin: var(--gap, 10vh)`);
  the same fallback in a longhand is frozen.
- `@container` units, and JS that reads `innerHeight` or `matchMedia`.
- CSS added with `insertRule` (CSS-in-JS in production), `replaceSync` on a constructed
  stylesheet, or a new `adoptedStyleSheets` after the shot has started, and a
  cross-origin stylesheet added while the viewport is grown.
- Vertical writing modes: `vb` is frozen as a height and `vi` is left alone, as in
  horizontal text.
- A cross-origin stylesheet that redirects, or that a stylesheet imports with its own
  `@import` (a font service's CSS): the browser loads an import without CORS, so no
  refetch can open it, and its viewport units stay live. It is noted on the shots unless
  its text, fetched as above, rules a viewport unit out; `@font-face` rules alone say
  nothing. A stylesheet that arrives after the first shot, or whose imports load after
  it, carries the note from the next shot on.
- A cross-origin stylesheet that a `replay` entry or a HAR route serves: the route
  stabilize adds runs first and fetches it live, falling back to the earlier routes only
  when that fetch fails. The replayed copy then carries no CORS header, so the sheet is
  noted on the shots.
- A script that keeps a reference to the original `<link>` of a cross-origin sheet: after
  stabilize swaps it for a CORS copy, the reference no longer reaches the page.
- GIFs and carousels. A video's playback stops, but its frame is wherever it was: use a
  poster or `mask`.
- A page that still grows after this is still refused by `snapPage`. Use
  `snap({ fullPage: true })` for it, Playwright's native full page.

## Labels and PDFs

A label strip above a shot and a PDF of the shots are steps over the captures
of an orchestration file, not config: see [Orchestration](orchestration.md).

## Playwright defaults

`defineConfig` applies these to the Playwright config:

| Option              | Value                           | Why                                                                                                                                       |
| ------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `workers`           | 1                               | Sequences run one at a time, in order.                                                                                                     |
| `timeout`           | 10 min                          | The time allowed between shots, not per sequence. See [Running](running.md#timeouts).                                                     |
| `actionTimeout`     | 30 s                            | Per click, fill and wait.                                                                                                                 |
| `navigationTimeout` | 120 s                           | Playwright's own default is no limit. This allows a cold dev build and still ends a `goto` that never settles.                            |
| `maxFailures`       | 1                               | Fail fast. `--max-failures 0` runs the rest.                                                                                              |
| `retries`           | 0                               | A retry would overwrite the first run's shots. Retries and `--repeat-each` are rejected.                                                  |
| `ignoreHTTPSErrors` | true                            | Self-signed staging certificates.                                                                                                         |
| `userAgent`         | headless token removed          | Headless Chromium's `HeadlessChrome` user agent is rewritten to `Chrome` unless you set `userAgent` yourself; some WAFs 403 the headless token. |
| `reporter`          | the terminal view               | Playwright's list reporter when stdout is not a terminal. See [Running](running.md#the-terminal).                                        |
| `outputDir`         | `node_modules/.cache/snapseq/playwright` | Playwright's own artifacts (traces, error context, `.last-run.json`) stay out of the screenshots dir. See below for what to keep out of it.   |

## Overriding Playwright options

Extra arguments to `defineConfig` are overrides, merged the way Playwright's
own `defineConfig` merges them, which runs underneath: `use`, `expect` and
`build` are merged, `webServer` entries are concatenated, `projects` are merged
by name with each project's `use` merged, and any other option is replaced.

```ts
// snapseq.config.ts
import { defineConfig } from "snapseq";

export default defineConfig(
  { envs: { dev: { host: "http://localhost:3000" } } },
  {
    workers: 2,
    use: { launchOptions: { args: ["--lang=de"] } },
  },
);
```

`metadata.snapseq` is reserved: it is restored after the overrides, so an
override's own `metadata` keeps its other keys and cannot replace it.

Nested objects such as `launchOptions` are replaced whole. To drop a
generated `webServer`, spread the result instead:
`{ ...defineConfig({ /* … */ }), webServer: undefined }`.

Playwright's own artifacts go to `node_modules/.cache/snapseq/playwright`, so
`--trace on` leaves traces there, not among the screenshots. Playwright empties
`outputDir` before a run, and the orchestration's run cache lives beside it in
`node_modules/.cache/snapseq`: an `outputDir` override that holds or sits inside
`node_modules/.cache/snapseq/runs` or `…/requests` is refused in an
orchestration run.
