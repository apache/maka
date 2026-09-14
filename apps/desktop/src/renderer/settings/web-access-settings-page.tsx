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

import { useEffect, useState } from 'react';
import { Button, Switch, TextInput, useMountedRef, useToast, useUiLocale } from '@maka/ui';
import { getWebAccessSettingsCopy } from '../locales/settings-web-access-copy.js';
import { settingsActionErrorMessage } from './settings-error-copy';
import { PasswordInput } from './password-input';
import { SettingsActions, SettingsField, SettingsPage, SettingsSection } from './settings-section';
import { SettingRow } from './settings-rows';
import { useActionGuard } from './use-action-guard';

export function WebAccessSettingsPage() {
  const locale = useUiLocale();
  const copy = getWebAccessSettingsCopy(locale);
  const toast = useToast();
  const mountedRef = useMountedRef();
  const actionGuard = useActionGuard<string>();
  const [status, setStatus] = useState<{ enrolled: boolean; enabled: boolean }>({
    enrolled: false,
    enabled: false,
  });
  const [passphrase, setPassphrase] = useState('');
  const [passphraseConfirm, setPassphraseConfirm] = useState('');
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.maka.webAccess.getStatus().then(
      (next) => {
        if (!cancelled) setStatus(next);
      },
      (error) => {
        if (!cancelled) {
          toast.error(copy.loadFailed, settingsActionErrorMessage(error, locale));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [copy.loadFailed, locale, toast]);

  async function runAction(action: string, run: () => Promise<void>): Promise<void> {
    if (!actionGuard.begin(action)) return;
    setPendingAction(action);
    try {
      await run();
    } finally {
      actionGuard.finish();
      if (mountedRef.current) setPendingAction(null);
    }
  }

  async function refreshStatus(): Promise<void> {
    const next = await window.maka.webAccess.getStatus();
    if (mountedRef.current) setStatus(next);
  }

  async function savePassphrase(): Promise<void> {
    await runAction('passphrase', async () => {
      if (passphrase !== passphraseConfirm) {
        toast.error(copy.passphraseSaveFailed, copy.passphraseMismatch);
        return;
      }
      try {
        const result = await window.maka.webAccess.setPassphrase(passphrase);
        if (!mountedRef.current) return;
        if (!result.ok) {
          toast.error(copy.passphraseSaveFailed, copy.passphraseTooShort);
          return;
        }
        setPassphrase('');
        setPassphraseConfirm('');
        toast.success(copy.passphraseSaved);
        await refreshStatus();
      } catch (error) {
        if (mountedRef.current) {
          toast.error(copy.passphraseSaveFailed, settingsActionErrorMessage(error, locale));
        }
      }
    });
  }

  async function showQr(): Promise<void> {
    if (status.enrolled && !window.confirm(copy.replaceQrConfirm)) return;
    await runAction('enroll', async () => {
      try {
        const result = await window.maka.webAccess.enrollTotp();
        if (!mountedRef.current) return;
        setQrDataUrl(result.qrDataUrl);
        setTotpCode('');
        setStatus((prev) => ({ ...prev, enrolled: false, enabled: false }));
      } catch (error) {
        if (mountedRef.current) {
          toast.error(copy.loadFailed, settingsActionErrorMessage(error, locale));
        }
      }
    });
  }

  async function confirmTotp(): Promise<void> {
    await runAction('confirm', async () => {
      try {
        const result = await window.maka.webAccess.confirmTotp(totpCode);
        if (!mountedRef.current) return;
        if (!result.ok) {
          toast.error(copy.confirmFailed);
          return;
        }
        setTotpCode('');
        toast.success(copy.confirmOk);
        await refreshStatus();
      } catch (error) {
        if (mountedRef.current) {
          toast.error(copy.confirmFailed, settingsActionErrorMessage(error, locale));
        }
      }
    });
  }

  async function setEnabled(enabled: boolean): Promise<void> {
    await runAction('enabled', async () => {
      try {
        const result = await window.maka.webAccess.setEnabled(enabled);
        if (!mountedRef.current) return;
        if (!result.ok) {
          toast.error(copy.enableFailed, copy.notEnrolled);
          return;
        }
        await refreshStatus();
      } catch (error) {
        if (mountedRef.current) {
          toast.error(copy.enableFailed, settingsActionErrorMessage(error, locale));
        }
      }
    });
  }

  async function generateRecovery(): Promise<void> {
    await runAction('recovery', async () => {
      try {
        const result = await window.maka.webAccess.regenerateRecovery();
        if (!mountedRef.current) return;
        if (result.codes.length === 0) {
          toast.error(copy.recoveryFailed);
          return;
        }
        setRecoveryCodes(result.codes);
      } catch (error) {
        if (mountedRef.current) {
          toast.error(copy.recoveryFailed, settingsActionErrorMessage(error, locale));
        }
      }
    });
  }

  const busy = pendingAction !== null;
  const totpReady = /^\d{6}$/.test(totpCode);

  return (
    <SettingsPage>
      <SettingsSection title={copy.passphraseTitle} description={copy.passphraseHelp}>
        <SettingsField>
          <PasswordInput
            value={passphrase}
            onChange={setPassphrase}
            label={copy.passphraseLabel}
            isDisabled={busy}
          />
        </SettingsField>
        <SettingsField>
          <PasswordInput
            value={passphraseConfirm}
            onChange={setPassphraseConfirm}
            label={copy.passphraseConfirmLabel}
            isDisabled={busy}
          />
        </SettingsField>
        <SettingsActions>
          <Button
            variant="primary"
            label={copy.savePassphrase}
            isDisabled={busy || passphrase.length === 0}
            onClick={() => void savePassphrase()}
          />
        </SettingsActions>
      </SettingsSection>

      <SettingsSection title={copy.authenticatorTitle} description={copy.authenticatorHelp}>
        <SettingsActions>
          <Button
            variant="secondary"
            label={status.enrolled ? copy.replaceQr : copy.showQr}
            isDisabled={busy}
            onClick={() => void showQr()}
          />
        </SettingsActions>
        {qrDataUrl ? (
          <SettingsField>
            <img src={qrDataUrl} alt={copy.qrAlt} width={192} height={192} />
          </SettingsField>
        ) : null}
        <SettingsField>
          <TextInput
            value={totpCode}
            onChange={(value) => setTotpCode(value.replace(/\D/g, '').slice(0, 6))}
            label={copy.confirmCodeLabel}
            placeholder={copy.confirmCodePlaceholder}
            isDisabled={busy}
          />
        </SettingsField>
        <SettingsActions>
          <Button
            variant="primary"
            label={copy.confirmCode}
            isDisabled={busy || !totpReady}
            onClick={() => void confirmTotp()}
          />
        </SettingsActions>
      </SettingsSection>

      <SettingsSection>
        <SettingRow
          title={copy.enabled}
          detail={copy.enabledHelp}
          action={
            <Switch
              label={copy.enabledAria}
              isLabelHidden
              value={status.enabled}
              isDisabled={busy || !status.enrolled}
              onChange={(enabled) => void setEnabled(enabled)}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={copy.recoveryTitle} description={copy.recoveryHelp}>
        <SettingsActions>
          <Button
            variant="secondary"
            label={copy.generateRecovery}
            isDisabled={busy}
            onClick={() => void generateRecovery()}
          />
        </SettingsActions>
        {recoveryCodes && recoveryCodes.length > 0 ? (
          <>
            <div className="settingsQuietCallout">
              <p>{copy.recoveryShownOnce}</p>
            </div>
            <SettingsField>
              <ul aria-label={copy.recoveryCodesAria}>
                {recoveryCodes.map((code) => (
                  <li key={code}>
                    <code>{code}</code>
                  </li>
                ))}
              </ul>
            </SettingsField>
          </>
        ) : null}
      </SettingsSection>
    </SettingsPage>
  );
}
