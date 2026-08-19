import { Service, type Context } from './plugin-kernel.js';
import {
  type ExtensionUiContribution,
  type ExtensionUiContributionInspection,
  ExtensionUiContributionRegistry,
  type ExtensionUiReadiness,
  type ExtensionUiReadinessInspection,
} from './extension-ui-contributions.js';
import { pluginIdentity, registerPluginContribution } from './plugin-runtime.js';

declare module './plugin-kernel.js' {
  interface Context {
    ui: PluginUiService;
  }
}

export class PluginUiService extends Service {
  readonly registry = new ExtensionUiContributionRegistry();

  constructor(ctx: Context) {
    super(ctx, 'ui');
  }

  register(contribution: ExtensionUiContribution): void {
    const identity = pluginIdentity(this.ctx);
    const registry = this.registry;
    registerPluginContribution(this.ctx, `ui:${contribution.id}`, () =>
      registry.register(identity, contribution),
    );
  }

  inspect(
    rootId: string,
    committed: readonly { readonly entryId: string; readonly generation: number }[],
  ): readonly ExtensionUiContributionInspection[] {
    return this.registry.inspect(rootId, committed);
  }

  setReadiness(
    entryId: string,
    generation: number,
    status: ExtensionUiReadiness,
    diagnostic?: string,
  ): void {
    const identity = pluginIdentity(this.ctx);
    this.registry.setReadiness(identity.scopeId, entryId, generation, status, diagnostic);
  }

  setReadinessForRoot(
    rootId: string,
    entryId: string,
    generation: number,
    status: ExtensionUiReadiness,
    diagnostic?: string,
  ): void {
    this.registry.setReadiness(rootId, entryId, generation, status, diagnostic);
  }

  inspectReadiness(rootId?: string): readonly ExtensionUiReadinessInspection[] {
    return this.registry.inspectReadiness(rootId);
  }
}
