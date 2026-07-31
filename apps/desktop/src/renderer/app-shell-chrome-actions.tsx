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
  Menu,
  MenuItem,
  useUiLocale,
} from '@maka/ui';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { getShellCopy } from './locales/shell-copy';

export function AppShellTopbarActions(props: {
  sidebarCollapsed: boolean;
  onOpenSearchModal(): void;
  onCollapseSidebar(): void;
  onExpandSidebar(): void;
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
          size="sm"
          className="maka-titlebar-action"
          data-maka-search-trigger="true"
          onClick={props.onOpenSearchModal}
        />
      </Tooltip>
      <Tooltip content={props.sidebarCollapsed ? copy.expandSidebar : copy.collapseSidebar}>
        <IconButton
          label={props.sidebarCollapsed ? copy.expandSidebar : copy.collapseSidebar}
          icon={props.sidebarCollapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
          variant="ghost"
          size="sm"
          className="maka-titlebar-action"
          onClick={props.sidebarCollapsed ? props.onExpandSidebar : props.onCollapseSidebar}
          aria-expanded={!props.sidebarCollapsed}
        />
      </Tooltip>
      {props.sidebarCollapsed && (
        <Tooltip content={copy.newTask}>
          <IconButton
            label={copy.newTask}
            icon={<SquarePen aria-hidden="true" />}
            variant="ghost"
            size="sm"
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

  return (
    <div className="maka-workspace-top-actions" role="toolbar" aria-label={copy.workspaceActions}>
      <Menu
        button={{
          label: copy.moreActions,
          icon: <MoreHorizontal aria-hidden="true" />,
          isIconOnly: true,
          variant: 'ghost',
          size: 'sm',
          className: 'maka-titlebar-action',
          style: { borderRadius: 'var(--radius-control)' },
        }}
      >
          <MenuItem icon={<MessageCircleQuestion aria-hidden="true" />} label={copy.feedback} onClick={props.onOpenFeedback} />
          <MenuItem icon={<Grid3X3 aria-hidden="true" />} label={copy.openCommandPalette} onClick={props.onOpenPalette} />
          <MenuItem icon={<HelpCircle aria-hidden="true" />} label={copy.openHelp} onClick={props.onOpenHelp} />
          <MenuItem icon={<CircleGauge aria-hidden="true" />} label={copy.openHealth} onClick={props.onOpenHealth} />
      </Menu>
      {props.workbarAvailable && (
        <Tooltip content={workbarLabel}>
          <IconButton
            label={workbarLabel}
            icon={props.workbarCollapsed ? <PanelRightOpen aria-hidden="true" /> : <PanelRightClose aria-hidden="true" />}
            variant="ghost"
            size="sm"
            className="maka-titlebar-action"
            onClick={props.onToggleWorkbar}
            aria-expanded={!props.workbarCollapsed}
          />
        </Tooltip>
      )}
    </div>
  );
}
