# @snapseq/stabilize

A [snapseq](https://github.com/snapseq/snapseq/tree/main/packages/snapseq)
plugin that makes a page hold still for its shots. It freezes viewport-height
units, so `snapPage` works on a page with a `100vh` section, keeps fixed
elements where the first screen had them, stops motion before each shot, and
moves the pointer off the content.

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

Viewport units, floating, scroll events, motion and hover are on; scroll and
reduced motion are off. Each has a switch:

```ts
stabilize({ viewportUnits: false })  // no freezing of viewport units
stabilize({ floating: false })       // fixed elements follow their insets in the grown viewport
stabilize({ scrollEvent: false })    // no scroll event after snapPage grew or restored the viewport
stabilize({ motion: false })         // motion is left alone
stabilize({ hover: false })          // the pointer is left where it is
stabilize({ scroll: true })          // scroll pass before a native full page
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
screen tall and sticky elements rest in flow; `floating` below puts fixed
elements back where the first screen had them. Width units (`vw`) are left
alone: the width never changes.

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
  then fetched once per page load as text, with CORS: at most 10 sheets a shot,
  512 K characters each, 3 s in all. The note is dropped only when the answer
  is `text/css` and, with comments and quoted strings taken out, has no
  viewport unit outside `url(...)` and no backslash escape, and every `@import`
  in it (`url("…")`, `url('…')`, `url(…)`, `"…"` or `'…'`, with media or layer
  text after it or not, resolved against the sheet) is a stylesheet that passes
  the same check. That is one level: an `@import` inside an imported sheet keeps
  the note. Each imported sheet counts toward the 10, and one over the limit
  keeps the note. Anything else keeps it too: a fetch that fails or runs out of
  time, another content type, a stylesheet not checked yet. It is a best-effort look: the
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

**Scroll event** (`scrollEvent`). `snapPage` grows the viewport from where the
page is; from the top nothing scrolls, so no scroll event fires, and UI that
follows scroll events only stays as it was: a fixed tray that hides on scroll
once its inline counterpart is in view is drawn over the footer, a back-to-top
button stays hidden. The plugin fires one scroll event after each grow, at the
document and bubbling to the window as the browser's own does, and one once the
viewport is restored, so the page is back in its viewport state for what the
sequence does next: a tray the grow hid shows again, and a click on it between
two shots finds it. The event is synthetic: `isTrusted` is `false`, and a handler that checks it
ignores it. Any scroll handler runs, not only the tray's, and some react in
ways you do not want:

- A header that hides on scroll down and treats a zero delta as down is hidden.
- A "bottom reached" handler, such as an infinite scroll that appends on each
  event or a 100 % scroll beacon, runs on each grow and on the restore. One that
  appends content every time keeps the document growing, and `snapPage` refuses
  the page.
- A reveal script that judges what is in view against the window height it read
  at load takes its in-view class off everything below the first screen, and an
  animated chart there goes back to its base state.

`scrollEvent: false` turns the event off.

**Floating** (`floating`). `snapPage` grows the viewport to the page height, and
a `position: fixed` element follows its insets with it: a promo drawer at
`bottom: 325px`, a chat bubble or a cookie banner ends up at the page end, over
the footer, where the reader saw it on the first screen. Before each shot, at the
device's viewport, the plugin records every fixed element that is on the screen:
rendered (not `display: none`, `visibility: hidden` or `opacity: 0`, on itself or
an ancestor) and inside the viewport. After each grow, once the page has settled,
it sets `top: <px> !important; bottom: auto !important` inline on each, so it sits
at the top it had. Height, width, `left`, `right` and `transform` are not
touched: a box centred by `top: 50%` and `translateY(-50%)` keeps its transform.
Once the viewport is restored, the page's own inline `top` and `bottom` come back,
whether the shot was taken or failed (a refused `snapPage`, a failed screenshot).
A property is restored only while it still holds what the plugin wrote, so a value
the page wrote in the meantime stays.

It leaves alone:

- A fixed element off the screen at the device's viewport, such as a drawer
  parked at `bottom: -100%`: it is not recorded, and pinning it would pull it
  into the full page. One only partly on the screen, such as a bottom sheet
  peeking 60 px, is not recorded either: it stays at the page end, clipped as
  the device's viewport clipped it.
- An element the page removed, hid, moved off the screen or un-fixed in response
  to the grow or to the scroll event.
- An element whose size changed with the viewport, such as a `top: 10%;
  bottom: 0` panel or an `inset: 0` dimmer: it has its own layout, and clearing
  its `bottom` would collapse it.
- An element already at its top (a `top: 0` header).
- An element the override does not bring to where it was, found by reading its
  position after the write: a fixed element inside a transformed, filtered or
  `contain`ed ancestor, whose containing block is that ancestor, and a fixed child
  of a pinned fixed ancestor, which follows it. Its inline values are put back.
- A box centred by `margin: auto`, such as a `<dialog>` opened with `showModal()`
  or a `[popover]`: with `bottom: auto` the auto margin becomes 0, the
  verification finds it moved, and it is put back, so it stays centred in the
  grown page.
- An element the page positions or restyles itself (a dropdown, a popover, a menu
  placed by a positioning library). The plugin notes its inline style, its `transform` and its
  `class` at the device's viewport, and leaves it where the page put it when any of
  them differs once the viewport has grown. CSS anchor positioning changes none of
  them and is not detected.

It cannot see fixed elements inside iframes (frames are not entered), in closed
shadow roots, or made by pseudo-elements. Open shadow roots are walked. If the
restore itself fails, the pin stays until the next shot, which clears it first; at
the device viewport a pinned element sits where it was. `floating: false`
turns the step off; a fixed element then sits where its insets put it in the grown
viewport, and a `bottom: 0` bar is drawn at the page end.

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
  out; `@font-face` rules alone say nothing. Its `@import`s are checked one level
  down (a font service's sheet that imports an empty beacon sheet is quiet); a
  deeper one keeps the note. A stylesheet that arrives after the first
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
