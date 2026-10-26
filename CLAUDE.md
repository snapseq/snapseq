# snapseq

pnpm workspace. `packages/snapseq` is the core: Playwright Test fixtures for scripted
screenshot sequences, stabilize built in, and orchestration mode (`*.orchestration.ts`
files that run sequences and then steps; the runner is `src/orchestration/`). `packages/label`
(`@snapseq/label`) and `packages/pdf` (`@snapseq/pdf`) are steps: plain functions over
captures, each its own npm package, peer-depending on `snapseq` only. Consumers install what
they use into their own app and keep all business logic there.

- Install: `pnpm install` at the root (builds every `dist/` via `prepare`), then
  `pnpm exec playwright install chromium` under Node 20 or 22 (`playwright install` hangs
  under Node 26; `nvm use 22` first).
- Test: `pnpm test` at the root runs every package; `packages/e2e` (private, never published) installs the built packages into a scratch project and drives them through real Chromium.
- Typecheck: `pnpm typecheck`.
- Keep it tiny: no brand selectors, no site-specific helpers, no exports without a real consumer.
- `packages/snapseq/docs/` is the API reference and the core README the front door; a step
  package's README documents that step. Update them with any public change. One changeset per changed package.
