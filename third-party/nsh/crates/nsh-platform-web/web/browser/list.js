// The core chooses the visible indices and recycles slots. This facade owns
// only app render closures and their reactive owners, as the QuickJS host does.
export const itemsProps = ["each", "children", "keyExtractor", "stickyHeaderIndices", "initialScrollIndex", "onViewableItemsChange", "viewabilityConfig", "refreshing", "onRefresh", "onLoadMore", "loadMoreThreshold", "header", "footer", "empty"];
const own = new Set([...itemsProps.filter(k => !["stickyHeaderIndices", "viewabilityConfig", "refreshing", "onRefresh", "onLoadMore"].includes(k)), "ref", "estimatedItemSize", "loadMoreAtStartThreshold", "separator"]);
export function createLists(invoke, values, reactive, dom, live, wake) {
  const lists = new Map(), rt = dom.rt;
  const slot = value => typeof value === "function" ? reactive.untracked(() => value({})) : value;
  const remove = (parent, entry) => { invoke(306, [parent, entry.node]); entry.dispose(); };
  const render = (props = {}) => {
    const node = rt.element("list"), id = values.nodeIds.get(node);
    const state = { node, props, owner: reactive.getOwner(), cells: new Map(), extras: [], latest: [-1, -1], reported: [-1, -1], timer: null };
    lists.set(id, state);
    reactive.cleanup(() => {
      lists.delete(id); clearTimeout(state.timer);
      const entries = [...state.cells.values(), ...state.extras];
      state.cells.clear(); state.extras.length = 0;
      let failure;
      for (const entry of entries) { try { entry.dispose(); } catch (error) { failure ??= { error }; } }
      if (failure) throw failure.error;
    });
    const splices = [];
    // Cells move with their items before their item memos read the new data, as the core moves them
    // (Rust lists' `move_rows`): otherwise each shows the item now at its old index until it is bound again.
    state.items = reactive.computed(previous => {
      const next = props.each ?? [], old = previous ?? [];
      if (old.length && old !== next) {
        let start = 0, end = old.length, nextEnd = next.length;
        while (start < end && start < nextEnd && old[start] === next[start]) start++;
        while (end > start && nextEnd > start && old[end - 1] === next[nextEnd - 1]) { end--; nextEnd--; }
        if (end !== start || nextEnd !== start) {
          splices.push([start, end - start, nextEnd - start]);
          reactive.untracked(() => { for (const cell of state.cells.values()) { const i = cell.index(); if (i >= end) cell.index.set(i + nextEnd - end); } });
        }
      }
      return next;
    });
    reactive.renderEffect(() => {
      const next = state.items();
      for (const splice of splices.splice(0)) rt.prop(node, "splice", splice);
      rt.prop(node, "count", next.length);
    });
    const previous = new Map();
    reactive.renderEffect(() => {
      const keys = ["viewport", ...Object.keys(props).filter(k => k !== "viewport" && !own.has(k))];
      for (const key of previous.keys()) if (!keys.includes(key)) { rt.prop(node, key, undefined); previous.delete(key); }
      for (const key of keys) {
        const value = props[key];
        if (!previous.has(key) || previous.get(key) !== value) { rt.prop(node, key, value); previous.set(key, value); }
      }
      for (const [key, fallback] of [["estimatedItemSize", 50], ["loadMoreThreshold", 1], ["loadMoreAtStartThreshold", 1]]) rt.prop(node, key, props[key] ?? fallback);
    });
    const extra = role => reactive.runWithOwner(state.owner, () => reactive.root(dispose => {
      const cell = rt.element("cell");
      try { rt.prop(cell, "slot", role); rt.append(node, cell); rt.insert(cell, () => slot(props[role])); }
      catch (error) { try { dispose(); } catch {} throw error; }
      return { node: cell, dispose };
    }));
    for (const role of ["header", "footer"]) if (role in props) state.extras.push(extra(role));
    if ("empty" in props) {
      let empty;
      reactive.renderEffect(() => {
        if (!(props.each?.length)) { if (!empty) { empty = extra("empty"); state.extras.push(empty); } }
        else if (empty) { remove(node, empty); state.extras.splice(state.extras.indexOf(empty), 1); empty = null; }
      });
    }
    const report = () => {
      state.timer = null;
      if (!live() || !lists.has(id)) return;
      reactive.untracked(() => {
        const [first, last] = state.latest, [before, after] = state.reported;
        if (first === before && last === after) return;
        state.reported = state.latest;
        const each = props.each ?? [], viewableItems = [], changed = [];
        const token = (index, isViewable) => {
          const item = each[index];
          const key = typeof props.keyExtractor === "function" ? props.keyExtractor(item, index) : String(item?.key ?? item?.id ?? index);
          return { item, key, index, isViewable };
        };
        if (first >= 0) for (let i = first; i <= Math.min(last, each.length - 1); i++) { viewableItems.push(token(i, true)); if (i < before || i > after) changed.push(token(i, true)); }
        if (before >= 0) for (let i = before; i <= Math.min(after, each.length - 1); i++) if (i < first || i > last) changed.push(token(i, false));
        if (typeof props.onViewableItemsChange === "function") props.onViewableItemsChange({ viewableItems, changed });
      });
    };
    if ("onViewableItemsChange" in props) dom.listen(node, "onViewableItemsChange", ({ first, last }) => {
      state.latest = [first, last]; clearTimeout(state.timer);
      const delay = props.viewabilityConfig?.minimumViewTime ?? 0;
      if (delay > 0) state.timer = setTimeout(report, delay); else report();
    });
    if (typeof props.initialScrollIndex === "number") invoke(314, [id, "scrollToIndex", { index: Math.max(0, props.initialScrollIndex), animated: false }]);
    if (typeof props.ref === "function") reactive.untracked(() => props.ref(node));
    return node;
  };
  const bind = (id, bindings) => {
    const state = lists.get(id);
    if (!state) return;
    let failure;
    try { reactive.batch(() => {
      for (const [slotId, first] of bindings) {
        if (lists.get(id) !== state) break;
        try {
        const existing = state.cells.get(slotId);
        if (existing) { existing.index.set(first); continue; }
        const entry = reactive.runWithOwner(state.owner, () => reactive.root(dispose => {
          const index = reactive.signal(first);
          let previous;
          const item = reactive.computed(() => { const i = index(), items = state.items(); if (i < items.length) previous = items[i]; return previous; });
          const cell = rt.element("cell");
          try {
            rt.prop(cell, "slot", slotId); rt.append(state.node, cell);
            const content = reactive.untracked(() => state.props.children(item, index));
            if ("separator" in state.props) {
              let separator, made = false;
              rt.insert(cell, () => {
                if (index() >= (state.props.each?.length ?? 0) - 1) return content;
                if (!made) { separator = slot(state.props.separator); made = true; }
                return state.props.inverted ? [separator, content] : [content, separator];
              });
            } else rt.insert(cell, content);
          } catch (error) { try { dispose(); } catch {} try { invoke(306, [state.node, cell]); } catch {} throw error; }
          return { node: cell, index, dispose };
        }));
        if (lists.get(id) === state) state.cells.set(slotId, entry); else remove(state.node, entry);
        } catch (error) { failure ??= { error }; }
      }
    }); } catch (error) { failure ??= { error }; }
    if (lists.get(id) === state) for (const [slot, index] of bindings) {
      const cell = state.cells.get(slot);
      if (cell) rt.prop(cell.node, "cellIndex", index);
    }
    wake();
    if (failure) throw failure.error;
  };
  return { render, bind };
}
