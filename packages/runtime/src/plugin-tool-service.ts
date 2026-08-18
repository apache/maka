import { Service, type Context } from './plugin-kernel.js';
import type { MakaTool } from './tool-runtime.js';
import {
  ExtensionToolContributionRegistry,
  type ExtensionToolContributionInspection,
  type ExtensionToolContributionRegistryOptions,
} from './extension-tool-contributions.js';
import { pluginIdentity, registerPluginContribution } from './plugin-runtime.js';

declare module './plugin-kernel.js' {
  interface Context {
    tools: PluginToolService;
  }
}

export class PluginToolService extends Service {
  readonly registry: ExtensionToolContributionRegistry;

  constructor(ctx: Context, options: ExtensionToolContributionRegistryOptions = {}) {
    super(ctx, 'tools');
    this.registry = new ExtensionToolContributionRegistry(options);
  }

  register(tool: MakaTool): void {
    const identity = pluginIdentity(this.ctx);
    registerPluginContribution(this.ctx, `tool:${tool.name}`, () =>
      this.registry.register(identity, tool),
    );
  }

  compose(rootId: string, coreTools: readonly MakaTool[]): readonly MakaTool[] {
    return this.registry.compose(rootId, coreTools);
  }

  inspect(rootId: string): readonly ExtensionToolContributionInspection[] {
    return this.registry.inspect(rootId);
  }
}
