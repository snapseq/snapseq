# create-snapseq

Scaffolds a [snapseq](https://github.com/snapseq/snapseq/tree/main/packages/snapseq)
repo: one site, or a pnpm workspace with a package per site. Each site gets a
config, a `home` sequence and a `pdf` orchestration that labels the shots and
binds one PDF per device. No runtime dependencies. Node 20 or later.

## Use

```bash
npm create snapseq@latest -- my-shots --site https://www.example.com
pnpm create snapseq my-shots --site https://www.example.com
yarn create snapseq my-shots --site https://www.example.com
```

npm passes flags to the package after `--`; pnpm and yarn take them as they are.
On a terminal it asks for what is missing: the folder, single site or
multisite, and the site URLs (multisite: one per line, an empty line ends).
Off a terminal a missing input is an error naming the flag, and nothing is
written.

```
create-snapseq [dir] [--site <url>]... [--multisite] [--no-install] [--help]
```

| Flag           | Meaning                                                                  |
| -------------- | ------------------------------------------------------------------------ |
| `dir`          | The folder to create. It must not exist, or be empty.                    |
| `--site <url>` | A site to shoot. Repeat it for more. One means a single site.            |
| `--multisite`  | A pnpm workspace with a package per site. Implied by adding to a root.   |
| `--no-install` | Write the files and print the commands to run, instead of running them.  |

A site URL is http or https, without credentials. Its origin is the env's
`host`, and its path is the page the `home` sequence opens. The site's name,
for its folder and package, is the hostname in lower case without a leading
`www.`. The env is `dev` for `localhost` and `127.0.0.1`, else `prod`.

## One site

```
my-shots/
  package.json            snapseq, @snapseq/label, @snapseq/pdf, @playwright/test, @types/node
  snapseq.config.ts       the env and its host; devices are snapseq's defaults
  snapseq/
    home.seq.ts           snap and snapPage of the page
    pdf.orchestration.ts  shoot, label, one PDF per device
  tsconfig.json
  .gitignore
```

## Multisite

```
my-shots/
  package.json            the `snapseq` script: every site, one at a time
  pnpm-workspace.yaml
  tsconfig.json
  packages/shared/src/index.ts   the devices every site uses
  sites/
    example.com/          the same files as one site, plus a dependency on shared
```

Two sites without `--multisite` are an error: dev, staging and prod of one site
are envs in one config, not sites.

Run `create-snapseq <root> --site <url>` on an existing multisite root (it has
`pnpm-workspace.yaml`, `sites/` and `packages/shared/`) to add `sites/<name>`.
Nothing else in the root changes.

Multisite needs pnpm: the launcher, or `pnpm` on the PATH (`corepack enable pnpm`).
With `--no-install` it is not needed.

## What it refuses

Before it writes anything, it refuses:

- a folder that exists and is not empty (except a multisite root, to add a site);
- a folder inside a git repo or a workspace (a `.git`, a `pnpm-workspace.yaml`,
  or a `package.json` with `workspaces` in a parent folder);
- a URL that is not http or https, has credentials, or has no plain hostname
  (an IPv6 address, say);
- two URLs with the same site name, or a site that already exists in the root;
- a multisite install with no pnpm.

## Install

Unless `--no-install`, it runs the launcher's package manager (pnpm, yarn, bun,
else npm; multisite is always pnpm) `install` in the folder, then
`playwright install chromium`. Under Node 26 it skips the browser, which hangs
there, and prints the command to run under Node 22. If an install fails, the
files stay and it prints what to run. It ends with the commands to run next:
`snapseq -o pdf` writes `screenshots/<run>/` with `desktop.pdf` and `mobile.pdf`.

The versions in the generated `package.json` files are the ones released with
this package.
