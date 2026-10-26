# Examples

Complete files, basic to complex. Each one is a sequence in `snapseq/` unless
it says otherwise; names are placeholders.

## 1. One page, two shots

The smallest sequence: open a page, shoot the viewport and the whole page.

```ts
// snapseq/pricing.seq.ts
import { sequence } from "snapseq";

sequence(async ({ page, seq }) => {
  await page.goto("/pricing");
  await seq.snap();      // 01.png  the viewport
  await seq.snapPage();  // 02.png  the whole page
});
```

Writes `pricing/desktop/01.png` and `02.png`, then the same under
`pricing/mobile/`.

## 2. Several pages, one sequence

A site walk. Shots stay numbered in order across navigations, and
`addPersistentStyle` hides a widget on every page, because it re-applies on
each navigation.

```ts
// snapseq/site.seq.ts
import { addPersistentStyle, sequence } from "snapseq";

const routes = ["/", "/pricing", "/docs", "/blog"];

sequence(async ({ page, seq }) => {
  await addPersistentStyle(page, "#chat-widget { display: none !important }");
  for (const route of routes) {
    await page.goto(route);
    await seq.snapPage();
  }
});
```

## 3. A device-only state

The `device` fixture is the `devices` key. A state that exists on one device
only is a branch in the body; the other device gets fewer shots.

```ts
// snapseq/home.seq.ts
import { sequence } from "snapseq";

sequence(async ({ page, seq, device }) => {
  await page.goto("/");
  await seq.snap();                                 // 01.png  both devices
  if (device === "mobile") {
    await page.getByRole("button", { name: "Menu" }).click();
    await page.getByRole("navigation").waitFor();   // what the shot needs, then the shot
    await seq.snap();                               // 02.png  mobile only
  }
});
```

## 4. A desktop-only sequence

`skipIf` at the top of the file runs before any fixture, so the skipped
device gets no directory ([Sequences](sequences.md#skipping)). With
`skipIf(({ device }) => device !== "desktop", "desktop only")` in
`snapseq/dashboard.seq.ts`, the reason shows in the terminal:

```
  ✔ dashboard / desktop  1 shot  2.8s
  - dashboard / mobile   skipped  desktop only
```

A condition you only learn once the page is open goes inside the body:

```ts
// snapseq/beta.seq.ts
import { sequence, skipIf } from "snapseq";

sequence(async ({ page, seq }) => {
  await page.goto("/beta");
  skipIf(await page.getByRole("heading", { name: "Coming soon" }).isVisible(), "not launched");
  await seq.snapPage();
});
```

## 5. A helper that takes the shot

A menu closes on every navigation. Put the precondition in the helper that
takes the shot, so every call gets it. The helper takes a `SequenceContext`;
the `ctx` fixture is one.

```ts
// snapseq/helpers/snap-menu.ts
import type { SequenceContext } from "snapseq";

export async function snapMenuOpen({ page, seq }: SequenceContext): Promise<string> {
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("navigation").waitFor();
  return seq.snap();
}
```

```ts
// snapseq/menus.seq.ts
import { sequence, skipIf } from "snapseq";
import { snapMenuOpen } from "./helpers/snap-menu";

skipIf(({ device }) => device !== "mobile", "the menu is a drawer on mobile only");

sequence(async ({ ctx, page, seq }) => {
  for (const route of ["/", "/pricing", "/docs"]) {
    await page.goto(route);   // navigation closes the drawer
    await seq.snap();         // closed
    await snapMenuOpen(ctx);  // open, every time
  }
});
```

## 6. A sticky tray

A promo tray docks to the bottom of the viewport and lands in its slot when
the page end scrolls into view. `snapPage` grows the viewport to the page
height, so the tray lands and the shot shows it in place.

```ts
// snapseq/landing.seq.ts
import { sequence } from "snapseq";

sequence(async ({ page, seq }) => {
  await page.goto("/landing");
  await seq.snapPage();                // 01.png  the tray rests in its slot at the page end

  await page.goto("/landing/video");   // a script sizes the page from innerHeight
  await seq.snap({ fullPage: true });  // 02.png  native full page; sticky elements stay pinned
});
```

Calling `snapPage` on the second page fails with
`snapPage: the document grew from 2140 to 3220 px after the viewport was set to its height …
Use snap({ fullPage: true }) for this page.`

## 7. Masking and clipping

Both shots take Playwright's screenshot options, `snapPage` all but
`fullPage`. Mask what changes between runs, clip to a region, inject CSS for
one shot.

```ts
// snapseq/account.seq.ts
import { sequence } from "snapseq";

sequence(async ({ page, seq }) => {
  await page.goto("/account");
  await seq.snap({ mask: [page.locator("time"), page.getByTestId("avatar")], maskColor: "#888" });

  const header = await page.locator("header").boundingBox();
  if (header) await seq.snap({ clip: header });

  await seq.snapPage({ style: ".cookie-banner { display: none }" });  // a fixed overlay: hiding it moves nothing
});
```

`style` is applied after `snapPage` has measured the page, so use it for CSS
that moves nothing, like hiding a fixed overlay. CSS that changes layout goes
in `addPersistentStyle`.

`path`, `type` and `quality` are not accepted: snapseq owns the file name
and format.

## 8. A state that arrives later

The readiness wait sees DOM mutations only. A chart drawn after a fetch, or a
video frame, needs its own wait. Prefer a locator; use `page.evaluate` only
with a timer, because it has no timeout of its own.

```ts
// snapseq/report.seq.ts
import { sequence } from "snapseq";

sequence(async ({ page, seq }) => {
  await page.goto("/report");

  // The chart lands after a fetch, once the DOM has already been quiet.
  await page.locator(".chart svg path").first().waitFor();
  await seq.snap();   // 01.png

  // A video frame: seek, then wait for `seeked`, racing a 5 s timer so a video
  // that never seeks (no metadata, a blocked source) cannot hang the sequence.
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
// snapseq/contact.seq.ts
import { sequence } from "snapseq";

sequence(async ({ page, seq, env }) => {
  if (env === "dev") {
    await page.route("https://api.example.com/**", async (route) => {
      await route.fulfill({ response: await route.fetch() });
    });
  }
  await page.goto("/contact");
  await page.getByRole("form").waitFor();
  await seq.snap();
});
```

If the API sends a wrong `access-control-allow-origin` rather than none, fetch
first and rewrite the header:

```ts
// snapseq/contact-wrong-origin.seq.ts
import { sequence } from "snapseq";

sequence(async ({ page, seq, env, host }) => {
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
    prod: { host: "https://www.example.com", use: { storageState: "snapseq/prod-session.json" } },
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

The iPhone descriptor runs on WebKit: install it with
`pnpm exec playwright install webkit`, or see [Devices](config.md#devices) for
the Chromium override.

```bash
pnpm snapseq                                  # dev; starts `pnpm dev` unless :3000 already answers
pnpm snapseq --env staging --device phone     # staging: credentials to its origin, the header to every origin its pages load
pnpm snapseq --env dev --host http://localhost:4000   # a server you started; `pnpm dev` is not run
```

Shots land under `<sequence>/desktop/`, `<sequence>/phone/` and
`<sequence>/300x250/`.

## 11. Rerun one sequence into the same run

Three sequences on two devices; the third row fails, three never run
(`maxFailures: 1`). Rerun what failed into the same run directory, then the
ones that never ran.

```bash
pnpm snapseq
#   ✔ home / desktop     3 shots  4.2s
#   ✔ landing / desktop  3 shots  4.9s
#   ✖ pricing / desktop  2 shots  31.0s  /pricing/team  Error: locator.click: Timeout 30000ms exceeded.
#
#   2 passed, 1 failed, 3 not run  8 shots  screenshots/2026-10-01 at 04.07.16 PM

# Fix the sequence, then rerun only the failed one, into the same run:
SNAPSEQ_RUN="2026-10-01 at 04.07.16 PM" pnpm snapseq --last-failed

# The ones that never ran, by device, same run:
SNAPSEQ_RUN="2026-10-01 at 04.07.16 PM" pnpm snapseq --device mobile
```

Only the rerun sequence's own `<sequence>/<device>` directory is wiped; the
passed ones keep their shots. A rerun starts from `01.png` again, so it
replaces the failed attempt whole. From a monorepo root the same commands go
through `pnpm --filter <app> exec snapseq …`. To rerun one sequence by name, give its
id, `pnpm snapseq pricing`, or a quoted glob for a folder, `pnpm snapseq 'campaign/*'`.
To run every sequence regardless of failures, pass `--max-failures 0`.

## 12. A backend that rejects every request

A search form posts to a backend the sequence cannot use: it sits behind a bot
check that rejects automated sessions, charges per call, or is down. Nothing
the browser sends can fix that. The prod env replays a recorded response for
that one request; the rest of the page, images included, stays live. The
sequence is what a user does, and shows three things such forms often need:
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
      replay: { "**/api/search": "snapseq/replay/search.json" },
    },
  },
});
```

```ts
// snapseq/search.seq.ts
import { sequence } from "snapseq";

sequence(async ({ page, seq }) => {
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
pnpm snapseq --env prod --record --host https://staging.example.com   # records the file from staging
pnpm snapseq --env prod                                               # replays it against prod
```

The recorded file is one response as the backend sent it, so the page renders
real content. Commit it with the sequence.
