// Browser promises and AbortSignals; generation/state decisions stay in core.
export function createResource(invoke, reactive, live, wake) {
  const finalizers = new FinalizationRegistry(id => { if (live()) invoke(807, [id]); });
  return function resource(source, fetcher, options) {
    const sourced = typeof fetcher === "function";
    if (!sourced) { options = fetcher; fetcher = source; }
    if (typeof fetcher !== "function") throw new TypeError("resource: the fetcher is not a function");
    const initial = options != null && "initialValue" in Object(options);
    const id = invoke(800, [initial]);
    const value = reactive.signal(initial ? options.initialValue : undefined);
    const error = reactive.signal(undefined), state = reactive.signal(initial ? "ready" : "unresolved"), trigger = reactive.signal(0);
    const read = () => value();
    finalizers.register(read, id);
    let refetching = false;
    const settle = (run, ok, result) => {
      void read; // Pending loads retain their resource through settlement.
      if (!live()) return;
      const next = invoke(ok ? 804 : 805, [id, run]);
      if (next === undefined) return;
      reactive.batch(() => { if (ok) value.set(result); error.set(ok ? undefined : result); state.set(next); });
      wake();
    };
    Object.assign(read, {
      loading: () => ["pending", "refreshing"].includes(state()), error: () => error(), state: () => state(),
      refetch() { void read; refetching = true; trigger.update(n => n + 1); },
      mutate(next) { void read; const status = invoke(806, [id]); reactive.batch(() => { value.set(next); error.set(undefined); state.set(status); }); return next; },
    });
    reactive.renderEffect(() => {
      // Keep the resource alive while its effect or a load is reachable.
      void read;
      trigger();
      const key = sourced ? (typeof source === "function" ? source() : source) : undefined;
      let controller;
      reactive.cleanup(() => { invoke(803, [id]); controller?.abort(); });
      reactive.untracked(() => {
        const refreshing = refetching; refetching = false;
        if (sourced && (key === undefined || key === null || key === false)) { state.set(invoke(802, [id])); return; }
        const [run, status] = invoke(801, [id]);
        controller = new AbortController();
        state.set(status);
        try {
          const info = { signal: controller.signal, refetching: refreshing };
          const result = sourced ? fetcher(key, info) : fetcher(info);
          const then = result != null && (typeof result === "object" || typeof result === "function") ? result.then : null;
          if (typeof then === "function") Promise.resolve(result).then(value => settle(run, true, value), error => settle(run, false, error));
          else settle(run, true, result);
        } catch (error) { settle(run, false, error); }
      });
    });
    return read;
  };
}
