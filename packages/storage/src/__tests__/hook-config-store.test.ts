import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createHookConfigStore, normalizeHookConfig } from '../hook-config-store.js';
import { createHookTrustStore } from '../hook-trust-store.js';

describe('Hook config store', () => {
  it('normalizes the bounded command-only v1 contract', () => {
    const config = normalizeHookConfig({
      version: 1,
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash|mcp__github__*',
            hooks: [
              {
                id: 'policy',
                type: 'command',
                command: '/usr/bin/true',
              },
            ],
          },
        ],
      },
    });
    assert.deepEqual(config.hooks.PreToolUse?.[0]?.hooks[0], {
      id: 'policy',
      type: 'command',
      command: '/usr/bin/true',
      args: [],
      timeoutMs: 3_000,
      enabled: true,
    });
  });

  it('rejects unknown fields, shell strings, arbitrary globs, and duplicate ids', () => {
    assert.throws(
      () => normalizeHookConfig({ version: 1, hooks: {}, typo: true }),
      /unknown field/u,
    );
    assert.throws(
      () =>
        normalizeHookConfig({
          version: 1,
          hooks: {
            PreToolUse: [
              {
                matcher: 'B*sh',
                hooks: [{ id: 'x', type: 'command', command: '/usr/bin/true' }],
              },
            ],
          },
        }),
      /matcher is invalid/u,
    );
    assert.throws(
      () =>
        normalizeHookConfig({
          version: 1,
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  { id: 'same', type: 'command', command: '/usr/bin/true' },
                  { id: 'same', type: 'command', command: '/usr/bin/false' },
                ],
              },
            ],
          },
        }),
      /Duplicate/u,
    );
    assert.throws(
      () =>
        normalizeHookConfig({
          version: 1,
          hooks: {
            PreToolUse: [{ hooks: [{ id: 'x', type: 'command', command: 'echo unsafe' }] }],
          },
        }),
      /absolute path/u,
    );
  });

  it('persists private config and exact-hash trust records atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-hooks-store-'));
    try {
      const configStore = createHookConfigStore(root);
      await configStore.set({
        version: 1,
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [{ id: 'policy', type: 'command', command: '/usr/bin/true' }],
            },
          ],
        },
      });
      assert.equal((await configStore.get()).hooks.PreToolUse?.[0]?.matcher, 'Bash');
      assert.match(await readFile(join(root, 'hooks.json'), 'utf8'), /"policy"/u);

      const trustStore = createHookTrustStore(root);
      const hash = `sha256:${'a'.repeat(64)}` as const;
      await trustStore.trust({
        definitionHash: hash,
        source: 'user',
        projectIdentity: 'user',
        trustedAt: 123,
      });
      assert.equal((await trustStore.get()).trustedDefinitions[0]?.definitionHash, hash);
      await trustStore.revoke(hash);
      assert.deepEqual((await trustStore.get()).trustedDefinitions, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
