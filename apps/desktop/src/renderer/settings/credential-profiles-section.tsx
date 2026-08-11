import { useState } from 'react';
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
  NumberInput,
  RelativeTime,
  TextInput,
  useUiLocale,
} from '@maka/ui';
import { getProviderSettingsCopy } from '../locales/settings-provider-copy';
import type { ConnectionTestResult, LlmConnection } from '@maka/core';
import type { CredentialProfileReadinessView } from '../../preload/bridge-contract.js';
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
  readonly onSaveCredential: (input: ProfileCredentialInput) => Promise<boolean>;
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

  const balanced = readiness?.routingMode === 'balanced';
  const anyAction = props.busy || props.actionId !== null;
  const profiles = readiness?.profiles ?? [];

  function statusOf(profile: ReadinessProfile): ProfileStatus {
    if (!profile.enabled) return 'disabled';
    if (!profile.credentialConfigured) return 'unconfigured';
    if (profile.circuit?.state === 'invalid') return 'invalid';
    if (profile.circuit?.state === 'open' || profile.circuit?.state === 'half_open') {
      return 'cooldown';
    }
    if (profile.lastTest?.status === 'needs_reauth') return 'needs_reauth';
    if (profile.supportedModels.length === 0) return 'unverified';
    return 'ready';
  }

  function statusLabel(status: ProfileStatus): string {
    switch (status) {
      case 'disabled':
        return copy.profileDisabledTag;
      case 'unconfigured':
        return copy.profileUnconfigured;
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

  async function toggleBalanced(next: boolean): Promise<void> {
    if (!readiness) return;
    await props.onSetRoutingMode({ mode: next ? 'balanced' : 'legacy_primary' });
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
    if (label.length === 0 || label === profile.label) {
      setEditingLabelFor(null);
      setWeightDraft(null);
      return;
    }
    if (
      await props.onUpdate({
        profileId: profile.profileId,
        profileRevision: profile.revision,
        label,
        ...(weightDraft === null || weightDraft === profile.weight
          ? {}
          : { weight: weightDraft }),
      })
    ) {
      setEditingLabelFor(null);
      setWeightDraft(null);
    }
  }

  return (
    <Grid columns={{ minWidth: 320 }} columnGap={10} rowGap={4} role="region" aria-label={copy.accounts}>
      <VStack gap={0.5}>
        <Heading level={3}>{copy.accounts}</Heading>
        <Text type="supporting" color="secondary">{copy.accountsHelp}</Text>
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
            {/* Routing mode: explicitly user-activated only. Adding a secondary
                profile never flips this switch. */}
            <HStack gap={4} justify="between" vAlign="center">
              <VStack gap={1} maxWidth={380}>
                <Text size="sm">{copy.profileRoutingMode}</Text>
                <Text type="supporting" color="secondary">
                  {balanced ? copy.profileRoutingBalanced : copy.profileRoutingLegacy}
                </Text>
                <Text type="supporting" color="secondary">
                  {balanced
                    ? copy.profileBalancedActive(readiness.readyCandidateCount)
                    : copy.profileBalancedHint}
                </Text>
              </VStack>
              <Button
                variant={balanced ? 'secondary' : 'primary'}
                isLoading={props.actionId === 'routing-mode'}
                isDisabled={anyAction && props.actionId !== 'routing-mode'}
                label={balanced ? copy.profileDisableBalanced : copy.profileEnableBalanced}
                onClick={() => void toggleBalanced(!balanced)}
              />
            </HStack>
            <Divider />
            {profiles.map((profile) => {
              const status = statusOf(profile);
              const testBusy = props.actionId === `test:${profile.profileId}`;
              const credentialBusy = props.actionId === `credential:${profile.profileId}`;
              const enableBusy = props.actionId === `enabled:${profile.profileId}`;
              const updateBusy = props.actionId === `update:${profile.profileId}`;
              const removeBusy = props.actionId === `remove:${profile.profileId}`;
              return (
                <VStack key={profile.profileId} gap={2}>
                  <HStack gap={4} justify="between" vAlign="start">
                    <VStack gap={1} maxWidth={380}>
                      <HStack gap={2} vAlign="center">
                        <Text size="sm">
                          {profile.primary ? copy.profilePrimary : profile.label}
                        </Text>
                        <Text size="sm" color="secondary">
                          {statusLabel(status)}
                        </Text>
                      </HStack>
                      <Text type="supporting" color="secondary">
                        {copy.profileSupportedModels(profile.supportedModels.length)}
                        {profile.primary ? '' : ` · ${copy.profileWeight} ${profile.weight}`}
                        {profile.primary ? '' : ` · ${lastTestText(profile)}`}
                      </Text>
                      {profile.circuit?.blockedUntil !== null &&
                        profile.circuit?.blockedUntil !== undefined && (
                          <Text type="supporting" color="secondary">
                            <RelativeTime ts={profile.circuit.blockedUntil} />
                          </Text>
                        )}
                    </VStack>
                    <HStack gap={2} vAlign="center">
                      <Button
                        variant="secondary"
                        size="sm"
                        isDisabled={anyAction && !testBusy}
                        isLoading={testBusy}
                        label={copy.profileTest}
                        onClick={() => void props.onTest({ profileId: profile.profileId })}
                      />
                      {!profile.primary && (
                        <Button
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
                        />
                      )}
                      {!profile.primary && (
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
                      )}
                      {!profile.primary && (
                        <Button
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
                        />
                      )}
                      {!profile.primary && (
                        <Button
                          variant="destructive"
                          size="sm"
                          isDisabled={anyAction && !removeBusy}
                          isLoading={removeBusy}
                          label={copy.profileRemove}
                          onClick={() =>
                            void props.onRemove(
                              { profileId: profile.profileId, profileRevision: profile.revision },
                              profile.label,
                            )
                          }
                        />
                      )}
                    </HStack>
                  </HStack>
                  {editingSecretFor === profile.profileId && (
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
                      <NumberInput
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
                      />
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
              );
            })}
            <Divider />
            {/* Add a secondary profile. New profiles are created disabled:
                they never start carrying traffic. */}
            <HStack gap={2} vAlign="center">
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
                label={copy.addProfile}
                onClick={() => void addProfile()}
              />
            </HStack>
            {addFailed && (
              <Text type="supporting" color="secondary">{copy.profileLabel}</Text>
            )}
          </>
        )}
      </VStack>
    </Grid>
  );
}
