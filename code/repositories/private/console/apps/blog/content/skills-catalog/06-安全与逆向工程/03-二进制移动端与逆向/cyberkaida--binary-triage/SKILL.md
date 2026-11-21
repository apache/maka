---
name: binary-triage
description: Performs initial binary triage by surveying memory layout, strings, imports/exports, and functions to quickly understand what a binary does and identify suspicious behavior. Use when first examining a binary, when user asks to triage/survey/analyze a program, or wants an overview before deeper reverse engineering.
---

# Binary Triage

## Instructions
We are triaging a binary to quickly understand what it does. This is an initial survey, not deep analysis. Our goal is to:
1. Identify key components and behaviors
2. Flag suspicious or interesting areas
3. Create a task list of next steps for deeper investigation

## Binary triage with ReVa

Follow this systematic workflow using ReVa's MCP tools:

### 1. Identify the Program
- Use `get-current-program` to see the active program
- Or use `list-project-files` to see available programs in the project
- Note the `programPath` (e.g., "/Hatchery.exe") for use in subsequent tools

### 2. Survey Memory Layout
- Use `get-memory-blocks` to understand the binary structure
- Examine key sections:
  - `.text` - executable code
  - `.data` - initialized data
  - `.rodata` - read-only data (strings, constants)
  - `.bss` - uninitialized data
- Flag unusual characteristics:
  - Unusually large sections
  - Packed/encrypted sections
  - Executable data sections
  - Writable code sections

### 3. Survey Strings
- Use `get-strings-count` to see total string count
- Use `get-strings` with pagination (100-200 strings at a time)
- Look for indicators of functionality or malicious behavior:
  - **Network**: URLs, IP addresses, domain names, API endpoints
  - **File System**: File paths, registry keys, configuration files
  - **APIs**: Function names, library references
  - **Messages**: Error messages, debug strings, log messages
  - **Suspicious Keywords**: admin, password, credential, token, crypto, encrypt, decrypt, download, execute, inject, shellcode, payload

### 4. Survey Symbols and Imports
- Use `get-symbols-count` with `includeExternal=true` to count imports
- Use `get-symbols` with `includeExternal=true` and `filterDefaultNames=true`
- Focus on external symbols (imports from libraries)
- Flag interesting/suspicious imports by category:
  - **Network APIs**: connect, send, recv, WSAStartup, getaddrinfo, curl_*, socket
  - **File I/O**: CreateFile, WriteFile, ReadFile, fopen, fwrite, fread
  - **Process Manipulation**: CreateProcess, exec, fork, system, WinExec, ShellExecute
  - **Memory Operations**: VirtualAlloc, VirtualProtect, mmap, mprotect
  - **Crypto**: CryptEncrypt, CryptDecrypt, EVP_*, AES_*, bcrypt, RC4
  - **Anti-Analysis**: IsDebuggerPresent, CheckRemoteDebuggerPresent, ptrace
  - **Registry**: RegOpenKey, RegSetValue, RegQueryValue
- Note the ratio of imports to total symbols (heavy import usage may indicate reliance on libraries)

### 5. Survey Functions
- Use `get-function-count` with `filterDefaultNames=true` to count named functions
- Use `get-function-count` with `filterDefaultNames=false` to count all functions
- Calculate ratio of named vs unnamed functions (high unnamed ratio = stripped binary)
- Use `get-functions` with `filterDefaultNames=true` to list named functions
- Identify key functions:
  - **Entry points**: `entry`, `start`, `_start`
  - **Main functions**: `main`, `WinMain`, `DllMain`, `_main`
  - **Suspicious names**: If not stripped, look for revealing function names

### 6. Cross-Reference Analysis for Key Findings
- For interesting strings found in Step 3:
  - Use `find-cross-references` with `direction="to"` and `includeContext=true`
  - Identify which functions reference suspicious strings
- For suspicious imports found in Step 4:
  - Use `find-cross-references` with `direction="to"` and `includeContext=true`
  - Identify which functions call suspicious APIs
- This helps prioritize which functions need detailed examination

### 7. Selective Initial Decompilation
- Use `get-decompilation` on entry point or main function
  - Set `limit=30` to get ~30 lines initially
  - Set `includeIncomingReferences=true` to see callers
  - Set `includeReferenceContext=true` for context snippets
- Use `get-decompilation` on 1-2 suspicious functions identified in Step 6
  - Set `limit=20-30` for quick overview
- Look for high-level patterns:
  - Loops (encryption/decryption routines)
  - Network operations
  - File operations
  - Process creation
  - Suspicious control flow (obfuscation indicators)
- **Do not do deep analysis yet** - this is just to understand general behavior

### 8. Document Findings and Create Task List
- Use the `TodoWrite` tool to create an actionable task list with items like:
  - "Investigate string 'http://malicious-c2.com' (referenced at 0x00401234)"
  - "Decompile function sub_401000 (calls VirtualAlloc + memcpy + CreateThread)"
  - "Analyze crypto usage in function encrypt_payload (uses CryptEncrypt)"
  - "Trace anti-debugging checks (IsDebuggerPresent at 0x00402000)"
  - "Examine packed section .UPX0 for unpacking routine"
- Each todo should be:
  - Specific (include addresses, function names, strings)
  - Actionable (what needs to be investigated)
  - Prioritized (most suspicious first)

## Output Format

Present triage findings to the user in this structured format:

### Program Overview
- **Name**: [Program name from programPath]
- **Type**: [Executable type - PE, ELF, Mach-O, etc.]
- **Platform**: [Windows, Linux, macOS, etc.]

### Memory Layout
- **Total Size**: [Size in bytes/KB/MB]
- **Key Sections**: [List main sections with sizes and permissions]
- **Unusual Characteristics**: [Any packed/encrypted/suspicious sections]

### String Analysis
- **Total Strings**: [Count from get-strings-count]
- **Notable Findings**: [Bullet list of interesting strings with context]
- **Suspicious Indicators**: [URLs, IPs, suspicious keywords found]

### Import Analysis
- **Total Symbols**: [Count from get-symbols-count]
- **External Imports**: [Count of external symbols]
- **Key Libraries**: [Main libraries imported]
- **Suspicious APIs**: [Categorized list of concerning imports]

### Function Analysis
- **Total Functions**: [Count with filterDefaultNames=false]
- **Named Functions**: [Count with filterDefaultNames=true]
- **Stripped Status**: [Yes/No based on ratio]
- **Entry Point**: [Address and name]
- **Main Function**: [Address and name]
- **Key Functions**: [List of important functions identified]

### Suspicious Indicators
[Bulleted list of red flags discovered, prioritized by severity]

### Recommended Next Steps
[Present the task list created in Step 8]
- Each item should be specific and actionable
- Prioritize by severity/importance
- Include addresses, function names, and context

## Important Notes

- **Speed over depth**: This is triage, not full analysis. Move quickly through steps.
- **Use pagination**: Don't request thousands of strings/functions at once. Use chunks of 100-200.
- **Focus on anomalies**: Flag things that are unusual, suspicious, or interesting.
- **Context is key**: When using cross-references, enable `includeContext=true` for code snippets.
- **Create actionable todos**: Each next step should be specific enough for another agent to execute.
- **Be systematic**: Follow all 8 steps in order for comprehensive coverage.
