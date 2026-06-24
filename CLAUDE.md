# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Lookout is an **Obsidian plugin** for surveying wide content: pan/zoom Mermaid diagrams, fit-to-frame, and open diagrams or wide tables full-screen. It is written in **TypeScript** (`src/main.ts`) and bundled to `main.js` by **esbuild** (the official `obsidian-sample-plugin` toolchain). `main.js` is **build output** — gitignored, rebuilt in CI, attached to releases — so **never edit `main.js`; edit `src/main.ts` and `styles.css`.** Obsidian loads `main.js`/`manifest.json`/`styles.css` from the plugin folder **root**, so esbuild emits the bundle there and **there is no `dist/`**. `tsc` is used **only to type-check** (`--noEmit`); esbuild does the transpile/bundle. The only runtime dependency is `obsidian` (host-provided, marked `external`).

## Commands

```bash
npm ci                 # install dev deps (first time / CI)
npm run dev            # esbuild watch: rebuild main.js on save (local dev)
npm run build          # tsc --noEmit (type-check) + esbuild production bundle
npm run lint           # eslint-plugin-obsidianmd (Obsidian compliance)
npm run validate       # manifest/versions consistency + required files
```

The full CI gate (run before every PR), on Node 20:

```bash
npm ci
npm run lint           # Obsidian plugin-guideline lint (eslint-plugin-obsidianmd)
npm run build          # type-check + bundle -> main.js
node --check main.js
node scripts/validate.mjs
```

There are no unit tests — behavioural verification is manual in a real vault (see below). `tsconfig.json` is `strict` with `strictPropertyInitialization` off (fields init in `_build()`); see `docs/DEVELOPMENT.md`.

**Obsidian compliance is enforced by lint, not memory.** `eslint-plugin-obsidianmd` (the same ruleset the Obsidian reviewer runs) gates CI, so write code that passes it: no `innerHTML`; `activeDocument`/`activeWindow` not `document`/`window`; `setCssStyles`/`setCssProps` (available on both `HTMLElement` and `SVGElement`) instead of direct `.style.x =`; `.instanceOf(HTMLElement)` not `instanceof`; auto-bound arrow-function fields for event handlers. Releases attest provenance for `main.js`/`styles.css` via `actions/attest-build-provenance`.

## Local development against a vault

Obsidian runs the plugin from `<vault>/.obsidian/plugins/lookout/`. Symlink the repo there and run the watch build; reload the plugin (toggle off/on, or the *Reload app without saving* command) after each rebuild:

```bash
ln -s "$(pwd)" /path/to/test-vault/.obsidian/plugins/lookout
npm run dev    # rebuilds main.js on every save
```

A note containing a wide Mermaid diagram and a wide table exercises both features. **Always test in both Reading view and Live Preview** — they render content into different DOM containers and have historically diverged (see the table-processing guards in `src/main.ts`).

## Architecture

Everything lives in `src/main.ts` (~900 lines), three classes:

- **`LookoutPlugin`** (the `default` export) — lifecycle and **discovery**. It finds rendered Mermaid `<svg>`s (`.mermaid svg, svg[id^="mermaid-"]`) and `<table>`s anywhere in the document and wraps each in a view. Discovery is driven by several overlapping triggers because Mermaid renders asynchronously and Obsidian re-renders panes on navigation: `onLayoutReady`, workspace events (`layout-change`, `active-leaf-change`, `file-open`), a `registerMarkdownPostProcessor`, and a `MutationObserver` on `document.body`. All of these funnel through `queueScan()` (debounced ~120ms) → `scan()` → `scanWithin(root)` → `process()` / `processTable()`.
- **`DiagramView`** — one pan/zoom controller per diagram. The same class serves both the **inline** frame (wraps the live svg in place) and **full-screen** (wraps a *clone* in a fixed overlay). It owns the transform math: `_measure`, `fit`, `actualSize`, `zoomTo`/`zoomBy`, `_panBounds`/`_clampPan`, and `_render`.
- **`TableView`** — far simpler; tables keep native horizontal scroll and only gain a full-screen button. Full-screen clones the table into a maximized scroll overlay.

### Idempotent processing (important invariant)

Because discovery fires repeatedly on the same DOM, every processor must be **idempotent**. Each handled element is stamped with the `PROCESSED` attribute and re-skipped; processors also bail early if the element is already inside Lookout's own wrappers (`.lookout-viewport`, `.lookout-fs`, `.lookout-table-host`). When adding any new element discovery, preserve this stamp-and-skip pattern or scans will duplicate views.

`processTable` carries hard-won guards: it enhances tables under `.markdown-rendered` **or** `.markdown-source-view` (Live Preview renders tables as a CM widget), but skips any table containing `[contenteditable="true"]` — that is the table the user is actively editing, whose DOM Obsidian owns.

### DOM ownership and CSS specificity

Lookout moves Obsidian-owned nodes (the svg, the table) into its own wrappers and must restore them on `destroy()`/`onunload`. When overriding Obsidian's built-in styles in `styles.css`, **win on selector specificity rather than `!important`** — e.g. qualify with the host class (`.mermaid.lookout-host`) or scope under a container. The codebase deliberately avoids `!important`.

## Conventions

- **Keep the dependency surface minimal.** `obsidian` is the only runtime dependency (host-provided, `external` — never bundled). Don't add runtime dependencies without a strong reason; dev dependencies stay limited to the TypeScript/esbuild toolchain. Type with the real Obsidian types, and keep `tsc --noEmit` (CI) green.
- **Follow Obsidian's code guidelines.** No `innerHTML`/`outerHTML` — build DOM nodes via the API (icons are constructed with `createElementNS` in `svgIcon()`). Clean up listeners/observers/timers on `destroy()`/`onunload()`.
- **Visual language is fixed:** quiet Obsidian theme surfaces (`var(--background-*)`, `var(--text-*)`) plus a single survey-cyan accent (`--lookout-accent`) reserved for focus and the active zoom gauge. Do not introduce new colors. Icons are inline lucide-style SVG (1.75px stroke) built via `svgIcon()`.
- User-facing strings (command names, `Notice` text) are in **Korean**.
- Respect `prefers-reduced-motion` (the `REDUCED_MOTION` flag / the reduced-motion media block) when adding animation.

## Branching & releases

- Default branch is **`dev`** — branch off it (`feat/*`, `fix/*`, `docs/*`, `chore/*`) and open PRs against `dev`, never `main`. Use Conventional Commits.
- `main` only receives merges from `dev` or `hotfix/*`. **Releases are automatic on merge to `main`**: the workflow reads `version` from `manifest.json` and pushes a bare-version tag (no `v` prefix — Obsidian convention).
- A version bump must touch three files in lockstep (validated by `scripts/validate.mjs`): `manifest.json` (`version`), `versions.json` (`"<version>": "<minAppVersion>"`, which must equal `manifest.minAppVersion`), and `CHANGELOG.md` (move `Unreleased` notes into a dated section).
