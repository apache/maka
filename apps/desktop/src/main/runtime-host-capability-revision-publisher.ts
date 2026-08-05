interface ActivePublisher {
  readonly generation: symbol;
  readonly publish: () => Promise<void>;
}

export interface CapabilityRevisionBinding {
  readonly aligned: Promise<void>;
  dispose(): void;
}

export interface CapabilityRevisionPublisher {
  bind(publish: () => Promise<void>): CapabilityRevisionBinding;
  refreshIfChanged(): Promise<void>;
}

/** Publish each callable revision once to the currently active candidate generation. */
export function createCapabilityRevisionPublisher(
  readRevision: () => number,
): CapabilityRevisionPublisher {
  let active: ActivePublisher | undefined;
  let published:
    | { readonly generation: symbol; readonly revision: number }
    | undefined;
  let queue = Promise.resolve();

  const refreshIfChanged = (): Promise<void> => {
    queue = queue
      .catch(() => undefined)
      .then(async () => {
        const target = active;
        if (!target) return;
        const revision = readRevision();
        if (
          published?.generation === target.generation &&
          published.revision === revision
        ) {
          return;
        }
        await target.publish();
        if (active === target) {
          published = { generation: target.generation, revision };
        }
      });
    return queue;
  };

  return {
    bind: (publish) => {
      const target: ActivePublisher = {
        generation: Symbol("Runtime Host Desktop candidate"),
        publish,
      };
      active = target;
      return {
        aligned: refreshIfChanged(),
        dispose: () => {
          if (active === target) active = undefined;
        },
      };
    },
    refreshIfChanged,
  };
}
