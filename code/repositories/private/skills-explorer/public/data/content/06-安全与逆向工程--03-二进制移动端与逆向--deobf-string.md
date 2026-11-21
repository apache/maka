---
name: deobf-string
description: Decrypt and recover obfuscated strings from binaries by analyzing encryption patterns and generating decryption scripts
---

# Deobfuscate Strings

## Prerequisites

Before starting analysis, check if IDA Pro MCP is connected. Use the MCP tool to verify the connection. If IDA Pro MCP is not available, inform the user:

> IDA Pro MCP is not connected. Please open IDA Pro with the MCP plugin loaded and ensure the MCP server is running, then try again.

## Workflow

### Step 1: Identify Encrypted Strings

Analyze the user-provided code snippet or function to identify string encryption patterns:

- Look for byte arrays or data references that appear to be encrypted strings
- Identify the decryption routine (often called at string usage sites)
- Determine the encryption algorithm by reverse-engineering the decryption function

Common patterns:

- XOR with a single byte or key array
- Custom substitution ciphers
- RC4 or other stream ciphers
- Base64 + XOR combinations
- Stack-constructed strings with arithmetic transformations

### Step 2: Analyze the Decryption Routine

Use IDA Pro MCP to:

- Decompile the decryption function
- Identify parameters: encrypted data pointer, length, key
- Determine the algorithm type and complexity

### Step 3: Choose Decryption Strategy

**Simple algorithms** (pure computation, no external dependencies):

- Single-byte or multi-byte XOR
- ADD/SUB/ROT transformations
- Simple lookup tables

→ Write a standalone Python script to decrypt.

**Complex algorithms** (state-dependent, uses library functions, or too complex to reimplement):

- Custom crypto with many rounds
- Decryption depends on runtime state or global variables
- Algorithm is heavily obfuscated itself

→ Use Unicorn Engine to emulate the decryption function directly from the binary.

### Step 4: Implement Decryption

#### Simple decryption (Python script):

```python
def decrypt_string(enc_bytes, key):
    # Example: XOR decryption
    return bytes([b ^ key[i % len(key)] for i, b in enumerate(enc_bytes)])
```

#### Complex decryption (Unicorn emulation):

```python
from unicorn import *
from unicorn.arm64_const import *

def emulate_decrypt(binary_path, func_addr, enc_data, enc_len, key_ptr):
    with open(binary_path, 'rb') as f:
        code = f.read()

    mu = Uc(UC_ARCH_ARM64, UC_MODE_LITTLE_ENDIAN)
    # Map code segment
    mu.mem_map(base_addr, align(len(code)))
    mu.mem_write(base_addr, code)
    # Map stack
    mu.mem_map(stack_base, stack_size)
    mu.reg_write(UC_ARM64_REG_SP, stack_top)
    # Set up arguments (AArch64 calling convention)
    mu.reg_write(UC_ARM64_REG_X0, enc_data_addr)
    mu.reg_write(UC_ARM64_REG_X1, enc_len)
    mu.reg_write(UC_ARM64_REG_X2, key_addr)
    # Emulate
    mu.emu_start(func_addr, func_end)
    # Read decrypted result
    result = mu.mem_read(output_addr, enc_len)
    return bytes(result)
```

### Step 5: Output Results

After decryption, present results to the user:

1. Display decrypted strings with their addresses in a table format:

```
Address      | Decrypted String
-------------|------------------
0x00412000   | "Hello, World!"
0x00412020   | "/dev/null"
```

2. Ask the user if they want to generate a patch file:

> Decryption complete. Would you like me to write the results to a .patched file that replaces encrypted strings in the binary?

If yes, write a patched binary with encrypted bytes replaced by plaintext (null-terminated), saved as `<original_name>.patched`.
