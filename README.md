# Lookout

[![CI](https://github.com/Post-Math/Lookout/actions/workflows/ci.yml/badge.svg?branch=dev)](https://github.com/Post-Math/Lookout/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Post-Math/Lookout?sort=semver)](https://github.com/Post-Math/Lookout/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> Survey wide content instead of scrolling sideways.

Lookout is an [Obsidian](https://obsidian.md) plugin for reading **wide Mermaid diagrams and wide tables**. Instead of squinting through a note's narrow horizontal scrollbar, you can pan and zoom a diagram, fit it to the frame, or throw either a diagram or a table up full‑screen.

The controls follow a quiet "drafting / survey instrument" visual language: they use Obsidian's own theme surfaces, with a single survey‑cyan accent reserved for focus and the active zoom gauge.

## Features

### Mermaid diagrams

Each rendered Mermaid diagram gets an unobtrusive instrument toolbar (it fades in on hover):

- **Pan** — drag, or scroll with the mouse wheel (Shift maps a vertical wheel to horizontal). At an edge with nowhere to go, scrolling releases back to the page.
- **Zoom** — `Ctrl`/`Cmd` + wheel zooms toward the cursor, or use the `+` / `−` buttons.
- **Gauge** — a monospace readout shows the current zoom; click it to snap back to **100 %**, top‑left.
- **Fit to frame** — scales the whole diagram to the frame.
- **Full screen** — opens the diagram in a focused full‑screen canvas with the same controls.

The inline frame hugs the diagram's natural (100 %) height, so a fully visible diagram has no dead space; tall diagrams are capped at 70 % of the window height and pan.

### Tables

Wide tables keep their normal horizontal scroll but gain a single **full‑screen** button (no zoom) pinned to the visible top‑right corner. Full screen shows the table in a maximized scroll area where its full width fits far better than in the note's narrow reading column.

Tables are enhanced in both **Reading view** and **Live Preview**; the table you are actively editing is left untouched.

## Keyboard

When a diagram frame is focused (or in full screen):

| Key | Action |
| --- | --- |
| `+` / `=` | Zoom in |
| `−` / `_` | Zoom out |
| `0` | Reset to 100 %, top‑left |
| Arrow keys | Pan |
| `F` | Open full screen (inline only) |
| `Esc` | Close full screen |

A command, **"Open the active note's first Mermaid diagram full screen"**, is also available from the command palette and can be bound to a hotkey.

## Installation

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/Post-Math/Lookout/releases).
2. Create a folder `lookout` under your vault's `.obsidian/plugins/` directory and place the three files inside it.
3. Reload Obsidian and enable **Lookout** under *Settings → Community plugins*.

### BRAT

Add `Post-Math/Lookout` as a beta plugin with the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin.

## Development

Lookout ships as plain CommonJS with **no build step** — Obsidian loads `main.js` directly. To work on it, clone this repo (or symlink it) into a vault's `.obsidian/plugins/lookout/` folder and edit `main.js` / `styles.css` directly, then reload the plugin.

```
main.js              # the plugin (DiagramView, TableView, LookoutPlugin)
styles.css           # the drafting/survey-instrument UI
manifest.json        # plugin metadata
versions.json        # plugin version -> minimum Obsidian version
scripts/validate.mjs # CI checks (manifest/versions consistency, required files)
```

Run the same checks CI runs before opening a PR:

```bash
node --check main.js
node scripts/validate.mjs
```

## Branching model

Lookout uses a git-flow style model:

- **`main`** — release / deployment. Always reflects the latest published release. Protected; only receives merges from `dev` (and `hotfix/*`).
- **`dev`** — integration branch and the **default branch**. The base for all day-to-day work.
- **`feat/*`, `fix/*`, `docs/*`, `chore/*`** — short-lived topic branches, branched off `dev` and merged back into `dev`.

```
feat/my-change  ──▶  dev  ──▶  main  ──▶  tag (e.g. 1.2.0)  ──▶  Release
```

Always branch off `dev` and open pull requests against `dev` — never `main`.

## Contributing

Contributions are welcome! External contributors work via a **fork** and open
pull requests against `dev`. A [code owner](.github/CODEOWNERS) review and a
green CI run are required before a PR can merge.

Please read **[CONTRIBUTING.md](CONTRIBUTING.md)** for the full workflow, and our
**[Code of Conduct](CODE_OF_CONDUCT.md)**. For security issues, see
**[SECURITY.md](SECURITY.md)**.

## License

[MIT](LICENSE) © Post-Math
