---
name: rev-ios-dump
description: Dump decrypted iOS app binaries (砸壳) from jailbroken devices using frida-ios-dump. Activate when the user wants to decrypt an iOS app, dump an IPA from a device, or extract a decrypted Mach-O binary for reverse engineering.
---

# rev-ios-dump - iOS App Decryption (砸壳)

Dump decrypted iOS application binaries from jailbroken devices for security analysis and reverse engineering.

---

## Overview

iOS apps distributed via the App Store are encrypted with Apple's FairPlay DRM. To perform static analysis (IDA/Ghidra/Hopper), the binary must first be decrypted at runtime — commonly called "砸壳" (dumping the shell). This skill uses Frida to instrument the running process and dump the decrypted Mach-O from memory.

---

## Prerequisites

| Requirement | Details |
|-------------|---------|
| Jailbroken iOS device | With SSH access enabled |
| frida-server | Installed and running on the device |
| Python 3 | On the host machine |
| frida + frida-tools | `pip3 install frida frida-tools` |
| USB or network access | SSH connection to the device |

### Verify frida-server is Running

```bash
# Check frida-server on device via SSH
ssh mobile@<device_ip> "ps aux | grep frida-server"

# If not running, start it
ssh mobile@<device_ip> "/usr/sbin/frida-server -D &"

# Verify from host
frida-ls-devices
frida-ps -H <device_ip>
```

---

## Tool: frida-ios-dump

Repo: `https://github.com/P4nda0s/frida-ios-dump`

### Installation

```bash
git clone https://github.com/P4nda0s/frida-ios-dump.git
cd frida-ios-dump
pip3 install -r requirements.txt

# Build the TypeScript agent (required before first run)
npm install --ignore-scripts
npx frida-compile dump.ts -o dist/dump.js
```

Note: This version uses a TypeScript-based Frida agent. The `dist/dump.js` must be compiled before `dump.py` can run.

---

## Step-by-Step Workflow

### Step 1: Identify Target App Bundle ID

Use one of these methods on the device:

```bash
# Method 1: List running apps via Frida
frida-ps -H <device_ip> -a

# Method 2: SSH into device and check
ssh mobile@<device_ip> "find /var/containers/Bundle/Application -name Info.plist -exec plutil -p {} \; 2>/dev/null | grep CFBundleIdentifier"
```

Or use CocoaTop on the device to identify the running process and its Bundle ID.

### Step 2: Ensure Target App is Running

The target app **must be running** on the device. frida-ios-dump attaches to the live process to dump decrypted memory.

### Step 3: Execute Dump

```bash
cd frida-ios-dump

python3 dump.py -H <device_ip> -u mobile -P <password> <bundle_id>
```

**Parameters:**

| Flag | Description |
|------|-------------|
| `-H` | Device IP address |
| `-u` | SSH username (typically `mobile`) |
| `-P` | SSH password (typically `alpine` on fresh jailbreak) |
| `<bundle_id>` | Target app Bundle ID (e.g., `app.ish.iSH`) |

**Example:**

```bash
python3 dump.py -H 192.168.1.100 -u mobile -P alpine app.ish.iSH
```

### Step 4: Verify Output

A successful dump produces a `.ipa` file in the current directory:

```bash
ls -la *.ipa

# Unzip to inspect
unzip -o <app_name>.ipa -d dumped_app/

# Verify decryption — cryptid should be 0
otool -l dumped_app/Payload/<AppName>.app/<BinaryName> | grep -A4 LC_ENCRYPTION_INFO
```

If `cryptid 0` is shown, the binary is successfully decrypted.

---

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `Failed to spawn` | App not installed or wrong Bundle ID | Verify Bundle ID with `frida-ps -H <ip> -a` |
| `Unable to connect to remote frida-server` | frida-server not running or port blocked | Start frida-server on device, check firewall |
| `SSH connection refused` | SSH not enabled or wrong credentials | Verify SSH access: `ssh mobile@<ip>` |
| `Timeout waiting for process` | App crashed or not fully launched | Launch app manually first, then retry |
| `frida.ServerNotRunningError` | frida-server version mismatch | Match frida-server version to host frida version |
| `cryptid 1` in output | Dump failed, binary still encrypted | Ensure app is running during dump, retry |
| `Permission denied` | SSH key/password issue | Check `-u` and `-P` flags, or use SSH key auth |

### Version Mismatch Fix

frida-server and host frida must be the same major version:

```bash
# Check host version
frida --version

# Download matching frida-server from:
# https://github.com/frida/frida/releases
# Choose: frida-server-<version>-ios-arm64.xz
```

---

## Output Usage

After obtaining the decrypted IPA:

1. **Static analysis** — Load the decrypted Mach-O into IDA/Ghidra/Hopper
2. **Class dump** — Extract ObjC headers: `class-dump <binary> > headers.h`
3. **String analysis** — Search for sensitive strings, URLs, keys
4. **Frida hooking** — Use with `rev-frida` skill for dynamic analysis
5. **Symbol recovery** — Use with `rev-symbol` skill for stripped binary analysis

---

## Notes

- The device must remain unlocked and the app must stay in the foreground during the dump process.
- For apps with multiple frameworks, frida-ios-dump will dump all encrypted frameworks within the app bundle.
- Some apps with advanced jailbreak detection may terminate before the dump completes — consider bypassing jailbreak detection first.
