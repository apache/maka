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
    const registry = this.registry;
    registerPluginContribution(this.ctx, `event:${definition.name}`, () =>
      registry.registerEvent(identity as never, definition),
    );
  }

  on(listener: ExtensionEventListenerContribution): void {
    const identity = pluginIdentity(this.ctx);
    const registry = this.registry;
    registerPluginContribution(this.ctx, `listener:${listener.event}:${listener.id}`, () =>
      registry.registerListener(identity as never, listener),
    );
  }

  inspectEvents(
    rootIds: readonly string[],
    committed?: readonly { readonly entryId: string; readonly generation: number }[],
  ): readonly ExtensionEventDefinitionInspection[] {
    return this.registry.inspectEvents(rootIds, committed);
  }

  inspectListeners(
    rootIds: readonly string[],
    committed?: readonly { readonly entryId: string; readonly generation: number }[],
  ): readonly ExtensionEventListenerInspection[] {
    return this.registry.inspectListeners(rootIds, committed);
  }

  parsePayload(
    rootIds: readonly string[],
    committed: readonly { readonly entryId: string; readonly generation: number }[],
    event: string,
    payload: unknown,
  ): unknown {
    return this.registry.parsePayload(rootIds, committed, event, payload);
  }

  resolveDefinition(
    rootIds: readonly string[],
    committed: readonly { readonly entryId: string; readonly generation: number }[],
    event: string,
  ): ExtensionEventDefinitionInspection {
    return this.registry.resolveDefinition(rootIds, committed, event);
  }

  parseResult(
    rootIds: readonly string[],
    committed: readonly { readonly entryId: string; readonly generation: number }[],
    event: string,
    result: unknown,
  ): unknown {
    return this.registry.parseResult(rootIds, committed, event, result);
  }
}
