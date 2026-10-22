<p align="center"><img src="https://raw.githubusercontent.com/snapseq/snapseq/main/assets/logo.svg" width="128" alt=""></p>

# snapseq

Playwright Test fixtures for scripted screenshot sequences, and steps that work on the shots they take.

| Package                                  | npm                                                                                     | What it does                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [`snapseq`](packages/snapseq)            | [![npm](https://img.shields.io/npm/v/snapseq)](https://www.npmjs.com/package/snapseq)   | Capture: numbered screenshots per run, sequence and device, and the orchestration files that run them. |
| [`@snapseq/label`](packages/label)       | [![npm](https://img.shields.io/npm/v/@snapseq/label)](https://www.npmjs.com/package/@snapseq/label) | A step: a labeled strip above each shot.                |
| [`@snapseq/pdf`](packages/pdf)           | [![npm](https://img.shields.io/npm/v/@snapseq/pdf)](https://www.npmjs.com/package/@snapseq/pdf)     | A step: shots bound into one PDF.                        |

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
