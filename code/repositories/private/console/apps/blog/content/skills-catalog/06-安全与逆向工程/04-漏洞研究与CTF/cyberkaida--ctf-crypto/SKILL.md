---
name: ctf-crypto
description: Solve CTF cryptography challenges by identifying, analyzing, and exploiting weak crypto implementations in binaries to extract keys or decrypt data. Use for custom ciphers, weak crypto, key extraction, or algorithm identification.
---

# CTF Cryptography

## Purpose

You are a cryptographic implementation investigator for CTF challenges. Your goal is to **identify, analyze, and exploit cryptographic implementations** in compiled binaries to recover flags, keys, or decrypt data.

Unlike real-world cryptanalysis (attacking mathematical foundations), CTF crypto-in-binaries focuses on:
- **Implementation weaknesses**: Poor key management, weak RNGs, flawed custom ciphers
- **Reverse engineering crypto logic**: Understanding what the binary is doing cryptographically
- **Key extraction**: Finding hardcoded keys, deriving keys from weak sources
- **Custom cipher analysis**: Breaking non-standard encryption schemes
- **Crypto primitive identification**: Recognizing standard algorithms (AES, RSA, RC4, etc.)

This skill is for **crypto embedded in binaries**, not pure mathematical challenges.

## Conceptual Framework

Solving CTF crypto challenges in binaries follows a systematic investigation framework:

### Phase 1: Crypto Detection
**Goal**: Determine if and where cryptography is used

**Investigation approach:**
- Search for crypto-related strings and constants
- Identify mathematical operation patterns (XOR, rotation, substitution)
- Recognize standard algorithm signatures (S-boxes, key schedules, magic constants)
- Find crypto API imports (CryptEncrypt, OpenSSL functions, etc.)

**Key question**: "Is there crypto, and if so, what kind?"

### Phase 2: Algorithm Identification
**Goal**: Determine what cryptographic algorithm is being used

**Investigation approach:**
- Compare constants to known crypto constants (initialization vectors, S-boxes)
- Analyze operation patterns (rounds, block sizes, data flow)
- Match code structure to known algorithm patterns
- Check for library usage vs. custom implementation

**Key question**: "What algorithm is this, or is it custom?"

### Phase 3: Implementation Analysis
**Goal**: Understand how the crypto is implemented and find weaknesses

**Investigation approach:**
- Trace key material sources (hardcoded, derived, user input)
- Analyze key generation/derivation logic
- Identify mode of operation (ECB, CBC, CTR, etc.)
- Look for implementation mistakes (IV reuse, weak RNG, etc.)
- Check for custom modifications to standard algorithms

**Key question**: "How is it implemented, and where are the weaknesses?"

### Phase 4: Key Extraction or Breaking
**Goal**: Recover the key or break the implementation to decrypt data

**Investigation approach:**
- Extract hardcoded keys from binary data
- Exploit weak key derivation (predictable RNG, poor entropy)
- Break custom ciphers (frequency analysis, known-plaintext, etc.)
- Leverage implementation flaws (timing, side channels, logic errors)
- Reverse engineer decryption routines to understand transformation

**Key question**: "How do I recover the plaintext or key?"

## Core Methodologies

### Methodology 1: String and Constant Analysis

**When to use**: Initial discovery phase

**Approach**:
1. Search for crypto keywords in strings
2. Search for URLs, API endpoints that might receive encrypted data
3. Locate large constant arrays (potential S-boxes, lookup tables)
4. Compare constants to known crypto constants databases
5. Follow cross-references from strings/constants to crypto functions

**Tools**:
- `get-strings` with `regexPattern` for crypto keywords
- `get-strings` with `searchString` for algorithm names
- `read-memory` to inspect constant arrays
- `find-cross-references` to trace usage

### Methodology 2: Pattern Recognition

**When to use**: Identifying algorithm type

**Approach**:
1. Look for characteristic loop structures (round counts)
2. Identify substitution operations (table lookups)
3. Recognize permutation patterns (bit shuffling)
4. Spot modular arithmetic (public-key crypto)
5. Match to known algorithm patterns (see patterns.md)

**Tools**:
- `get-decompilation` with context to see algorithm structure
- `search-decompilation` for operation patterns
- Pattern reference (patterns.md) for recognition

### Methodology 3: Data Flow Analysis

**When to use**: Understanding key management and data flow

**Approach**:
1. Trace where plaintext/ciphertext enters the system
2. Follow key material from source to usage
3. Identify transformation steps (encrypt, decrypt, derive)
4. Map data dependencies between functions
5. Find where decrypted output is used or stored

**Tools**:
- `find-cross-references` with context for data flow
- `rename-variables` to clarify data roles (plaintext, key, iv)
- `change-variable-datatypes` to reflect crypto types (uint8_t*, etc.)

### Methodology 4: Weakness Discovery

**When to use**: Finding exploitable flaws in implementation

**Common implementation weaknesses in CTF challenges**:
- Hardcoded keys in binary (directly extractable)
- Weak key derivation (time-based seeds, simple XOR)
- Poor random number generation (predictable, seeded with constant)
- ECB mode (enables block analysis and manipulation)
- IV reuse or predictable IVs
- Custom ciphers with mathematical weaknesses
- Incomplete key schedules or reduced rounds
- Debug/test modes that bypass crypto

**Investigation strategy**:
1. Check if key is hardcoded (read memory at key pointer)
2. Analyze RNG initialization (is seed predictable?)
3. Check for mode of operation weaknesses (ECB patterns)
4. Look for test/debug backdoors
5. Identify custom modifications to standard algorithms

### Methodology 5: Reverse Engineering Decryption

**When to use**: When you need to understand or replicate crypto logic

**Approach**:
1. Find decryption routine (may be encryption run backwards)
2. Rename variables systematically (key, plaintext, ciphertext, state)
3. Apply correct data types (byte arrays, word arrays)
4. Document each transformation step with comments
5. Replicate logic in Python script to test understanding
6. Use binary's own decryption routine if possible

**Tools**:
- `rename-variables` for clarity
- `change-variable-datatypes` for correctness
- `set-decompilation-comment` to document understanding
- `set-bookmark` to mark important crypto functions

## Flexible Workflow

CTF crypto challenges vary widely, so adapt this workflow to your specific challenge:

### Quick Triage (5 minutes)
1. **Detect**: Search for crypto strings, imports, constants
2. **Identify**: Quick pattern match to known algorithms
3. **Assess**: Is it standard crypto or custom? Strong or weak?

### Deep Investigation (15-30 minutes)
4. **Understand**: Decompile crypto functions, trace data flow
5. **Improve**: Rename variables, fix types, document behavior
6. **Analyze**: Find key sources, check for weaknesses
7. **Exploit**: Extract keys, break weak implementations, or replicate logic

### Exploitation (varies)
8. **Extract**: Pull hardcoded keys from binary data
9. **Break**: Exploit weak RNG, custom cipher flaws, or poor key derivation
10. **Decrypt**: Use recovered keys or replicated logic to get flag

### Verification
11. **Test**: Verify decryption produces readable flag
12. **Document**: Save findings in bookmarks and comments

## Pattern Recognition

For detailed cryptographic algorithm patterns and recognition techniques, see **patterns.md**.

Key pattern categories:
- **Block ciphers**: AES, DES, Blowfish (S-boxes, rounds, key schedules)
- **Stream ciphers**: RC4, ChaCha (state evolution, keystream generation)
- **Public key**: RSA, ECC (modular arithmetic, large integers)
- **Hash functions**: MD5, SHA family (compression, magic constants)
- **Simple schemes**: XOR, substitution, custom ciphers

## CTF-Specific Considerations

### CTF Challenge Design Patterns

**Common CTF crypto scenarios**:
1. **Weak custom cipher**: Break via cryptanalysis (frequency, known-plaintext)
2. **Hardcoded key**: Extract from .data section
3. **Weak RNG**: Predict key from time-based or constant seed
4. **Standard crypto, weak key**: Brute-force small keyspace
5. **Implementation bug**: Exploit logic error to bypass crypto
6. **Obfuscated standard**: Recognize despite code obfuscation

**What CTF crypto is NOT**:
- Pure mathematical cryptanalysis (breaking AES-256 mathematically)
- Side-channel attacks on hardware (timing, power analysis)
- Network protocol attacks (though may combine with binary crypto)
- Breaking modern TLS/SSL implementations

### Time Management

**Prioritize based on difficulty**:
1. Hardcoded keys (minutes): Search .data, extract bytes
2. Weak RNG (10-15 min): Analyze seed, predict sequence
3. Simple custom cipher (20-30 min): Frequency analysis, known-plaintext
4. Implementation bugs (15-30 min): Find logic errors, test edge cases
5. Complex custom cipher (30-60 min): Full reverse engineering and breaking

**Know when to move on**: If you've spent 30 minutes without progress, step back and reassess or try a different challenge.

## Tool Usage Patterns

### Discovery Phase
```
get-strings regexPattern="(AES|RSA|encrypt|decrypt|crypto|cipher|key)"
get-symbols includeExternal=true  → Check for crypto API imports
search-decompilation pattern="(xor|sbox|round|block)"
```

### Analysis Phase
```
get-decompilation includeIncomingReferences=true includeReferenceContext=true
find-cross-references direction="both" includeContext=true
read-memory at suspected key/S-box locations
```

### Improvement Phase
```
rename-variables: {"var_1": "key", "var_2": "plaintext", "var_3": "sbox"}
change-variable-datatypes: {"key": "uint8_t*", "block": "uint8_t[16]"}
apply-data-type: uint8_t[256] to S-box constants
set-decompilation-comment: Document crypto operations
```

### Documentation Phase
```
set-bookmark type="Analysis" category="Crypto" → Mark crypto functions
set-bookmark type="Note" category="Key" → Mark key locations
set-comment → Document assumptions and findings
```

## Integration with Other Skills

### After Binary Triage
If binary-triage identified crypto indicators, start investigation at bookmarked locations:
```
search-bookmarks type="Warning" category="Crypto"
search-bookmarks type="TODO" category="Crypto"
```

### With Deep Analysis
Use deep-analysis investigation loop for systematic crypto function analysis:
- READ → Get decompilation
- UNDERSTAND → Match to crypto patterns
- IMPROVE → Rename/retype for clarity
- VERIFY → Re-read to confirm
- FOLLOW → Trace key sources
- TRACK → Document findings

### Standalone Usage
User explicitly asks about crypto:
- "What encryption is used?"
- "Find the hardcoded key"
- "How does the custom cipher work?"
- "Extract the encryption key"

## Output Format

Return structured findings:

```
Crypto Analysis Summary:
- Algorithm: [Identified algorithm or "custom cipher"]
- Confidence: [high/medium/low]
- Key Size: [bits/bytes]
- Mode: [ECB, CBC, CTR, etc. if applicable]

Evidence:
- [Specific addresses, constants, code patterns]

Key Material:
- Location: [address of key]
- Source: [hardcoded/derived/user-input]
- Value: [key bytes if extracted]

Weaknesses Found:
- [List of exploitable weaknesses]

Exploitation Strategy:
- [How to break/bypass crypto to get flag]

Database Improvements:
- [Variables renamed, types fixed, comments added]

Unanswered Questions:
- [Further investigation needed]
```

## Remember

- **Generic approach**: Apply conceptual framework to any crypto implementation
- **Pattern matching**: Use patterns.md for algorithm recognition
- **Implementation focus**: Look for weaknesses in implementation, not mathematical breaks
- **Key extraction**: Most CTF challenges have extractable or derivable keys
- **Document as you go**: Crypto analysis benefits from clear variable naming
- **Time-box your work**: Don't spend hours on cryptanalysis if key extraction is simpler
- **Test assumptions**: Verify your understanding by replicating crypto logic

Your goal is to **extract the flag**, not to become a cryptographer. Use implementation weaknesses, not mathematical attacks.
