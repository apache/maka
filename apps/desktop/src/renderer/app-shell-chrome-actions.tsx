import {
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightOpen,
  Search,
} from '@maka/ui/icons';
import {
  IconButton,
  useUiLocale,
} from '@maka/ui';
import { Icon } from '@astryxdesign/core/Icon';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import {
  SideNavCollapseButton,
  type SideNavImperativeCollapseHandle,
} from '@astryxdesign/core/SideNav';
import type { RefObject } from 'react';
import { getShellCopy } from './locales/shell-copy';

/**
 * Match SideNavItem collapsed/expanded icon slot: Astryx `renderIconSlot`
 * uses size `sm` (1rem) + color `secondary`. Titlebar follows that recipe
 * — not raw Lucide size props — so chrome and sidebar share one glyph look.
 */
function ChromeIcon(props: { icon: typeof Search }) {
  return <Icon icon={props.icon} size="sm" color="secondary" />;
}

export function AppShellTopbarActions(props: {
  sidebarCollapsed: boolean;
  sidebarHandleRef: RefObject<SideNavImperativeCollapseHandle | null>;
  /* Settings has its own navigation column; the session-sidebar toggle is
     meaningless there. */
  sidebarToggleHidden?: boolean;
  onOpenSearchModal(): void;
}) {
  const locale = useUiLocale();
  const copy = getShellCopy(locale).chrome;
  return (
    <div className="maka-shell-topbar-rail" data-maka-contract="shell-topbar-rail" role="group" aria-label={copy.windowActions}>
      <Tooltip content={copy.searchConversations}>
        <IconButton
          label={copy.searchConversations}
          icon={<ChromeIcon icon={Search} />}
          variant="ghost"
          size="md"
          className="maka-titlebar-action"
          data-maka-search-trigger="true"
          onClick={props.onOpenSearchModal}
        />
      </Tooltip>
      {!props.sidebarToggleHidden && (
      <Tooltip content={props.sidebarCollapsed ? copy.expandSidebar : copy.collapseSidebar}>
        <SideNavCollapseButton
          handleRef={props.sidebarHandleRef}
          label={props.sidebarCollapsed ? copy.expandSidebar : copy.collapseSidebar}
          className="maka-titlebar-action"
          aria-expanded={!props.sidebarCollapsed}
        >
          {props.sidebarCollapsed ? (
            <ChromeIcon icon={PanelLeftOpen} />
          ) : (
            <ChromeIcon icon={PanelLeftClose} />
          )}
        </SideNavCollapseButton>
      </Tooltip>
      )}
      {/* Collapsed "new task" lives on the SideNav rail (SessionSidebarNav),
          not here — a third titlebar button duplicated the rail icon and made
          left-cluster width state-dependent for drag-region math. */}
    </div>
  );
}

/**
 * The titlebar's right edge.
 *
 * It used to also carry a `…` menu holding 问题反馈 / 打开命令面板 / 打开帮助 /
 * 打开健康中心 — a drawer of four things that each belong somewhere else.
 * 健康中心 was a duplicate of the Settings nav entry, 问题反馈 only opened
 * Settings → 关于, and the other two now have real homes: the keyboard sheet is
 * a row on 关于, and the palette keeps ⌘K, which that sheet documents.
 *
 * What is left is the workbar toggle, and only while the workbar is closed —
 * open, the toggle lives in the workbar's own tab row, beside the thing it
 * closes. So this bar renders nothing at all rather than holding an empty
 * no-drag rectangle open in the titlebar.
 */
export function AppShellWorkspaceTopActions(props: {
  workbarAvailable: boolean;
  workbarCollapsed: boolean;
  onToggleWorkbar(): void;
}) {
  const locale = useUiLocale();
  const copy = getShellCopy(locale).chrome;
  // Open, the toggle is the workbar's own; closed, this is the only way back.
  if (!props.workbarAvailable || !props.workbarCollapsed) return null;

  return (
    <div className="maka-workspace-top-actions" role="toolbar" aria-label={copy.workspaceActions}>
      <Tooltip content={copy.expandWorkbar}>
        <IconButton
          label={copy.expandWorkbar}
          icon={<ChromeIcon icon={PanelRightOpen} />}
          variant="ghost"
          size="md"
          className="maka-titlebar-action"
          onClick={props.onToggleWorkbar}
          aria-expanded={false}
        />
      </Tooltip>
    </div>
  );
}
