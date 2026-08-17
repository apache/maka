import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeExtensionCatalogMutateInput,
  decodeExtensionCatalogQueryResult,
  decodeExtensionContractQueryResult,
  decodeExtensionConfigurationMutateInput,
  decodeExtensionPackageExportInput,
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
    decodeExtensionContractQueryResult({
      packages: [
        {
          extensionId: 'dev.maka.weather',
          revision: 'sha256-demo',
          version: '1.2.0',
          displayName: 'Weather',
          description: '',
          dependencies: [{ id: 'dev.maka.http', version: '^1.0.0' }],
          configuration: {
            properties: {
              apiKey: { type: 'string', secret: true },
            },
            required: ['apiKey'],
          },
          contributions: [
            { kind: 'ui', id: 'root', surface: 'app.root', slots: ['weather.details'] },
            { kind: 'hook', id: 'policy', event: 'PreToolUse', mode: 'gate' },
            {
              kind: 'event',
              id: 'dev.maka.weather.changed',
              event: 'dev.maka.weather.changed',
              description: 'Weather changed.',
            },
            {
              kind: 'listener',
              id: 'refresh',
              event: 'dev.maka.weather.changed',
            },
          ],
        },
      ],
    }).packages[0]?.contributions[0]?.slots,
    ['weather.details'],
  );
  assert.equal(
    decodeExtensionContractQueryResult({
      packages: [
        {
          extensionId: 'dev.maka.policy',
          revision: 'sha256-demo',
          version: '1.0.0',
          displayName: 'Policy',
          description: '',
          dependencies: [],
          configuration: { properties: {}, required: [] },
          contributions: [{ kind: 'hook', id: 'policy', event: 'PreToolUse', mode: 'gate' }],
        },
      ],
    }).packages[0]?.contributions[0]?.event,
    'PreToolUse',
  );
  assert.equal(
    decodeExtensionContractQueryResult({
      packages: [
        {
          extensionId: 'dev.maka.events',
          revision: 'sha256-demo',
          version: '1.0.0',
          displayName: 'Events',
          description: '',
          dependencies: [],
          configuration: { properties: {}, required: [] },
          contributions: [
            {
              kind: 'listener',
              id: 'observe',
              event: 'dev.maka.events.changed',
            },
          ],
        },
      ],
    }).packages[0]?.contributions[0]?.event,
    'dev.maka.events.changed',
  );
  assert.deepEqual(
    decodeExtensionConfigurationMutateInput({
      bindingId: 'weather-binding',
      configuration: { apiKey: 'secret', retries: 3 },
    }),
    { bindingId: 'weather-binding', configuration: { apiKey: 'secret', retries: 3 } },
  );
  assert.deepEqual(
    decodeExtensionPackageExportInput({
      extensionId: 'dev.maka.weather',
      revision: 'sha256-demo',
      targetPath: '/tmp/weather.maka-extension',
    }),
    {
      extensionId: 'dev.maka.weather',
      revision: 'sha256-demo',
      targetPath: '/tmp/weather.maka-extension',
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
          sessionAccess: true,
        },
        {
          bindingId: 'legacy-overlay-binding',
          extensionId: 'dev.maka.legacy-overlay',
          revision: '1',
          id: 'legacy-overlay',
          surface: 'app.overlay',
          priority: 10,
          document: '<aside>Legacy</aside>',
          documentSha256: 'legacy-demo',
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
          sessionAccess: true,
        },
        {
          bindingId: 'legacy-overlay-binding',
          extensionId: 'dev.maka.legacy-overlay',
          revision: '1',
          id: 'legacy-overlay',
          surface: 'app.overlay',
          priority: 10,
          document: '<aside>Legacy</aside>',
          documentSha256: 'legacy-demo',
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
          eventContributionIds: [],
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
          eventContributionIds: [],
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
  assert.equal(operationAllowsRemoteOwner('extension.package.export'), false);
  assert.equal(operationAllowsRemoteOwner('extension.configuration.mutate'), false);
});
