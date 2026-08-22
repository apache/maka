import assert from 'node:assert/strict';
import test from 'node:test';

import { isWorkspaceIdentity, workspaceIdentityFromUuid } from '../workspace-identity.js';

test('Workspace identities use one canonical lowercase representation', () => {
  const uuid = '123E4567-E89B-42D3-A456-426614174000';

  assert.equal(
    workspaceIdentityFromUuid(uuid),
    'workspace:v1:123e4567-e89b-42d3-a456-426614174000',
  );
  assert.equal(isWorkspaceIdentity('workspace:v1:123e4567-e89b-42d3-a456-426614174000'), true);
  assert.equal(isWorkspaceIdentity(`workspace:v1:${uuid}`), false);
  assert.equal(isWorkspaceIdentity('/workspace/maka'), false);
});
