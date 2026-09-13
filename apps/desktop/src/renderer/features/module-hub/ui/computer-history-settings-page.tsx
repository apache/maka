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

import { useId, useRef, useState } from 'react';
import { AlertDialog } from '@astryxdesign/core/AlertDialog';
import { Selector } from '@astryxdesign/core/Selector';
import { Tab, TabList } from '@astryxdesign/core/TabList';
import type { ComputerHistoryClearScope } from '@maka/core/computer-history';
import { Button, HStack, IconButton, Switch, Text, TextInput, useUiLocale } from '@maka/ui';
import { ArrowRight, Globe, Plus, RefreshCcw, ShieldCheck, Trash2, X } from '@maka/ui/icons';
import { SettingsField, SettingsPage, SettingsRow, SettingsSection } from '../../../application/contracts/settings-presentation/index.js';
import { useComputerHistoryApplications } from '../controller/use-computer-history-applications.js';
import { useComputerHistorySettings, useRecentHistoryApplications } from '../controller/use-computer-history-settings.js';
import { ComputerHistoryAppIcon } from './computer-history-app-icon.js';
import { historyAppName } from './computer-history-copy.js';
import { computerHistorySettingsCopy, normalizeHistoryExclusion } from './computer-history-settings-copy.js';

type SourceType = 'applications' | 'websites';
type ConsentKey = 'enabled' | 'captureText' | 'summariesEnabled' | 'summaryTextEnabled';

export function ComputerHistorySettingsPage({ onConfigureModel, onOpenHistory }: {
  onConfigureModel: () => void;
  onOpenHistory?: () => void;
}) {
  const locale = useUiLocale();
  const copy = computerHistorySettingsCopy(locale);
  const controller = useComputerHistorySettings();
  const { status, pending } = controller;
  const recent = useRecentHistoryApplications();
  const metadata = useComputerHistoryApplications([...status?.settings.blockedApplications ?? [], ...recent.applications]);
  const [source, setSource] = useState<SourceType>('applications');
  const [inputs, setInputs] = useState({ applications: '', websites: '' });
  const [inputError, setInputError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [scope, setScope] = useState<ComputerHistoryClearScope>('last_hour');
  const [confirmScope, setConfirmScope] = useState<ComputerHistoryClearScope | null>(null);
  const deleteDialogRef = useRef<HTMLDialogElement>(null);
  const feedbackSequence = useRef(0);
  const panelId = useId();
  const busy = pending !== null;
  const unavailable = status && (!status.platformSupported ? copy.unsupported : !status.helperAvailable ? copy.unavailable : null);
  const disabled = busy || !status || Boolean(controller.statusError);
  const hasModel = Boolean(controller.modelLabel?.trim()) && !controller.modelError;
  const sources = status ? source === 'applications' ? status.settings.blockedApplications : status.settings.blockedDomains : [];
  const field = source === 'applications' ? 'blockedApplications' : 'blockedDomains';

  async function confirm(operation: () => Promise<boolean>, success = copy.saved): Promise<boolean> {
    const sequence = ++feedbackSequence.current;
    setFeedback(null);
    const saved = await operation();
    if (saved && sequence === feedbackSequence.current) setFeedback(success);
    return saved;
  }

  function saveConsent(key: ConsentKey, value: boolean) {
    if (disabled || ((key === 'summariesEnabled' || key === 'summaryTextEnabled') && value && !hasModel)) return;
    void confirm(() => controller.update({ [key]: value }, key));
  }

  async function addSource(selected?: string) {
    if (disabled) return;
    const value = normalizeHistoryExclusion(selected ?? inputs[source], source);
    const error = !value ? source === 'applications' ? copy.invalidApp : copy.invalidWebsite
      : sources.includes(value) ? copy.duplicate : sources.length >= 256 ? copy.tooMany : null;
    setInputError(error);
    if (error || !value) return;
    const original = selected ?? inputs[source];
    if (await confirm(() => controller.update({ [field]: [...sources, value] }, 'exclusions'))) {
      setInputs((current) => current[source] === original ? { ...current, [source]: '' } : current);
    }
  }

  function removeSource(value: string) {
    if (disabled) return;
    setInputError(null);
    void confirm(() => controller.update({ [field]: sources.filter((entry) => entry !== value) }, 'exclusions'));
  }

  const consent = (key: ConsentKey, label: string, description: string) => {
    const modelConsent = key === 'summariesEnabled' || key === 'summaryTextEnabled';
    return (
      <SettingsRow
        label={label}
        description={description}
        end={<Switch
          label={label}
          isLabelHidden
          value={status?.settings[key] ?? false}
          isLoading={pending === key}
          isDisabled={disabled || (!status?.settings[key] && (modelConsent ? !hasModel : Boolean(unavailable)))}
          disabledMessage={modelConsent && !hasModel ? copy.modelRequired : unavailable || undefined}
          onChange={(value) => saveConsent(key, value)}
        />}
      />
    );
  };

  return (
    <SettingsPage as="section" aria-label={copy.title} className="computer-history-settings">
      <div className="computer-history-settings-status">
        <Text type="supporting" color="secondary">{copy.local} · {status ? copy.states[status.state] : controller.statusError ? copy.states.error : copy.loading}</Text>
        <HStack gap={2}>
          {onOpenHistory ? <Button label={copy.history} icon={<ArrowRight size={16} aria-hidden />} variant="ghost" size="sm" onClick={onOpenHistory} isDisabled={busy} /> : null}
          <IconButton label={copy.refresh} tooltip={copy.refresh} icon={<RefreshCcw size={16} aria-hidden />} variant="ghost" isDisabled={busy} onClick={() => { void controller.refresh(); metadata.refresh(); recent.refresh(); }} />
        </HStack>
      </div>
      {controller.statusError ? <div role="alert" className="computer-history-settings-error">{copy.statusReadFailed} {controller.statusError}</div> : null}
      {status?.error ? <div role="alert" className="computer-history-settings-error">{status.error}</div> : null}
      {controller.actionError ? <div role="alert" className="computer-history-settings-error">{copy.actionFailed} {controller.actionError}</div> : null}
      {feedback ? <Text role="status" type="supporting">{feedback}</Text> : null}
      <SettingsSection title={copy.recordingGroup} description={unavailable || undefined}>
        {consent('enabled', copy.recording, copy.recordingHelp)}
        <SettingsRow label={copy.accessibility} end={status ? status.accessibilityGranted ? copy.granted : copy.required : '—'} />
        <SettingsRow label={copy.inputMonitoring} end={status ? status.inputMonitoringGranted ? copy.granted : copy.required : '—'} />
        {status && (!status.accessibilityGranted || !status.inputMonitoringGranted) ? <SettingsRow
          label={copy.permissionHelp}
          end={<Button label={copy.request} icon={<ShieldCheck size={16} aria-hidden />} variant="secondary" size="sm" isDisabled={busy || Boolean(unavailable)} isLoading={pending === 'permissions'} onClick={() => void confirm(controller.requestPermissions, copy.requestDone)} />}
        /> : null}
      </SettingsSection>
      <SettingsSection title={copy.contentGroup}>
        {consent('captureText', copy.text, copy.textHelp)}
        {consent('summariesEnabled', copy.analysis, copy.analysisHelp)}
        {consent('summaryTextEnabled', copy.summaryText, copy.summaryTextHelp.replace('{model}', hasModel ? controller.modelLabel! : copy.modelMissing))}
        <SettingsRow
          label={copy.model}
          description={<>{copy.modelAuthority}{controller.modelError ? <span role="alert" className="computer-history-settings-error"> {copy.modelReadFailed} {controller.modelError}</span> : null}</>}
          end={<span className="computer-history-settings-model"><span>{controller.modelError ? copy.modelReadFailed : controller.modelLabel || copy.modelMissing}</span><Button label={copy.configure} icon={<ArrowRight size={16} aria-hidden />} variant="ghost" size="sm" isDisabled={busy} onClick={onConfigureModel} /></span>}
        />
      </SettingsSection>
      <SettingsSection title={copy.exclusions} description={copy.exclusionsHelp} variant="bare">
        <Text type="supporting" color="secondary">{copy.protection}</Text>
        <TabList role="tablist" aria-label={copy.sources} value={source} onChange={(value) => { if (value === 'applications' || value === 'websites') { setSource(value); setInputError(null); } }} hasDivider>
          <Tab id={`${panelId}-applications-tab`} value="applications" label={copy.applications} panelId={`${panelId}-applications`} />
          <Tab id={`${panelId}-websites-tab`} value="websites" label={copy.websites} panelId={`${panelId}-websites`} />
        </TabList>
        <div role="tabpanel" id={`${panelId}-${source}`} aria-labelledby={`${panelId}-${source}-tab`} tabIndex={0} className="computer-history-settings-sources">
          {source === 'applications' ? <>
            {recent.error ? <div role="alert" className="computer-history-settings-error">{copy.recentAppsFailed} {recent.error}</div> : null}
            {recent.applications.some((id) => !sources.includes(id)) ? <Selector
              label={copy.recentApps}
              description={copy.recentAppsHelp}
              placeholder={copy.selectApp}
              value=""
              width="100%"
              hasSearch
              isDisabled={disabled}
              options={recent.applications.filter((id) => !sources.includes(id)).map((id) => ({
                value: id,
                label: historyAppName(id, metadata.applications.get(id)?.name),
                description: id,
                icon: <ComputerHistoryAppIcon application={id} metadata={metadata.applications.get(id)} />,
              }))}
              onChange={(value) => { if (value) { setInputs((current) => ({ ...current, applications: value })); void addSource(value); } }}
            /> : null}
          </> : null}
          <form className="computer-history-settings-add" onSubmit={(event) => { event.preventDefault(); void addSource(); }}>
            <TextInput
              label={source === 'applications' ? copy.applicationID : copy.hostname}
              placeholder={source === 'applications' ? copy.appPlaceholder : copy.websitePlaceholder}
              description={source === 'applications' ? copy.appHelp : copy.websitesHelp}
              value={inputs[source]}
              onChange={(value) => { setInputs((current) => ({ ...current, [source]: value })); setInputError(null); }}
              isDisabled={disabled}
              width="100%"
            />
            <Button label={copy.add} icon={<Plus size={16} aria-hidden />} variant="secondary" size="sm" isDisabled={disabled || !inputs[source].trim()} isLoading={pending === 'exclusions'} onClick={() => void addSource()} />
          </form>
          {inputError ? <div role="alert" className="computer-history-settings-error">{inputError}</div> : null}
          {source === 'applications' && metadata.error ? <div role="alert" className="computer-history-settings-error">{copy.iconsFailed} {metadata.error}</div> : null}
          <ul className="computer-history-settings-source-list">
            {sources.map((value) => (
              <li key={value}>
                {source === 'applications' ? <ComputerHistoryAppIcon application={value} metadata={metadata.applications.get(value)} size={24} /> : <Globe size={20} aria-hidden />}
                <span className="computer-history-settings-source-name">
                  <span>{source === 'applications' ? historyAppName(value, metadata.applications.get(value)?.name) : value}</span>
                  {source === 'applications' ? <Text type="supporting" color="secondary">{value}</Text> : null}
                </span>
                <IconButton label={`${copy.remove} ${value}`} tooltip={`${copy.remove} ${value}`} icon={<X size={16} aria-hidden />} variant="ghost" isDisabled={disabled} onClick={() => removeSource(value)} />
              </li>
            ))}
          </ul>
          {status && sources.length === 0 ? <Text type="supporting" color="secondary">{source === 'applications' ? copy.noApps : copy.noWebsites}</Text> : null}
        </div>
      </SettingsSection>
      <SettingsSection title={copy.data}>
        <SettingsRow label={copy.retention} description={copy.retentionHelp} end={copy.retentionValue} />
        <SettingsRow label={copy.events} end={status ? status.eventCount.toLocaleString(locale) : '—'} />
        <SettingsRow label={copy.suppressed} end={status ? status.suppressedEventCount.toLocaleString(locale) : '—'} />
        <SettingsRow label={copy.segments} end={status ? status.segmentCount.toLocaleString(locale) : '—'} />
        <SettingsRow label={copy.latest} end={status?.newestEventAt ? new Date(status.newestEventAt).toLocaleString(locale) : status ? copy.none : '—'} />
        <SettingsField>
          <div className="computer-history-settings-delete">
            <Selector label={copy.clearScope} value={scope} options={Object.entries(copy.periods).map(([value, label]) => ({ value, label }))} onChange={(value) => { if (value in copy.periods) setScope(value as ComputerHistoryClearScope); }} isDisabled={busy} />
            <Button label={copy.clear} icon={<Trash2 size={16} aria-hidden />} variant="destructive" size="sm" isDisabled={busy} onClick={() => setConfirmScope(scope)} />
          </div>
        </SettingsField>
      </SettingsSection>
      <AlertDialog
        ref={deleteDialogRef}
        isOpen={confirmScope !== null}
        onOpenChange={(open) => { if (!open && !busy) setConfirmScope(null); }}
        title={copy.confirmTitle}
        description={`${confirmScope ? copy.periods[confirmScope] : ''}. ${copy.confirmHelp}${controller.actionError || controller.statusError ? `\n${copy.actionFailed} ${controller.actionError || controller.statusError}` : ''}`}
        cancelLabel={copy.cancel}
        actionLabel={copy.confirm}
        isActionLoading={pending === 'clear'}
        onAction={() => {
          if (!confirmScope || busy) return;
          // The action becomes disabled while saving; retain focus on Cancel.
          deleteDialogRef.current?.querySelector<HTMLButtonElement>('button[data-autofocus]')?.focus({ preventScroll: true });
          void confirm(() => controller.clear(confirmScope), copy.deleted).then((saved) => { if (saved) setConfirmScope(null); });
        }}
      />
    </SettingsPage>
  );
}
