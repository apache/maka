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

import { Canvas, Text, View, platform } from 'nsh';
import { SettingsSkeleton } from './Loading';
import { messageDateTime, tr } from './locale';
import {
  RowLine,
  SettingsBody,
  SettingsButton,
  SettingsConfirm,
  SettingsDiscard,
  SettingsInput,
  SettingsProblem,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from './SettingsPage';
import type { RemoteAccessSettingsOwner } from './remoteAccessSettingsState';
import { C, captionTextStyle } from './ui';

type Props = { owner: RemoteAccessSettingsOwner };
const shortPeerId = (id: string) => (id.length > 12 ? id.slice(0, 8) + '…' + id.slice(-4) : id);
const peerIdStyle = { ...captionTextStyle, fontFamily: 'monospace' };

export function RemoteAccessSettings({ owner }: Props) {
  return (
    <If
      when={platform.idiom !== 'terminal'}
      else={
        <SettingsBody>
          <SettingsProblem message={tr('Remote Access is available in Maka Desktop.')} />
        </SettingsBody>
      }
    >
      <If
        when={!owner.discarding.asking()}
        else={
          <SettingsDiscard onDiscard={owner.discarding.discard} onKeep={owner.discarding.keep} />
        }
      >
        <If
          when={!owner.confirming()}
          else={
            <SettingsConfirm
              title={tr('Revoke access for {device}?', {
                device: owner.confirming()?.label || shortPeerId(owner.confirming()?.peerId ?? ''),
              })}
              body={tr('This disconnects the device immediately. To reconnect, pair it again.')}
              error={owner.actionError()}
              confirm={tr('Revoke')}
              destructive
              disabled={owner.busy()}
              onConfirm={owner.revoke}
              onCancel={owner.cancelRevoke}
            />
          }
        >
          <RemoteAccessForm owner={owner} />
        </If>
      </If>
    </If>
  );
}

function RemoteAccessForm({ owner }: Props) {
  const live = () => owner.status()!;
  const draft = () => owner.draft()!;
  const disabled = () => owner.busy() || live().cliOverride || !!owner.loadError();
  const statusLabel = () => {
    switch (live().status) {
      case 'connected':
        return tr('Connected');
      case 'starting':
        return tr('Connecting…');
      case 'error':
        return tr('Error');
      case 'disabled':
        return tr('Off');
    }
  };
  return (
    <If
      when={owner.status() && owner.draft()}
      else={
        <SettingsBody>
          <If when={owner.loadError()} else={<SettingsSkeleton padded={false} rows={3} />}>
            <SettingsProblem message={owner.loadError()} retry={owner.refresh} />
          </If>
        </SettingsBody>
      }
    >
      <SettingsBody
        footerShown={owner.dirty()}
        footer={
          <>
            <SettingsButton
              label={tr('Discard')}
              tone="quiet"
              disabled={owner.busy()}
              onPress={owner.discard}
            />
            <SettingsButton
              label={tr('Save')}
              tone="primary"
              disabled={disabled()}
              onPress={owner.save}
            />
          </>
        }
      >
        <If when={owner.loadError()}>
          <SettingsProblem message={owner.loadError()} retry={owner.refresh} />
        </If>
        <SettingsSection title={tr('Connection status')}>
          <SettingsRow
            label={tr('Remote Access')}
            trailing={
              <Text
                style={{
                  ...captionTextStyle,
                  fontWeight: '600',
                  color:
                    live().status === 'error'
                      ? C.danger
                      : live().status === 'connected'
                        ? C.success
                        : C.muted,
                }}
              >
                {statusLabel()}
              </Text>
            }
          />
          <If when={live().error}>
            <SettingsRow
              label={tr('Relay')}
              description={live().error ?? undefined}
              tone="danger"
              trailing={
                <If when={!live().cliOverride}>
                  <SettingsButton label={tr('Retry')} disabled={disabled()} onPress={owner.retry} />
                </If>
              }
            />
          </If>
          <SettingsRow
            label={tr('Host Peer ID')}
            detail={
              <Text style={{ ...peerIdStyle, color: C.muted }}>{shortPeerId(live().peerId)}</Text>
            }
            trailing={
              <SettingsButton
                label={owner.copied() === 'peer' ? tr('Copied') : tr('Copy')}
                accessibilityLabel={tr('Copy Host Peer ID')}
                onPress={() => owner.copy('peer', live().peerId)}
              />
            }
          />
          <SettingsRow
            label={tr('Connected relays')}
            description={live().connectedRelays.join(' · ') || tr('No relay connected')}
          />
        </SettingsSection>
        <SettingsSection
          title={tr('Configuration')}
          note={
            live().cliOverride
              ? tr('Relay settings are controlled by Host launch flags.')
              : undefined
          }
        >
          <SettingsSwitch
            label={tr('Enable Remote Access')}
            checked={draft().enabled}
            disabled={disabled()}
            onPress={() => owner.setEnabled(!draft().enabled)}
          />
          <If when={draft().enabled}>
            <SettingsSwitch
              label={tr('Relay only (disable direct P2P)')}
              checked={draft().relayOnly}
              disabled={disabled()}
              onPress={() => owner.setRelayOnly(!draft().relayOnly)}
            />
            <SettingsRow
              label={tr('Relays')}
              trailing={
                <SettingsButton
                  label={tr('Add relay')}
                  disabled={disabled()}
                  onPress={owner.addRelay}
                />
              }
            />
          </If>
        </SettingsSection>
        <If when={draft().enabled}>
          <Each of={draft().relays} key={(relay) => relay.id}>
            {(relay) => (
              <SettingsSection
                title={tr('Relay {number}', {
                  number: draft().relays.findIndex((item) => item.id === relay().id) + 1,
                })}
                trailing={
                  <SettingsButton
                    label={tr('Remove')}
                    disabled={disabled()}
                    onPress={() => owner.removeRelay(relay().id)}
                  />
                }
              >
                <SettingsInput
                  label={tr('Relay URL')}
                  placeholder="https://relay.example.org"
                  value={relay().url}
                  disabled={disabled()}
                  error={
                    relay().url && owner.urlError(relay())
                      ? tr('Enter an HTTP or HTTPS relay URL.')
                      : undefined
                  }
                  change={(url) => owner.editRelay(relay().id, { url })}
                />
                <SettingsInput
                  label={tr('QUIC port')}
                  placeholder={tr('Optional')}
                  value={relay().quicPort}
                  disabled={disabled()}
                  error={owner.portError(relay()) ? tr('Enter a port from 1 to 65535.') : undefined}
                  change={(quicPort) => owner.editRelay(relay().id, { quicPort })}
                />
                <SettingsInput
                  label={tr('TLS certificate SHA-256')}
                  placeholder={tr('Optional')}
                  value={relay().certSha256}
                  disabled={disabled()}
                  change={(certSha256) => owner.editRelay(relay().id, { certSha256 })}
                />
                <SettingsInput
                  label={tr('TLS CA certificate path')}
                  placeholder={tr('Optional')}
                  value={relay().caDerPath}
                  disabled={disabled()}
                  change={(caDerPath) => owner.editRelay(relay().id, { caDerPath })}
                />
                <SettingsSelect
                  label={tr('Relay Bearer token')}
                  value={owner.relayAuth(relay())}
                  disabled={disabled()}
                  choices={[
                    {
                      value: 'keep',
                      title: owner.hasSavedToken(relay()) ? tr('Keep saved token') : tr('No token'),
                    },
                    { value: 'replace', title: tr('Replace') },
                    ...(owner.hasSavedToken(relay())
                      ? [{ value: 'clear', title: tr('Clear') }]
                      : []),
                  ]}
                  change={(auth) =>
                    owner.editRelay(relay().id, {
                      auth: auth as 'keep' | 'clear' | 'replace',
                      token: '',
                    })
                  }
                />
                <If when={relay().auth === 'replace'}>
                  <SettingsInput
                    label={tr('New Bearer token')}
                    masked
                    value={relay().token}
                    disabled={disabled()}
                    change={(token) => owner.editRelay(relay().id, { token })}
                  />
                </If>
              </SettingsSection>
            )}
          </Each>
        </If>
        <If when={owner.actionError()}>
          <SettingsProblem message={owner.actionError()} />
        </If>
        <Pairing owner={owner} />
        <SettingsSection title={tr('Paired devices')}>
          <If when={!owner.devices().length}>
            <SettingsRow label={tr('No paired devices')} />
          </If>
          <Each of={owner.devices()} key={(device) => device.peerId}>
            {(device) => (
              <SettingsRow
                label={device().label || tr('Unnamed device')}
                detail={
                  <>
                    <Text style={{ ...peerIdStyle, color: C.muted }}>
                      {shortPeerId(device().peerId)}
                    </Text>
                    <Text style={{ ...captionTextStyle, color: C.muted }}>
                      {[
                        device().createdAt &&
                          tr('Paired {time}', {
                            time: messageDateTime(Date.parse(device().createdAt)),
                          }),
                        device().lastActiveAt &&
                          tr('Last active {time}', {
                            time: messageDateTime(Date.parse(device().lastActiveAt!)),
                          }),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  </>
                }
                trailing={
                  <SettingsButton
                    label={tr('Revoke')}
                    tone="danger"
                    disabled={owner.busy()}
                    onPress={() => owner.confirmRevoke(device())}
                  />
                }
              />
            )}
          </Each>
        </SettingsSection>
      </SettingsBody>
    </If>
  );
}

function Pairing({ owner }: Props) {
  const code = () => owner.activeInvite()?.qr;
  const active = owner.activeInvite;
  const moduleSize = () => Math.max(2, Math.min(5, Math.floor(320 / ((code()?.length ?? 0) + 8))));
  const side = () => ((code()?.length ?? 0) + 8) * moduleSize();
  return (
    <SettingsSection title={tr('Pair new device')}>
      <If when={owner.sas()}>
        <SettingsRow
          label={tr('SAS verification code')}
          description={tr('Confirm only if this code matches the one on your phone.')}
          trailing={
            <View
              style={{
                backgroundColor: C.raised,
                borderRadius: 8,
                paddingHorizontal: 14,
                paddingVertical: 8,
              }}
            >
              <Text
                style={{
                  color: C.text,
                  fontFamily: 'monospace',
                  fontVariant: ['tabular-nums'],
                  fontSize: 24,
                  fontWeight: '600',
                  letterSpacing: 3,
                }}
              >
                {owner.sas()?.sas}
              </Text>
            </View>
          }
        />
      </If>
      <SettingsRow
        label={owner.pairing().kind === 'expired' ? tr('Pairing link expired') : tr('Pairing link')}
        detail={
          <If when={active()}>
            <Text style={{ ...captionTextStyle, color: C.muted, fontVariant: ['tabular-nums'] }}>
              {tr('Expires in {seconds}s', { seconds: owner.secondsLeft() })}
            </Text>
          </If>
        }
        description={
          !owner.canPair() ? tr('Connect to a relay before pairing a device.') : undefined
        }
        trailing={
          <SettingsButton
            label={owner.pairing().kind !== 'idle' ? tr('Regenerate') : tr('Pair device')}
            tone="primary"
            disabled={!owner.canPair() || owner.busy()}
            onPress={owner.pair}
          />
        }
      />
      <If when={active()}>
        <SettingsRow
          label={tr('Scan with the Maka app')}
          description={
            !code() ? tr('This link is too long for a QR code. Copy it instead.') : undefined
          }
          trailing={
            <SettingsButton
              label={owner.copied() === 'invite' ? tr('Copied') : tr('Copy pairing link')}
              onPress={() => owner.copy('invite', owner.activeInvite()!.uri)}
            />
          }
        />
        <If when={code()}>
          <View style={{ alignItems: 'center', paddingVertical: 16 }}>
            <RowLine />
            <View
              style={{ borderRadius: 8, overflow: 'hidden', borderWidth: 1, borderColor: C.line }}
            >
              <Canvas
                accessibilityElementsHidden
                style={{ width: side(), height: side() }}
                draw={(ctx) => {
                  const matrix = code();
                  if (!matrix) return;
                  const unit = moduleSize();
                  // QR optical colors are data, independent of the window appearance.
                  ctx.fillStyle = '#fff';
                  ctx.fillRect(0, 0, side(), side());
                  ctx.fillStyle = '#000';
                  matrix.forEach((row, y) =>
                    row.forEach((dark, x) => {
                      if (dark) ctx.fillRect((x + 4) * unit, (y + 4) * unit, unit, unit);
                    }),
                  );
                }}
              />
            </View>
          </View>
        </If>
      </If>
    </SettingsSection>
  );
}
