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
  SquarePen,
} from '@maka/ui/icons';
import {
  IconButton,
  useUiLocale,
} from '@maka/ui';
import {
  DropdownMenu,
  DropdownMenuItem,
} from '@astryxdesign/core/DropdownMenu';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import {
  SideNavCollapseButton,
  type SideNavImperativeCollapseHandle,
} from '@astryxdesign/core/SideNav';
import { useRef, useState, type RefObject } from 'react';
import { getShellCopy } from './locales/shell-copy';

export function AppShellTopbarActions(props: {
  sidebarCollapsed: boolean;
  sidebarHandleRef: RefObject<SideNavImperativeCollapseHandle | null>;
  onOpenSearchModal(): void;
  onCreateSession(): void;
}) {
  const locale = useUiLocale();
  const copy = getShellCopy(locale).chrome;
  return (
    <div className="maka-shell-topbar-rail" data-maka-contract="shell-topbar-rail" aria-label={copy.windowActions}>
      <Tooltip content={copy.searchConversations}>
        <IconButton
          label={copy.searchConversations}
          icon={<Search aria-hidden="true" />}
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
          {props.sidebarCollapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
        </SideNavCollapseButton>
      </Tooltip>
      {props.sidebarCollapsed && (
        <Tooltip content={copy.newTask}>
          <IconButton
            label={copy.newTask}
            icon={<SquarePen aria-hidden="true" />}
            variant="ghost"
            size="md"
            className="maka-titlebar-action"
            onClick={props.onCreateSession}
          />
        </Tooltip>
      )}
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
          icon: <MoreHorizontal aria-hidden="true" />,
          isIconOnly: true,
          variant: 'ghost',
          size: 'md',
          className: 'maka-titlebar-action',
        }}
      >
          <DropdownMenuItem icon={<MessageCircleQuestion aria-hidden="true" />} label={copy.feedback} onClick={() => scheduleAfterMenuClose(props.onOpenFeedback)} />
          <DropdownMenuItem icon={<Grid3X3 aria-hidden="true" />} label={copy.openCommandPalette} onClick={() => scheduleAfterMenuClose(props.onOpenPalette)} />
          <DropdownMenuItem icon={<HelpCircle aria-hidden="true" />} label={copy.openHelp} onClick={() => scheduleAfterMenuClose(props.onOpenHelp)} />
          <DropdownMenuItem icon={<CircleGauge aria-hidden="true" />} label={copy.openHealth} onClick={() => scheduleAfterMenuClose(props.onOpenHealth)} />
      </DropdownMenu>
      {props.workbarAvailable && (
        <Tooltip content={workbarLabel}>
          <IconButton
            label={workbarLabel}
            icon={props.workbarCollapsed ? <PanelRightOpen aria-hidden="true" /> : <PanelRightClose aria-hidden="true" />}
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
