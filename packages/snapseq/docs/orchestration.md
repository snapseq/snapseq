# Orchestration

An orchestration file runs sequences in an order you choose, with settings you
choose for each, then works on the shots they took: a label strip on each,
one PDF per device, anything you can write as a function. A plain `snapseq`
run takes raw numbered shots and stops there. Write an orchestration when the
deliverable is more than that:

- one run folder holds sequences that need different devices or envs,
- the shots get labels, or are bound into PDFs,
- one part of a big run may need shooting again without redoing the rest.

## An example

A proof of three pages. The first is shot on desktop only, the second on both
devices against the `uat` env, the third on both plus a tablet. Then every shot
gets a dark label strip, and each device gets its own PDF.

```ts
// snapseq.config.ts
import { defineConfig } from "snapseq";

export default defineConfig({
  envs: {
    dev: { host: "http://localhost:3000" },
    uat: { host: "https://uat.example.com" },
  },
});
```

```ts
// snapseq/12345-spring-launch.seq.ts
import { sequence } from "snapseq";

sequence(async ({ page, seq }) => {
  await page.goto("/spring");
  await seq.snap({ label: "1.0 Launch" });
  await seq.snapPage({ label: "1.1 Launch, full page" });
});
```

`label` is typed once `@snapseq/label` is installed: see its
[README](https://github.com/snapseq/snapseq/tree/main/packages/label). The other
two sequences are files of the same kind.

```ts
// snapseq/spring.orchestration.ts
import { join } from "node:path";
import { defineOrchestration } from "snapseq";
import { label } from "@snapseq/label";
import { pdf } from "@snapseq/pdf";

export default defineOrchestration(async ({ run, config, dir }) => {
  const raw = [
    ...(await run("12345-spring-launch", { devices: ["desktop"] })),
    ...(await run("12346-spring-offer", { env: "uat" })),
    ...(await run("12347-spring-reminder", {
      devices: { ...config.devices, tablet: { viewport: { width: 1024, height: 1366 } } },
    })),
  ];

  const labelled = await label(raw, { theme: "dark", scale: (dsf) => dsf / 2 });

  for (const device of new Set(labelled.map((c) => c.device))) {
    await pdf(labelled.filter((c) => c.device === device), join(dir, `${device}.pdf`));
  }
});
```

Run the whole proof, then shoot one part of it again:

```bash
pnpm snapseq snapseq/spring.orchestration.ts --run review-1
pnpm snapseq snapseq/spring.orchestration.ts --run review-1 12346 --device mobile
```

The second command shoots `12346-spring-offer` on `mobile`, takes the other five
parts from the run, and runs the steps again over all of them. The run folder
afterwards holds the deliverables and the sequences, nothing else:

```
screenshots/review-1/
  desktop.pdf
  mobile.pdf
  tablet.pdf
  12345-spring-launch/
    desktop/
      01.png
      02.png
      labelled/01.png
      labelled/02.png
  12346-spring-offer/
    desktop/…
    mobile/…
  12347-spring-reminder/
    desktop/…
    mobile/…
    tablet/…
```

## The file

A file is an orchestration when its name ends in `.orchestration.ts` (or `.js`,
`.mts`, `.cts`, `.mjs`, `.cjs`). It can live anywhere. `snapseq/` is fine: only
`*.seq.*` files there are sequences. Its default export is the function that
`defineOrchestration` returns. The function is `async` and gets `{ run, config, dir }`;
what it returns is ignored.

snapseq loads the file and the config with jiti, rooted at the config file's
folder, so TypeScript and the `paths` of your `tsconfig.json` work without a
build. The config must export the result of `defineConfig` from snapseq 0.7 or
newer.

The function is plain code. Loops, conditions, `try`/`catch` and `console.log`
all work. snapseq adds one thing to it: `run()`.

## run()

```ts
run(sequence: string, options?: RunOptions, ...playwright: PlaywrightTestConfig[]): Promise<readonly Capture[]>
```

`run()` shoots one sequence now and waits for it. `sequence` is the file's
name in `sequencesDir` without `.seq.ts`: `"12345-spring-launch"`, or
`"campaign/pricing"` for a file in a folder. The sequence runs in its own
`playwright test` process on the devices of the call, and the promise resolves
to one capture per device, in device order. It rejects when any device did not
produce one: see [Errors](#errors).

Await every call. Calls do not overlap, and each sequence and device can be
captured once per orchestration.

### Options

`options` is a piece of the config for this call. Each key you give replaces the
config's key whole; keys you leave out keep the config's.

| Key              | Meaning                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| `devices`        | Names to pick from the config's, in that order: `["desktop"]`. Or a map that replaces the devices: `{ ...config.devices, tablet: { viewport: { width: 1024, height: 1366 } } }`. |
| `env`            | An env name from `envs`: shoot against it, and its host.                                                     |
| `host`           | Over the env's host, like `--host`. An `http://` or `https://` URL.                                          |
| `envs`, `defaultEnv`, `sequencesDir`, `screenshotsDir`, `numbering`, `format`, `stabilize` | As in [Config](config.md), for this call. |

Nothing else is accepted: an unknown key (`plugins` from a 0.6 config, say) is
refused before anything runs. Options are plain JSON, because they travel to
another process: no functions, no `undefined`.

`--env` and `--host` on the command line, or `SNAPSEQ_ENV` and `SNAPSEQ_HOST`,
win over the `env` and `host` of every call. The config is read without them,
so a call may bring in an env and select it:

```ts
await run("12346-spring-offer", {
  envs: { ...config.envs, preview: { host: "https://preview.example.com" } },
  env: "preview",
});
```

Four things follow from replacing whole keys:

- `envs: { uat: { host } }` drops every other env. Spread the rest: `{ ...config.envs, uat: { host } }`.
- `format: { quality: 70 }` drops `type: "jpeg"`, and Playwright refuses a quality on a PNG at the first shot. Spread: `{ ...config.format, quality: 70 }`.
- A `devices` map replaces the whole map, so a device you do not list is not shot. Spread `config.devices`, or pick names instead.
- `screenshotsDir` moves that call's captures. `dir` stays the orchestration's, so a PDF written to `dir` lands elsewhere than the shots it binds.

### Playwright overrides

The arguments after `options` are Playwright configs, merged the way extra
arguments to `defineConfig` are ([Config](config.md#overriding-playwright-options)),
after the config's own overrides and the call's options:

```ts
await run("12346-spring-offer", { env: "uat" }, { use: { locale: "de-DE" } });
```

They are plain JSON too. A `grep` that is a `RegExp`, or a `Buffer` in
`clientCertificates`, is refused with its path. `retries` above 0 and
`repeatEach` above 1 are refused, and so is `use.baseURL`: the host comes from
the env, `host` or `--host`. Whatever the overrides say, a child shoots only that
sequence's file, on the devices of the call, once.

## config and dir

`config` is the config with its defaults filled in: `envs`, `defaultEnv`,
`devices` (desktop and mobile when the config names none), `sequencesDir`,
`screenshotsDir`, `numbering`, `format` and `stabilize`. Paths are as the config
spells them, relative to the config file. Read it to build options, as the
example does with `config.devices`.

`dir` is this run's absolute folder, `<screenshotsDir>/<run>`. Put what the
orchestration makes there. The run's name is `--run`, else `SNAPSEQ_RUN`, else
the time the run started.

## Captures and shots

`run()` resolves to captures. A capture is one sequence on one device.

```ts
interface Capture {
  readonly sequence: string;   // "12345-spring-launch"
  readonly device: string;     // "desktop"
  readonly env: string;
  readonly host: string;
  readonly dir: string;        // the absolute folder the shots are in
  readonly reused: boolean;    // a filter left this part out; it came from the run's cache
  readonly shots: readonly CaptureShot[];
}

interface CaptureShot {
  readonly index: number;      // from 1
  readonly name: string;       // "01.png"
  readonly path: string;       // absolute
  readonly url: string;        // the page when the shot was taken
  readonly notes: readonly string[];   // the notes the terminal prints with the shot
  readonly deviceScaleFactor: number;  // the file's pixels per CSS pixel
  readonly format: { type: "png" | "jpeg"; quality?: number };  // what the file is
  readonly options: SnapOptions;       // what snap() was called with
}
```

`Capture`, `CaptureShot`, `RunOptions`, `ResolvedSnapseqConfig`, `Orchestration`
and `OrchestrationContext` are exported from `snapseq`.

A capture is plain data. `shot.options` is what the sequence passed to `snap` or
`snapPage`, as JSON: a `mask` is left out, and `label` text stays, which is how a
step knows which shots to label. Shots are in the order they were taken.

## Steps

A step is an async function that takes captures. It runs in the orchestration's
own process, after the captures it needs exist, so it can take functions as
options and nothing has to cross a process. Two ship as packages:

| Package | Step |
| ------- | ---- |
| [`@snapseq/label`](https://github.com/snapseq/snapseq/tree/main/packages/label) | `label(captures, options)` writes a `labelled/` folder in each capture's folder, a strip above the shots whose `options.label` is set and a plain copy of the rest. It resolves to the captures pointing at those files. |
| [`@snapseq/pdf`](https://github.com/snapseq/snapseq/tree/main/packages/pdf) | `pdf(captures, file)` binds the shots of any captures, in the order given, into one PDF, and resolves to `file`. |

Install what you use, in the app that has snapseq:

```bash
pnpm add -D @snapseq/label @snapseq/pdf
```

Steps compose by hand. `label` returns captures, so `pdf` can bind its result
(the labelled shots) or the raw captures. Which captures go into which file is
your code: group by `device`, by `sequence`, or put them all in one.

A step you write is a function of the same shape. This one writes a list of the
shots and their pages:

```ts
// snapseq/steps/manifest.ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Capture } from "snapseq";

export async function manifest(captures: readonly Capture[], dir: string): Promise<string> {
  const lines = captures.flatMap((c) =>
    c.shots.map((s) => `${c.sequence}/${c.device}/${s.name}  ${s.url}`),
  );
  const file = join(dir, "manifest.txt");
  await writeFile(file, `${lines.join("\n")}\n`);
  return file;
}
```

```ts
import { manifest } from "./steps/manifest.js";
// …
await manifest(raw, dir);
```

A step that makes new files should leave the raw shots alone and return captures
for what it made, as `label` does: the same captures with `dir` and every shot's
`path` changed. This one copies the shots into a delivery folder and hands back the
copies:

```ts
// snapseq/steps/collect.ts
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Capture } from "snapseq";

export async function collect(captures: readonly Capture[], into: string): Promise<Capture[]> {
  const out: Capture[] = [];
  for (const c of captures) {
    const dir = join(into, c.sequence, c.device);
    await mkdir(dir, { recursive: true });
    for (const s of c.shots) await copyFile(s.path, join(dir, s.name));
    out.push({ ...c, dir, shots: c.shots.map((s) => ({ ...s, path: join(dir, s.name) })) });
  }
  return out;
}
```

Steps print nothing. A step that throws ends the run (see [Errors](#errors)). A
`console.log` in the orchestration works.

## Running it

```bash
pnpm snapseq <file>.orchestration.ts [--run <name> [sequence...] [--device <name>]] [options]
```

Any argument that ends in `.orchestration.ts` (or the other extensions) switches
snapseq to this mode. The run's folder is named by `--run`, else `SNAPSEQ_RUN`, else
the time the run started.
The flags it takes, and the ones it refuses, are in [Running](running.md#orchestration-runs).

What to shoot is in the file, so the words after it are not Playwright's file
filter and `--device` is not its `--project`: they select parts to shoot again
([Repairs](#repairs)).

## Repairs

One part of a run is wrong: a page changed, a shot was caught mid-animation. Name
the run and say which parts to shoot again:

```bash
pnpm snapseq snapseq/spring.orchestration.ts --run review-1 12346 --device mobile
```

- Words after the file are sequence filters. A part matches when its sequence id
  contains one of them as plain text, not a regular expression and not a path.
- `--device <name>` is an exact device name, and may be repeated.
- A part is a sequence on a device. It matches when it passes both filters; a
  filter left out matches everything.

The file runs again from the top. A `run()` for a part that matches shoots it.
A `run()` for a part that does not match returns the capture the run's cache has
for it, with `reused: true`, without starting a child. Then every step runs again over
all the captures, the reused ones included, and writes its files again.

The cache is `node_modules/.cache/snapseq/runs/<run>.json`, beside the config. A
capture comes out of it only if the config, the sequences folder, the sequence
file and the screenshots folder are the ones it was taken with, and every shot is
still a file. Otherwise the part is shot, and the terminal says so before it starts
(`building, no capture yet`). It does not count as a match.

Things to know:

- The cache does not remember options. If you change what `run()` is given for a
  part, shoot that part again with a filter.
- A filter needs `--run` naming an earlier run, and a part to match, or the run
  fails with `no part matched "zzz"`.
- A shot again wipes the sequence's folder on that device first, `labelled/` inside it
  too. The steps write it again.
- A plain `pnpm snapseq --run review-1` (not `SNAPSEQ_RUN`) into the same run drops the
  run's cache. The next repair shoots every part it finds no capture for.
- Two snapseq processes cannot write one run: the second stops with
  `snapseq: another snapseq (pid N) is writing this run`.
- The reshoot hint prints after a full run that passed. It does not print after a repair.

## What the terminal shows

Each child draws its own rows, as a plain run does: one line per sequence and device,
the shot it is on and its URL, the server wait, the error line
([Running](running.md#the-terminal)). snapseq adds the lines around them.

```
  snapseq  spring.orchestration.ts  review-1

  ✔ 12345-spring-launch / desktop    2 shots  1.5s
  ✔ 12346-spring-offer / desktop (uat)     2 shots  1.5s
  ✔ 12346-spring-offer / mobile (uat)      2 shots  1.5s
  ✔ 12347-spring-reminder / desktop  2 shots  1.5s
  ✔ 12347-spring-reminder / mobile   2 shots  1.5s
  ✔ 12347-spring-reminder / tablet   2 shots  1.5s

  6 passed  12 shots  22s  screenshots/review-1
  reshoot one part: snapseq snapseq/spring.orchestration.ts --run review-1 <sequence> --device <device>
```

- The heading names the file and the run.
- A row names the env, `(uat)`, when the env in use is not the default.
- After a repair, a part it did not shoot gets a line of its own, `reused  2 shots`.
  A part with nothing to reuse says `building, no capture yet`.
- The footer counts every part by outcome (`6 passed, 1 reused`), the shots in all
  the captures, the time and the run folder. When the run ended on an error, a
  `failed  <message>` line comes before it. After Ctrl-C the last line is
  `interrupted  <run folder>` and there is no footer.
- On an interactive run the run folder then opens in a file manager window, once,
  passed or failed but not after Ctrl-C. `SNAPSEQ_OPEN=0` keeps it closed.
- Piped, in CI, or with `--debug`, each child prints Playwright's list reporter
  instead of rows, inside the same heading and footer.

The exit code is 0 when the run ended well, 1 for an error, a missing `await` or
`no part matched`, and 130 for Ctrl-C.

Ctrl-C stops the child the way it stops a plain run, then ends the run: no further
`run()` starts.

## Errors

`run()` rejects with a message that ends with the call site, like
`(spring.orchestration.ts:9)`. Catch it to carry on, or leave it: an error nothing
catches ends the run with `failed  <message>` and exit code 1.

Before any child starts, nothing is shot:

| Message starts with | Cause |
| ------------------- | ----- |
| `unknown option "plugins"; options take …` | A key `run()` does not take. The list names the ones it does. |
| `options must be an object` | `options` is not a plain object. |
| `a sequence id names a file in snapseq/ …` | The id is not a name, or is a path out of the folder. |
| `no snapseq/<id>.seq.ts; sequences: …` | No such file. The message lists the ids it found. |
| `one sequence, N files: …; keep one` | The id matches `.seq.ts` and `.seq.js`, say. |
| `unknown device "x" at options.devices[0]; devices: …` | A name not in the config's `devices`. |
| `options.devices is empty; pick at least one device` | An empty list. |
| `device "x" twice in options.devices, at [1]` | A name picked twice. |
| `options.devices must be device names or a map …` | Neither names nor a map of use options. |
| `options.devices["a/b"]: a device name is a folder name …` | A key with a `/` or `\`. A value that is not an object: `options.devices.x must be Playwright use options …`. |
| `unknown env "x" at options.env; envs: …` | An env not in `envs`. `options.defaultEnv` gets the same check, and `--env` its own: `unknown env "x" from --env or SNAPSEQ_ENV; this run's envs: …`. |
| `options.envs must map env names to { host }` | An empty or malformed map. An env without a host: `options.envs.x needs a host`. |
| `options.host must be an http(s) URL` | A host such as `localhost:3000`. |
| `… is a RegExp`, `… is a Buffer`, `… is undefined` | Something that is not plain JSON, with its path. |
| `playwright[0] must be a Playwright config object` | An override that is not an object. |
| `playwright[0].use.baseURL is set; …` | Also on a device or an env's `use`. The host comes from the env, `host` or `--host`. |
| `playwright[0].retries is 2; …`, `….repeatEach is 2; …` | Retries and repeats overwrite shots. |
| `options.numbering must be zeros …` | As in [Config](config.md#fields). |
| `options.screenshotsDir must be a folder …` | An empty or non-string path. |
| `options.sequencesDir must be a folder …` | An empty or non-string path. |
| `<sequence>/<device> already captured by this orchestration` | A part can be captured once. |
| `run("x") while "y" is running; await it first` | Two calls at once. |
| `run("x") after the orchestration stopped` | A call that came after Ctrl-C or an error ended the run. |

After the child ran, with its output still on your terminal above the error:

| Message starts with | Cause |
| ------------------- | ----- |
| `<sequence> failed on mobile` | The sequence failed on a device. When `maxFailures` stopped the others: `<sequence> failed on desktop, not run on mobile after desktop failed`. |
| `<sequence> was skipped on mobile: "desktop only"` | A `skipIf` skipped a device. Pick the devices instead: `devices: ["desktop"]`. |
| `<sequence> never used seq on desktop` | The sequence never used the `seq` or `ctx` fixture, so it has no capture. |
| `<sequence> reported no usable capture on mobile: …` | The child's capture did not check out: no capture, or a shot file missing. |
| `<sequence> was retried on mobile; retries must be 0` | A retry, which would overwrite the shots. |
| `<sequence> ran 2 tests; one sequence per file` | The file has more than one `sequence()` or test. |
| `<sequence>: …` | An error outside any test, such as a dev server that never came up. The text is the error's first line. |
| `<sequence>: child exited before reporting …` | The child died or never started its tests, e.g. a config error; read its output. |
| `<sequence>: child ended with 1 after reporting passed …` | The child's exit disagrees with its report. |
| `<sequence>: was interrupted …` | The child was stopped. |

A rejected call keeps the devices that passed. If you catch it and call `run()` again
with the same options, the devices that passed come back with `reused: true` and only
the ones that failed are shot again.

Ending the run:

| Message | Cause |
| ------- | ----- |
| `run("x") was not awaited; the orchestration finished first` | The function returned with a call still going. The child is stopped. |
| `no part matched "zzz"` | A repair whose filters matched no part. |
| `<the step's message>` | A step threw, e.g. `@snapseq/pdf: nothing to bind`. |

Before the file runs, the command itself refuses what cannot work, with a message that
starts `snapseq:`: a filter without `--run`, a `--run` that names no folder, a
flag the mode refuses, a file with no default export, a config that is not from
`defineConfig` in 0.7 or newer.

## Limits

- One call at a time. Children do not run in parallel; each `run()` is one
  `playwright test`, so each starts its own browser.
- An env's `webServer` is started and stopped by each child, unless something
  already answers at its host. Start the server yourself and keep it running for the
  length of the orchestration.
- Options and Playwright overrides are JSON. Page setup that needs a function belongs
  in the sequence or in a Playwright fixture.
- A part is captured once per orchestration. Catching a failed call and calling it again
  is allowed.
- `maxFailures` is 1 in each child: after a device fails, the call's other devices
  are not shot. `--max-failures 0` shoots them; the call still rejects.
- The run cache lives in `node_modules/.cache/snapseq`, beside the config. An
  `outputDir` that Playwright would empty over it is refused.
