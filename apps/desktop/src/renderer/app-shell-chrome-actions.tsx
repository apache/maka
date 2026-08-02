import {
  CircleGauge,
  Grid3X3,
  HelpCircle,
  MessageCircleQuestion,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Search,
} from '@maka/ui/icons';
import {
  IconButton,
  useUiLocale,
} from '@maka/ui';
import {
  DropdownMenu,
  DropdownMenuItem,
} from '@astryxdesign/core/DropdownMenu';
import { Icon } from '@astryxdesign/core/Icon';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import {
  SideNavCollapseButton,
  type SideNavImperativeCollapseHandle,
} from '@astryxdesign/core/SideNav';
import { useRef, useState, type RefObject } from 'react';
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
  onOpenSearchModal(): void;
}) {
  const locale = useUiLocale();
  const copy = getShellCopy(locale).chrome;
  return (
    <div className="maka-shell-topbar-rail" data-maka-contract="shell-topbar-rail" aria-label={copy.windowActions}>
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
      {/* Collapsed "new task" lives on the SideNav rail (SessionSidebarNav),
          not here — a third titlebar button duplicated the rail icon and made
          left-cluster width state-dependent for drag-region math. */}
    </div>
  );
}

export function AppShellWorkspaceTopActions(props: {
  workbarAvailable: boolean;
  workbarCollapsed: boolean;
  onToggleWorkbar(): void;
  onOpenFeedback(): void;
  onOpenPalette(): void;
  onOpenHelp(): void;
  onOpenHealth(): void;
}) {
  const locale = useUiLocale();
  const copy = getShellCopy(locale).chrome;
  const workbarLabel = props.workbarCollapsed ? copy.expandWorkbar : copy.collapseWorkbar;
  const pendingMenuIntentRef = useRef<(() => void) | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const scheduleAfterMenuClose = (intent: () => void) => {
    pendingMenuIntentRef.current = intent;
  };

  return (
    <div className="maka-workspace-top-actions" role="toolbar" aria-label={copy.workspaceActions}>
      <DropdownMenu
        isMenuOpen={menuOpen}
        onOpenChange={(open) => {
          setMenuOpen(open);
          if (open) return;
          const intent = pendingMenuIntentRef.current;
          pendingMenuIntentRef.current = null;
          if (intent) window.requestAnimationFrame(intent);
        }}
        button={{
          label: copy.moreActions,
          icon: <ChromeIcon icon={MoreHorizontal} />,
          isIconOnly: true,
          variant: 'ghost',
          size: 'md',
          className: 'maka-titlebar-action',
        }}
      >
          <DropdownMenuItem icon={<ChromeIcon icon={MessageCircleQuestion} />} label={copy.feedback} onClick={() => scheduleAfterMenuClose(props.onOpenFeedback)} />
          <DropdownMenuItem icon={<ChromeIcon icon={Grid3X3} />} label={copy.openCommandPalette} onClick={() => scheduleAfterMenuClose(props.onOpenPalette)} />
          <DropdownMenuItem icon={<ChromeIcon icon={HelpCircle} />} label={copy.openHelp} onClick={() => scheduleAfterMenuClose(props.onOpenHelp)} />
          <DropdownMenuItem icon={<ChromeIcon icon={CircleGauge} />} label={copy.openHealth} onClick={() => scheduleAfterMenuClose(props.onOpenHealth)} />
      </DropdownMenu>
      {props.workbarAvailable && (
        <Tooltip content={workbarLabel}>
          <IconButton
            label={workbarLabel}
            icon={
              props.workbarCollapsed ? (
                <ChromeIcon icon={PanelRightOpen} />
              ) : (
                <ChromeIcon icon={PanelRightClose} />
              )
            }
            variant="ghost"
            size="md"
            className="maka-titlebar-action"
            onClick={props.onToggleWorkbar}
            aria-expanded={!props.workbarCollapsed}
          />
        </Tooltip>
      )}
    </div>
  );
}
