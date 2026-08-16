import type { ProjectRecord } from '@maka/core/project';
import { DropdownMenu, DropdownMenuItem } from '@astryxdesign/core/DropdownMenu';
import { ICON_SIZE, AlertTriangle, Check, FolderOpen, Network, Plus, RefreshCcw, X } from './icons.js';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';

export interface WorkspacePickerGroup {
  id: string;
  label: string;
  status?: string;
  disabled?: boolean;
  projects: readonly ProjectRecord[];
  selectedProjectId?: string | null;
  onSelectProject?(projectId: string): void;
  onAdd?(): void;
  onRelink?(projectId: string): void;
  onSelectNoProject?(): void;
}

export interface WorkspacePickerModel {
  label?: string;
  hostBadge?: string;
  branch?: string | null;
  pending?: boolean;
  selectedGroupId?: string;
  groups: readonly WorkspacePickerGroup[];
  retry?: { label: string; onClick(): void };
}

export function WorkspacePicker({ workspacePicker: picker }: {
  workspacePicker: WorkspacePickerModel;
}) {
  const copy = getConversationCopy(useUiLocale()).workspace;
  const locked = picker.pending === true;
  const selectedGroup = picker.groups.find((group) => group.id === picker.selectedGroupId);

  return (
    <DropdownMenu
      placement="above"
      hasChevron={false}
      className="maka-composer-quiet-menu"
      button={{
        label: picker.label ?? copy.choose,
        icon: <FolderOpen size={ICON_SIZE.meta} aria-hidden="true" />,
        variant: 'ghost',
        size: 'sm',
        isDisabled: locked,
        isLoading: locked,
        tooltip: copy.chooseTitle(picker.branch ?? undefined),
        className: 'maka-workspace-picker',
        endContent: picker.hostBadge ? (
          <span className="maka-workspace-picker-host-badge">
            <Network size={ICON_SIZE.meta} aria-hidden="true" />
            <span>{picker.hostBadge}</span>
          </span>
        ) : undefined,
        'aria-label': copy.chooseAriaLabel(
          picker.hostBadge
            ? `${picker.hostBadge} · ${picker.label ?? copy.current}`
            : picker.label ?? copy.current,
          picker.branch ?? undefined,
        ),
      }}
    >
      {picker.groups.length > 0 ? <div className="maka-workspace-picker-scroll">
        {picker.groups.map((group) => {
          const projects = group.projects.filter(
            (project) => project.archivedAt === undefined,
          );
          const emptyUnselectedGroup =
            group.id !== picker.selectedGroupId && projects.length === 0;
          return (
            <div
              key={group.id}
              role="group"
              aria-label={group.label}
              className="maka-workspace-picker-group"
            >
              <div className="maka-workspace-picker-group-label">
                <span>{group.label}</span>
                {group.status ? <span>{group.status}</span> : null}
              </div>
              {projects.map((project) => {
              const missing = !project.available;
              return (
                <DropdownMenuItem
                  key={project.id}
                  icon={missing
                    ? <AlertTriangle size={ICON_SIZE.meta} aria-hidden="true" />
                    : <FolderOpen size={ICON_SIZE.meta} aria-hidden="true" />}
                  label={project.name}
                  endContent={missing
                    ? (
                        <span className="maka-workspace-picker-status">
                          {group.onRelink ? copy.relink : copy.unavailable}
                        </span>
                      )
                    : picker.selectedGroupId === group.id &&
                        project.id === group.selectedProjectId
                      ? <Check size={ICON_SIZE.control} aria-hidden="true" />
                      : undefined}
                  onClick={() => {
                    if (missing) group.onRelink?.(project.id);
                    else group.onSelectProject?.(project.id);
                  }}
                  isDisabled={
                    locked ||
                    group.disabled ||
                    (!missing && !group.onSelectProject) ||
                    (missing && !group.onRelink)
                  }
                />
              );
              })}
              {emptyUnselectedGroup && group.onAdd ? (
                <DropdownMenuItem
                  icon={<Plus size={ICON_SIZE.meta} aria-hidden="true" />}
                  label={copy.addProject}
                  isDisabled={locked || group.disabled}
                  onClick={group.onAdd}
                />
              ) : null}
              {emptyUnselectedGroup && group.onSelectNoProject ? (
                <DropdownMenuItem
                  icon={<X size={ICON_SIZE.meta} aria-hidden="true" />}
                  label={copy.noProject}
                  isDisabled={locked || group.disabled}
                  onClick={group.onSelectNoProject}
                />
              ) : null}
            </div>
          );
        })}
      </div> : null}
      {selectedGroup?.onAdd || selectedGroup?.onSelectNoProject || picker.retry ? (
        <div role="group" className="maka-workspace-picker-actions">
          {selectedGroup?.onAdd ? (
            <DropdownMenuItem
              icon={<Plus size={ICON_SIZE.meta} aria-hidden="true" />}
              label={copy.addProject}
              isDisabled={locked || selectedGroup.disabled}
              onClick={selectedGroup.onAdd}
            />
          ) : null}
          {selectedGroup?.onSelectNoProject ? (
            <DropdownMenuItem
              icon={<X size={ICON_SIZE.meta} aria-hidden="true" />}
              label={copy.noProject}
              endContent={selectedGroup.selectedProjectId === null
                ? <Check size={ICON_SIZE.control} aria-hidden="true" />
                : undefined}
              isDisabled={locked || selectedGroup.disabled}
              onClick={selectedGroup.onSelectNoProject}
            />
          ) : null}
          {picker.retry ? (
            <DropdownMenuItem
              icon={<RefreshCcw size={ICON_SIZE.meta} aria-hidden="true" />}
              label={picker.retry.label}
              isDisabled={locked}
              onClick={picker.retry.onClick}
            />
          ) : null}
        </div>
      ) : null}
    </DropdownMenu>
  );
}
