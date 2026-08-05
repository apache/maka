import assert from 'node:assert/strict';
import test from 'node:test';
import { registerRuntimeHostSkillsIpc } from '../runtime-host-skills-ipc-main.js';

test('keeps a resolved Skill mutation on one project root', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const catalogContexts: string[] = [];
  const mutationContexts: string[] = [];
  let rootReads = 0;
  let mutationAttempts = 0;
  registerRuntimeHostSkillsIpc({
    ipcMain: {
      handle: (channel, handler) => {
        handlers.set(channel, handler as (...args: unknown[]) => unknown);
      },
    },
    client: {
      loadSkillCatalog: async ({ projectRoot }: { projectRoot: string }) => {
        catalogContexts.push(projectRoot);
        return {
          revision: `sha256:${'a'.repeat(64)}`,
          view: 'governance',
          items: [{ kind: 'skill', id: 'writer', ref: 'project:writer' }],
        };
      },
      mutateSkillCatalog: async ({ context }: { context: { projectRoot: string } }) => {
        mutationContexts.push(context.projectRoot);
        mutationAttempts += 1;
        if (mutationAttempts === 1) return { kind: 'revision_conflict' };
        return { kind: 'rejected', reason: 'not_found' };
      },
    } as never,
    workspaceRoot: '/tmp/maka-runtime-host-skills-workspace',
    mainWindowController: {} as never,
    getCurrentProjectRoot: async () => {
      rootReads += 1;
      return rootReads === 1 ? '/tmp/project-a' : '/tmp/project-b';
    },
    openPath: async () => '',
  });

  await handlers.get('skills:setEnabled')?.({}, 'writer', true);

  assert.equal(rootReads, 1);
  assert.deepEqual(catalogContexts, ['/tmp/project-a', '/tmp/project-a']);
  assert.deepEqual(mutationContexts, ['/tmp/project-a', '/tmp/project-a']);
});
