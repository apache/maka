import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ExtensionLifecycleKernel } from '../extension-lifecycle-kernel.js';
import {
  defineTrustedUiExtensionRevision,
  ExtensionUiContributionRegistry,
} from '../extension-ui-contributions.js';

describe('Extension UI contributions', () => {
  test('keeps the committed UI visible across candidate activation and owns cleanup', async () => {
    const kernel = new ExtensionLifecycleKernel();
    const registry = new ExtensionUiContributionRegistry();
    let candidateObserved: string | undefined;
    for (const revision of ['1', '2']) {
      await kernel.install(
        defineTrustedUiExtensionRevision({
          registry,
          extensionId: 'appearance',
          revision,
          ui: [ui(`<h1>revision ${revision}</h1>`)],
          ...(revision === '2'
            ? {
                healthCheck: () => {
                  candidateObserved = registry.inspect('desktop-ui', committed(kernel))[0]
                    ?.document;
                },
              }
            : {}),
        }),
      );
    }
    await kernel.activate({
      bindingId: 'appearance-binding',
      scopeId: 'desktop-ui',
      extensionId: 'appearance',
      revision: '1',
    });
    assert.equal(
      registry.inspect('desktop-ui', committed(kernel))[0]?.document,
      '<h1>revision 1</h1>',
    );
    await kernel.update('appearance-binding', '2');
    assert.equal(candidateObserved, '<h1>revision 1</h1>');
    assert.equal(
      registry.inspect('desktop-ui', committed(kernel))[0]?.document,
      '<h1>revision 2</h1>',
    );
    await kernel.stop('appearance-binding');
    assert.deepEqual(registry.inspect('desktop-ui', committed(kernel)), []);
    await kernel.start('appearance-binding');
    assert.equal(registry.inspect('desktop-ui', committed(kernel))[0]?.revision, '2');
    await kernel.removeBinding('appearance-binding');
    assert.deepEqual(registry.inspect('desktop-ui', committed(kernel)), []);
  });

  test('failed candidate keeps current UI and conflicting ids are rejected', async () => {
    const kernel = new ExtensionLifecycleKernel();
    const registry = new ExtensionUiContributionRegistry();
    await kernel.install(
      defineTrustedUiExtensionRevision({
        registry,
        extensionId: 'current',
        revision: '1',
        ui: [ui('<p>current</p>')],
      }),
    );
    await kernel.install(
      defineTrustedUiExtensionRevision({
        registry,
        extensionId: 'other',
        revision: '1',
        ui: [ui('<p>other</p>')],
      }),
    );
    await kernel.activate({
      bindingId: 'current-binding',
      scopeId: 'desktop-ui',
      extensionId: 'current',
      revision: '1',
    });
    await assert.rejects(
      kernel.activate({
        bindingId: 'other-binding',
        scopeId: 'desktop-ui',
        extensionId: 'other',
        revision: '1',
      }),
      /activation failed/,
    );
    assert.deepEqual(
      registry.inspect('desktop-ui', committed(kernel)).map(({ extensionId }) => extensionId),
      ['current'],
    );
  });
});

function ui(document: string) {
  return { id: 'app', surface: 'app.root' as const, priority: 100, document, network: false };
}

function committed(kernel: ExtensionLifecycleKernel) {
  return kernel
    .inspectScope('desktop-ui')
    .flatMap((binding) =>
      binding.current ? [{ bindingId: binding.bindingId, revision: binding.current.revision }] : [],
    );
}
