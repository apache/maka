import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { readRendererShellSource } from './renderer-shell-source-helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

describe('session revision (edit-and-resend) contract', () => {
  it('edits locally, then lazily prepares an in-conversation version on send', async () => {
    const source = await readRendererShellSource('app-shell-revision-actions.ts');
    assert.match(source, /function beginEditUserMessage\(turnId: string\): void/);
    assert.match(source, /userFacingText\(userMessage\)/);
    assert.match(source, /composerRef\.current\?\.setText\(prompt\)/);
    assert.match(source, /async function prepareRevisionSend\(text: string\)/);
    assert.match(
      source,
      /reviseBeforeTurn\(sourceSessionId, \{\s*sourceTurnId: draft\.sourceTurnId/,
    );
    assert.match(source, /revisionDraftRef\.current !== draft/);
    assert.match(source, /retainedAttachmentTurn/);
    assert.match(
      source,
      /userMessage\.displayText !== undefined && userMessage\.displayText !== userMessage\.text/,
    );
  });

  it('wires revision ownership through the shell and composer', async () => {
    const shell = await readRendererShellSource('app-shell.tsx');
    const source = await readRendererShellSource('app-shell-revision-actions.ts');
    assert.match(
      shell,
      /onEditUserMessage=\{\(turnId\) => \{ void beginEditUserMessage\(turnId\); \}\}/,
    );
    assert.match(shell, /prepareRevisionSend/);
    assert.match(
      source,
      /const submittedSkills =[\s\S]*getSkills\(\)[\s\S]*await window\.maka\.sessions\.reviseBeforeTurn[\s\S]*setSkillDraft\(newSession\.id, submittedSkills\)[\s\S]*setDraft\(newSession\.id, text\)/,
      'revision preparation must snapshot submitted Skills before creating the child session',
    );
    assert.match(
      source,
      /previousComposerSkills: composerRef\.current\?\.getSkills\(\) \?\? \[\]/,
      'revision cancellation must be able to restore the complete pre-edit draft',
    );
    assert.match(
      source,
      /setSkillDraft\(\s*draft\.sourceSessionId,\s*draft\.previousComposerSkills/,
      'revision cancellation must restore the source Skill snapshot',
    );
    assert.match(
      shell,
      /revisionNotice=\{[\s\S]*revisionDraft && activeId === revisionDraft\.draftSessionId/,
    );
    assert.match(
      shell,
      /clearDraft\(expectedRevisionDraft\.draftSessionId\)[\s\S]*clearDraft\(expectedRevisionDraft\.sourceSessionId\)/,
      'a successful child retry must clear both copies of the migrated draft',
    );
    assert.match(
      shell,
      /if \(\(skillIds\.length === 0 && text\.trim\(\) === '\/compact'\) \|\| swarmCommand \|\| graphCommand\) \{[\s\S]*revisionCommandUnsupported/,
      'revision drafts must reject local slash commands before preparing a durable version',
    );
    assert.match(
      shell,
      /revisionSend &&[\s\S]*skillIds\.length === 0 &&[\s\S]*text\.trim\(\) === revision\.originalText\.trim\(\)/,
      'adding a structured Skill makes an otherwise unchanged revision sendable',
    );
    assert.match(
      shell,
      /send\(text, pending, \{\s*\.\.\.\(skillIds\.length > 0 \? \{ skillIds \} : \{\}\),\s*\.\.\.\(quotes \? \{ quotes \} : \{\}\),\s*\}\)/,
      'revision sends preserve structured Skill ids alongside quote refs in the shared send envelope',
    );
    assert.match(shell, /cancelRevisionDraft/);
    assert.match(
      shell,
      /if \(source && owner && !source\.isArchived && !owner\.isArchived\) return;[\s\S]*commitRevisionDraft\(null\)/,
    );
    assert.match(source, /composerRef\.current\?\.setDraft\(newSession\.id, text\)/);
    assert.doesNotMatch(source, /requestAnimationFrame/);
    const rowActions = await readRendererShellSource('app-shell-session-row-actions.ts');
    assert.match(rowActions, /revisionFamily: true/);

    const composer = await readFile(resolve(REPO_ROOT, 'packages/ui/src/composer.tsx'), 'utf8');
    assert.match(composer, /if \(activeDraftKey\(\) !== submittedDraftKey\) return;/);
    assert.match(composer, /clearDraft\(draftKey: string\)/);
    assert.match(composer, /disabled=\{sendPending\}/);
  });

  it('keeps edit disabled for unsafe or non-user turns', async () => {
    const turn = await readFile(resolve(REPO_ROOT, 'packages/ui/src/chat-turn.tsx'), 'utf8');
    assert.match(
      turn,
      /props\.onEditUserMessage &&[\s\S]*!turn\.user\.automationOrigin &&[\s\S]*!turn\.user\.agentGraphOrigin/,
    );
    assert.match(
      turn,
      /editDisabled=\{[\s\S]*turn\.user\.attachments\?\.length[\s\S]*turn\.status === 'running'[\s\S]*!!props\.liveStreaming/,
    );
    assert.match(turn, /aria-disabled=\{props\.editDisabled === true/);
    assert.match(turn, /editMessageDisabledAttachments/);
    assert.match(turn, /editMessageDisabledTransformedText/);

    const view = await readFile(resolve(REPO_ROOT, 'packages/ui/src/chat-view.tsx'), 'utf8');
    assert.match(view, /message\.displayText !== undefined &&[\s\S]*message\.displayText !== message\.text/);
    assert.match(view, /streamingActive \|\| props\.activeSession\?\.status === 'running'/);
  });

  it('commits a preparing revision only when its first run starts', async () => {
    const main = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/main/sessions-ipc-main.ts'), 'utf8');
    assert.match(
      main,
      /text: skillInvocation\.sendText,[\s\S]*onRunStarted: async \(_runId, header\) => \{[\s\S]*header\.revisionState === 'preparing'[\s\S]*commitRevisionVersion\(sessionId\)/,
      'Skill expansion and the revision commit hook must coexist in one Runtime send',
    );
  });

  it('exposes reviseBeforeTurn on the preload bridge', async () => {
    const preload = await readFile(resolve(REPO_ROOT, 'apps/desktop/src/preload/preload.ts'), 'utf8');
    const bridge = await readFile(
      resolve(REPO_ROOT, 'apps/desktop/src/preload/bridge-contract.d.ts'),
      'utf8',
    );
    assert.match(preload, /reviseBeforeTurn\(sessionId: string, input: ReviseBeforeTurnInput\)/);
    assert.match(preload, /sessions:reviseBeforeTurn/);
    assert.match(bridge, /reviseBeforeTurn\(sessionId: string, input: ReviseBeforeTurnInput\)/);
    assert.doesNotMatch(preload, /branchBeforeTurn/);
    assert.doesNotMatch(bridge, /branchBeforeTurn/);
  });
});
