import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = process.cwd().endsWith('apps/desktop')
  ? resolve(process.cwd(), '..', '..')
  : process.cwd();

async function source(relativePath: string): Promise<string> {
  return readFile(resolve(REPO_ROOT, relativePath), 'utf8');
}

describe('preload bridge contract', () => {
  it('uses one preload-owned contract for runtime exposure and renderer types', async () => {
    const [preload, bridge, globalTypes] = await Promise.all([
      source('apps/desktop/src/preload/preload.ts'),
      source('apps/desktop/src/preload/bridge-contract.d.ts'),
      source('apps/desktop/src/global.d.ts'),
    ]);

    assert.match(preload, /const makaBridge = \{/);
    assert.match(preload, /\} satisfies MakaBridge;/);
    assert.match(preload, /contextBridge\.exposeInMainWorld\('maka', makaBridge\)/);
    assert.doesNotMatch(preload, /from ['"]\.\.\/main\//);
    assert.match(preload, /from ['"]\.\/attachment-ingest-payload\.js['"]/);

    assert.match(bridge, /export interface MakaBridge \{/);
    assert.match(bridge, /attachmentItems\?: RendererIngestInput\[\]/);
    assert.match(bridge, /export type PermissionActionResult =/);
    assert.match(
      bridge,
      /\| 'invalid_id'[\s\S]*\| 'unsupported_platform'[\s\S]*\| 'unsupported_permission'[\s\S]*\| 'open_settings_failed'[\s\S]*\| 'denied'[\s\S]*\| 'failed'/,
    );
    assert.match(bridge, /openSystemSettings\(permId: string\): Promise<PermissionActionResult>/);
    assert.match(bridge, /requestAccess\(permId: string\): Promise<PermissionActionResult>/);
    assert.match(preload, /openSystemSettings\(permId: string\): Promise<PermissionActionResult>/);
    assert.match(preload, /requestAccess\(permId: string\): Promise<PermissionActionResult>/);
    assert.match(globalTypes, /import type \{ MakaBridge \} from ['"]\.\/preload\/bridge-contract\.js['"]/);
    assert.match(globalTypes, /maka: MakaBridge/);
  });
});
