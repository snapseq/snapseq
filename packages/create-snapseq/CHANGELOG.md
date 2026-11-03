# create-snapseq

## 0.7.0

First release: `npm create snapseq` (or `pnpm create snapseq`, `yarn create snapseq`) scaffolds a snapseq repo for one site, or a pnpm workspace with a package per site and a shared package for the devices. Each site gets a config, a home sequence and a `pdf` orchestration that labels the shots and binds one PDF per device. It installs the dependencies and Chromium unless told not to, and adds a site to an existing multisite root.
