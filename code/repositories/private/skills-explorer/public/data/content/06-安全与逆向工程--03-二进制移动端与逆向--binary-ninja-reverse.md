---
name: binary-ninja-reverse
description: Use for authorized binary analysis in Binary Ninja, including HLIL/MLIL/LLIL inspection, strings/imports/exports, cross-references, types, patch review, Python API automation, and optional Binary Ninja MCP or localhost HTTP integration.
---

# Binary Ninja reverse engineering

Use Binary Ninja when the user explicitly selects it, when its ILs materially help data-flow analysis, or when IDA/Ghidra/radare2 results need an independent cross-check.

## Start safely

1. Confirm the repository case scope is ready before acting on a target.
2. Check `skills/tool-index.md` for `binaryninja`; Binary Ninja is commercial software and must be installed manually with a valid Vector 35 license.
3. Work on a copy when applying patches or saving database changes.
4. Record imports/exports, entry points, architecture, and file hash before promoting findings.

## Choose the integration

- **GUI or Python API:** preferred when Binary Ninja is already open or the user wants direct interactive analysis.
- **Community MCP bridge:** use only when explicitly requested and after reviewing the third-party plugin boundary. Keep the Binary Ninja HTTP listener on `127.0.0.1:9009`; do not enable network exposure by default.
- **Fallback:** use `ghidra-reverse`, `ida-reverse`, or `radare2` when Binary Ninja is unavailable or its license/API cannot open the target.

The reviewed community integration is [`fosdickio/binary_ninja_mcp`](https://github.com/fosdickio/binary_ninja_mcp), GPL-3.0, plugin metadata version `1.1.0`, minimum Binary Ninja build `4000`. The repository is not an official Vector 35 component. This skill was checked against commit `8c5134ee46e2bf44f9a4d846bd971c3e39b3e306` on 2026-09-03.

Install the Binary Ninja side through its Plugin Manager or from the reviewed source. For the MCP stdio bridge, pin the published bridge version rather than using an unbounded package:

```text
npx -y binary-ninja-mcp@1.0.0 --host 127.0.0.1 --port 9009
```

Register that command only in the MCP client the user selected. The bridge is not ready until Binary Ninja is running, a binary is open, and the localhost plugin endpoint responds.

## Analysis workflow

1. Enumerate open binaries and select the intended view.
2. Capture binary status, entry points, segments, imports, exports, and representative strings.
3. Follow call sites and cross-references before interpreting a function in isolation.
4. Use HLIL for readable logic, MLIL SSA for data flow, and LLIL/disassembly when lifting loses instruction-level behavior.
5. Apply names, comments, and types incrementally; keep the original addresses in evidence.
6. Treat byte patches, prototype changes, and saved-file writes as mutations. Perform them only when requested and preserve the original artifact.
7. Cross-check high-impact conclusions with a second evidence source or another disassembler.

Useful MCP capability families include binary/view selection, `list_imports`, `list_exports`, `list_strings`, `decompile_function`, `get_il`, callers/callees, cross-references, types, comments, renames, and byte patching. Discover the live tool list instead of assuming every upstream function is present.

## Output

Report concrete addresses, function names, IL level, supporting strings/imports, confidence, and reproduction steps. Keep the Evidence → Finding → Path chain used by the rest of the repository.
