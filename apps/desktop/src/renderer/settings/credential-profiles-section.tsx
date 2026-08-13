import { Fragment, type PointerEvent, useId, useRef, useState } from 'react';
import {
  Banner,
  Divider,
  Grid,
  Heading,
  HStack,
  Text,
  VStack,
} from '@astryxdesign/core';
import {
  Button,
  MoreMenu,
  NumberInput,
  RelativeTime,
  Switch,
  TextInput,
  useUiLocale,
} from '@maka/ui';
import { getProviderSettingsCopy } from '../locales/settings-provider-copy';
import type { ConnectionTestResult, LlmConnection } from '@maka/core/llm-connections';
import type { QuotaWindow } from '@maka/core/oauth-subscription';
import type {
  CredentialProfileReadinessView,
  CredentialProfileUsageView,
} from '../../preload/bridge-contract.js';
import { PasswordInput } from './password-input';
import type {
  ProfileBasisInput,
  ProfileCreateInput,
  ProfileCredentialInput,
  ProfileRoutingModeInput,
  ProfileTestInput,
  ProfileUpdateInput,
} from './provider-panel-shared';

export interface CredentialProfilesSectionProps {
  readonly connection: LlmConnection;
  readonly readiness: CredentialProfileReadinessView | null;
  readonly readinessFailed: boolean;
  readonly actionId: string | null;
  readonly secretDraft: Record<string, string>;
  readonly setSecretDraft: (updater: (current: Record<string, string>) => Record<string, string>) => void;
  readonly newLabel: string;
  readonly setNewLabel: (value: string) => void;
  readonly newWeight: number;
  readonly setNewWeight: (value: number) => void;
  readonly onCreate: (input: ProfileCreateInput) => Promise<boolean>;
  readonly onUpdate: (input: ProfileUpdateInput) => Promise<boolean>;
  readonly onSetEnabled: (input: ProfileBasisInput & { enabled: boolean }) => Promise<boolean>;
  readonly onRemove: (input: ProfileBasisInput, label: string) => Promise<boolean>;
  readonly onSetRoutingMode: (input: ProfileRoutingModeInput) => Promise<boolean>;
  readonly onMove: (profileId: string, offset: number) => Promise<boolean>;
  readonly onSaveCredential: (input: ProfileCredentialInput) => Promise<boolean>;
  readonly oauth: boolean;
  readonly oauthStateHints: Readonly<Record<string, string>>;
  readonly usageByProfile: Readonly<
    Record<string, CredentialProfileUsageView | { readonly kind: 'loading' }>
  >;
  readonly onRefreshUsage: (profileId: string) => Promise<void>;
  readonly onOAuthLogin: (profileId: string) => Promise<boolean>;
  readonly onTest: (input: ProfileTestInput) => Promise<ConnectionTestResult | null>;
  readonly busy: boolean;
}

type ProfileStatus =
  | 'disabled'
  | 'unconfigured'
  | 'unverified'
  | 'needs_reauth'
  | 'invalid'
  | 'cooldown'
  | 'ready';

type ReadinessProfile = CredentialProfileReadinessView['profiles'][number];

/**
 * Accounts / API Keys area (RFC 13.3). One row per Credential Profile with
 * label, enable state, weight, readiness status, last test, supported-model
 * summary and its actions. API keys are only visible inside the per-row
 * replace form at save time; removal confirms against the label only and the
 * primary profile cannot be removed. Transient cooldown is shown as a circuit
 * status separate from "balancing not activated" — the routing switch only
 * ever reflects the user's explicit choice.
 */
export function CredentialProfilesSection(props: CredentialProfilesSectionProps) {
  const locale = useUiLocale();
  const copy = getProviderSettingsCopy(locale).detail;
  const { readiness } = props;
  const [editingSecretFor, setEditingSecretFor] = useState<string | null>(null);
  const [editingLabelFor, setEditingLabelFor] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState('');
  const [weightDraft, setWeightDraft] = useState<number | null>(null);
  const [addFailed, setAddFailed] = useState(false);
  const [draggingProfileId, setDraggingProfileId] = useState<string | null>(null);
  const [dragOverInsertionIndex, setDragOverInsertionIndex] = useState<number | null>(null);
  const draggingProfileIdRef = useRef<string | null>(null);
  const dragOverInsertionIndexRef = useRef<number | null>(null);
  const profileListId = useId();

  const balanced = readiness?.routingMode === 'balanced';
  const automatic = balanced && readiness?.routingStrategy === 'smooth_weighted_round_robin';
  const anyAction = props.busy || props.actionId !== null;
  const sourceProfiles = readiness?.profiles ?? [];
  const profiles = props.oauth
    ? [...sourceProfiles].sort((left, right) => right.weight - left.weight)
    : sourceProfiles;

  function statusOf(profile: ReadinessProfile): ProfileStatus {
    if (!profile.enabled) return 'disabled';
    if (!profile.credentialConfigured) return 'unconfigured';
    if (profile.circuit?.state === 'invalid') return 'invalid';
    if (profile.circuit?.state === 'open' || profile.circuit?.state === 'half_open') {
      return 'cooldown';
    }
    if (profile.lastTest?.status === 'needs_reauth') return 'needs_reauth';
    if (props.oauth) return 'ready';
    if (profile.supportedModels.length === 0) return 'unverified';
    return 'ready';
  }

  function statusLabel(status: ProfileStatus): string {
    switch (status) {
      case 'disabled':
        return copy.profileDisabledTag;
      case 'unconfigured':
        return props.oauth ? copy.profileOAuthUnconfigured : copy.profileUnconfigured;
      case 'unverified':
        return copy.profileUnverified;
      case 'needs_reauth':
        return copy.profileNeedsReauth;
      case 'invalid':
        return copy.profileInvalid;
      case 'cooldown':
        return copy.profileCooldown;
      case 'ready':
        return copy.profileReady;
    }
  }

  function lastTestText(profile: ReadinessProfile): string {
    if (!profile.lastTest) return copy.profileLastTestNone;
    const at = Date.parse(profile.lastTest.checkedAt);
    const when = Number.isFinite(at)
      ? ` · ${new Date(at).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US')}`
      : '';
    return `${statusLabel(statusOf(profile))}${when}`;
  }

  function usageText(profile: ReadinessProfile): string | null {
    if (!props.oauth || !profile.credentialConfigured) return null;
    const usage = props.usageByProfile[profile.profileId];
    if (usage === undefined || usage.kind === 'loading') return copy.profileUsageLoading;
    if (usage.kind === 'unavailable') {
      switch (usage.reason) {
        case 'unsupported_provider':
          return copy.profileUsageUnsupported;
        case 'credential_unavailable':
          return copy.profileUsageCredentialUnavailable;
        case 'provider_rejected':
          return copy.profileUsageProviderRejected;
        case 'provider_unavailable':
          return copy.profileUsageProviderUnavailable;
        case 'invalid_response':
          return copy.profileUsageInvalidResponse;
      }
    }
    const quota = usage.quota;
    const windows = [
      quota.fiveHour
        ? quotaWindowText(quota.fiveHour, copy.profileUsageFiveHour)
        : null,
      quota.sevenDay
        ? quotaWindowText(quota.sevenDay, copy.profileUsageSevenDay)
        : null,
    ].filter((value): value is string => value !== null);
    return windows.length > 0 ? windows.join(' · ') : copy.profileUsageUnavailable;
  }

  function quotaWindowText(
    window: QuotaWindow,
    usageLabel: (utilization: number) => string,
  ): string {
    const resetAt = Date.parse(window.resetsAt);
    if (!Number.isFinite(resetAt)) return usageLabel(window.utilization);
    const when = new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(resetAt);
    return `${usageLabel(window.utilization)} · ${copy.profileUsageRefreshAt(when)}`;
  }

  async function setLoadBalancing(enabled: boolean): Promise<void> {
    if (!readiness) return;
    await props.onSetRoutingMode({
      mode: 'balanced',
      strategy: enabled ? 'smooth_weighted_round_robin' : 'priority_failover',
    });
  }

  function moveProfileToInsertion(profileId: string, insertionIndex: number): void {
    draggingProfileIdRef.current = null;
    dragOverInsertionIndexRef.current = null;
    setDraggingProfileId(null);
    setDragOverInsertionIndex(null);
    const currentIndex = profiles.findIndex((profile) => profile.profileId === profileId);
    if (currentIndex < 0) return;
    const targetIndex = insertionIndex > currentIndex ? insertionIndex - 1 : insertionIndex;
    const offset = targetIndex - currentIndex;
    if (offset !== 0) void props.onMove(profileId, offset);
  }

  function insertionIndexAt(clientY: number): number {
    const list = document.getElementById(profileListId);
    if (!list) return profiles.length;
    const rows = list.querySelectorAll<HTMLElement>('[data-credential-profile-index]');
    for (const row of rows) {
      const index = Number(row.dataset.credentialProfileIndex);
      const bounds = row.getBoundingClientRect();
      if (clientY < bounds.top + bounds.height / 2) return index;
    }
    return profiles.length;
  }

  function finishPointerDrag(event: PointerEvent<HTMLElement>, profileId: string): void {
    if (draggingProfileIdRef.current !== profileId) return;
    const insertionIndex = dragOverInsertionIndexRef.current ?? insertionIndexAt(event.clientY);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    moveProfileToInsertion(profileId, insertionIndex);
  }

  function dropZone(insertionIndex: number) {
    const active = draggingProfileId !== null && dragOverInsertionIndex === insertionIndex;
    return (
      <div
        aria-hidden="true"
        style={{
          height: draggingProfileId === null ? 6 : 18,
          display: 'flex',
          alignItems: 'center',
          transition: 'height 120ms ease',
        }}
      >
        <div
          style={{
            width: '100%',
            height: 2,
            borderRadius: 999,
            background: active ? 'var(--color-border-accent, currentColor)' : 'transparent',
          }}
        />
      </div>
    );
  }

  async function addProfile(): Promise<void> {
    const label = props.newLabel.trim();
    if (label.length === 0) {
      setAddFailed(true);
      return;
    }
    if (await props.onCreate({ label, weight: props.newWeight })) {
      setAddFailed(false);
    }
  }

  async function saveSecret(profileId: string): Promise<void> {
    const secret = props.secretDraft[profileId];
    if (!secret) return;
    if (await props.onSaveCredential({ profileId, secret })) {
      setEditingSecretFor(null);
    }
  }

  async function saveLabelEdit(profile: ReadinessProfile): Promise<void> {
    const label = labelDraft.trim();
    const labelChanged = label.length > 0 && label !== profile.label;
    const weightChanged = weightDraft !== null && weightDraft !== profile.weight;
    if (!labelChanged && !weightChanged) {
      setEditingLabelFor(null);
      setWeightDraft(null);
      return;
    }
    if (
      await props.onUpdate({
        profileId: profile.profileId,
        profileRevision: profile.revision,
        ...(labelChanged ? { label } : {}),
        ...(weightChanged ? { weight: weightDraft as number } : {}),
      })
    ) {
      setEditingLabelFor(null);
      setWeightDraft(null);
    }
  }

  return (
    <Grid columns={{ minWidth: 320 }} columnGap={10} rowGap={4} role="region" aria-label={props.oauth ? copy.credentials : copy.accounts}>
      <VStack gap={0.5}>
        <Heading level={3}>{props.oauth ? copy.credentials : copy.accounts}</Heading>
        <Text type="supporting" color="secondary">{props.oauth ? copy.credentialsHelpAccount : copy.accountsHelp}</Text>
      </VStack>
      <VStack gap={4}>
        {props.readinessFailed && (
          <Banner status="warning" role="alert" title={copy.profileReadFailed} />
        )}
        {!props.readinessFailed && readiness === null && !props.busy && (
          <Text type="supporting" color="secondary">{copy.profileNoProfiles}</Text>
        )}
        {readiness && (
          <>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) 180px',
              gap: 16,
              alignItems: 'center',
            }}>
              <VStack gap={1} maxWidth={380}>
                <Text size="sm">{copy.profileRoutingMode}</Text>
                <Text type="supporting" color="secondary">
                  {automatic
                    ? copy.profileRoutingAutomaticHelp
                    : copy.profileRoutingManualHelp}
                </Text>
              </VStack>
              <div style={{ width: 180, display: 'flex', justifyContent: 'flex-end' }}>
                <Switch
                  label={copy.profileEnableBalanced}
                  value={automatic}
                  isDisabled={anyAction || profiles.length < 2}
                  onChange={(enabled) => void setLoadBalancing(enabled)}
                />
              </div>
            </div>
            <Divider />
            <div id={profileListId} style={{ display: 'contents' }}>
            {profiles.map((profile) => {
              const status = statusOf(profile);
              const testBusy = props.actionId === `test:${profile.profileId}`;
              const credentialBusy = props.actionId === `credential:${profile.profileId}`;
              const enableBusy = props.actionId === `enabled:${profile.profileId}`;
              const updateBusy = props.actionId === `update:${profile.profileId}`;
              const removeBusy = props.actionId === `remove:${profile.profileId}`;
              const profileIndex = profiles.indexOf(profile);
              const displayedLabel =
                props.oauth && profile.primary && profile.label === 'primary'
                  ? profileIndex === 0
                    ? copy.profilePrimary
                    : copy.profileAccount(profileIndex + 1)
                  : profile.label;
              return (
                <Fragment key={profile.profileId}>
                {props.oauth && dropZone(profileIndex)}
                <div
                  data-credential-profile-index={profileIndex}
                  style={{
                    opacity: draggingProfileId === profile.profileId ? 0.55 : 1,
                  }}
                >
                <VStack gap={2}>
                  <HStack gap={4} justify="between" vAlign="start">
                    <VStack gap={1} maxWidth={380}>
                      <HStack gap={2} vAlign="center">
                        {props.oauth && (
                          <span
                            aria-hidden="true"
                            onPointerDown={(event) => {
                              if (anyAction) return;
                              event.currentTarget.setPointerCapture(event.pointerId);
                              draggingProfileIdRef.current = profile.profileId;
                              dragOverInsertionIndexRef.current = profileIndex;
                              setDraggingProfileId(profile.profileId);
                              setDragOverInsertionIndex(profileIndex);
                            }}
                            onPointerMove={(event) => {
                              if (draggingProfileIdRef.current !== profile.profileId) return;
                              const insertionIndex = insertionIndexAt(event.clientY);
                              dragOverInsertionIndexRef.current = insertionIndex;
                              setDragOverInsertionIndex(insertionIndex);
                            }}
                            onPointerUp={(event) => finishPointerDrag(event, profile.profileId)}
                            onPointerCancel={() => {
                              draggingProfileIdRef.current = null;
                              dragOverInsertionIndexRef.current = null;
                              setDraggingProfileId(null);
                              setDragOverInsertionIndex(null);
                            }}
                            style={{
                              cursor: anyAction ? 'default' : 'grab',
                              touchAction: 'none',
                              userSelect: 'none',
                            }}
                          >
                            ⋮⋮
                          </span>
                        )}
                        <Text size="sm">{displayedLabel}</Text>
                        {props.oauth && profileIndex === 0 && displayedLabel !== copy.profilePrimary && (
                          <Text size="sm" color="secondary">{copy.profilePrimary}</Text>
                        )}
                        <Text size="sm" color="secondary">
                          {statusLabel(status)}
                        </Text>
                      </HStack>
                      {!props.oauth && (
                        <Text type="supporting" color="secondary">
                          {copy.profileSupportedModels(profile.supportedModels.length)}
                          {` · ${copy.profileWeight} ${profile.weight}`}
                          {` · ${lastTestText(profile)}`}
                        </Text>
                      )}
                      {profile.accountHint && (
                        <Text type="supporting" color="secondary">{profile.accountHint}</Text>
                      )}
                      {usageText(profile) && (
                        <Text type="supporting" color="secondary">{usageText(profile)}</Text>
                      )}
                      {props.oauthStateHints[profile.profileId] && (
                        <Text type="supporting" color="secondary">
                          {props.oauthStateHints[profile.profileId]}
                        </Text>
                      )}
                      {profile.circuit?.blockedUntil !== null &&
                        profile.circuit?.blockedUntil !== undefined && (
                          <Text type="supporting" color="secondary">
                            <RelativeTime ts={profile.circuit.blockedUntil} />
                          </Text>
                        )}
                    </VStack>
                    <HStack gap={2} vAlign="center" hAlign="end">
                      {props.oauth ? (
                        <MoreMenu
                          size="sm"
                          label={copy.profileMoreActions(displayedLabel)}
                          items={[
                            {
                              label: profile.credentialConfigured ? copy.relogin : copy.login,
                              isDisabled: anyAction && !credentialBusy,
                              onClick: () => void props.onOAuthLogin(profile.profileId),
                            },
                            {
                              label: profile.enabled ? copy.profileDisabled : copy.profileEnabled,
                              isDisabled: anyAction && !enableBusy,
                              onClick: () =>
                                void props.onSetEnabled({
                                  profileId: profile.profileId,
                                  profileRevision: profile.revision,
                                  enabled: !profile.enabled,
                                }),
                            },
                            {
                              label: copy.edit,
                              isDisabled: anyAction && !updateBusy,
                              onClick: () => {
                                if (editingLabelFor === profile.profileId) {
                                  void saveLabelEdit(profile);
                                } else {
                                  setEditingLabelFor(profile.profileId);
                                  setLabelDraft(profile.label);
                                  setWeightDraft(profile.weight);
                                }
                              },
                            },
                            {
                              label: copy.profileRefreshUsage,
                              isDisabled:
                                anyAction ||
                                !profile.credentialConfigured ||
                                props.usageByProfile[profile.profileId]?.kind === 'loading',
                              onClick: () => void props.onRefreshUsage(profile.profileId),
                            },
                            { type: 'divider' },
                            {
                              label: copy.profileMoveUp,
                              isDisabled: anyAction || profileIndex === 0,
                              onClick: () => void props.onMove(profile.profileId, -1),
                            },
                            {
                              label: copy.profileMoveDown,
                              isDisabled: anyAction || profileIndex === profiles.length - 1,
                              onClick: () => void props.onMove(profile.profileId, 1),
                            },
                            ...(!profile.primary
                              ? [
                                  { type: 'divider' as const },
                                  {
                                    label: copy.profileRemove,
                                    isDisabled: anyAction && !removeBusy,
                                    onClick: () =>
                                      void props.onRemove(
                                        {
                                          profileId: profile.profileId,
                                          profileRevision: profile.revision,
                                        },
                                        profile.label,
                                      ),
                                  },
                                ]
                              : []),
                          ]}
                        />
                      ) : (
                        <>
                          <Button
                            variant="secondary"
                            size="sm"
                            isDisabled={anyAction && !testBusy}
                            isLoading={testBusy}
                            label={copy.profileTest}
                            onClick={() => void props.onTest({ profileId: profile.profileId })}
                          />
                          {!profile.primary && <Button
                          variant="secondary"
                          size="sm"
                          isDisabled={anyAction && !credentialBusy}
                          isLoading={credentialBusy}
                          label={copy.profileReplaceCredential}
                          onClick={() => {
                            if (editingSecretFor === profile.profileId) {
                              void saveSecret(profile.profileId);
                            } else {
                              setEditingSecretFor(profile.profileId);
                            }
                          }}
                          />}
                          <Button
                            variant="secondary"
                            size="sm"
                            isDisabled={anyAction && !enableBusy}
                            isLoading={enableBusy}
                            label={profile.enabled ? copy.profileDisabled : copy.profileEnabled}
                            onClick={() =>
                              void props.onSetEnabled({
                                profileId: profile.profileId,
                                profileRevision: profile.revision,
                                enabled: !profile.enabled,
                              })
                            }
                          />
                          {!profile.primary && <Button
                            variant="secondary"
                            size="sm"
                            isDisabled={anyAction && !updateBusy}
                            isLoading={updateBusy}
                            label={copy.edit}
                            onClick={() => {
                              if (editingLabelFor === profile.profileId) {
                                void saveLabelEdit(profile);
                              } else {
                                setEditingLabelFor(profile.profileId);
                                setLabelDraft(profile.label);
                                setWeightDraft(profile.weight);
                              }
                            }}
                          />}
                          {!profile.primary && <MoreMenu
                            size="sm"
                            label={copy.profileRemove}
                            items={[{
                              label: copy.profileRemove,
                              isDisabled: anyAction && !removeBusy,
                              onClick: () =>
                                void props.onRemove(
                                  { profileId: profile.profileId, profileRevision: profile.revision },
                                  profile.label,
                                ),
                            }]}
                          />}
                        </>
                      )}
                    </HStack>
                  </HStack>
                  {!props.oauth && editingSecretFor === profile.profileId && (
                    <HStack gap={2} vAlign="center">
                      <PasswordInput
                        value={props.secretDraft[profile.profileId] ?? ''}
                        onChange={(value) =>
                          props.setSecretDraft((current) => ({
                            ...current,
                            [profile.profileId]: value,
                          }))
                        }
                        placeholder={copy.profileKeyPlaceholder}
                        label={copy.profileKeyPlaceholder}
                        isLabelHidden
                        isDisabled={anyAction}
                      />
                      <Button
                        variant="primary"
                        size="sm"
                        isDisabled={anyAction || !props.secretDraft[profile.profileId]}
                        isLoading={credentialBusy}
                        label={copy.profileSaveCredential}
                        onClick={() => void saveSecret(profile.profileId)}
                      />
                      <Button
                        variant="secondary"
                        size="sm"
                        isDisabled={anyAction}
                        label={copy.cancel}
                        onClick={() => {
                          setEditingSecretFor(null);
                          props.setSecretDraft((current) => {
                            const { [profile.profileId]: _dropped, ...rest } = current;
                            return rest;
                          });
                        }}
                      />
                    </HStack>
                  )}
                  {editingLabelFor === profile.profileId && (
                    <HStack gap={2} vAlign="center">
                      <TextInput
                        value={labelDraft}
                        onChange={setLabelDraft}
                        placeholder={copy.profileLabel}
                        label={copy.profileLabel}
                        isLabelHidden
                        isDisabled={anyAction}
                      />
                      {!props.oauth && <NumberInput
                        size="sm"
                        width={120}
                        label={copy.profileWeight}
                        isLabelHidden
                        value={weightDraft}
                        isIntegerOnly
                        min={1}
                        max={100}
                        onChange={setWeightDraft}
                        isDisabled={anyAction}
                      />}
                      <Button
                        variant="primary"
                        size="sm"
                        isDisabled={anyAction || labelDraft.trim().length === 0}
                        isLoading={updateBusy}
                        label={copy.save}
                        onClick={() => void saveLabelEdit(profile)}
                      />
                      <Button
                        variant="secondary"
                        size="sm"
                        isDisabled={anyAction}
                        label={copy.cancel}
                        onClick={() => {
                          setEditingLabelFor(null);
                          setWeightDraft(null);
                        }}
                      />
                    </HStack>
                  )}
                </VStack>
                </div>
                </Fragment>
              );
            })}
            {props.oauth && profiles.length > 0 && dropZone(profiles.length)}
            </div>
            {!props.oauth && <Divider />}
            {!props.oauth && <HStack gap={2} vAlign="center">
              <TextInput
                value={props.newLabel}
                onChange={props.setNewLabel}
                placeholder={copy.profileLabel}
                label={copy.profileLabel}
                isLabelHidden
                isDisabled={anyAction}
              />
              <NumberInput
                size="sm"
                width={120}
                label={copy.profileWeight}
                isLabelHidden
                value={props.newWeight}
                isIntegerOnly
                min={1}
                max={100}
                onChange={props.setNewWeight}
                isDisabled={anyAction}
              />
              <Button
                variant="primary"
                size="sm"
                isDisabled={anyAction || props.newLabel.trim().length === 0}
                isLoading={props.actionId?.startsWith('create:') === true}
                label={props.oauth ? copy.addOAuthProfile : copy.addProfile}
                onClick={() => void addProfile()}
              />
            </HStack>}
            {!props.oauth && addFailed && (
              <Text type="supporting" color="secondary">{copy.profileLabel}</Text>
            )}
          </>
        )}
      </VStack>
    </Grid>
  );
}
