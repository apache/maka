import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeExtensionCatalogMutateInput,
  decodeExtensionCatalogQueryResult,
  decodeExtensionUiRpcInvokeInput,
  decodeExtensionUiSnapshotResult,
  decodeToolPackageInstallInput,
  decodeToolPackageUninstallInput,
} from '../protocol/extension.js';
import { operationAllowsRemoteOwner } from '../protocol/operations.js';

test('Extension control protocol strictly decodes catalog and lifecycle mutations', () => {
  assert.deepEqual(
    decodeExtensionCatalogMutateInput({
      kind: 'enable',
      bindingId: 'weather-binding',
      scopeId: 'session:1',
      extensionId: 'dev.maka.weather',
      revision: '2',
    }),
    {
      kind: 'enable',
      bindingId: 'weather-binding',
      scopeId: 'session:1',
      extensionId: 'dev.maka.weather',
      revision: '2',
    },
  );
  assert.deepEqual(
    decodeExtensionUiRpcInvokeInput({
      scopeId: 'desktop-ui',
      bindingId: 'ui-binding',
      extensionId: 'dev.maka.appearance',
      revision: '2',
      method: 'lookup',
      args: { query: 'Maka' },
    }),
    {
      scopeId: 'desktop-ui',
      bindingId: 'ui-binding',
      extensionId: 'dev.maka.appearance',
      revision: '2',
      method: 'lookup',
      args: { query: 'Maka' },
    },
  );
  assert.deepEqual(
    decodeExtensionUiSnapshotResult({
      scopeId: 'desktop-ui',
      digest: 'sha256-demo',
      contributions: [
        {
          bindingId: 'ui-binding',
          extensionId: 'dev.maka.appearance',
          revision: '2',
          id: 'root',
          surface: 'app.root',
          priority: 100,
          document: '<main>Maka</main>',
          documentSha256: 'demo',
          network: false,
        },
      ],
    }),
    {
      scopeId: 'desktop-ui',
      digest: 'sha256-demo',
      contributions: [
        {
          bindingId: 'ui-binding',
          extensionId: 'dev.maka.appearance',
          revision: '2',
          id: 'root',
          surface: 'app.root',
          priority: 100,
          document: '<main>Maka</main>',
          documentSha256: 'demo',
          network: false,
        },
      ],
    },
  );
  assert.deepEqual(
    decodeExtensionCatalogQueryResult({
      revisions: [
        {
          extensionId: 'dev.maka.weather',
          revision: '2',
          toolNames: ['Weather'],
          uiContributionIds: [],
        },
      ],
      bindings: [
        {
          bindingId: 'weather-binding',
          scopeId: 'session:1',
          extensionId: 'dev.maka.weather',
          desiredRevision: '2',
          lastGoodRevision: '2',
          enabled: true,
          status: 'active',
          error: null,
        },
      ],
    }),
    {
      revisions: [
        {
          extensionId: 'dev.maka.weather',
          revision: '2',
          toolNames: ['Weather'],
          uiContributionIds: [],
        },
      ],
      bindings: [
        {
          bindingId: 'weather-binding',
          scopeId: 'session:1',
          extensionId: 'dev.maka.weather',
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
  assert.deepEqual(decodeToolPackageInstallInput({ sourcePath: '/tmp/weather-tool' }), {
    sourcePath: '/tmp/weather-tool',
  });
  assert.deepEqual(
    decodeToolPackageUninstallInput({
      extensionId: 'weather',
      revision: `sha256-${'a'.repeat(64)}`,
    }),
    { extensionId: 'weather', revision: `sha256-${'a'.repeat(64)}` },
  );
  assert.throws(
    () => decodeToolPackageInstallInput({ sourcePath: '/tmp/weather-tool', source: 'inline' }),
    /Unknown Tool package install input field/u,
  );
  assert.equal(operationAllowsRemoteOwner('extension.catalog.query'), false);
  assert.equal(operationAllowsRemoteOwner('extension.catalog.mutate'), false);
  assert.equal(operationAllowsRemoteOwner('extension.ui.snapshot'), false);
  assert.equal(operationAllowsRemoteOwner('extension.ui.rpc.invoke'), false);
  assert.equal(operationAllowsRemoteOwner('extension.package.install'), false);
  assert.equal(operationAllowsRemoteOwner('extension.package.uninstall'), false);
});
