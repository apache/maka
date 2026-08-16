import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ExtensionLifecycleKernel } from '../extension-lifecycle-kernel.js';
import {
  defineTrustedUiExtensionRevision,
  ExtensionUiContributionRegistry,
  validateExtensionUiContribution,
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
    assert.deepEqual(Object.keys(registry.inspect('desktop-ui', committed(kernel))[0]!).sort(), [
      'bindingId',
      'document',
      'documentSha256',
      'extensionId',
      'hostMethods',
      'hostState',
      'id',
      'network',
      'priority',
      'revision',
      'scopeId',
      'sessionAccess',
      'slots',
      'surface',
    ]);
    assert.doesNotThrow(() => structuredClone(registry.inspect('desktop-ui', committed(kernel))));
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

  test('composes five independent slots and isolates 1,000 child updates from the root', async () => {
    const kernel = new ExtensionLifecycleKernel();
    const registry = new ExtensionUiContributionRegistry();
    await kernel.install(
      defineTrustedUiExtensionRevision({
        registry,
        extensionId: 'official-layout',
        revision: '1',
        ui: [ui('<main>official root</main>')],
      }),
    );
    await kernel.activate({
      bindingId: 'official-layout-binding',
      scopeId: 'desktop-ui',
      extensionId: 'official-layout',
      revision: '1',
    });

    for (let index = 1; index <= 5; index += 1) {
      for (const revision of ['1', '2']) {
        await kernel.install(
          defineTrustedUiExtensionRevision({
            registry,
            extensionId: `component-${index}`,
            revision,
            ui: [slot(`component-${index}`, 'conversation.header', `<p>${index}:${revision}</p>`)],
          }),
        );
      }
      await kernel.activate({
        bindingId: `component-${index}-binding`,
        scopeId: 'desktop-ui',
        extensionId: `component-${index}`,
        revision: '1',
      });
    }

    for (let iteration = 0; iteration < 1_000; iteration += 1) {
      await kernel.update('component-3-binding', iteration % 2 === 0 ? '2' : '1');
      const composed = registry.inspect('desktop-ui', committed(kernel));
      assert.equal(composed.length, 6);
      assert.equal(composed.find(({ surface }) => surface === 'app.root')?.revision, '1');
      assert.equal(
        composed
          .filter(({ extensionId }) => extensionId !== 'component-3')
          .every(({ revision }) => revision === '1'),
        true,
      );
    }

    await kernel.install(
      defineTrustedUiExtensionRevision({
        registry,
        extensionId: 'component-3',
        revision: 'broken',
        ui: [slot('component-3', 'conversation.header', '<p>broken</p>')],
        healthCheck: () => {
          throw new Error('candidate failed');
        },
      }),
    );
    await assert.rejects(kernel.update('component-3-binding', 'broken'), /health_check failed/);

    const final = registry.inspect('desktop-ui', committed(kernel));
    assert.equal(final.filter(({ surface }) => surface === 'app.root').length, 1);
    assert.equal(final.filter(({ surface }) => surface === 'app.slot').length, 5);
    assert.equal(new Set(final.map(({ id }) => id)).size, 6);
    assert.equal(final.find(({ extensionId }) => extensionId === 'component-3')?.revision, '1');
    assert.equal(
      final.every(({ revision }) => revision === '1'),
      true,
    );
  });

  test('requires a canonical slot name only for app.slot contributions', () => {
    assert.doesNotThrow(() =>
      validateExtensionUiContribution(slot('status', 'settings.content', '<p>status</p>')),
    );
    assert.throws(
      () =>
        validateExtensionUiContribution({
          ...slot('status', 'settings.content', '<p>status</p>'),
          slot: 'Settings Content',
        }),
      /slot name is invalid/,
    );
    assert.throws(
      () => validateExtensionUiContribution({ ...ui('<p>root</p>'), slot: 'settings.content' }),
      /Only an app.slot contribution/,
    );
  });

  test('projects a dynamic three-level slot tree without coupling child revisions', async () => {
    const kernel = new ExtensionLifecycleKernel();
    const registry = new ExtensionUiContributionRegistry();
    const definitions = [
      {
        extensionId: 'layout',
        revision: '1',
        ui: [{ ...ui('<main data-maka-slot="layout.body"></main>'), slots: ['layout.body'] }],
      },
      {
        extensionId: 'body',
        revision: '1',
        ui: [
          {
            ...slot('body', 'layout.body', '<section data-maka-slot="body.footer"></section>'),
            slots: ['body.footer'],
          },
        ],
      },
      {
        extensionId: 'footer',
        revision: '1',
        ui: [slot('footer', 'body.footer', '<footer>ready</footer>')],
      },
    ] as const;
    for (const definition of definitions) {
      await kernel.install(defineTrustedUiExtensionRevision({ registry, ...definition }));
      await kernel.activate({
        bindingId: `${definition.extensionId}-binding`,
        scopeId: 'desktop-ui',
        extensionId: definition.extensionId,
        revision: definition.revision,
      });
    }
    const projected = registry.inspect('desktop-ui', committed(kernel));
    assert.deepEqual(
      projected.map(({ id, slot, slots }) => ({ id, slot, slots })),
      [
        { id: 'app', slot: undefined, slots: ['layout.body'] },
        { id: 'body', slot: 'layout.body', slots: ['body.footer'] },
        { id: 'footer', slot: 'body.footer', slots: [] },
      ],
    );
  });
});

function ui(document: string) {
  return { id: 'app', surface: 'app.root' as const, priority: 100, document, network: false };
}

function slot(id: string, name: string, document: string) {
  return {
    id,
    surface: 'app.slot' as const,
    slot: name,
    priority: 100,
    document,
    network: false,
  };
}

function committed(kernel: ExtensionLifecycleKernel) {
  return kernel
    .inspectScope('desktop-ui')
    .flatMap((binding) =>
      binding.current ? [{ bindingId: binding.bindingId, revision: binding.current.revision }] : [],
    );
}
