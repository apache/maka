---
name: rev-frida
description: Generate Frida hook scripts using modern Frida API. Activate when the user wants to write Frida scripts, hook functions at runtime, trace calls or arguments or return values, intercept native or ObjC or Java methods, dump memory or exports, or handle native module load timing for Android and other targets.
---

# rev-frida - Frida Script Generator

Generate Frida instrumentation scripts for dynamic analysis, hooking, and runtime inspection.

## Overview

Use Frida for:
- native export hooks
- Java or ObjC method hooks
- runtime tracing
- argument or return-value capture
- memory dumping
- loader-aware native instrumentation

## Important: Modern Frida CLI

The modern Frida CLI does not use `--no-pause`. A spawned process resumes after the script is loaded.

```bash
# Spawn and hook
frida -U -f com.example.app -l hook.js

# Attach to running process
frida -U com.example.app -l hook.js

# Attach by PID
frida -U -p 1234 -l hook.js
```

## Modern API Reference

### Module & Symbol Lookup

```javascript
const mod = Process.getModuleByName("libssl.so");

mod.name;
mod.base;
mod.size;
mod.path;

const ptr = mod.getExportByName("SSL_read");

Process.enumerateModules();
mod.enumerateExports();
mod.enumerateImports();

const addr = Module.getExportByName(null, "open");
```

### Interceptor

```javascript
Interceptor.attach(ptr, {
    onEnter(args) {
        console.log("arg0:", args[0].toInt32());
        console.log("arg1 str:", args[1].readUtf8String());
    },
    onLeave(retval) {
        console.log("ret:", retval.toInt32());
    }
});

Interceptor.replace(ptr, new NativeCallback(function (a0, a1) {
    console.log("replaced");
    return 0;
}, "int", ["pointer", "int"]));
```

### NativeFunction & NativeCallback

```javascript
const open = new NativeFunction(
    Module.getExportByName(null, "open"),
    "int",
    ["pointer", "int"]
);

const fd = open(Memory.allocUtf8String("/etc/hosts"), 0);

const cb = new NativeCallback(function (arg) {
    console.log("called with:", arg);
    return 0;
}, "int", ["int"]);
```

### Memory Operations

```javascript
ptr(addr).readByteArray(size);
ptr(addr).readUtf8String();
ptr(addr).readU32();
ptr(addr).readPointer();

ptr(addr).writeByteArray(bytes);
ptr(addr).writeUtf8String("hello");
ptr(addr).writeU32(0x41414141);

const buf = Memory.alloc(256);
const str = Memory.allocUtf8String("hello");

Memory.scan(mod.base, mod.size, "48 89 5C 24 ?? 48 89 6C", {
    onMatch(address, size) {
        console.log("found at:", address);
    },
    onComplete() {}
});
```

### ObjC

```javascript
if (ObjC.available) {
    const hook = ObjC.classes.ClassName["- methodName:"];
    Interceptor.attach(hook.implementation, {
        onEnter(args) {
            const selfObj = new ObjC.Object(args[0]);
            const param = new ObjC.Object(args[2]);
            console.log(selfObj.toString());
            console.log(param.toString());
        }
    });
}
```

### Java

```javascript
if (Java.available) {
    Java.perform(function () {
        const Activity = Java.use("android.app.Activity");
        Activity.onCreate.implementation = function (bundle) {
            console.log("onCreate called");
            return this.onCreate(bundle);
        };
    });
}
```

## Script Generation Guidelines

When generating Frida scripts:

1. Always use the modern API such as `Process.getModuleByName()` and `mod.getExportByName()`.
2. Do not use `--no-pause`.
3. Prefer load-event-driven native hooking over polling.
4. Print pointers and buffers in readable form.
5. Wrap risky hooks in `try/catch`.
6. Use `hexdump()` for binary inspection.

### Handle Native Module Load Timing

Do not assume a target `.so` is already loaded.

Preferred order:
1. Hook `android_dlopen_ext` or `dlopen` and install hooks when the target library loads.
2. Use an immediate `Process.findModuleByName()` check for already-loaded modules.
3. Use polling only as a fallback.

Use this helper by default:

```javascript
function hookModuleLoad(moduleName, callback) {
    const dlopen = Module.findGlobalExportByName("android_dlopen_ext")
        || Module.findGlobalExportByName("dlopen");

    if (!dlopen) {
        throw new Error("dlopen/android_dlopen_ext not found");
    }

    const hooked = new Set();

    Interceptor.attach(dlopen, {
        onEnter(args) {
            this.path = args[0].isNull() ? null : args[0].readCString();
            this.shouldHook = this.path && this.path.indexOf(moduleName) !== -1;
        },
        onLeave(retval) {
            if (!this.shouldHook || retval.isNull()) {
                return;
            }

            const mod = Process.findModuleByName(moduleName);
            if (!mod) {
                return;
            }

            const key = mod.base.toString();
            if (hooked.has(key)) {
                return;
            }
            hooked.add(key);

            callback(mod);
        }
    });
}
```

Use it like this:

```javascript
hookModuleLoad("libtarget.so", function (mod) {
    const target = mod.getExportByName("target_export");
    Interceptor.attach(target, {
        onEnter(args) {
            console.log("target_export called");
        }
    });
});
```

If the target may already be loaded, combine an immediate check with the load hook:

```javascript
function hookNowOrOnLoad(moduleName, callback) {
    const mod = Process.findModuleByName(moduleName);
    if (mod) {
        callback(mod);
        return;
    }
    hookModuleLoad(moduleName, callback);
}
```

Use polling only as a fallback:

```javascript
function hookWhenReady(moduleName, exportName, callbacks) {
    const mod = Process.findModuleByName(moduleName);
    if (mod) {
        Interceptor.attach(mod.getExportByName(exportName), callbacks);
        return;
    }

    const timer = setInterval(function () {
        const loaded = Process.findModuleByName(moduleName);
        if (!loaded) {
            return;
        }
        clearInterval(timer);
        Interceptor.attach(loaded.getExportByName(exportName), callbacks);
    }, 100);
}
```

Notes:
- On Android, prefer `android_dlopen_ext` before `dlopen`.
- Deduplicate by module base, not only by path.
- `onLeave` of `dlopen/android_dlopen_ext` is usually the right time to install hooks after constructors have run.
- If Java drives native loading, also consider `System.loadLibrary`, `Runtime.loadLibrary0`, `dlsym`, or `RegisterNatives`.

### Do Not Blindly Hook init Series Functions

Do not tell the user to hook `.init`, `.init_array`, constructors, or `JNI_OnLoad` blindly.

These are fragile points:
- many libraries perform one-time setup there
- bad hooks can crash the process before the real target logic runs
- early hooks can change timing and hide the behavior the user wants to study
- constructor code often fans out into many unrelated helpers

Before suggesting an init-stage hook:
1. identify why early hooking is required
2. identify the exact module and exact initialization routine
3. confirm whether the target symbol or behavior only exists before normal exports are reachable
4. prefer a later stable hook if it gives the same visibility

Prefer this order:
1. hook a stable exported function after module load
2. hook `RegisterNatives`, `dlsym`, or the first real business function
3. hook `JNI_OnLoad` only if native registration or anti-debug setup happens there
4. hook constructors or `.init_array` only if there is strong evidence that the critical logic is there

If proposing an early init hook, state:
- why the normal export hook is insufficient
- what exact function or address should be hooked
- what failure mode to expect
- how to verify the hook did not break initialization

Bad advice:

```javascript
// do not suggest this without a reason
Interceptor.attach(Module.findBaseAddress("libtarget.so").add(0x1234), ...);
```

Better advice:
- wait for module load
- confirm the constructor target by symbols, xrefs, strings, or trace evidence
- attach only after identifying the exact initialization function
- explain the risk to the user before using an init-stage hook

### Prefer Constructor Dispatchers Over Blind init Hooks

If anti-debug logic is suspected inside the constructor chain, prefer observing or hooking the dispatcher first instead of attaching blindly to raw `.init_array` entries.

Useful higher-level targets include:
- `call_constructors`
- `call_array`
- linker-side constructor walkers
- app-side wrapper functions that iterate constructor tables

Why this is safer:
- one hook can reveal the full constructor sequence
- you can see which constructor runs immediately before termination or anti-debug setup
- it reduces blind patching of unrelated initialization code
- it lets you log constructor targets first and patch only the offending one later

Recommended workflow:
1. hook module load
2. identify whether the process terminates during constructor execution
3. if yes, hook `call_constructors` or `call_array` when available
4. log each constructor target as it is dispatched
5. identify the exact constructor that performs anti-debug checks
6. patch or hook that constructor, or patch the specific anti-debug branch inside it

Only suggest `call_constructors` or `call_array` when:
- the target platform or linker build exposes those functions
- symbols, traces, or disassembly indicate they are actually used
- the user needs visibility into constructor-time anti-debug behavior

Warn about these constraints:
- these functions are loader or linker internals and names may vary by Android version, vendor build, or platform
- they may not be exported and may require symbol recovery or offset-based attachment
- hooking them too early can affect every library load, so scope logging carefully
- use them for discovery first, not as a default permanent bypass

Good guidance:
- “The process dies during native library initialization. First hook the constructor dispatcher such as `call_constructors` or `call_array` if present, log the constructor targets, then move to the exact offending constructor.”

Bad guidance:
- “Hook every `.init_array` entry and patch until it stops crashing.”

### Pointer and Buffer Logging

```javascript
console.log(args[0]);
console.log(args[0].toString());
console.log(hexdump(args[0], {
    offset: 0,
    length: 64,
    header: true,
    ansi: false
}));
```
