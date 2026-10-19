# snapseq

pnpm workspace. `packages/snapseq` is the core: Playwright Test fixtures for scripted
screenshot captures. `packages/label` (`@snapseq/label`), `packages/pdf` (`@snapseq/pdf`)
and `packages/stabilize` (`@snapseq/stabilize`) are plugins: each its own npm package,
peer-depending on `snapseq` only. `label` and `pdf` transform the shot files; `stabilize`
works in the page through `ctx.page`. Consumers install what they use into their own app
and keep all business logic there.

- Install: `pnpm install` at the root (builds every `dist/` via `prepare`), then
  `pnpm exec playwright install chromium` under Node 20 or 22 (`playwright install` hangs
  under Node 26; `nvm use 22` first).
- Test: `pnpm test` at the root runs every package; the core's integration file launches real Chromium.
- Typecheck: `pnpm typecheck`.
- Keep it tiny: no brand selectors, no site-specific helpers, no exports without a real consumer.
- `packages/snapseq/docs/` is the API reference and the core README the front door; a plugin's
  README documents that plugin. Update them with any public change. One changeset per changed package.
