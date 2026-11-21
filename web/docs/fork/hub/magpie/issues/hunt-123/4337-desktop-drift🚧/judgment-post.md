Confirmed — and already fixed on main. Your diagnosis is exactly right, @qq406175258-del: Desktop 4.4212 seals `inferenceGatewayApiKey` at rest (`__sealed__:v1:…`, Electron safeStorage on macOS), and magpie's byte-for-byte check read that as "changed" while Desktop kept sending the same key in memory.

**Status**

Fixed by 83e41a22c ("agent: Claude Desktop's key, sealed at rest by Desktop 4.4212, isn't said to be changed"), committed to main the same minute this issue was filed (from a Discord report), and first shipped in v0.1.2122. Your installed 0.1.2119 predates it; any release from v0.1.2122 on (current latest v0.1.2888) has the fix. Updating magpie clears the pill for good: Desktop re-seals the key at its next start and magpie now leaves it alone.

**How it's covered (tip 247794c61)**

- `internal/agent/desktopseal.go:39` `desktopOpen` opens a `__sealed__:v1:` value where it can (Windows DPAPI). What it can't open — the macOS Keychain seal, `internal/agent/desktopseal_other.go:7` — comes back "unknown", and the check treats unknown as not changed: `internal/agent/claudedesktop.go:279-281` returns `want, true` for it. That is the exact trade-off this issue suggested ("a sealed secret is unknown, not changed"), plus it still compares the real key wherever the seal can be opened.
- Reconnect leaves a sealed key alone (`internal/agent/claudedesktop.go:358`), so the write-in-the-clear → re-seal loop is gone too.
- The address check still catches a profile pointed elsewhere while the key is sealed — covered by test.

**Verified on this machine (darwin/arm64, tip 247794c61)**

| Check | Result |
| --- | --- |
| `go test -tags nogui -run 'TestClaudeDesktopSealedKeyIsNotChanged\|TestClaudeDesktopImportedSealedKeyStays\|TestDesktopOpenNotSealed' ./internal/agent/` | 3/3 PASS |
| `TestClaudeDesktopSealedKeyIsNotChanged` also proves | sealed key → no drift and Sync doesn't rewrite the profile; a clear foreign key → still "was changed"; key gone → "is gone"; wrong address with the key sealed → still caught |

The covering tests are `internal/agent/desktopseal_test.go:21`, `:62` and `:86`.

Not verified here: a live Claude Desktop 4.4212 on macOS writing its Keychain seal into a real profile (this machine has no Desktop-on-magpie); the sandbox tests exercise a seal magpie can't open, which is the same path the macOS Keychain seal takes.

AI use: this comment was written with GLM-5.3-Flash via ZCode; I ran and read the tests above.
