import assert from 'node:assert/strict';
import test from 'node:test';
import { registerRuntimeHostSkillsIpc } from '../runtime-host-skills-ipc-main.js';

test('keeps a resolved Skill mutation on one project root', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const catalogContexts: unknown[] = [];
  const mutationContexts: unknown[] = [];
  let workspaceReads = 0;
  let mutationAttempts = 0;
  registerRuntimeHostSkillsIpc({
    ipcMain: {
      handle: (channel, handler) => {
        handlers.set(channel, handler as (...args: unknown[]) => unknown);
      },
    },
    client: {
      loadSkillCatalog: async ({ workspace }: { workspace: unknown }) => {
        catalogContexts.push(workspace);
        return {
          revision: `sha256:${'a'.repeat(64)}`,
          view: 'governance',
          items: [{ kind: 'skill', id: 'writer', ref: 'project:writer' }],
        };
      },
      mutateSkillCatalog: async ({ context }: { context: { workspace: unknown } }) => {
        mutationContexts.push(context.workspace);
        mutationAttempts += 1;
        if (mutationAttempts === 1) return { kind: 'revision_conflict' };
        return { kind: 'rejected', reason: 'not_found' };
      },
    } as never,
    workspaceRoot: '/tmp/maka-runtime-host-skills-workspace',
    mainWindowController: {} as never,
    getCurrentWorkspace: async () => {
      workspaceReads += 1;
      const suffix = workspaceReads === 1 ? 'a' : 'b';
      return {
        target: { kind: 'project', projectId: `project-${suffix}` },
        hostCwd: `/tmp/project-${suffix}`,
      };
    },
    getDefaultPermissionMode: async () => 'ask',
    openPath: async () => '',
  });

  await handlers.get('skills:setEnabled')?.({}, 'writer', true);

  assert.equal(workspaceReads, 1);
  assert.deepEqual(catalogContexts, [
    { kind: 'project', projectId: 'project-a' },
    { kind: 'project', projectId: 'project-a' },
  ]);
  assert.deepEqual(mutationContexts, catalogContexts);
});

test('requests the Host-owned invocable projection for existing and new Sessions', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const targets: unknown[] = [];
  registerRuntimeHostSkillsIpc({
    ipcMain: {
      handle: (channel, handler) => {
        handlers.set(channel, handler as (...args: unknown[]) => unknown);
      },
    },
    client: {
      listInvocableSkills: async (target: unknown) => {
        targets.push(target);
        return [{ ref: 'project:review', id: 'review', name: 'Review', description: 'Review code' }];
      },
    } as never,
    workspaceRoot: '/tmp/maka-runtime-host-skills-workspace',
    mainWindowController: {} as never,
    getCurrentWorkspace: async () => ({
      target: { kind: 'project', projectId: 'project-a' },
      hostCwd: '/tmp/project-a',
    }),
    getDefaultPermissionMode: async () => 'bypass',
    openPath: async () => '',
  });

  const list = handlers.get('skills:listInvocable');
  assert.ok(list);
  assert.deepEqual(await list({}, 'session-1'), [
    { ref: 'project:review', id: 'review', name: 'Review', description: 'Review code' },
  ]);
  await list({}, undefined, { collaborationMode: 'plan', model: 'ignored-model' });
  assert.deepEqual(targets, [
    { kind: 'session', sessionId: 'session-1' },
    {
      kind: 'new_session',
      context: { workspace: { kind: 'project', projectId: 'project-a' } },
      collaborationMode: 'plan',
      permissionMode: 'bypass',
    },
  ]);
});
