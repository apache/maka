---
name: rev-u3d-dump
description: Dump Unity IL2CPP symbols from iOS/Android builds. Extract method names, addresses, and type info from IL2CPP binaries and global-metadata.dat, then generate IDA/Ghidra import scripts.
---

# rev-u3d-dump - Unity IL2CPP Symbol Dumper

Extract C# method names, addresses, and type definitions from Unity IL2CPP builds for IDA/Ghidra analysis.

---

## Overview

Unity IL2CPP compiles C# to native code. The original class/method names are stripped from the binary but preserved in `global-metadata.dat`. This skill recovers the mapping between native function addresses and their original C# names.

### Key Files in Unity Build

| File | Location | Purpose |
|------|----------|---------|
| Native binary | iOS: `Frameworks/UnityFramework.framework/UnityFramework`<br>Android: `lib/{arch}/libil2cpp.so` | Compiled C# code (Mach-O / ELF) |
| Metadata | `Data/Managed/Metadata/global-metadata.dat` | All type/method/string info |

---

## Tool Selection

### Il2CppDumper (recommended for metadata v39+)

Use the **v39 fork** for Unity 6+ builds:

- Repo: `https://github.com/roytu/Il2CppDumper` (branch: `v39`)
- Supports metadata v24–v39
- Outputs `script.json` with function addresses — ready for IDA/Ghidra import

The original Il2CppDumper (`https://github.com/Perfare/Il2CppDumper`) only supports up to v29.

### Cpp2IL (alternative)

- Repo: `https://github.com/SamboyCoding/Cpp2IL`
- Supports metadata v39, but dummy DLLs lack `[Address]` attributes
- Useful for C# source reconstruction, not ideal for IDA import

---

## Step-by-Step Workflow

### Step 1: Locate IL2CPP Files

**iOS (IPA):**
```bash
# Unzip IPA
unzip -o app.ipa -d .

# Binary
BINARY="Payload/<AppName>.app/Frameworks/UnityFramework.framework/UnityFramework"

# Metadata
METADATA="Payload/<AppName>.app/Data/Managed/Metadata/global-metadata.dat"
```

**Android (APK):**
```bash
# Unzip APK
unzip -o app.apk -d .

# Binary (pick target arch)
BINARY="lib/arm64-v8a/libil2cpp.so"

# Metadata
METADATA="assets/bin/Data/Managed/Metadata/global-metadata.dat"
```

### Step 2: Check Metadata Version

```bash
# First 8 bytes: magic (4) + version (4), little-endian
xxd -l 8 "$METADATA"
# Expected: af1b b1fa 2700 0000  → magic OK, version = 0x27 = 39
```

| Version | Unity | Tool |
|---------|-------|------|
| ≤ 29 | Unity 2021 and earlier | Original Il2CppDumper |
| 31 | Unity 2022 | Original Il2CppDumper (partial) |
| 39 | Unity 6 (6000.x) | **roytu/Il2CppDumper v39 fork** |

### Step 3: Build & Run Il2CppDumper (v39 fork)

```bash
# Clone v39 fork
git clone -b v39 https://github.com/roytu/Il2CppDumper.git

# Build
cd Il2CppDumper
DOTNET_ROLL_FORWARD=LatestMajor dotnet build -c Release

# Run (use net8.0 framework)
DOTNET_ROLL_FORWARD=LatestMajor dotnet run \
  --project Il2CppDumper/Il2CppDumper.csproj \
  -c Release --framework net8.0 \
  -- "$BINARY" "$METADATA" output_dir
```

**Notes:**
- `DOTNET_ROLL_FORWARD=LatestMajor` allows running on .NET 9/10 even though the project targets .NET 6/8
- Exit code 134 is normal in non-interactive mode (caused by `Console.ReadKey()` at the end)
- On macOS, if the binary gets SIGKILL'd, ad-hoc sign it: `codesign -s - <binary>`

### Step 4: Verify Output

Successful run produces these files in the output directory:

| File | Size (typical) | Purpose |
|------|----------------|---------|
| `script.json` | 50–100 MB | Function addresses + names + signatures (IDA/Ghidra import) |
| `dump.cs` | 10–30 MB | C# class dump with RVA/VA addresses |
| `il2cpp.h` | 50–100 MB | C struct definitions for type import |
| `ida_py3.py` | ~2 KB | IDA Python import script |

Check `script.json` format:
```json
{
  "ScriptMethod": [
    {
      "Address": 40865744,
      "Name": "ClassName$$MethodName",
      "Signature": "ReturnType ClassName__MethodName (args...);",
      "TypeSignature": "viii"
    }
  ]
}
```

Check `dump.cs` format:
```csharp
// RVA: 0x1A2B3C4 Offset: 0x1A2B3C4 VA: 0x1A2B3C4
public void MethodName() { }
```

### Step 5: Import into IDA

1. Open the native binary in IDA (UnityFramework / libil2cpp.so)
2. Place `script.json` and `ida_py3.py` in the same directory
3. `File → Script file...` → select `ida_py3.py`
4. The script reads `script.json` and renames all functions automatically
5. Optional: `File → Load file → Parse C header file...` → select `il2cpp.h` for struct types

### Step 5 (alt): Import into Ghidra

1. Open the binary in Ghidra
2. Use the `ghidra.py` or `ghidra_with_struct.py` script from Il2CppDumper
3. `Window → Script Manager → Run` with `script.json` in the same directory

---

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `not a supported version[39]` | Using original Il2CppDumper | Switch to roytu/Il2CppDumper v39 fork |
| Exit code 137 (SIGKILL) | macOS unsigned binary | `codesign -s - <binary>` |
| `Cannot read keys` (exit 134) | Non-interactive console | Ignore — dump completed successfully |
| `DOTNET_ROLL_FORWARD` error | .NET version mismatch | Set `DOTNET_ROLL_FORWARD=LatestMajor` |
| Empty output | Wrong binary/metadata pair | Verify both files are from the same build |

---

## Output Usage Tips

- `dump.cs` is the quickest reference — search for class/method names with RVA addresses
- `script.json` Address values are decimal — convert to hex for IDA: `hex(40865744)` → `0x26F8FD0`
- Field offsets in `dump.cs` (e.g., `// 0x20`) are relative to object base, useful for memory inspection with Frida
