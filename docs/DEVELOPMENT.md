# Development

Technical guide for working on Lookout's code. For the contribution process
(branching, pull requests, releases) see **[CONTRIBUTING.md](../CONTRIBUTING.md)**;
for a deeper architectural orientation see **[CLAUDE.md](../CLAUDE.md)**.

## Toolchain: TypeScript + esbuild

Lookout is written in **TypeScript** and bundled to `main.js` by **esbuild**,
following the official `obsidian-sample-plugin` layout. The authored source lives
in `src/`; `main.js` is **build output** and is **not committed** (it is rebuilt
in CI and attached to releases). Obsidian loads `main.js`, `manifest.json`, and
`styles.css` directly from the plugin folder **root** — esbuild emits the bundle
there (`outfile: "main.js"`), so there is **no `dist/`**.

`tsc` is used **only to type-check** (`--noEmit`); esbuild does the actual
transpile/bundle. The single runtime dependency is `obsidian`, which is provided
by the host and is marked `external` (never bundled).

## Repository layout

```
src/main.ts          # the entire plugin (DiagramView, TableView, LookoutPlugin)
styles.css           # the drafting / survey-instrument UI
manifest.json        # plugin metadata (id, version, minAppVersion, …)
versions.json        # plugin version -> minimum Obsidian version
esbuild.config.mjs   # bundles src/main.ts -> main.js (dev watch / production)
tsconfig.json        # type-check config (strict, noEmit)
package.json         # dev dependencies + scripts
scripts/validate.mjs # manifest/versions consistency + required-files check
tests/e2e/           # headless-browser E2E (drives the built main.js)
docs/                # developer docs
main.js              # BUILD OUTPUT (gitignored) — do not edit
```

## Prerequisites

- **Node 20+** (CI runs on Node 20).
- Install dev dependencies once: `npm ci` (or `npm install`).

## Local development against a vault

Obsidian runs the plugin from `<vault>/.obsidian/plugins/lookout/`. Symlink the
repo there, then start the watch build so edits to `src/` re-bundle `main.js`:

```bash
ln -s "$(pwd)" /path/to/test-vault/.obsidian/plugins/lookout
npm run dev        # esbuild watch: rebuilds main.js on every save
```

After each rebuild, reload the plugin in Obsidian (toggle it off/on, or run
*Reload app without saving*) to pick up the new `main.js`. Use a throwaway vault,
not your real notes. A note containing a **wide Mermaid diagram** and a **wide
table** exercises both features. Always test in **both Reading view and Live
Preview** — they render content into different DOM containers and have
historically diverged (see the table-processing guards in `src/main.ts`).

## Scripts & the CI gate

```bash
npm run dev         # esbuild watch build (development)
npm run build       # tsc --noEmit (type-check) + esbuild production bundle
npm run typecheck   # tsc --noEmit only
npm run lint        # eslint-plugin-obsidianmd (Obsidian compliance) — see below
npm run validate    # manifest/versions consistency + required-files check
npm run test:e2e    # headless browser E2E (see below) — run after `npm run build`
```

CI (and a pre-PR check) runs, on Node 20:

```bash
npm ci
npm run lint        # Obsidian plugin-guideline lint
npm run build       # type-check + bundle -> main.js
node --check main.js
node scripts/validate.mjs
```

### Linting — Obsidian compliance (recurrence prevention)

The Obsidian plugin reviewer runs `eslint-plugin-obsidianmd` (no `innerHTML`,
`activeDocument`/`activeWindow` for popout windows, `setCssStyles`/`setCssProps`
instead of direct `.style` assignment, `.instanceOf()` for cross-window checks,
window-scoped timers, etc.). We run that **same ruleset locally and in CI**
(`eslint.config.mjs`, flat config with typed linting), so a violation fails the
build here instead of surfacing at submission/review time. `npm run lint` must
be green before opening a PR; the CI `validate` job enforces it. When a rule is
deliberately not applicable (e.g. `ui/sentence-case` for Korean UI text), it is
turned off in `eslint.config.mjs` with a comment rather than ignored ad hoc.

There are no unit tests, but there is a headless-browser **E2E** check (see
below). Beyond that, behavioural verification is manual in a vault.

### E2E tests

`tests/e2e/` drives the **real bundled `main.js`** in headless Chromium under a
tiny `obsidian` stub, then asserts rendered behavior. Each case guards a real
regression:

- `table-fullscreen.test.mjs` — the full-screen table must inherit the same
  theme styling and layout as the inline view (it lives outside the note's
  `.markdown-rendered` context, so the clone is re-wrapped in one).
- `diagram-fit.test.mjs` — "fit to frame" on an inline Mermaid diagram must size
  the frame to the fitted content, so a tall diagram (e.g. a long
  `sequenceDiagram`) shows whole with no vertical scroll, while the default view
  stays at 100%.

```bash
npx playwright install chromium   # one-time (or set CHROMIUM_PATH to a binary)
npm run build                     # the tests load the built main.js
npm run test:e2e                  # both cases (test:e2e:table / test:e2e:diagram run one)
```

It is not part of the CI `validate` job (no browser there); run it locally when
touching the view/teardown/DOM code or `styles.css`.

### Type-checking

`tsconfig.json` is `strict` (against the real `obsidian` types), with one
relaxation: **`strictPropertyInitialization` is off**, because the view classes
initialize their fields in `_build()` / `_buildToolbar()` rather than the
constructor body. `strictNullChecks`, `noImplicitAny`, etc. remain on.

## Code guidelines (Obsidian)

Keep changes within Obsidian's plugin guidelines:

- **No `innerHTML` / `outerHTML`.** Build DOM nodes with the API. Icons are
  constructed element-by-element in `svgIcon()` (`createElementNS`), not from
  markup strings.
- **Clean up on teardown.** Plugin-level listeners go through `registerEvent`;
  the view classes own their DOM listeners / observers / timers and remove them
  in `destroy()`, which `onunload()` calls for every view.
- **Don't fight the theme.** Override Obsidian's styles by winning on selector
  specificity, never `!important` (see `styles.css`).

## Architecture (in brief)

`src/main.ts` holds three classes:

- **`LookoutPlugin`** (the `default` export) — lifecycle and **discovery**.
  Finds rendered Mermaid `<svg>`s and `<table>`s and wraps each in a view.
  Discovery is driven by several overlapping triggers (layout events, a markdown
  post-processor, a `MutationObserver`) because Mermaid renders asynchronously;
  they funnel through a debounced `queueScan() → scan() → process()/processTable()`.
- **`DiagramView`** — one pan/zoom controller per diagram; serves both the
  inline frame and the full-screen overlay. Owns the transform math.
- **`TableView`** — thin; tables keep native scroll and only gain a full-screen
  button.

Two invariants to preserve when changing discovery:

1. **Idempotent processing.** Discovery fires repeatedly on the same DOM. Each
   handled element is stamped with a `PROCESSED` attribute and re-skipped, and
   processors bail if the element is already inside Lookout's own wrappers. Keep
   this stamp-and-skip pattern or scans will duplicate views.
2. **DOM ownership.** Lookout moves Obsidian-owned nodes (the svg, the table)
   into its own wrappers and must restore them on `destroy()` / `onunload()`.

See **[CLAUDE.md](../CLAUDE.md)** for the full version, including the
Live-Preview table guards and the CSS-specificity convention.

## Branching & releases

Summarised here; the authoritative version is in
**[CONTRIBUTING.md](../CONTRIBUTING.md)**.

- Default branch is **`dev`** — branch off it (`feat/*`, `fix/*`, `docs/*`,
  `chore/*`) and open PRs against `dev`, never `main`. Use Conventional Commits.
- `main` only receives merges from `dev` or `hotfix/*`. **Releases are automatic
  on merge to `main`**: the workflow installs deps, builds `main.js`, reads
  `version` from `manifest.json`, pushes a bare-version tag (no `v` prefix —
  Obsidian convention), and uploads `main.js` / `manifest.json` / `styles.css`.
- A version bump touches three files in lockstep (checked by
  `scripts/validate.mjs`): `manifest.json` (`version`) — keep `package.json`'s
  `version` in sync — `versions.json` (`"<version>": "<minAppVersion>"`, equal to
  `manifest.minAppVersion`), and `CHANGELOG.md` (move `Unreleased` into a dated
  section).
