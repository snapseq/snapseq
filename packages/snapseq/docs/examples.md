# Examples

Complete files, basic to complex. Each one is a capture in `captures/` unless
it says otherwise; names are placeholders.

## 1. One page, two shots

The smallest capture: freeze motion, open a page, shoot the viewport and the
whole page.

```ts
// captures/pricing.capture.ts
import { capture, disableTransitions } from "snapseq";

capture(async ({ page, seq }) => {
  await disableTransitions(page);
  await page.goto("/pricing");
  await seq.snap();      // 01.png  the viewport
  await seq.snapPage();  // 02.png  the whole page
});
```

Writes `pricing/desktop/01.png`, `02.png` and `shots.txt`, then the same
under `pricing/mobile/`.

## 2. Several pages, one capture

A site walk. Shots stay numbered in order across navigations, and
`addPersistentStyle` hides a widget on every page, because it re-applies on
each navigation.

```ts
// captures/site.capture.ts
import { addPersistentStyle, capture, disableTransitions } from "snapseq";

const routes = ["/", "/pricing", "/docs", "/blog"];

capture(async ({ page, seq }) => {
  await disableTransitions(page);
  await addPersistentStyle(page, "#chat-widget { display: none !important }");
  for (const route of routes) {
    await page.goto(route);
    await seq.snapPage();
  }
});
```

`shots.txt` says which page each number is:

```
01.png  http://localhost:3000/
02.png  http://localhost:3000/pricing
03.png  http://localhost:3000/docs
04.png  http://localhost:3000/blog
```

## 3. A device-only state

The `device` fixture is the `devices` key. A state that exists on one device
only is a branch in the body; the other device gets fewer shots.

```ts
// captures/home.capture.ts
import { capture, disableTransitions } from "snapseq";

capture(async ({ page, seq, device }) => {
  await disableTransitions(page);
  await page.goto("/");
  await seq.snap();                                 // 01.png  both devices
  if (device === "mobile") {
    await page.getByRole("button", { name: "Menu" }).click();
    await page.getByRole("navigation").waitFor();   // what the shot needs, then the shot
    await seq.snap();                               // 02.png  mobile only
  }
});
```

## 4. A desktop-only capture

`skipIf` at the top of the file runs before any fixture, so the skipped
device gets no directory. The reason shows in the terminal.

```ts
// captures/dashboard.capture.ts
import { capture, disableTransitions, skipIf } from "snapseq";

skipIf(({ device }) => device !== "desktop", "desktop only");

capture(async ({ page, seq }) => {
  await disableTransitions(page);
  await page.goto("/dashboard");
  await seq.snapPage();
});
```

```
  ✔ dashboard / desktop  1 shot  2.8s
  - dashboard / mobile   skipped  desktop only
```

A condition you only learn once the page is open goes inside the body:

```ts
// captures/beta.capture.ts
import { capture, skipIf } from "snapseq";

capture(async ({ page, seq }) => {
  await page.goto("/beta");
  skipIf(await page.getByRole("heading", { name: "Coming soon" }).isVisible(), "not launched");
  await seq.snapPage();
});
```

## 5. A helper that takes the shot

A menu closes on every navigation. Put the precondition in the helper that
takes the shot, so every call gets it. The helper takes a `CaptureContext`;
the `ctx` fixture is one.

```ts
// captures/helpers/snap-menu.ts
import type { CaptureContext } from "snapseq";

export async function snapMenuOpen({ page, seq }: CaptureContext): Promise<string> {
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("navigation").waitFor();
  return seq.snap();
}
```

```ts
// captures/menus.capture.ts
import { capture, disableTransitions, skipIf } from "snapseq";
import { snapMenuOpen } from "./helpers/snap-menu";

skipIf(({ device }) => device !== "mobile", "the menu is a drawer on mobile only");

capture(async ({ ctx, page, seq }) => {
  await disableTransitions(page);
  for (const route of ["/", "/pricing", "/docs"]) {
    await page.goto(route);   // navigation closes the drawer
    await seq.snap();         // closed
    await snapMenuOpen(ctx);  // open, every time
  }
});
```

Helpers are plain files under `captures/`; only `*.capture.ts` files are
captures.

## 6. A sticky tray

A promo tray docks to the bottom of the viewport and lands in its slot when
the page end scrolls into view. `snapPage` grows the viewport to the page
height, so the tray lands and the shot shows it in place.

A page whose height follows the viewport, a `100vh` hero or a loader pinned
to the page end, grows again with every resize. `snapPage` refuses it; use
Playwright's native full page there.

```ts
// captures/landing.capture.ts
import { capture, disableTransitions } from "snapseq";

capture(async ({ page, seq }) => {
  await disableTransitions(page);
  await page.goto("/landing");
  await seq.snapPage();                // 01.png  the tray rests in its slot at the page end

  await page.goto("/landing/video");   // a 100vh hero: its height follows the viewport
  await seq.snap({ fullPage: true });  // 02.png  native full page; sticky elements stay pinned
});
```

Calling `snapPage` on the second page fails with
`snapPage: the document grew from 2140 to 3220 px after the viewport was set to its height …
Use snap({ fullPage: true }) for this page.`

## 7. Masking and clipping

Both shots take Playwright's screenshot options. Mask what changes between
runs, clip to a region, inject CSS for one shot.

```ts
// captures/account.capture.ts
import { capture, disableTransitions } from "snapseq";

capture(async ({ page, seq }) => {
  await disableTransitions(page);
  await page.goto("/account");
  await seq.snap({ mask: [page.locator("time"), page.getByTestId("avatar")], maskColor: "#888" });

  const header = await page.locator("header").boundingBox();
  if (header) await seq.snap({ clip: header });

  await seq.snapPage({ style: ".cookie-banner { display: none }" });
});
```

`path` and `type` are not accepted: the sequence owns the file name and
format.

## 8. A state that arrives later

The readiness wait sees DOM mutations only. A chart drawn after a fetch, or a
video frame, needs its own wait. Prefer a locator; use `page.evaluate` only
with a timer, because it has no timeout of its own.

```ts
// captures/report.capture.ts
import { capture, disableTransitions } from "snapseq";

capture(async ({ page, seq }) => {
  await disableTransitions(page);
  await page.goto("/report");

  // The chart lands after a fetch, once the DOM has already been quiet.
  await page.locator(".chart svg path").first().waitFor();
  await seq.snap();   // 01.png

  // A video frame: seek, then wait for `seeked`, racing a 5 s timer so a video
  // that never seeks (no metadata, a blocked source) cannot hang the capture.
  const video = page.locator("video").first();
  await video.evaluate((el: HTMLVideoElement) =>
    Promise.race([
      new Promise<void>((done) => {
        el.addEventListener("seeked", () => done(), { once: true });
        el.pause();
        el.currentTime = 3;
      }),
      new Promise<void>((done) => setTimeout(done, 5000)),
    ]),
  );
  await seq.snap();   // 02.png
});
```

Never define a named function inside `page.evaluate`; arrows only. See
[Troubleshooting](troubleshooting.md#referenceerror-__name-is-not-defined).

## 9. An API without CORS on dev

A page on localhost calls an API that sends no `access-control-allow-origin`
for that origin, so the browser drops the response and the widget stays a
skeleton. Re-serve those responses through Playwright, which adds the header
and answers preflights itself. The `env` fixture keeps it to dev.

```ts
// captures/contact.capture.ts
import { capture, disableTransitions } from "snapseq";

capture(async ({ page, seq, env }) => {
  if (env === "dev") {
    await page.route("https://api.example.com/**", async (route) => {
      await route.fulfill({ response: await route.fetch() });
    });
  }
  await disableTransitions(page);
  await page.goto("/contact");
  await page.getByRole("form").waitFor();
  await seq.snap();
});
```

If the API sends a wrong `access-control-allow-origin` rather than none, fetch
first and rewrite the header:

```ts
// captures/contact-wrong-origin.capture.ts
import { capture } from "snapseq";

capture(async ({ page, seq, env, host }) => {
  if (env === "dev") {
    await page.route("https://api.example.com/**", async (route) => {
      const res = await route.fetch();
      await route.fulfill({
        response: res,
        headers: { ...res.headers(), "access-control-allow-origin": new URL(host).origin },
      });
    });
  }
  await page.goto("/contact");
  await seq.snap();
});
```

## 10. Two envs and a dev server

The config for a project with a local dev server, a password-protected
staging host that also wants a header, a production host with a saved login,
and three devices including one of Playwright's descriptors. A second argument
adds a browser flag.

```ts
// snapseq.config.ts
import { devices } from "@playwright/test";
import { defineConfig } from "snapseq";

export default defineConfig({
  envs: {
    dev: { host: "http://localhost:3000", webServer: "pnpm dev" },
    staging: {
      host: "https://staging.example.com",
      httpCredentials: { username: "preview", password: process.env.STAGING_PASSWORD ?? "" },
      use: { extraHTTPHeaders: { "x-preview-token": process.env.STAGING_TOKEN ?? "" } },
    },
    prod: { host: "https://www.example.com", use: { storageState: "captures/prod-session.json" } },
  },
  devices: {
    desktop: { viewport: { width: 1440, height: 900 } },
    phone: devices["iPhone 14"],
    "300x250": { viewport: { width: 300, height: 250 } },
  },
}, {
  use: { launchOptions: { args: ["--lang=de"] } },
});
```

```bash
pnpm screenshot                                  # dev; starts `pnpm dev` unless :3000 already answers
pnpm screenshot --env staging --device phone     # credentials and the header go to staging only
pnpm screenshot --env dev --host http://localhost:4000   # a server you started; `pnpm dev` is not run
```

Shots land under `<capture>/desktop/`, `<capture>/phone/` and
`<capture>/300x250/`.

## 11. Rerun one capture into the same run

Four captures; the third fails, so the fourth never runs (`maxFailures: 1`).
Rerun what failed into the same run directory, then the one that never ran.

```bash
pnpm screenshot
#   ✔ home / desktop      3 shots  4.2s
#   ✔ home / mobile       3 shots  4.9s
#   ✖ pricing / desktop   2 shots  31.0s  /pricing/team  Error: locator.click: Timeout 30000ms exceeded.
#   . pricing / mobile    not run
#   . landing / desktop   not run
#   . landing / mobile    not run
#
#   2 passed, 1 failed, 3 not run  8 shots  .screenshots/2026-10-01 at 04.07.16 PM

# Fix the capture, then rerun only the failed one, into the same run:
SNAPSEQ_RUN="2026-10-01 at 04.07.16 PM" pnpm screenshot --last-failed

# The ones that never ran, by name, same run:
SNAPSEQ_RUN="2026-10-01 at 04.07.16 PM" pnpm screenshot pricing --device mobile
SNAPSEQ_RUN="2026-10-01 at 04.07.16 PM" pnpm screenshot landing
```

Only the rerun capture's own `<capture>/<device>` directory is wiped; the
passed ones keep their shots. A rerun starts from `01.png` again, so it
replaces the failed attempt whole. From a monorepo root the same commands go
through `pnpm --filter <app> screenshot …`. To run every capture regardless of
failures, pass `--max-failures 0`.

## 12. A backend that rejects every request

A search form posts to a backend the capture cannot use: it sits behind a bot
check that rejects automated sessions, charges per call, or is down. Nothing
the browser sends can fix that. The prod env replays a recorded response for
that one request; the rest of the page, images included, stays live. The
capture is what a user does, and shows three things such forms often need:
validation that runs on blur, a checkbox whose `<input>` is invisible, and a
result that lands after the DOM-quiet wait.

```ts
// snapseq.config.ts
import { defineConfig } from "snapseq";

export default defineConfig({
  envs: {
    staging: { host: "https://staging.example.com" },   // the search works here
    prod: {
      host: "https://www.example.com",
      replay: { "**/api/search": "captures/replay/search.json" },
    },
  },
});
```

```ts
// captures/search.capture.ts
import { capture, disableTransitions } from "snapseq";

capture(async ({ page, seq }) => {
  await disableTransitions(page);
  await page.goto("/");
  const form = page.locator(".search-form");
  await form.locator("input[name=q]").fill("lamps");
  await form.locator("input[name=q]").press("Tab");     // the form validates on blur
  await form.locator(".consent label").click();         // the <input> is 0x0; the label takes the click
  await form.getByRole("button", { name: "Search" }).click();
  await form.locator(".results li").first().waitFor(); // arrives seconds later; not a DOM-quiet state
  await seq.snapPage();
});
```

```bash
pnpm screenshot --env prod --record --host https://staging.example.com   # records the file from staging
pnpm screenshot --env prod                                               # replays it against prod
```

The recorded file is one response as the backend sent it, so the page renders
real content. Commit it with the capture.
