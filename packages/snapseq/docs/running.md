# Running

```bash
pnpm screenshot                              # every capture, every device
pnpm screenshot pricing                      # captures whose path matches "pricing"
pnpm screenshot pricing --device mobile
pnpm screenshot --env staging                # or SNAPSEQ_ENV=staging
pnpm screenshot --host http://localhost:4000 # or SNAPSEQ_HOST=…
SNAPSEQ_RUN=review-1 pnpm screenshot      # name the run dir instead of the timestamp
pnpm screenshot --headed                     # also --ui, --debug, --trace on, --reporter json
pnpm screenshot --help
```

From a monorepo root: `pnpm --filter <app> screenshot pricing --device desktop`.

A filter is a regular expression matched against each capture file's absolute
path, not its name. `pricing` also matches a folder named pricing anywhere
above the file, and `home` matches every capture on a machine whose path
contains `/home/`. When the word could appear in the path, filter with a path
fragment that includes the captures folder (`captures/home`) or the file name
with its extension (`home.capture.ts`).

`snapseq` translates its own flags, finds `snapseq.config.ts` in the
current directory (or takes `-c <path>`), and hands everything else to
`playwright test`, the copy installed beside that config. So `--headed`, `--ui`, `--debug`, `--trace on`,
`--reporter json`, `--max-failures 0` and the rest work as in Playwright.

## Flags and variables

| Flag                  | Variable          | Effect                                                                                        |
| --------------------- | ----------------- | --------------------------------------------------------------------------------------------- |
| `[filter...]`         |                   | Playwright's file filter: captures whose path matches.                                        |
| `--env <name>`        | `SNAPSEQ_ENV`  | The env from the config. Default: `defaultEnv`, else `dev`, else the first.                   |
| `--host <url>`        | `SNAPSEQ_HOST` | Override that env's host for this run. A host different from the env's does not start its `webServer`. |
| `--device <name>`     |                   | Only this device; repeatable. Playwright's `--project`.                                       |
| `--record`            | `SNAPSEQ_RECORD` | Fetch the env's `replay` requests live and write their files. The variable takes `1` or `true` to record, `0`, `false` or empty not to; anything else is an error. The flag takes `--record=0` and the like, but `--record=` is an error, and `--record 0` records and passes `0` to Playwright as a file filter. On an env without `replay` it does nothing. See [Config](config.md#replay). |
| `-c, --config <path>` |                   | The config file. Default: `./snapseq.config.{ts,mts,cts,js,mjs,cjs}`.                      |
|                       | `SNAPSEQ_RUN`  | The run directory's name. Default: the local time the run started. A name, not a path.        |
|                       | `SNAPSEQ_OPEN` | `0` or `false` (any case) keeps the run directory's file manager window closed at the end of an interactive run. See [The terminal](#the-terminal). |

The flag wins over the variable. An empty value (`--env ""`) means unset.

## Run directories

Every run gets its own directory named for the local time it started
(`2026-10-01 at 04.07.16 PM`), shared by all captures in that run:

```
.screenshots/
  2026-10-01 at 04.07.16 PM/
    pricing/desktop/01.png
    pricing/desktop/02.png
    pricing/desktop/shots.txt
    pricing/mobile/…
    campaign/landing/desktop/…
```

Within a run, a capture's `<capture>/<device>` directory is wiped when that
capture starts. So the run name and the device names must be directory names,
not paths, and a directory outside the screenshots dir is never wiped. A
capture whose directory holds another capture's output is refused instead; see
[Troubleshooting](troubleshooting.md).
Retries and `--repeat-each` are rejected because a second run would overwrite
the first.

A run lives in `.screenshots/<run>` (`screenshotsDir`, beside the config),
`<run>` being the time it started. The terminal summary prints the path; a
piped or CI run does not. For scripts and CI, name the run:
`SNAPSEQ_RUN=nightly pnpm screenshot` writes `.screenshots/nightly/`. A name
used twice is the same directory: only the captures that run again are wiped.

`shots.txt` in each directory lists every file with the URL it was taken at
and its notes: what was still pending when a readiness wait ran out, or what a
plugin noted:

```
01.png  http://localhost:3000/pricing
02.png  http://localhost:3000/pricing
03.png  http://localhost:3000/pricing/team  2 images still loading after 5 s (first: http://localhost:3000/img/team-hero.jpg)
```

## Rerunning

`pnpm screenshot --last-failed` reruns the captures that failed last time. It
is not a resume: with `maxFailures: 1` the captures that never ran are not
included, and a rerun capture starts from `01.png` again. Set
`SNAPSEQ_RUN=<that run>` to write into the same run directory; only the
rerun capture's own directory is wiped.

```bash
SNAPSEQ_RUN="2026-10-01 at 04.07.16 PM" pnpm screenshot --last-failed
```

[Example 11](examples.md#11-rerun-one-capture-into-the-same-run) walks through it.

## Timeouts

The timeout (10 min, Playwright's `timeout`) is the time allowed between
shots, not per capture: every shot moves the deadline, so a capture of any
length passes as long as it keeps landing shots, and one that hangs dies 10
minutes after its last. The live terminal view then says `No shot for 10
min.` The list reporter (CI, a pipe) prints Playwright's own `Test timeout of
…ms exceeded.` instead, and its number is the time since the capture started.

A `goto` is bounded separately, at 120 s (`navigationTimeout`), and every
click, fill and wait at 30 s (`actionTimeout`).
[Config](config.md#playwright-defaults) lists them all.

## When a capture fails

A capture that fails or times out leaves `failed.png` beside the shots it did
take: the page as the teardown found it, when it can still be shot (5 s at
most). `shots.txt` gets a `failed.png` line with that URL, and the terminal
names that page as where it died. Images still loading, including `<picture>`
sources and those in frames, are abandoned (their `src` and `srcset` removed)
before that shot, so one that never answers cannot hold it back. The run stops
there (`maxFailures: 1`); `--max-failures 0` runs the rest.

## The terminal

An interactive run (stdout is a terminal) draws one live frame, redrawn in
place: a header with the env, host, run and elapsed time; one line per capture
and device in the order the run takes them, each changing in place like a todo
list; and a footer.

```
  snapseq  dev  http://localhost:3000  2026-10-01 at 04.07.16 PM  00:10

  ✔ home / desktop     3 shots  4.2s
  - landing / desktop  skipped  mobile only
  ⠋ pricing / desktop  2 shots  00:05  /pricing/team
  . home / mobile      queued
  . landing / mobile   queued
  . pricing / mobile   queued

  1 passed, 1 skipped  5 shots  .screenshots/2026-10-01 at 04.07.16 PM
```

A row is queued, running (shots so far, how long, the path of the last shot),
passed (shots and duration), failed, timed out or interrupted (the same, then
where it died and the first error line), skipped (the reason), or not run
(still queued when the run stopped). Shots are discovered as a capture runs, so
there is no total to count towards. Until the first row finishes the footer
reads `0/M done`, M being the rows planned; after that it counts rows by
outcome, as in the sample.
A list longer than the terminal scrolls with the work, the running row always
in view, with a line each for what is hidden above and below as room allows. A
label or path
too long for its line is cut from the left (`…/enterprise-pricing / desktop`).
Below 7 rows there is no room for a frame, and the view prints one line per
event instead.

When the run ends the frame is replaced by a summary with the rows that ran,
were skipped or were interrupted (the footer counts the rest, `not run`
included; Playwright's JSON reporter has the full inventory), full error
messages and the run directory. That directory then opens in a file manager
window (Finder on macOS, Explorer on Windows, the desktop's file manager on
Linux), whether the run passed or failed, but not after Ctrl-C.
`SNAPSEQ_OPEN=0` (or `false`) keeps the window closed. Only an interactive run
does this; pipes and CI never get a window. Resizing the terminal mid-run
freezes the frame as it is: every finished row is printed under it in full, and
the rest follow one line per event.

Before the first capture, while Playwright brings up the env's dev server, one
line says what the run is waiting for and for how long:
`waiting for http://localhost:3002  pnpm dev  00:14`. It appears after the
first second, so a server that is already up never shows it.

Passed is green, failed red, rows that did nothing are dimmed; `NO_COLOR` or
`FORCE_COLOR=0` drops the colors. A terminal that cannot draw the marks (the
Linux console, Windows outside Windows Terminal) gets words instead: `ok`,
`FAIL`, `skip`.

When stdout is not a terminal (a pipe), `CI` or `PWDEBUG` is set, `TERM` is
`dumb`, or the flags `--list`, `--debug`, `--ui`, `--ui-host` or `--ui-port`
are given, the run uses Playwright's list reporter with one line per shot,
file and URL, instead. It ends with Playwright's count (`2 passed (4.9s)`), not
the summary line, and does not print the run directory: see
[Run directories](#run-directories) to find it. `--reporter list` or any other
reporter flag overrides the default either way.
