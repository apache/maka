---
name: rev-unicorn-debug
description: Debug and emulate specific code fragments or functions using the Unicorn engine. Activate when the user wants to emulate a function with Unicorn, trace binary execution without running the full program, decrypt or decode data by emulating the algorithm, or bypass environment dependencies (JNI, syscalls, libc) during emulation.
---

# rev-unicorn-debug - Unicorn Emulation Debugger

Debug and emulate specific code fragments or functions using the Unicorn engine. Analyze context dependencies (JNI, syscalls, library functions) and simulate them through hook mechanisms to complete the user's debugging goal.

---

## Core Principles

1. **Load file raw first** — do NOT parse ELF/PE/Mach-O headers. Read the file as raw bytes and map directly into Unicorn memory. We only need to emulate specific functions, not the entire binary. If raw loading fails (code references segments at specific addresses), then parse minimally — only map the segments needed.
2. **Identify context dependencies** — analyze the target code for external calls (JNI, syscalls, libc, imports) and hook them to provide simulated responses.
3. **Use callbacks extensively** — leverage Unicorn's hook system for debugging, tracing, error recovery, and environment simulation.
4. **Iterative fix** — when emulation crashes, use the callback info to diagnose and fix (map missing memory, hook unhandled calls, fix register state).
5. **Minimal trace output** — prefer block-level tracing over instruction-level. Only enable instruction trace on small targeted ranges. Use counters and summaries instead of per-step logging.

---

## Environment Simulation Strategy

Before emulating, read the target function and identify what it calls. Hook external dependencies by address and simulate in Python:

| Category | Examples | Simulation Strategy |
|----------|----------|-------------------|
| libc | `malloc`, `free`, `memcpy`, `strlen`, `printf` | Hook address, implement logic in Python (bump allocator for malloc) |
| JNI | `GetStringUTFChars`, `FindClass`, `GetMethodID` | Build fake JNIEnv function table in UC memory, write RET stubs at each entry, hook stub addresses |
| Syscalls | `read`, `write`, `mmap`, `ioctl` | Hook `UC_HOOK_INTR`, dispatch by syscall number |
| C++ runtime | `operator new`, `__cxa_throw` | Hook and simulate |
| Library calls | `pthread_mutex_lock`, `dlopen` | Hook and return success/stub |

**Hook pattern:** Register a `UC_HOOK_CODE` callback. When PC hits a known import address, execute the Python simulation, then set PC = LR to skip the original function.

---

## Callback Types to Use

| Callback | Purpose |
|----------|---------|
| `UC_HOOK_CODE` | Intercept import calls by address; instruction-level trace (use sparingly, narrow range only) |
| `UC_HOOK_BLOCK` | Block-level trace (preferred over instruction trace) |
| `UC_HOOK_MEM_UNMAPPED` | Auto-map missing pages to recover from unmapped access errors |
| `UC_HOOK_MEM_READ \| UC_HOOK_MEM_WRITE` | Trace memory access on targeted data ranges only |
| `UC_HOOK_INTR` | Intercept SVC/INT for syscall simulation |

---

## Iterative Debugging Workflow

When emulation fails, follow this loop:

1. **Run** — start emulation, let it crash
2. **Read callback output** — which address faulted? What type (read/write/fetch)?
3. **Diagnose**:
   - Unmapped memory fetch → missing code page, map it
   - Unmapped memory read/write → missing data section or uninitialized pointer, map or hook
   - Hitting an import stub → identify the function, add a simulation hook
   - Infinite loop → add a code hook with execution counter, stop after threshold
4. **Fix** — add the hook / map the memory / adjust registers
5. **Re-run** — repeat until the target function completes

---

## Architecture Quick Reference

| Arch | Uc Const | Mode | SP | LR | Args | Return | Syscall |
|------|----------|------|----|----|------|--------|---------|
| ARM64 | `UC_ARCH_ARM64` | `UC_MODE_LITTLE_ENDIAN` | SP | X30 | X0-X7 | X0 | X8 + SVC #0 |
| ARM32 | `UC_ARCH_ARM` | `UC_MODE_THUMB` / `UC_MODE_ARM` | SP | LR | R0-R3 | R0 | R7 + SVC #0 |
| x86-64 | `UC_ARCH_X86` | `UC_MODE_64` | RSP | (stack) | RDI,RSI,RDX,RCX,R8,R9 | RAX | RAX + syscall |
| x86-32 | `UC_ARCH_X86` | `UC_MODE_32` | ESP | (stack) | (stack) | EAX | EAX + int 0x80 |
| MIPS32 | `UC_ARCH_MIPS` | `UC_MODE_MIPS32 + UC_MODE_BIG_ENDIAN` | $sp | $ra | $a0-$a3 | $v0 | $v0 + syscall |
