package gateway

import (
	"bytes"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/tidwall/gjson"
	"github.com/yetone/magpie/internal/provider"
)

// kimiToolEnumTypes is body with a type written into each schema of its
// tools' that has an enum (or a const) and no type, for Kimi and Moonshot:
// their "moonshot flavored json schema" refuses one, 400 "tools.function.
// parameters is not a valid moonshot flavored json schema … type is not
// defined" (#886, cua-driver's parse_visual_regions, whose kinds' items are
// {"enum":["text","icon"]}), and the whole request fails though the tool is
// never called. The type is the one every value has — string, integer,
// number or boolean, or that type and "null" when a null is among them, the
// one type array Kimi takes beside an enum; values of other mixed types are
// left as they were. It is written in place, after the schema's brace, so
// the rest of the body and a cache's prefix stay as they were.
func kimiToolEnumTypes(p provider.Provider, to provider.Protocol, body []byte) []byte {
	if !isKimi(p, to) {
		return body
	}
	if !bytes.Contains(body, []byte(`"enum"`)) && !bytes.Contains(body, []byte(`"const"`)) {
		return body
	}
	tools := gjson.GetBytes(body, "tools")
	if !tools.IsArray() || tools.Index <= 0 {
		return body
	}
	var ins []typeInsert
	collectUntypedEnums(body, tools, false, &ins)
	return withTypes(body, ins)
}

// withTypes is body with each insert's type written after its schema's
// opening brace; a brace named twice gets it once.
func withTypes(body []byte, ins []typeInsert) []byte {
	if len(ins) == 0 {
		return body
	}
	sort.SliceStable(ins, func(i, j int) bool { return ins[i].at < ins[j].at })
	var out bytes.Buffer
	out.Grow(len(body) + len(ins)*24)
	last := -1
	for _, in := range ins {
		if in.at == last {
			continue
		}
		start := last + 1
		out.Write(body[start : in.at+1])
		out.WriteString(`"type":` + in.typ)
		if !emptyObjectAt(body, in.at) {
			out.WriteByte(',')
		}
		last = in.at
	}
	out.Write(body[last+1:])
	return out.Bytes()
}

// emptyObjectAt is whether the object opening at body[at] is {}, spaces
// aside: a type written into it has nothing after it to be parted from.
func emptyObjectAt(body []byte, at int) bool {
	for i := at + 1; i < len(body); i++ {
		switch body[i] {
		case ' ', '\t', '\n', '\r':
			continue
		case '}':
			return true
		}
		return false
	}
	return false
}

// isKimi is whether p is served by Moonshot: the Kimi platform's API or a
// Kimi Code membership's.
func isKimi(p provider.Provider, to provider.Protocol) bool {
	switch provider.HostOf(p.Base(to)) {
	case "api.moonshot.ai", "api.moonshot.cn", "api.kimi.com", "api.kimi.ai":
		return true
	}
	return strings.HasPrefix(p.Preset, "moonshot") || strings.HasPrefix(p.Preset, "kimi")
}

type typeInsert struct {
	at  int    // the schema's opening brace
	typ string // the type as JSON: "string", or ["string","null"]
}

// collectUntypedEnums adds, for each schema under node with an enum or a
// const and no type, where it opens and the type it is given: properties
// or items say it before the values do (a string enum beside items is an
// array, #3867, as geminiSchemaType reads its keywords first), and the
// values' own type when no keyword does.
func collectUntypedEnums(body []byte, node gjson.Result, inSchema bool, ins *[]typeInsert) {
	switch {
	case node.IsArray():
		node.ForEach(func(_, v gjson.Result) bool {
			collectUntypedEnums(body, v, inSchema, ins)
			return true
		})
	case node.IsObject():
		if inSchema && node.Index > 0 && node.Index < len(body) && body[node.Index] == '{' && !node.Get("type").Exists() {
			var vals []gjson.Result
			if e := node.Get("enum"); e.IsArray() {
				vals = e.Array()
			} else if c := node.Get("const"); c.Exists() {
				vals = []gjson.Result{c}
			}
			if t := enumType(vals); t != "" {
				if kt := keywordType(node); kt == "object" || kt == "array" {
					// properties or items say the type before the
					// values do: a schema with items and a string
					// enum given "string" went on with items beside
					// a string, as a Gemini one did before
					// geminiSchemaType read its keywords first (#3867)
					t = `"` + kt + `"`
				}
				*ins = append(*ins, typeInsert{node.Index, t})
			}
		}
		node.ForEach(func(key, v gjson.Result) bool {
			k := key.String()
			if !inSchema {
				switch k {
				case "parameters", "input_schema":
					collectUntypedEnums(body, v, true, ins)
				case "function":
					collectUntypedEnums(body, v, false, ins)
				}
				return true
			}
			switch k {
			case "properties", "$defs", "definitions", "dependentSchemas", "patternProperties":
				v.ForEach(func(_, s gjson.Result) bool {
					collectUntypedEnums(body, s, true, ins)
					return true
				})
			case "items", "additionalProperties", "contains", "propertyNames", "not", "if", "then", "else", "allOf", "anyOf", "oneOf", "prefixItems", "unevaluatedProperties", "unevaluatedItems", "contentSchema":
				collectUntypedEnums(body, v, true, ins)
			}
			return true
		})
	}
}

// enumType is the type, as JSON, an enum or const of vals is written with
// for Kimi: the one all of them have, or it and "null" when a null is among
// them; "" when there are none or other types are mixed.
func enumType(vals []gjson.Result) string {
	var rest []gjson.Result
	null := false
	for _, v := range vals {
		if v.Type == gjson.Null {
			null = true
			continue
		}
		rest = append(rest, v)
	}
	t := valuesType(rest)
	switch {
	case t == "":
		return ""
	case null:
		return `["` + t + `","null"]`
	}
	return `"` + t + `"`
}

// valuesType is the JSON Schema type all of vals have, "" when there are
// none or they differ; whole numbers among fractions make them number.
func valuesType(vals []gjson.Result) string {
	t := ""
	for _, v := range vals {
		var vt string
		switch v.Type {
		case gjson.String:
			vt = "string"
		case gjson.True, gjson.False:
			vt = "boolean"
		case gjson.Number:
			vt = "integer"
			if strings.ContainsAny(v.Raw, ".eE") {
				vt = "number"
			}
		default:
			return ""
		}
		switch {
		case t == "" || t == vt:
			t = vt
		case t == "integer" && vt == "number" || t == "number" && vt == "integer":
			t = "number"
		default:
			return ""
		}
	}
	return t
}

// kimiLockedSampling is body without temperature and top_p when the model's
// server locks them to one value: since kimi-k2.5 every kimi-kX.Y on both
// Kimi platforms (Moonshot's API and a Kimi Code membership's), Kimi
// Code's own kimi-for-coding and k3*, and the same models on Volcengine
// Ark, whose coding plan serves kimi-kX.Y behind hosts the preset's plans
// and a provider added by hand both reach (#4495: 400 "Volcengine Ark:
// `temperature` only 1 is allowed for this model"). A client that sends
// its own defaults — VS Code Copilot's chat sends temperature 0.1 and
// top_p 1 — is refused 400 "invalid temperature: only 1 is allowed for
// this model" before any token is read (a K2.5/K2.6 with thinking off
// takes only 0.6), and the whole request fails. Left out, the server
// fills in the value the model and mode want, so no number is written
// here. Models that take a range — moonshot-v1-*, kimi-k2-0905-preview,
// kimi-k2-thinking, kimi-latest — keep what the user set, as does anyone
// not served by Moonshot or Ark.
func kimiLockedSampling(p provider.Provider, to provider.Protocol, body []byte) []byte {
	if !isKimi(p, to) && !isArk(p) {
		return body
	}
	if !kimiLockedSamplingModel(gjson.GetBytes(body, "model").String()) {
		return body
	}
	return withoutFields(body, "temperature", "top_p")
}

// kimiLockedSamplingModel is whether the model's server locks temperature
// and top_p: kimi-for-coding* and k3* on Kimi Code, and kimi-k2.5 and
// later (kimi-k2.6, kimi-k3, …) on either platform. A leading "vendor/" is
// ignored.
func kimiLockedSamplingModel(model string) bool {
	m := strings.ToLower(model)
	if i := strings.LastIndexByte(m, '/'); i >= 0 {
		m = m[i+1:]
	}
	if strings.HasPrefix(m, "kimi-for-coding") {
		return true
	}
	v, ok := strings.CutPrefix(m, "kimi-k")
	if !ok {
		if v, ok = strings.CutPrefix(m, "k"); !ok {
			return false
		}
	}
	major, rest := leadingInt(v)
	if major < 0 {
		return false
	}
	if major != 2 {
		return major >= 3
	}
	if !strings.HasPrefix(rest, ".") {
		return false // kimi-k2-thinking, kimi-k2-0905-preview
	}
	minor, _ := leadingInt(rest[1:])
	return minor >= 5
}

// leadingInt reads the decimal integer s begins with, -1 when there is
// none, and what follows it.
func leadingInt(s string) (int, string) {
	i := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	if i == 0 {
		return -1, s
	}
	n, err := strconv.Atoi(s[:i])
	if err != nil {
		return -1, s
	}
	return n, s[i:]
}

// kimiToolRefTypes is body with a type written into each schema its tools'
// $refs reach that has none, for Kimi and Moonshot. Their validator expands
// a $ref and refuses a target with no type — 400 "not a valid moonshot
// flavored json schema … At path 'properties.b': detected infinite
// recursion without termination condition" — and the whole request fails,
// though the same schema written inline passes. Codex sends such targets:
// its MCP and Codex App tools come as zod's $defs (__schema0, __schema1 …),
// and it types a def with properties or an enum but leaves a oneOf or an
// allOf one as it was (chaosy on Discord, Codex on k3). The type is the
// one the target's keywords or branches say, a type array when they differ,
// and every type when nothing does, which Kimi takes as "any". A target
// that is {} or an anyOf (Kimi refuses a type beside one: "type should be
// defined in anyOf items instead of the parent schema") is left as Kimi
// takes it, as is an enum whose values no one type array can hold. A
// target that is itself a $ref — zod writes one beside what it changed of
// a reused schema, a format and a description among them — has its chain
// followed to the target it ends at, for a type beside a $ref is refused
// too, 400 "At path '$defs.__schema14': when using $ref, type should be
// defined in the referenced schema instead of the parent schema" (#3205),
// so the type goes to the chain's end or nowhere; a chain that ends at a
// ref to nowhere, or never ends, leaves its schemas as they were. Written
// in place, like kimiToolEnumTypes', after which it runs.
func kimiToolRefTypes(p provider.Provider, to provider.Protocol, body []byte) []byte {
	if !isKimi(p, to) || !bytes.Contains(body, []byte(`"$ref"`)) {
		return body
	}
	tools := gjson.GetBytes(body, "tools")
	if !tools.IsArray() || tools.Index <= 0 {
		return body
	}
	var ins []typeInsert
	tools.ForEach(func(_, tool gjson.Result) bool {
		for _, at := range []string{"function.parameters", "parameters", "input_schema"} {
			if root := tool.Get(at); root.IsObject() {
				collectRefTargets(body, root, root, &ins)
			}
		}
		return true
	})
	return withTypes(body, ins)
}

// collectRefTargets adds, for each local $ref under node (a schema of the
// tool schema root) whose target Kimi would refuse untyped, where the
// target opens and the type it is given. The target is the schema the
// chain of $refs ends at, the one place a type may go (#3205); a chain
// that ends at a ref to nowhere, or never ends, adds nothing.
func collectRefTargets(body []byte, root, node gjson.Result, ins *[]typeInsert) {
	walkSchema(node, func(s gjson.Result) {
		ref := s.Get(`\$ref`)
		if ref.Type != gjson.String {
			return
		}
		t, ok := refTarget(root, ref.String())
		if !ok {
			return
		}
		for i := 0; ; i++ {
			r := t.Get(`\$ref`)
			if r.Type != gjson.String {
				break
			}
			if i > 16 {
				return
			}
			n, ok := refTarget(root, r.String())
			if !ok {
				return
			}
			t = n
		}
		if !t.IsObject() || t.Index <= 0 || t.Index >= len(body) || body[t.Index] != '{' || !untypedForKimi(t) {
			return
		}
		if typ := kimiSchemaType(root, t); typ != "" {
			*ins = append(*ins, typeInsert{t.Index, typ})
		}
	})
}

// walkSchema calls f with node and every schema under it, through the
// keywords that hold schemas.
func walkSchema(node gjson.Result, f func(gjson.Result)) {
	switch {
	case node.IsArray():
		node.ForEach(func(_, v gjson.Result) bool {
			walkSchema(v, f)
			return true
		})
	case node.IsObject():
		f(node)
		node.ForEach(func(key, v gjson.Result) bool {
			switch key.String() {
			case "properties", "$defs", "definitions", "dependentSchemas", "patternProperties":
				v.ForEach(func(_, s gjson.Result) bool {
					walkSchema(s, f)
					return true
				})
			case "items", "additionalProperties", "contains", "propertyNames", "not", "if", "then", "else", "allOf", "anyOf", "oneOf", "prefixItems", "unevaluatedProperties", "unevaluatedItems", "contentSchema":
				walkSchema(v, f)
			}
			return true
		})
	}
}

// refTarget is the schema a local $ref ("#", "#/$defs/x") names in root.
func refTarget(root gjson.Result, ref string) (gjson.Result, bool) {
	if ref != "#" && !strings.HasPrefix(ref, "#/") {
		return gjson.Result{}, false
	}
	cur := root
	for _, tok := range strings.Split(ref, "/")[1:] {
		tok = strings.ReplaceAll(strings.ReplaceAll(tok, "~1", "/"), "~0", "~")
		if u, err := url.PathUnescape(tok); err == nil {
			tok = u
		}
		if !cur.IsObject() && !cur.IsArray() {
			return gjson.Result{}, false
		}
		cur = cur.Get(gjson.Escape(tok))
		if !cur.Exists() {
			return gjson.Result{}, false
		}
	}
	return cur, true
}

// untypedForKimi is whether Kimi refuses s as a $ref's target: it has no
// type, isn't {}, an anyOf, or a $ref with nothing but notes beside it.
func untypedForKimi(s gjson.Result) bool {
	if s.Get("type").Exists() || s.Get("anyOf").Exists() {
		return false
	}
	only := true
	n := 0
	s.ForEach(func(k, _ gjson.Result) bool {
		n++
		switch k.String() {
		case "$ref", "description", "title", "default", "examples", "$comment":
		default:
			only = false
		}
		return true
	})
	if n == 0 {
		return false
	}
	return !(only && s.Get(`\$ref`).Exists())
}

// allKimiTypes is every JSON Schema type, which Kimi takes for a schema
// that may be anything.
const allKimiTypes = `["string","number","integer","boolean","object","array","null"]`

// kimiSchemaType is the type, as JSON, an untyped schema s is given: the
// one (or the ones) its keywords and branches say, every type when they
// say nothing, and "" for an enum no type Kimi takes beside one can hold.
func kimiSchemaType(root, s gjson.Result) string {
	if t := keywordType(s); t == "object" || t == "array" {
		// properties or items say it before its values do: a schema
		// with items and a string enum given "string" went on with
		// items beside a string, as a Gemini one did before
		// geminiSchemaType read its keywords first (#3867)
		return `"` + t + `"`
	}
	if e := s.Get("enum"); e.IsArray() {
		return enumType(e.Array())
	}
	if c := s.Get("const"); c.Exists() {
		return enumType([]gjson.Result{c})
	}
	ts := schemaTypes(root, s, 0)
	if len(ts) == 0 {
		return allKimiTypes
	}
	if ts["integer"] && ts["number"] {
		delete(ts, "integer")
	}
	var names []string
	for _, t := range []string{"string", "number", "integer", "boolean", "object", "array", "null"} {
		if ts[t] {
			names = append(names, `"`+t+`"`)
		}
	}
	if len(names) == 1 {
		return names[0]
	}
	return "[" + strings.Join(names, ",") + "]"
}

// schemaTypes is the set of types s can have, as its type, its keywords,
// its values or its branches (through their $refs) say; nil when they
// don't say.
func schemaTypes(root, s gjson.Result, depth int) map[string]bool {
	if depth > 16 || !s.IsObject() {
		return nil
	}
	ts := map[string]bool{}
	if t := s.Get("type"); t.Exists() {
		for _, v := range t.Array() {
			ts[v.String()] = true
		}
		return ts
	}
	if ref := s.Get(`\$ref`); ref.Type == gjson.String {
		if t, ok := refTarget(root, ref.String()); ok {
			return schemaTypes(root, t, depth+1)
		}
		return nil
	}
	if e := s.Get("enum"); e.IsArray() || s.Get("const").Exists() {
		vals := e.Array()
		if c := s.Get("const"); c.Exists() {
			vals = []gjson.Result{c}
		}
		for _, v := range vals {
			switch v.Type {
			case gjson.String:
				ts["string"] = true
			case gjson.True, gjson.False:
				ts["boolean"] = true
			case gjson.Null:
				ts["null"] = true
			case gjson.Number:
				if strings.ContainsAny(v.Raw, ".eE") {
					ts["number"] = true
				} else {
					ts["integer"] = true
				}
			default:
				if v.IsArray() {
					ts["array"] = true
				} else {
					ts["object"] = true
				}
			}
		}
		return ts
	}
	// a branch that says nothing makes oneOf and anyOf anything; allOf
	// is what its branches that do say
	for _, k := range []string{"oneOf", "anyOf", "allOf"} {
		bs := s.Get(k)
		if !bs.IsArray() {
			continue
		}
		known := false
		for _, b := range bs.Array() {
			bt := schemaTypes(root, b, depth+1)
			if len(bt) == 0 && k != "allOf" {
				return nil
			}
			for t := range bt {
				ts[t] = true
				known = true
			}
		}
		if known {
			return ts
		}
	}
	t := keywordType(s)
	if t == "" {
		return nil
	}
	ts[t] = true
	return ts
}

// keywordType is the type schema s's keywords say (properties: object,
// items: array, pattern: string, minimum: number), "" when they say none.
// An object's or an array's keywords come first: they hold schemas of
// their own, which a validator reads only under that type.
func keywordType(s gjson.Result) string {
	has := func(keys ...string) bool {
		for _, k := range keys {
			if s.Get(k).Exists() {
				return true
			}
		}
		return false
	}
	switch {
	case has("properties", "required", "additionalProperties", "patternProperties", "minProperties", "maxProperties", "propertyNames", "dependentRequired", "dependentSchemas", "unevaluatedProperties"):
		return "object"
	case has("items", "prefixItems", "minItems", "maxItems", "uniqueItems", "contains", "unevaluatedItems"):
		return "array"
	case has("minLength", "maxLength", "pattern", "format", "contentEncoding", "contentMediaType"):
		return "string"
	case has("minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"):
		return "number"
	}
	return ""
}
