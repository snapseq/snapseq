# Running

```bash
pnpm snapseq                              # every sequence, every device
pnpm snapseq pricing                      # sequences whose path matches "pricing"
pnpm snapseq pricing --device mobile
pnpm snapseq --env staging                # or SNAPSEQ_ENV=staging
pnpm snapseq --host http://localhost:4000 # or SNAPSEQ_HOST=…
pnpm snapseq --run review-1               # name the run dir instead of the timestamp (or SNAPSEQ_RUN=review-1)
pnpm snapseq --headed                     # also --ui, --debug, --trace on, --reporter json
pnpm snapseq --help
pnpm snapseq snapseq/spring.orchestration.ts --run review-1   # an orchestration file: see below
```

From a monorepo root: `pnpm --filter <app> exec snapseq pricing --device desktop`.

A filter is a regular expression matched against each sequence file's absolute
path, not its name. `pricing` also matches a folder named pricing anywhere
above the file, and `home` matches every sequence on a machine whose path
contains `/home/`. When the word could appear in the path, filter with a path
fragment that includes the snapseq folder (`snapseq/home`) or the file name
with its extension (`home.seq.ts`).

`snapseq` translates its own flags, finds `snapseq.config.ts` in the
current directory (or takes `-c <path>`), and hands everything else to
`playwright test`, the copy installed beside that config. So `--headed`, `--ui`, `--debug`, `--trace on`,
`--reporter json`, `--max-failures 0` and the rest work as in Playwright.

## Flags and variables

| Flag                  | Variable          | Effect                                                                                        |
| --------------------- | ----------------- | --------------------------------------------------------------------------------------------- |
| `[filter...]`         |                   | Playwright's file filter: sequences whose path matches.                                        |
| `--env <name>`        | `SNAPSEQ_ENV`  | The env from the config. Default: `defaultEnv`, else `dev`, else the first.                   |
| `--host <url>`        | `SNAPSEQ_HOST` | Override that env's host for this run. A host different from the env's does not start its `webServer`. |
| `--device <name>`     |                   | Only this device; repeatable. Playwright's `--project`.                                       |
| `--record`            | `SNAPSEQ_RECORD` | Fetch the env's `replay` requests live and write their files. The variable takes `1` or `true` to record, `0`, `false` or empty not to; anything else is an error. The flag takes `--record=0` and the like, but `--record=` is an error, and `--record 0` records and passes `0` to Playwright as a file filter. On an env without `replay` it does nothing. See [Config](config.md#replay). |
| `-c, --config <path>` |                   | The config file. Default: `./snapseq.config.{ts,mts,cts,js,mjs,cjs}`.                      |
| `--run <name>`        | `SNAPSEQ_RUN`  | The run directory's name. Default: the local time the run started. A name, not a path. Into a name already used, only the sequences that run again are wiped. The flag, not the variable, also drops the run's orchestration cache: see [Repairs](orchestration.md#repairs). |
|                       | `SNAPSEQ_OPEN` | `0` or `false` (any case) keeps the run directory's file manager window closed at the end of an interactive run. See [The terminal](#the-terminal). |

The flag wins over the variable. An empty value (`--env ""`) means unset.

## Run directories

Every run gets its own directory named for the local time it started
(`2026-10-01 at 04.07.16 PM`), shared by all sequences in that run:

```
screenshots/
  2026-10-01 at 04.07.16 PM/
    pricing/desktop/01.png
    pricing/desktop/02.png
    pricing/mobile/…
    campaign/landing/desktop/…
```

Within a run, a sequence's `<sequence>/<device>` directory is wiped when that
sequence starts. So the run name and the device names must be directory names,
not paths, and a directory outside the screenshots dir is never wiped. A
sequence whose directory another sequence file writes into is refused instead;
see [Troubleshooting](troubleshooting.md).
Retries and `--repeat-each` are rejected because a second run would overwrite
the first.

A run lives in `screenshots/<run>` (`screenshotsDir`, beside the config),
`<run>` being the time it started. The terminal summary prints the path; a
piped or CI run does not. For scripts and CI, name the run:
`pnpm snapseq --run nightly` (or `SNAPSEQ_RUN=nightly`) writes `screenshots/nightly/`. A name
used twice is the same directory: only the sequences that run again are wiped.

## Rerunning

`pnpm snapseq --last-failed` reruns the sequences that failed last time. It
is not a resume: with `maxFailures: 1` the sequences that never ran are not
included, and a rerun sequence starts from `01.png` again. Set
`SNAPSEQ_RUN=<that run>` to write into the same run directory; only the
rerun sequence's own directory is wiped.

```bash
SNAPSEQ_RUN="2026-10-01 at 04.07.16 PM" pnpm snapseq --last-failed
```

[Example 11](examples.md#11-rerun-one-sequence-into-the-same-run) walks through it.

## Orchestration runs

A file whose name ends in `.orchestration.ts` takes the place of the sequence
filter: the file says which sequences run, on which devices, and what is done to
the shots. [Orchestration](orchestration.md) covers the file.

```bash
pnpm snapseq snapseq/spring.orchestration.ts                  # named after the time it started
pnpm snapseq snapseq/spring.orchestration.ts --run review-1   # the whole proof
pnpm snapseq snapseq/spring.orchestration.ts --run review-1 12346 --device mobile   # shoot one part again
pnpm snapseq snapseq/spring.orchestration.ts --env uat --headed
```

| Flag                | Effect in an orchestration run                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| `--run <name>`      | The run folder. With words or `--device` after it, a repair: see [Repairs](orchestration.md#repairs). |
| `[sequence...]`     | Needs `--run`. Shoot again the parts whose sequence id contains the text. Plain text, not a regular expression. |
| `--device <name>`   | Needs `--run`. Shoot again the parts on that device. Exact name, repeatable.                        |
| `--env`, `--host`   | As in a plain run, and over the `env` and `host` that any `run()` gives.                            |
| `--record`          | Sets `SNAPSEQ_RECORD` for every child, as a plain run does. Write `--record=0`; with a space, `0` is read as a sequence filter. |
| `-c, --config`      | The config file.                                                                                    |
| `--headed`, `--debug` | Passed to every child.                                                                            |
| `--trace <mode>`, `--timeout <ms>`, `--max-failures <n>` | Passed to every child, with their value.                         |

These are refused, with the reason in the message:

| Flag                           | Why                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `--ui`                         | It opens one Playwright window on one run.                                          |
| `--list`                       | The orchestration decides its sequences while it runs.                              |
| `--shard`                      | An orchestration runs its sequences one after another, in its own order.            |
| `--repeat-each`, `--retries`   | A second pass would overwrite the shots. Catch the rejection of `run()` and call it again. |
| `--reporter`                   | snapseq reads each child's result through its own reporter.                         |
| `--last-failed`, `--only-changed` | The orchestration picks its sequences. Shoot a part again with `--run` and a filter. |

Any other flag is refused too, with the list of the ones that work. The variables
`SNAPSEQ_ENV`, `SNAPSEQ_HOST`, `SNAPSEQ_RUN`, `SNAPSEQ_RECORD` and `SNAPSEQ_OPEN` work
as in a plain run.

Each child is a `playwright test` for one `run()`. Its output, the live rows or the
list reporter, appears as it would on its own, between the heading and the
footer that snapseq prints; the file manager opens once, at the end, on the run
folder. [What the terminal shows](orchestration.md#what-the-terminal-shows) has
a sample. The exit code is 0, 1, or 130 after Ctrl-C.

## Timeouts

The timeout (10 min, Playwright's `timeout`) is the time allowed between
shots, not per sequence: every shot moves the deadline, so a sequence of any
length passes as long as it keeps landing shots, and one that hangs dies 10
minutes after its last. The live terminal view then says `No shot for 10
min.` The list reporter (CI, a pipe) prints Playwright's own `Test timeout of
…ms exceeded.` instead, and its number is the time since the sequence started.

A `goto` is bounded separately, at 120 s (`navigationTimeout`), and every
click, fill and wait at 30 s (`actionTimeout`).
[Config](config.md#playwright-defaults) lists them all.

## When a sequence fails

A sequence that fails or times out leaves `failed.png` beside the shots it did
take: the page as the teardown found it, when it can still be shot (5 s at
most). The terminal names that page as where it died. Images still loading, including `<picture>`
sources and those in frames, are abandoned (their `src` and `srcset` removed)
before that shot, so one that never answers cannot hold it back. The run stops
there (`maxFailures: 1`); `--max-failures 0` runs the rest.

## The terminal

An interactive run (stdout is a terminal) draws one live frame, redrawn in
place: a header with the env, host, run and elapsed time; one line per sequence
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

  1 passed, 1 skipped  5 shots  screenshots/2026-10-01 at 04.07.16 PM
```

A row is queued, running (shots so far, how long, the path of the last shot),
passed (shots and duration), failed, timed out or interrupted (the same, then
where it died and the first error line), skipped (the reason), or not run
(still queued when the run stopped). Shots are discovered as a sequence runs, so
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

Before the first sequence, while Playwright brings up the env's dev server, one
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
