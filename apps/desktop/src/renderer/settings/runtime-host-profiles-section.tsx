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
import type { RuntimeHostRemoteTransport } from "@maka/runtime-host/client";
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

export function RuntimeHostProfilesSection() {
  const locale = useUiLocale();
  const copy = getSettingsProjectsCopy(locale).runtimeHost;
  const mountedRef = useMountedRef();
  const toast = useToast();
  const [snapshot, setSnapshot] = useState<
    Awaited<ReturnType<typeof window.maka.runtimeHostProfiles.getSnapshot>>
  >();
  const [showAdd, setShowAdd] = useState(false);
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
  }, [copy.loadFailed, locale, reload, toast]);

  async function select(profileId: string) {
    setSwitching(true);
    try {
      const next = await window.maka.runtimeHostProfiles.select(profileId);
      if (!mountedRef.current) return;
      setSnapshot(next);
      if (next.unavailable?.profileId === profileId) {
        toast.error(copy.selectFailed, next.unavailable.message);
      }
    } catch (error) {
      if (mountedRef.current) {
        await reload().catch(() => undefined);
        toast.error(copy.selectFailed, settingsActionErrorMessage(error, locale));
      }
    } finally {
      if (mountedRef.current) setSwitching(false);
    }
  }

  function toggleAdd() {
    if (!showAdd) setDraft(createRemoteHostDraft());
    setShowAdd((value) => !value);
  }

  async function saveAndConnect() {
    setSwitching(true);
    try {
      const transport = createTransport(draft);
      const result = await window.maka.runtimeHostProfiles.addAndSelect({
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
        toast.error(copy.selectFailed, result.message);
        return;
      }
      if (result.warning) toast.warning(copy.selectionNotSaved, result.warning);
      setShowAdd(false);
      setDraft(createRemoteHostDraft());
    } catch (error) {
      if (mountedRef.current) {
        await reload().catch(() => undefined);
        toast.error(copy.saveFailed, settingsActionErrorMessage(error, locale));
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
        toast.error(copy.removeFailed, settingsActionErrorMessage(error, locale));
      }
    }
  }

  const remoteProfiles = snapshot?.profiles.filter((profile) => profile.kind === "remote") ?? [];
  const profileOptions = (snapshot?.profiles ?? []).map((profile) => ({
    value: profile.id,
    label: profile.name,
  }));
  if (
    snapshot &&
    !profileOptions.some((option) => option.value === snapshot.selectedProfileId)
  ) {
    profileOptions.push({
      value: snapshot.selectedProfileId,
      label: `${snapshot.selectedProfileId} (${copy.unavailable})`,
    });
  }

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
              value={snapshot?.selectedProfileId ?? "local"}
              isDisabled={!snapshot || switching}
              options={profileOptions}
              onChange={(value) => void select(value)}
            />
            {snapshot && snapshot.activeProfileId !== snapshot.selectedProfileId ? (
              <Button
                variant="secondary"
                size="sm"
                label={copy.connect}
                isDisabled={switching}
                onClick={() => void select(snapshot.selectedProfileId)}
              />
            ) : null}
          </HStack>}
        />
      </SettingsSection>

      <SettingsSection
        title={copy.remoteTitle}
        description={copy.remoteDescription}
        action={
          <Button
            variant="secondary"
            size="sm"
            label={showAdd ? copy.cancel : copy.add}
            isDisabled={switching}
            onClick={toggleAdd}
          />
        }
      >
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
              end={<Button variant="primary" size="sm" label={copy.saveAndConnect} isDisabled={switching || !draftComplete(draft)} clickAction={saveAndConnect} />}
            />
          </>
        ) : null}
        {remoteProfiles.length === 0 && !showAdd ? (
          <SettingsRow label={copy.empty} />
        ) : (
          <List density="balanced" hasDividers aria-label={copy.remoteTitle}>
            {remoteProfiles.map((profile) => (
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
                    {snapshot?.activeProfileId === profile.id ? <Badge variant="neutral" label={copy.active} /> : null}
                    {snapshot?.unavailable?.profileId === profile.id ? <Badge variant="neutral" label={copy.unavailable} /> : null}
                    <MoreMenu
                      label={copy.moreActions(profile.name)}
                      size="sm"
                      items={[{
                        label: copy.remove,
                        isDisabled:
                          switching ||
                          snapshot?.activeProfileId === profile.id ||
                          snapshot?.selectedProfileId === profile.id,
                        onClick: () => void remove(profile.id),
                      }]}
                    />
                  </HStack>
                }
              />
            ))}
          </List>
        )}
      </SettingsSection>
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
  return value.startsWith("/") && !value.includes("?") && !value.includes("#");
}
