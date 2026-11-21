<!-- hunt93 L4 audit draft — NOT posted. Baseline: upstream/main 4a1cd776 (fetched 2026-10-27). Seven-question gate: passed; trigger realism (same-size corruption) stated plainly in the body. Test file: onnx_panic_test.go (red at head). -->

## A model file that is malformed instead of missing ends magpie, not the load

`guard.Load` (internal/pii/guard, from `6e9820a3`, #3578) reads AstrLink Guard's three files with nothing native, and every step of the reading checks its bounds and comes back as an error — but one step doesn't: an initializer whose `dims` multiply past int64 makes the external tensor's `length` negative, which walks past the "external data out of range" check, and `data[offset : offset+length]` panics. The panic is in `guardLoad`, called from `guardClassifyTurn`, called from the find goroutine `backend.find` runs (`internal/pii/find.go`) — behind no recover anywhere on the way — so it ends the whole gateway, every agent's every request, over one bad file.

Minimal reproduction: a model_int8.onnx of one external initializer whose single dim is the varint of 2^63 (negative as int64), beside a two-byte onnx_data — `loadNet` panics with `slice bounds out of range [:-9223372036854775808]` instead of returning an error. The new test below holds exactly these bytes and wants an error; at head it gets the panic:

```
--- FAIL: TestLoadNetErrorsOnAMalformedTensor (0.00s)
    onnx_panic_test.go:43: loadNet panicked on a malformed model: runtime error: slice bounds out of range [:-9223372036854775808]
```

The path the bytes take (`readTensor`, onnx.go):

```go
	n := int64(1)
	for _, d := range t.dims {
		n *= d          // dims [2^63] → n negative
	}
	...
	case external:
		...
		if length < 0 {
			length = n * size   // negative
		}
		if offset < 0 || offset+length > int64(len(data)) {
			return name, nil, errors.New("external data out of range")
		}
		t.raw = data[offset : offset+length]   // panics
```

`offset+length` going the other way (negative) never trips the check; a product that wraps to a small positive would pass it too and hand the network truncated weights, caught later by shape checks or not. The files reach `Load` after passing `guardInstalled` on their **size alone** — their sha256 is checked once, at the download — so a file that is corrupted after it is installed (a bit flip, an interrupted write padded back to size, an antivirus rewriting) gets in. What it should do is what the package does everywhere else — `decodeCache` reads "a file cut short or not ours" as empty, `fields` says "bad protobuf key" — come back as an error, and a load that failed is what the pii package already knows what to do with: `retryAfter` holds requests back and tries again.

The odds of the trigger are the honest cost of this issue: it needs corruption that keeps the size, which is rare — but the blast radius is the process, not a request, and the fix is one comparison. `n` and `length` checked as they are built (or the sum against `len(data)` in uint64) close it.

Verification (macOS 15.6 arm64, go1.26, at upstream/main `4a1cd776`):

| Check | Result |
| --- | --- |
| `go test ./internal/pii/guard -run TestLoadNetErrorsOnAMalformedTensor` (new) | red: panic `slice bounds out of range [:-9223372036854775808]` |
| `go test -count=1 ./internal/pii/guard` whole package with the new test kept | only the new test red; `TestKernelsMatchGo` (the asm against the Go reference) and the rest green |
| `gofmt -l internal/pii/guard` | clean |
| `go vet ./internal/pii/...` darwin, `GOOS=linux`, `GOOS=windows` | exit 0 each |

## Source

Found auditing the #3578 series (`6e9820a3` pii/guard: run AstrLink Guard's int8 model in Go): the ONNX protobuf reader is new, hand-written, and parses bytes that reach it unhashed (size-checked only, `guardInstalled`).

## Not verified

No corrupted-on-disk 37 MB data file run through a real load — the reproduction is the crafted 43-byte model file, which pins the panic to the exact line. The overflow-to-small-positive variant (dims that wrap near 2^64 into a plausible element count) is reasoned from the same three lines, not separately reproduced; the same check closes both. Whether a same-size corruption is common enough to file is the judgment call here — filed because the cost of being wrong is one small bounds check, and the cost of the bug is the gateway.
