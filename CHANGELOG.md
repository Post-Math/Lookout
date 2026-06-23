# Changelog

All notable changes to Lookout are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

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

[Unreleased]: https://github.com/Post-Math/Lookout/compare/1.1.1...HEAD
[1.1.1]: https://github.com/Post-Math/Lookout/releases/tag/1.1.1
