---
name: rev-symbol
description: Restore function symbols by analyzing code patterns, strings, constants, and cross-references
---

# rev-symbol - Symbol Recovery

Analyze function code characteristics to recover/identify function symbols and names.

## Pre-check

**Determine which IDA access method is available:**

**Option A — IDA Pro MCP (preferred if connected):**
Check if the IDA Pro MCP server is connected (look for an active `ida-pro` or equivalent MCP connection). If connected, you can query IDA directly via MCP tools — no exported files needed. Proceed with the analysis using MCP.

**Option B — IDA-NO-MCP exported data:**
If MCP is not connected, check if IDA-NO-MCP exported data exists in the current directory:

1. Check if `decompile/` directory exists
2. Check if there are `.c` files inside

If neither MCP nor exported data is available, prompt the user:
```
No IDA access method detected. Choose one of the following:

Option A — IDA Pro MCP (recommended):
  Connect the IDA Pro MCP server so Claude can query IDA directly.

Option B — IDA-NO-MCP export:
  1. Download plugin: https://github.com/P4nda0s/IDA-NO-MCP
  2. Copy INP.py to IDA plugins directory
  3. Press Ctrl-Shift-E in IDA to export
  4. Open the exported directory with Claude Code
```

---

## Export Directory Structure

```
./
├── decompile/              # Decompiled C code directory
│   ├── 0x401000.c          # One file per function, named by hex address
│   ├── 0x401234.c
│   └── ...
├── decompile_failed.txt    # Failed decompilation list
├── decompile_skipped.txt   # Skipped functions list
├── strings.txt             # String table (address, length, type, content)
├── imports.txt             # Import table (address:function_name)
├── exports.txt             # Export table (address:function_name)
└── memory/                 # Memory hexdump (1MB chunks)
```

## Function File Format (decompile/*.c)

Each `.c` file contains function metadata comments and decompiled code:

```c
/*
 * func-name: sub_401000
 * func-address: 0x401000
 * callers: 0x402000, 0x403000    // List of functions that call this function
 * callees: 0x404000, 0x405000    // List of functions called by this function
 */

int __fastcall sub_401000(int a1, int a2)
{
    // Decompiled code...
}
```

---

## Symbol Recovery Steps

### Step 1: Analyze Internal Characteristics

Carefully examine the target function for:

- **String constants**: Strings used in the function may reveal its purpose
- **Numeric constants / Magic Numbers**: 
  - MD5: `0x67452301`, `0xEFCDAB89`, `0x98BADCFE`, `0x10325476`
  - CRC32: `0xEDB88320`
  - Base64 charset: `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/`
  - AES S-Box: `0x63, 0x7C, 0x77, 0x7B...`
  - Zlib: `0x78`, `0x9C` (compression header)
  - other constants/magic numbers...
- **Code structure**: Loop patterns, bitwise operations, specific algorithm flows

If you can identify a known algorithm through constants/structure, tell the user directly.

### Step 2: Analyze Cross-References

**Analyze Callees (called functions):**
- Read functions in the callees list
- For each callee, check if its address exists in `imports.txt`
- Recognize call patterns even when symbols are missing:

  **Paired function patterns (identify by matching call pairs):**
  ```c
  // malloc/free, new/delete, alloc/dealloc
  xx = sub_A(0x100);        // alloc: takes size, returns pointer
  ...
  sub_B(xx);                // free: takes the same pointer
  
  // mutex_lock/mutex_unlock, pthread_mutex_lock/unlock
  sub_A(lock_ptr);          // lock
  ...                       // critical section
  sub_B(lock_ptr);          // unlock (same lock object)
  
  // open/close, fopen/fclose, CreateFile/CloseHandle
  fd = sub_A("/path", 0);   // open: path + flags, returns handle
  ...
  sub_B(fd);                // close: takes the handle
  
  // pthread_create/pthread_join
  sub_A(&tid, 0, func, arg); // create: out param, attr, func, arg
  ...
  sub_B(tid, &ret);          // join: tid, out param
  

  **Argument pattern recognition:**
  ```c
  // socket(AF_INET, SOCK_STREAM, 0) - fixed constants
  sub_XXX(2, 1, 0);         // socket: domain=2, type=1, protocol=0
  
  // connect/bind(sockfd, addr, addrlen)
  sub_XXX(fd, &var, 16);   // addr struct, len=16 for IPv4
  
  // memcpy/memmove(dst, src, size)
  sub_XXX(dst, src, n);     // 3 params: dst, src, count
  
  // memset(ptr, value, size)
  sub_XXX(ptr, 0, 0x100);   // 3 params: ptr, byte value, count
  
  // read/write(fd, buf, count)
  ret = sub_XXX(fd, buf, n); // returns bytes read/written
  
  // strcmp/strncmp(s1, s2) or (s1, s2, n)
  if (sub_XXX(s1, s2) == 0)  // returns 0 on equal
  ```

  **Return value patterns:**
  ```c
  // file/socket operations: -1 on error
  if ((fd = sub_XXX(...)) == -1) goto error;
  
  // allocation: NULL on failure
  if (!(ptr = sub_XXX(size))) goto error;
  
  // success/error: 0 = success
  if (sub_XXX(...) != 0) goto error;
  
  // strlen: returns size_t
  len = sub_XXX(str);
  sub_YYY(dst, src, len);   // len used in memcpy
  ```

**Analyze Callers (calling functions):**
- Read functions in the callers list
- If a caller has a symbol (check exports.txt), infer the callee's purpose from context
- Recursive check: trace up the call chain until you find a function with a symbol
- Analyze how the return value is used by callers

### Step 3: Information Gathering and Search

Collect the following information:
- Strings in the function (check `strings.txt` for addresses used in the function)
- Magic Numbers / constants
- Known imports called (cross-reference callees with `imports.txt`)
- Caller/callee symbols from `exports.txt`
- Paired function patterns identified

Based on collected information:
1. First attempt local reasoning based on:
   - Function signature (number and types of parameters)
   - Paired call patterns (alloc/free, lock/unlock)
   - Known imports in the call chain
   - Code structure similarity to known algorithms

2. If uncertain, use **Web Search** to search:
   - Search Magic Numbers: `0x67452301 0xEFCDAB89 algorithm`
   - Search code patterns: `rotate left xor constant algorithm`
   - Search unique strings found in the function
   - Search parameter patterns: `function(int, int, 0) socket`

---

## Output Format

```
## Symbol Recovery Analysis: <function_address>

### Function Characteristics
- Strings: <list discovered strings>
- Constants: <list key constants>
- Called imports: <list>

### Cross-Reference Analysis
- Callers: <callers and their symbols>
- Callees: <callees and their symbols>

### Inference Result
- **Suggested symbol name**: <suggested_name>
- **Confidence**: High / Medium / Low
- **Reasoning**: <explain why this name is suggested>

### Similar Open Source Implementation
- <if similar open source code is found, provide link>
```
