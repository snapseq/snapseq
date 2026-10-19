<p align="center"><img src="https://raw.githubusercontent.com/snapseq/snapseq/main/assets/logo.svg" width="128" alt=""></p>

# snapseq

Playwright Test fixtures for scripted screenshot sequences, and plugins for the shots they take.

| Package                                  | npm                                                                                     | What it does                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [`snapseq`](packages/snapseq)            | [![npm](https://img.shields.io/npm/v/snapseq)](https://www.npmjs.com/package/snapseq)   | The core: numbered screenshots per run, sequence and device.         |
| [`@snapseq/label`](packages/label)       | [![npm](https://img.shields.io/npm/v/@snapseq/label)](https://www.npmjs.com/package/@snapseq/label) | A labeled strip above each shot.                        |
| [`@snapseq/pdf`](packages/pdf)           | [![npm](https://img.shields.io/npm/v/@snapseq/pdf)](https://www.npmjs.com/package/@snapseq/pdf)     | One PDF per sequence and device.                         |
| [`@snapseq/stabilize`](packages/stabilize) | [![npm](https://img.shields.io/npm/v/@snapseq/stabilize)](https://www.npmjs.com/package/@snapseq/stabilize) | Steady `vh` units for `snapPage`, and no motion before a shot. |

Start with the [core README](packages/snapseq/README.md) and its [docs](packages/snapseq/docs).

## Develop and release

```bash
pnpm install             # every package; builds each dist/ via prepare
pnpm typecheck
pnpm test                # every package; packages/e2e drives the built packages through real Chromium
pnpm changeset           # one per changed package
pnpm changeset version   # bump versions and write changelogs
pnpm release             # publish what changed, tag
git push --follow-tags
```
