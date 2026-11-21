---
name: deobf-indirect
description: Deobfuscate indirect branches (CSEL + BR pattern) using symbolic execution and BFS traversal to recover control flow
---

# Deobfuscate Indirect Branches

## Part 1: CSEL + BR Indirect Branch Pattern

### Pattern Recognition

The obfuscator converts conditional branches into indirect jumps, where `CSEL` and `BR` instructions appear in pairs. `CSEL` selects one of two target addresses based on a condition, followed by some junk instructions, then `BR` jumps to the selected address.

Typical instruction sequence:

```asm
CMP             W10, W11
CSEL            W10, W13, W12, LS   ; select W13 or W12 based on LS condition
......                               ; junk code in between (address calculations, etc.)
ADD             X8, X8, X14
BR              X8                   ; indirect jump to the computed target
```

Key characteristics:

- `CSEL` selects one of two register values, representing two branch targets
- Code between `CSEL` and `BR` is address calculation or junk code
- `BR` performs the final indirect jump

### Analysis Approach

Symbolic execution: when encountering a `CSEL` instruction, force different branch selections to obtain two different `BR` target addresses.

Steps:

1. Start two symbolic execution runs from the same basic block entry
2. First run: force `CSEL` to select the first register (condition-true branch)
3. Second run: force `CSEL` to select the second register (condition-false branch)
4. Each run reaches `BR` and yields a different target address (A and B)

### Traversal Strategy

BFS traversal starting from the function entry block:

1. Add the function entry address to the work queue
2. Dequeue an address, run symbolic execution with both `CSEL` selections until `BR`
3. Record patch info (CSEL address, condition, two target addresses)
4. Add both target addresses to the work queue
5. Use a visited set to prevent revisiting
6. Mark blocks ending with `RET` as return blocks — do not continue from them

### Patching Strategy

Code between `CSEL` and `BR` is junk — patch a conditional branch directly at the `CSEL` location.

For example, `CSEL W11, W8, W9, CC`: W8 is the target for the CC-true branch (A), W9 is the target for the CC-false branch (B).

Patch as:

```asm
BCC  A    ; if condition met, jump to A
B    B    ; otherwise jump to B
```

Two instructions = 8 bytes, overwriting the `CSEL` (4 bytes) and the next junk instruction (4 bytes).

## Part 2: CSET + BR Indirect Branch Pattern (Jump Table Variant)

### Pattern Recognition

Unlike the CSEL variant in Part 1, the CSET variant uses a 0/1 index to look up a jump table for computing the target address. The code between CSET and BR is NOT all junk — it contains useful instructions that subsequent basic blocks depend on.

Typical instruction sequence:

```asm
CMP             X27, X8
CSET            W8, EQ              ; W8 = 0 or 1 (index)
STR             W8, [SP, #offset]   ; store index (junk)
LDR             X9, [SP, #tbl_off]  ; load jump table pointer (junk)
LDR             X8, [X9, W8, UXTW#3] ; table[index] (junk)
ADRP            X9, #page           ; load encrypted constant (junk)
LDR             W9, [X9, #off]      ;   (junk)
MOV             W10, #imm           ; XOR key (junk)
MOVK            W10, #imm, LSL#16   ;   (junk)
EOR             W9, W9, W10         ; decrypt offset (junk)
NEG             W9, W9              ; negate (junk)
ADD             X8, X8, W9, SXTW    ; final target address (junk, boundary)
; --- useful code below ---
ADRP            X25, #0x100004000   ; register setup for successor blocks
ADD             X25, X25, #0x250
MOV             W28, #0xF065        ; constant init
MOVK            W28, #0x611A, LSL#16
LDR             X23, [SP, #0x50]    ; load state for successor
BR              X8                   ; indirect jump (junk)
```

### Junk Code Identification

`ADD Xn, Xn, Wm, SXTW` is the boundary between junk and useful code. Everything from CSET to ADD (inclusive) is junk:

| Instruction                     | Purpose                       | Classification                 |
| ------------------------------- | ----------------------------- | ------------------------------ |
| `CSET Wd, cond`                 | Set 0/1 index                 | junk (replaced by patch)       |
| `STR Wd, [SP, #off]`            | Store index value             | junk (only used by jump table) |
| `LDR Xn, [base, #off]`          | Load jump table pointer       | junk                           |
| `LDR Xm, [Xn, Wd, UXTW#3]`      | Table lookup table[index]     | junk                           |
| `ADRP + LDR Wn`                 | Load encrypted constant       | junk                           |
| `MOV + MOVK Wm`                 | XOR decryption key            | junk                           |
| `EOR Wn, Wn, Wm`                | Decrypt offset                | junk                           |
| `NEG Wn, Wn`                    | Negate                        | junk                           |
| `ADD Xm, Xm, Wn, SXTW`          | Compute final address         | junk (**boundary**)            |
| Subsequent MOV/LDR/STR/ADRP+ADD | Register and stack state init | **useful**                     |
| `BR Xm`                         | Indirect jump                 | junk (replaced by patch)       |

### Analysis Approach

Same as the CSEL variant: symbolic execution forces CSET to take 1 and 0 respectively, runs until BR to obtain two target addresses.

One difference: a single basic block may contain multiple CSEL/CSET instructions (e.g., a data-selection CSEL followed by a branch-controlling CSET). The script forces selection on every CSEL/CSET encountered; the recorded `csel_addr` is the last one (the one that controls the BR target).

### Patching Strategy

Cannot patch directly at the CSET location (would skip useful code). Correct approach:

1. Locate `ADD Xn, Xn, Wm, SXTW` (the boundary)
2. Extract useful code bytes between ADD+4 and BR
3. Move useful code up to the CSET location
4. Append `Bcond A; B B` immediately after

```
Before:  [CSET][junk...][ADD][useful code][BR]
After:   [useful code][Bcond A][B B][... dead code ...]
```

Prerequisite: useful code must be position-independent (SP-relative addressing, immediate assignments, or same-page ADRP). Moving ADRP within the same 4KB page requires no immediate adjustment.

### Reference Implementation

Two script variants for different obfuscation sub-patterns:

#### `script/deinbr-v3-csel.py` — CSEL variant (ELF)

For binaries where `CSEL` directly selects between two target addresses and the code between CSEL and BR is pure address calculation junk. Patches 8 bytes at the CSEL location (Bcond + B), overwriting CSEL and the next junk instruction.

#### `script/deinbr-v3-cset.py` — CSET variant (Mach-O / ELF)

For binaries where `CSET` sets a 0/1 index and the code between CSET and BR contains **useful side-effect instructions** (register setup, stack stores for subsequent blocks) interleaved with address calculation junk.

Patching strategy: find `ADD Xn, Xn, Wm, SXTW` (last address calculation step), move the useful code (between ADD and BR) up to the CSET location, then append Bcond + B. This preserves register/memory state that successor blocks depend on. The moved instructions must be position-independent (SP-relative, immediates, or same-page ADRP).

Both scripts share the same core workflow:

1. `analyze_br(proj, func_start)` — BFS traversal, collects all patch points
2. `run_until_br(proj, state, csel_selector)` — execute from a given state until BR, forcing CSEL/CSET selection
3. `do_patch(binary_path, save_path, proj, patch_list)` — assemble patches with keystone and write to binary

Key angr options:

- `CALLLESS` — ignore function calls to prevent analysis divergence
- `LAZY_SOLVES` — defer constraint solving for performance
- `ZERO_FILL_UNCONSTRAINED_MEMORY` — fill unconstrained memory with zeros
- `ZERO_FILL_UNCONSTRAINED_REGISTERS` — fill unconstrained registers with zeros

### Script Execution Rules

All non-trivial Python code (both analysis scripts and final patching scripts) MUST be written to a file and executed via `python script.py`. Never use `python -c "..."` inline in bash. This avoids shell quoting/escaping issues and makes scripts easier to debug and reuse.

### Common Errors and Debugging

#### BR target is an invalid address

```
block: 41fe20, next_1: <SimState @ 0x2908f8c3>, next_2: <SimState @ 0x2908f8c3>
SimEngineError: No bytes in memory for block starting at 0x2908f8c3.
```

Cause: The user-provided address is not the function entry but an internal basic block. Stack-based jump table base addresses and offset constants have not been initialized (filled with zeros by ZERO_FILL), causing BR to compute an invalid target.

Solution: Confirm the address is the function start. Use the symbol table or IDA/Ghidra to find the function entry:

```python
for sym in proj.loader.main_object.symbols:
    if sym.rebased_addr <= target_addr < sym.rebased_addr + sym.size:
        print(sym.name, hex(sym.rebased_addr))
```

#### Both branch targets are identical

```
block: XXXXX, next_1: <SimState @ 0xABCD>, next_2: <SimState @ 0xABCD>
```

Same cause as above — starting execution from a non-entry point means the two registers selected by CSEL hold the same value (both zero or the same uninitialized value), producing the same BR target after address calculation.

Solution: Use the correct function entry address.

#### Encountering non-CSEL conditional select instructions

```
block XXXXX: expected 1 successor, got 0
```

Or the script reaches BR without detecting CSEL, so `csel_addr` is missing from globals.

Cause: The basic block uses `CSET` instead of `CSEL`. `CSET` is a special form of `CSEL`, equivalent to `CSEL Rd, WZR, WZR, invert(cond)`, selecting 1 or 0 as an index.

Handle the same way as `CSEL` — identify the condition and force both branch selections. The script must handle both `csel` and `cset`:

```python
if insn.mnemonic == 'cset':
    # cset Wd, cond  is equivalent to  csel Wd, #1, #0, cond (condition met=1, not met=0)
    dst, cond = parse_cset(insn)
    val = 1 if csel_selector == 1 else 0
    setattr(state.regs, dst, val)
    ...
```
