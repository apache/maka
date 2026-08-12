import { useCallback, useEffect, useState } from "react";
import { HStack, List, ListItem } from "@astryxdesign/core";
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
import { SettingsRow, SettingsSection } from "./settings-section.js";

export function RuntimeHostProfilesSection(props: {
  onActiveProfileKind?(kind: "local" | "remote" | undefined): void;
}) {
  const locale = useUiLocale();
  const copy = getSettingsProjectsCopy(locale).runtimeHost;
  const mountedRef = useMountedRef();
  const toast = useToast();
  const [snapshot, setSnapshot] = useState<
    Awaited<ReturnType<typeof window.maka.runtimeHostProfiles.getSnapshot>>
  >();
  const [showAdd, setShowAdd] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [draft, setDraft] = useState({
    id: "",
    name: "",
    url: "",
    rootId: "",
    credential: "",
  });

  const reload = useCallback(async () => {
    const next = await window.maka.runtimeHostProfiles.getSnapshot();
    if (mountedRef.current) setSnapshot(next);
  }, [mountedRef]);

  useEffect(() => {
    void reload().catch((error) =>
      toast.error(copy.loadFailed, settingsActionErrorMessage(error, locale)),
    );
  }, [copy.loadFailed, locale, reload, toast]);

  useEffect(() => {
    props.onActiveProfileKind?.(snapshot?.activeProfile?.kind);
  }, [props.onActiveProfileKind, snapshot]);

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

  async function save() {
    try {
      const next = await window.maka.runtimeHostProfiles.save({
        profile: {
          id: draft.id,
          name: draft.name,
          kind: "remote",
          transport: { kind: "tls", url: draft.url },
          rootId: draft.rootId,
        },
        credential: draft.credential,
      });
      if (!mountedRef.current) return;
      setSnapshot(next);
      setShowAdd(false);
      setDraft({ id: "", name: "", url: "", rootId: "", credential: "" });
    } catch (error) {
      if (mountedRef.current) {
        toast.error(copy.saveFailed, settingsActionErrorMessage(error, locale));
      }
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
            onClick={() => setShowAdd((value) => !value)}
          />
        }
      >
        {showAdd ? (
          <>
            <SettingsRow label={copy.id} end={<TextInput label={copy.id} isLabelHidden value={draft.id} onChange={(id) => setDraft((value) => ({ ...value, id }))} />} />
            <SettingsRow label={copy.name} end={<TextInput label={copy.name} isLabelHidden value={draft.name} onChange={(name) => setDraft((value) => ({ ...value, name }))} />} />
            <SettingsRow label={copy.url} end={<TextInput label={copy.url} isLabelHidden value={draft.url} placeholder="wss://host.example" onChange={(url) => setDraft((value) => ({ ...value, url }))} />} />
            <SettingsRow label={copy.rootId} end={<TextInput label={copy.rootId} isLabelHidden value={draft.rootId} onChange={(rootId) => setDraft((value) => ({ ...value, rootId }))} />} />
            <SettingsRow label={copy.credential} end={<PasswordInput label={copy.credential} isLabelHidden value={draft.credential} onChange={(credential) => setDraft((value) => ({ ...value, credential }))} />} />
            <SettingsRow
              label={copy.add}
              end={<Button variant="primary" size="sm" label={copy.save} isDisabled={Object.values(draft).some((value) => !value.trim())} clickAction={save} />}
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
                description={profile.transport.url}
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
