# Lookout

[![CI](https://github.com/Post-Math/Lookout/actions/workflows/ci.yml/badge.svg?branch=dev)](https://github.com/Post-Math/Lookout/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Post-Math/Lookout?sort=semver)](https://github.com/Post-Math/Lookout/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> Survey wide content instead of scrolling sideways.

**Lookout** is an [Obsidian](https://obsidian.md) plugin for reading **wide
Mermaid diagrams and wide tables**. Instead of squinting through a note's narrow
horizontal scrollbar, pan and zoom a diagram, fit it to the frame, or throw
either a diagram or a table up full-screen.

The controls follow a quiet *drafting / survey-instrument* visual language: they
borrow Obsidian's own theme surfaces, with a single survey-cyan accent reserved
for focus and the active zoom gauge.

## Features

### Mermaid diagrams

Each rendered Mermaid diagram gets an unobtrusive instrument toolbar (it fades in
on hover):

- **Pan** — drag, or scroll with the mouse wheel (Shift maps a vertical wheel to
  horizontal). At an edge with nowhere to go, scrolling releases back to the page.
- **Zoom** — `Ctrl` / `Cmd` + wheel zooms toward the cursor, or use the `+` / `−`
  buttons.
- **Gauge** — a monospace readout shows the current zoom; click it to snap back to
  **100 %**, top-left.
- **Fit to frame** — scales the whole diagram to the frame.
- **Full screen** — opens the diagram in a focused full-screen canvas with the
  same controls.

The inline frame hugs the diagram's natural (100 %) height, so a fully visible
diagram has no dead space; tall diagrams are capped at 70 % of the window height
and pan.

### Tables

Wide tables keep their normal horizontal scroll but gain a single **full-screen**
button (no zoom) pinned to the visible top-right corner. Full screen shows the
table in a maximized scroll area where its full width fits far better than in the
note's narrow reading column.

Tables are enhanced in both **Reading view** and **Live Preview**; the table you
are actively editing is left untouched.

## Keyboard & commands

When a diagram frame is focused (or in full screen):

| Key | Action |
| --- | --- |
| `+` / `=` | Zoom in |
| `−` / `_` | Zoom out |
| `0` | Reset to 100 %, top-left |
| Arrow keys | Pan |
| `F` | Open full screen (inline only) |
| `Esc` | Close full screen |

A command, **“Open the active note's first Mermaid diagram full screen”**, is
available from the command palette and can be bound to a hotkey.

## Installation

Lookout works on both desktop and mobile (Obsidian **1.0.0+**).

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the
   [latest release](https://github.com/Post-Math/Lookout/releases).
2. Create a folder `lookout` under your vault's `.obsidian/plugins/` directory and
   place the three files inside it.
3. Reload Obsidian and enable **Lookout** under *Settings → Community plugins*.

### BRAT (beta)

Add `Post-Math/Lookout` as a beta plugin with the
[BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin to track pre-release
builds.

## Support

Found a bug or have an idea? Please use the
[issue tracker](https://github.com/Post-Math/Lookout/issues). For security
reports, see [SECURITY.md](SECURITY.md).

## Contributing & development

Contributions are welcome! Start with **[CONTRIBUTING.md](CONTRIBUTING.md)** for
the workflow and our [Code of Conduct](CODE_OF_CONDUCT.md), and see
**[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)** for the local setup, the checks to
run, and an architecture overview. In short: Lookout is written in **TypeScript**
(`src/main.ts`) and bundled to `main.js` with **esbuild** — `npm ci`, then
`npm run dev` to watch-build while you edit.

## License

[MIT](LICENSE) © Post-Math
