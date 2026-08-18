import { Service, type Context } from './plugin-kernel.js';
import {
  type ExtensionEventDefinition,
  type ExtensionEventDefinitionInspection,
  type ExtensionEventListenerContribution,
  type ExtensionEventListenerInspection,
  ExtensionEventContributionRegistry,
} from './extension-event-contributions.js';
import { pluginIdentity, registerPluginContribution } from './plugin-runtime.js';

declare module './plugin-kernel.js' {
  interface Context {
    hooks: PluginHookService;
  }
}

export class PluginHookService extends Service {
  readonly registry = new ExtensionEventContributionRegistry();

  constructor(ctx: Context) {
    super(ctx, 'hooks');
  }

  define(definition: ExtensionEventDefinition): void {
    const identity = pluginIdentity(this.ctx);
    registerPluginContribution(this.ctx, `event:${definition.name}`, () =>
      this.registry.registerEvent(identity as never, definition),
    );
  }

  on(listener: ExtensionEventListenerContribution): void {
    const identity = pluginIdentity(this.ctx);
    registerPluginContribution(this.ctx, `listener:${listener.event}:${listener.id}`, () =>
      this.registry.registerListener(identity as never, listener),
    );
  }

  inspectEvents(
    rootIds: readonly string[],
    committed?: readonly { readonly entryId: string; readonly revision: string }[],
  ): readonly ExtensionEventDefinitionInspection[] {
    return this.registry.inspectEvents(rootIds, committed);
  }

  inspectListeners(
    rootIds: readonly string[],
    committed?: readonly { readonly entryId: string; readonly revision: string }[],
  ): readonly ExtensionEventListenerInspection[] {
    return this.registry.inspectListeners(rootIds, committed);
  }
}
