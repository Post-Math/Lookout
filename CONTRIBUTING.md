# Contributing to Lookout

Thanks for your interest in improving Lookout! This document explains the
branching model, how to set up a local development environment, and what a good
pull request looks like.

By participating you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug** or **request a feature** via the
  [issue tracker](https://github.com/Post-Math/Lookout/issues) — please use the
  provided templates.
- **Open a pull request** for a fix or improvement (see below).
- **Improve the docs.**

For security issues, do **not** open a public issue — see [SECURITY.md](SECURITY.md).

## Branching model (git-flow)

Lookout follows a git-flow style model:

| Branch | Purpose | Accepts merges from |
| --- | --- | --- |
| `main` | Release / deployment. Always reflects the latest published release. Protected. | `dev` (and `hotfix/*`) |
| `dev` | Integration branch. The default branch and the base for all day-to-day work. Protected. | `feat/*`, `fix/*`, `docs/*`, `chore/*`, … |
| `feat/*`, `fix/*`, `docs/*`, `chore/*`, `refactor/*` | Short-lived topic branches for a single change. | — |

Rules of thumb:

- **Always branch off `dev`** and **open your pull request against `dev`** — never `main`.
- `main` only ever receives merges from `dev` (a release) or a `hotfix/*` branch
  (an urgent production fix, which is merged back into `dev` afterwards).
- Keep topic branches focused: one logical change per branch / PR.

```
feat/my-change  ──▶  dev  ──▶  main  ──▶  tag (e.g. 1.2.0)  ──▶  Release
```

## Pull request workflow (fork-based)

External contributors don't have write access to this repository, so work
happens in a **fork**:

1. **Fork** `Post-Math/Lookout` to your account.
2. **Clone** your fork and add the upstream remote:
   ```bash
   git clone git@github.com:<you>/Lookout.git
   cd Lookout
   git remote add upstream git@github.com:Post-Math/Lookout.git
   ```
3. **Sync `dev`** and create a topic branch off it:
   ```bash
   git fetch upstream
   git switch -c feat/my-change upstream/dev
   ```
4. Make your changes (see *Local development* below) and commit using
   [Conventional Commits](https://www.conventionalcommits.org/) — e.g.
   `feat: add fit-to-height for tall diagrams` or `fix: show table button in Live Preview`.
5. **Push** to your fork and **open a PR targeting the `dev` branch** of
   `Post-Math/Lookout`. Fill out the PR template.
6. Make sure **CI is green** and address review feedback. A
   [code owner](.github/CODEOWNERS) approval is required before merging.

Maintainers with write access follow the same model with branches on the main
repository instead of a fork.

## Local development

Lookout is written in **TypeScript** (`src/main.ts`) and bundled to `main.js`
by **esbuild**. To develop against a real vault:

1. Use a throwaway test vault (not your real notes).
2. Install dependencies: `npm ci`.
3. Symlink (or copy) the repo into the vault's plugins folder:
   ```bash
   ln -s "$(pwd)" /path/to/test-vault/.obsidian/plugins/lookout
   ```
4. Start the watch build: `npm run dev` (re-bundles `main.js` on every save).
5. In Obsidian, enable **Lookout** under *Settings → Community plugins*.
6. Edit `src/main.ts` / `styles.css`, then reload the plugin (toggle it off/on,
   or use the *Reload app without saving* command) to see your changes.

A note with a wide Mermaid diagram and a wide table is enough to exercise both
features in Reading view and Live Preview. See
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the full developer guide.

## Before you open a PR

Run the same checks CI runs:

```bash
npm ci
npm run build           # tsc --noEmit (type-check) + esbuild bundle
node --check main.js
node scripts/validate.mjs
```

Please also:

- Keep the **drafting / survey-instrument** visual language (quiet Obsidian
  theme surfaces, a single survey-cyan accent). Avoid introducing new colors.
- Follow Obsidian's code guidelines (no `innerHTML`; clean up on teardown) and
  avoid adding runtime dependencies.
- Update `README.md` / docs when behavior changes.

## Releasing (maintainers)

Releases are **automatic on merge to `main`** — there is no manual tagging step.
The version bump lands on `dev` first:

1. On a branch off `dev`, prepare the release:
   - bump `version` in `manifest.json`,
   - add the matching entry to `versions.json` (`"<version>": "<minAppVersion>"`),
   - move the `Unreleased` notes in [`CHANGELOG.md`](CHANGELOG.md) into a dated
     `## [<version>]` section.

   Open a PR into `dev` and merge it.
2. Open a **release PR** from `dev` into `main` using the release template
   (append `?expand=1&template=release.md` to the compare URL) and merge it
   after a code-owner approval.
3. On merge, the **Release** workflow reads the version from `manifest.json`,
   pushes the bare-version tag (no `v` prefix, to match Obsidian's convention),
   and publishes a GitHub release with `main.js`, `manifest.json`, and
   `styles.css`. It is idempotent — a merge that does not bump the version
   (e.g. a CI or docs change) is a no-op.
4. Back-merge `main` into `dev` so the histories stay reconciled.

Thank you for contributing! 🛰️
