<!--
Release PR — merges `dev` into `main` to cut a new version.

Open it from the dev...main compare with:
  ?expand=1&template=release.md
(base: main, compare: dev)

Bump manifest.json + versions.json + CHANGELOG.md on `dev` BEFORE opening this
PR. On merge, the Release workflow auto-tags `main` and publishes the release.
-->

## Release X.Y.Z

<!-- One-line summary of this release. -->

## Highlights

<!-- Mirror the new CHANGELOG.md section for X.Y.Z. -->
-

## Pre-merge checklist

- [ ] `manifest.json` `version` is set to **X.Y.Z**
- [ ] `versions.json` has `"X.Y.Z": "<minAppVersion>"` (matches `manifest.minAppVersion`)
- [ ] `CHANGELOG.md` has a dated `## [X.Y.Z]` section (moved out of *Unreleased*)
- [ ] `node --check main.js` and `node scripts/validate.mjs` pass locally
- [ ] CI (`validate`) is green on this PR
- [ ] Code-owner approval obtained

## After merge (automatic)

On merge into `main`, the **Release** workflow reads the version from
`manifest.json`, pushes the `X.Y.Z` tag, and publishes the GitHub release with
`main.js`, `manifest.json`, and `styles.css`. If that version is already
released, it does nothing.

Maintainer follow-up:

- [ ] Verify the release and its three assets appeared under
      [Releases](https://github.com/Post-Math/Lookout/releases).
- [ ] Back-merge `main` into `dev` (a `chore/sync-dev-with-main` PR) to
      reconcile history.
