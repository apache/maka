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

import {
  cleanup,
  computed,
  effect,
  keymap,
  platform,
  signal,
  Text,
  View,
  Scroll,
  windowSize,
} from 'nsh';
import type { JSX, ViewRef } from 'nsh';
import { Button, Popover } from 'nsh/base';
import { Icon } from './Icon';
import { ModalDialog, DialogHeader, DialogFooter } from './ModalDialog';
import {
  SettingsBody,
  SettingsSection,
  SettingsRow,
  SettingsButton,
  SettingsInput,
  SettingsTextArea,
  SettingsSelect,
  SettingsDiscard,
  SettingsFormFooter,
  settingsInset,
} from './SettingsPage';
import type { SettingsPageInput } from '../../../../packages/plugin-sdk/src/workbench-views';
import { createSettingsDiscard } from './settingsDiscard';
import { tr } from './locale';
import {
  C,
  captionTextStyle,
  codeTextStyle,
  controlStyle,
  toolbarControlStyle,
  controlDisabledStyle,
  floatingStyle,
  menuDetailTextStyle,
  menuLabelStyle,
  menuRowStyle,
  menuRowHoverStyle,
  menuSeparatorStyle,
  quietActiveStyle,
  quietFocusStyle,
  textTooltip,
} from './ui';
import type { UiContext } from '../../../../packages/plugin-sdk/src/workbench';
import type { Host, Input, Output } from './host';
import { createProjectActions } from './projectActionsState';
import type { ActionDefinition, ProjectActionsModel } from './projectActionsState';
import { renderText } from './text';

const desktop = platform.idiom !== 'terminal';
const actionButtonStyle = {
  ...toolbarControlStyle,
  flexDirection: 'row',
  alignItems: 'center',
  gap: 4,
} as const;
const actionButtonStates = () => ({
  hoverStyle: { backgroundColor: C.surface },
  activeStyle: { backgroundColor: C.line },
  focusStyle: quietFocusStyle(),
  disabledStyle: controlDisabledStyle,
});
export function ProjectActions(props: {
  model: ProjectActionsModel;
  ready(): boolean;
  lastUsedActionId(): string | null | undefined;
  configure(): void;
}) {
  const model = props.model;
  const adding = signal<ReturnType<ProjectActionsModel['directory']>>(null);
  effect(() => {
    const target = adding();
    if (target && target !== model.directory()) adding.set(null);
  });
  const selected = computed(() => {
    const definitions = model.definitions();
    if (!definitions.length) return undefined;
    const lastUsed = props.lastUsedActionId();
    if (!lastUsed) return definitions[0];
    return definitions.find((definition) => definition.id === lastUsed) ?? definitions[0];
  });
  const canLaunch = () => props.ready() && model.ready();
  const empty = () => model.empty() && model.ready() && !model.problem().message;
  const addButton = () => (
    <Button
      accessibilityLabel={tr('Add Action')}
      onPress={() => adding.set(model.directory())}
      style={desktop ? { ...menuRowStyle(), paddingVertical: 4 } : actionButtonStyle}
      {...actionButtonStates()}
      hoverStyle={desktop ? { backgroundColor: C.cardRaised } : { backgroundColor: C.surface }}
      activeStyle={desktop ? quietActiveStyle() : { backgroundColor: C.line }}
    >
      <Icon name="plus" color={C.muted} size={desktop ? 14 : 16} />
      <Text style={{ ...captionTextStyle, color: C.secondary }}>{tr('Add Action')}</Text>
    </Button>
  );
  return (
    <>
      <If when={!model.loading()}>
        {desktop ? (
          <>
            <View style={{ paddingHorizontal: 12, paddingVertical: 12, gap: 4 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 24, gap: 8 }}>
                <Text
                  style={{ ...menuDetailTextStyle, fontWeight: '500', color: C.muted, flex: 1 }}
                >
                  {tr('Project Actions')}
                </Text>
                <If when={!empty()}>
                  <Button
                    accessibilityLabel={tr('Manage Actions…')}
                    tooltip={textTooltip(() => tr('Manage Actions…'))}
                    onPress={props.configure}
                    style={{
                      ...controlStyle,
                      width: 24,
                      minHeight: 24,
                      height: 24,
                      paddingHorizontal: 0,
                      paddingVertical: 0,
                      alignItems: 'center',
                    }}
                    hoverStyle={{ backgroundColor: C.cardRaised }}
                    activeStyle={quietActiveStyle()}
                    focusStyle={quietFocusStyle()}
                  >
                    <Icon name="settings" size={14} color={C.muted} />
                  </Button>
                </If>
              </View>
              <View style={{ marginHorizontal: -8 }}>
                <If
                  when={empty()}
                  else={
                    <>
                      <ActionProblem model={model} />
                      <ActionRows
                        model={model}
                        canLaunch={canLaunch}
                        run={(definition) => void model.activate(definition)}
                      />
                    </>
                  }
                >
                  {addButton()}
                </If>
              </View>
            </View>
            <View style={{ height: 1, backgroundColor: C.line, marginHorizontal: 12 }} />
          </>
        ) : (
          <If
            when={empty()}
            else={
              <View
                style={{ flexDirection: 'row', alignItems: 'center', minWidth: 0, flexShrink: 1 }}
              >
                <If when={selected()}>
                  {(definition) => (
                    <>
                      <Button
                        accessibilityLabel={tr('Run current Action {name}', {
                          name: definition().name,
                        })}
                        tooltip={textTooltip(() => definition().name)}
                        onPress={() => void model.activate(definition())}
                        disabled={props.lastUsedActionId() === undefined || !canLaunch()}
                        style={{ ...actionButtonStyle, maxWidth: 200, minWidth: 32, flexShrink: 1 }}
                        {...actionButtonStates()}
                      >
                        <Icon name="play" color={C.muted} size={16} />
                        <Text
                          style={[
                            { ...captionTextStyle, color: C.secondary, flexShrink: 1, minWidth: 0 },
                            { numberOfLines: 1, textOverflow: 'ellipsis' },
                          ]}
                        >
                          {definition().name}
                        </Text>
                      </Button>
                      <Text style={{ ...captionTextStyle, color: C.line, flexShrink: 0 }}>│</Text>
                    </>
                  )}
                </If>
                <ActionsMenu
                  model={model}
                  arrowOnly={!!selected()}
                  canLaunch={canLaunch}
                  configure={props.configure}
                />
              </View>
            }
          >
            {addButton()}
          </If>
        )}
      </If>
      <If when={adding()}>
        {(target) => (
          <AddActionDialog model={model} path={target().path} close={() => adding.set(null)} />
        )}
      </If>
    </>
  );
}

function ActionRows(props: {
  model: ProjectActionsModel;
  canLaunch(): boolean;
  run(definition: ActionDefinition): void;
}) {
  const hover = () => (desktop ? { backgroundColor: C.cardRaised } : menuRowHoverStyle());
  return (
    <Each of={props.model.definitions()} key={(definition) => definition.id}>
      {(definition) => (
        <Button
          onPress={() => props.run(definition())}
          disabled={!props.canLaunch()}
          accessibilityLabel={tr('Run Action {name}', { name: definition().name })}
          tooltip={desktop ? textTooltip(() => definition().command) : undefined}
          style={{ ...menuRowStyle(), paddingVertical: 4 }}
          hoverStyle={hover()}
          focusStyle={desktop ? quietFocusStyle() : hover()}
          activeStyle={desktop ? quietActiveStyle() : hover()}
          disabledStyle={controlDisabledStyle}
        >
          <Icon name="play" color={desktop ? C.muted : C.secondary} size={desktop ? 14 : 16} />
          <View style={[{ flex: 1, minWidth: 0, gap: 2 }, { pointerEvents: 'none' }]}>
            <Text
              style={[
                { ...captionTextStyle, color: C.text },
                { numberOfLines: 1, textOverflow: 'ellipsis' },
              ]}
            >
              {definition().name}
            </Text>
            <Text
              style={[
                { ...codeTextStyle, ...menuDetailTextStyle, color: C.muted },
                { numberOfLines: 1, textOverflow: 'ellipsis' },
              ]}
            >
              {definition().command}
            </Text>
          </View>
        </Button>
      )}
    </Each>
  );
}

function ActionsMenu(props: {
  model: ProjectActionsModel;
  arrowOnly: boolean;
  canLaunch(): boolean;
  configure(): void;
}) {
  const model = props.model;
  const open = signal(false);
  return (
    <Popover
      open={open()}
      onOpenChange={({ open: next }) => open.set(next)}
      placement="bottom"
      align="end"
      offset={4}
      margin={8}
      style={{ flexShrink: 0 }}
      popupStyle={{
        ...floatingStyle(),
        width: 336,
        maxHeight: Math.max(0, windowSize().height - 64),
      }}
      trigger={
        <Button
          accessibilityLabel={tr('Actions')}
          tooltip={textTooltip(() => (open() ? undefined : tr('Actions')))}
          style={{
            ...actionButtonStyle,
            backgroundColor: open() ? C.card : undefined,
          }}
          {...actionButtonStates()}
        >
          <If when={!props.arrowOnly}>
            <Icon name="play" color={C.muted} size={16} />
            <Text style={{ ...captionTextStyle, color: C.secondary }}>{tr('Project Action')}</Text>
          </If>
          <Icon name="down" color={C.muted} size={16} />
        </Button>
      }
    >
      <Text style={[menuLabelStyle(), { numberOfLines: 2, textOverflow: 'ellipsis' }]}>
        {model.directory()?.path ?? tr('Select a directory')}
      </Text>
      <Scroll style={{ minHeight: 0, maxHeight: 320, flexShrink: 1 }}>
        <ActionProblem model={model} />
        <ActionRows
          model={model}
          canLaunch={props.canLaunch}
          run={(definition) => {
            open.set(false);
            void model.activate(definition);
          }}
        />
        <If when={model.empty()}>
          <Text style={{ ...captionTextStyle, color: C.muted, padding: 8 }}>
            {tr('No Actions')}
          </Text>
        </If>
      </Scroll>
      <View style={menuSeparatorStyle()} />
      <Button
        accessibilityLabel={tr('Manage Actions…')}
        onPress={() => {
          open.set(false);
          props.configure();
        }}
        style={menuRowStyle()}
        hoverStyle={menuRowHoverStyle()}
        focusStyle={menuRowHoverStyle()}
        activeStyle={menuRowHoverStyle()}
      >
        <Icon name="settings" color={C.secondary} />
        <Text style={{ ...captionTextStyle, color: C.text }}>{tr('Manage Actions…')}</Text>
      </Button>
    </Popover>
  );
}
function ActionProblem(props: { model: ProjectActionsModel }) {
  return (
    <>
      <If when={props.model.problem().message}>
        {(diagnostic) => (
          <Text style={{ ...captionTextStyle, color: C.danger, padding: 8 }}>{diagnostic()}</Text>
        )}
      </If>
      <If when={props.model.problem().retry}>
        {(retry) => (
          <SettingsButton
            label={renderText(retry().label)}
            onPress={() => void retry().run()}
            disabled={!retry().enabled}
          />
        )}
      </If>
    </>
  );
}
function ActionFields(props: {
  name: string;
  command: string;
  disabled: boolean;
  changeName(value: string): void;
  changeCommand(value: string): void;
}) {
  return (
    <View style={{ gap: 16 }}>
      <SettingsSection>
        <SettingsInput
          label={tr('Action name')}
          value={props.name}
          change={props.changeName}
          disabled={props.disabled}
          autoFocus
        />
      </SettingsSection>
      <SettingsSection title={tr('Action command')}>
        <SettingsTextArea
          label={tr('Action command')}
          value={props.command}
          change={props.changeCommand}
          disabled={props.disabled}
          monospace
          lines={4}
        />
      </SettingsSection>
    </View>
  );
}

function AddActionDialog(props: { model: ProjectActionsModel; path: string; close(): void }) {
  const model = props.model;
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const name = signal('');
  const command = signal('');
  const dismiss = () => {
    model.dismissError();
    props.close();
  };
  const discarding = createSettingsDiscard(() => !!(name() || command()), dismiss);
  const cancel = () => {
    if (!model.performing() && !discarding.back()) dismiss();
  };
  const canSave = () =>
    !discarding.asking() && model.ready() && !!name().trim() && !!command().trim();
  const save = async () => {
    if (!canSave()) return;
    await model.save(null, name(), command(), () => {
      if (alive) props.close();
    });
  };
  const form = signal<ViewRef | null>(null);
  effect(() => {
    const node = form();
    if (node) return keymap.bind('mod+enter', () => void save(), { when: 'always', within: node });
  });
  return (
    <ModalDialog size="form" onCancel={cancel}>
      <If
        when={!discarding.asking()}
        else={
          <>
            <DialogHeader title={tr('Discard unsaved changes?')} detail={name()} />
            <DialogFooter>
              <SettingsButton label={tr('Keep editing')} tone="quiet" onPress={discarding.keep} />
              <SettingsButton
                label={tr('Discard changes')}
                tone="danger"
                onPress={discarding.discard}
              />
            </DialogFooter>
          </>
        }
      >
        <View ref={(node) => form.set(node)} style={{ gap: 16, minHeight: 0, flexShrink: 1 }}>
          <DialogHeader title={tr('Add Action')} detail={props.path} />
          <Scroll style={{ minHeight: 0, flexShrink: 1 }}>
            <ActionFields
              name={name()}
              command={command()}
              disabled={!model.ready()}
              changeName={(value) => name.set(value)}
              changeCommand={(value) => command.set(value)}
            />
            <ActionProblem model={model} />
          </Scroll>
          <DialogFooter>
            <SettingsFormFooter
              saveLabel={tr('Save')}
              canSave={canSave()}
              busy={model.performing()}
              save={() => void save()}
              cancel={cancel}
            />
          </DialogFooter>
        </View>
      </If>
    </ModalDialog>
  );
}

function ProjectActionEditor(props: {
  model: ProjectActionsModel;
  project: JSX.Element;
  editing?(value: boolean): void;
  settings?: SettingsPageInput['settings'];
}) {
  const model = props.model;
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const editor = signal<{
    original: ActionDefinition | null;
    name: string;
    command: string;
  } | null>(null);
  const removing = signal<{ original: ActionDefinition } | null>(null);
  const discarding = createSettingsDiscard(
    () => {
      const draft = editor();
      return (
        !!draft &&
        (draft.name !== (draft.original?.name ?? '') ||
          draft.command !== (draft.original?.command ?? ''))
      );
    },
    () => {
      removing.set(null);
      editor.set(null);
    },
  );
  if (props.settings)
    cleanup(
      props.settings.attach({
        title: () => {
          const draft = editor();
          if (!draft) return tr('Project Actions');
          return tr(draft.original ? 'Edit Action' : 'Add Action');
        },
        nested: () => editor() !== null,
        navigation: () =>
          discarding.asking()
            ? 'discard'
            : removing()
              ? 'remove'
              : editor()
                ? 'edit'
                : 'project-actions',
        busy: model.performing,
        leave: discarding.leave,
        back() {
          if (removing() && !discarding.asking()) removing.set(null);
          else if (discarding.back()) return false;
          else if (editor()) editor.set(null);
          else return true;
          return false;
        },
      }),
    );
  effect(() => props.editing?.(editor() !== null || removing() !== null));
  cleanup(() => props.editing?.(false));
  const disabled = () => !model.ready();
  const save = async () => {
    const draft = editor();
    if (!draft) return;
    await model.save(draft.original, draft.name, draft.command, () => {
      if (alive && editor() === draft) {
        discarding.keep();
        editor.set(null);
      }
    });
  };
  const remove = async () => {
    const confirmation = removing();
    const draft = editor();
    if (!confirmation) return;
    await model.remove(confirmation.original, () => {
      if (alive && removing() === confirmation && editor() === draft) {
        discarding.keep();
        removing.set(null);
        editor.set(null);
      }
    });
  };
  return (
    <If
      when={!discarding.asking()}
      else={
        <SettingsDiscard
          name={editor()?.name}
          onDiscard={discarding.discard}
          onKeep={discarding.keep}
        />
      }
    >
      <SettingsBody
        footerShown={editor() !== null}
        footer={
          <If
            when={removing()}
            else={
              <If when={editor()}>
                {(draft) => (
                  <SettingsFormFooter
                    saveLabel={tr('Save')}
                    canSave={!disabled() && !!draft().name.trim() && !!draft().command.trim()}
                    busy={model.performing()}
                    save={() => void save()}
                    cancel={() => discarding.leave(() => editor.set(null))}
                    extra={
                      <If when={draft().original}>
                        {(original) => (
                          <SettingsButton
                            label={tr('Delete')}
                            tone="danger"
                            disabled={disabled()}
                            onPress={() => removing.set({ original: original() })}
                          />
                        )}
                      </If>
                    }
                  />
                )}
              </If>
            }
          >
            <SettingsButton label={tr('Cancel')} tone="quiet" onPress={() => removing.set(null)} />
            <SettingsButton
              label={tr('Delete')}
              tone="danger"
              disabled={disabled()}
              onPress={() => void remove()}
            />
          </If>
        }
      >
        {props.project}
        <If when={!editor() && !removing() && model.directory()}>
          <SettingsSection
            title={tr('Actions')}
            trailing={
              <SettingsButton
                label={tr('Add Action')}
                icon="plus"
                disabled={disabled()}
                onPress={() => editor.set({ original: null, name: '', command: '' })}
              />
            }
          >
            <Each of={model.definitions()} key={(definition) => definition.id}>
              {(definition) => (
                <SettingsRow
                  label={definition().name}
                  detail={
                    <Text
                      style={[
                        { ...codeTextStyle, color: C.muted },
                        { numberOfLines: 2, textOverflow: 'ellipsis' },
                      ]}
                    >
                      {definition().command}
                    </Text>
                  }
                  opens
                  disabled={disabled()}
                  onPress={() =>
                    editor.set({
                      original: definition(),
                      name: definition().name,
                      command: definition().command,
                    })
                  }
                />
              )}
            </Each>
            <If when={model.loading()}>
              <SettingsRow label={tr('Loading…')} tone="muted" />
            </If>
            <If when={model.ready() && model.empty()}>
              <SettingsRow label={tr('No Actions')} tone="muted" />
            </If>
          </SettingsSection>
        </If>
        <If when={removing() ? null : editor()}>
          {(draft) => (
            <ActionFields
              name={draft().name}
              command={draft().command}
              disabled={disabled()}
              changeName={(name) => editor.set({ ...draft(), name })}
              changeCommand={(command) => editor.set({ ...draft(), command })}
            />
          )}
        </If>
        <If when={removing()}>
          {(confirmation) => (
            <View style={{ paddingHorizontal: settingsInset }}>
              <DialogHeader
                title={tr('Delete Action {name}?', { name: confirmation().original.name })}
              />
            </View>
          )}
        </If>
        <ActionProblem model={model} />
      </SettingsBody>
    </If>
  );
}

export function ProjectActionsSettings(props: {
  context: UiContext;
  host: Host;
  initialProjectId?: string;
  settings?: SettingsPageInput['settings'];
}) {
  type ProjectChoice = { value: string; title: string; path: string };
  const initialProjectId = props.initialProjectId;
  const selected = signal<ProjectChoice | null>(null);
  const editing = signal(false);
  const choices = signal<ProjectChoice[]>([]);
  const projects = signal<{ kind: 'loading' | 'ready' } | { kind: 'failed'; reason: string }>({
    kind: 'loading',
  });
  const model = createProjectActions(props.context, props.host, () => {
    const project = selected();
    return project ? { kind: 'project', projectId: project.value, path: project.path } : null;
  });
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const loadProjects = async () => {
    projects.set({ kind: 'loading' });
    try {
      type Projects = Extract<Output<'agent', 'projects'>, { kind: 'projects' }>;
      let cursor: Projects['next'] = null;
      const available: ProjectChoice[] = [];
      do {
        const input: Input<'agent', 'projects'> = { kind: 'list', cursor };
        const page: Output<'agent', 'projects'> = await props.host.query(
          'agent',
          'projects',
          input,
        );
        if (page.kind !== 'projects') throw new Error(tr('Could not load projects.'));
        for (const project of page.projects) {
          if (project.available && project.path && !project.archived)
            available.push({
              value: project.reference.id,
              title: project.name,
              path: project.path,
            });
        }
        cursor = page.next;
      } while (cursor !== null && alive);
      if (!alive) return;
      choices.set(available);
      const initial =
        initialProjectId === undefined
          ? available[0]
          : available.find((project) => project.value === initialProjectId);
      selected.set(initial ?? null);
      projects.set({ kind: 'ready' });
    } catch (reason) {
      if (alive)
        projects.set({
          kind: 'failed',
          reason: reason instanceof Error ? reason.message : String(reason),
        });
    }
  };
  void loadProjects();
  const projectReadError = () => {
    const state = projects();
    return state.kind === 'failed' ? state.reason : undefined;
  };
  return (
    <ProjectActionEditor
      model={model}
      editing={(value) => editing.set(value)}
      settings={props.settings}
      project={
        <SettingsSection>
          <If when={projects().kind === 'loading'}>
            <SettingsRow label={tr('Loading…')} tone="muted" />
          </If>
          <If when={projectReadError()}>
            {(reason) => (
              <SettingsRow
                label={tr('Could not load projects.')}
                description={reason()}
                trailing={
                  <SettingsButton label={tr('Retry')} onPress={() => void loadProjects()} />
                }
              />
            )}
          </If>
          <If when={projects().kind === 'ready'}>
            <If when={editing() ? selected() : null}>
              {(project) => (
                <SettingsRow
                  label={tr('Project: {name}', { name: project().title })}
                  description={project().path}
                />
              )}
            </If>
            <If when={!editing()}>
              <SettingsSelect
                label={tr('Choose a project')}
                detailBelowLabel
                value={selected()?.value ?? null}
                choices={choices().map((project) => ({ ...project, detail: project.path }))}
                change={(value) =>
                  selected.set(choices().find((project) => project.value === value) ?? null)
                }
                disabled={model.performing() || !choices().length}
              />
              <If when={!selected()}>
                <SettingsRow
                  label={tr(
                    initialProjectId === undefined
                      ? 'No available projects'
                      : 'The conversation project is unavailable.',
                  )}
                  tone="muted"
                />
              </If>
            </If>
          </If>
        </SettingsSection>
      }
    />
  );
}
