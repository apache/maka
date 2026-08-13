// apps/desktop/src/renderer/command-palette-commands.ts
//
// Pure builders for the command palette list. Extracted from
// command-palette.tsx (JSX) so main-process unit tests can import them
// under tsconfig.main (no JSX). The palette re-exports these helpers.

import {
  Blocks,
  CalendarDays,
  Clock,
  Database,
  Download,
  FolderOpen,
  Keyboard,
  MessageSquare,
  MessageCircleQuestion,
  Moon,
  Palette,
  Plug,
  Plus,
  Settings as SettingsIcon,
  ShieldCheck,
  Sparkles,
  Sun,
  SunMoon,
  Wifi,
  type LucideIcon,
} from '@maka/ui/icons';
import type { ChatDefaultPermissionMode, SettingsSection, ThemePreference } from '@maka/core/settings';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { PermissionMode } from '@maka/core/permission';
import type { SessionSummary } from '@maka/core/session';
import type { UiLocale } from '@maka/core/ui-locale';
import type { NavSelection } from '@maka/ui';
import { getShellCopy } from './locales/shell-copy.js';
import { SETTINGS_NAV } from './settings/settings-nav.js';
import type { Command } from './command-palette-types.js';

/**
 * Helper composing the palette's base command list (everything except the
 * session rows, which buildSessionCommands derives separately so the catalog
 * can stay live while the palette is open — #1045). Pulling this out makes
 * the palette itself pure presentation.
 */
export function buildCommandList(args: {
  locale: UiLocale;
  activeSessionId: string | undefined;
  themePref: ThemePreference;
  connections: LlmConnection[];
  defaultSlug: string | null;
  onNewChat(): Promise<void> | void;
  onOpenSideChat?(): Promise<void> | void;
  onStartDeepResearch?(): Promise<void> | void;
  onOpenSettings(): void;
  onOpenSettingsSection(section: SettingsSection): void;
  onOpenShortcuts(): void;
  onSetTheme(next: ThemePreference): void;
  /**
   * Diagnostics — wired up via the existing IPC bridge in main.tsx so the
   * palette can trigger actions without taking a dependency on
   * `window.maka.*` directly from this file.
   */
  onTestConnection?(slug: string): Promise<void> | void;
  onSetDefaultConnection?(slug: string): Promise<void> | void;
  onOpenWorkspace?(): Promise<void> | void;
  onOpenProjectFolder?(): Promise<void> | void;
  onOpenSkillsFolder?(): Promise<void> | void;
  /** Copy the active conversation as Markdown to the clipboard. */
  onExportActiveConversation?(): Promise<void> | void;
  /**
   * PR-CMD-PALETTE-SAVE-CONVERSATION-FILE-0: save the active conversation
   * as a Markdown file via the native save dialog. Complements
   * `onExportActiveConversation` (clipboard) for users who want a
   * durable archive without the clipboard detour.
   */
  onSaveActiveConversationToFile?(): Promise<void> | void;
  /**
   * PR-CMD-PALETTE-COPY-DAILY-REVIEW-0: copy today's Daily Review
   * as Markdown from anywhere via ⌘K. Same Markdown formatter
   * `<DailyReviewPanel>` uses; renderer wires the bridge.
   */
  onCopyTodayDailyReview?(): Promise<void> | void;
  /**
   * PR-CMD-PALETTE-OPEN-MEMORY-0: open the local MEMORY.md file in
   * the OS default editor from anywhere via ⌘K. The renderer wires
   * this to `window.maka.memory.openFile()`.
   */
  onOpenLocalMemoryFile?(): Promise<void> | void;
  /**
   * PR-CMD-PALETTE-PERMISSION-MODE-0: switch the active session's
   * permission mode from anywhere via ⌘K. Only registers when both
   * a callback and an active session id are wired. Mirrors the
   * composer's permission-mode dropdown (PR-MOVE-PERMISSION-MODE
   * relocated the picker out of the chat header).
   */
  onSetPermissionMode?(mode: ChatDefaultPermissionMode): Promise<void> | void;
  activePermissionMode?: PermissionMode;
  /**
   * PR-CMD-PALETTE-PASTE-DAILY-REVIEW-0: fetch today's review and
   * paste the Markdown into the composer instead of the clipboard.
   * Useful when the user wants to ask the model "summarize my day"
   * without leaving the chat.
   */
  onPasteTodayDailyReviewIntoComposer?(): Promise<void> | void;
  /**
   * PR-DAILY-REVIEW-EXPORT-FILE-0: save today's review as a Markdown
   * file via the native save dialog. Persistent archive without
   * round-tripping the clipboard.
   */
  onSaveTodayDailyReviewToFile?(): Promise<void> | void;
  /**
   * PR-CMD-PALETTE-COPY-ENV-SUMMARY-0: copy the Settings → 关于
   * environment summary (Maka version + Electron / Node / Chrome
   * versions + platform + arch + build mode/sha) as Markdown,
   * without having to open Settings. Useful for bug reports.
   */
  onCopyEnvSummary?(): Promise<void> | void;
  /**
   * PR-CMD-PALETTE-NETWORK-PROXY-TEST-0: ⌘K → 测试当前网络代理. Fires
   * `window.maka.settings.testNetworkProxy()` and surfaces the result
   * via toast so a user debugging a connection issue does not have to
   * open Settings → 网络 first.
   */
  onTestNetworkProxy?(): Promise<void> | void;
  /**
   * PR-CMD-PALETTE-ENRICH-0: jump to an app module (会话 / 计划 /
   * 技能 / 每日回顾) directly from the palette. Search itself is
   * already covered by the existing thread-search hookup, so the
   * `search` module nav id is intentionally omitted here.
   */
  onSelectModule?(selection: NavSelection): void;
  onStartScheduledTask?(): void;
}): Command[] {
  const copy = getShellCopy(args.locale).commandPalette;
  const staticCopy = (id: keyof typeof copy.commands) => copy.commands[id];
  const cmds: Command[] = [
    {
      id: 'action:new-chat',
      kind: 'action',
      ...staticCopy('action:new-chat'),
      Icon: Plus,
      keywords: [...copy.staticKeywords['action:new-chat']],
      run: args.onNewChat,
    },
    ...(args.activeSessionId && args.onOpenSideChat
      ? [
          {
            id: 'action:side-chat',
            kind: 'action' as const,
            ...staticCopy('action:side-chat'),
            Icon: MessageCircleQuestion,
            keywords: [...copy.staticKeywords['action:side-chat']],
            run: args.onOpenSideChat,
          },
        ]
      : []),
    ...(args.onStartDeepResearch
      ? [
          {
          id: 'action:new-deep-research',
          kind: 'action' as const,
            ...staticCopy('action:new-deep-research'),
          Icon: Sparkles,
            keywords: [...copy.staticKeywords['action:new-deep-research']],
          run: () => args.onStartDeepResearch!(),
          },
        ]
      : []),
    ...(args.onStartScheduledTask
      ? [
          {
          id: 'action:new-scheduled-task',
          kind: 'action' as const,
            ...staticCopy('action:new-scheduled-task'),
          Icon: Clock,
            keywords: [...copy.staticKeywords['action:new-scheduled-task']],
          run: args.onStartScheduledTask,
          },
        ]
      : []),
    {
      id: 'action:open-settings',
      kind: 'action',
      ...staticCopy('action:open-settings'),
      Icon: SettingsIcon,
      keywords: [...copy.staticKeywords['action:open-settings']],
      run: args.onOpenSettings,
    },
    {
      id: 'action:keyboard-help',
      kind: 'action',
      ...staticCopy('action:keyboard-help'),
      Icon: Keyboard,
      keywords: [...copy.staticKeywords['action:keyboard-help']],
      run: args.onOpenShortcuts,
    },
    {
      id: 'theme:light',
      kind: 'action',
      ...staticCopy('theme:light'),
      hint: args.themePref === 'light' ? copy.current : undefined,
      Icon: Sun,
      keywords: [...copy.staticKeywords['theme:light']],
      run: () => args.onSetTheme('light'),
    },
    {
      id: 'theme:dark',
      kind: 'action',
      ...staticCopy('theme:dark'),
      hint: args.themePref === 'dark' ? copy.current : undefined,
      Icon: Moon,
      keywords: [...copy.staticKeywords['theme:dark']],
      run: () => args.onSetTheme('dark'),
    },
    {
      id: 'theme:auto',
      kind: 'action',
      ...staticCopy('theme:auto'),
      hint: args.themePref === 'auto' ? copy.current : undefined,
      Icon: SunMoon,
      keywords: [...copy.staticKeywords['theme:auto']],
      run: () => args.onSetTheme('auto'),
    },
  ];

  // PR-CMD-PALETTE-ENRICH-0: app module jumps. Lets ⌘K →
  // "每日回顾" / "技能" / "计划" switch app modules without an
  // extra mouse click. Cheap to ship — pure callback wiring.
  if (args.onSelectModule) {
    const select = args.onSelectModule;
    cmds.push({
      id: 'nav:sessions',
      kind: 'action',
      ...staticCopy('nav:sessions'),
      Icon: MessageSquare,
      keywords: [...copy.staticKeywords['nav:sessions']],
      run: () => select({ section: 'sessions', filter: 'chats' }),
    });
    cmds.push({
      id: 'nav:automations',
      kind: 'action',
      ...staticCopy('nav:automations'),
      Icon: Clock,
      keywords: [...copy.staticKeywords['nav:automations']],
      run: () => select({ section: 'automations', module: 'scheduled-tasks' }),
    });
    cmds.push({
      id: 'nav:skills',
      kind: 'action',
      ...staticCopy('nav:skills'),
      Icon: Blocks,
      keywords: [...copy.staticKeywords['nav:skills']],
      run: () => select({ section: 'extensions', module: 'skills' }),
    });
    cmds.push({
      id: 'nav:mcp',
      kind: 'action',
      ...staticCopy('nav:mcp'),
      Icon: Plug,
      keywords: [...copy.staticKeywords['nav:mcp']],
      run: () => select({ section: 'extensions', module: 'mcp' }),
    });
    cmds.push({
      id: 'nav:daily-review',
      kind: 'action',
      ...staticCopy('nav:daily-review'),
      Icon: CalendarDays,
      keywords: [...copy.staticKeywords['nav:daily-review']],
      run: () => select({ section: 'automations', module: 'daily-review' }),
    });
  }

  // One palette command per Settings section so ⌘K → label lands the user
  // directly on that page.
  for (const navItem of SETTINGS_NAV) {
    cmds.push({
      id: `settings:${navItem.id}`,
      kind: 'action',
      label: copy.settingsCommand(copy.settingsSections[navItem.id]),
      group: copy.groups.settings,
      Icon: navItem.Icon as LucideIcon,
      keywords: copy.settingsKeywords(navItem.id, copy.settingsSections[navItem.id]),
      run: () => args.onOpenSettingsSection(navItem.id),
    });
  }

  // Diagnostics — quick actions @kenji called out in UI-05 (palette as
  // command surface, not just navigation). Each is gated on the matching
  // host callback being provided so the palette stays useful even when
  // some IPC entry isn't wired up.
  if (args.onOpenWorkspace) {
    cmds.push({
      id: 'diag:open-workspace',
      kind: 'action',
      ...staticCopy('diag:open-workspace'),
      Icon: FolderOpen,
      keywords: [...copy.staticKeywords['diag:open-workspace']],
      run: () => args.onOpenWorkspace!(),
    });
  }
  if (args.onOpenProjectFolder) {
    cmds.push({
      id: 'diag:open-project-folder',
      kind: 'action',
      ...staticCopy('diag:open-project-folder'),
      Icon: FolderOpen,
      keywords: [...copy.staticKeywords['diag:open-project-folder']],
      run: () => args.onOpenProjectFolder!(),
    });
  }
  if (args.onOpenSkillsFolder) {
    cmds.push({
      id: 'diag:open-skills',
      kind: 'action',
      ...staticCopy('diag:open-skills'),
      Icon: FolderOpen,
      keywords: [...copy.staticKeywords['diag:open-skills']],
      run: () => args.onOpenSkillsFolder!(),
    });
  }
  if (args.onExportActiveConversation && args.activeSessionId) {
    cmds.push({
      id: 'diag:export-conversation',
      kind: 'action',
      ...staticCopy('diag:export-conversation'),
      Icon: Download,
      keywords: [...copy.staticKeywords['diag:export-conversation']],
      run: () => args.onExportActiveConversation!(),
    });
  }
  if (args.onSaveActiveConversationToFile && args.activeSessionId) {
    cmds.push({
      id: 'diag:save-conversation-file',
      kind: 'action',
      ...staticCopy('diag:save-conversation-file'),
      Icon: Download,
      keywords: [...copy.staticKeywords['diag:save-conversation-file']],
      run: () => args.onSaveActiveConversationToFile!(),
    });
  }
  if (args.onCopyTodayDailyReview) {
    cmds.push({
      id: 'diag:copy-today-daily-review',
      kind: 'action',
      ...staticCopy('diag:copy-today-daily-review'),
      Icon: CalendarDays,
      keywords: [...copy.staticKeywords['diag:copy-today-daily-review']],
      run: () => args.onCopyTodayDailyReview!(),
    });
  }
  if (args.onPasteTodayDailyReviewIntoComposer && args.activeSessionId) {
    cmds.push({
      id: 'diag:paste-today-daily-review',
      kind: 'action',
      ...staticCopy('diag:paste-today-daily-review'),
      Icon: CalendarDays,
      keywords: [...copy.staticKeywords['diag:paste-today-daily-review']],
      run: () => args.onPasteTodayDailyReviewIntoComposer!(),
    });
  }
  if (args.onSaveTodayDailyReviewToFile) {
    cmds.push({
      id: 'diag:save-today-daily-review',
      kind: 'action',
      ...staticCopy('diag:save-today-daily-review'),
      Icon: CalendarDays,
      keywords: [...copy.staticKeywords['diag:save-today-daily-review']],
      run: () => args.onSaveTodayDailyReviewToFile!(),
    });
  }
  if (args.onCopyEnvSummary) {
    cmds.push({
      id: 'diag:copy-env-summary',
      kind: 'action',
      ...staticCopy('diag:copy-env-summary'),
      Icon: Database,
      keywords: [...copy.staticKeywords['diag:copy-env-summary']],
      run: () => args.onCopyEnvSummary!(),
    });
  }
  if (args.onTestNetworkProxy) {
    cmds.push({
      id: 'diag:test-network-proxy',
      kind: 'action',
      ...staticCopy('diag:test-network-proxy'),
      Icon: Wifi,
      keywords: [...copy.staticKeywords['diag:test-network-proxy']],
      run: () => args.onTestNetworkProxy!(),
    });
  }
  if (args.onOpenLocalMemoryFile) {
    cmds.push({
      id: 'diag:open-local-memory',
      kind: 'action',
      ...staticCopy('diag:open-local-memory'),
      Icon: FolderOpen,
      keywords: [...copy.staticKeywords['diag:open-local-memory']],
      run: () => args.onOpenLocalMemoryFile!(),
    });
  }
  if (args.onSetPermissionMode && args.activeSessionId) {
    const setMode = args.onSetPermissionMode;
    const current = args.activePermissionMode;
    const modes: ChatDefaultPermissionMode[] = ['ask', 'bypass'];
    for (const mode of modes) {
      const localized = copy.permissionModes[mode];
      cmds.push({
        id: `perm:set-${mode}`,
        kind: 'action',
        label: localized.label,
        hint: current === mode ? copy.current : localized.hint,
        group: copy.groups.permissions,
        Icon: ShieldCheck,
        keywords: copy.permissionKeywords(mode),
        run: () => setMode(mode),
      });
    }
  }
  if (args.onTestConnection && args.defaultSlug) {
    const defaultConnection = args.connections.find((c) => c.slug === args.defaultSlug);
    if (defaultConnection) {
      cmds.push({
        id: 'diag:test-default',
        kind: 'action',
        label: copy.testDefaultConnection(defaultConnection.name),
        hint: defaultConnection.providerType,
        group: copy.commands['diag:test-network-proxy'].group,
        Icon: Plug,
        keywords: copy.connectionKeywords('test', defaultConnection.name, defaultConnection.providerType),
        run: () => args.onTestConnection!(defaultConnection.slug),
      });
    }
  }

  // Per-connection: switch the default model + run a test. Useful when the
  // user has 3+ connections and doesn't want to walk through Settings ·
  // 账号 just to swap.
  if (args.onSetDefaultConnection || args.onTestConnection) {
    for (const connection of args.connections) {
      if (!connection.enabled) continue;
      const isDefault = connection.slug === args.defaultSlug;
      // The workspace default is the pair {connection, model}. A connection
      // with no default model cannot supply half of it, so offering the command
      // could only produce a failure toast that reads like a transient one.
      if (args.onSetDefaultConnection && !isDefault && connection.defaultModel) {
        cmds.push({
          id: `connection:set-default:${connection.slug}`,
          kind: 'action',
          label: copy.setDefaultConnection(connection.name),
          hint: connection.providerType,
          group: copy.groups.connections,
          Icon: Wifi,
          keywords: copy.connectionKeywords('default', connection.name, connection.providerType),
          run: () => args.onSetDefaultConnection!(connection.slug),
        });
      }
      if (args.onTestConnection && !isDefault) {
        cmds.push({
          id: `connection:test:${connection.slug}`,
          kind: 'action',
          label: copy.testConnection(connection.name),
          hint: connection.providerType,
          group: copy.groups.connections,
          Icon: Plug,
          keywords: copy.connectionKeywords('test', connection.name, connection.providerType),
          run: () => args.onTestConnection!(connection.slug),
        });
      }
    }
  }

  return cmds;
}

/**
 * Session rows for the palette's 会话 group, derived separately from the
 * base command list (#1045): the base list is frozen per palette open/close,
 * while these rebuild only when the visible session catalog or the active
 * session actually changes, so background session creates/renames stay live
 * without reintroducing per-render list rebuilds.
 */
export function buildSessionCommands(args: {
  locale: UiLocale;
  sessions: SessionSummary[];
  activeSessionId: string | undefined;
  onSelectSession(id: string): void;
}): Command[] {
  const copy = getShellCopy(args.locale).commandPalette;
  const cmds: Command[] = [];
  for (const session of args.sessions) {
    if (session.isArchived) continue;
    cmds.push({
      id: `session:${session.id}`,
      kind: 'session',
      label: session.name,
      hint: session.id === args.activeSessionId ? copy.current : undefined,
      group: copy.groups.conversations,
      Icon: session.isFlagged ? Palette : MessageSquare,
      keywords: ['session', 'chat', session.name],
      run: () => args.onSelectSession(session.id),
    });
  }
  return cmds;
}
