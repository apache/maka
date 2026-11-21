---
name: pyghidra-scripting
description: Write and run Python (PyGhidra) code inside the Ghidra session that ReVa's MCP server is already attached to, using the five ReVa scripting tools — `run-script`, `list-scripts`, `read-script`, `write-script`, `edit-script`. Use this whenever the user asks to execute Python against the current program, reach for the Ghidra Flat API directly, write a custom analysis pass, automate something the other ReVa tools don't expose, or persist a `.py` script in Ghidra's scripts directory. Also use when an existing ReVa MCP tool can't do what's needed and the right answer is "drop into PyGhidra for one call." Do NOT use this skill for plain ReVa tool calls that already have a dedicated MCP tool (use that tool instead); do NOT use it to build standalone Python programs that run pyghidra in their own process (the run-script tool runs *inside* the ReVa-hosted Ghidra).
---

# PyGhidra scripting via ReVa

ReVa exposes five MCP tools under the `scripts` provider that let an assistant write, edit, run, and inspect Python scripts inside the same Ghidra session ReVa is serving. The Python code runs under PyGhidra (CPython 3 + JPype), so it has the full Ghidra Java API available — the `FlatProgramAPI`, `DecompInterface`, `FunctionManager`, everything.

This skill teaches when to reach for these tools, how to structure the Python you send to `run-script`, and the pitfalls that bite in practice.

## The five tools at a glance

| Tool | Purpose | Use when |
|---|---|---|
| `run-script` | Execute Python against a program. Inline `code`, or by `scriptPath` / `scriptName`. | The dedicated ReVa MCP tools don't cover what you need, or you want one tight pass over the program. |
| `list-scripts` | Enumerate scripts across registered directories. Filterable by name/path; paginated. | Discovering what's already saved before writing a new one. |
| `read-script` | `cat -n` view of a script with `offset` / `limit` and a `truncated` flag. | Reading an existing script before editing it. The numbered output is what `edit-script` lines up against. |
| `write-script` | Create a new `.py` file (or full overwrite with `overwrite: true`). User-writeable dirs only. | Saving a reusable script. Never reach for this just to bundle inline code — use `run-script` with `code` for one-shot use. |
| `edit-script` | `old_string` → `new_string` replacement. Errors if `old_string` matches multiple places unless `replace_all: true`. | Iterating on an existing script. Pair with `read-script` to see line context first. |

## Reach-for-it triggers

`run-script` is the escape hatch. Use it when:

- You need to run a custom predicate over every function/symbol/instruction and the existing list/find tools don't filter the right way.
- You need to combine multiple Ghidra API calls into one operation that would otherwise take many MCP round-trips.
- You want to use a Ghidra API ReVa doesn't expose — e.g. `DecompInterface` low-level features, `PCode` analysis, custom `AddressSet` arithmetic, the data flow API directly, `BinaryReader`, etc.
- You're prototyping; once it works and is reusable, save it with `write-script`.

Don't use `run-script` when a dedicated ReVa MCP tool already does the job — those tools have stable schemas and structured output that's easier to reason about than free-form `stdout`. The decompiler / functions / strings / symbols / xrefs tools cover the common path.

## Runtime gate: PyGhidra-only

`run-script` only works when Ghidra was launched **under PyGhidra**:

- ✅ `mcp-reva` (Claude CLI / stdio mode)
- ✅ `pyghidra-gui` (GUI mode launched with PyGhidra)
- ✅ `reva_headless_server.py` (headless mode via PyGhidra)
- ❌ Plain `ghidraRun` — PyGhidra is not wired in; you'll get a `PyGhidraNotAvailableException` error response with launch guidance.

If a `run-script` call comes back with that error, the right move is to tell the user how to relaunch (don't keep retrying). The other four tools (`list-scripts`, `read-script`, `write-script`, `edit-script`) work in every mode because they're plain file operations.

## The execution contract for `run-script`

This is the contract your inline `code` (or saved script) runs under. Internalise it — most failures come from getting one of these wrong.

**Pre-bound globals.** The script runs as a Ghidra PyGhidra script, so the standard `GhidraScript` globals are already defined: `currentProgram`, `currentAddress`, `currentSelection`, `currentHighlight`, `monitor`, `state`, plus `FlatProgramAPI` helpers like `toAddr`, `getFunctionAt`, `getFunctionContaining`, `getSymbolAt`, `getInstructionAt`, `getDataAt`, `getReferencesTo`, `getReferencesFrom`, `createLabel`, `setEOLComment`, `find`, `findBytes`, `clearListing`. You do **not** need to import or set these up. `currentProgram` is the program identified by the `programPath` argument.

**No automatic transaction.** Unlike GhidraScripts run from inside Ghidra's GUI, ReVa's `run-script` deliberately does **not** open a transaction around your code. Any mutation (rename, retype, comment, label, create function, etc.) must be wrapped manually:

```python
tx = currentProgram.startTransaction("Describe the edit")
try:
    # ... do stuff that mutates state ...
    currentProgram.endTransaction(tx, True)   # commit
except Exception:
    currentProgram.endTransaction(tx, False)  # roll back
    raise
```

This is intentional — auto-wrapping at the tool layer would create nested-transaction footguns when scripts already handle their own. Read-only scripts (printing, counting, dumping) need no transaction at all.

**Inline header.** When you pass `code`, the tool prepends `# @runtime PyGhidra\n` automatically. Don't add it yourself.

**Cancellation is cooperative.** The configured timeout (default 60s, overridable per-call via `timeoutSeconds`) only fires if your code yields to the monitor. In long loops, call `monitor.isCancelled()` regularly and break:

```python
fm = currentProgram.getFunctionManager()
for func in fm.getFunctions(True):
    if monitor.isCancelled():
        break
    # ... work ...
```

A tight Python loop without a monitor check will run past the timeout. The result will then come back with `timedOut: true` and partial output but the Ghidra session may still be busy for a moment.

**Output is captured and capped.** `stdout` and `stderr` are each capped at 64K chars by default (configurable via `SCRIPT_OUTPUT_CHAR_LIMIT`). If you blow the cap, the result has `stdoutTruncated: true` or `stderrTruncated: true`. Design output for an LLM consumer — terse, structured, line-per-record. Reach for JSON if downstream parsing matters:

```python
import json
results = []
for func in currentProgram.getFunctionManager().getFunctions(True):
    if monitor.isCancelled(): break
    if some_predicate(func):
        results.append({"addr": str(func.getEntryPoint()), "name": func.getName()})
print(json.dumps(results))
```

**Result schema.** `run-script` returns:

```json
{
  "success": true|false,
  "programPath": "/binary.exe",
  "stdout": "...",
  "stderr": "...",
  "stdoutTruncated": false,
  "stderrTruncated": false,
  "durationMs": 1234,
  "timedOut": false,
  "scriptSource": {"type": "inline|path|name", "value": "..."},
  "error": "ClassName: message"   // only when the executor itself threw
}
```

`success` is `false` if the script raised a Python exception (detected via the `Traceback (most recent call last)` marker in stderr), if it hit the timeout, or if the executor threw. Read `stderr` to see the actual traceback — Python exceptions don't surface as MCP errors, they come back in `stderr` with `success: false`.

## What you can call from inside

The script has the full Ghidra/PyGhidra surface. The most commonly useful entry points:

```python
# Program structure
prog     = currentProgram                             # the Program object
listing  = prog.getListing()                          # CodeUnits, data, comments
memory   = prog.getMemory()                           # blocks, bytes
fm       = prog.getFunctionManager()                  # functions
st       = prog.getSymbolTable()                      # symbols/labels
rm       = prog.getReferenceManager()                 # xrefs
dtm      = prog.getDataTypeManager()                  # data types

# Flat-API one-liners (already global)
addr     = toAddr(0x401000)
func     = getFunctionAt(addr) or getFunctionContaining(addr)
sym      = getSymbolAt(addr)
instr    = getInstructionAt(addr)
xrefs_to = getReferencesTo(addr)

# Java classes — import as normal Python after PyGhidra is up (it is, when run-script runs)
from ghidra.program.model.symbol import SourceType
from ghidra.app.decompiler import DecompInterface, DecompileOptions
```

For everything else: see [references/flat-api.md](references/flat-api.md) for the categorised Flat-API cheat-sheet, and [references/jpype-interop.md](references/jpype-interop.md) for the Java-via-Python idioms (arrays, iterators, sign extension, type stubs).

## Workflow patterns

### Inline one-shot (most common)

```
run-script(programPath="/bin", code="""
fm = currentProgram.getFunctionManager()
total = 0
huge = []
for f in fm.getFunctions(True):
    if monitor.isCancelled(): break
    size = f.getBody().getNumAddresses()
    total += size
    if size > 4096:
        huge.append((str(f.getEntryPoint()), f.getName(), size))
print(f'total bytes: {total}')
for addr, name, size in huge:
    print(f'{addr} {size:6d} {name}')
""")
```

Read the stdout, draw conclusions, move on. Nothing persisted.

### Iterate then save

1. Send a draft via `run-script` with inline `code`.
2. When it works, call `write-script` with `scriptName="MyAnalysis.py"` and the final `code`. (Pick a descriptive name — `list-scripts` will return it.)
3. Next time, `run-script` with `scriptName="MyAnalysis.py"`.

### Edit-in-place on a saved script

1. `list-scripts` (or remember the name).
2. `read-script` — note the line numbers around what you want to change.
3. `edit-script` with `old_string` set to a *uniquely identifying* slice (include enough surrounding context that there's exactly one match). The tool errors out on ambiguity unless you pass `replace_all: true`.
4. Re-run via `run-script(scriptName=...)`.

`edit-script` is preferred over re-writing the whole file — it preserves the rest of the script unchanged and is what the user can review as a diff.

## Pitfalls

These are the ones that account for most "why did my script misbehave."

### Forgot the transaction
Mutations without `startTransaction` throw `IllegalStateException: not in transaction`. If a `run-script` call mutates and you see this in `stderr`, that's the cause. Wrap the mutating block — see the contract section above.

### `monitor.isCancelled()` check missing
Tight loops that never check the monitor blow past the timeout silently — the `timedOut` flag still flips, but your script may have already done damage. Always check the monitor inside any loop touching every function / instruction / address.

### Java `Iterator` vs Python iterable
Most Ghidra iterators are Python-iterable thanks to JPype, but a few (notably `SymbolIterator` from some accessors and the older `ReferenceIterator`) only expose `hasNext()` / `next()`. If a `for x in it:` loop silently yields nothing, fall back to `while it.hasNext(): x = it.next()`. `FunctionManager.getFunctions(True)` is iterable directly.

### Java `byte` is signed
`MemoryBlock.getBytes(addr, byte[] buf)` fills you a Java `byte[]`. Values come back as `-128..127`. Mask with `b & 0xff` if you want `0..255`. Allocating the buffer: `import jpype; buf = jpype.JByte[16]`.

### `print()` is what shows up in stdout
The script's `print()` is rerouted to the captured stdout writer — that's how you get output back. Don't use logging frameworks expecting them to flush somewhere visible; `print(...)` is the contract.

### Decompiler is expensive to construct
If you decompile more than a handful of functions in one script, build the `DecompInterface` once and reuse it. Always `dispose()` it. With a per-function timeout of 30s, a 100-function pass that re-builds the decompiler each call can easily blow `run-script`'s overall timeout.

```python
from ghidra.app.decompiler import DecompInterface
decomp = DecompInterface()
decomp.openProgram(currentProgram)
try:
    for f in currentProgram.getFunctionManager().getFunctions(True):
        if monitor.isCancelled(): break
        res = decomp.decompileFunction(f, 30, monitor)
        if res.decompileCompleted():
            # process res.getDecompiledFunction().getC()
            pass
finally:
    decomp.dispose()
```

### `script` paths must live inside a registered scripts dir
`run-script(scriptPath=...)` refuses paths outside Ghidra's registered script directories (user dir, system dirs, bundle dirs). Same for `read-script`. For writes, you're additionally limited to the *writeable* set (user dir, typically `~/ghidra_scripts/`). System dirs are read-only.

### Inline `code` and saved scripts both bypass Ghidra's `# @category` UI metadata
`run-script(code=...)` writes a temp file with only the `# @runtime PyGhidra` header. `# @category`, `# @menupath`, `# @keybinding` headers in a *saved* script matter for the Ghidra GUI but are ignored by `run-script` — keep them if you want the script to appear in the Script Manager, drop them otherwise.

## Where to go next

These reference files are bundled with the skill. Load only the one(s) relevant.

- **[references/flat-api.md](references/flat-api.md)** — Categorised cheat-sheet for the program-inspection surface: `FlatProgramAPI` one-liners (`toAddr`, `getFunctionAt`, `createLabel`, `setEOLComment`, references, comments, bookmarks, search), `AddressSet` arithmetic for restricting iteration, imports/externals/thunks (`isThunk`, `getCallingFunctions`, `ExternalManager`), data types & structs (`StructureDataType`, `DataTypeManager`, `createData`), and `FlatDecompilerAPI` basics. Load when writing inline `code` that inspects or mutates program structure.

- **[references/decompiler-pcode.md](references/decompiler-pcode.md)** — The decompiler's internal representation: `HighFunction`, `LocalSymbolMap`, `HighSymbol`/`HighVariable`/`HighParam`, `Varnode` def-use chains, `PcodeOp` opcodes (COPY/LOAD/CALL/MULTIEQUAL/PTRSUB/…), `ParallelDecompiler` for batch passes, `HighFunctionDBUtil` for persisting decompiler-derived renames. Load when the question is "trace this value back to its source", "where does this argument come from", "which functions look like the decompiler got confused", "rename this `iVar3` to something useful", or any task that needs more than the C source string.

- **[references/jpype-interop.md](references/jpype-interop.md)** — Python ↔ Java boundary notes: arrays (`jpype.JByte[16]`), sign extension, varargs, overload resolution, exception types, getter/setter ↔ property, package collisions, type stubs (`from ghidra.ghidra_builtins import *` under `TYPE_CHECKING`). Load when JPype errors show up or you're doing anything beyond simple `for x in it:` iteration.

- **[references/recipes.md](references/recipes.md)** — Copy-pasteable inline `code` snippets covering the well-trodden paths: function iteration with predicates, xrefs to a symbol with caller context, batch rename by regex, thunks-aware callers of an import, decompile-and-grep, string dump with referencers, call-graph walk, plate/EOL annotations, raw byte reads — plus the heavier patterns: define a struct and apply it to memory, set a function signature with proper storage, trace argN back through Varnode def-use chains, register touches per function, `ParallelDecompiler` batch decompilation, `EmulatorHelper` for string deobfuscation, recursive xref-walking, and persisting a decompiler-derived rename via `HighFunctionDBUtil`. Load when the user asks "how do I do X" and X is a well-trodden path.

- **[references/persistent-scripts.md](references/persistent-scripts.md)** — Conventions for saved scripts: naming, where files land, GhidraScript headers (`# @category`, `# @runtime`), how to discover existing scripts before duplicating, the typical edit cycle. Load when the user wants to save / reuse / iterate on a script rather than one-shot it.

## Working style

A few things that keep PyGhidra-via-ReVa pleasant:

- **Prefer dedicated ReVa tools first.** `run-script` is powerful but free-form; the structured tools (decompiler, functions, strings, xrefs, …) have schemas the assistant can reason about more reliably. Reach for `run-script` only when the structured tools don't cover the question.
- **Print structured output.** When a `run-script` result is going to be re-consumed by an LLM, prefer JSON or fixed columns over prose. The 64K cap is per-stream — design for it.
- **Keep transactions narrow.** Open one per logical edit, not one wrapping the whole script. Smaller transactions undo cleanly in Ghidra's history and survive errors better.
- **Iterate with `edit-script`, not `write-script`.** Once a saved script exists, targeted edits produce reviewable diffs; full overwrites don't.
- **Read before you edit.** `read-script` first to see the current state and pick `old_string` slices that are unique. Editing blind almost always picks too-short a slice and either misses or hits multiple lines.
