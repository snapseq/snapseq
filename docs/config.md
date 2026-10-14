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
| `capturesDir`    | `"captures"`                           | Relative to the config file. Matches `*.capture.ts`.                    |
| `screenshotsDir` | `".screenshots"`                       | Relative to the config file. Snapseq writes a `.gitignore` inside it. |
| `numbering`      | `"00"`                                 | The shape of a shot number: `"00"` gives `01.png`, `"000"` gives `001.png`. Zeros only. Wide enough for the longest capture: `100.png` sorts before `99.png`. |
| `format`         | `{}` (PNG)                             | Playwright's screenshot `type` and `quality`: `{ type: "jpeg", quality: 60 }` writes `01.jpg`, … Quality is 0 to 100 and JPEG only, as in Playwright. |

## Envs

An env is a host and what it takes to reach it.

| Field             | Notes                                                                                                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`            | The base URL. `page.goto("/pricing")` resolves against it. `--host` or `SNAPSEQ_HOST` overrides it for one run.                                                                                                    |
| `httpCredentials` | HTTP basic auth, offered to the host's origin only (an overridden host counts). Playwright's `origin` field sends them somewhere else instead, e.g. a host that redirects to a second origin behind the same password. |
| `webServer`       | The command that serves `host`. See "Dev server".                                                                                                                                                                      |
| `use`             | This env's Playwright options, merged over the defaults below. A token in `extraHTTPHeaders`, a login in `storageState`, a `locale`: whatever Playwright takes, in its own words.                                       |
| `replay`          | Requests answered from recorded files instead of this env's backend, e.g. `{ "**/api/search": "captures/replay/search.json" }`. See "Replay".                                                                       |

An option that differs per env goes on the env, not in a composed override:

```ts
envs: {
  dev: { host: "http://localhost:3000" },
  staging: {
    host: "https://staging.example.com",
    use: { extraHTTPHeaders: { authorization: `Bearer ${process.env.STAGING_TOKEN}` } },
  },
  prod: { host: "https://www.example.com", use: { storageState: "captures/prod-session.json" } },
},
```

### Dev server

Give an env the command that serves it and snapseq starts it before the run:

```ts
dev: { host: "http://localhost:3002", webServer: "pnpm dev --port 3002" },
```

This is Playwright's `webServer`. The command runs from the config file's
directory and must listen on `host`. If something at `host` already passes
Playwright's readiness check (a 2xx, 3xx or 400–403 response after
redirects), it is reused and the command is not started. Otherwise the command
starts, with up to 120 s to become ready, and is stopped when the run ends,
Ctrl-C included. An overridden host (`--host`, `SNAPSEQ_HOST`) never starts
the command; point it at a server you run yourself. The server's stdout is
hidden and its stderr shown; `DEBUG=pw:webserver` shows everything.

### Replay

A page state that depends on a request this env cannot answer, such as a
backend behind a bot check that rejects automated sessions, one that charges
per call, or one that is simply down, comes from a recorded response instead:

```ts
prod: {
  host: "https://www.example.com",
  replay: { "**/api/search": "captures/replay/search.json" },
},
```

Each key is a Playwright `page.route` URL pattern and each value a file
relative to the config file. Before every capture, snapseq routes the pattern
and answers it with the file's contents as JSON. The request never reaches the
backend; the rest of the page stays live. A run whose file is missing fails
before its first shot and names the file.

`pnpm screenshot --record` (or `SNAPSEQ_RECORD=1`) fetches each request live
instead, writes its file, and answers with it. Record against a host where the
request succeeds, check the shot, and commit the file; every later run replays
it. `--host` points the env at such a host for the recording run:

```bash
pnpm screenshot --env prod --record --host https://staging.example.com
pnpm screenshot --env prod
```

Only an env with `replay` is affected. JSON bodies only; anything else goes
through Playwright's `page.routeFromHAR` in the capture.

## Devices

One Playwright project per key. The value is that project's `use` options, so
Playwright's own device descriptors work:

```ts
import { devices } from "@playwright/test";

devices: {
  desktop: { viewport: { width: 1440, height: 900 } },
  phone: devices["iPhone 14"],
  "300x250": { viewport: { width: 300, height: 250 } },   // a fixed-size page, e.g. an ad slot
},
```

The key is the directory name under each capture (`pricing/phone/01.png`),
the value of the `device` fixture, and what `--device` selects. It must be a
directory name, not a path.

## Playwright defaults

`defineConfig` applies these to the Playwright config:

| Option              | Value                           | Why                                                                                                                                       |
| ------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `workers`           | 1                               | Captures run one at a time, in order.                                                                                                     |
| `timeout`           | 10 min                          | The time allowed between shots, not per capture. See [Running](running.md#timeouts).                                                     |
| `actionTimeout`     | 30 s                            | Per click, fill and wait.                                                                                                                 |
| `navigationTimeout` | 120 s                           | Playwright's own default is no limit. This allows a cold dev build and still ends a `goto` that never settles.                            |
| `maxFailures`       | 1                               | Fail fast. `--max-failures 0` runs the rest.                                                                                              |
| `retries`           | 0                               | A retry would overwrite the first run's shots. Retries and `--repeat-each` are rejected.                                                  |
| `ignoreHTTPSErrors` | true                            | Self-signed staging certificates.                                                                                                         |
| `userAgent`         | headless token removed          | Headless Chromium's `HeadlessChrome` user agent is rewritten to `Chrome` unless you set `userAgent` yourself; some WAFs 403 the headless token. |
| `reporter`          | the terminal view               | Playwright's list reporter when stdout is not a terminal. See [Running](running.md#the-terminal).                                        |
| `outputDir`         | `node_modules/.cache/snapseq` | Playwright's own artifacts (traces, error context, `.last-run.json`) stay out of the screenshots dir.                                    |

## Overriding Playwright options

Extra arguments to `defineConfig` are overrides, merged the way Playwright's
own `defineConfig` merges them, which runs underneath: `use` is merged, the
rest replaced.

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

Merging concatenates `webServer` entries and replaces nested objects such as
`launchOptions` whole. To drop a generated `webServer`, spread the result
instead: `{ ...defineConfig({ /* … */ }), webServer: undefined }`.

Playwright's own artifacts go to `node_modules/.cache/snapseq`, so
`--trace on` leaves traces there, not among the screenshots.
