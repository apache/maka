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
} from "@astryxdesign/core";
import type {
  RemoteRuntimeHostProfile,
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
import { RuntimeHostManagementDialog } from './runtime-host-management-dialog.js';

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
  const mountedRef = useMountedRef();
  const toast = useToast();
  const [snapshot, setSnapshot] = useState<
    Awaited<ReturnType<typeof window.maka.runtimeHostProfiles.getSnapshot>>
  >();
  const [showAdd, setShowAdd] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [managedProfile, setManagedProfile] = useState<RemoteRuntimeHostProfile>();
  const [switching, setSwitching] = useState(false);
  const [draft, setDraft] = useState(createRemoteHostDraft);

  const reload = useCallback(async () => {
    const next = await window.maka.runtimeHostProfiles.getSnapshot();
    if (mountedRef.current) setSnapshot(next);
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

  async function resolvePairingRecovery() {
    setSwitching(true);
    try {
      const next = await window.maka.runtimeHostProfiles.resolvePairingRecovery();
      if (mountedRef.current) setSnapshot(next);
    } catch (error) {
      if (mountedRef.current) {
        toast.error(
          copy.resolvePairingRecoveryFailed,
          settingsActionErrorMessage(error, locale),
        );
      }
    } finally {
      if (mountedRef.current) setSwitching(false);
    }
  }

  const remoteEntries = snapshot?.entries.filter((entry) => entry.profile.kind === "remote") ?? [];
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
            <Button
              variant="secondary"
              size="sm"
              label={showAdd ? copy.cancel : copy.configureManually}
              isDisabled={switching}
              onClick={toggleAdd}
            />
          </HStack>
        }
      >
        {snapshot?.pairingRecoveryBlocked || snapshot?.pairingRecoveryPending ? (
          <SettingsRow
            label={copy.pairingRecoveryTitle}
            description={copy.pairingRecoveryDescription}
            end={(
              <Button
                variant="secondary"
                size="sm"
                label={copy.resolvePairingRecovery}
                isDisabled={switching}
                onClick={() => void resolvePairingRecovery()}
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
        {remoteEntries.length === 0 && !showAdd ? (
          <SettingsRow label={copy.empty} />
        ) : (
          <List density="balanced" hasDividers aria-label={copy.remoteTitle}>
            {remoteEntries.map((entry) => {
              const profile = entry.profile;
              if (profile.kind !== "remote") return null;
              return (
                <ListItem
                  key={profile.id}
                  label={profile.name}
                description={
                  profile.transport.kind === "ssh"
                    ? profile.transport.destination
                    : profile.transport.url
                }
                startContent={<Cpu size={ICON_SIZE.control} aria-hidden="true" />}
                endContent={
                  <HStack gap={2} align="center">
                    {entry.isDefault ? <Badge variant="neutral" label={copy.defaultBadge} /> : null}
                    {entry.readiness === "unavailable" ? <Badge variant="neutral" label={copy.unavailable} /> : null}
                    <Switch
                      label={profile.name}
                      isLabelHidden
                      value={entry.enabled}
                      isDisabled={switching || entry.isDefault}
                      disabledMessage={entry.isDefault ? copy.defaultDisableHelp : undefined}
                      onChange={(enabled) => void setEnabled(profile.id, enabled)}
                    />
                    <MoreMenu
                      label={copy.moreActions(profile.name)}
                      size="sm"
                      items={[
                        ...(profile.transport.kind === "ssh" && entry.managedService
                          ? [{
                              label: copy.manage,
                              isDisabled: switching,
                              onClick: () => setManagedProfile(profile),
                            }]
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
        profile={managedProfile}
        onClose={() => {
          setManagedProfile(undefined);
          void reload();
        }}
      />
    </>
  );
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
