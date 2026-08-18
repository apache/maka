# Maka Computer History helper

This directory vendors the macOS event-stream collector from
`hqhq1025/open-codex-computer-history` version 0.2.0.

The collector is a clean-room implementation based on public product behavior
and locally observable interfaces. It records Accessibility and Core Graphics
interaction events without screenshots, video, or audio.

Maka owns the Electron integration, process lifecycle, privacy defaults,
timeline projection, and user controls. The vendored collector remains under
the MIT license copied to `apps/desktop/resources/licenses/open-computer-history`.
