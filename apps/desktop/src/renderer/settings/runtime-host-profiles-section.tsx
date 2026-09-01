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

import { useCallback, useEffect, useState } from "react";
import {
  Banner,
  HStack,
  List,
  ListItem,
  SegmentedControl,
  SegmentedControlItem,
  Switch,
  Tooltip,
} from "@astryxdesign/core";
import type {
  DesktopLocalRuntimeHostRemoteAccessSnapshot,
  DesktopRuntimeHostPeerMeshTarget,
} from '../../preload/bridge-contract.js';
import type {
  RuntimeHostPeerConnectionPath,
  RuntimeHostRemoteTransport,
} from "@maka/runtime-host/client";
import { isCanonicalRuntimeHostWebSocketPath } from "@maka/runtime-host/protocol";
import {
  Badge,
  Button,
  MoreMenu,
  Selector,
  TextInput,
  useMountedRef,
  useToast,
  useUiLocale,
} from "@maka/ui";
import { Cpu, ICON_SIZE } from "@maka/ui/icons";
import { getSettingsProjectsCopy } from "../locales/settings-projects-copy.js";
import { PasswordInput } from "./password-input.js";
import { settingsActionErrorMessage } from "./settings-error-copy.js";
import { SettingsField, SettingsRow, SettingsSection } from "./settings-section.js";
import { RuntimeHostOnboardingDialog } from './runtime-host-onboarding-dialog.js';
import {
  RuntimeHostManagementDialog,
  type RuntimeHostManagementTarget,
} from './runtime-host-management-dialog.js';
import { RuntimeHostConnectionCodeDialog } from './runtime-host-connection-code-dialog.js';
import {
  PeerMeshPeerIdButton,
  RuntimeHostPairingRecoveryButton,
  RuntimeHostPeerMeshDialog,
  RuntimeHostProfileMoreMenu,
  type RuntimeHostPairingActionCopy,
} from '../features/runtime-host-management';
import { SessionCollaborationJoinDialog } from '../features/session-collaboration';
import { getSessionCollaborationCopy } from '../locales/session-collaboration-copy.js';

type RemoteTransportKind = RuntimeHostRemoteTransport["kind"];

function createRemoteHostDraft() {
  return {
    id: `remote-${crypto.randomUUID()}`,
    name: "",
    transportKind: "tls" as RemoteTransportKind,
    url: "",
    destination: "",
    sshPort: "",
    remotePort: "",
    websocketPath: "/runtime-host",
    plaintextAcknowledged: false,
    rootId: "",
    credential: "",
  };
}

export function RuntimeHostProfilesSection(props: {
  readonly onRemoteHostAdded: (profileId: string) => void;
}) {
  const locale = useUiLocale();
  const copy = getSettingsProjectsCopy(locale).runtimeHost;
  const pairingActionCopy: RuntimeHostPairingActionCopy = {
    retry: copy.resolvePairingRecovery,
    retryFailed: copy.resolvePairingRecoveryFailed,
    discard: copy.discardPairing,
    discardConfirmTitle: copy.discardPairingConfirmTitle,
    discardConfirmBody: copy.discardPairingConfirmBody,
    discardFailed: copy.discardPairingFailed,
    cancel: copy.cancel,
  };
  const collaborationCopy = getSessionCollaborationCopy(locale);
  const mountedRef = useMountedRef();
  const toast = useToast();
  const [snapshot, setSnapshot] = useState<
    Awaited<ReturnType<typeof window.maka.runtimeHostProfiles.getSnapshot>>
  >();
  const [showAdd, setShowAdd] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showJoinSharedSession, setShowJoinSharedSession] = useState(false);
  const [managedTarget, setManagedTarget] = useState<RuntimeHostManagementTarget>();
  const [localAccess, setLocalAccess] = useState<DesktopLocalRuntimeHostRemoteAccessSnapshot>();
  const [connectionCodeDialog, setConnectionCodeDialog] = useState<
    | { readonly mode: 'import' }
    | {
        readonly mode: 'share';
        readonly connectionCode: string;
        readonly openManagementOnClose?: true;
      }
  >();
  const [peerMeshTarget, setPeerMeshTarget] = useState<{
    readonly target: DesktopRuntimeHostPeerMeshTarget;
    readonly name: string;
  }>();

  const [switching, setSwitching] = useState(false);
  const [draft, setDraft] = useState(createRemoteHostDraft);

  const reload = useCallback(async () => {
    const [next, nextLocalAccess] = await Promise.all([
      window.maka.runtimeHostProfiles.getSnapshot(),
      window.maka.localRuntimeHostRemoteAccess.getSnapshot(),
    ]);
    if (mountedRef.current) {
      setSnapshot(next);
      setLocalAccess(nextLocalAccess);
    }
  }, [mountedRef]);

  useEffect(() => {
    void reload().catch((error) =>
      toast.error(copy.loadFailed, settingsActionErrorMessage(error, locale)),
    );
    return window.maka.runtimeHostProfiles.subscribeChanges(() => void reload());
  }, [copy.loadFailed, locale, reload, toast]);

  async function setDefault(profileId: string) {
    setSwitching(true);
    try {
      const next = await window.maka.runtimeHostProfiles.setDefault(profileId);
      if (!mountedRef.current) return;
      setSnapshot(next);
    } catch (error) {
      if (mountedRef.current) {
        await reload().catch(() => undefined);
        toast.error(
          copy.selectFailed,
          settingsActionErrorMessage(error, locale),
          undefined,
          { profileId },
        );
      }
    } finally {
      if (mountedRef.current) setSwitching(false);
    }
  }

  function toggleAdd() {
    if (!showAdd) setDraft(createRemoteHostDraft());
    setShowAdd((value) => !value);
  }

  async function saveAndEnable() {
    setSwitching(true);
    const profileId = draft.id;
    try {
      const transport = createTransport(draft);
      const result = await window.maka.runtimeHostProfiles.addAndEnable({
        profile: {
          id: draft.id,
          name: draft.name,
          kind: "remote",
          transport,
          rootId: draft.rootId,
        },
        credential: draft.credential,
      });
      if (!mountedRef.current) return;
      setSnapshot(result.snapshot);
      if (result.kind === "unavailable") {
        toast.error(
          copy.selectFailed,
          result.message,
          undefined,
          { profileId },
        );
        return;
      }
      setShowAdd(false);
      setDraft(createRemoteHostDraft());
    } catch (error) {
      if (mountedRef.current) {
        await reload().catch(() => undefined);
        toast.error(
          copy.saveFailed,
          settingsActionErrorMessage(error, locale),
          undefined,
          { profileId },
        );
      }
    } finally {
      if (mountedRef.current) setSwitching(false);
    }
  }

  async function remove(profileId: string) {
    try {
      const next = await window.maka.runtimeHostProfiles.remove(profileId);
      if (mountedRef.current) setSnapshot(next);
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          copy.removeFailed,
          settingsActionErrorMessage(error, locale),
          undefined,
          { profileId },
        );
      }
    }
  }

  async function setEnabled(profileId: string, enabled: boolean) {
    setSwitching(true);
    try {
      const next = await window.maka.runtimeHostProfiles.setEnabled(profileId, enabled);
      if (!mountedRef.current) return;
      setSnapshot(next);
      const entry = next.entries.find((candidate) => candidate.profile.id === profileId);
      if (entry?.readiness === "unavailable" && entry.message) {
        toast.error(
          copy.selectFailed,
          entry.message,
          undefined,
          { profileId },
        );
      }
    } catch (error) {
      if (mountedRef.current) {
        await reload().catch(() => undefined);
        toast.error(
          copy.selectFailed,
          settingsActionErrorMessage(error, locale),
          undefined,
          { profileId },
        );
      }
    } finally {
      if (mountedRef.current) setSwitching(false);
    }
  }

  async function enableLocalRemoteAccess(allowInterruptActiveTasks = false): Promise<void> {
    setSwitching(true);
    try {
      const result = await window.maka.localRuntimeHostRemoteAccess.enable({
        allowInterruptActiveTasks,
        coordinationRelays: [],
      });
      if (result.kind === 'enabled') {
        setConnectionCodeDialog({
          mode: 'share',
          connectionCode: result.connectionCode,
          openManagementOnClose: true,
        });
      }
      if (!mountedRef.current) return;
      if (result.kind === 'active_tasks') {
        const confirmed = await toast.confirm({
          title: copy.remoteAccessActiveTasks,
          description: copy.remoteAccessActiveTasksDescription,
          confirmLabel: copy.interruptAndEnable,
          cancelLabel: copy.cancel,
          destructive: true,
        });
        if (confirmed) await enableLocalRemoteAccess(true);
        return;
      }
      setLocalAccess(result.snapshot);
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          copy.remoteAccessFailed,
          settingsActionErrorMessage(error, locale),
        );
      }
    } finally {
      if (mountedRef.current) setSwitching(false);
    }
  }

  async function createLocalConnectionCode(): Promise<void> {
    setSwitching(true);
    try {
      const code = await window.maka.localRuntimeHostRemoteAccess.createConnectionCode();
      if (mountedRef.current) setConnectionCodeDialog({ mode: 'share', connectionCode: code });
    } catch (error) {
      if (mountedRef.current) {
        toast.error(copy.remoteAccessFailed, settingsActionErrorMessage(error, locale));
      }
    } finally {
      if (mountedRef.current) setSwitching(false);
    }
  }

  async function disableLocalRemoteAccess(): Promise<void> {
    const confirmed = await toast.confirm({
      title: copy.disableRemoteAccessConfirm,
      description: copy.disableRemoteAccessDescription,
      confirmLabel: copy.disableRemoteAccess,
      cancelLabel: copy.cancel,
    });
    if (!confirmed) return;
    setSwitching(true);
    try {
      const next = await window.maka.localRuntimeHostRemoteAccess.disable();
      if (mountedRef.current) setLocalAccess(next);
    } catch (error) {
      if (mountedRef.current) {
        toast.error(copy.remoteAccessFailed, settingsActionErrorMessage(error, locale));
      }
    } finally {
      if (mountedRef.current) setSwitching(false);
    }
  }

  async function revokeLocalSharedAccess(): Promise<void> {
    const confirmed = await toast.confirm({
      title: copy.revokeSharedAccessConfirm,
      description: copy.revokeSharedAccessDescription,
      confirmLabel: copy.revokeSharedAccess,
      cancelLabel: copy.cancel,
      destructive: true,
    });
    if (!confirmed) return;
    setSwitching(true);
    try {
      const next = await window.maka.localRuntimeHostRemoteAccess.revokeSharedAccess();
      if (mountedRef.current) {
        setLocalAccess(next);
        toast.success(copy.revokeSharedAccessDone);
      }
    } catch (error) {
      if (mountedRef.current) {
        toast.error(copy.remoteAccessFailed, settingsActionErrorMessage(error, locale));
      }
    } finally {
      if (mountedRef.current) setSwitching(false);
    }
  }

  const connectedEntries = snapshot?.entries.filter((entry) => entry.profile.kind !== 'local') ?? [];
  const localProfile = snapshot?.entries.find((entry) => entry.profile.kind === 'local')?.profile;
  const localManagementTarget = localProfile
    ? {
        id: localProfile.id,
        name: localProfile.name,
        scope: 'full' as const,
        directPeerManagement: false,
      }
    : undefined;
  const profileOptions = (snapshot?.entries ?? [])
    .filter((entry) => entry.enabled)
    .map((entry) => ({
      value: entry.profile.id,
      label: entry.profile.name,
    }));

  return (
    <>
      <SettingsSection title={copy.title} description={copy.description}>
        <SettingsRow
          label={copy.selected}
          description={copy.selectedHelp}
          end={<HStack gap={2} align="center">
            <Selector
              label={copy.selected}
              isLabelHidden
              value={snapshot?.defaultProfileId ?? "local"}
              isDisabled={!snapshot || switching}
              options={profileOptions}
              onChange={(value) => void setDefault(value)}
            />
          </HStack>}
        />
        <SettingsRow
          label={copy.thisComputerRemoteAccess}
          description={
            localAccess?.state === 'unsupported'
              ? localAccess.message
              : localAccess?.state === 'unavailable'
                ? localAccess.message
                : copy.thisComputerRemoteAccessHelp
          }
          end={(
            <HStack gap={2} align="center">
              <Badge
                variant="neutral"
                label={localAccess?.state === 'on' ? copy.remoteAccessOn : copy.remoteAccessOff}
              />
              {localManagementTarget && localAccess?.managedService ? (
                <Button
                  variant="secondary"
                  size="sm"
                  label={copy.manage}
                  isDisabled={switching}
                  onClick={() => setManagedTarget(localManagementTarget)}
                />
              ) : null}
              {localAccess?.state === 'on' ? (
                <MoreMenu
                  label={copy.thisComputerRemoteAccess}
                  size="sm"
                  items={[
                    {
                      label: copy.createConnectionCode,
                      isDisabled: switching,
                      onClick: () => void createLocalConnectionCode(),
                    },
                    ...(localAccess.sharedAccess
                      ? [{
                          label: copy.revokeSharedAccess,
                          isDisabled: switching,
                          onClick: () => void revokeLocalSharedAccess(),
                        }]
                      : []),
                    {
                      label: copy.disableRemoteAccess,
                      isDisabled: switching,
                      onClick: () => void disableLocalRemoteAccess(),
                    },
                  ]}
                />
              ) : (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    label={copy.enableRemoteAccess}
                    isDisabled={
                      switching ||
                      !localAccess ||
                      localAccess.state === 'unsupported'
                    }
                    onClick={() => void enableLocalRemoteAccess()}
                  />
                  {localAccess?.state === 'off' && localAccess.managedService ? (
                    <MoreMenu
                      label={copy.thisComputerRemoteAccess}
                      size="sm"
                      items={[
                        ...(localAccess.sharedAccess
                          ? [{
                              label: copy.revokeSharedAccess,
                              isDisabled: switching,
                              onClick: () => void revokeLocalSharedAccess(),
                            }]
                          : []),
                      ]}
                    />
                  ) : null}
                </>
              )}
            </HStack>
          )}
        />
        <SettingsRow
          label={copy.peerMesh}
          description={copy.peerMeshHelp}
          end={(
            <Button
              variant="secondary"
              size="sm"
              label={copy.managePeerMesh}
              isDisabled={switching}
              onClick={() => setPeerMeshTarget({
                target: { kind: 'desktop' },
                name: 'Local',
              })}
            />
          )}
        />
      </SettingsSection>

      <SettingsSection
        title={copy.remoteTitle}
        description={copy.remoteDescription}
        action={
          <HStack gap={2} align="center">
            <Button
              variant="primary"
              size="sm"
              label={copy.addComputer}
              isDisabled={switching}
              onClick={() => {
                setShowOnboarding(true);
              }}
            />
            <MoreMenu
              label={copy.moreActions(copy.remoteTitle)}
              size="sm"
              items={[
                {
                  label: copy.useConnectionCode,
                  isDisabled: switching,
                  onClick: () => setConnectionCodeDialog({ mode: 'import' }),
                },
                {
                  label: collaborationCopy.joinAction,
                  isDisabled: switching,
                  onClick: () => setShowJoinSharedSession(true),
                },
                {
                  label: showAdd ? copy.cancel : copy.configureManually,
                  isDisabled: switching,
                  onClick: toggleAdd,
                },
              ]}
            />
          </HStack>
        }
      >
        {snapshot?.pairingRecoveryBlocked || snapshot?.pairingRecoveryPending ? (
          <SettingsRow
            label={copy.pairingRecoveryTitle}
            description={copy.pairingRecoveryDescription}
            end={(
              <RuntimeHostPairingRecoveryButton
                isDisabled={switching}
                copy={pairingActionCopy}
                errorMessage={(error) => settingsActionErrorMessage(error, locale)}
                onChanged={() => void reload()}
                onWorkingChange={setSwitching}
              />
            )}
          />
        ) : null}
        {showAdd ? (
          <>
            <SettingsRow
              label={copy.name}
              description={copy.nameHelp}
              end={<TextInput label={copy.name} isLabelHidden value={draft.name} onChange={(name) => setDraft((value) => ({ ...value, name }))} />}
            />
            <SettingsField className="settingsRuntimeHostTransportField">
              <fieldset className="settingsRuntimeHostTransport">
                <legend>{copy.transport}</legend>
                <p>{copy.transportHelp}</p>
                <SegmentedControl
                  label={copy.transport}
                  value={draft.transportKind}
                  layout="fill"
                  size="sm"
                  onChange={(transportKind) =>
                    setDraft((value) => ({
                      ...value,
                      transportKind: transportKind as RemoteTransportKind,
                    }))
                  }
                >
                  <SegmentedControlItem value="tls" label={copy.tls} />
                  <SegmentedControlItem value="ssh" label={copy.ssh} />
                  <SegmentedControlItem value="plaintext" label={copy.plaintext} />
                </SegmentedControl>
              </fieldset>
            </SettingsField>
            {draft.transportKind === "ssh" ? (
              <>
                <SettingsRow
                  label={copy.sshDestination}
                  description={copy.sshDestinationHelp}
                  end={<TextInput label={copy.sshDestination} isLabelHidden value={draft.destination} placeholder="user@host.example" onChange={(destination) => setDraft((value) => ({ ...value, destination }))} />}
                />
                <SettingsRow
                  label={copy.sshPort}
                  description={copy.sshPortHelp}
                  end={<TextInput label={copy.sshPort} isLabelHidden value={draft.sshPort} placeholder="22" onChange={(sshPort) => setDraft((value) => ({ ...value, sshPort }))} />}
                />
                <SettingsRow
                  label={copy.remotePort}
                  description={copy.remotePortHelp}
                  end={<TextInput label={copy.remotePort} isLabelHidden value={draft.remotePort} placeholder="8765" onChange={(remotePort) => setDraft((value) => ({ ...value, remotePort }))} />}
                />
                <SettingsRow
                  label={copy.websocketPath}
                  description={copy.websocketPathHelp}
                  end={<TextInput label={copy.websocketPath} isLabelHidden value={draft.websocketPath} placeholder="/runtime-host" onChange={(websocketPath) => setDraft((value) => ({ ...value, websocketPath }))} />}
                />
              </>
            ) : (
              <SettingsRow
                label={draft.transportKind === "tls" ? copy.url : copy.plaintextUrl}
                description={draft.transportKind === "tls" ? copy.urlHelp : copy.plaintextUrlHelp}
                end={<TextInput label={draft.transportKind === "tls" ? copy.url : copy.plaintextUrl} isLabelHidden value={draft.url} placeholder={draft.transportKind === "tls" ? "wss://host.example" : "ws://host.example"} onChange={(url) => setDraft((value) => ({ ...value, url }))} />}
              />
            )}
            {draft.transportKind === "plaintext" ? (
              <>
                <SettingsRow
                  label={copy.plaintextAcknowledgement}
                  description={copy.plaintextAcknowledgementHelp}
                  end={<Switch label={copy.plaintextAcknowledgement} isLabelHidden value={draft.plaintextAcknowledged} onChange={(plaintextAcknowledged) => setDraft((value) => ({ ...value, plaintextAcknowledged }))} />}
                />
                <Banner status="warning" title={copy.plaintextWarning} />
              </>
            ) : null}
            <SettingsRow
              label={copy.rootId}
              description={copy.rootIdHelp}
              end={<TextInput label={copy.rootId} isLabelHidden value={draft.rootId} onChange={(rootId) => setDraft((value) => ({ ...value, rootId }))} />}
            />
            <SettingsRow
              label={copy.credential}
              description={copy.credentialHelp}
              end={<PasswordInput label={copy.credential} isLabelHidden value={draft.credential} onChange={(credential) => setDraft((value) => ({ ...value, credential }))} />}
            />
            <SettingsRow
              label={copy.add}
              end={<Button variant="primary" size="sm" label={copy.saveAndEnable} isDisabled={switching || !draftComplete(draft)} clickAction={saveAndEnable} />}
            />
          </>
        ) : null}
        {connectedEntries.length === 0 && !showAdd ? (
          <SettingsRow label={copy.empty} />
        ) : (
          <List density="balanced" hasDividers aria-label={copy.remoteTitle}>
            {connectedEntries.map((entry) => {
              const profile = entry.profile;
              if (profile.kind === 'local') return null;
              const managementTarget: RuntimeHostManagementTarget | undefined =
                entry.managedService
                  ? profile.kind === 'environment'
                    ? {
                        id: profile.id,
                        name: profile.name,
                        subtitle: profile.provider.distribution,
                        scope: 'project_directories',
                        directPeerManagement: false,
                      }
                    : profile.transport.kind === 'ssh'
                      ? {
                          id: profile.id,
                          name: profile.name,
                          subtitle: profile.transport.destination,
                          scope: 'full',
                          directPeerManagement: true,
                        }
                      : undefined
                  : undefined;
              return (
                <ListItem
                  key={profile.id}
                  label={profile.name}
                  description={
                    profile.kind === 'environment'
                      ? profile.provider.distribution
                      : profile.transport.kind === "ssh"
                        ? profile.transport.destination
                        : profile.transport.kind === "libp2p-direct"
                          ? (
                              <PeerMeshPeerIdButton
                                peerId={profile.transport.peerId}
                                displayValue={abbreviatePeerId(profile.transport.peerId)}
                                copyLabel={locale.startsWith('zh')
                                  ? `复制完整 Peer ID：${profile.transport.peerId}`
                                  : `Copy full Peer ID: ${profile.transport.peerId}`}
                                copiedTitle={locale.startsWith('zh') ? 'Peer ID 已复制' : 'Peer ID copied'}
                                failedTitle={locale.startsWith('zh') ? '无法复制 Peer ID' : 'Could not copy Peer ID'}
                                errorMessage={(error) => settingsActionErrorMessage(error, locale)}
                                className="settingsRuntimeHostPeerId"
                              />
                            )
                          : profile.transport.url
                  }
                  startContent={<Cpu size={ICON_SIZE.control} aria-hidden="true" />}
                  endContent={
                    <HStack gap={2} align="center">
                      {entry.isDefault ? (
                        <Badge variant="neutral" label={copy.defaultBadge} />
                      ) : null}
                      {profile.kind === 'remote' && profile.transport.kind === 'libp2p-direct' ? (
                        <Badge variant="warning" label={copy.experimentalBadge} />
                      ) : null}
                      {entry.pairingPending ? (
                        <Badge variant="warning" label={copy.pairingPendingBadge} />
                      ) : null}
                      {entry.readiness === "unavailable" ? (
                        <Badge variant="neutral" label={copy.unavailable} />
                      ) : null}
                      {entry.peerPath ? (
                        <Tooltip content={peerPathDetail(entry.peerPath, locale)}>
                          <span>
                            <Badge
                              variant="neutral"
                              label={entry.peerPath.kind === 'direct'
                                ? (locale.startsWith('zh') ? '直连' : 'Direct')
                                : (locale.startsWith('zh') ? '成员转发' : 'Member transit')}
                            />
                          </span>
                        </Tooltip>
                      ) : null}
                      <Switch
                        label={profile.name}
                        isLabelHidden
                        value={entry.enabled}
                        isDisabled={switching || entry.isDefault || entry.pairingPending}
                        disabledMessage={entry.pairingPending
                          ? copy.pairingRecoveryDescription
                          : entry.isDefault
                            ? copy.defaultDisableHelp
                            : undefined}
                        onChange={(enabled) => void setEnabled(profile.id, enabled)}
                      />
                      <RuntimeHostProfileMoreMenu
                        label={copy.moreActions(profile.name)}
                        profileId={profile.id}
                        pairingPending={entry.pairingPending === true}
                        isDisabled={switching}
                        copy={pairingActionCopy}
                        errorMessage={(error) => settingsActionErrorMessage(error, locale)}
                        onChanged={() => void reload()}
                        onWorkingChange={setSwitching}
                        items={[
                          ...(managementTarget && !entry.pairingPending
                            ? [{
                                label: copy.manage,
                                isDisabled: switching,
                                onClick: () => setManagedTarget(managementTarget),
                              }, ...(managementTarget.directPeerManagement
                                ? [{
                                    label: copy.managePeerMesh,
                                    isDisabled: switching,
                                    onClick: () => setPeerMeshTarget({
                                      target: { kind: 'managed_host', profileId: profile.id },
                                      name: profile.name,
                                    }),
                                  }]
                                : [])]
                            : []),
                          {
                            label: copy.remove,
                            isDisabled:
                              switching ||
                              entry.enabled ||
                              entry.isDefault,
                            onClick: () => void remove(profile.id),
                          },
                        ]}
                      />
                    </HStack>
                  }
                />
              );
            })}
          </List>
        )}
      </SettingsSection>
      <RuntimeHostOnboardingDialog
        isOpen={showOnboarding}
        onClose={() => {
          setShowOnboarding(false);
          void reload();
        }}
        onRemoteHostAdded={props.onRemoteHostAdded}
      />
      <RuntimeHostManagementDialog
        key={managedTarget ? `profile:${managedTarget.id}` : 'no-profile'}
        target={managedTarget}
        onClose={() => {
          setManagedTarget(undefined);
          void reload();
        }}
        onManagePeerMesh={(target) => {
          setManagedTarget(undefined);
          setPeerMeshTarget({
            target: { kind: 'managed_host', profileId: target.id },
            name: target.name,
          });
        }}
      />
      {peerMeshTarget ? (
        <RuntimeHostPeerMeshDialog
          target={peerMeshTarget.target}
          targetName={peerMeshTarget.name}
          offerLocalHost={
            peerMeshTarget.target.kind === 'desktop' && localAccess?.state === 'on'
          }
          onClose={() => setPeerMeshTarget(undefined)}
        />
      ) : null}
      {connectionCodeDialog?.mode === 'import' ? (
        <RuntimeHostConnectionCodeDialog
          mode="import"
          onClose={() => setConnectionCodeDialog(undefined)}
          onImported={(profileId) => {
            props.onRemoteHostAdded(profileId);
            void reload();
          }}
        />
      ) : connectionCodeDialog ? (
        <RuntimeHostConnectionCodeDialog
          mode="share"
          connectionCode={connectionCodeDialog.connectionCode}
          onClose={() => {
            const openManagement = connectionCodeDialog.openManagementOnClose;
            setConnectionCodeDialog(undefined);
            if (openManagement && localManagementTarget) {
              setManagedTarget(localManagementTarget);
            }
          }}
        />
      ) : null}
      {showJoinSharedSession ? (
        <SessionCollaborationJoinDialog
          copy={collaborationCopy}
          onClose={() => setShowJoinSharedSession(false)}
          onImported={() => {
            void reload();
          }}
        />
      ) : null}
    </>
  );
}

function peerPathDetail(
  path: RuntimeHostPeerConnectionPath,
  locale: string,
): string {
  if (path.kind === 'transit') {
    return locale.startsWith('zh')
      ? `成员转发 · ${abbreviatePeerId(path.relayPeerId)}`
      : `Member transit · ${abbreviatePeerId(path.relayPeerId)}`;
  }
  const transport = path.transport === 'webrtc'
    ? 'WebRTC'
    : path.transport === 'quic'
      ? 'QUIC'
      : path.transport === 'tcp'
        ? 'TCP'
        : locale.startsWith('zh')
          ? '其他'
          : 'Other';
  return `${locale.startsWith('zh') ? '直连' : 'Direct'} · ${transport}`;
}

function abbreviatePeerId(peerId: string): string {
  return peerId.length <= 20 ? peerId : `${peerId.slice(0, 10)}…${peerId.slice(-6)}`;
}

function createTransport(draft: ReturnType<typeof createRemoteHostDraft>): RuntimeHostRemoteTransport {
  if (draft.transportKind === "tls") return { kind: "tls", url: draft.url };
  if (draft.transportKind === "plaintext") {
    return {
      kind: "plaintext",
      url: draft.url,
      acknowledgement: "plaintext-bearer-v1",
    };
  }
  return {
    kind: "ssh",
    destination: draft.destination,
    ...(draft.sshPort.trim() ? { sshPort: Number(draft.sshPort) } : {}),
    remotePort: Number(draft.remotePort),
    websocketPath: draft.websocketPath,
  };
}

function draftComplete(draft: ReturnType<typeof createRemoteHostDraft>): boolean {
  if ([draft.name, draft.rootId, draft.credential].some((value) => !value.trim())) return false;
  if (draft.transportKind === "ssh") {
    return Boolean(
      draft.destination.trim() &&
      validPort(draft.remotePort) &&
      validWebSocketPath(draft.websocketPath) &&
      (!draft.sshPort.trim() || validPort(draft.sshPort)),
    );
  }
  return Boolean(
    draft.url.trim() &&
    (draft.transportKind !== "plaintext" || draft.plaintextAcknowledged),
  );
}

function validPort(value: string): boolean {
  const port = Number(value);
  return value.trim() !== "" && Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function validWebSocketPath(value: string): boolean {
  return isCanonicalRuntimeHostWebSocketPath(value);
}
