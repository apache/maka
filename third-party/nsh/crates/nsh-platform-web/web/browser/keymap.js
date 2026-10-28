// Rust parses shortcuts; the platform consumes matched keys synchronously.
export function createKeymap(invoke, reactive, dom, platform, wake) {
  let next = 1, entries = [];
  const call = (op, args) => {
    try { const result = invoke(op, args); wake(); return result; }
    catch (error) { throw new TypeError(error.message); }
  };
  const send = list => call(451, [list.map(e => [e.text, e.id, e.when, e.repeat]), !!platform.appleKeyboard]);
  dom.rootProp("onKeyCommand", id => {
    const entry = entries.find(entry => entry.id === id);
    if (entry) entry.handler({ keystroke: entry.text });
  });
  return {
    label(text) { return call(450, [String(text), !!platform.appleKeyboard]); },
    bind(first, handler, options) {
      let pairs;
      if (first !== null && typeof first === "object") { pairs = Object.entries(first); options = handler; }
      else {
        if (first == null) throw new TypeError("keymap.bind: expected a keystroke or object of handlers");
        pairs = [[String(first), handler]];
      }
      if (options != null && typeof options !== "object") throw new TypeError("keymap.bind: options must be an object");
      const when = options?.when, repeat = !!options?.repeat;
      if (when !== undefined && when !== "always" && when !== "notEditing") throw new TypeError("keymap.bind: when must be always or notEditing");
      const added = pairs.map(([text, handler]) => {
        if (typeof handler !== "function") throw new TypeError(`keymap.bind: the handler of ${JSON.stringify(text)} is not a function`);
        if (next >= 0xffffffff) throw new RangeError("shortcut IDs exhausted");
        return { text, handler, id: next++, when, repeat };
      });
      const updated = [...entries, ...added];
      send(updated); entries = updated;
      let removed = false;
      const unbind = () => {
        if (removed) return;
        const remaining = entries.filter(entry => !added.includes(entry));
        send(remaining); entries = remaining; removed = true;
      };
      if (reactive.getOwner()) reactive.cleanup(unbind);
      return unbind;
    },
  };
}
