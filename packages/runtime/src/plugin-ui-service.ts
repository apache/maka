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
    registerPluginContribution(this.ctx, `ui:${contribution.id}`, () =>
      this.registry.register(identity, contribution),
    );
  }

  inspect(
    rootId: string,
    committed: readonly { readonly bindingId: string; readonly revision: string }[],
  ): readonly ExtensionUiContributionInspection[] {
    return this.registry.inspect(rootId, committed);
  }

  setReadiness(
    entryId: string,
    revision: string,
    status: ExtensionUiReadiness,
    diagnostic?: string,
  ): void {
    const identity = pluginIdentity(this.ctx);
    this.registry.setReadiness(identity.scopeId, entryId, revision, status, diagnostic);
  }

  inspectReadiness(rootId?: string): readonly ExtensionUiReadinessInspection[] {
    return this.registry.inspectReadiness(rootId);
  }
}
