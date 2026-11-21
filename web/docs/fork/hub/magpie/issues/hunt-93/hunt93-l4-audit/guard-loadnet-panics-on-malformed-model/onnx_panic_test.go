package guard

import (
	"os"
	"path/filepath"
	"testing"
)

// loadNet panics on a malformed model instead of saying so: an
// initializer's dims varint that overflows int64 makes the external
// tensor's length negative, which passes the "external data out of
// range" check, and data[offset:offset+length] panics. The files pass
// Installed() on their size alone (their sha256 is checked at the
// download only), so a corrupted one reaches Load, and the panic — in
// internal/pii's find goroutine, behind no recover — ends the whole
// gateway. It should come back as an error: "a file cut short or not
// ours" is read as a load that failed, held back and tried again.
func TestLoadNetErrorsOnAMalformedTensor(t *testing.T) {
	dir := t.TempDir()
	// the external data file, as read before the dims are used
	if err := os.WriteFile(filepath.Join(dir, "model_int8.onnx_data"), []byte("data"), 0o644); err != nil {
		t.Fatal(err)
	}
	// ModelProto { graph { initializer { dims: 2^63, data_type: int8,
	// name: "w", external_data { location: "model_int8.onnx_data" },
	// external: true } } }, the fields' numbers as onnx.proto has them
	tensor := concat(
		[]byte{0x08, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01}, // dims: 2^63, negative as int64
		[]byte{0x10, 0x03},      // data_type: int8
		[]byte{0x42, 0x01, 'w'}, // name: "w"
		[]byte{0x6a, 0x20,
			0x0a, 0x08, 'l', 'o', 'c', 'a', 't', 'i', 'o', 'n',
			0x12, 0x14, 'm', 'o', 'd', 'e', 'l', '_', 'i', 'n', 't', '8', '.', 'o', 'n', 'n', 'x', '_', 'd', 'a', 't', 'a'}, // external_data
		[]byte{0x70, 0x01}, // external: true
	)
	graph := concat([]byte{0x2a, byte(len(tensor))}, tensor)
	onnx := concat([]byte{0x3a, byte(len(graph))}, graph)
	if err := os.WriteFile(filepath.Join(dir, "model_int8.onnx"), onnx, 0o644); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if p := recover(); p != nil {
			t.Fatalf("loadNet panicked on a malformed model: %v", p)
		}
	}()
	if _, err := loadNet(filepath.Join(dir, "model_int8.onnx")); err == nil {
		t.Fatal("loadNet took a malformed model")
	}
}

func concat(parts ...[]byte) []byte {
	var out []byte
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}
