export * from './artifact-preview-registry.js';
export * from './assistant-stream.js';
export * from './chat-empty-hero.js';
export * from './chat-model-helpers.js';
export * from './clipboard-feedback.js';
export * from './use-mounted-ref.js';
export * from './components.js';
export type { SessionHistoryGroup } from './session-history-list.js';
export * from './session-status-presentation.js';
export * from './composer-helpers.js';
export * from './conversation-copy.js';
export * from './shared-ui-copy.js';
export * from './skills-copy.js';
export * from './daily-review-copy.js';
export * from './plan-reminder-copy.js';
export * from './tool-activity/copy.js';
export * from './chat-input-behavior.js';
export * from './composer-mention-popup.js';
export * from './use-composer-skill-draft.js';
export * from './use-mention-popup.js';
export * from './runtime-resume-copy.js';
export * from './input-history.js';
export * from './daily-review-helpers.js';
export * from './locale-helpers.js';
export * from './locale-context.js';
export * from './markdown.js';
export * from './maka-uri.js';
export * from './materialize.js';
export * from './live-turn-projection.js';
export * from './model-picker.js';
export * from './interaction-queue.js';
export * from './user-question-prompt.js';
export * from './user-question-prompt-state.js';
export * from './redact.js';
export * from './overlay-scroll-area.js';
export * from './smooth-stream.js';
export * from './thinking-stream.js';
export * from './task-ledger-panel.js';
export * from './toast.js';
export * from './tool-output-stream.js';
export * from './ui.js';
export * from './utils.js';

// shared primitive UI primitives (copy/own from upstream primitive source). Each file is
// dropped in `./primitives/` with the `cn()` import rewritten to our
// local helper. Net-new components that aren't already covered
// by our shared component-style wrappers in `./ui.js` re-export here so
// consumers can `import { Alert, Empty, ... } from '@maka/ui'`.
export * from './bot-brand.js';
export * from './bot-brand-logo.js';
export * from './maka-wordmark.js';
export * from './primitives/alert.js';
export * from './primitives/card.js';
// `markerVariants` / `toolVariants` are deliberately NOT re-exported here:
// they are internal styling tables that the chat call sites apply via relative
// import, so keeping them off the package barrel preserves the governance goal
// — they stay renamable/removable without a public-API break. (Contrast
// `buttonVariants`, which IS public because it has external consumers.)
//
// `previewVariants` (#332 PR4) IS re-exported: its file-diff parts have a second,
// cross-package consumer — `apps/desktop`'s `artifact-preview.tsx` — which is the
// promotion condition the off-barrel convention named, so the export is the rule.
export { Bubble, Marker, Message, previewVariants } from './primitives/chat.js';
export { formatTurnDuration } from './chat-display-helpers.js';
export type {
  BubbleProps,
  MarkerProps,
  MarkerVariant,
  MessageProps,
} from './primitives/chat.js';
export * from './primitives/empty.js';
export * from './primitives/item.js';
export * from './primitives/spinner.js';
export * from './primitives/kbd.js';
export * from './primitives/menu.js';
export * from './primitives/dialog-header.js';
export * from './primitives/stat-tile.js';
export * from './primitives/data-table.js';
export * from './primitives/section-header.js';
export { EmptyState } from './empty-state.js';
export * from './primitives/choice-card.js';
export * from './primitives/segmented.js';
export * from './primitives/settings-select.js';
export * from './primitives/settings-switch.js';
export * from './primitives/input.js';
export * from './primitives/time-picker.js';
export * from './primitives/textarea.js';
export * from './primitives/input-group.js';
export * from './primitives/toolbar.js';
export {
  Collapsible,
  CollapsibleTrigger,
  CollapsiblePanel,
} from './primitives/collapsible.js';
export {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from './primitives/tooltip.js';
export {
  NumberField,
  NumberFieldInput,
} from './primitives/number-field.js';
export {
  Tabs as PrimitiveTabs,
  TabsList as PrimitiveTabsList,
  TabsTrigger as PrimitiveTabsTrigger,
  TabsPanel as PrimitiveTabsPanel,
  TabsContent as PrimitiveTabsContent,
  TabsPrimitive as PrimitiveTabsPrimitive,
} from './primitives/tabs.js';
export {
  Accordion as PrimitiveAccordion,
  AccordionItem as PrimitiveAccordionItem,
  AccordionHeader as PrimitiveAccordionHeader,
  AccordionTrigger as PrimitiveAccordionTrigger,
  AccordionPanel as PrimitiveAccordionPanel,
  AccordionPrimitive as PrimitiveAccordionPrimitive,
} from './primitives/accordion.js';
// PR-USE-SHADCN-BASE-UI-BADGE: the canonical pill Badge primitive. #520 PR9
// collapsed the legacy ui.tsx Badge onto this one. Badge is the pill emphasis
// marker (health/permission center). Variants: default / destructive / error
// / info / outline / secondary / success / warning.
export { Badge, badgeVariants } from './primitives/badge.js';
export type { BadgeProps } from './primitives/badge.js';
// PR-USE-SHADCN-BASE-UI-CHIP: squared compact status label. #520 PR9 collapsed
// .settingsBadge + .settingsConnectionBadge CSS chips onto this one. Chip is
// the squared (radius-control) counterpart to pill Badge, for dense settings
// status rows. Status variants mirror StatusTone: neutral / info / success /
// warning / destructive; `accent` is the separate brand-accent marker
// (default-connection flags) outside the status scale.
export { Chip, chipVariants } from './primitives/chip.js';
export type { ChipProps } from './primitives/chip.js';
// PageHeader — the shared page-header shell (convergence round 3). One shell
// for the module hero (as='h2': 技能 / 定时任务) and the settings intros
// (as='h3': permission / health / voice / about). Wrapper class + per-slot
// CSS stay at the call site; the primitive converges STRUCTURE only.
export { PageHeader } from './primitives/page-header.js';
export type { PageHeaderProps } from './primitives/page-header.js';
// Streaming UI rework: Codex-style tool "trow" grouping helpers. Pure bucketing
// + summary used by the timeline tool renderer (ToolTrow) and unit-tested.
export {
  summarizeTrowTools,
  trowActivityKind,
  isTrowRunning,
  trowNeedsAttention,
  type TrowActivityKind,
} from './tool-activity/trow-summary.js';
// #646 run→done seam: a tool row shimmers while running and settles by the
// light band stopping (no opacity fade — parallel settles don't stack).
// Unit-tested.
export {
  isToolRowRunning,
  isToolRowSettled,
} from './tool-activity/tool-row-motion.js';
// Streaming UI rework: per-word fade-in for streamed text (replaces the ▎
// caret). Pure append-record ring + tokenizer are unit-tested; the hook feeds
// markdown-body's rehype pass.
export {
  useStreamFade,
  tokenizeFade,
  updateFadeRing,
  createFadeRing,
  fadeBoundary,
  fadeAgeAt,
  FADE_MS,
  MAX_FADE_BATCHES,
  type StreamFade,
  type FadeToken,
  type FadeRingState,
  type FadeBatch,
} from './stream-fade.js';
