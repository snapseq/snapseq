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
PNG unless the config's `numbering` and `format` say otherwise. Files that do not end in `.capture.ts` are
not captures; helpers can live in `captures/helpers/`.

## Fixtures

Beyond Playwright's own (`page`, `context`, `browser`, …):

| Fixture  | Value                                                                                   |
| -------- | --------------------------------------------------------------------------------------- |
| `seq`    | The shot sequence: `snap`, `snapPage`, `dir`.                                           |
| `device` | The `devices` key this run is on, e.g. `"mobile"`.                                      |
| `env`    | The active env name, e.g. `"dev"`.                                                      |
| `host`   | The resolved base URL.                                                                  |
| `ctx`    | All of the above plus `page` in one object, for helpers that take a `CaptureContext`.   |

## Shots

`seq.snap()` is a viewport shot.

`seq.snapPage()` is the whole page the way a reviewer expects it: the viewport
grows to the document height, so sticky and fixed elements rest in flow and a
tray whose slot comes into view gets to land; one shot; the viewport is
restored.

`seq.snap({ fullPage: true })` is Playwright's native full page: the viewport
stays as it is, and sticky elements come out pinned where the scroll left
them. Use it for a page whose layout follows the viewport height (`vh` units,
a loader at the page end). `snapPage` measures once more after the viewport is
set and refuses such a page, with the viewport restored, because a taller
viewport would never catch it.

Both take Playwright's screenshot options (`mask`, `clip`, `style`,
`omitBackground`, …) except the path, the image type and the quality, which
the sequence takes from the config's `numbering` and `format`. Both resolve to
the path of the file they wrote.

## Readiness

Every shot waits for the page to be ready first, in this order:

1. **DOM quiet.** No mutation for 200 ms, 3 s at most, then a painted frame. JS-driven motion that touches the DOM each frame, a carousel spring or a chart growing, ends before the shot.
2. **Fonts in.** `document.fonts.ready`, 5 s at most. A face that lands late reflows every line, and `snapPage` measures the page after it.
3. **Images loaded.** Every `<img>`, lazy ones made eager so a full page gets them too, 5 s at most for the lot.
4. **DOM quiet again**, because image loads run handlers of their own.

A wait that ran out its cap is noted on the shot's line in `shots.txt`
(`07.png  http://…  2 images still loading after 5 s`) and printed once in
the terminal. A shot that was ready says nothing.

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

Wait for what the shot needs rather than for `networkidle` as a rule: a page
that polls or streams never goes idle, and the `goto` then runs to the 120 s
navigation bound before the capture fails.

## Helpers

- `disableTransitions(page)`: no transitions, animations or smooth scrolling, on this document and every one the page navigates to afterwards. Once per capture. `animation: none` resets each element to its un-animated base state rather than freezing it mid-keyframe.
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
body. The reason shows on the capture's line in the terminal. To run a single
capture, filter by file: `pnpm screenshot pricing`.

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
