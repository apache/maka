import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = join(process.cwd(), '../..');

async function read(path: string): Promise<string> {
  return readFile(join(ROOT, path), 'utf8');
}

describe('Desktop explicit Skill invocation contract', () => {
  it('keeps selected Skills as structured chips instead of textarea tokens', async () => {
    const popup = await read('packages/ui/src/use-mention-popup.ts');
    const composer = await read('packages/ui/src/composer.tsx');
    const draft = await read('packages/ui/src/use-composer-skill-draft.ts');
    const styles = await read('apps/desktop/src/renderer/styles/composer-mention.css');

    assert.match(
      popup,
      /input\.onSelectSkill\?\.\(\{[\s\S]*item\.ref \? \{ ref: item\.ref \}[\s\S]*id: item\.id,[\s\S]*name: item\.name/,
    );
    assert.match(popup, /value\.slice\(0, current\.start\)/);
    assert.doesNotMatch(popup, /skillMentionInsertion\(item\.id\)/);
    assert.match(composer, /className="maka-composer-skill-chip"/);
    assert.match(composer, /props\.onSend\(text, skillIds\)/);
    assert.match(composer, /clearDraft\(draftKey\);\s*skillDraft\.clear\(draftKey\)/);
    assert.match(composer, /<UiButton[\s\S]*?size="icon"[\s\S]*?shape="pill"[\s\S]*?className="maka-composer-skill-chip-remove"/);
    assert.match(
      composer,
      /skillDraft\.remove\(skill\.ref \?\? skill\.id\);[\s\S]*?requestAnimationFrame\(\(\) => textareaRef\.current\?\.focus\(\)\)/,
    );
    assert.match(composer, /skillDraft\.skills\.map\(\(skill\) => skill\.ref \?\? skill\.id\)/);
    assert.match(draft, /storeRef = useRef<Map<string, ComposerSkillSelection\[\]>>/);
    assert.match(styles, /\.maka-composer-skill-chip \{[\s\S]*?min-height: 32px;/);
    assert.doesNotMatch(styles, /\.maka-composer-skill-chip-remove \{/);
  });

  it('clears the submitted Skill owner before guarding the visible draft', async () => {
    const composer = await read('packages/ui/src/composer.tsx');
    const clearSubmittedAt = composer.indexOf('skillDraft.clear(submittedSkillDraftKey)');
    const ownerGuardAt = composer.indexOf(
      'if (activeDraftKey() !== submittedDraftKey) return',
      clearSubmittedAt,
    );
    assert.ok(clearSubmittedAt >= 0 && ownerGuardAt > clearSubmittedAt);
  });

  it('re-resolves structured ids and direct tokens before consuming attachments', async () => {
    const sessions = await read('apps/desktop/src/main/sessions-ipc-main.ts');
    const sendPlan = await read('apps/desktop/src/main/session-send-skill-plan.ts');
    const runtime = await read('packages/runtime/src/skill-invocation.ts');

    const preparationAt = sessions.indexOf('const sendPlan = await prepareSessionSendSkillPlan');
    const resolveAt = sessions.indexOf('resolveSessionSend({', preparationAt);
    const sendAt = sessions.indexOf('const iterator = runtime.sendMessage(sessionId', resolveAt);
    assert.ok(preparationAt >= 0 && resolveAt > preparationAt && sendAt > resolveAt);
    assert.match(sessions, /prepareSkillInvocation\(sessionId, sendCommand\.text, sendCommand\.skillIds\)/);
    assert.match(sendPlan, /if \(preparation\.disposition === 'blocked'\)/);
    assert.match(runtime, /\.\.\.\(input\.skillIds \?\? \[\]\)/);
    assert.match(runtime, /loadedSkillInvocationReceipt\('explicit'/);
    assert.match(runtime, /Every invocation token is removed before provider[\s\S]*handoff/);
    assert.match(
      sessions,
      /sendCommand\.text\.trim\(\)\.length > 0[\s\S]*\.map\(\(skill\) => `\/skill:\$\{skill\.id\}`\)/,
      'chip-only sends must retain a readable user message instead of persisting a blank bubble',
    );
  });

  it('uses the same session project root and host for resolution and slash suggestions', async () => {
    const main = await read('apps/desktop/src/main/main.ts');
    const desktopToolSurface = await read(
      'apps/desktop/src/main/desktop-backend-tool-surface.ts',
    );
    const sessionStream = await read('apps/desktop/src/main/session-stream.ts');
    const workspaceIpc = await read('apps/desktop/src/main/workspace-resources-ipc-main.ts');
    const preload = await read('apps/desktop/src/preload/preload.ts');
    const mentions = await read('apps/desktop/src/renderer/use-composer-mentions.ts');
    assert.match(main, /resolveSkillDiscoveryPaths\([\s\S]*resolveProjectRootForContext\(sessionId\)[\s\S]*workspaceRoot/);
    assert.match(main, /resolveDesktopSkillHostForSession\(sessionId\)/);
    assert.match(main, /resolveDesktopSkillHostForNewSession\(projectRoot, newSessionContext\)/);
    assert.match(
      main,
      /resolveDesktopSessionSkillHost\(desktopBackendToolSurfaceDeps, \{[\s\S]*header,[\s\S]*childTools: childAgentTools/,
    );
    assert.match(
      main,
      /resolveDesktopNewSessionSkillHost\(desktopBackendToolSurfaceDeps, \{[\s\S]*context,/,
    );
    assert.match(
      desktopToolSurface,
      /resolveDesktopBackendToolSurface\(deps, \{[\s\S]*header: input\.header,[\s\S]*\{ tools \}/,
    );
    // #1433: the preview may READ the Deep Research label off a real header
    // (`isDeepResearchSession`), but it must not MINT one. Minting it here is
    // how the old Quick Chat panel ended up with a second, hand-written copy
    // of what is now `sessionModeSeed` — the sole authority on what a mode
    // implies. This fails the moment that derivation is written twice.
    assert.doesNotMatch(
      desktopToolSurface,
      /DEEP_RESEARCH_SESSION_LABEL/,
      'only create-session-input.ts may derive the Deep Research label',
    );
    assert.doesNotMatch(
      main,
      /host: desktopSessionSkillHosts\.get\(sessionId\) \?\? desktopHostCapabilities/,
    );
    assert.match(sessionStream, /resolveDesktopBackendToolSurface\(deps, ctx\)/);
    assert.doesNotMatch(main, /resolveDesktopSkillDiscoverySource/);
    assert.match(main, /listInvocableSkills: listDesktopInvocableSkills/);
    assert.match(
      main,
      /if \(sessionId && isSessionWorkspaceUnavailableError\(error\)\) return \[\]/,
      'stale sessions must fail soft without rejected Skill-list IPC noise',
    );
    assert.match(workspaceIpc, /'skills:listInvocable'[\s\S]*deps\.listInvocableSkills/);
    assert.match(preload, /listInvocable\([\s\S]*newSessionContext[\s\S]*skills:listInvocable/);
    assert.match(
      mentions,
      /window\.maka\.skills\.listInvocable\(\s*sessionId,\s*sessionId/,
    );
    assert.match(mentions, /window\.maka\.sessions\.subscribeChanges\(\(event\) =>/);
    assert.match(mentions, /window\.maka\.mcp\.subscribeChanges\(\(\) => refresh\(\)\)/);
    assert.doesNotMatch(mentions, /filter\(\(skill\) => skill\.enabled/);
  });

  it('uses readable text for chip-only optimistic messages', async () => {
    const renderer = await read('apps/desktop/src/renderer/app-shell-chat-actions.ts');
    assert.match(
      renderer,
      /showOptimisticUserMessage\([\s\S]*skillInvocationDisplayText\(text, sendResult\.skillInvocation\)[\s\S]*sendResult\.attachments/,
    );
  });

  it('scopes transient failure feedback to the composer that initiated the send', async () => {
    const renderer = await read('apps/desktop/src/renderer/app-shell-chat-actions.ts');
    assert.match(
      renderer,
      /if \(newChatOwner && isNewChatSendSurfaceActive\(newChatOwner\)\) \{\s*showSkillInvocationFeedback/,
    );
    assert.match(
      renderer,
      /if \(activeIdRef\.current === sessionId\) \{\s*showSkillInvocationFeedback/,
    );
  });

  it('keeps a deterministic visual fixture for the real structured chip', async () => {
    const fixture = await read('apps/desktop/src/main/e2e-fixture.ts');
    const renderer = await read('apps/desktop/src/renderer/app-shell-e2e-fixture.ts');
    assert.match(fixture, /case 'composer-skill-invocation':[\s\S]*composerSkills:/);
    assert.match(renderer, /composerRef\.current\?\.setSkills\(state\.composerSkills\)/);
  });
});
