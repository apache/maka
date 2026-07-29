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
  Button as UiButton,
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useUiLocale,
} from '@maka/ui';
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
    <div className="maka-shell-topbar-rail" aria-label={copy.windowActions}>
      <Tooltip>
        <TooltipTrigger
          render={<UiButton variant="quiet" size="icon-sm" />}
          type="button"
          className="maka-titlebar-action"
          data-maka-search-trigger="true"
          onClick={props.onOpenSearchModal}
          aria-label={copy.searchConversations}
        >
          <Search aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>{copy.searchConversations}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={<UiButton variant="quiet" size="icon-sm" />}
          type="button"
          className="maka-titlebar-action"
          onClick={props.sidebarCollapsed ? props.onExpandSidebar : props.onCollapseSidebar}
          aria-label={props.sidebarCollapsed ? copy.expandSidebar : copy.collapseSidebar}
          aria-expanded={!props.sidebarCollapsed}
        >
          {props.sidebarCollapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
        </TooltipTrigger>
        <TooltipContent>{props.sidebarCollapsed ? copy.expandSidebar : copy.collapseSidebar}</TooltipContent>
      </Tooltip>
      {props.sidebarCollapsed && (
        <Tooltip>
          <TooltipTrigger
            render={<UiButton variant="quiet" size="icon-sm" />}
            type="button"
            className="maka-titlebar-action"
            onClick={props.onCreateSession}
            aria-label={copy.newTask}
          >
            <SquarePen aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent>{copy.newTask}</TooltipContent>
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
      <Menu>
        <MenuTrigger
          render={<UiButton variant="quiet" size="icon-sm" />}
          type="button"
          className="maka-titlebar-action"
          aria-label={copy.moreActions}
        >
          <MoreHorizontal aria-hidden="true" />
        </MenuTrigger>
        <MenuPopup align="end" sideOffset={4}>
          <MenuItem onClick={props.onOpenFeedback}>
            <MessageCircleQuestion aria-hidden="true" />
            <span>{copy.feedback}</span>
          </MenuItem>
          <MenuItem onClick={props.onOpenPalette}>
            <Grid3X3 aria-hidden="true" />
            <span>{copy.openCommandPalette}</span>
          </MenuItem>
          <MenuItem onClick={props.onOpenHelp}>
            <HelpCircle aria-hidden="true" />
            <span>{copy.openHelp}</span>
          </MenuItem>
          <MenuItem onClick={props.onOpenHealth}>
            <CircleGauge aria-hidden="true" />
            <span>{copy.openHealth}</span>
          </MenuItem>
        </MenuPopup>
      </Menu>
      {props.workbarAvailable && (
        <Tooltip>
          <TooltipTrigger
            render={<UiButton variant="quiet" size="icon-sm" />}
            type="button"
            className="maka-titlebar-action"
            onClick={props.onToggleWorkbar}
            aria-label={workbarLabel}
            aria-expanded={!props.workbarCollapsed}
          >
            {props.workbarCollapsed ? <PanelRightOpen aria-hidden="true" /> : <PanelRightClose aria-hidden="true" />}
          </TooltipTrigger>
          <TooltipContent>{workbarLabel}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
