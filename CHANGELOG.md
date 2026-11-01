# Changelog

All notable changes to Lookout are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.3] - 2026-11-02

Development-toolchain security and release-hygiene maintenance. No change in
behaviour; the shipped `main.js` / `styles.css` are byte-identical to 1.2.2.

### Security — dev toolchain only

- `moment` is pinned to `^2.31.0` via npm `overrides` (GHSA-4p3w-j4w9-5jqw).
  `obsidian` pins 2.29.4 exactly, so Dependabot could not update it; it is used
  only for type declarations and is never bundled.
- `minimatch` is pinned to `^11.0.1` under ESLint, `@eslint/config-array`,
  `@eslint/eslintrc`, `@typescript-eslint/typescript-estree` and
  `eslint-plugin-n` (GHSA-g3hv-75wg-m249), replacing every copy that contains
  the vulnerable code. The 3.x / 8.x copies used by eslint-plugin-import / -react
  / -json-schema-validator stay because 11 would break them; see
  `docs/DEVELOPMENT.md`.
- Lockfile security bumps: `js-yaml` 4.3.2, `brace-expansion` 1.1.21 / 2.1.7 /
  5.0.12, `fast-uri` 3.1.9 (#43, #44, #45).

### Internal — recurrence prevention

- `package.json` / `package-lock.json` carry the release version again (they
  were stuck at 1.1.5 since 1.2.0), and `scripts/validate.mjs` now fails CI when
  they disagree with `manifest.json`.

## [1.2.2] - 2026-07-28

The remaining warning from Obsidian's plugin review. No change in behaviour.

### Fixed

- The inert footnote marker's dotted underline is drawn with a `border-bottom`
  instead of `text-decoration`. 1.2.1 moved the rule to the
  `text-decoration-line` / `text-decoration-style` longhands on the assumption
  that only the multi-value shorthand was flagged; Obsidian's CSS check
  actually maps the entire `text-decoration` family onto a single browser
  feature that Chrome supports only partially, so every spelling of it warns.
  The marker looks the same.

### Internal — recurrence prevention

- `scripts/validate.mjs` now fails the build if `styles.css` declares any
  `text-decoration*` property. The reviewer's CSS check runs on their side
  only, so the previous fix could not be verified before submission and the
  same warning came back a second time; the local gate now carries the rule.

## [1.2.1] - 2026-07-28

Compliance fixes raised by Obsidian's plugin review. No change in behaviour.

### Fixed

- Elements are created through Obsidian's `createEl` helper instead of
  `document.createElement`, per the plugin guidelines
  (`obsidianmd/prefer-create-el`).
- The inert footnote marker's dotted underline is written with the
  `text-decoration-line` / `text-decoration-style` longhands. Obsidian's CSS
  check flags the multi-value `text-decoration` shorthand as only partially
  supported at this plugin's `minAppVersion`.

### Internal — recurrence prevention

- `eslint-plugin-obsidianmd` moves 0.3.0 → 0.4.1. Both findings above are rules
  the local gate already had in principle, but the pinned 0.3.0 did not yet
  carry them, so CI could not have caught either one before submission.
- `npm run lint` now runs with `--max-warnings=0`. `prefer-create-el` reports at
  *warning* severity, so the gate exited 0 while the violation stood; warnings
  now fail the build the same as errors.

## [1.2.0] - 2026-07-28

### Added

- Full-screen tables now support **footnotes** ([#28]). A cell's footnote marker
  used to survive into the full-screen view as a dead `[1]`: the definitions
  live outside the `<table>` the overlay clones, so there was nothing to show
  and nothing to jump to. The definitions a table actually references are now
  resolved from the note's own **source** through Obsidian's metadata cache and
  rendered under the clone, so they appear no matter where the table sits in the
  note — numbering preserved, so a table referencing only footnote 3 still reads
  "3." — and every footnote id and `#`-anchor is re-pointed into an
  overlay-local namespace so the marker jumps to its definition and the "↩︎"
  back-reference jumps back, all without leaving full screen or touching the
  note's own footnote navigation. The footnote text is laid out at a readable
  measure rather than at the table's width, so a narrow table no longer squeezes
  it into a one-word-per-line ribbon.
- Hovering a marker in full screen previews its definition. Obsidian gives a
  footnote no hover affordance of its own, and in full screen the definition can
  sit far below a long table, so the marker would otherwise be a number with
  nothing behind it until clicked. The note's own markers are untouched.
- Scope: footnotes resolve in **Reading view**. **Live Preview is not
  supported**, because Obsidian parses each block there on its own: a
  reference-style marker (`[^id]`) is not rendered inside a table widget at all
  (the definition is outside that block, and the note itself shows the marker as
  plain text), and an inline marker (`^[note]`) is numbered within its block
  rather than within the note, so it cannot be matched to a definition — a
  paragraph's footnote above the table would otherwise be rendered under the
  table's marker. Where a definition cannot be resolved — that case, a footnote
  referenced but never defined, a table in a surface with no backing file, or a
  metadata index that has not caught up with the file — the marker stays visible
  but is made plainly inert, and is exposed to assistive tech as a disabled link
  carrying the reason, not by colour alone. Wrong footnote text under a right
  marker is never shown.
  A table with no footnotes at all builds exactly the overlay it did before.

### Fixed

- The full-screen clone no longer copies the live table's `id` attributes into
  the document. A table carrying a `^block-id`, or anything id-bearing inside a
  cell, previously appeared twice under the same id for as long as the overlay
  was open — invalid DOM, and enough to send an in-note `#…` link to the clone
  instead of the note. Ids inside an SVG a cell contains are deliberately kept:
  id-scoped `<style>`, `<use>` and gradient/marker/clip-path references break
  without them, and a duplicated svg-internal id resolves to an identical
  definition.

### Changed

- Both full-screen views — diagrams and tables — are now proper modal surfaces.
  They cover the workspace, but `Tab` used to walk straight out of them onto the
  note's own links and buttons behind the overlay, so focus landed where the
  reader could not see it and the next `Enter` activated it. `Tab` and
  `Shift+Tab` now cycle within the overlay, and it identifies itself to
  assistive tech as a labelled modal dialog.
- The minimum supported Obsidian version is now **1.6.6**, the release that
  exposes footnotes in the metadata cache — the single source full-screen
  footnote definitions are read from.
- Closing a full-screen table **from the keyboard** now returns focus to the
  inline trigger button, which is made visible while it holds focus. Closing
  with the mouse still leaves focus where it was, so Space keeps scrolling the
  note rather than re-activating an invisible button. This affects every
  full-screen table, not only footnoted ones.

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

[Unreleased]: https://github.com/Post-Math/Lookout/compare/1.2.3...HEAD
[1.2.3]: https://github.com/Post-Math/Lookout/compare/1.2.2...1.2.3
[1.2.2]: https://github.com/Post-Math/Lookout/compare/1.2.1...1.2.2
[1.2.1]: https://github.com/Post-Math/Lookout/compare/1.2.0...1.2.1
[1.2.0]: https://github.com/Post-Math/Lookout/compare/1.1.7...1.2.0
[#28]: https://github.com/Post-Math/Lookout/issues/28
[1.1.3]: https://github.com/Post-Math/Lookout/compare/1.1.2...1.1.3
[1.1.2]: https://github.com/Post-Math/Lookout/compare/1.1.1...1.1.2
[1.1.1]: https://github.com/Post-Math/Lookout/releases/tag/1.1.1
