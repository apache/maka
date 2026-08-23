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

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettings, UpdateAppSettingsResult } from '@maka/core/settings';
import type { ProjectRecord } from '@maka/core/project';
import type { DesktopProjectCapabilities } from '../../preload/bridge-contract.js';
import {
  Badge,
  Banner,
  Button,
  EmptyState,
  MoreMenu,
  TextInput,
  useMountedRef,
  useToast,
  useUiLocale,
} from '@maka/ui';
import { HStack, List, ListItem } from '@astryxdesign/core';
import { ICON_SIZE, FolderOpen } from '@maka/ui/icons';
import { getSettingsProjectsCopy } from '../locales/settings-projects-copy.js';
import { projectPathDisplay } from '../project-path-display.js';
import { settingsActionErrorMessage } from './settings-error-copy';
import { SettingsPage, SettingsSection } from './settings-section';
import { RuntimeHostProfilesSection } from './runtime-host-profiles-section.js';
import { useKeyedActionGuard } from './use-action-guard';
import { useOptionalRuntimeHostSettingsTarget } from './runtime-host-settings-target.js';
import { getSettingsSharedCopy } from '../locales/settings-shared-copy.js';
import { RemoteProjectDirectoryDialog } from '../remote-project-directory-dialog.js';

const NO_PROJECT_CAPABILITIES: DesktopProjectCapabilities = {
  chooseClientDirectory: false,
  chooseHostDirectory: false,
  selectNoProject: false,
  setLocalDefault: false,
  viewClientPath: false,
};

/**
 * Settings · 偏好 · 项目 — the management view of the project catalog, and the
 * home of the default project.
 *
 * Project management used to be scattered across the surfaces that happened to
 * need it: adding lived in the composer, renaming in the sidebar row menu, and
 * "which project does a new chat open in" was not a setting at all — it was
 * whichever project you used last, decided implicitly by
 * `project-root-controller` and invisible to the user.
 *
 * This page does not own a second copy of that data. The catalog behind
 * `window.maka.projects` is the same one the sidebar groups by and the composer
 * picker chooses from; what this page adds is a preference stored beside it.
 */
export function ProjectsSettingsPage(props: {
  settings: AppSettings;
  runtimeHostStatus: 'loading' | 'ready' | 'unavailable' | 'error';
  onUpdate(
    patch: Parameters<typeof window.maka.settings.update>[0],
  ): Promise<UpdateAppSettingsResult>;
  onRetryRuntimeHost(): Promise<void>;
  onRemoteHostAdded(profileId: string): void;
}) {
  const host = useOptionalRuntimeHostSettingsTarget();
  const locale = useUiLocale();
  const copy = getSettingsProjectsCopy(locale);
  const sharedCopy = getSettingsSharedCopy(locale);
  const toast = useToast();
  const mountedRef = useMountedRef();
  const actionGuard = useKeyedActionGuard<string>();
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [capabilities, setCapabilities] =
    useState<DesktopProjectCapabilities>(NO_PROJECT_CAPABILITIES);
  const [homePath, setHomePath] = useState<string | undefined>(undefined);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const directoryPickerTriggerRef = useRef<HTMLButtonElement>(null);
  const reloadGeneration = useRef(0);

  const reload = useCallback(async () => {
    if (!host) return;
    const generation = ++reloadGeneration.current;
    const snapshot = await window.maka.projects.getSnapshot(undefined, host);
    if (mountedRef.current && generation === reloadGeneration.current) {
      setProjects([...snapshot.projects]);
      setCapabilities(snapshot.capabilities);
    }
  }, [host, mountedRef]);

  useEffect(() => {
    if (!host) {
      setProjects([]);
      setCapabilities(NO_PROJECT_CAPABILITIES);
      setHomePath(undefined);
      return;
    }
    let cancelled = false;
    setHomePath(undefined);
    void reload();
    const unsubscribeProjects = window.maka.projects.subscribeChanges(
      () => void reload(),
      undefined,
      host,
    );
    const unsubscribeHosts = window.maka.runtimeHostProfiles.subscribeChanges(() => void reload());
    void window.maka.app.info(host).then(
      (info) => {
        if (!cancelled && mountedRef.current) setHomePath(info.homePath);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
      unsubscribeProjects();
      unsubscribeHosts();
    };
  }, [reload, mountedRef]);

  // Archived projects are removed-from-Maka, not deleted; they belong to the
  // restore path, not to a list whose whole purpose is "what can I open".
  const listed = projects.filter((project) => project.archivedAt === undefined);
  const defaultProjectId = capabilities.setLocalDefault
    ? props.settings.projects.defaultProjectId
    : undefined;
  // The stored id is a preference, not a guarantee: the project it names can be
  // archived or lose its folder afterwards. Saying so out loud beats silently
  // behaving like no default was ever set — a silent fallback is the same kind
  // of lie as a control that claims a state it does not have.
  const defaultResolves =
    defaultProjectId !== undefined &&
    listed.some((project) => project.id === defaultProjectId && project.available);
  const diagnosticTarget = host ? { profileId: host.profileId } : undefined;

  async function runRowAction(
    key: string,
    action: () => Promise<void>,
    failure: string,
  ) {
    const release = actionGuard.begin(key);
    if (!release) return;
    try {
      try {
        await action();
      } catch (error) {
        if (mountedRef.current) {
          toast.error(
            failure,
            settingsActionErrorMessage(error, locale),
            undefined,
            diagnosticTarget,
          );
        }
        return;
      }
      try {
        await reload();
      } catch (error) {
        if (mountedRef.current) {
          toast.error(
            failure,
            settingsActionErrorMessage(error, locale),
            undefined,
            diagnosticTarget,
          );
        }
      }
    } finally {
      release();
    }
  }

  async function setDefault(projectId: string | undefined) {
    await props.onUpdate({ projects: { defaultProjectId: projectId } });
  }

  if (!host) {
    return (
      <SettingsPage as="section" aria-label={copy.section}>
        <RuntimeHostProfilesSection onRemoteHostAdded={props.onRemoteHostAdded} />
        <Banner
          status={props.runtimeHostStatus === 'error' ? 'error' : 'warning'}
          title={props.runtimeHostStatus === 'loading'
            ? sharedCopy.loading
            : sharedCopy.runtimeHostUnavailable}
          endContent={props.runtimeHostStatus === 'error' ? (
            <Button
              variant="secondary"
              size="sm"
              label={sharedCopy.retry}
              onClick={() => void props.onRetryRuntimeHost()}
            />
          ) : undefined}
        />
      </SettingsPage>
    );
  }
  return (
    <SettingsPage as="section" aria-label={copy.section}>
      <RuntimeHostProfilesSection onRemoteHostAdded={props.onRemoteHostAdded} />
      {/* No section title: the page header already says 项目, and repeating it
          straight above the rows is the same duplicate-heading noise we
          removed from the skills page. The rule this page exists for lives in
          the page subtitle; the section keeps only its action. */}
      <SettingsSection
        description={
          defaultProjectId !== undefined && !defaultResolves
            ? `${copy.sectionHelp} ${copy.defaultUnavailable}`
            : copy.sectionHelp
        }
        action={capabilities.chooseClientDirectory || capabilities.chooseHostDirectory ? (
          <Button
            ref={directoryPickerTriggerRef}
            variant="secondary"
            size="sm"
            label={copy.addProject}
            clickAction={capabilities.chooseHostDirectory
              ? () => setDirectoryPickerOpen(true)
              : async () => {
                  const result = await window.maka.projects.add(host);
                  if (result.ok) await reload();
                }}
          />
        ) : undefined}
      >
        {listed.length === 0 ? (
          <EmptyState icon={<FolderOpen size={ICON_SIZE.empty} />} title={copy.emptyTitle} description={copy.emptyBody} />
        ) : (
          // A project is an entity, not a preference, so it belongs in the
          // entity-list carrier the MCP and skills pages already use — real
          // list semantics, real dividers, and a leading slot for the icon
          // that gives each row something to hang on. Built out of settings
          // rows first, the page was four paragraphs of text in a column.
          (<List density="balanced" hasDividers aria-label={copy.section}>
            {listed.map((project) => {
              const isDefault = project.id === defaultProjectId;
              const endCluster = (
                    <>
                      {capabilities.setLocalDefault && isDefault ? (
                        <Badge variant="neutral" label={copy.defaultBadge} />
                      ) : capabilities.setLocalDefault ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          label={copy.setDefault}
                          // A disabled control explains its own disabling:
                          // the enabled tooltip answers "what does this do",
                          // which is exactly the question the user is NOT
                          // asking once the button is greyed out.
                          tooltip={
                            project.available
                              ? copy.setDefaultTitle
                              : copy.setDefaultDisabledTitle
                          }
                          isDisabled={!project.available}
                          clickAction={() =>
                            runRowAction(
                              `default:${project.id}`,
                              () => setDefault(project.id),
                              copy.setDefaultFailed,
                            )
                          }
                        />
                      ) : null}
                      <MoreMenu
                        label={copy.moreActions(project.name)}
                        size="sm"
                        items={[
                          ...(isDefault
                            ? [{
                                label: copy.clearDefault,
                                onClick: () =>
                                  void runRowAction(
                                    `default:${project.id}`,
                                    () => setDefault(undefined),
                                    copy.setDefaultFailed,
                                  ),
                              }]
                            : []),
                          {
                            label: copy.rename,
                            onClick: () => {
                              setDraftName(project.name);
                              setRenamingId(project.id);
                            },
                          },
                          ...(capabilities.viewClientPath
                            ? [
                                {
                                  label: copy.openFolder,
                                  // Only offered when the catalog still vouches for the
                                  // folder; a menu entry that always fails is worse
                                  // than one that is not there.
                                  isDisabled: !project.available,
                                  onClick: () =>
                                    void runRowAction(
                                      `reveal:${project.id}`,
                                      async () => {
                                        const result = await window.maka.projects.reveal(
                                          project.id,
                                          host,
                                        );
                                        if (!result.ok) throw new Error(result.reason);
                                      },
                                      copy.openFolderFailed,
                                    ),
                                },
                              ]
                            : []),
                          {
                            label: copy.remove,
                            onClick: () =>
                              void runRowAction(
                                `remove:${project.id}`,
                                async () => {
                                  const ok = await toast.confirm({
                                    title: copy.removeConfirmTitle,
                                    description: copy.removeConfirmBody,
                                    confirmLabel: copy.removeConfirm,
                                    cancelLabel: copy.removeCancel,
                                    destructive: true,
                                  });
                                  if (!ok) return;
                                  await window.maka.projects.archive(project.id, host);
                                  // Removing the default leaves the preference
                                  // pointing at nothing; clear it in the same
                                  // action rather than leaving a dangling id.
                                  if (isDefault) {
                                    try {
                                      await setDefault(undefined);
                                    } catch (error) {
                                      if (mountedRef.current) {
                                        toast.error(
                                          copy.setDefaultFailed,
                                          settingsActionErrorMessage(error, locale),
                                          undefined,
                                          diagnosticTarget,
                                        );
                                      }
                                    }
                                  }
                                },
                                copy.actionFailed,
                              ),
                          },
                        ]}
                      />
                    </>
              );

              const isRenaming = renamingId === project.id;
              const canSave =
                draftName.trim() !== '' && draftName.trim() !== project.name;

              async function saveRename() {
                const next = draftName.trim();
                if (next === '' || next === project.name) return;
                await runRowAction(
                  `rename:${project.id}`,
                  async () => {
                    await window.maka.projects.rename(project.id, next, host);
                    setRenamingId(null);
                  },
                  copy.renameFailed,
                );
              }

              const path = capabilities.viewClientPath && project.preferredPath
                ? projectPathDisplay(project.preferredPath, { homePath })
                : undefined;

              return (
                <ListItem
                  key={project.id}
                  // While renaming, the field and its save/cancel pair share ONE
                  // flex container. Split across label and endContent they
                  // overlapped: the field claims the label slot's full width and
                  // the buttons render on top of its right edge.
                  label={isRenaming ? (
                    <HStack gap={2} align="center">
                    <TextInput
                      type="text"
                      value={draftName}
                      onChange={(value) => setDraftName(value.slice(0, 80))}
                      // Enter saves and Escape backs out: a field that can only
                      // be dismissed by mousing to a button is a trap for anyone
                      // who opened it from the keyboard.
                      onEnter={() => {
                        if (canSave) void saveRename();
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') setRenamingId(null);
                      }}
                      label={copy.renameLabel}
                      isLabelHidden
                      hasAutoFocus
                    />
                      <Button
                        variant="primary"
                        size="sm"
                        isDisabled={!canSave}
                        clickAction={() => saveRename()}
                        label={copy.save}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setRenamingId(null)}
                        label={copy.cancel}
                      />
                    </HStack>
                  ) : project.name}
                  description={isRenaming || (!capabilities.viewClientPath && project.available)
                    ? undefined
                    : (
                    <code
                      className="settingsReadOnlyValue"
                      data-mono="true"
                      // The abbreviated form is what the row shows; the whole
                      // path stays one hover away rather than being lost.
                      title={path?.title}
                    >
                      {path?.text ?? copy.unavailable}
                    </code>
                  )}
                  // No wrapper class: `startContent` already owns the slot's
                  // layout, and the anchor's weight comes from the icon's size
                  // rather than a plate or a second glyph family.
                  startContent={<FolderOpen size={ICON_SIZE.control} aria-hidden="true" />}
                  endContent={isRenaming ? undefined : endCluster}
                />
              );
            })}
          </List>)
        )}
      </SettingsSection>
      <RemoteProjectDirectoryDialog
        host={directoryPickerOpen ? host : undefined}
        returnFocusTo={directoryPickerTriggerRef.current}
        onClose={() => setDirectoryPickerOpen(false)}
        onRegistered={() => {
          setDirectoryPickerOpen(false);
          void reload();
        }}
      />
    </SettingsPage>
  );
}
