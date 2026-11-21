package gateway

import (
	"encoding/json"
	"reflect"
	"testing"
)

// hunt103/b probe: does main (3bebc383, d71362afc in) still emit items on a
// non-array anywhere, on the shapes from #3173 (nested items.items, the
// reporter's 400 path), #3121 (union list with array half, one level), and
// the no-array-half list skygunner's rule also clears?
func TestZZProbe3173NestedItemsOffAnArray(t *testing.T) {
	// #3173's reported 400 path: items.items under an array property, the
	// inner node's type list folding to string without the fix.
	in := `{"type":"object","properties":{
		"functions":{"type":"array","minItems":1,"items":{"type":["string","array"],"items":{"type":"string"}}},
		"reviewed":{"type":"array","items":{"oneOf":[{"type":["string","array"],"items":{"type":"string"}},{"type":"number"}]}}
	}}`
	var got any
	if err := json.Unmarshal(plainSchema(json.RawMessage(in)), &got); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(got)
	t.Logf("nested-items.items -> %s", b)
	if strays := findStrayItems(got, "$"); len(strays) != 0 {
		t.Errorf("items on a non-array survived: %v in %s", strays, b)
	}
}

func TestZZProbe3121OneLevel(t *testing.T) {
	// #3121: a property whose schema is a type list with an array half and
	// its own items.
	in := `{"type":"object","properties":{
		"disease":{"type":["string","array"],"items":{"type":"string","minLength":1}}
	},"required":["disease"]}`
	want := `{"type":"object","properties":{
		"disease":{"type":"array","items":{"type":"string","minLength":1}}
	},"required":["disease"]}`
	var got, exp any
	if err := json.Unmarshal(plainSchema(json.RawMessage(in)), &got); err != nil {
		t.Fatal(err)
	}
	json.Unmarshal([]byte(want), &exp)
	if !reflect.DeepEqual(got, exp) {
		b, _ := json.Marshal(got)
		t.Errorf("got %s", b)
	}
}

func TestZZProbeNoArrayHalf(t *testing.T) {
	// a type list with no array half: the items must go, not ride a string.
	in := `{"type":"object","properties":{
		"disease":{"type":["string","number"],"items":{"type":"string"},"minItems":1,"maxItems":2}
	}}`
	var got any
	if err := json.Unmarshal(plainSchema(json.RawMessage(in)), &got); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(got)
	t.Logf("no-array-half -> %s", b)
	if strays := findStrayItems(got, "$"); len(strays) != 0 {
		t.Errorf("items on a non-array survived: %v in %s", strays, b)
	}
}

// findStrayItems walks a plainSchema output and reports every path where
// items (or minItems/maxItems) sits on a node whose type is not array.
func findStrayItems(v any, path string) []string {
	var out []string
	switch x := v.(type) {
	case []any:
		for _, e := range x {
			out = append(out, findStrayItems(e, path)...)
		}
	case map[string]any:
		t, _ := x["type"].(string)
		if t != "array" {
			for _, k := range []string{"items", "minItems", "maxItems"} {
				if x[k] != nil {
					out = append(out, path+"."+k+" on type "+t)
				}
			}
		}
		for k, e := range x {
			out = append(out, findStrayItems(e, path+"."+k)...)
		}
	}
	return out
}
