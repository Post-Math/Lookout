# Changelog

All notable changes to Lookout are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.7] - 2026-06-24

### Fixed

- "Fit to frame" on an inline Mermaid diagram no longer leaves a vertical scroll
  or dead space. Previously fit scaled the diagram to the frame **width** while
  the frame height stayed at the diagram's 100% height, so the frame and the
  content heights did not match: a tall diagram (e.g. a long `sequenceDiagram`)
  overflowed and scrolled, and a wide one had dead space above/below. Fit now
  contains the diagram within both the frame width and the 70vh height cap and
  sizes the frame to that fitted height, so frame and content match exactly. The
  default inline view stays at 100% (actual size); fit and full screen are how a
  tall diagram is seen whole.
- The fitted frame height is now exact under Obsidian's app-wide
  `box-sizing: border-box`. The viewport's 1px border had been eating into the
  content box, leaving the diagram 1–2px taller than the frame — a faint
  vertical scroll visible in Obsidian but not in a `content-box` test harness.
  The frame now compensates for the border so the content box matches the
  fitted diagram precisely.

## [1.1.6] - 2026-06-24

### Fixed

- Wide tables: the full-screen button no longer floats off-screen at the table's
  hidden far-right edge. The host is now a grid that caps itself at the visible
  column width (so the table's overflow stays inside our own scroller) and the
  button is pinned to the visible top-right corner.
- Full-screen tables no longer show stray ":::"/"⋮" marks: Obsidian's Live
  Preview table-editor chrome is now stripped from the full-screen clone on
  both axes — column and row menu buttons (`.table-col-btn`, `.table-row-btn`)
  as well as the column and row drag grips (`.table-col-drag-handle`,
  `.table-row-drag-handle`). The earlier fix missed the horizontal column grip.

## [1.1.5] - 2026-06-24

### Changed

- Brought the source into line with the Obsidian plugin guidelines (no
  user-visible change): `setCssStyles`/`setCssProps` instead of direct `.style`
  assignment, `activeDocument`/`activeWindow` for popout-window safety,
  `.instanceOf()` for cross-window type checks, window-scoped `requestAnimation
  Frame`, and auto-bound arrow-function event handlers.
- Full-screen tables get their `.markdown-rendered` styling context from the
  scroll container directly, dropping the partially-supported `display: contents`.
- esbuild marks Node built-ins external via `node:module` `builtinModules`,
  removing the `builtin-modules` dependency.

### Internal — recurrence prevention

- Added **`eslint-plugin-obsidianmd`** (the Obsidian reviewer's ruleset) with a
  flat, type-aware `eslint.config.mjs`; `npm run lint` now gates CI and the
  release workflow, so guideline violations fail the build instead of surfacing
  at submission.
- Release assets `main.js` and `styles.css` are now published with **GitHub
  build-provenance attestations** (`actions/attest-build-provenance`).

## [1.1.4] - 2026-06-24

### Fixed

- Full-screen tables now match the inline view's styling. The clone is opened
  outside the note's `.markdown-rendered` context, which dropped the theme's
  table borders/padding/header background; it is now re-wrapped in that context
  (with `display: contents` so the centering/scroll layout is unchanged).
- Diagram host overflow is now neutralized on the actual `.mermaid` wrapper (via
  `closest('.mermaid')`), so the override applies even when the diagram svg is
  nested or matched only by its `mermaid-*` id. No user-visible change in the
  common case; removes a latent edge case.

### Internal

- Removed the remaining `!important` declarations in `styles.css`, overriding
  Obsidian's styles by selector specificity instead.
- Migrated the project to **TypeScript + esbuild** (the official
  `obsidian-sample-plugin` toolchain): source now lives in `src/main.ts` and is
  bundled to `main.js` (a build artifact, no longer committed). CI and the
  release workflow type-check (`tsc --noEmit`) and build before packaging. No
  change to the shipped plugin's behavior.
- Followed Obsidian's code guidelines: icons are now built via the DOM
  (`createElementNS`) instead of `innerHTML`.
- Added a headless-browser E2E test (`tests/e2e/`, `npm run test:e2e`) that
  drives the bundled plugin and guards the full-screen table styling.
- Restructured docs: `README.md` is now user-facing; developer setup and
  architecture moved to `docs/DEVELOPMENT.md`.

## [1.1.3] - 2026-06-23

### Changed

- Metadata: `author` is now **Post-Math** (matches the organization and the
  community-plugin listing). No functional change.

## [1.1.2] - 2026-06-23

### Changed

- Metadata: `authorUrl` now points to the author profile
  (`https://github.com/Post-Math`) instead of the plugin repository, per the
  Obsidian community-plugin submission guidelines. No functional change.

## [1.1.1] - 2026-06-23

Initial public release.

### Added

- Mermaid diagrams: pan (drag / wheel), zoom (`Ctrl`/`Cmd`+wheel or buttons), a
  100 % gauge, fit-to-frame, and full-screen — with keyboard controls.
- Tables: a full-screen button for wide tables, in both Reading view and Live
  Preview.
- Command: "Open the active note's first Mermaid diagram full screen".

### Fixed

- Mermaid: the inline frame now hugs the diagram's natural (100 %) height, so a
  short diagram no longer sits inside an oversized frame with dead space.
- Tables: the full-screen button now appears in Live Preview (Obsidian's default
  mode), not only in Reading view. The table being actively edited is left
  untouched.

[Unreleased]: https://github.com/Post-Math/Lookout/compare/1.1.3...HEAD
[1.1.3]: https://github.com/Post-Math/Lookout/compare/1.1.2...1.1.3
[1.1.2]: https://github.com/Post-Math/Lookout/compare/1.1.1...1.1.2
[1.1.1]: https://github.com/Post-Math/Lookout/releases/tag/1.1.1
