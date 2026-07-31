/**
 * Source contract for ArtifactPane async list lifecycle.
 *
 * The pane follows the active chat session. If a stale `artifacts.list()`
 * response from the previous session lands after the user has switched
 * sessions, it must not overwrite the current session's artifact list.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererContractCss } from './contract-css-helpers.js';

const ARTIFACT_PANE_SOURCE = join(process.cwd(), 'src', 'renderer', 'artifact-pane.tsx');

describe('ArtifactPane async lifecycle contract', () => {
  it('drops stale artifact list responses when the active session changes', async () => {
    const src = await readFile(ARTIFACT_PANE_SOURCE, 'utf8');
    const css = await readRendererContractCss();
    const refreshBlock = src.match(/const refresh = useCallback\(async \(\) => \{[\s\S]*?\}, \[[^\]]*sessionId[^\]]*toast[^\]]*\]\);/)?.[0] ?? '';
    const subscriptionEffect = src.match(/useEffect\(\(\) => \{[\s\S]*?window\.maka\.artifacts\.subscribeChanges[\s\S]*?\}, \[sessionId, refresh\]\);/)?.[0] ?? '';
    const retryBlock = src.match(/async function retryArtifactListRefresh[\s\S]*?async function openInFinder/)?.[0] ?? '';

    assert.match(
      src,
      /const artifactListRequestSeqRef = useRef\(0\)/,
      'ArtifactPane must keep a monotonic request sequence across renders',
    );
    assert.match(
      src,
      /const artifactPaneMountedRef = useMountedRef\(\)/,
      'ArtifactPane must track whether async artifact work still owns a mounted surface',
    );
    assert.match(
      src,
      /const artifactPaneSessionIdRef = useRef<string \| undefined>\(sessionId\);[\s\S]*artifactPaneSessionIdRef\.current = sessionId;/,
      'ArtifactPane must track the latest active session so async action continuations cannot update a stale chat surface',
    );
    assert.match(
      src,
      /useEffect\(\(\) => \{[\s\S]*return \(\) => \{[\s\S]*artifactListRequestSeqRef\.current \+= 1;[\s\S]*pendingArtifactListRetryRef\.current = false;[\s\S]*pendingArtifactActionRef\.current = null;[\s\S]*\};[\s\S]*\}, \[\]\)/,
      'ArtifactPane unmount must invalidate list responses, release pending owners, and be StrictMode replay safe',
    );
    assert.match(
      src,
      /const recordsSessionIdRef = useRef<string \| undefined>\(undefined\)/,
      'ArtifactPane must track which session owns the currently rendered records',
    );
    assert.match(
      refreshBlock,
      /const requestSeq = \+\+artifactListRequestSeqRef\.current/,
      'each artifact list refresh must claim a fresh request sequence',
    );
    assert.match(
      refreshBlock,
      /const next = await window\.maka\.artifacts\.list\(sessionId, \{\s*includeDeleted: true,?\s*\}\)[\s\S]*if \(artifactPaneMountedRef\.current && requestSeq === artifactListRequestSeqRef\.current\) \{[\s\S]*recordsSessionIdRef\.current = sessionId[\s\S]*setRecordsSessionId\(sessionId\)[\s\S]*setRecords\(next\)/,
      'artifact list responses may set records only if the pane is still mounted and they are still the latest request',
    );
    assert.match(
      refreshBlock,
      /catch \(error\) \{[\s\S]*if \(artifactPaneMountedRef\.current && requestSeq === artifactListRequestSeqRef\.current\) \{[\s\S]*const message = artifactActionErrorMessage\(error, locale, copy\);[\s\S]*setListError\(\{ sessionId, message \}\)[\s\S]*recordsSessionIdRef\.current !== sessionId[\s\S]*setRecords\(\[\]\)[\s\S]*toast\.error\(copy\.pane\.refreshFailed, message\)/,
      'artifact list failures must update UI only while mounted and only for the latest request',
    );
    assert.match(
      src,
      /const activeRecords = useMemo\([\s\S]*recordsSessionId === sessionId \? filterUserVisibleArtifacts\(records\) : \[\][\s\S]*\[records, recordsSessionId, sessionId\]/,
      'rendering must filter artifact records by the current active session id and generated-file visibility policy',
    );
    assert.doesNotMatch(
      src,
      /if \(!sessionId \|\| records\.length === 0\)/,
      'the pane must not render or hide from unscoped records',
    );
    assert.doesNotMatch(src, /return null;/, 'the Files tab owns the empty state, so ArtifactPane must stay mounted and report a zero count');
    assert.match(src, /props\.onCountChange\?\.\(activeRecords\.length\)/, 'ArtifactPane must report the current tab count from its authoritative filtered list');
    assert.match(
      src,
      /setSelectedId\(preferredArtifactSelectionId\(activeRecords\)\)/,
      'artifact selection fallback must route through the live-first helper',
    );
    assert.match(
      src,
      /function preferredArtifactSelectionId\(records: readonly ArtifactRecord\[\]\): string \| null \{[\s\S]*records\.find\(\(record\) => record\.status !== 'deleted'\) \?\? records\[0\]/,
      'selection fallback must prefer a live artifact while keeping deleted tombstones selectable when explicitly chosen',
    );
    assert.match(
      src,
      /activeListError && \([\s\S]*className="maka-artifact-list-error"[\s\S]*copy\.pane\.listLoadFailed[\s\S]*copy\.pane\.retry/,
      'current-session artifact list failures must render an inline retryable error instead of making the pane disappear',
    );
    assert.match(src, /const \[pendingArtifactListRetry, setPendingArtifactListRetry\] = useState\(false\)/);
    assert.match(src, /const pendingArtifactListRetryRef = useRef\(false\)/);
    assert.match(
      retryBlock,
      /if \(pendingArtifactListRetryRef\.current\) return;[\s\S]*pendingArtifactListRetryRef\.current = true[\s\S]*setPendingArtifactListRetry\(true\)[\s\S]*await refresh\(\)[\s\S]*pendingArtifactListRetryRef\.current = false[\s\S]*if \(artifactPaneMountedRef\.current\) setPendingArtifactListRetry\(false\)/,
      'manual artifact-list retry must use a ref-backed pending gate so repeated clicks cannot fan out list IPC calls',
    );
    assert.match(src, /onClick=\{\(\) => void retryArtifactListRefresh\(\)\}/);
    // #1565 PR 3: Astryx Button spells the disabled prop `isDisabled`.
    assert.match(src, /isDisabled=\{pendingArtifactListRetry\}/);
    assert.match(src, /aria-busy=\{pendingArtifactListRetry \? 'true' : undefined\}/);
    assert.match(src, /data-pending=\{pendingArtifactListRetry \? 'true' : undefined\}/);
    assert.match(src, /pendingArtifactListRetry \? copy\.pane\.retrying : copy\.pane\.retry/);
    assert.doesNotMatch(src, /className="maka-artifact-error-retry"/);
    assert.doesNotMatch(css, /\.maka-artifact-error-retry/);
    assert.doesNotMatch(src, /className="maka-artifact-error-retry"[\s\S]*onClick=\{\(\) => void refresh\(\)\}/);
    assert.match(
      subscriptionEffect,
      /return \(\) => \{[\s\S]*artifactListRequestSeqRef\.current \+= 1;[\s\S]*unsubscribe\(\);[\s\S]*\};/,
      'session-change cleanup must invalidate in-flight artifact list responses before unsubscribing',
    );
    assert.match(
      refreshBlock,
      /\}, \[[^\]]*copy[^\]]*locale[^\]]*sessionId[^\]]*toast[^\]]*\]\);/,
      'refresh must include localized copy, locale, session, and toast dependencies',
    );
  });

  it('surfaces thrown artifact action failures instead of leaving toolbar clicks silent', async () => {
    const src = await readFile(ARTIFACT_PANE_SOURCE, 'utf8');
    const openBlock = src.match(/async function openInFinder[\s\S]*?async function copyText/)?.[0] ?? '';
    const copyBlock = src.match(/async function copyText[\s\S]*?async function saveAs/)?.[0] ?? '';
    const saveBlock = src.match(/async function saveAs[\s\S]*?async function deleteArtifact/)?.[0] ?? '';
    const deleteBlock = src.match(/async function deleteArtifact[\s\S]*?\r?\n  \}\r?\n\r?\n  \/\/ ---- render/)?.[0] ?? '';

    assert.match(src, /function artifactActionErrorMessage\(error: unknown, locale: UiLocale, copy: ArtifactCopy\)/);
    assert.match(
      src,
      /function artifactActionErrorMessage\(error: unknown, locale: UiLocale, copy: ArtifactCopy\): string \{[\s\S]*redactSecrets\(error instanceof Error \? error\.message : String\(error \?\? ''\)\)\.trim\(\)/,
      'artifact action failures must redact raw IPC/file-system errors before toast detail',
    );
    assert.match(
      src,
      /generalizedErrorMessageChinese\(new Error\(raw\), ''\)/,
      'artifact action failures must classify raw English errors into Chinese copy',
    );
    assert.match(
      src,
      /generalizedErrorMessage\(new Error\(raw\), ''\)/,
      'artifact action failures must classify errors for English copy too',
    );
    assert.doesNotMatch(
      src,
      /if \(error instanceof Error && error\.message\.trim\(\)\) return error\.message\.trim\(\)/,
      'artifact action failure helper must not directly echo raw Error.message',
    );
    assert.match(openBlock, /catch \(error\) \{[\s\S]*toast\.error\(copy\.pane\.openFailed, artifactActionErrorMessage\(error, locale, copy\)\)/);
    assert.match(openBlock, /const actionSessionId = sessionId;[\s\S]*const result = await window\.maka\.app\.openArtifactPath\(artifactId\);[\s\S]*if \(!isArtifactActionSurfaceActive\(actionSessionId\)\) return;/);
    assert.match(copyBlock, /catch \(error\) \{[\s\S]*toast\.error\(copy\.pane\.copyFailed, artifactActionErrorMessage\(error, locale, copy\)\)/);
    assert.match(copyBlock, /const actionSessionId = sessionId;[\s\S]*const result = await window\.maka\.artifacts\.readText\(artifactId\);[\s\S]*if \(!isArtifactActionSurfaceActive\(actionSessionId\)\) return;[\s\S]*await navigator\.clipboard\.writeText\(result\.text\);[\s\S]*if \(!isArtifactActionSurfaceActive\(actionSessionId\)\) return;/);
    assert.match(saveBlock, /catch \(error\) \{[\s\S]*toast\.error\(copy\.pane\.saveFailed, artifactActionErrorMessage\(error, locale, copy\)\)/);
    assert.match(saveBlock, /const actionSessionId = sessionId;[\s\S]*const result = await window\.maka\.app\.saveArtifactAs\(artifactId\);[\s\S]*if \(!isArtifactActionSurfaceActive\(actionSessionId\)\) return;/);
    assert.match(deleteBlock, /catch \(error\) \{[\s\S]*toast\.error\(copy\.pane\.deleteFailed\(name\), artifactActionErrorMessage\(error, locale, copy\)\)/);
    assert.match(deleteBlock, /const actionSessionId = sessionId;[\s\S]*if \(!isArtifactActionSurfaceActive\(actionSessionId\)\) return;[\s\S]*await window\.maka\.artifacts\.delete\(artifactId\);[\s\S]*await refresh\(\);[\s\S]*if \(!isArtifactActionSurfaceActive\(actionSessionId\)\) return;/);
  });

  it('drops stale artifact action continuations after switching sessions', async () => {
    const src = await readFile(ARTIFACT_PANE_SOURCE, 'utf8');
    const actionOwnerBlock = src.match(/function isArtifactActionSurfaceActive[\s\S]*?async function openInFinder/)?.[0] ?? '';

    assert.match(
      actionOwnerBlock,
      /function isArtifactActionSurfaceActive\(actionSessionId: string \| undefined\): boolean \{[\s\S]*actionSessionId &&[\s\S]*artifactPaneMountedRef\.current &&[\s\S]*artifactPaneSessionIdRef\.current === actionSessionId &&[\s\S]*recordsSessionIdRef\.current === actionSessionId/,
      'artifact actions must verify both the mounted surface and the active records session before post-await side effects',
    );
    assert.doesNotMatch(
      src,
      /await navigator\.clipboard\.writeText\(result\.text\);[\s\S]*if \(!artifactPaneMountedRef\.current\) return;/,
      'copy must not write stale artifact text just because the pane component remains mounted',
    );
  });

  it('gates artifact toolbar actions while async work is pending', async () => {
    const src = await readFile(ARTIFACT_PANE_SOURCE, 'utf8');
    const css = await readRendererContractCss();
    const gateBlock = src.match(/async function runArtifactAction[\s\S]*?async function openInFinder/)?.[0] ?? '';
    const toolbarBlock = src.match(/<Toolbar className="maka-artifact-toolbar"[\s\S]*?\n            <\/Toolbar>/)?.[0] ?? '';

    assert.match(src, /const \[pendingArtifactAction, setPendingArtifactAction\] = useState<string \| null>\(null\)/);
    assert.match(src, /const pendingArtifactActionRef = useRef<string \| null>\(null\)/);
    assert.match(src, /const artifactPaneMountedRef = useMountedRef\(\)/);
    assert.match(src, /const artifactActionBusy = pendingArtifactAction !== null/);
    assert.match(
      gateBlock,
      /if \(pendingArtifactActionRef\.current !== null\) return;[\s\S]*pendingArtifactActionRef\.current = actionKey[\s\S]*setPendingArtifactAction\(actionKey\)[\s\S]*await action\(\)[\s\S]*pendingArtifactActionRef\.current = null[\s\S]*if \(artifactPaneMountedRef\.current\) setPendingArtifactAction\(null\)/,
      'Artifact actions must use a ref-backed pending gate so same-frame double clicks cannot run two IPC calls',
    );
    assert.match(
      src,
      /onShowInFolder=\{\(\) => void runArtifactAction\(`\$\{selected\.id\}:open`, \(\) => openInFinder\(selected\.id\)\)\}/,
      'Unsupported-preview Finder action must share the same pending gate as the toolbar button',
    );
    assert.match(src, /import \{[^}]*\bButton\b[^}]*\bToolbar\b[^}]*\bToolbarGroup\b[^}]*\bToolbarSeparator\b[^}]*\buseToast\b[^}]*\} from '@maka\/ui';/);
    assert.match(
      toolbarBlock,
      /<Toolbar className="maka-artifact-toolbar" aria-label=\{copy\.pane\.actionsAria\}>[\s\S]*<ToolbarGroup className="maka-artifact-toolbar-group">[\s\S]*<ToolbarSeparator className="maka-artifact-toolbar-separator" orientation="vertical" \/>[\s\S]*<ToolbarGroup className="maka-artifact-toolbar-group maka-artifact-toolbar-danger-group">/,
      'Artifact toolbar must use the shared primitive Toolbar shell while keeping actions grouped',
    );
    for (const action of ['open', 'save', 'copy', 'delete']) {
      assert.ok(
        toolbarBlock.includes(`runArtifactAction(\`\${selected.id}:${action}\``),
        `${action} action must run through the pending gate`,
      );
    }
    // #1565 PR 3: Astryx Button spells the disabled prop `isDisabled`.
    assert.match(toolbarBlock, /isDisabled=\{artifactActionBusy\}/, 'toolbar buttons must be disabled while any artifact action is pending');
    assert.match(toolbarBlock, /aria-busy=\{pendingArtifactAction === `\$\{selected\.id\}:open` \? 'true' : undefined\}/);
    assert.match(toolbarBlock, /copy\.pane\.opening/);
    assert.match(toolbarBlock, /copy\.pane\.saving/);
    assert.match(toolbarBlock, /copy\.pane\.copying/);
    assert.match(toolbarBlock, /copy\.pane\.deleting/);
    assert.doesNotMatch(css, /\.maka-artifact-toolbar-button\b/, 'artifact actions must not restore consumer-owned Button states');
    assert.match(toolbarBlock, /variant="secondary"\s+size="sm"/);
    // #1565 PR 3: the delete action is a Tooltip render-prop composition kept on
    // legacy buttonVariants; lock the source form instead of JSX props.
    assert.match(toolbarBlock, /buttonVariants\(\{ variant: 'destructive', size: 'icon-sm' \}\)/);
  });
});
