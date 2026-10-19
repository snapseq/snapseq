# Captures

A capture is one file in `captures/` that takes an ordered series of shots.
It is a Playwright test with a few fixtures added.

```ts
// captures/pricing.capture.ts
import { capture, disableTransitions } from "snapseq";

capture(async ({ page, seq, device }) => {
  await disableTransitions(page);                  // once per capture; survives navigation
  await page.goto("/pricing");                     // baseURL-relative
  await seq.snap();                                // 01.png  viewport
  await seq.snapPage();                            // 02.png  full page
  if (device === "mobile") {
    await page.getByRole("button", { name: "Menu" }).click();
    await page.getByRole("navigation").waitFor(); // what the shot needs, then the shot
    await seq.snap();                              // 03.png  mobile only
  }
});
```

## Files and names

The file name is the capture name: `captures/pricing.capture.ts` writes to
`.screenshots/<run>/pricing/<device>/`. Folders nest:
`captures/campaign/pricing.capture.ts` writes to
`.screenshots/<run>/campaign/pricing/<device>/`.

One `capture()` per file. A shot's number is its position in the file, so a
second capture is a second file. The number is two digits wide and the file a
PNG unless the config's `numbering` and `format` say otherwise. A file is a
capture when its name ends in `.capture.ts` (or `.js`, `.mts`, `.cts`, `.mjs`,
`.cjs`); other files are not, and helpers can live in `captures/helpers/`.

## Fixtures

Beyond Playwright's own (`page`, `context`, `browser`, …):

| Fixture  | Value                                                                                   |
| -------- | --------------------------------------------------------------------------------------- |
| `seq`    | The shot sequence: `snap`, `snapPage`, `dir`, `shots`.                                  |
| `device` | The `devices` key this run is on, e.g. `"mobile"`.                                      |
| `env`    | The active env name, e.g. `"dev"`.                                                      |
| `host`   | The resolved base URL.                                                                  |
| `ctx`    | All of the above plus `page` in one object, for helpers that take a `CaptureContext`.   |
| `snapseq` | The config's `plugins`, as `defineConfig` set them. Read by `seq`; nothing for a capture to use. |

## Shots

`seq.snap()` is a viewport shot.

`seq.snapPage()` is the whole page the way a reviewer expects it: the viewport
grows to the document height, so sticky and fixed elements rest in flow and a
tray whose slot comes into view gets to land; one shot; the viewport and the
scroll position are restored. A page about one screen tall whose content
scrolls inside an element rather than the document (`html` and `body` at 100%
height with `overflow: hidden`, a scrolling `main`) is not grown: the shot is
the device's viewport, with a note naming the element. Content that lands
during the wait and makes it taller makes it a page again, grown as usual; a
shell that grows with the viewport gets the note instead of a refusal. The
element is never expanded.

`seq.snap({ fullPage: true })` is Playwright's native full page: the viewport
stays as it is, and sticky elements come out pinned where the scroll left
them. Use it for a page whose layout follows the viewport height (`vh` units,
a loader at the page end). `snapPage` measures once more after the viewport is
set and refuses such a page, with the viewport restored, because a taller
viewport would never catch it. The `snapseq-stabilize` plugin freezes `vh`
units, so `snapPage` takes a `100vh` page; see [Plugins](plugins.md).

Both take Playwright's screenshot options (`mask`, `clip`, `style`,
`omitBackground`, …) except the path, the image type and the quality, which
the sequence takes from the config's `numbering` and `format`. `snapPage` does
not take `fullPage` either. A plugin can add keys of its own, such as `label`
from `snapseq-label`:
`seq.snap({ label: "0.0 Home" })`. See [Plugins](plugins.md). Both resolve to
the path of the file they wrote. One shot runs at a time: a second `snap`
before the first resolved throws, so await each.

## Readiness

Every shot waits for the page to be ready first, in this order:

1. **Document parsed.** The current document's `DOMContentLoaded`, before the plugin hooks run. A click that navigates resolves while the new page is still arriving; the shot waits for all of it. A page that never finishes parsing holds the shot to the navigation timeout. A document a hook navigates to is not waited for: navigate before the shot, not from a hook. Not the `load` event: a beacon that never answers would hold every shot.
2. **DOM quiet.** No mutation for 200 ms, 3 s at most, then a painted frame. JS-driven motion that touches the DOM each frame, a carousel spring or a chart growing, ends before the shot.
3. **Fonts in.** No wait when no font is loading (`document.fonts.status` is `loaded`); otherwise `document.fonts.ready`, 5 s at most. A face that lands late reflows every line, and `snapPage` measures the page after it.
4. **Images loaded.** For `snap`, the visible `<img>` elements in the viewport, or in the `clip`, and above it: images below the fold, hidden ones (`display: none`, `visibility: hidden`), and ones an ancestor's overflow cuts out of view (below a scrolling panel's visible area) do not hold the shot. One at `opacity: 0` does, as it may fade in once loaded. For `snapPage` and `snap({ fullPage: true })`, every `<img>`, lazy ones made eager so a full page gets them too. 5 s at most for the lot.
5. **DOM quiet again**, because image loads run handlers of their own.

`snapPage` runs the wait once the viewport has grown, and again after its second
grow when landing in flow changed the height, so an image that a newly shown
section starts (an observer that sets its `src`) holds the shot or gets a note.
Each run has its own 5 s image cap, so a slow page can spend two.

A wait that ran out its cap, a shot that may lack something, or a plugin with
something to say, gets a note on its line in `shots.txt`, printed once in the
terminal too:

```
07.png  http://…  2 images still loading after 5 s (first: http://…/hero.jpg)
```

- `N images still loading after 5 s (first: <url>)`: the image wait ran out.
- `N images failed to load (first: <url>)`: an image the shot shows has no
  pixels, a 404 or a broken file. Hidden ones do not count.
- `font readiness still pending after 5 s`: a font was loading, and `document.fonts.ready`,
  which also waits for the load event, had not resolved.
- `DOM still changing after 3 s (most changed: div#ticker)`: the element with
  the most changes, named by its tag, `#id` and first class. Without the
  parenthesis when no element was counted.
- `the page scrolls inside <main.content> not the document: scrollable content
  may be omitted`: `snapPage` only, for a page about one screen tall whose
  content scrolls inside an element. One in an open shadow root is named after
  its host: `<app-shell div.content>`.
- `scroll pass stopped after N steps`: from `snapseq-stabilize` with
  `scroll: true`, for a native full page whose scroll pass hit its cap of 60
  steps or 5 s. See its [README](../../stabilize/README.md).
- `cannot read <url>: its viewport units stay live`: from `snapseq-stabilize`,
  for a stylesheet from another origin that it could not read, so its viewport
  units were not frozen. See its [README](../../stabilize/README.md).

An image's URL loses its user and password, query and hash, and is cut to 80
characters; a data URL reads `a data: URL`; an image with no URL yet gets no
`(first: …)`. One query parameter stays, the first named `url`, `src` or `image`
that holds an http(s) URL, so an image served through a loader reads
`…/_next/image?url=/img/hero.jpg` instead of every note reading
`…/_next/image`. It is decoded (up to three times in all), and its own query,
hash and credentials are dropped; it is cut to 60 characters. A value that is not
an http(s) URL, such as a `data:` URL, is left out. A shot that was ready says
nothing.

The wait sees DOM mutations in the page's own document and runs on the page's
timers. It does not see:

- a state that lands after the DOM has been quiet for 200 ms, such as a fetch that resolves later;
- video, canvas, CSS backgrounds, iframes, shadow trees;
- motion that never touches the DOM (the Web Animations API);
- anything while `page.clock` is paused.

Those need their own wait before the shot: a locator
(`await page.locator(".chart svg path").first().waitFor()`) or a bounded
`page.evaluate`. [Example 8](examples.md#8-a-state-that-arrives-later) shows
both.

`stabilize()` from [`snapseq-stabilize`](../../stabilize/README.md) covers Web
Animations: its `motion` option, on by default, finishes or cancels them before
each shot and applies `disableTransitions`, so the capture need not.

Wait for what the shot needs rather than for `networkidle` as a rule: a page
that polls or streams never goes idle, and the `goto` then runs to the 120 s
navigation bound before the capture fails.

## Helpers

- `disableTransitions(page)`: no transitions, animations or smooth scrolling, on this document and every one the page navigates to afterwards. Once per capture. `animation: none` resets each element to its un-animated base state rather than freezing it mid-keyframe. An element whose base state is hidden and that a `forwards` keyframe animation reveals (a `.hero` with base `opacity: 0` and `animation: fadeIn 1s forwards`) stays hidden in the shot; reveal it with `addPersistentStyle(page, ".hero { opacity: 1 !important }")` or the page's own revealed class.
- `addPersistentStyle(page, css)`: the same persistence for your own CSS, e.g. `addPersistentStyle(page, "#chat-widget { display: none !important }")`.

Both inject a `<style>` element, which a strict `style-src` blocks. See
[Troubleshooting](troubleshooting.md#injected-styles-do-nothing).

## Skipping

```ts
// captures/dashboard.capture.ts
import { capture, skipIf } from "snapseq";

// Whole file, decided before any fixture runs: skipped devices get no directory.
skipIf(({ device }) => device !== "desktop", "desktop only");

capture(async ({ page, seq }) => { /* … */ });
```

A condition you only learn mid-capture: `skipIf(condition, reason)` inside the
body. The reason shows on the capture's line in the terminal. `seq` is already
set up by then, so a capture that uses it leaves an empty `<capture>/<device>/`
directory behind; a file-level `skipIf` does not. To run a single capture,
filter by file: `pnpm screenshot pricing`.

## Page states that flip

A menu that closes on navigation, a panel that opens on click: put the
precondition in the helper that takes the shot, so every call gets it.

```ts
// captures/helpers/snap-menu.ts
import type { CaptureContext } from "snapseq";

export async function snapMenuOpen({ page, seq }: CaptureContext): Promise<string> {
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("navigation").waitFor();
  return seq.snap();
}
```

Call it with the `ctx` fixture: `await snapMenuOpen(ctx)`.
[Example 5](examples.md#5-a-helper-that-takes-the-shot) uses it across pages.

## An API without CORS on a dev server

A page served from localhost may call an API that sends no
`access-control-allow-origin` for that origin. The browser drops the response
and the widget stays a skeleton. Re-serve those responses through
`page.route` and `route.fulfill({ response: await route.fetch() })`: Playwright
adds the missing header and answers preflights itself. Routed requests bypass
the HTTP cache, which does not matter for screenshots.
[Example 9](examples.md#9-an-api-without-cors-on-dev) is the complete file.

## A backend that rejects every request

A widget whose backend the capture cannot use, because it sits behind a bot
check, charges per call or is down, cannot be fixed from the browser. Give the
env a `replay` entry for that request ([Config](config.md#replay)): snapseq
answers it from a recorded file before the first shot, and the capture stays
what a user does.
[Example 12](examples.md#12-a-backend-that-rejects-every-request) is the
complete file.
