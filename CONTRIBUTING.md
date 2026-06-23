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

Lookout ships as **plain CommonJS with no build step** — Obsidian loads
`main.js` directly. To develop against a real vault:

1. Use a throwaway test vault (not your real notes).
2. Symlink (or copy) the repo into the vault's plugins folder:
   ```bash
   ln -s "$(pwd)" /path/to/test-vault/.obsidian/plugins/lookout
   ```
3. In Obsidian, enable **Lookout** under *Settings → Community plugins*.
4. Edit `main.js` / `styles.css`, then reload the plugin (toggle it off/on, or
   use the *Reload app without saving* command) to see your changes.

A note with a wide Mermaid diagram and a wide table is enough to exercise both
features in Reading view and Live Preview.

## Before you open a PR

Run the same checks CI runs:

```bash
node --check main.js
node scripts/validate.mjs
```

Please also:

- Keep the **drafting / survey-instrument** visual language (quiet Obsidian
  theme surfaces, a single survey-cyan accent). Avoid introducing new colors.
- Match the surrounding code style (plain CommonJS, no new dependencies).
- Update `README.md` / docs when behavior changes.

## Releasing (maintainers)

1. Merge `dev` into `main` via PR.
2. Bump `version` in `manifest.json` and add the matching entry to
   `versions.json` (`"<version>": "<minAppVersion>"`).
3. Tag the release commit on `main` with the bare version (no `v` prefix, to
   match Obsidian's convention) and push the tag:
   ```bash
   git tag 1.2.0
   git push origin 1.2.0
   ```
4. The **Release** workflow validates the tag against `manifest.json` and
   publishes a GitHub release with `main.js`, `manifest.json`, and `styles.css`.

Thank you for contributing! 🛰️
