# Computer History integration

## Product decision

Maka treats Computer History as a local context source, not as a second memory
system and not as a screen replay feature.

The integration has four boundaries:

1. A macOS helper records Accessibility and Core Graphics interaction events.
2. The Electron main process owns the helper lifecycle, raw files, privacy
   settings, retention, deletion, and timeline projection.
3. The preload bridge exposes bounded status, controls, and reduced timeline
   entries. It never exposes raw JSONL paths or event bodies.
4. The workbar lets the user explicitly add one reduced activity interval to
   the Composer. History is never injected into a model request automatically.

This follows the released Computer History generation: an interaction-event
stream, not the older screenshot/OCR Chronicle design.

## User experience

Computer History is a persistent workbar tool next to Changes, Terminal,
Browser, Files, Tasks, and Trace.

The panel provides:

- recording state and event count;
- explicit enable/disable;
- permission request for Accessibility and Input Monitoring;
- pause/resume;
- destructive clear with confirmation;
- a chronological app/window activity list;
- an explicit "Add to chat" action per interval.

At narrow widths the existing responsive workbar moves to the bottom panel.
The timeline remains scrollable and does not create horizontal overflow.

## Privacy defaults

- The feature is disabled by default.
- Typed-text persistence is disabled by default.
- Password and secure fields are always suppressed by the collector.
- Private-browsing windows are always suppressed.
- Keychain Access is blocked by default.
- The helper does not request Screen Recording and does not capture screenshots,
  video, or audio.
- Raw event segments are pruned after 48 hours by the helper.
- Suppressed event bodies are not stored; only a count is retained.
- Renderer and model-facing projections omit keyboard text, selection text,
  accessibility values, raw paths, and process identifiers.

Window titles and app names are observed external data. Before they can enter
the Composer, control characters and tag delimiters are escaped and the
projection is wrapped in an `untrusted-observed-ui` envelope that explicitly
instructs the model to treat the contents as data rather than commands.

## Implementation map

- Shared contract: `packages/core/src/computer-history.ts`
- Native collector: `apps/desktop/native/computer-history`
- Helper build: `apps/desktop/scripts/build-computer-history-helper.mjs`
- Main authority and IPC: `apps/desktop/src/main/computer-history-main.ts`
- Preload bridge: `apps/desktop/src/preload/preload.ts`
- Workbar surface: `apps/desktop/src/renderer/computer-history-panel.tsx`
- Capability/health projection: `apps/desktop/src/main/capability-snapshot.ts`
- Functional and responsive E2E:
  `apps/desktop/e2e/computer-history.spec.ts`

The vendored collector is the MIT-licensed clean-room implementation from
`hqhq1025/open-codex-computer-history` version 0.2.0. Attribution is preserved
in `NOTICE` and the packaged license directory.

## Why this fits Maka

Maka already has the correct downstream surfaces:

- Session Composer for explicit context use;
- Side Chat for exploratory questions that should not interrupt the main task;
- Daily Review for model-generated rollups over local activity;
- Skills and scheduled tasks for turning repeated workflows into automation;
- Permission Center for capability readiness and revocation visibility.

The first integration uses deterministic ten-minute activity grouping. A later
summary lane should feed reduced intervals into the existing Daily Review model
authority instead of starting a separate provider/session stack.

## Remaining product work

The implemented vertical slice is complete for local recording, timeline viewing,
control, deletion, and explicit chat context. Follow-up work should add:

- an app/domain policy editor in Settings;
- an optional typed-text toggle with a high-friction privacy warning;
- 10-minute and 6-hour model summaries through Daily Review;
- "Ask in Side Chat" and "Create Skill/Automation" actions;
- Windows UI Automation collection with the same shared event contract;
- packaged/notarized helper verification in release CI.

These are extensions, not hidden fallbacks. The current UI reports unsupported
or unavailable states explicitly.
