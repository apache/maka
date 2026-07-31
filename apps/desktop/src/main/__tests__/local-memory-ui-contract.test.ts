import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererContractCss } from './contract-css-helpers.js';
import { readSettingsCombinedSource } from './settings-contract-source-helpers.js';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';

const REPO_ROOT = join(process.cwd(), '..', '..');

async function readRepo(path: string): Promise<string> {
  return readFile(join(REPO_ROOT, path), 'utf8');
}

describe('local MEMORY.md Settings UI contract', () => {
  it('wires every behavior-bearing controller output at the page composition root', async () => {
    const page = await readRepo('apps/desktop/src/renderer/settings/memory-settings-page.tsx');

    assert.match(page, /<WorkspaceInstructionsSection[\s\S]*state=\{workspaceInstructions\.state\}[\s\S]*disabled=\{memoryControlsDisabled\}[\s\S]*isActionPending=\{workspaceInstructions\.isActionPending\}[\s\S]*onOpen=\{workspaceInstructions\.openFile\}[\s\S]*onCreate=\{workspaceInstructions\.createFile\}/);
    assert.match(page, /<MemoryPromptPreviewSection[\s\S]*active=\{promptPreviewWillInject\}[\s\S]*preview=\{localMemoryPromptPreview\}[\s\S]*budgetLabel=\{localMemoryPromptPreviewBudgetLabel\}[\s\S]*blockedReason=\{promptPreviewBlockedReason\}[\s\S]*safeMode=\{effective\.status === 'safe_mode'\}[\s\S]*copyPending=\{isMemoryActionPending\('memory:prompt-preview:copy'\)\}[\s\S]*onCopy=\{copyLocalMemoryPromptPreview\}/);

    const entryLists = [...page.matchAll(/<MemoryEntryList[\s\S]*?\/>/g)].map((match) => match[0]);
    assert.equal(entryLists.length, 2, 'active and archived entry lists must both be wired');
    for (const list of entryLists) {
      assert.match(list, /filtered=\{normalizedMemoryEntryQuery\.length > 0\}/);
      assert.match(list, /draftDirty=\{memoryDraftDirty\}/);
      assert.match(list, /busy=\{memoryControlsDisabled \|\| effective\.status === 'incognito_blocked' \|\| !effective\.enabled\}/);
      assert.match(list, /pendingCopyIds=\{pendingMemoryActions\}/);
      assert.match(list, /onCopyReference=\{copyMemoryEntryReference\}/);
      assert.match(list, /onFocusDraft=\{focusMemoryEntryInDraft\}/);
      assert.match(list, /onStatusChange=\{updateMemoryEntryStatus\}/);
    }
    const [activeList, archivedList] = entryLists;
    assert.match(activeList, /title=\{copy\.text\.activeMemories\}/);
    assert.match(activeList, /copy=\{copy\}/);
    assert.match(activeList, /entries=\{filteredActiveEntries\}/);
    assert.doesNotMatch(activeList, /\n\s+archived(?:\s|\n)/);
    assert.match(archivedList, /title=\{copy\.text\.archivedMemories\}/);
    assert.match(archivedList, /copy=\{copy\}/);
    assert.match(archivedList, /entries=\{filteredArchivedEntries\}/);
    assert.match(archivedList, /\n\s+archived(?:\s|\n)/);
  });

  it('renders active and archived memory entries as separate visible groups', async () => {
    const src = await readSettingsCombinedSource();

    assert.match(src, /<MemoryEntryList[\s\S]*title=\{copy\.text\.activeMemories\}[\s\S]*entries=\{filteredActiveEntries\}/);
    assert.match(src, /<MemoryEntryList[\s\S]*title=\{copy\.text\.archivedMemories\}[\s\S]*entries=\{filteredArchivedEntries\}[\s\S]*archived/);
    assert.match(src, /<div className="settingsMemoryManualAdd" role="group" aria-label=\{copy\.text\.manualAddAria\}>/);
    assert.doesNotMatch(src, /<div className="settingsMemoryManualAdd" aria-label=\{copy\.text\.manualAddAria\}>/);
    assert.match(src, /visibleMemoryEntries\.archivedEntries\.length > 0/);
    assert.ok(src.includes("entry.tags.join(' / ')"));
  });

  it('renders stable entry metadata so local memory stays white-box', async () => {
    const src = await readSettingsCombinedSource();
    const css = await readRendererContractCss();
    const listBlock = src.match(/function MemoryEntryList\([\s\S]*?function filterLocalMemoryEntries/)?.[0] ?? '';

    assert.match(listBlock, /settingsMemoryEntryFacts/);
    assert.match(listBlock, /ID \{entry\.id\}/);
    assert.match(listBlock, /entry\.createdAt !== undefined/);
    assert.match(listBlock, /props\.copy\.text\.created\}<RelativeTime ts=\{entry\.createdAt\}/);
    assert.match(listBlock, /entry\.updatedAt !== undefined/);
    assert.match(listBlock, /props\.copy\.text\.updated\}<RelativeTime ts=\{entry\.updatedAt\}/);
    assert.match(listBlock, /settingsMemoryPromptScope/);
    assert.match(listBlock, /props\.copy\.text\.archivedNoPrompt/);
    assert.match(listBlock, /props\.copy\.text\.activePrompt/);
    assert.match(css, /\.settingsMemoryEntryFacts/);
    assert.match(css, /\.settingsMemoryPromptScope/);
  });

  it('can copy a stable memory entry reference for audit handoff', async () => {
    const src = await readSettingsCombinedSource();
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';
    const listBlock = src.match(/function MemoryEntryList\([\s\S]*?function filterLocalMemoryEntries/)?.[0] ?? '';

    assert.match(pageBlock, /async function copyMemoryEntryReference/);
    assert.match(pageBlock, /Memory entry: \$\{entry\.title\}/);
    assert.match(pageBlock, /ID: \$\{entry\.id\}/);
    assert.match(pageBlock, /Status: \$\{memoryEntryStatusLabel\(entry\.status, copy\)\}/);
    assert.match(pageBlock, /runMemoryAction\(`entry:\$\{entry\.id\}:copy`/);
    assert.match(pageBlock, /navigator\.clipboard\.writeText\(reference\)/);
    assert.match(pageBlock, /toast\.success\(copy\.text\.entryReferenceCopied, entry\.id\)/);
    assert.match(pageBlock, /toast\.error\(copy\.text\.copyFailed, copy\.text\.copyFailedDetail\)/);
    assert.match(listBlock, /onCopyReference/);
    assert.match(listBlock, /pendingCopyIds\?: ReadonlySet<string>/);
    assert.match(listBlock, /const copyPending = props\.pendingCopyIds\?\.has\(`entry:\$\{entry\.id\}:copy`\) \?\? false/);
    assert.match(listBlock, /isDisabled=\{copyPending\}/); // #1565 PR 3: Astryx Button uses isDisabled
    assert.match(listBlock, /copyPending \? props\.copy\.text\.copying : props\.copy\.text\.copyReference/);
    assert.match(src, /function memoryEntryStatusLabel/);
  });

  it('can focus a memory entry in the visible MEMORY.md draft editor', async () => {
    const src = await readSettingsCombinedSource();
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';
    const listBlock = src.match(/function MemoryEntryList\([\s\S]*?function filterLocalMemoryEntries/)?.[0] ?? '';

    assert.match(src, /findLocalMemoryEntryDraftRange/);
    assert.match(pageBlock, /function focusMemoryEntryInDraft/);
    assert.match(pageBlock, /findLocalMemoryEntryDraftRange\(draft, entry\.id\)/);
    assert.match(pageBlock, /editorRef\.current\?\.setSelectionRange\(range\.start, range\.end\)/);
    assert.match(pageBlock, /editorRef\.current\?\.scrollIntoView\(\{\s*block: 'center',\s*behavior: 'smooth',?\s*\}\)/);
    assert.match(pageBlock, /copy\.text\.locateFailed/);
    assert.match(listBlock, /onFocusDraft/);
    assert.match(listBlock, /props\.copy\.text\.locateDraft/);
  });

  it('previews the send-time memory prompt context from the core helper', async () => {
    const src = await readSettingsCombinedSource();
    const page = await readRepo('apps/desktop/src/renderer/settings/memory-settings-page.tsx');
    const css = await readRendererContractCss();
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(src, /LOCAL_MEMORY_PROMPT_MAX_CHARS/);
    assert.match(src, /buildLocalMemoryPromptBody/);
    assert.match(pageBlock, /const rawLocalMemoryPromptPreview = buildLocalMemoryPromptBody\(input\.draft\) \?\? ''/);
    assert.match(pageBlock, /localMemoryPromptPreviewBlockedReason\(effective, copy\)/);
    assert.match(pageBlock, /localMemoryPromptPreviewTruncated/);
    assert.match(pageBlock, /localMemoryPromptPreviewBudgetLabel/);
    assert.match(pageBlock, /copy\.previewTruncated\(LOCAL_MEMORY_PROMPT_MAX_CHARS\.toLocaleString\(copy\.intlLocale\)\)/);
    assert.match(pageBlock, /copy\.previewLimit\(LOCAL_MEMORY_PROMPT_MAX_CHARS\.toLocaleString\(copy\.intlLocale\)\)/);
    assert.match(pageBlock, /props\.copy\.text\.promptPreview/);
    assert.match(pageBlock, /props\.copy\.text\.willInject/);
    assert.match(pageBlock, /props\.copy\.text\.willNotInject/);
    assert.match(pageBlock, /props\.copy\.text\.promptPreviewHelp/);
    assert.match(pageBlock, /<pre>\{props\.preview\}<\/pre>/);
    assert.match(pageBlock, /async function copyLocalMemoryPromptPreview/);
    assert.match(pageBlock, /runMemoryAction\('memory:prompt-preview:copy'/);
    assert.match(pageBlock, /navigator\.clipboard\.writeText\(localMemoryPromptPreview\)/);
    assert.match(pageBlock, /copy\.text\.promptCopied/);
    assert.match(pageBlock, /props\.copyPending \? props\.copy\.text\.copying : props\.copy\.text\.copyContext/);
    assert.match(pageBlock, /isDisabled=\{!props\.preview \|\| props\.copyPending\}/); // #1565 PR 3
    assert.match(page, /preview=\{localMemoryPromptPreview\}/);
    assert.match(page, /onCopy=\{copyLocalMemoryPromptPreview\}/);
    assert.match(css, /\.settingsMemoryPromptPreview/);
    assert.match(css, /\.settingsMemoryPromptPreviewBudget/);
  });

  it('filters memory entries locally across title content id origin timestamps and tags', async () => {
    const src = await readSettingsCombinedSource();
    const css = await readRendererContractCss();
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(src, /function filterLocalMemoryEntries/);
    assert.match(src, /label=\{copy\.text\.filterAria\}[\s\S]*isLabelHidden/);
    assert.match(src, /placeholder=\{copy\.text\.filterPlaceholder\}/);
    assert.match(src, /setMemoryEntryQuery\(''\)/);
    assert.match(src, /copy\.text\.clear/);
    assert.match(pageBlock, /filteredEntryCount === 0/);
    assert.match(pageBlock, /settingsMemoryFilterEmpty/);
    assert.match(pageBlock, /copy\.text\.filterEmpty/);
    assert.match(pageBlock, /copy\.text\.filterEmptyHelp/);
    assert.match(css, /\.settingsMemoryFilterEmpty/);
    assert.match(pageBlock, /visibleMemoryEntries\.entries\.length === 0 && !memoryEntryPreviewBlockedReason/);
    assert.match(pageBlock, /settingsMemoryListEmpty/);
    assert.match(pageBlock, /copy\.text\.waitingEntry/);
    assert.match(pageBlock, /copy\.text\.waitingEntryHelp/);
    assert.match(css, /\.settingsMemoryListEmpty/);
    assert.match(src, /entry\.id/);
    assert.match(src, /String\(entry\.createdAt\)/);
    assert.match(src, /String\(entry\.updatedAt\)/);
    assert.match(src, /\.\.\.entry\.tags/);
    assert.match(src, /memoryOriginLabel\(entry\.origin, props\.copy\)/);
    assert.match(src, /props\.copy\.text\.noMatchEntry/);
    // PR-MEMORY-ENTRY-LIST-A11Y-0 (round 18/30): list container
    // switched from `<div role="list">` to semantic `<ul>`; rows
    // wrapped in `<li>` (the inner `<article>` per row stays
    // because articles are valid sectioning content inside list
    // items). aria-label is preserved.
    assert.match(src, /<ul className="settingsMemoryEntryList" aria-label=\{props\.copy\.listAria\(props\.title\)\}>/);
    assert.match(src, /<li key=\{entry\.id\}>[\s\S]*?<article className="settingsMemoryEntryCard">/);
    assert.match(src, /<div className="settingsMemoryEntryActions" role="group" aria-label=\{props\.copy\.entryActionsAria\(entry\.title\)\}>/);
    assert.doesNotMatch(src, /<div className="settingsMemoryEntryActions">\s*\{props\.onCopyReference && \(/);
  });

  it('keeps archived entries visually available without using hidden placeholder copy', async () => {
    const css = await readRendererContractCss();

    assert.match(css, /\.settingsMemoryEntryGroup\[data-archived="true"\]/);
    assert.doesNotMatch(css, /coming soon|todo|not implemented/i);
  });

  it('describes agent memory reads as a current send-time prompt boundary', async () => {
    const src = await readSettingsCombinedSource();
    const memoryPage = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/);

    assert.ok(memoryPage, 'Memory settings page block must exist');
    assert.match(memoryPage![0], /copy\.text\.agentReadableHelp/);
    assert.doesNotMatch(
      memoryPage![0],
      /后续 prompt 注入|之后会|V0\.|coming soon|not implemented/i,
      'Memory settings read-boundary copy must not sound like a future roadmap or implementation placeholder',
    );
  });

  it('labels the missing MEMORY.md path as an actionable create state', async () => {
    const src = await readSettingsCombinedSource();
    const memoryPage = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/);

    assert.ok(memoryPage, 'Memory settings page block must exist');
    assert.match(memoryPage![0], /copy\.text\.waitingFile/);
    assert.doesNotMatch(
      memoryPage![0],
      /MEMORY\.md 尚未创建/,
      'Missing MEMORY.md copy should read as an actionable create state, not unfinished implementation copy',
    );
  });

  it('gives repeated workspace-instruction row actions file-specific accessible names', async () => {
    const src = await readSettingsCombinedSource();
    const page = await readRepo('apps/desktop/src/renderer/settings/memory-settings-page.tsx');
    const memoryPage = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(memoryPage, /aria-label=\{props\.copy\.openInstructionAria\(file\.file\)\}/);
    assert.match(memoryPage, /aria-label=\{props\.copy\.createInstructionAria\(file\.file\)\}/);
    assert.match(memoryPage, /props\.onOpen\(file\.file\)/);
    assert.match(memoryPage, /props\.onCreate\(file\.file\)/);
    assert.match(page, /onOpen=\{workspaceInstructions\.openFile\}/);
    assert.match(page, /onCreate=\{workspaceInstructions\.createFile\}/);
  });

  it('gates local memory file actions with visible per-action pending feedback', async () => {
    const src = await readSettingsCombinedSource();
    const memoryPage = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(memoryPage, /const memoryActionGuard = useKeyedActionGuard<string>\(\)/);
    assert.match(memoryPage, /async function runMemoryAction<T>\([\s\S]*key: string,[\s\S]*action: \(isCurrent: \(\) => boolean\) => Promise<T>,/);
    assert.match(memoryPage, /const release = memoryActionGuard\.begin\(key\);/);
    assert.match(memoryPage, /if \(!release\) return undefined;/);
    assert.match(memoryPage, /finally \{[\s\S]*release\(\);/);
    assert.match(memoryPage, /const isMemoryActionPending = \(key: string\) => pendingMemoryActions\.has\(key\)/);

    assert.match(memoryPage, /runAction\(`instruction:\$\{file\}:open`/);
    assert.match(memoryPage, /runWriteAction\(`instruction:\$\{file\}:create`/);
    assert.match(memoryPage, /runMemoryAction\(`backup:\$\{backup\.kind\}:open`/);
    assert.match(memoryPage, /runMemoryAction\(`backup:\$\{backup\.kind\}:restore`/);
    assert.match(memoryPage, /runMemoryAction\(`backup:\$\{backup\.kind\}:copy`/);
    assert.match(memoryPage, /runMemoryAction\('memory:file:open'/);
    assert.match(memoryPage, /runMemoryAction\('memory:folder:open'/);
    assert.match(memoryPage, /runMemoryAction\('backup:latest:open'/);
    assert.match(memoryPage, /runMemoryAction\('backup:latest:restore'/);
    assert.match(memoryPage, /runMemoryAction\('memory:path:copy'/);
    assert.match(memoryPage, /<div className="settingsActionRow" role="group" aria-label=\{copy\.text\.fileActionsAria\}>/);
    assert.doesNotMatch(memoryPage, /<div className="settingsActionRow">\s*<button type="button" className="maka-button" disabled=\{memoryControlsDisabled \|\| !effective\.enabled \|\| !memoryDraftDirty\}/);

    assert.match(memoryPage, /isDisabled=\{props\.disabled \|\| props\.isActionPending\(`instruction:\$\{file\.file\}:open`\)\}/); // #1565 PR 3
    assert.match(memoryPage, /props\.isActionPending\(`instruction:\$\{file\.file\}:open`\) \? props\.copy\.text\.opening : props\.copy\.text\.instructionOpen/);
    assert.match(memoryPage, /props\.isActionPending\(`instruction:\$\{file\.file\}:create`\) \? props\.copy\.text\.creating : props\.copy\.text\.instructionCreate/);
    assert.match(memoryPage, /isMemoryActionPending\(`backup:\$\{backup\.kind\}:open`\) \? copy\.text\.opening : copy\.text\.open/);
    assert.match(memoryPage, /isMemoryActionPending\(`backup:\$\{backup\.kind\}:restore`\) \? copy\.text\.restoring : copy\.text\.restore/);
    assert.match(memoryPage, /isMemoryActionPending\(`backup:\$\{backup\.kind\}:copy`\) \? copy\.text\.copying : copy\.text\.copyReference/);
    assert.match(memoryPage, /isMemoryActionPending\('memory:file:open'\) \? copy\.text\.opening : copy\.text\.openFile/);
    assert.match(memoryPage, /isMemoryActionPending\('backup:latest:restore'\) \? copy\.text\.restoring : copy\.text\.restorePrevious/);
  });

  it('gates local memory write actions with one synchronous busy owner', async () => {
    const src = await readSettingsCombinedSource();
    const memoryPage = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(memoryPage, /type MemoryWriteAction =[\s\S]*'save'[\s\S]*'reset'[\s\S]*'restore'[\s\S]*'entry-status'/);
    assert.match(memoryPage, /const \[pendingMemoryWriteAction, setPendingMemoryWriteAction\] = useState<MemoryWriteAction \| null>\(null\)/);
    assert.match(memoryPage, /const memoryActionGuard = useKeyedActionGuard<string>\(\)/);
    assert.match(
      memoryPage,
      /async function runMemoryWriteAction<T>\([\s\S]*action: MemoryWriteAction,[\s\S]*run: \(isCurrent: \(\) => boolean\) => Promise<T>,[\s\S]*const releaseWrite = memoryActionGuard\.begin\('write'\);[\s\S]*if \(!releaseWrite\) return undefined;[\s\S]*setPendingMemoryWriteAction\(action\);[\s\S]*setBusy\(true\);/,
      'local memory writes must set a synchronous busy guard before awaiting file/settings writes',
    );
    assert.match(
      memoryPage,
      /finally \{[\s\S]*releaseWrite\(\);[\s\S]*setPendingMemoryWriteAction\(null\);[\s\S]*setBusy\(false\);[\s\S]*\}/,
      'local memory write guard must always release after success or failure',
    );
    assert.match(memoryPage, /await runMemoryWriteAction\('reload'/);
    assert.match(memoryPage, /await runMemoryWriteAction\('enable'/);
    assert.match(memoryPage, /await runMemoryWriteAction\('agent-read'/);
    assert.match(memoryPage, /await runMemoryWriteAction\('save'/);
    assert.match(memoryPage, /await runMemoryWriteAction\('reset'/);
    assert.match(memoryPage, /await runMemoryWriteAction\('restore'/);
    assert.match(memoryPage, /await runMemoryWriteAction\('entry-status'/);
    assert.match(memoryPage, /useWorkspaceInstructionsController/);
    assert.match(memoryPage, /pendingMemoryWriteAction === 'save' \? copy\.text\.saving : memoryDraftDirty \? copy\.text\.save : copy\.text\.saved/);
    assert.match(memoryPage, /pendingMemoryWriteAction === 'reload' \? copy\.text\.loading : copy\.text\.reload/);
    assert.match(memoryPage, /pendingMemoryWriteAction === 'reset' \? copy\.text\.resetting : copy\.text\.resetBackup/);
  });

  it('drops late local memory reload and pending cleanup after Settings is closed', async () => {
    const src = await readSettingsCombinedSource();
    const memoryPage = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';
    const reloadBlock = memoryPage.match(/async function reload\(\)[\s\S]*?async function reloadDraftFromDisk/)?.[0] ?? '';
    const enableBlock = memoryPage.match(/async function setEnabled\(enabled: boolean\)[\s\S]*?async function setAgentReadEnabled/)?.[0] ?? '';
    const agentReadBlock = memoryPage.match(/async function setAgentReadEnabled[\s\S]*?async function save/)?.[0] ?? '';
    const saveBlock = memoryPage.match(/async function save\(\)[\s\S]*?async function reset/)?.[0] ?? '';
    const resetBlock = memoryPage.match(/async function reset\(\)[\s\S]*?async function restoreLatestBackup/)?.[0] ?? '';
    const restoreLatestBlock = memoryPage.match(/async function restoreLatestBackup\(\)[\s\S]*?async function restoreBackupCandidate/)?.[0] ?? '';
    const restoreCandidateBlock = memoryPage.match(/async function restoreBackupCandidate[\s\S]*?async function openFile/)?.[0] ?? '';
    const openFileBlock = memoryPage.match(/async function openFile\(\)[\s\S]*?async function openLatestBackup/)?.[0] ?? '';
    const openLatestBlock = memoryPage.match(/async function openLatestBackup\(\)[\s\S]*?async function openBackupCandidate/)?.[0] ?? '';
    const openCandidateBlock = memoryPage.match(/async function openBackupCandidate[\s\S]*?async function openFolder/)?.[0] ?? '';
    const openFolderBlock = memoryPage.match(/async function openFolder\(\)[\s\S]*?async function copyPath/)?.[0] ?? '';
    const openInstructionBlock = memoryPage.match(/async function openFile\(file: string\)[\s\S]*?async function createFile/)?.[0] ?? '';
    const createInstructionBlock = memoryPage.match(/async function createFile[\s\S]*?return \{/)?.[0] ?? '';
    const copyPathBlock = memoryPage.match(/async function copyPath\(\)[\s\S]*?async function copyBackupReference/)?.[0] ?? '';
    const copyBackupBlock = memoryPage.match(/async function copyBackupReference[\s\S]*?async function copyLatestBackupReference/)?.[0] ?? '';
    const copyEntryBlock = memoryPage.match(/async function copyMemoryEntryReference[\s\S]*?function focusMemoryEntryInDraft/)?.[0] ?? '';
    const updateStatusBlock = memoryPage.match(/async function updateMemoryEntryStatus[\s\S]*?\r?\n  }\r?\n\r?\n  const viewModel =/)?.[0] ?? '';
    const promptPreviewCopyBlock = memoryPage.match(/async function copyLocalMemoryPromptPreview\(\)[\s\S]*?return \{/)?.[0] ?? '';
    const writeActionBlock = memoryPage.match(/async function runMemoryWriteAction<T>[\s\S]*?async function runMemoryAction/)?.[0] ?? '';
    const actionBlock = memoryPage.match(/async function runMemoryAction<T>[\s\S]*?async function reload/)?.[0] ?? '';

    assert.match(memoryPage, /const memoryPageMountedRef = useRef\(false\)/);
    assert.match(memoryPage, /const memoryPageLifecycleRef = useRef\(0\)/);
    assert.match(memoryPage, /const memoryReloadTicketRef = useRef\(0\)/);
    assert.match(
      memoryPage,
      /useEffect\(\(\) => \{[\s\S]*memoryPageLifecycleRef\.current \+= 1;[\s\S]*memoryPageMountedRef\.current = true;[\s\S]*const lifecycle = memoryPageLifecycleRef\.current;[\s\S]*return \(\) => \{[\s\S]*memoryPageMountedRef\.current = false;[\s\S]*memoryReloadTicketRef\.current \+= 1;/,
      'Memory page cleanup must invalidate reloads (the shared keyed guard hook releases pending owners on unmount)',
    );
    assert.match(
      memoryPage,
      /function isMemoryPageCurrent\(lifecycle: number\): boolean \{[\s\S]*return memoryPageMountedRef\.current && memoryPageLifecycleRef\.current === lifecycle;/,
      'Memory page lifecycle checks must be StrictMode-safe, not just a mounted boolean',
    );
    assert.match(
      reloadBlock,
      /const lifecycle = memoryPageLifecycleRef\.current;[\s\S]*const ticket = \+\+memoryReloadTicketRef\.current;[\s\S]*await window\.maka\.memory\.getState\(\);[\s\S]*if \(!isMemoryPageCurrent\(lifecycle\) \|\| ticket !== memoryReloadTicketRef\.current\) return false;[\s\S]*setState\(next\);/,
      'Local memory reload must not write loaded state after unmount or a stale reload ticket',
    );
    assert.match(
      reloadBlock,
      /catch \(error\) \{[\s\S]*if \(isMemoryPageCurrent\(lifecycle\) && ticket === memoryReloadTicketRef\.current\) \{[\s\S]*toast\.error\(copy\.text\.loadFailed, settingsActionErrorMessage\(error, locale\)\);/,
      'Local memory reload errors must not toast after Settings closes',
    );
    assert.match(
      reloadBlock,
      /finally \{[\s\S]*if \(isMemoryPageCurrent\(lifecycle\) && ticket === memoryReloadTicketRef\.current\) \{[\s\S]*setLoadingMemory\(false\);/,
      'Local memory reload must not clear loading state after unmount',
    );
    assert.match(
      writeActionBlock,
      /const lifecycle = memoryPageLifecycleRef\.current;[\s\S]*return await run\(\(\) => isMemoryPageCurrent\(lifecycle\)\);[\s\S]*catch \(error\) \{[\s\S]*if \(!isMemoryPageCurrent\(lifecycle\)\) return undefined;[\s\S]*finally \{[\s\S]*releaseWrite\(\);[\s\S]*if \(isMemoryPageCurrent\(lifecycle\)\) \{[\s\S]*setPendingMemoryWriteAction\(null\);[\s\S]*setBusy\(false\);/,
      'Memory write wrapper must release the guard but not write pending state after unmount',
    );
    assert.match(enableBlock, /await runMemoryWriteAction\('enable', async \(isCurrent\) => \{[\s\S]*await props\.onReloadSettings\(\);[\s\S]*if \(!isCurrent\(\)\) return;[\s\S]*setState\(next\);/);
    assert.match(agentReadBlock, /await runMemoryWriteAction\('agent-read', async \(isCurrent\) => \{[\s\S]*await props\.onReloadSettings\(\);[\s\S]*if \(!isCurrent\(\)\) return;[\s\S]*setState\(next\);/);
    assert.match(saveBlock, /await runMemoryWriteAction\('save', async \(isCurrent\) => \{[\s\S]*const next = await window\.maka\.memory\.save\(draft\);[\s\S]*if \(!isCurrent\(\)\) return;[\s\S]*setState\(next\);/);
    assert.match(resetBlock, /await runMemoryWriteAction\('reset', async \(isCurrent\) => \{[\s\S]*const next = await window\.maka\.memory\.reset\(\);[\s\S]*if \(!isCurrent\(\)\) return;[\s\S]*setState\(next\);/);
    assert.match(restoreLatestBlock, /await runMemoryWriteAction\('restore', async \(isCurrent\) => \{[\s\S]*if \(!isCurrent\(\)\) return;[\s\S]*const result = await window\.maka\.memory\.restoreLatestBackup\(\);[\s\S]*if \(!isCurrent\(\)\) return;[\s\S]*setState\(result\.state\);/);
    assert.match(restoreCandidateBlock, /await runMemoryWriteAction\('restore', async \(isCurrent\) => \{[\s\S]*if \(!isCurrent\(\)\) return;[\s\S]*const result = await window\.maka\.memory\.restoreBackup\(backup\.kind\);[\s\S]*if \(!isCurrent\(\)\) return;[\s\S]*setState\(result\.state\);/);
    assert.match(createInstructionBlock, /await runWriteAction\(`instruction:\$\{file\}:create`, async \(isActionCurrent\) => \{[\s\S]*const result = await window\.maka\.workspaceInstructions\.createFile\(file\);[\s\S]*if \(!isActionCurrent\(\)\) return;[\s\S]*const refreshed = await reload\(\);/);
    assert.match(updateStatusBlock, /await runMemoryWriteAction\('entry-status', async \(isCurrent\) => \{[\s\S]*const next = await window\.maka\.memory\.save\(result\.draft\);[\s\S]*if \(!isCurrent\(\)\) return;[\s\S]*setState\(next\);/);
    assert.match(
      actionBlock,
      /action: \(isCurrent: \(\) => boolean\) => Promise<T>,[\s\S]*const lifecycle = memoryPageLifecycleRef\.current;[\s\S]*return await action\(\(\) => isMemoryPageCurrent\(lifecycle\)\);[\s\S]*catch \(error\) \{[\s\S]*if \(!isMemoryPageCurrent\(lifecycle\)\) return undefined;[\s\S]*finally \{[\s\S]*release\(\);[\s\S]*if \(isMemoryPageCurrent\(lifecycle\)\) \{[\s\S]*setPendingMemoryActions/,
      'Memory file-action wrapper must release the guard but not write pending state after unmount',
    );
    assert.match(openFileBlock, /await runMemoryAction\('memory:file:open', async \(isCurrent\) => \{[\s\S]*const result = await window\.maka\.memory\.openFile\(\);[\s\S]*if \(!isCurrent\(\)\) return;[\s\S]*if \(!result\.ok\) toast\.error/);
    assert.match(openLatestBlock, /await runMemoryAction\('backup:latest:open', async \(isCurrent\) => \{[\s\S]*const result = await window\.maka\.memory\.openLatestBackup\(\);[\s\S]*if \(!isCurrent\(\)\) return;[\s\S]*if \(!result\.ok\) toast\.error/);
    assert.match(openCandidateBlock, /await runMemoryAction\(`backup:\$\{backup\.kind\}:open`, async \(isCurrent\) => \{[\s\S]*const result = await window\.maka\.memory\.openBackup\(backup\.kind\);[\s\S]*if \(!isCurrent\(\)\) return;[\s\S]*if \(!result\.ok\)/);
    assert.match(openFolderBlock, /await runMemoryAction\('memory:folder:open', async \(isCurrent\) => \{[\s\S]*const result = await window\.maka\.app\.openPath\('memory'\);[\s\S]*if \(!isCurrent\(\)\) return;[\s\S]*if \(!result\.ok\)/);
    assert.match(openInstructionBlock, /await runAction\(`instruction:\$\{file\}:open`, async \(isActionCurrent\) => \{[\s\S]*const result = await window\.maka\.workspaceInstructions\.openFile\(file\);[\s\S]*if \(isActionCurrent\(\) && !result\.ok\)/);
    assert.match(createInstructionBlock, /await runWriteAction\(`instruction:\$\{file\}:create`, async \(isActionCurrent\) => \{[\s\S]*catch \(error\) \{[\s\S]*if \(isActionCurrent\(\)\) toast\.error\(copy\.text\.instructionCreateFailed, settingsActionErrorMessage\(error, locale\)\);/);
    assert.match(copyPathBlock, /await navigator\.clipboard\.writeText\(state\.path\);[\s\S]*if \(isCurrent\(\)\) toast\.success\(copy\.text\.pathCopied, state\.path\);[\s\S]*catch \{[\s\S]*if \(isCurrent\(\)\) toast\.error\(copy\.text\.copyFailed/);
    assert.match(copyBackupBlock, /await navigator\.clipboard\.writeText\(reference\);[\s\S]*if \(isCurrent\(\)\) toast\.success\(copy\.text\.backupReferenceCopied/);
    assert.match(copyEntryBlock, /await navigator\.clipboard\.writeText\(reference\);[\s\S]*if \(isCurrent\(\)\) toast\.success\(copy\.text\.entryReferenceCopied, entry\.id\);/);
    assert.match(promptPreviewCopyBlock, /await navigator\.clipboard\.writeText\(localMemoryPromptPreview\);[\s\S]*if \(isCurrent\(\)\) toast\.success\(copy\.text\.promptCopied/);
  });

  it('manual add stays draft-only and routes through the core helper', async () => {
    const src = await readSettingsCombinedSource();
    const manualAddBlock = src.match(/function addManualMemoryDraftEntry\(\) \{[\s\S]*?\r?\n  \}\r?\n\r?\n  async function updateMemoryEntryStatus/)?.[0] ?? '';

    assert.match(src, /appendManualLocalMemoryEntryDraft\(draft/);
    assert.match(src, /tags:\s*newMemoryTags\.split\(', '\)|tags:\s*newMemoryTags\.split\(','/);
    assert.match(src, /<FormLayout>[\s\S]*label=\{copy\.text\.tags\}/);
    assert.doesNotMatch(
      src,
      /label=\{copy\.text\.(?:title|tags|content|fileContent)\}\s+isLabelHidden/,
    );
    assert.match(src, /copy\.text\.addedDraft/);
    assert.match(src, /copy\.text\.addedDraftDetail/);
    assert.doesNotMatch(manualAddBlock, /window\.maka\.memory\.save\(result\.draft\)/);
  });

  it('can archive and restore visible memory entries without hand-editing metadata', async () => {
    const src = await readSettingsCombinedSource();

    assert.match(src, /setLocalMemoryEntryStatusDraft\(draft/);
    assert.match(src, /onStatusChange=\{updateMemoryEntryStatus\}/);
    assert.match(src, /const statusActionLabel = props\.draftDirty/);
    assert.match(src, /:\s*props\.archived\s*\?\s*props\.copy\.text\.restoreAction\s*:\s*props\.copy\.text\.archiveAction;/);
    assert.match(src, /window\.maka\.memory\.save\(result\.draft\)/);
  });

  it('keeps archive and restore draft-only when MEMORY.md has unsaved edits', async () => {
    const src = await readSettingsCombinedSource();
    const css = await readRendererContractCss();
    const updateBlock = src.match(/async function updateMemoryEntryStatus[\s\S]*?\r?\n  }\r?\n\r?\n  const viewModel =/)?.[0] ?? '';
    const listBlock = src.match(/function MemoryEntryList\([\s\S]*?function filterLocalMemoryEntries/)?.[0] ?? '';

    assert.match(updateBlock, /if \(memoryDraftDirty\) \{/);
    assert.match(updateBlock, /setDraft\(result\.draft\)/);
    assert.match(updateBlock, /copy\.text\.archivedDraft/);
    assert.match(updateBlock, /copy\.text\.restoredDraft/);
    assert.match(updateBlock, /copy\.text\.addedDraftDetail/);
    assert.match(updateBlock, /return;\r?\n    }\r?\n\r?\n    try \{[\s\S]*await runMemoryWriteAction\('entry-status'/);
    assert.match(updateBlock, /window\.maka\.memory\.save\(result\.draft\)/);
    assert.match(src, /draftDirty=\{memoryDraftDirty\}/);
    assert.match(listBlock, /draftDirty\?: boolean/);
    assert.match(listBlock, /const statusActionLabel = props\.draftDirty/);
    assert.match(listBlock, /props\.copy\.text\.restoreDraftAction/);
    assert.match(listBlock, /props\.copy\.text\.archiveDraftAction/);
    assert.match(listBlock, /const statusActionAriaLabel = props\.draftDirty/);
    assert.match(listBlock, /props\.copy\.draftStatusAria\(statusActionLabel\)/);
    assert.match(listBlock, /aria-label=\{statusActionAriaLabel\}/);
    assert.match(listBlock, /settingsMemoryEntryDraftNotice/);
    assert.match(listBlock, /props\.copy\.text\.archiveDraftNotice/);
    assert.match(css, /\.settingsMemoryEntryDraftNotice/);
    assert.match(css, /var\(--warning\)/);
  });

  it('uses stopped-update copy for invalid memory entry ids instead of raw missing-field wording', async () => {
    const src = await readSettingsCombinedSource();

    assert.match(src, /copy\.text\.invalidIdDetail/);
  });

  it('tells the user when saving MEMORY.md redacted sensitive fields', async () => {
    const src = await readSettingsCombinedSource();
    const css = await readRendererContractCss();
    const saveBlock = src.match(/async function save\(\) \{[\s\S]*?\r?\n  \}\r?\n\r?\n  async function reset/)?.[0] ?? '';
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(saveBlock, /const redacted = next\.content !== draft/);
    assert.match(saveBlock, /copy\.text\.savedRedacted/);
    assert.match(saveBlock, /copy\.redactedDetail\(formatLocalMemorySaveSummary\(next, copy\)\)/);
    assert.match(pageBlock, /memoryDraftHasSensitiveFields: redactSecrets\(input\.draft\) !== input\.draft/);
    assert.match(pageBlock, /settingsMemoryDraftWarning/);
    assert.match(pageBlock, /role="status"/);
    assert.match(pageBlock, /copy\.text\.sensitiveDraft/);
    assert.match(pageBlock, /copy\.text\.sensitiveDraftHelp/);
    assert.match(css, /\.settingsMemoryDraftWarning/);
  });

  it('summarizes parsed memory entry counts after save', async () => {
    const src = await readSettingsCombinedSource();
    const css = await readRendererContractCss();
    const saveBlock = src.match(/async function save\(\) \{[\s\S]*?\r?\n  \}\r?\n\r?\n  async function reset/)?.[0] ?? '';
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(src, /function formatLocalMemorySaveSummary\(state: LocalMemoryState, copy: MemorySettingsCopy\)/);
    assert.match(src, /state\.activeEntryCount/);
    assert.match(src, /copy\.saveSummary\(state\.activeEntryCount, state\.archivedEntryCount\)/);
    assert.match(saveBlock, /formatLocalMemorySaveSummary\(next, copy\)/);
    assert.match(saveBlock, /copy\.text\.savedRedacted/);
    assert.match(saveBlock, /savedAt: Date\.now\(\)/);
    assert.match(pageBlock, /lastSaveSummary/);
    assert.match(pageBlock, /setLastSaveSummary\(\{\s*title: copy\.text\.savedFile,\s*detail,\s*savedAt: Date\.now\(\),?\s*\}\)/);
    assert.match(pageBlock, /settingsMemorySaveSummary/);
    assert.match(pageBlock, /settingsMemorySaveSummaryTime/);
    assert.match(pageBlock, /copy\.text\.savedAt\}<RelativeTime ts=\{lastSaveSummary\.savedAt\}/);
    assert.match(pageBlock, /lastSaveSummary && !memoryDraftDirty/);
    assert.match(css, /\.settingsMemorySaveSummary/);
    assert.match(css, /\.settingsMemorySaveSummaryTime/);
    assert.match(css, /var\(--success\)/);
  });

  it('shows whether the visible MEMORY.md draft has unsaved changes', async () => {
    const src = await readSettingsCombinedSource();
    const css = await readRendererContractCss();
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(pageBlock, /const memoryDraftDirty = input\.draft !== effective\.content/);
    assert.match(pageBlock, /settingsMemoryDirtyState/);
    assert.match(pageBlock, /memoryDraftDirty \? copy\.text\.dirty : copy\.text\.savedDraft/);
    assert.match(pageBlock, /isDisabled=\{memoryControlsDisabled \|\| !effective\.enabled \|\| !memoryDraftDirty\}/); // #1565 PR 3
    assert.match(pageBlock, /pendingMemoryWriteAction === 'save' \? copy\.text\.saving : memoryDraftDirty \? copy\.text\.save : copy\.text\.saved/);
    assert.match(css, /\.settingsMemoryDirtyState\[data-dirty="true"\]/);
  });

  it('parses entry cards from the visible MEMORY.md draft while unsaved edits are pending', async () => {
    const src = await readSettingsCombinedSource();
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(src, /parseLocalMemoryMarkdown/);
    assert.match(pageBlock, /const draftMemoryEntries = parseLocalMemoryMarkdown\(input\.draft\)/);
    assert.match(pageBlock, /const visibleMemoryEntries = memoryDraftDirty \? draftMemoryEntries : effective/);
    assert.match(pageBlock, /visibleMemoryEntries\.activeEntries/);
    assert.match(pageBlock, /visibleMemoryEntries\.archivedEntries/);
    assert.match(pageBlock, /visibleMemoryEntries\.entries\.length > 0/);
    assert.match(pageBlock, /copy\.countEntries\(visibleMemoryEntries\.entries\.length\)/);
    assert.match(pageBlock, /copy\.countActive\(visibleMemoryEntries\.activeEntries\.length, memoryDraftDirty\)/);
  });

  it('shows a clear safe-mode reason when draft entry preview is paused', async () => {
    const src = await readSettingsCombinedSource();
    const css = await readRendererContractCss();
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(pageBlock, /const memoryEntryPreviewBlockedReason =/);
    assert.match(pageBlock, /memoryDraftDirty && draftMemoryEntries\.safeMode/);
    assert.match(pageBlock, /copy\.previewOversize/);
    assert.match(pageBlock, /settingsMemoryEntryPreviewNotice/);
    assert.match(pageBlock, /role="status"/);
    assert.match(pageBlock, /copy\.text\.previewPaused/);
    assert.match(css, /\.settingsMemoryEntryPreviewNotice/);
  });

  it('can reload the visible MEMORY.md draft from disk to discard unsaved edits', async () => {
    const src = await readSettingsCombinedSource();
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(pageBlock, /async function reloadDraftFromDisk\(\)/);
    assert.match(pageBlock, /await reload\(\)/);
    assert.match(pageBlock, /copy\.text\.reloaded/);
    assert.match(pageBlock, /copy\.text\.reloadDiscarded/);
    assert.match(pageBlock, /onClick=\{\(\) => void reloadDraftFromDisk\(\)\}/);
    assert.match(pageBlock, /pendingMemoryWriteAction === 'reload' \? copy\.text\.loading : copy\.text\.reload/);
  });

  it('keeps MEMORY.md editing disabled until the initial disk state has loaded', async () => {
    const src = await readSettingsCombinedSource();
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';
    const reloadBlock = pageBlock.match(/async function reload\(\)[\s\S]*?async function reloadDraftFromDisk/)?.[0] ?? '';

    assert.match(pageBlock, /const \[loadingMemory, setLoadingMemory\] = useState\(true\)/);
    assert.match(reloadBlock, /finally \{[\s\S]*setLoadingMemory\(false\)/);
    assert.match(pageBlock, /const memoryControlsDisabled = loadingMemory \|\| busy/);
    assert.match(pageBlock, /isDisabled=\{memoryControlsDisabled \|\| effective\.status === 'incognito_blocked' \|\| !effective\.enabled\}/); // #1565 PR 3
    assert.match(pageBlock, /isDisabled=\{memoryControlsDisabled \|\| !effective\.enabled \|\| !memoryDraftDirty\}/); // #1565 PR 3
  });

  it('surfaces thrown local memory and workspace instruction action failures', async () => {
    const src = await readSettingsCombinedSource();
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';
    const reloadBlock = pageBlock.match(/async function reload\(\)[\s\S]*?async function reloadDraftFromDisk/)?.[0] ?? '';
    const saveBlock = pageBlock.match(/async function save\(\)[\s\S]*?async function reset/)?.[0] ?? '';
    const resetBlock = pageBlock.match(/async function reset\(\)[\s\S]*?async function restoreLatestBackup/)?.[0] ?? '';
    const restoreLatestBlock = pageBlock.match(/async function restoreLatestBackup\(\)[\s\S]*?async function restoreBackupCandidate/)?.[0] ?? '';
    const restoreCandidateBlock = pageBlock.match(/async function restoreBackupCandidate[\s\S]*?async function openFile/)?.[0] ?? '';
    const openFileBlock = pageBlock.match(/async function openFile\(\)[\s\S]*?async function openLatestBackup/)?.[0] ?? '';
    const openLatestBlock = pageBlock.match(/async function openLatestBackup\(\)[\s\S]*?async function openBackupCandidate/)?.[0] ?? '';
    const openCandidateBlock = pageBlock.match(/async function openBackupCandidate[\s\S]*?async function openFolder/)?.[0] ?? '';
    const openFolderBlock = pageBlock.match(/async function openFolder\(\)[\s\S]*?async function copyPath/)?.[0] ?? '';
    const openInstructionBlock = pageBlock.match(/async function openFile\(file: string\)[\s\S]*?async function createFile/)?.[0] ?? '';
    const createInstructionBlock = pageBlock.match(/async function createFile[\s\S]*?return \{/)?.[0] ?? '';
    const updateStatusBlock = pageBlock.match(/async function updateMemoryEntryStatus[\s\S]*?\r?\n  }\r?\n\r?\n  const viewModel =/)?.[0] ?? '';

    assert.match(src, /function settingsActionErrorMessage\(error: unknown, locale: UiLocale = 'zh'\)/);
    assert.match(reloadBlock, /catch \(error\) \{[\s\S]*toast\.error\(copy\.text\.loadFailed, settingsActionErrorMessage\(error, locale\)\)/);
    assert.match(saveBlock, /catch \(error\) \{[\s\S]*toast\.error\(copy\.text\.saveFailed, settingsActionErrorMessage\(error, locale\)\)/);
    assert.match(resetBlock, /catch \(error\) \{[\s\S]*toast\.error\(copy\.text\.resetFailed, settingsActionErrorMessage\(error, locale\)\)/);
    assert.match(restoreLatestBlock, /catch \(error\) \{[\s\S]*toast\.error\(copy\.text\.restoreLatestFailed, settingsActionErrorMessage\(error, locale\)\)/);
    assert.match(restoreCandidateBlock, /catch \(error\) \{[\s\S]*toast\.error\(copy\.text\.restoreCandidateFailed, settingsActionErrorMessage\(error, locale\)\)/);
    assert.match(openFileBlock, /catch \(error\) \{[\s\S]*toast\.error\(copy\.text\.openFailed, settingsActionErrorMessage\(error, locale\)\)/);
    assert.match(openLatestBlock, /catch \(error\) \{[\s\S]*toast\.error\(copy\.text\.openPreviousFailed, settingsActionErrorMessage\(error, locale\)\)/);
    assert.match(openCandidateBlock, /catch \(error\) \{[\s\S]*copy\.openBackupFailed\(localMemoryBackupKindLabel\(backup\.kind, copy\)\), settingsActionErrorMessage\(error, locale\)\)/);
    assert.match(openFolderBlock, /catch \(error\) \{[\s\S]*copy\.openBackupFailed\(openPathActionLabel\('memory', locale\)\), settingsActionErrorMessage\(error, locale\)\)/);
    assert.match(openInstructionBlock, /catch \(error\) \{[\s\S]*toast\.error\(copy\.text\.instructionOpenFailed, settingsActionErrorMessage\(error, locale\)\)/);
    assert.match(createInstructionBlock, /catch \(error\) \{[\s\S]*toast\.error\(copy\.text\.instructionCreateFailed, settingsActionErrorMessage\(error, locale\)\)/);
    assert.match(updateStatusBlock, /catch \(error\) \{[\s\S]*toast\.error\(status === 'archived' \? copy\.text\.archiveFailed : copy\.text\.entryRestoreFailed, settingsActionErrorMessage\(error, locale\)\)/);
  });

  it('does not return raw shell.openPath errors from local memory open IPC', async () => {
    const main = await readMainProcessCombinedSource();
    const memoryOpenRegion = main.match(/ipcMain\.handle\('memory:openFile'[\s\S]*?function normalizeMemoryTextInput/)?.[0] ?? '';

    assert.match(
      main,
      /case 'open-failed':[\s\S]*系统未能打开 MEMORY\.md。/,
      'MEMORY.md open failure copy must have a stable product message',
    );
    assert.match(
      main,
      /case 'open-failed':[\s\S]*系统未能打开 MEMORY\.md 备份。/,
      'MEMORY.md backup open failure copy must have a stable product message',
    );
    assert.match(
      memoryOpenRegion,
      /memory:openFile[\s\S]*shell\.openPath\(resolved\.path\)[\s\S]*localMemoryOpenFailureCopy\('open-failed'\)/,
      'memory:openFile must not return shell.openPath raw error strings',
    );
    assert.match(
      memoryOpenRegion,
      /memory:openLatestBackup[\s\S]*shell\.openPath\(resolved\.path\)[\s\S]*localMemoryBackupOpenFailureCopy\('open-failed'\)/,
      'memory:openLatestBackup must not return shell.openPath raw error strings',
    );
    assert.match(
      memoryOpenRegion,
      /memory:openBackup[\s\S]*shell\.openPath\(resolved\.path\)[\s\S]*localMemoryBackupOpenFailureCopy\('open-failed'\)/,
      'memory:openBackup must not return shell.openPath raw error strings',
    );
    assert.doesNotMatch(
      memoryOpenRegion,
      /return error \? \{ ok: false, message: error \}/,
      'local memory open IPC must never forward raw shell.openPath errors to Settings toasts',
    );
  });

  it('can restore the latest MEMORY.md backup through an explicit reversible action', async () => {
    const main = await readMainProcessCombinedSource();
    const preload = await readRepo('apps/desktop/src/preload/preload.ts');
    const globalTypes = await readRepo('apps/desktop/src/preload/bridge-contract.d.ts');
    const service = await readRepo('apps/desktop/src/main/local-memory-service.ts');
    const src = await readSettingsCombinedSource();
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(service, /async restoreLatestBackup/);
    assert.match(service, /\`\$\{this\.file\}\.reset\.bak\`/);
    assert.match(service, /await this\.backupRestoreUndo\(\)/);
    assert.match(service, /await this\.backup\('restore\.bak'\)/);
    assert.match(service, /realpath\(backupInfo\.path\)/);
    assert.match(service, /const backupContent = await readFile\(backup\)/);
    assert.match(service, /await writeFile\(this\.file, backupContent, \{ mode: 0o600 \}\)/);
    assert.match(service, /await chmod\(this\.file, 0o600\)/);
    assert.match(service, /没有找到上一版 MEMORY\.md 备份/);
    assert.match(main, /ipcMain\.handle\('memory:restoreLatestBackup'/);
    assert.match(preload, /restoreLatestBackup\(\)/);
    assert.match(preload, /memory:restoreLatestBackup/);
    assert.match(globalTypes, /restoreLatestBackup\(\)/);
    assert.match(pageBlock, /async function restoreLatestBackup/);
    assert.match(pageBlock, /title: copy\.text\.restoreLatestTitle/);
    assert.match(pageBlock, /description: copy\.restoreLatestDescription\(backupLabel\)/);
    assert.match(pageBlock, /window\.maka\.memory\.restoreLatestBackup\(\)/);
    assert.match(pageBlock, /copy\.text\.restoredLatest/);
    assert.match(pageBlock, /copy\.text\.restoredDetail/);
    assert.match(pageBlock, /copy\.text\.restorePrevious/);
  });

  it('shows latest MEMORY.md backup metadata before restore', async () => {
    const core = await readRepo('packages/core/src/local-memory.ts');
    const service = await readRepo('apps/desktop/src/main/local-memory-service.ts');
    const src = await readSettingsCombinedSource();
    const css = await readRendererContractCss();
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(core, /interface LocalMemoryBackupInfo/);
    assert.match(core, /readonly kind: 'save' \| 'reset' \| 'restore'/);
    assert.match(core, /readonly sizeBytes: number/);
    assert.match(core, /readonly activeEntryCount: number/);
    assert.match(core, /readonly safeMode: boolean/);
    assert.match(core, /readonly latestBackup\?: LocalMemoryBackupInfo/);
    assert.match(core, /readonly backups\?: ReadonlyArray<LocalMemoryBackupInfo>/);
    assert.match(service, /async latestBackupInfo/);
    assert.match(service, /async backupInfos/);
    assert.match(service, /kind: 'save' as const/);
    assert.match(service, /kind: 'reset' as const/);
    assert.match(service, /kind: 'restore' as const/);
    assert.match(service, /parseLocalMemoryMarkdown\(await readFile\(backupPath, 'utf8'\)\)/);
    assert.match(pageBlock, /settingsMemoryBackupState/);
    assert.match(pageBlock, /copy\.text\.openPrevious/);
    assert.match(pageBlock, /localMemoryBackupKindLabel\(effective\.latestBackup\.kind, copy\)/);
    assert.match(pageBlock, /localMemoryBackupSummary\(effective\.latestBackup, copy\)/);
    assert.match(pageBlock, /<RelativeTime ts=\{effective\.latestBackup\.updatedAt\}/);
    assert.match(pageBlock, /copy\.text\.waitingBackup/);
    assert.match(pageBlock, /copy\.text\.noBackup/);
    assert.match(pageBlock, /!\s*effective\.latestBackup/);
    assert.match(src, /function localMemoryBackupKindLabel/);
    assert.match(src, /function localMemoryBackupSummary/);
    assert.match(src, /copy\.backupOversize/);
    assert.match(src, /copy\.backupSummary\(backup\.activeEntryCount, backup\.archivedEntryCount\)/);
    assert.match(src, /copy\.backupKinds\[kind\]/);
    assert.match(css, /\.settingsMemoryBackupState/);
  });

  it('shows validated MEMORY.md backup candidates as metadata only', async () => {
    const src = await readSettingsCombinedSource();
    const css = await readRendererContractCss();
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(pageBlock, /effective\.backups && effective\.backups\.length > 1/);
    assert.match(pageBlock, /settingsMemoryBackupList/);
    assert.match(pageBlock, /copy\.text\.backupCandidates/);
    assert.match(pageBlock, /effective\.backups\.map\(\(backup\) =>/);
    assert.match(pageBlock, /localMemoryBackupKindLabel\(backup\.kind, copy\)/);
    assert.match(pageBlock, /localMemoryBackupSummary\(backup, copy\)/);
    assert.match(pageBlock, /const backupCandidateLabel = `\$\{localMemoryBackupKindLabel\(backup\.kind, copy\)\} · \$\{localMemoryBackupSummary\(backup, copy\)\}`/);
    // PR-MEMORY-BACKUP-LIST-A11Y-0 (round 16/30): list container
    // switched from `<div role="list">` + `<span role="listitem">`
    // to semantic <ul>/<li>. The behavioral pins (aria-label on
    // the list, className on each row) are preserved — the
    // assertions now match the semantic markup.
    assert.match(pageBlock, /<ul className="settingsMemoryBackupCandidates" aria-label=\{copy\.text\.backupCandidatesAria\}>/);
    assert.match(pageBlock, /className="settingsMemoryBackupCandidate"/);
    assert.match(pageBlock, /aria-label=\{copy\.openBackupAria\(backupCandidateLabel\)\}/);
    assert.match(pageBlock, /aria-label=\{copy\.restoreBackupAria\(backupCandidateLabel\)\}/);
    assert.match(pageBlock, /aria-label=\{copy\.copyBackupAria\(backupCandidateLabel\)\}/);
    assert.match(pageBlock, /<RelativeTime ts=\{backup\.updatedAt\}/);
    assert.match(pageBlock, /copyBackupReference\(backup\)/);
    assert.match(pageBlock, /copy\.text\.copyReference/);
    assert.match(pageBlock, /copy\.text\.backupHelp/);
    assert.doesNotMatch(pageBlock, /backup\.content|readFile\(backup/);
    assert.match(css, /\.settingsMemoryBackupList/);
    assert.match(css, /\.settingsMemoryBackupCandidate/);
  });

  it('opens the latest MEMORY.md backup only through a main-process validated path', async () => {
    const main = await readMainProcessCombinedSource();
    const preload = await readRepo('apps/desktop/src/preload/preload.ts');
    const globalTypes = await readRepo('apps/desktop/src/preload/bridge-contract.d.ts');
    const service = await readRepo('apps/desktop/src/main/local-memory-service.ts');
    const src = await readSettingsCombinedSource();
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(service, /async resolveLatestBackupForOpen/);
    assert.match(service, /requireLatestBackupInfo\(\)/);
    assert.match(service, /isInsideOrSamePath\(root, backupPath\)/);
    assert.match(main, /ipcMain\.handle\('memory:openLatestBackup'/);
    assert.match(main, /localMemory\.resolveLatestBackupForOpen\(\)/);
    assert.match(main, /shell\.openPath\(resolved\.path\)/);
    assert.match(main, /localMemoryBackupOpenFailureCopy/);
    assert.match(preload, /openLatestBackup\(\)/);
    assert.match(preload, /memory:openLatestBackup/);
    assert.match(globalTypes, /openLatestBackup\(\)/);
    assert.match(pageBlock, /async function openLatestBackup/);
    assert.match(pageBlock, /window\.maka\.memory\.openLatestBackup\(\)/);
    assert.match(pageBlock, /copy\.text\.openPreviousFailed/);
    assert.match(pageBlock, /isMemoryActionPending\('backup:latest:open'\) \? copy\.text\.opening : copy\.text\.openPrevious/);
    assert.match(pageBlock, /!\s*effective\.latestBackup/);
  });

  it('opens a specific MEMORY.md backup candidate by kind without renderer-supplied paths', async () => {
    const main = await readMainProcessCombinedSource();
    const preload = await readRepo('apps/desktop/src/preload/preload.ts');
    const globalTypes = await readRepo('apps/desktop/src/preload/bridge-contract.d.ts');
    const service = await readRepo('apps/desktop/src/main/local-memory-service.ts');
    const src = await readSettingsCombinedSource();
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(service, /async resolveBackupForOpen\(kind: LocalMemoryBackupInfo\['kind'\]\)/);
    assert.match(service, /backupInfos\(\)\)\.find\(\(candidate\) => candidate\.kind === kind\)/);
    assert.match(main, /ipcMain\.handle\('memory:openBackup'/);
    assert.match(main, /kind !== 'save' && kind !== 'reset' && kind !== 'restore'/);
    assert.match(main, /localMemory\.resolveBackupForOpen\(kind\)/);
    assert.match(main, /shell\.openPath\(resolved\.path\)/);
    assert.match(preload, /openBackup\(kind: 'save' \| 'reset' \| 'restore'\)/);
    assert.match(preload, /memory:openBackup', kind/);
    assert.match(globalTypes, /openBackup\(kind: 'save' \| 'reset' \| 'restore'\)/);
    assert.match(pageBlock, /async function openBackupCandidate/);
    assert.match(pageBlock, /window\.maka\.memory\.openBackup\(backup\.kind\)/);
    assert.match(pageBlock, /copy\.openBackupFailed\(localMemoryBackupKindLabel\(backup\.kind, copy\)\)/);
    assert.match(pageBlock, /openBackupCandidate\(backup\)/);
    assert.match(pageBlock, /isMemoryActionPending\(`backup:\$\{backup\.kind\}:open`\) \? copy\.text\.opening : copy\.text\.open/);
    assert.doesNotMatch(pageBlock, /openBackup\((backup\.path|.*path)/);
  });

  it('restores a specific MEMORY.md backup candidate by kind without renderer-supplied paths', async () => {
    const main = await readMainProcessCombinedSource();
    const preload = await readRepo('apps/desktop/src/preload/preload.ts');
    const globalTypes = await readRepo('apps/desktop/src/preload/bridge-contract.d.ts');
    const service = await readRepo('apps/desktop/src/main/local-memory-service.ts');
    const src = await readSettingsCombinedSource();
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';

    assert.match(service, /async restoreBackup\(kind: LocalMemoryBackupInfo\['kind'\]\)/);
    assert.match(service, /restoreBackupBySelector/);
    assert.match(service, /candidate\.kind === kind/);
    assert.match(main, /ipcMain\.handle\('memory:restoreBackup'/);
    assert.match(main, /kind !== 'save' && kind !== 'reset' && kind !== 'restore'/);
    assert.match(main, /localMemory\.restoreBackup\(kind\)/);
    assert.match(preload, /restoreBackup\(kind: 'save' \| 'reset' \| 'restore'\)/);
    assert.match(preload, /memory:restoreBackup', kind/);
    assert.match(globalTypes, /restoreBackup\(kind: 'save' \| 'reset' \| 'restore'\)/);
    assert.match(pageBlock, /async function restoreBackupCandidate/);
    assert.match(pageBlock, /window\.maka\.memory\.restoreBackup\(backup\.kind\)/);
    assert.match(pageBlock, /title: copy\.text\.restoreCandidateTitle/);
    assert.match(pageBlock, /description: copy\.restoreCandidateDescription\(backupLabel\)/);
    assert.match(pageBlock, /restoreBackupCandidate\(backup\)/);
    assert.match(pageBlock, /isMemoryActionPending\(`backup:\$\{backup\.kind\}:restore`\) \? copy\.text\.restoring : copy\.text\.restore/);
    assert.doesNotMatch(pageBlock, /restoreBackup\((backup\.path|.*path)/);
  });

  it('can copy a latest MEMORY.md backup reference without exposing backup content', async () => {
    const src = await readSettingsCombinedSource();
    const pageBlock = src.match(/function MemorySettingsPage\([\s\S]*?function MemoryEntryList/)?.[0] ?? '';
    const copyBackupBlock = pageBlock.match(/async function copyBackupReference[\s\S]*?\r?\n  }\r?\n\r?\n  async function copyLatestBackupReference/)?.[0] ?? '';

    assert.match(pageBlock, /async function copyBackupReference/);
    assert.match(pageBlock, /async function copyLatestBackupReference/);
    assert.match(pageBlock, /await copyBackupReference\(backup\)/);
    assert.match(copyBackupBlock, /Memory backup: \$\{localMemoryBackupKindLabel\(backup\.kind, copy\)\}/);
    assert.match(copyBackupBlock, /Path: \$\{backup\.path\}/);
    assert.match(copyBackupBlock, /Updated: \$\{new Date\(backup\.updatedAt\)\.toISOString\(\)\}/);
    assert.match(copyBackupBlock, /Entries: \$\{localMemoryBackupSummary\(backup, copy\)\}/);
    assert.match(copyBackupBlock, /Size: \$\{backup\.sizeBytes\} bytes/);
    assert.match(copyBackupBlock, /Safe mode: \$\{backup\.reason \?\? 'oversize'\}/);
    assert.match(copyBackupBlock, /navigator\.clipboard\.writeText\(reference\)/);
    assert.match(copyBackupBlock, /copy\.text\.backupReferenceCopied/);
    assert.match(pageBlock, /isMemoryActionPending\(`backup:\$\{effective\.latestBackup\.kind\}:copy`\) \? copy\.text\.copying : copy\.text\.copyPrevious/);
    assert.doesNotMatch(copyBackupBlock, /backup\.content|readFile\(backup/);
  });
});
