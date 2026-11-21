import type { Toolkit } from "./context";

export type Plugin = {
  id: string;
  apply: (toolkit: Toolkit) => void | Promise<void>;
  dispose?: (toolkit: Toolkit) => void | Promise<void>;
};

export function createPluginRegistry() {
  const plugins = new Map<string, Plugin>();

  return {
    async register(plugin: Plugin, toolkit: Toolkit) {
      await plugin.apply(toolkit);
      plugins.set(plugin.id, plugin);
    },
    async unregister(id: string, toolkit: Toolkit) {
      const plugin = plugins.get(id);
      if (!plugin) {
        return;
      }
      await plugin.dispose?.(toolkit);
      plugins.delete(id);
    },
    list() {
      return [...plugins.values()];
    },
  };
}
