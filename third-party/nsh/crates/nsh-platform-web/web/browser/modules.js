// Registry metadata supplies the native functions and classes. These
// facades are shared by every ES module within one app realm.
export function createModules(invoke, values, live, wake, makeComponent) {
  const pending = new Map();
  const classes = new Map();
  const instances = new Map();
  let nextCall = 1;
  const finalizers = new FinalizationRegistry(id => {
    if (!live()) return;
    // An older wrapper may finalize after wrap() already replaced it.
    if (instances.get(id)?.deref()) return;
    instances.delete(id);
    values.classPeers.delete(id);
    invoke(203, [id]);
  });
  // A function Rust made (a `Stop`): it calls back into Rust, which
  // drops what it runs once the function is collected.
  const functions = new FinalizationRegistry(id => { if (live()) invoke(209, [id]); });
  values.makeFunction = id => {
    const fn = () => {
      if (!live()) return;
      invoke(208, [id]);
      wake();
    };
    functions.register(fn, id);
    return fn;
  };
  // A call returning a promise never throws: what Rust refuses rejects it.
  const call = (op, prefix, receiver, args, promise) => {
    if (!live()) throw new Error("the app was disposed");
    let id = 0, result;
    if (promise) {
      if (nextCall > 0xffffffff) throw new RangeError("browser call IDs exhausted");
      id = nextCall++;
      result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    }
    try {
      const value = invoke(op, [...prefix, receiver, args, id]);
      wake();
      return promise ? result : value;
    } catch (error) {
      const waiter = pending.get(id);
      pending.delete(id);
      if (waiter) { waiter.reject(error); return result; }
      throw error;
    }
  };
  const remember = (object, id) => {
    values.instances.set(object, id);
    instances.set(id, new WeakRef(object));
    values.classPeers.set(id, new WeakRef(object));
    finalizers.register(object, id);
    return object;
  };
  values.wrap = (id, classId) => {
    const existing = instances.get(id)?.deref();
    if (existing) return existing;
    const Constructor = classes.get(classId);
    if (!Constructor) throw new TypeError(`unregistered Rust class ${classId}`);
    return remember(Object.create(Constructor.prototype), id);
  };
  values.attach = remember;
  values.settle = (id, result) => {
    Promise.resolve(result).then(
      value => { if (live()) { invoke(204, [id, true, value]); wake(); } },
      error => { if (live()) { invoke(204, [id, false, error]); wake(); } },
    );
  };
  const exports = new Map();
  const metadata = invoke(200, []);
  // Register every prototype before constructing module values: classes
  // referenced by another module retain their canonical identity.
  for (const set of metadata) {
    for (const spec of set.classes) {
      if (classes.has(spec.id)) continue;
      const ctor = spec.members.find(member => member.kind === "constructor");
      const Constructor = function (...args) {
        if (!new.target) throw new TypeError(`${spec.name} requires new`);
        if (!ctor) throw new TypeError(`${spec.name} has no public constructor`);
        return call(202, [spec.id, ctor.id], this, args, false);
      };
      Object.defineProperty(Constructor, "name", { value: spec.name });
      classes.set(spec.id, Constructor);
      const dispose = function () {
        if (!live()) throw new Error("the app was disposed");
        invoke(205, [this, spec.id]);
      };
      for (const member of spec.members) {
        if (member.kind === "constructor") continue;
        const fn = function (...args) {
          return call(202, [spec.id, member.id], this, args, member.promise);
        };
        Object.defineProperty(fn, "name", { value: member.name });
        const target = member.kind === "static" ? Constructor : Constructor.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(target, member.name) ?? { configurable: true };
        if (member.kind === "get" || member.kind === "set") descriptor[member.kind] = fn;
        else { descriptor.value = fn; descriptor.writable = true; }
        Object.defineProperty(target, member.name, descriptor);
      }
      Object.defineProperty(Constructor.prototype, "dispose", { value: dispose, configurable: true, writable: true });
      if (Symbol.dispose) Object.defineProperty(Constructor.prototype, Symbol.dispose, { value: dispose, configurable: true, writable: true });
    }
  }
  for (const set of metadata) {
    const namespace = exports.get(set.specifier) ?? Object.create(null);
    exports.set(set.specifier, namespace);
    for (const spec of set.components ?? []) namespace[spec.export] = makeComponent(spec, call);
    for (const spec of set.classes) if (!spec.interface) namespace[spec.name] = classes.get(spec.id);
    for (const module of set.modules) {
      const object = module.flat ? namespace : (namespace[module.name] ??= {});
      Object.assign(object, module.constants);
      for (const spec of module.functions) {
        const fn = function (...args) { return call(201, [spec.id], this, args, spec.promise); };
        Object.defineProperty(fn, "name", { value: spec.name });
        Object.defineProperty(object, spec.name, spec.getter
          ? { get: fn, enumerable: true, configurable: true }
          : { value: fn, writable: true, enumerable: true, configurable: true });
      }
      if (module.default) namespace.default = object;
    }
  }
  return {
    exports,
    measure(node) { return call(315, [], node, [], true, false); },
    reply(id, ok, value) {
      const waiter = pending.get(id);
      if (!waiter) return;
      pending.delete(id);
      if (ok) waiter.resolve(value); else waiter.reject(value);
    },
    dispose() {
      const waiters = [...pending.values()];
      pending.clear();
      instances.clear();
      values.classPeers.clear();
      classes.clear();
      exports.clear();
      for (const waiter of waiters) waiter.reject(new Error("the app was disposed"));
    },
  };
}
