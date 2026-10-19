---
"snapseq": patch
"@snapseq/label": patch
"@snapseq/pdf": patch
"@snapseq/stabilize": patch
---

Each package's `exports` now points `require` at `index.d.cts` and `import` at `index.d.ts`, so a CommonJS consumer on `module: node16` no longer gets TS1479.
