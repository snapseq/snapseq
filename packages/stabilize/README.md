# @snapseq/stabilize

A [snapseq](https://github.com/snapseq/snapseq/tree/main/packages/snapseq)
plugin that makes a page hold still for its shots. It freezes viewport-height
units, so `snapPage` works on a page with a `100vh` section, stops motion
before each shot, and moves the pointer off the content.

## Install

In the app that has snapseq. Peer dependency: `snapseq`.

```bash
pnpm add -D @snapseq/stabilize
```

## Config

```ts
// snapseq.config.ts
import { defineConfig } from "snapseq";
import { stabilize } from "@snapseq/stabilize";

export default defineConfig({ envs: { /* … */ }, plugins: [stabilize()] });
```

Viewport units, motion and hover are on; scroll, scroll events and reduced
motion are off. Each has a switch:

```ts
stabilize({ viewportUnits: false })  // no freezing of viewport units
stabilize({ motion: false })         // motion is left alone
stabilize({ hover: false })          // the pointer is left where it is
stabilize({ scroll: true })          // scroll pass before a native full page
stabilize({ scrollEvent: true })     // a scroll event once snapPage grew the viewport
stabilize({ reducedMotion: true })   // emulate prefers-reduced-motion: reduce
```

## Use

No option: take the shots as usual.

```ts
// snapseq/home.seq.ts
sequence(async ({ page, seq }) => {
  await page.goto("/");
  await seq.snapPage();  // a 100vh hero stays one screen tall; the shot is the whole page
});
```

## What it does

**Viewport units** (`viewportUnits`). `snapPage` grows the viewport to the
page height, and a `100vh` section grows with it, so the page never settles
and `snapPage` refuses it. Before each shot, while the viewport is still the
device's, the plugin rewrites the page's viewport-height units to px: `vh`,
`vmin`, `vmax`, `vb` and their `s`, `l` and `d` variants. The hero stays one
screen tall, a fixed banner lands at the end of the page, sticky elements rest
in flow. Width units (`vw`) are left alone: the width never changes.

- It reaches stylesheets (media, supports, layer, container, nested rules,
  keyframes, `@import`), inline `style` attributes and custom properties
  (`--h: 50vh`), and keeps `!important`. Text in quotes and `url(...)` are not
  touched.
- It reaches open shadow roots and adopted stylesheets (`adoptedStyleSheets`),
  on the document and in every root, nested roots included.
- The page's own value is kept for every declaration. The next shot freezes
  it again at that shot's viewport, so a viewport you resized in between is
  followed. Between shots the page keeps the px values of the last shot's
  viewport.
- CSS that arrives while the viewport is grown is frozen at the viewport the
  shot started with: `<style>` and `<link>` elements added, alone or inside a
  subtree (a widget set through `innerHTML`), the text of a `<style>` edited,
  and inline styles on added elements or written on elements that were already
  there. Open shadow roots are watched too.
- A stylesheet from another origin cannot be read by script. Before a shot,
  the plugin fetches such a stylesheet again as a CORS request, and the page's
  rules then become readable. A route exists only while a cross-origin
  stylesheet is fetched again, for that URL alone, and is removed afterwards.
  If the server refuses, or the stylesheet redirects, the stylesheet stays as
  the page had it, and each shot taken while it is unreadable carries the note
  `cannot read <url>: its viewport units stay live`, noted on the shot's line in
  the terminal (the URL without its query string, cut to 80 characters). The
  refetch is tried once per page load. A stylesheet that stays unreadable is
  then fetched once per page load as text, with CORS: at most 10 a shot,
  512 K characters each, 3 s in all. The note is dropped only when the answer
  is `text/css` and, with comments and quoted strings taken out, has no
  viewport unit outside `url(...)`, no backslash escape and no `@import`.
  Anything else keeps it: a fetch that fails or runs out of time, another
  content type, a stylesheet not checked yet. It is a best-effort look: the
  anonymous fetch may not get the stylesheet the page applied (a CDN that
  varies by cookie, say).

  Security: the URLs to fetch again come from the page, which may name any URL.
  While a cross-origin stylesheet is fetched again, a route answers that URL
  with a CORS header for one `text/css` response; anything else (another
  content type, a redirect, an error, a second request for the URL, a request
  that carries a cookie) goes on to the browser, whose own request gets no
  header. A page that tampers with its own stylesheet list can obtain a
  stylesheet this way, not another resource. The window closes when every
  refetch has settled (the page stops waiting after 5 s) or after 6 s, and
  the route is removed either way. The route's fetch
  sends an empty `cookie` header, which Playwright 1.59 takes as set, so the
  context's cookies are not added to it.

**Hover** (`hover`). After a click the pointer stays where it was, and
whatever moved under it (a product card, a menu) is drawn in `:hover`. Before
each shot the plugin moves the pointer off the viewport, so nothing is
hovered. The move fires the page's `mouseleave` handlers: a menu that opens on
hover closes. The pointer leaves through the left edge at mid-height, so
exit-intent scripts that watch the top edge are not triggered. It then sits off
the page until the sequence's next action: `page.click` and locator actions move
it first, a bare `mouse.down`, `mouse.up` or `mouse.wheel` does not. `hover:
false` turns the move off. For a hover state the sequence set up on purpose,
leave it for that shot:

```ts
await page.hover(".menu");
await seq.snap({ hover: "keep" });
```

**Scroll** (`scroll`, off by default). `snap({ fullPage: true })` is
Playwright's native full page: it does not scroll, so an `IntersectionObserver`
reveal stays blank and a `data-src` image stays unloaded. With `scroll: true`,
a shot with `fullPage`, after the DOM has been quiet for 200 ms, 2 s at most,
scrolls the document from its top down to its end, one viewport at a time
with a frame on each stop, then restores the scroll position the page had. The end is read on every stop, so growth that lands
during the pass is followed. It stops after 60 steps or 5 s, and the shot then
carries the note `scroll pass stopped after N steps`. Plain `snap` and
`snapPage` are not scrolled: `snapPage` grows the viewport to the whole page,
which shows everything already. A virtualized list, or a header that changes
with the scroll direction, is not helped. With `hover: "keep"` the pass moves
content under the kept pointer. A reveal done by a keyframe animation is
brought to its end by the motion step below.

**Scroll event** (`scrollEvent`, off by default). `snapPage` grows the
viewport from where the page is; from the top nothing scrolls, so no scroll
event fires, and UI that follows scroll events only stays as it was: a fixed
tray that hides once the page end is in view is drawn over the footer, a
back-to-top button stays hidden. With `scrollEvent: true` the plugin fires
one scroll event after each grow, at the document and bubbling to the window
as the browser's own does, and one before each shot, so the tray shows again
once the viewport is back. The event is synthetic: `isTrusted` is `false`,
and a handler that checks it ignores it. Any scroll handler runs, not only
the tray's: one that reads "bottom reached" (an infinite scroll that loads
more, a 100 % scroll beacon) or compares with the last `scrollY` (a header
that hides on scroll down) can react too. That is why it is off by default.

**Motion** (`motion`). When the sequence begins, transitions and smooth
scrolling are turned off on every document: `disableTransitions` from snapseq
without its `animation: none`. Animations run, and before each shot, and in
`snapPage` after each grow once the DOM has been quiet for 200 ms (2 s at
most), CSS and Web Animations are finished, or cancelled when they cannot
finish (an infinite one), rather than removed. A `forwards` reveal, such as a
bar chart that grows in, keeps its final state, and so does a `forwards` exit
animation, hidden; one without fill goes back to its base style. Finishing
runs the page's `animationend` and `finish` handlers. After a grow this comes
before `snapPage` measures the page, so a section that opens as it comes into
view is measured open. SVG animations are paused where they are, like a
video, so a draw-in that finished stays drawn; videos stop playing. The
screenshot itself runs with Playwright's `animations: "disabled"` unless the
sequence sets its own, so an animation that starts after that pass (from a
resize handler, say) is finished or cancelled too; Playwright plays an
infinite animation it cancelled again once the shot is taken, so between
shots the page holds less still than under `animation: none`. A sequence
that calls `disableTransitions` itself brings `animation: none` back, and
with it reveals held at their base state.

**Reduced motion** (`reducedMotion`, off by default). Emulates
`prefers-reduced-motion: reduce` for the sequence, for a page that has a quieter
variant. Off, the page's own preference is left alone.

## What it does not do

- Media queries that depend on the viewport height (`min-height`,
  `orientation`, `aspect-ratio`), and the `media` attribute of a stylesheet.
- `@property` initial values.
- Closed shadow roots, a cross-origin `<link>` inside a shadow root (skipped
  without a warning), and an open shadow root attached after the shot started
  (the next shot reaches it).
- A viewport unit in a `var()` fallback inside a shorthand
  (`margin: var(--gap, 10vh)`); the same fallback in a longhand is frozen.
- `@container` units, and JS that reads `innerHeight` or `matchMedia`.
- CSS added with `insertRule` (CSS-in-JS in production), `replaceSync` on a
  constructed stylesheet, or a new `adoptedStyleSheets` after the shot has
  started, and a cross-origin stylesheet added while the viewport is grown.
- Vertical writing modes: `vb` is frozen as a height and `vi` is left alone,
  as in horizontal text.
- A cross-origin stylesheet that redirects, or that a stylesheet imports with
  its own `@import` (a font service's CSS): the browser loads an import without
  CORS, so no refetch can open it, and its viewport units stay live. It is
  noted on the shots unless its text, fetched as above, rules a viewport unit
  out; `@font-face` rules alone say nothing. An `@import` inside that text is
  not followed: it keeps the note. A stylesheet that arrives after the first
  shot, or whose imports load after it, carries the note from the next shot on.
- A cross-origin stylesheet that a `replay` entry or a HAR route serves: the
  plugin's route runs first and fetches it live, falling back to the earlier
  routes only when that fetch fails. The replayed copy then carries no CORS
  header, so the sheet is noted on the shots.
- A script that keeps a reference to the original `<link>` of a cross-origin
  sheet: after the plugin swaps it for a CORS copy, the reference no longer
  reaches the page.
- GIFs and carousels. A video's playback stops, but its frame is wherever it
  was: use a poster or `mask`.
- A page that still grows after this is still refused by `snapPage`. Use
  `snap({ fullPage: true })` for it, Playwright's native full page.

Developed and tested on Chromium.

More: [Plugins](https://github.com/snapseq/snapseq/blob/main/packages/snapseq/docs/plugins.md), on how they run and how to write one.
