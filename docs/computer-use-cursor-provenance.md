# Computer Use cursor provenance and compatibility evidence

This document records the source lineage and compatibility evidence for Maka's
agent-cursor overlay.

Earlier revisions overstated the relationship between compatibility analysis
and source provenance. In particular, they described the current scorer as a
term-for-term recovery from a shipped executable and described several values
as exact copies. The repository history supports a different and more precise
account: the cursor began as a TypeScript adaptation of MIT-licensed
`trycua/cua`, then Maka replaced and extended its planner, timing, hotspot,
rendering, and presentation lifecycle while using Codex Desktop as a
compatibility target.

## Source lineage

| Stage | Source | What entered Maka |
|---|---|---|
| Initial cursor renderer | `trycua/cua` cursor-overlay, MIT, upstream commit `8c921b2b3bf13494724ead4f0a814d80c56a7e8b` | A TypeScript adaptation of the public cursor-overlay motion and rendering design, introduced in Maka commit `025d0c628a2162d0a7daf49e97d104c36a4431c6`. |
| Maka implementation | Commits beginning with `6a0a4fe8254a0bfab8e757d5562c23ab0244fb7f`, then `5551d6cd1c730542d8584ef295584607f9ae4428` and `cbb03172fcb499ced4c186b7c3437583cf524e28` | Direct-motion semantics, the cubic planner and scorer, spring timing, hotspot behavior, target-relative window ordering, rendering, presentation fences, and tests. |
| Compatibility reference | Codex Desktop behavior observed on the 2026-07-16 build | Product-level expectations for pointer readability, center-aligned presentation, curved motion, target-window ordering, and settling before an action is released. |

The current TypeScript planner, scorer, rendering, and Maka-specific
integration are maintained in this repository. No OpenAI source code or
executable is included or redistributed.

## Implementation boundary

The current implementation uses a deterministic cubic candidate planner,
spring-based progress and style motion, a stable normalized cursor shape, and
an explicit close-enough release gate. These are Maka implementation contracts,
not a claim of instruction-for-instruction equivalence with Codex Desktop.

The parameters live next to the implementation in
`apps/desktop/src/renderer/computer-use-overlay/engine/cursor-engine.ts`. Their
release behavior is covered by cursor-engine, presentation-fence, frame-rate,
viewport, and real-window landing tests.

## Compatibility validation

Validation compares externally visible behavior:

- the pointer remains readable on light and dark surfaces;
- the presented hotspot lands at the action coordinate;
- long moves remain inside the viewport and do not curl away from the target;
- progress remains tied to wall-clock time across supported frame rates;
- the action is not released while the cursor is visibly short of the target;
- the overlay is ordered relative to the target window rather than globally
  above unrelated applications.

PR visual evidence belongs on the pull request or issue rather than under
`docs/`.
