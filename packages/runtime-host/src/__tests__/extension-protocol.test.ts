import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeExtensionCatalogMutateInput,
  decodeExtensionCatalogQueryResult,
} from '../protocol/extension.js';
import { operationAllowsRemoteOwner } from '../protocol/operations.js';

test('Extension control protocol strictly decodes catalog and lifecycle mutations', () => {
  assert.deepEqual(
    decodeExtensionCatalogMutateInput({
      kind: 'enable',
      bindingId: 'weather-binding',
      scopeId: 'session-1',
      extensionId: 'weather',
      revision: '2',
    }),
    {
      kind: 'enable',
      bindingId: 'weather-binding',
      scopeId: 'session-1',
      extensionId: 'weather',
      revision: '2',
    },
  );
  assert.deepEqual(
    decodeExtensionCatalogQueryResult({
      revisions: [{ extensionId: 'weather', revision: '2', toolNames: ['Weather'] }],
      bindings: [
        {
          bindingId: 'weather-binding',
          scopeId: 'session-1',
          extensionId: 'weather',
          desiredRevision: '2',
          lastGoodRevision: '2',
          enabled: true,
          status: 'active',
          error: null,
        },
      ],
    }),
    {
      revisions: [{ extensionId: 'weather', revision: '2', toolNames: ['Weather'] }],
      bindings: [
        {
          bindingId: 'weather-binding',
          scopeId: 'session-1',
          extensionId: 'weather',
          desiredRevision: '2',
          lastGoodRevision: '2',
          enabled: true,
          status: 'active',
          error: null,
        },
      ],
    },
  );

  assert.throws(
    () =>
      decodeExtensionCatalogMutateInput({
        kind: 'enable',
        bindingId: 'weather-binding',
        scopeId: 'session-1',
        extensionId: 'weather',
        revision: '2',
        modulePath: '/tmp/untrusted.mjs',
      }),
    /Unknown extension enable input field/,
  );
  assert.throws(
    () =>
      decodeExtensionCatalogMutateInput({
        kind: 'update',
        bindingId: 'weather-binding',
        revision: 'bad\nrevision',
      }),
    /Invalid extension revision/,
  );
  assert.equal(operationAllowsRemoteOwner('extension.catalog.query'), false);
  assert.equal(operationAllowsRemoteOwner('extension.catalog.mutate'), false);
});
