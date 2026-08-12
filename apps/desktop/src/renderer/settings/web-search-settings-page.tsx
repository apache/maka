import { useRef, useState } from 'react';
import { Banner, EmptyState, Link } from '@astryxdesign/core';
import type { AppSettings, UpdateAppSettingsResult } from '@maka/core/settings';
import type { WebSearchCredentialStatus } from '@maka/core/web-search';
import { normalizeSearchUrl } from '@maka/core/search';
import { webSearchCredentialStatusFromResponse } from '@maka/core/web-search';
import { Button, Selector, StatusDot, TextInput, RelativeTime, Switch, redactSecrets, useMountedRef, useToast, useUiLocale } from '@maka/ui';
import { getWebSearchSettingsCopy, type WebSearchSettingsCopy } from '../locales/settings-web-search-copy';
import { getSettingsSharedCopy } from '../locales/settings-shared-copy.js';
import { SettingsActions, SettingsField, SettingsPage, SettingsRow, SettingsSection } from './settings-section';
import { PasswordInput } from './password-input';
import { settingsActionErrorMessage } from './settings-error-copy';
import { dotForStatus, type StatusSemantic } from '@maka/ui';
import { useKeyedActionGuard } from './use-action-guard';

/**
 * PR-WEB-SEARCH-TAVILY-0: Settings → Web search.
 *
 * Current provider support is Tavily only. Renderer never sees the cleartext API
 * key — `props.settings.webSearch.providers.tavily.apiKey` arrives
 * pre-masked from the IPC store boundary (the bullet sentinel
 * `MASKED_TOKEN_SENTINEL`). Re-submitting the sentinel is treated as
 * "keep current" in `mergeWebSearchSettings`.
 *
 * The test button calls Runtime Host `web-search.execute` (a Tavily request)
 * and surfaces ok/fail via toast. The live-query verifier runs a real query
 * and renders 3-5 plain-text rows.
 */
export function WebSearchSettingsPage(props: {
  settings: AppSettings;
  onUpdate(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
}) {
  const locale = useUiLocale();
  const copy = getWebSearchSettingsCopy(locale);
  const sharedCopy = getSettingsSharedCopy(locale);
  const webSearch = props.settings.webSearch;
  const usingModelSearch = webSearch.defaultProvider === 'model';
  const tavily = webSearch.providers.tavily;
  const tavilyKey = tavily.apiKey;
  const credentialSource = tavily.credentialSource;
  const usingEnvKey = credentialSource === 'env';
  const [draftKey, setDraftKey] = useState('');
  const [pendingWebSearchEnabled, setPendingWebSearchEnabled] = useState(false);
  const [pendingCredentialAction, setPendingCredentialAction] = useState<'save' | 'clear' | null>(null);
  const [testing, setTesting] = useState(false);
  const [liveQuery, setLiveQuery] = useState('');
  const [liveQueryRunning, setLiveQueryRunning] = useState(false);
  const [liveQueryResults, setLiveQueryResults] = useState<readonly { title: string; url: string; snippet: string; source: string }[] | null>(null);
  const [liveQueryError, setLiveQueryError] = useState<string | null>(null);
  const webSearchMountedRef = useMountedRef();
  const webSearchActionGuard = useKeyedActionGuard<'set-enabled' | 'credential' | 'test' | 'live-query'>();
  const liveQueryInputRef = useRef(liveQuery);
  const toast = useToast();

  function updateLiveQuery(next: string) {
    liveQueryInputRef.current = next;
    setLiveQuery(next);
    setLiveQueryError(null);
    setLiveQueryResults(null);
  }

  function isCurrentLiveQuery(queryOwner: string): boolean {
    return webSearchMountedRef.current && liveQueryInputRef.current === queryOwner;
  }

  async function runCredentialAction(action: 'save' | 'clear', run: () => Promise<void>) {
    if (webSearchActionGuard.has('credential') || webSearchActionGuard.has('test')) return;
    const releaseCredential = webSearchActionGuard.begin('credential');
    if (!releaseCredential) return;
    setPendingCredentialAction(action);
    try {
      await run();
    } finally {
      releaseCredential();
      if (webSearchMountedRef.current) {
        setPendingCredentialAction(null);
      }
    }
  }

  async function updateWebSearch(
    patch: NonNullable<Parameters<typeof window.maka.settings.update>[0]['webSearch']>,
    failureTitle = copy.saveFailed,
  ): Promise<boolean> {
    try {
      await props.onUpdate({ webSearch: patch });
      return true;
    } catch (error) {
      if (webSearchMountedRef.current) {
        toast.error(failureTitle, settingsActionErrorMessage(error, locale));
      }
      return false;
    }
  }

  async function setEnabled(enabled: boolean) {
    const releaseEnabled = webSearchActionGuard.begin('set-enabled');
    if (!releaseEnabled) return;
    setPendingWebSearchEnabled(true);
    try {
      await updateWebSearch({ enabled });
    } finally {
      releaseEnabled();
      if (webSearchMountedRef.current) {
        setPendingWebSearchEnabled(false);
      }
    }
  }

  async function persistCredentialStatus(status: WebSearchCredentialStatus, credentialVersion: number): Promise<boolean> {
    return updateWebSearch(
      {
        providers: {
          tavily: {
            credentialVersion,
            credentialStatus: status,
            credentialCheckedAt: new Date().toISOString(),
          },
        },
      },
      copy.saveStatusFailed,
    );
  }

  async function saveDraftKey() {
    if (usingEnvKey || draftKey.length === 0) return;
    await runCredentialAction('save', async () => {
      const saved = await updateWebSearch({ providers: { tavily: { apiKey: draftKey } } });
      if (!saved) return;
      if (!webSearchMountedRef.current) return;
      setDraftKey('');
      toast.success(copy.keySaved, copy.keySavedDetail);
    });
  }

  async function clearKey() {
    await runCredentialAction('clear', async () => {
      const saved = await updateWebSearch({ enabled: false, providers: { tavily: { apiKey: '' } } });
      if (!saved) return;
      if (!webSearchMountedRef.current) return;
      setDraftKey('');
      toast.success(copy.credentialsCleared, copy.credentialsClearedDetail);
    });
  }

  async function runTest() {
    if (webSearchActionGuard.has('test') || webSearchActionGuard.has('credential')) return;
    const releaseTest = webSearchActionGuard.begin('test');
    if (!releaseTest) return;
    setTesting(true);
    const usesDraftKey = !usingModelSearch && draftKey.trim().length > 0;
    const testedCredentialVersion = tavily.credentialVersion;
    try {
      const result = await window.maka.webSearch.test({
        provider: webSearch.defaultProvider,
        apiKey: usesDraftKey ? draftKey : undefined,
      });
      if (!webSearchMountedRef.current) return;
      if (!usingModelSearch && !usesDraftKey && hasUsableKey) {
        void persistCredentialStatus(webSearchCredentialStatusFromResponse(result), testedCredentialVersion);
      }
      if (result.ok) {
        toast.success(copy.credentialValid, copy.resultCount(result.results.length));
      } else {
        toast.error(copy.testFailed, copy.errors[result.reason]);
      }
    } catch (err) {
      if (webSearchMountedRef.current) {
        toast.error(copy.testError, settingsActionErrorMessage(err, locale));
      }
    } finally {
      releaseTest();
      if (webSearchMountedRef.current) {
        setTesting(false);
      }
    }
  }

  async function runLiveQuery() {
    if (webSearchActionGuard.has('live-query')) return;
    const queryOwner = liveQueryInputRef.current;
    const trimmed = queryOwner.trim();
    if (trimmed.length === 0) return;
    const releaseLiveQuery = webSearchActionGuard.begin('live-query');
    if (!releaseLiveQuery) return;
    setLiveQueryRunning(true);
    setLiveQueryError(null);
    setLiveQueryResults(null);
    const queriedCredentialVersion = tavily.credentialVersion;
    try {
      const result = await window.maka.webSearch.query({
        provider: webSearch.defaultProvider,
        query: trimmed,
        limit: 5,
      });
      if (!isCurrentLiveQuery(queryOwner)) return;
      if (result.ok) {
        setLiveQueryResults(result.results);
        if (!usingModelSearch && hasUsableKey) {
          void persistCredentialStatus('valid', queriedCredentialVersion);
        }
      } else {
        setLiveQueryError(copy.errors[result.reason]);
        if (!usingModelSearch && hasUsableKey) {
          void persistCredentialStatus(webSearchCredentialStatusFromResponse(result), queriedCredentialVersion);
        }
      }
    } catch (err) {
      if (isCurrentLiveQuery(queryOwner)) {
        setLiveQueryError(settingsActionErrorMessage(err, locale));
      }
    } finally {
      releaseLiveQuery();
      if (webSearchMountedRef.current) {
        setLiveQueryRunning(false);
      }
    }
  }

  const hasStoredKey = tavilyKey.length > 0;
  const hasUsableKey = hasStoredKey || usingEnvKey;
  const hasUsableProvider = usingModelSearch || hasUsableKey;
  const statusCopy = usingModelSearch
    ? {
        label: webSearch.enabled ? copy.statuses.modelEnabled : copy.statuses.modelDisabled,
        // Verified-and-on is proven health, which is what success is for.
        // Off stays amber (`attention`) exactly as before — it was never one of
        // the ruled `info` states, and this pass repaints nothing it did not name.
        tone: webSearch.enabled ? ('success' as const) : ('attention' as const),
      }
    : presentWebSearchCredentialStatus(
        credentialSource,
        webSearch.enabled,
        tavily.credentialStatus,
        copy,
      );
  const queryDisabledReason = webSearchQueryDisabledReason({
    hasUsableKey: hasUsableProvider,
    enabled: webSearch.enabled,
    query: liveQuery,
    copy,
  });
  const checkedAtMs = tavily.credentialCheckedAt
    ? Date.parse(tavily.credentialCheckedAt)
    : Number.NaN;
  const hasCheckedAt = !usingModelSearch && Number.isFinite(checkedAtMs);
  const credentialActionBusy = pendingCredentialAction !== null || testing;

  return (
    <SettingsPage>
      <SettingsSection
        title={sharedCopy.groups.searchProvider}
        description={sharedCopy.groups.searchProviderHelp}
      >
        <SettingsRow
          label={copy.provider}
          description={copy.providerHelp}
          end={<Selector
            value={webSearch.defaultProvider}
            label={copy.provider}
            isLabelHidden
            options={[
              { value: 'model', label: copy.providerModel },
              { value: 'tavily', label: copy.providerTavily },
            ]}
            onChange={(value) =>
              void updateWebSearch({
                defaultProvider: value === 'tavily' ? 'tavily' : 'model',
              })
            }
          />}
        />
        <SettingsRow
          label={copy.enabled}
          description={copy.enabledHelp}
          align="start"
          end={<div className="settingsWebSearchControlCluster">
            <div className="settingsWebSearchStatusCluster" role="group" aria-label={copy.statusAria}>
              <span className="settingsStatus">
                <StatusDot variant={dotForStatus(statusCopy.tone)} label={statusCopy.label} />
                <span>{statusCopy.label}</span>
              </span>
              {hasCheckedAt && (
                <small>
                  {copy.lastTest}<RelativeTime ts={checkedAtMs} />
                </small>
              )}
              <small>
                {usingModelSearch
                  ? copy.sources.model
                  : presentWebSearchCredentialSource(credentialSource, hasStoredKey, copy)}
              </small>
            </div>
            <Switch
              label={copy.enabledAria}
              isLabelHidden
              value={webSearch.enabled}
              isDisabled={!hasUsableProvider || pendingWebSearchEnabled}
              onChange={(enabled) => void setEnabled(enabled)}
            />
          </div>}
        />

        {!usingModelSearch && <>{/* The key was an input squeezed into the row's end slot with the
            actions posing as a second labeled row. Astryx's own form idiom:
            a full-width credential Field, then the section's one action
            cluster (save primary, test secondary, clear ghost). */}
        <SettingsField>
          <PasswordInput
            value={draftKey}
            onChange={setDraftKey}
            isDisabled={usingEnvKey || credentialActionBusy}
            placeholder={usingEnvKey ? copy.envPlaceholder : hasStoredKey ? copy.storedPlaceholder : copy.keyPlaceholder}
            label={copy.key}
            description={usingEnvKey ? copy.envKeyHelp : copy.savedKeyHelp}
          />
          {!usingEnvKey && (
            <small className="settingsQuietStatus">
              <Link href="https://tavily.com" target="_blank" rel="noreferrer noopener">tavily.com</Link>
            </small>
          )}
        </SettingsField>

        <SettingsActions role="group" aria-label={copy.actions}>
          <Button
            variant="primary"
            isDisabled={credentialActionBusy || usingEnvKey || draftKey.length === 0}
            onClick={() => void saveDraftKey()}
            label={pendingCredentialAction === 'save' ? copy.saving : copy.saveKey}
          />
          <Button
            variant="secondary"
            isDisabled={credentialActionBusy || (draftKey.length === 0 && !hasUsableKey)}
            onClick={() => void runTest()}
            label={testing ? copy.testing : copy.testKey}
          />
          {hasStoredKey && (
            <Button
              variant="ghost"
              isDisabled={credentialActionBusy}
              onClick={() => void clearKey()}
              label={pendingCredentialAction === 'clear' ? copy.clearing : copy.clearKey}
            />
          )}
        </SettingsActions>
        </>}
        {usingModelSearch && (
          <SettingsRow label={copy.modelCredential} description={copy.modelCredentialHelp} />
        )}
      </SettingsSection>

      {!usingModelSearch && (
        <SettingsSection
          title={sharedCopy.groups.searchBehavior}
          description={sharedCopy.groups.searchBehaviorHelp}
        >
          {/* UX audit (owner msg `30f736ed`): one action wore three labels.
              Keep one label on the full-width query field. */}
          <SettingsField>
            <TextInput
              value={liveQuery}
              onChange={(value) => updateLiveQuery(value)}
              placeholder={copy.queryPlaceholder}
              label={copy.testSearch}
              description={copy.testSearchHelp}
              width="100%"
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !liveQueryRunning) {
                  event.preventDefault();
                  void runLiveQuery();
                }
              }}
            />
          </SettingsField>
          <SettingsActions>
            <div className="settingsWebSearchSearchControls">
              <Button
                variant="primary"
                isLoading={liveQueryRunning}
                isDisabled={queryDisabledReason !== null}
                onClick={() => void runLiveQuery()}
                label={copy.search}
              />
              {!liveQueryRunning && queryDisabledReason && (
                <small className="settingsWebSearchDisabledReason">{queryDisabledReason}</small>
              )}
            </div>
          </SettingsActions>
        </SettingsSection>
      )}

      {liveQueryError && (
        <Banner status="error" role="alert" title={copy.queryFailed(liveQueryError)} />
      )}
      {(() => {
        // PR-SETTINGS-WEB-SEARCH-URL-HARDEN-0: match the chat-side
        // WebSearchPreview hardening (xuan `e511aa5`): the renderer
        // does NOT trust raw URLs / text coming back over IPC even
        // though the main-process Tavily client filters first. Drop
        // non-http(s) / malformed rows and redact every text cell
        // before it reaches the DOM.
        const safeRows: ReadonlyArray<{ title: string; url: string; source: string; snippet: string }> | null =
          liveQueryResults
            ? liveQueryResults
                .map((row) => {
                  const normalized = normalizeSearchUrl(row.url);
                  if (!normalized.ok) return null;
                  return {
                    title: redactSecrets(row.title),
                    url: redactSecrets(normalized.value),
                    source: redactSecrets(row.source),
                    snippet: redactSecrets(row.snippet),
                  };
                })
                .filter(
                  (
                    row,
                  ): row is { title: string; url: string; source: string; snippet: string } =>
                    row !== null,
                )
            : null;
        if (safeRows && safeRows.length === 0 && !liveQueryError) {
          return <EmptyState isCompact title={copy.noResults} />;
        }
        if (safeRows && safeRows.length > 0) {
          return (
            <ul className="settingsWebSearchResults" aria-label={copy.resultsAria}>
              {safeRows.map((row, idx) => (
                <li key={`${row.url}-${idx}`} className="settingsWebSearchResult">
                  <Link href={row.url} target="_blank" rel="noreferrer noopener">{row.title}</Link>
                  <small>{row.source}</small>
                  <p>{row.snippet}</p>
                </li>
              ))}
            </ul>
          );
        }
        return null;
      })()}
    </SettingsPage>
  );
}

function webSearchQueryDisabledReason(input: { hasUsableKey: boolean; enabled: boolean; query: string; copy: WebSearchSettingsCopy }): string | null {
  if (!input.hasUsableKey) return input.copy.disabledReasons.noKey;
  if (!input.enabled) return input.copy.disabledReasons.disabled;
  if (input.query.trim().length === 0) return input.copy.disabledReasons.noQuery;
  return null;
}

function presentWebSearchCredentialStatus(
  credentialSource: AppSettings['webSearch']['providers']['tavily']['credentialSource'],
  enabled: boolean,
  status: WebSearchCredentialStatus,
  copy: WebSearchSettingsCopy,
): { label: string; tone: StatusSemantic } {
  if (credentialSource === 'none') return { label: copy.statuses.not_configured, tone: 'attention' };
  if (status === 'valid') {
    return enabled
      ? { label: copy.statuses.validEnabled, tone: 'success' }
      // Valid credentials, feature off: a fact the user set, not a problem.
      : { label: copy.statuses.validDisabled, tone: 'neutral' };
  }
  if (status === 'invalid_credentials') return { label: copy.statuses.invalid_credentials, tone: 'error' };
  if (status === 'rate_limited') return { label: copy.statuses.rate_limited, tone: 'attention' };
  if (status === 'timeout') return { label: copy.statuses.timeout, tone: 'attention' };
  if (status === 'network_error') return { label: copy.statuses.network_error, tone: 'attention' };
  if (status === 'not_configured') return { label: copy.statuses.not_configured, tone: 'attention' };
  return enabled
    ? { label: copy.statuses.unknownEnabled, tone: 'attention' }
    // Configured but never tested: setup is unfinished, and the amber says so.
    // Testing moves it to success or error, completing the narrative; neutral
    // would read as "all set" and break that story.
    : { label: copy.statuses.untested, tone: 'attention' };
}

function presentWebSearchCredentialSource(
  credentialSource: AppSettings['webSearch']['providers']['tavily']['credentialSource'],
  hasStoredKey: boolean,
  copy: WebSearchSettingsCopy,
): string {
  if (credentialSource === 'env') {
    return hasStoredKey ? copy.sources.envWithSaved : copy.sources.env;
  }
  if (credentialSource === 'saved') return copy.sources.saved;
  return copy.sources.none;
}
