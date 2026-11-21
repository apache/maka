export type SeamRegistry = {
  define: (name: string) => void;
  provide: (name: string, value: unknown) => void;
  consume: (name: string) => unknown;
  unprovide: (name: string) => void;
};

export function createSeamRegistry(): SeamRegistry {
  const defined = new Set<string>();
  const providers = new Map<string, unknown>();

  return {
    define(name) {
      defined.add(name);
    },
    provide(name, value) {
      providers.set(name, value);
    },
    consume(name) {
      if (!providers.has(name)) {
        throw new Error(`seam not provided: ${name}`);
      }
      return providers.get(name);
    },
    unprovide(name) {
      providers.delete(name);
    },
  };
}
