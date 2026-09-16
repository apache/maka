/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * Counts React commits, rendered fibers, and the `setState` calls that caused
 * them, from inside the renderer (#4109).
 *
 * Injected with `Page.addScriptToEvaluateOnNewDocument` before the app loads,
 * because both halves have to be in place first:
 *
 *   1. `__REACT_DEVTOOLS_GLOBAL_HOOK__` must exist before `react-dom` looks for
 *      it, or no commit is ever reported. This is a minimal stand-in for the
 *      DevTools hook — enough of the shape that react-dom injects into it.
 *
 *   2. `Function.prototype.bind` is wrapped to catch React creating a state
 *      dispatcher. React binds `dispatchSetState` as `(null, fiber, queue)`,
 *      and the queue is the only object in the runtime carrying
 *      `lastRenderedReducer`, so that triple identifies it with no version
 *      coupling to react-dom's internals.
 *
 * A fiber counts as rendered when it carries `Placement` (`flags & 1`) and its
 * alternate was last seen in the previous commit. That is identity-insensitive:
 * it reports what React actually re-rendered, not what a `memo` comparator was
 * asked about.
 *
 * `arm` gates recording so a measurement covers one interaction rather than the
 * app's whole life. Set `__MAKA_PROBE__.arm = false` before profiling with the
 * sampler, or the probe's own walk lands in the profile.
 */
(() => {
  if (globalThis.__MAKA_PROBE__) return 'already';
  const probe = {
    commits: [],
    dispatches: [],
    arm: false,
    roots: new Set(),
    rootIdx: new WeakMap(),
    qid: 0,
    qlabel: new Map(),
  };
  globalThis.__MAKA_PROBE__ = probe;

  const originalBind = Function.prototype.bind;
  Function.prototype.bind = function bind(...args) {
    const bound = originalBind.apply(this, args);
    try {
      const queue = args[2];
      if (
        args.length === 3 &&
        args[0] === null &&
        queue &&
        typeof queue === 'object' &&
        'lastRenderedReducer' in queue &&
        !queue.__qid
      ) {
        queue.__qid = ++probe.qid;
        const qid = queue.__qid;
        return function dispatchWithRecord(action) {
          if (probe.arm && probe.dispatches.length < 500) {
            probe.dispatches.push({
              t: performance.now(),
              qid,
              prev: brief(queue.lastRenderedState),
              action: brief(action),
              st: (new Error().stack || '')
                .split('\n')
                .slice(2, 8)
                .map((line) => line.trim().slice(0, 130)),
            });
          }
          return bound.apply(this, arguments);
        };
      }
    } catch {
      // A bind we cannot inspect is a bind we do not care about.
    }
    return bound;
  };

  function brief(value) {
    try {
      if (value == null) return String(value);
      if (typeof value === 'function') return 'fn';
      if (typeof value !== 'object') return String(value).slice(0, 40);
      if (Array.isArray(value)) return `Arr${value.length}`;
      return `{${Object.keys(value).slice(0, 6)}}`;
    } catch {
      return '?';
    }
  }

  const nameOf = (fiber) => {
    const type = fiber.type ?? fiber.elementType;
    if (typeof type === 'string') return type;
    if (typeof type === 'function') return type.displayName || type.name || 'anon';
    if (type && typeof type === 'object') {
      const inner = type.type ?? type.render;
      return (
        type.displayName ||
        (typeof inner === 'function' ? inner.displayName || inner.name : null) ||
        'obj'
      );
    }
    return `tag${fiber.tag}`;
  };

  const hook = {
    renderers: new Map(),
    supportsFiber: true,
    _nextId: 1,
    inject(renderer) {
      const id = hook._nextId++;
      hook.renderers.set(id, renderer);
      return id;
    },
    checkDCE() {},
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    setStrictMode() {},
    getFiberRoots() {
      return probe.roots;
    },
    on() {},
    off() {},
    sub() {
      return () => {};
    },
    emit() {},
    onCommitFiberRoot(_id, root) {
      probe.roots.add(root);
      const idx = (probe.rootIdx.get(root) || 0) + 1;
      probe.rootIdx.set(root, idx);
      const key = '__pc';
      let total = 0;
      let visited = 0;
      const renderRoots = [];
      const stack = [[root.current, 0, false]];
      while (stack.length) {
        const [fiber, depth, hasRenderedAncestor] = stack.pop();
        if (!fiber || visited++ > 90000) break;
        const alternate = fiber.alternate;
        const rendered = fiber.flags & 1 && alternate && alternate[key] === idx - 1;
        if (rendered) total++;
        let ancestor = hasRenderedAncestor;
        if (rendered && !hasRenderedAncestor && probe.arm) {
          ancestor = true;
          renderRoots.push({ d: depth, name: nameOf(fiber) });
        }
        let state = fiber.memoizedState;
        let i = 0;
        while (state && i < 1200) {
          if (state.queue?.__qid && !probe.qlabel.has(state.queue.__qid)) {
            probe.qlabel.set(state.queue.__qid, `${nameOf(fiber)}@d${depth}#h${i}`);
          }
          state = state.next;
          i++;
        }
        fiber[key] = idx;
        if (fiber.child) stack.push([fiber.child, depth + 1, ancestor]);
        if (fiber.sibling) stack.push([fiber.sibling, depth, hasRenderedAncestor]);
      }
      if (probe.arm && probe.commits.length < 300) {
        renderRoots.sort((a, b) => a.d - b.d);
        probe.commits.push({ t: performance.now(), idx, total, rr: renderRoots.slice(0, 3) });
      }
    },
  };
  Object.defineProperty(globalThis, '__REACT_DEVTOOLS_GLOBAL_HOOK__', {
    value: hook,
    writable: false,
    configurable: true,
  });
  return 'installed';
})();
