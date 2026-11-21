---
name: ctf-rev
description: Solve CTF reverse engineering challenges using systematic analysis to find flags, keys, or passwords. Use for crackmes, binary bombs, key validators, obfuscated code, algorithm recovery, or any challenge requiring program comprehension to extract hidden information.
---

# CTF Reverse Engineering

## Purpose

You are a CTF reverse engineering solver. Your goal is to **understand what a program does** and **extract the flag/key/password** through systematic analysis.

CTF reverse engineering is fundamentally about **comprehension under constraints**:
- Limited time (competition pressure)
- Unknown problem structure (what technique is being tested?)
- Minimal documentation (that's the challenge!)
- Goal-oriented (find the flag, not perfect understanding)

Unlike malware analysis or vulnerability research, CTF reversing tests your ability to:
1. **Quickly identify the core challenge** (crypto? obfuscation? algorithm recovery?)
2. **Trace critical data flow** (where does input go? how is it validated?)
3. **Recognize patterns** (standard algorithms, common tricks)
4. **Adapt your approach** (static vs dynamic, top-down vs bottom-up)

## Conceptual Framework

### The Three Questions

Every reverse engineering challenge boils down to answering:

**1. What does the program EXPECT?**
- Input format (string, number, binary data?)
- Input structure (length, format, encoding?)
- Validation criteria (checks, comparisons, constraints?)

**2. What does the program DO?**
- Transformation (encrypt, hash, encode, compute?)
- Comparison (against hardcoded value, derived value?)
- Algorithm (standard crypto, custom logic, mathematical?)

**3. How do I REVERSE it?**
- Is the operation reversible? (encryption vs hashing)
- Can I brute force? (keyspace size, performance)
- Can I derive the answer? (solve equations, trace backwards)
- Can I bypass? (patch, debug, manipulate state)

### Understanding vs Solving

**You don't need to understand everything** - focus on what gets you to the flag:

**Full Understanding** (often unnecessary):
- Every function's purpose
- Complete program flow
- All edge cases and error handling
- Library implementation details

**Sufficient Understanding** (what you need):
- Entry point to flag validation
- Core transformation logic
- Input-to-output relationship
- Comparison or success criteria

**Example:**
```
Program has 50 functions. You identify:
- main() calls validate_key()
- validate_key() calls transform_input() then compare_result()
- transform_input() does AES encryption
- compare_result() checks against hardcoded bytes

Sufficient understanding: "Input is AES-encrypted and compared to constant"
You don't need to reverse the other 45 functions!
```

## Core Methodologies

### Static Analysis: Code Comprehension

**Goal:** Understand program logic by reading decompiled/disassembled code

**When to use:**
- Small, focused programs (crackmes, keygens)
- Algorithm identification challenges
- When dynamic analysis is hindered (anti-debugging, complex state)
- When you need to understand transformation logic

**Approach:**
1. **Find the critical path** - Entry point → flag validation → success
2. **Trace input flow** - Where does user input go? How is it used?
3. **Identify operations** - What transformations occur? (XOR, loops, comparisons)
4. **Recognize patterns** - Does this match known algorithms? (see patterns.md)

**ReVa workflow:**
```
1. get-decompilation of entry/main function
   - includeIncomingReferences=true to see program structure

2. Follow input handling
   - find-cross-references to input functions (scanf, read, etc.)
   - Trace data flow from input to validation

3. Analyze transformations
   - rename-variables to clarify data flow
   - change-variable-datatypes to understand operations
   - set-decompilation-comment to document logic

4. Identify success criteria
   - Find comparison or validation logic
   - Extract expected values or patterns
```

### Dynamic Analysis: Runtime Observation

**Goal:** Observe program behavior during execution

**When to use:**
- Complex control flow (hard to follow statically)
- Obfuscated or packed code
- When you need to see intermediate values
- Time-based or environmental checks

**Approach:**
1. **Set breakpoints at key locations**
   - Input processing
   - Transformations
   - Comparisons
   - Success/failure branches

2. **Observe state changes**
   - Register/variable values
   - Memory contents
   - Function arguments/returns

3. **Test hypotheses**
   - "If I input X, does Y happen?"
   - "What value is being compared here?"

**Note:** ReVa focuses on static analysis. For dynamic analysis, use external debuggers (gdb, x64dbg, etc.)

### Hybrid Approach: Best of Both Worlds

**Most effective for CTF challenges**

**Workflow:**
1. **Static: Identify structure** (find validation function, success path)
2. **Dynamic: Observe runtime** (breakpoint at validation, see expected value)
3. **Static: Understand transformation** (reverse the algorithm)
4. **Dynamic: Verify solution** (test your derived key/flag)

**Example:**
```
Static: "Input is transformed by function sub_401234 then compared"
Dynamic: Run with test input, breakpoint at comparison → see expected value
Static: Decompile sub_401234 → recognize as base64 encoding
Solve: base64_decode(expected_value) = flag
Dynamic: Verify flag works
```

## Problem-Solving Strategies

### Strategy 1: Top-Down (Goal-Oriented)

**Start from the win condition, work backwards**

**When to use:**
- Clear success/failure indicators (prints "Correct!" or "Wrong!")
- Simple program structure
- When you want to understand the minimum necessary

**Workflow:**
```
1. Find success message/function
2. find-cross-references direction="to" → What calls this?
3. get-decompilation of validation function
4. Identify what conditions lead to success
5. Work backwards to understand required input
```

**Example:**
```
1. String "Congratulations!" at 0x402000
2. Referenced by function validate_flag at 0x401500
3. Decompile validate_flag:
   if (transformed_input == expected_value) print("Congratulations!");
4. Now focus on: What's expected_value? How is input transformed?
```

### Strategy 2: Bottom-Up (Data Flow)

**Start from input, trace forward to validation**

**When to use:**
- Complex program structure (many functions)
- When win condition is unclear
- When you want to understand transformations

**Workflow:**
```
1. get-strings regexPattern="(scanf|read|fgets|input)"
2. find-cross-references to input function
3. Trace data flow: input → storage → transformation → usage
4. Follow transformations until you reach comparison/validation
```

**Example:**
```
1. scanf at 0x401000 reads into buffer
2. buffer passed to process_input(buffer)
3. process_input calls encrypt(buffer, key)
4. Encrypted result compared to hardcoded bytes
5. Now analyze: What's the encryption? Can we reverse it?
```

### Strategy 3: Pattern Recognition

**Identify standard algorithms or common techniques**

**When to use:**
- Crypto challenges (encryption, hashing)
- Encoding challenges (base64, custom encodings)
- Algorithm implementation challenges

**Workflow:**
```
1. Look for algorithmic patterns (see patterns.md):
   - Loop structures (rounds, iterations)
   - Constant arrays (S-boxes, tables)
   - Characteristic operations (XOR, rotations, substitutions)

2. Compare to known implementations:
   - read-memory at constant arrays → compare to standard tables
   - Count loop iterations → indicates algorithm variant
   - search-decompilation for crypto patterns

3. Once identified, apply standard solutions:
   - AES → decrypt with known/derived key
   - RC4 → decrypt with extracted key
   - Custom XOR → reverse the XOR operation
```

### Strategy 4: Constraint Solving

**Frame the problem as mathematical constraints**

**When to use:**
- Serial/key validation (input must satisfy equations)
- Mathematical puzzles
- Multiple related checks

**Workflow:**
```
1. Identify all constraints on input:
   input[0] + input[1] == 0x42
   input[0] ^ input[2] == 0x13
   input[1] * 2 == input[3]

2. Extract to external solver (z3, constraint solver)

3. Solve for input values

4. Verify solution in program
```

**Example:**
```
Decompiled validation:
  if (flag[0] + flag[1] != 100) return 0;
  if (flag[0] - flag[1] != 20) return 0;
  if (flag[2] ^ 0x42 != 0x33) return 0;

Solve:
  flag[0] + flag[1] = 100
  flag[0] - flag[1] = 20
  → flag[0] = 60, flag[1] = 40

  flag[2] ^ 0x42 = 0x33
  → flag[2] = 0x33 ^ 0x42 = 0x71 = 'q'
```

## Flexible Workflow

CTF challenges vary widely - adapt your approach:

### Initial Assessment (5-10 minutes)

**Understand the challenge:**
- What's provided? (binary, source, description?)
- What's the goal? (find flag, generate key, bypass check?)
- What's the constraint? (time limit, black box?)

**ReVa reconnaissance:**
```
1. get-current-program or list-project-files
2. get-strings-count and sample strings (100-200)
   - Look for: flag format, hints, library names
3. get-symbols with includeExternal=true
   - Check for suspicious imports (crypto APIs, anti-debug)
4. get-function-count to gauge complexity
```

### Focused Investigation (15-45 minutes)

**Follow the most promising lead:**

**If you found flag format in strings:**
→ Top-down from flag string

**If you found crypto APIs:**
→ Pattern recognition (identify algorithm)

**If you found input validation:**
→ Data flow tracing (input to validation)

**If program is simple (< 10 functions):**
→ Comprehensive static analysis

**If program is complex or obfuscated:**
→ Hybrid approach (dynamic to find key points, static to understand)

### Solution Extraction (10-20 minutes)

**Once you understand the mechanism:**

1. **Can you reverse it?**
   - Decryption, decoding, mathematical inverse

2. **Can you derive it?**
   - Solve constraints, extract from comparison

3. **Can you brute force it?**
   - Small keyspace, fast validation

4. **Can you bypass it?**
   - Patch comparison, manipulate state

**Verify your solution:**
- Test with actual program (if possible)
- Check flag format (usually flag{...} or CTF{...})

## Pattern Recognition

CTF challenges often test recognition of standard patterns. See `patterns.md` for detailed guides on:

**Cryptographic Patterns:**
- Block ciphers (AES, DES, custom)
- Stream ciphers (RC4, custom)
- Hash functions (MD5, SHA, custom)
- XOR obfuscation

**Algorithm Patterns:**
- Encoding schemes (base64, custom alphabets)
- Mathematical operations (modular arithmetic, matrix operations)
- State machines (input validation via states)

**Code Patterns:**
- Input validation loops
- Character-by-character comparisons
- Transformation + comparison structures
- Anti-debugging tricks (for CTF context)

**Data Structure Patterns:**
- Lookup tables (substitution ciphers)
- Hardcoded arrays (expected values)
- Buffer transformations

## ReVa Tool Usage for CTF

### Discovery Tools

**Find the interesting parts quickly:**

```
get-strings regexPattern="(flag|key|password|correct|wrong|success)"
→ Find win/lose conditions

search-decompilation pattern="(scanf|read|input|strcmp|memcmp)"
→ Find input/comparison functions

get-functions-by-similarity searchString="check"
→ Find validation functions
```

### Analysis Tools

**Understand the core logic:**

```
get-decompilation with includeIncomingReferences=true, includeReferenceContext=true
→ Get full context of validation logic

find-cross-references direction="both" includeContext=true
→ Trace data flow and function relationships

read-memory to extract constants, tables, expected values
→ Get hardcoded comparison targets
```

### Improvement Tools

**Make code readable as you work:**

```
rename-variables to track data flow
→ input_buffer, encrypted_data, expected_hash

change-variable-datatypes to clarify operations
→ uint8_t* for byte buffers, uint32_t for crypto state

set-decompilation-comment to document findings
→ "AES round function", "Compares against flag"

set-bookmark for important locations
→ type="Analysis" for key findings
→ type="TODO" for things to investigate
```

## Key Principles

### 1. Goal Focus
**Don't analyze everything - focus on getting the flag**
- Identify critical path (input → validation → success)
- Ignore unrelated functions
- Sufficient understanding > complete understanding

### 2. Adapt Quickly
**Switch strategies if stuck**
- Static not working? Try dynamic
- Too complex? Look for simpler approach (bypass, brute force)
- Pattern not matching? Could be custom algorithm

### 3. Leverage Knowledge
**CTF challenges reuse concepts**
- Standard crypto algorithms
- Common obfuscation tricks
- Typical validation patterns
- Recognize and apply known solutions

### 4. Document Progress
**Track what you learn**
```
set-bookmark type="Analysis" category="Finding"
  → Document what you've confirmed

set-bookmark type="TODO" category="Investigate"
  → Track unanswered questions

set-decompilation-comment
  → Preserve understanding for later reference
```

### 5. Verify Incrementally
**Test your understanding as you go**
- "If this is AES, I should see S-box constants" → Check
- "If input is XORed with 0x42, output[0] should be..." → Verify with example
- "If this is the flag comparison, changing this byte should..." → Test hypothesis

## Common CTF Challenge Types

### Crackme / Serial Validation
**Challenge:** Find input that passes validation
**Approach:** Data flow tracing (input → validation logic)
**Key insight:** Focus on validation function, extract constraints

### Algorithm Recovery
**Challenge:** Implement or reverse unknown algorithm
**Approach:** Pattern recognition, understand operations
**Key insight:** Look for mathematical patterns, trace transformations

### Crypto Challenge
**Challenge:** Decrypt ciphertext or find key
**Approach:** Identify algorithm, extract key/IV, decrypt
**Key insight:** Recognize standard crypto patterns (see patterns.md)

### Code Obfuscation
**Challenge:** Understand obfuscated/packed code
**Approach:** Dynamic analysis to observe deobfuscated state
**Key insight:** Let program do the work, observe result

### Binary Bomb
**Challenge:** Defuse "bomb" by providing correct inputs for each phase
**Approach:** Phase-by-phase analysis, mixed static/dynamic
**Key insight:** Each phase typically tests different concept

### Custom Encoding
**Challenge:** Decode encoded flag or encode input correctly
**Approach:** Identify encoding scheme, reverse or replicate
**Key insight:** Look for transformation loops, character mappings

## Integration with Other Skills

### After Binary Triage
**Triage identified suspicious areas → Deep dive with CTF focus**

```
From triage bookmarks:
- "Crypto function at 0x401234" → Identify algorithm, extract key
- "Input validation at 0x402000" → Understand constraints, solve
- "Suspicious string XOR" → Decode to find flag or hint
```

### Using Deep Analysis
**When you need detailed function understanding**

```
CTF skill identifies: "Validation at validate_key function"
Deep analysis answers: "What exactly does validate_key do?"
CTF skill uses result: Apply findings to extract flag
```

**Workflow:**
1. CTF skill: High-level strategy, identify critical functions
2. Deep analysis: Detailed investigation of specific functions
3. CTF skill: Synthesize findings, extract solution

## Success Criteria

**You've solved the challenge when you can:**

1. **Demonstrate understanding:**
   - Explain how input becomes output
   - Identify the validation mechanism
   - Recognize the core algorithm/technique

2. **Extract the solution:**
   - Provide the flag/key/password
   - Explain how you derived it
   - Verify it works (if testable)

3. **Document the path:**
   - Key functions and addresses
   - Critical transformations or comparisons
   - Solution method (reverse, derive, brute force, bypass)

## Remember

CTF reverse engineering is **problem-solving under constraints**:
- You have limited time
- You need sufficient, not perfect, understanding
- The goal is the flag, not comprehensive analysis
- Adapt your strategy based on what you find
- Leverage patterns and prior knowledge
- Switch between static and dynamic as needed

**Focus on answering:**
1. What does the program expect? (input format/structure)
2. What does the program do? (transformation/validation)
3. How do I reverse it? (derive/decrypt/solve/bypass)

When you answer these three questions, you have your flag.
