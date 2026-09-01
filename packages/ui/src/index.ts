/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

export * from './artifact-preview-registry.js';
export * from './assistant-stream.js';
export * from './chat-empty-hero.js';
export * from './chat-model-helpers.js';
export * from './use-mounted-ref.js';
export * from './components.js';
export type { ComposerProps } from './components.js';
export type { SandboxBoundaryPromptProps } from './sandbox-boundary-prompt.js';
export type { ClientCapabilityPromptProps } from './client-capability-prompt.js';
export type {
  ProjectRowActions,
  SessionHistoryGroup,
  SessionRowActions,
} from './session-history-list.js';
export * from './session-status-presentation.js';
export * from './composer-helpers.js';
export * from './conversation-copy.js';
export * from './shared-ui-copy.js';
export * from './skills-copy.js';
export * from './daily-review-copy.js';
export * from './scheduled-task-copy.js';
export * from './tool-activity/copy.js';
export * from './tool-activity/sandbox-denial.js';
export * from './chat-input-behavior.js';
export * from './runtime-resume-copy.js';
export * from './input-history.js';
export * from './daily-review-helpers.js';
export * from './locale-helpers.js';
export * from './locale-context.js';
export { MakaUriContext } from './markdown.js';
export * from './maka-uri.js';
export * from './materialize.js';
export * from './live-turn-projection.js';
export * from './transcript-projection.js';
export * from './use-transcript-projection.js';
export * from './model-picker.js';
export * from './interaction-queue.js';
export * from './user-question-prompt.js';
export * from './user-question-prompt-state.js';
export * from './redact.js';
export * from './thinking-stream.js';
export * from './session-todo-panel.js';
export * from './toast.js';
export * from './tool-output-stream.js';
export * from './ui.js';
export * from './utils.js';

// Maka-owned product assets and compositions remain public only where they do
// not duplicate a published Astryx component authority.
export * from './bot-brand.js';
export * from './bot-brand-logo.js';
export * from './maka-wordmark.js';
// #1565 PR 3: Card is the Astryx primitive now (the thin data-slot recipe is
// retired); same barrel slot, implementation swapped behind it.
export { Card, type CardProps, type CardVariant } from '@astryxdesign/core';
// `markerVariants` is deliberately NOT re-exported here: it is an internal
// styling table that the chat call sites apply via relative import, so keeping
// it off the package barrel preserves the governance goal — it stays
// renamable/removable without a public-API break.
//
// `previewVariants` (#332 PR4) IS re-exported: its file-diff parts have a second,
// cross-package consumer — `apps/desktop`'s `artifact-preview.tsx` — which is the
// promotion condition the off-barrel convention named, so the export is the rule.
export { previewVariants } from './primitives/chat.js';
export { DiffCodePreview } from './tool-activity/diff-code-preview.js';
export { syntaxLanguageForPath } from './tool-activity/diff-syntax.js';
export { MarkdownBody } from './markdown-body.js';
export { ToolResultPreview } from './tool-activity/tool-result-preview.js';
export { formatTurnDuration } from './chat-display-helpers.js';
export * from './primitives/stat-tile.js';
// PR-USE-SHADCN-BASE-UI-BADGE: the canonical pill Badge primitive. #520 PR9
// collapsed the legacy ui.tsx Badge onto this one. #1565 PR 3: the recipe is
// the Astryx Badge now (label prop, status + palette variants); same barrel
// slot, implementation swapped behind it. badgeVariants retired with the cva
// recipe (no consumers).
export { Badge, type BadgeProps, type BadgeVariant } from '@astryxdesign/core';
// PageHeader — the shared page-header shell (convergence round 3). One shell
// for the module hero (as='h2': 技能 / 定时任务) and the settings intros
// (as='h3': permission / health / about). Wrapper class + per-slot
// CSS stay at the call site; the primitive converges STRUCTURE only.
export { PageHeader } from './primitives/page-header.js';
export type { PageHeaderProps } from './primitives/page-header.js';
// ModulePage — the ONE shell every module page renders into (Astryx Layout,
// incident-console archetype). Born in this package for 定时任务 / 每日回顾;
// exported so the renderer-owned MCP page renders the same surface.
export { ModulePage, type ModulePageProps } from './primitives/module-page.js';
// One vocabulary for what a state MEANS, and one place deciding what each
// word looks like — see status-vocabulary.ts for why there is no `info`.
export { dotForStatus, type StatusSemantic } from './status-vocabulary.js';
// One tab stop per module-page row list; the MCP page (renderer-owned) uses
// the same hook the skills and scheduled-task panels do.
export { useRovingRowFocus, type RovingRowFocusProps } from './use-roving-row-focus.js';
// #1565 PR 2: Astryx i18n adapter — appended, never reordered (barrel freeze).
export * from './astryx-i18n.js';

// #1565 PR 3: Astryx atoms. These append-only exports leave the frozen
// @maka/ui surface intact; the mechanical atom cut follows separately.
export {
  Button,
  MoreMenu,
  type MoreMenuProps,
  type ButtonProps,
  type ButtonVariant,
  type ButtonSize,
  Banner,
  type BannerProps,
  type BannerStatus,
  Divider,
  type DividerProps,
  Text,
  type TextProps,
  type TextType,
  type TextSize,
  Stack,
  type StackProps,
  StackItem,
  type StackItemProps,
  HStack,
  type HStackProps,
  VStack,
  type VStackProps,
  IconButton,
  type IconButtonProps,
  EmptyState,
  type EmptyStateProps,
  Kbd,
  type KbdProps,
  Spinner,
  type SpinnerProps,
  type SpinnerSize,
  type SpinnerShade,
  ClickableCard,
  type ClickableCardProps,
  TextInput,
  type TextInputProps,
  TextArea,
  type TextAreaProps,
  NumberInput,
  type NumberInputProps,
  InputGroup,
  type InputGroupProps,
  InputGroupText,
  StatusDot,
  type StatusDotVariant,
  Switch,
  type SwitchProps,
  CheckboxInput,
  type CheckboxInputProps,
  CheckboxList,
  type CheckboxListProps,
  CheckboxListItem,
  type CheckboxListItemProps,
  RadioList,
  type RadioListProps,
  RadioListItem,
  type RadioListItemProps,
  Selector,
  SelectorOption,
  type SelectorProps,
  type SelectorOptionType,
  type SelectorOptionData,
  FormLayout,
  type FormLayoutProps,
  CommandPalette,
  type CommandPaletteProps,
  CommandPaletteInput,
  type CommandPaletteInputProps,
  CommandPaletteFooter,
  type CommandPaletteFooterProps,
  type SearchSource,
  type SearchableItem,
} from '@astryxdesign/core';
