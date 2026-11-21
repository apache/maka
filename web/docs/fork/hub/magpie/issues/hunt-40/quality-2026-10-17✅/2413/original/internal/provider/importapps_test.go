package provider

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func sqliteFixture(t *testing.T, path string, stmts ...string) {
	t.Helper()
	os.MkdirAll(filepath.Dir(path), 0o700)
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			t.Fatalf("%s: %v", s, err)
		}
	}
}

func itemsOf(t *testing.T, id string) map[string]AppImport {
	t.Helper()
	for _, s := range ImportSources() {
		if s.ID == id {
			if !s.Found || s.Error != "" {
				t.Fatalf("%s: found %v, %s", id, s.Found, s.Error)
			}
			out := map[string]AppImport{}
			for _, it := range s.Items {
				out[it.Ref] = it
			}
			return out
		}
	}
	t.Fatalf("no source %s", id)
	return nil
}

// CC Switch keeps each agent's own settings; magpie reads them as the
// providers they point at, and adds only what the user picks.
func TestImportCCSwitch(t *testing.T) {
	isolate(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)                                  // Windows
	t.Setenv("APPDATA", filepath.Join(home, "AppData", "Roaming")) // Windows: never the real Alma
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
	sqliteFixture(t, filepath.Join(home, ".cc-switch", "cc-switch.db"),
		`CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, website_url TEXT, category TEXT, created_at INTEGER, sort_index INTEGER, PRIMARY KEY (id, app_type))`,
		`INSERT INTO providers VALUES ('official','claude','Claude Official','{"env":{}}','','official',1,0)`,
		`INSERT INTO providers VALUES ('relay','claude','Some Relay','{"env":{"ANTHROPIC_BASE_URL":"https://relay.example.com","ANTHROPIC_AUTH_TOKEN":"sk-relay","ANTHROPIC_MODEL":"claude-sonnet-5"}}','https://relay.example.com','custom',2,1)`,
		`INSERT INTO providers VALUES ('relay','codex','Some Relay','{"auth":{"OPENAI_API_KEY":"sk-relay"},"config":"model_provider = \"relay\"\nmodel = \"gpt-5.5\"\n\n[model_providers.relay]\nname = \"relay\"\nbase_url = \"https://relay.example.com/v1\"\nwire_api = \"responses\"\n"}','','custom',3,0)`,
		`INSERT INTO providers VALUES ('ds','claude','DeepSeek','{"env":{"ANTHROPIC_BASE_URL":"https://api.deepseek.com/anthropic","ANTHROPIC_AUTH_TOKEN":"sk-ds"}}','','cn_official',4,2)`,
		`INSERT INTO providers VALUES ('dial','pi','dial','{"api":"openai-completions","apiKey":"magpie","baseUrl":"http://127.0.0.1:3425/v1"}','','custom',5,0)`,
		`INSERT INTO providers VALUES ('g','gemini','Gemini relay','{"env":{"GOOGLE_GEMINI_BASE_URL":"https://g.example.com","GEMINI_API_KEY":"k"}}','','custom',6,0)`,
	)
	// DeepSeek is already here under its preset id, with another key
	if err := Save(FromPresetKey(t, "deepseek", "sk-other")); err != nil {
		t.Fatal(err)
	}

	items := itemsOf(t, "cc-switch")
	if it := items["claude/official"]; it.Skip == "" {
		t.Fatalf("official sign-in offered: %+v", it)
	}
	if it := items["pi/dial"]; it.Skip == "" {
		t.Fatalf("magpie itself offered: %+v", it)
	}
	if it := items["gemini/g"]; it.Skip == "" {
		t.Fatalf("gemini relay offered: %+v", it)
	}
	relay := items["claude/relay"]
	if relay.Skip != "" || relay.Status != "new" || relay.Provider.Anthropic != "https://relay.example.com" || relay.Provider.Responses != "https://relay.example.com/v1" || relay.From != "Claude Code, Codex" {
		t.Fatalf("relay: %+v", relay)
	}
	if _, ok := items["codex/relay"]; ok {
		t.Fatal("the Codex half of the relay listed on its own")
	}
	ds := items["claude/ds"]
	if ds.Status != "taken" || ds.Provider.ID != "deepseek" || ds.Provider.Preset != "deepseek" || ds.KeyOf != "deepseek" {
		t.Fatalf("deepseek: %+v", ds)
	}

	added, err := ImportFromApps([]AppPick{{Source: "cc-switch", Ref: "claude/relay"}, {Source: "cc-switch", Ref: "claude/ds", Mode: "key"}})
	if err != nil || len(added) != 2 {
		t.Fatalf("import: %v %v", added, err)
	}
	if p, err := Find("some-relay"); err != nil || p.Key != "sk-relay" || len(p.Models) != 2 {
		t.Fatalf("relay saved: %+v", p)
	}
	if p, _ := Find("deepseek"); p.Key != "sk-other" || len(p.Keys) != 1 || p.Keys[0].Key != "sk-ds" {
		t.Fatalf("deepseek's second key: %+v", p)
	}
	if it := itemsOf(t, "cc-switch")["claude/ds"]; it.Status != "same" {
		t.Fatalf("second key again: %+v", it)
	}
	// imported once, it is there already
	if it := itemsOf(t, "cc-switch")["claude/relay"]; it.Status != "same" {
		t.Fatalf("after import: %+v", it)
	}
}

func TestImportAlma(t *testing.T) {
	isolate(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)                                  // Windows
	t.Setenv("APPDATA", filepath.Join(home, "AppData", "Roaming")) // Windows: never the real Alma
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	cfg, _ := os.UserConfigDir()
	sqliteFixture(t, filepath.Join(cfg, "alma", "chat_threads.db"),
		`CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT, type TEXT, api_key TEXT, models TEXT, base_url TEXT, enabled INTEGER, created_at TEXT, api_format TEXT, is_response_api INTEGER, custom_headers TEXT)`,
		`INSERT INTO providers VALUES ('a1','OpenRouter','openrouter','sk-or','["anthropic/claude-sonnet-5"]',NULL,1,'1',NULL,0,NULL)`,
		`INSERT INTO providers VALUES ('a2','My Proxy','custom','sk-p','[]','https://proxy.example.com/v1',0,'2','openai-chat',0,'{"X-Team":"a"}')`,
		`INSERT INTO providers VALUES ('a3','Copilot','copilot','','[]',NULL,1,'3',NULL,0,NULL)`,
		`INSERT INTO providers VALUES ('a4','junk','custom','x','[]','bbb',0,'4',NULL,0,NULL)`,
	)
	items := itemsOf(t, "alma")
	if it := items["a1"]; it.Provider.Preset != "openrouter" || it.Provider.Key != "sk-or" || len(it.Provider.Models) != 1 {
		t.Fatalf("openrouter: %+v", it)
	}
	if it := items["a2"]; it.Off == "" || it.Provider.Chat != "https://proxy.example.com/v1" || it.Provider.Headers["X-Team"] != "a" {
		t.Fatalf("proxy: %+v", it)
	}
	if items["a3"].Skip == "" || items["a4"].Skip == "" {
		t.Fatalf("sign-in or junk offered: %+v %+v", items["a3"], items["a4"])
	}
}

func TestImportCodexConfig(t *testing.T) {
	isolate(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)                                  // Windows
	t.Setenv("APPDATA", filepath.Join(home, "AppData", "Roaming")) // Windows: never the real Alma
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
	t.Setenv("CODEX_HOME", filepath.Join(home, ".codex"))
	t.Setenv("OPENAI_API_KEY", "sk-unrelated")
	t.Setenv("RELAY_KEY", "sk-environment")
	config := codexConfigPath()
	if err := os.MkdirAll(filepath.Dir(config), 0o700); err != nil {
		t.Fatal(err)
	}
	data := `model_provider = "magpie"
model = "deepseek/deepseek-chat"
model_catalog_json = "magpie-models.json"

[model_providers.magpie]
base_url = "http://127.0.0.1:3448/v1"
experimental_bearer_token = "magpie"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://relay.example.com/v1"
wire_api = "responses"
experimental_bearer_token = "sk-explicit"

[model_providers.deepseek.http_headers]
X-Org = " abc "

[model_providers."my.relay"]
base_url = "https://other.example.com/v1"
experimental_bearer_token = "sk-other"

[model_providers."my.relay".http_headers]
X-Org = "xyz"

[model_providers.openrouter]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
wire_api = "chat"
experimental_bearer_token = "sk-openrouter"

[model_providers.openrouter.http_headers]
X-Org = "preset"

[model_providers.unkeyed]
base_url = "https://unkeyed.example.com/v1"
env_key = "RELAY_KEY"

[profiles."ds"]
model_provider = "deepseek"
model = "deepseek-chat"
model_catalog_json = "models.json"

[profiles.inherited]
model_provider = "deepseek"
model = "gpt-6-sol"

[profiles.magpiecatalog]
model_provider = "deepseek"
model = "gpt-6-sol"
model_catalog_json = "magpie-models.json"
`
	if err := os.WriteFile(config, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(filepath.Dir(config), "models.json"), []byte(`{"models":[{"slug":"deepseek-chat","visibility":"list"},{"slug":"deepseek-reasoner","visibility":"list"},{"slug":"old-model","visibility":"hide"}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(filepath.Dir(config), "magpie-models.json"), []byte(`{"models":[{"slug":"openrouter/x-ai/grok-4.7","visibility":"list"},{"slug":"group/auto-glm-5-3","visibility":"list"}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	items := itemsOf(t, "codex")
	if len(items) != 5 || items["my.relay"].Ref != "my.relay" || items["my.relay"].Skip != "" {
		t.Fatalf("provider tables: %+v", items)
	}
	if got := items["my.relay"].Provider.Headers["X-Org"]; got != "xyz" {
		t.Fatalf("quoted provider's header = %q, want %q", got, "xyz")
	}
	if p := items["openrouter"].Provider; p.Preset != "openrouter" || p.Headers["X-Org"] != "preset" {
		t.Fatalf("preset import should keep the preset and its headers: %+v", p)
	}
	if items["magpie"].Skip == "" || items["unkeyed"].Skip == "" {
		t.Fatalf("gateway or env-key provider offered: %+v %+v", items["magpie"], items["unkeyed"])
	}
	ds := items["deepseek"]
	if ds.Skip != "" || ds.Provider.Key != "sk-explicit" || ds.Provider.Responses != "https://relay.example.com/v1" || strings.Join(ds.Provider.Models, ",") != "deepseek-chat,deepseek-reasoner,gpt-6-sol" {
		t.Fatalf("Codex import: %+v", ds)
	}
	if _, err := Find("deepseek"); err == nil {
		t.Fatal("Codex config became a provider before import")
	}
	if added, err := ImportFromApps([]AppPick{{Source: "codex", Ref: "deepseek"}, {Source: "codex", Ref: "openrouter"}}); err != nil || len(added) != 2 {
		t.Fatalf("import: %v %v", added, err)
	}
	if it := itemsOf(t, "codex")["deepseek"]; it.Status != "same" {
		t.Fatalf("reimport after header normalization: %+v", it)
	}
	if err := os.Remove(config); err != nil {
		t.Fatal(err)
	}
	p, err := Find("deepseek")
	if err != nil || p.Key != "sk-explicit" || strings.Join(p.Models, ",") != "deepseek-chat,deepseek-reasoner,gpt-6-sol" {
		t.Fatalf("imported provider did not persist: %+v %v", p, err)
	}
	if p.Headers["X-Org"] != "abc" {
		t.Fatalf("Codex http_headers lost during import: got %q, want %q", p.Headers["X-Org"], "abc")
	}
	if p, err := Find("openrouter"); err != nil || p.Preset != "openrouter" || p.Headers["X-Org"] != "preset" {
		t.Fatalf("preset import lost its preset or headers: %+v %v", p, err)
	}
}

// One key for two Anthropic workspaces: the entry naming the other workspace
// is a provider of its own, still the preset's, under the next free id.
func TestImportPresetOtherHeaders(t *testing.T) {
	isolate(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)                                  // Windows
	t.Setenv("APPDATA", filepath.Join(home, "AppData", "Roaming")) // Windows: never the real Alma
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
	first, _ := FromPreset("anthropic")
	first.Key, first.Headers = "sk-ant", map[string]string{"anthropic-workspace-id": "ws1"}
	if err := Save(first); err != nil {
		t.Fatal(err)
	}
	cfg, _ := os.UserConfigDir()
	sqliteFixture(t, filepath.Join(cfg, "alma", "chat_threads.db"),
		`CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT, type TEXT, api_key TEXT, models TEXT, base_url TEXT, enabled INTEGER, created_at TEXT, api_format TEXT, is_response_api INTEGER, custom_headers TEXT)`,
		`INSERT INTO providers VALUES ('ws2','Anthropic','anthropic','sk-ant','[]',NULL,1,'2',NULL,0,'{"anthropic-workspace-id":"ws2"}')`,
	)
	same, _ := imported("Anthropic", "sk-ant", endpoints{anthropic: "https://api.anthropic.com"}, nil)
	same.Headers = map[string]string{"anthropic-workspace-id": " ws1 "}
	if it := settle([]AppImport{{Provider: same}}, load().Providers, map[string]bool{})[0]; it.Status != "same" {
		t.Fatalf("same key and headers should be the provider already here: %+v", it)
	}
	items := itemsOf(t, "alma")
	if it := items["ws2"]; it.Status != "taken" || it.KeyOf != "" || it.Provider.Preset != "anthropic" || it.Provider.Headers["anthropic-workspace-id"] != "ws2" {
		t.Fatalf("other workspace should be a provider of its own: %+v", it)
	}
	if added, err := ImportFromApps([]AppPick{{Source: "alma", Ref: "ws2"}}); err != nil || len(added) != 1 {
		t.Fatalf("import: %v %v", added, err)
	}
	p, err := Find("anthropic-2")
	if err != nil || p.Preset != "anthropic" || p.Headers["anthropic-workspace-id"] != "ws2" || p.Anthropic != "https://api.anthropic.com" || p.Name != "Anthropic 2" {
		t.Fatalf("second Anthropic: %+v %v", p, err)
	}
	if p, _ := Find("anthropic"); p.Headers["anthropic-workspace-id"] != "ws1" {
		t.Fatalf("first Anthropic changed: %+v", p)
	}
	if it := itemsOf(t, "alma")["ws2"]; it.Status != "same" {
		t.Fatalf("reimport: %+v", it)
	}
}

func TestImportHeadersDistinguishExistingProvider(t *testing.T) {
	existing := Provider{ID: "relay", Key: "sk-shared", Responses: "https://relay.example.com/v1"}
	incoming := existing
	incoming.Headers = map[string]string{"X-Org": "abc"}
	items := settle([]AppImport{{Provider: incoming}}, []Provider{existing}, map[string]bool{})
	if items[0].Status != "taken" || items[0].KeyOf != "" {
		t.Fatalf("provider with new headers should be importable separately: %+v", items[0])
	}
	existing.Headers = incoming.Headers
	incoming.Key = "sk-other"
	items = settle([]AppImport{{Provider: incoming}}, []Provider{existing}, map[string]bool{})
	if items[0].KeyOf != "relay" {
		t.Fatalf("provider with matching headers should accept another key: %+v", items[0])
	}
}

func TestCodexImportModelsSameBasename(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)                                  // Windows
	t.Setenv("APPDATA", filepath.Join(home, "AppData", "Roaming")) // Windows: never the real Alma
	config := filepath.Join(home, "other", "config.toml")
	models := []byte(`{"models":[{"slug":"custom-model","visibility":"list"}]}`)
	for _, path := range []string{
		filepath.Join(home, ".codex", "magpie-models.json"),
		filepath.Join(home, "other", "magpie-models.json"),
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, models, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if got := codexImportModels(config, "../.codex/magpie-models.json"); len(got) != 0 {
		t.Fatalf("magpie's own catalog was imported: %v", got)
	}
	if got := codexImportModels(config, "magpie-models.json"); len(got) != 1 || got[0] != "custom-model" {
		t.Fatalf("user catalog with the same basename was skipped: %v", got)
	}
}

func TestClaudeConfigDirImport(t *testing.T) {
	isolate(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)                                  // Windows
	t.Setenv("APPDATA", filepath.Join(home, "AppData", "Roaming")) // Windows: never the real Alma
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(home, "custom-claude"))
	path := claudeSettingsPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"env":{"ANTHROPIC_BASE_URL":"https://relay.example.com/anthropic","ANTHROPIC_AUTH_TOKEN":"sk-claude","ANTHROPIC_MODEL":"claude-sonnet-5"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	items := itemsOf(t, "claude-code")
	if items["settings"].Skip != "" || items["settings"].Provider.Key != "sk-claude" {
		t.Fatalf("Claude custom config dir: %+v", items)
	}
	// a settings.json a Windows tool saved with a UTF-8 BOM (#1534)
	if err := os.WriteFile(path, []byte("\xef\xbb\xbf{\r\n  \"env\": {\r\n    \"ANTHROPIC_BASE_URL\": \"https://relay.example.com/anthropic\",\r\n    \"ANTHROPIC_AUTH_TOKEN\": \"sk-bom\"\r\n  }\r\n}\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	items = itemsOf(t, "claude-code")
	if items["settings"].Skip != "" || items["settings"].Provider.Key != "sk-bom" {
		t.Fatalf("Claude settings.json with a BOM: %+v", items)
	}
}

func FromPresetKey(t *testing.T, id, key string) Provider {
	p, err := FromPreset(id)
	if err != nil {
		t.Fatalf("no preset %s", id)
	}
	p.Key = key
	return p
}

func TestImportAppsByName(t *testing.T) {
	for i := 1; i < len(appReaders); i++ {
		if strings.ToLower(appReaders[i-1].name) > strings.ToLower(appReaders[i].name) {
			t.Fatalf("%s listed before %s", appReaders[i-1].name, appReaders[i].name)
		}
	}
}

// An app with nothing to bring over lists no items, not null: the window
// reads each source's items.
func TestImportSourcesNeverNull(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)                                  // Windows
	t.Setenv("APPDATA", filepath.Join(home, "AppData", "Roaming")) // Windows: never the real Alma
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
	os.MkdirAll(filepath.Join(home, ".claude"), 0o755)
	os.WriteFile(filepath.Join(home, ".claude", "settings.json"), []byte(`{"model": "opus"}`), 0o644)
	for _, s := range ImportSources() {
		b, _ := json.Marshal(s)
		if s.Items == nil || strings.Contains(string(b), `"items":null`) {
			t.Fatalf("%s: items is null: %s", s.ID, b)
		}
	}
}

func TestSqlitePath(t *testing.T) {
	for in, want := range map[string]string{
		`C:/Users/me/.cc-switch/cc-switch.db`: "/C:/Users/me/.cc-switch/cc-switch.db",
		"/Users/me/.cc-switch/cc-switch.db":   "/Users/me/.cc-switch/cc-switch.db",
	} {
		if got := sqlitePath(in); got != want {
			t.Errorf("sqlitePath(%q) = %q, want %q", in, got, want)
		}
	}
}

// The same relay is often both a CC Switch entry and what Claude Code's
// settings.json points at. Picked together, it is added once; removed, it
// can be imported again rather than being "Already added" as the copy left
// behind (#1486, kk349958194).
func TestImportSameAccountFromTwoAppsOnce(t *testing.T) {
	isolate(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)                                  // Windows
	t.Setenv("APPDATA", filepath.Join(home, "AppData", "Roaming")) // Windows: never the real Alma
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(home, ".claude"))
	sqliteFixture(t, filepath.Join(home, ".cc-switch", "cc-switch.db"),
		`CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT, website_url TEXT, category TEXT, created_at INTEGER, sort_index INTEGER, PRIMARY KEY (id, app_type))`,
		`INSERT INTO providers VALUES ('relay','claude','Some Relay','{"env":{"ANTHROPIC_BASE_URL":"https://relay.example.com","ANTHROPIC_AUTH_TOKEN":"sk-relay","ANTHROPIC_MODEL":"claude-sonnet-5"}}','https://relay.example.com','custom',2,1)`,
	)
	if err := os.MkdirAll(filepath.Join(home, ".claude"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".claude", "settings.json"), []byte(`{"env":{"ANTHROPIC_BASE_URL":"https://relay.example.com","ANTHROPIC_AUTH_TOKEN":"sk-relay"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	// what the picker turns on by default: every new entry of every app
	var picks []AppPick
	for _, s := range ImportSources() {
		for _, it := range s.Items {
			if it.Skip == "" && it.Status == "new" {
				picks = append(picks, AppPick{Source: s.ID, Ref: it.Ref})
			}
		}
	}
	if len(picks) != 2 {
		t.Fatalf("picks: %+v", picks)
	}
	if _, err := ImportFromApps(picks); err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, p := range load().Providers {
		ids = append(ids, p.ID)
	}
	if len(ids) != 1 {
		t.Fatalf("the relay added %d times: %v", len(ids), ids)
	}
	if err := Delete(ids[0]); err != nil {
		t.Fatal(err)
	}
	if it := itemsOf(t, "cc-switch")["claude/relay"]; it.Status != "new" {
		t.Fatalf("after removing it: %+v", it)
	}
}

// CC Switch's config.json from before its database, saved with a UTF-8 BOM
// on Windows (#1534), is read through the mark.
func TestImportCCSwitchConfigWithBOM(t *testing.T) {
	isolate(t)
	path := filepath.Join(t.TempDir(), "config.json")
	cfg := "\xef\xbb\xbf{\r\n  \"claude\": {\r\n    \"providers\": {\r\n      \"relay\": {\r\n        \"name\": \"Some Relay\",\r\n        \"settingsConfig\": {\"env\": {\"ANTHROPIC_BASE_URL\": \"https://relay.example.com\", \"ANTHROPIC_AUTH_TOKEN\": \"sk-relay\"}}\r\n      }\r\n    }\r\n  }\r\n}\r\n"
	if err := os.WriteFile(path, []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	items, err := readCCSwitch(path)
	if err != nil || len(items) != 1 || items[0].Provider.Key != "sk-relay" {
		t.Fatalf("config.json with a BOM: %+v %v", items, err)
	}
}

// A provider's Gemini URL (#1346) names its host like its other endpoints
// do: the same key at that host is the provider already here, not another
// one to add beside it.
func TestGeminiURLIsItsHost(t *testing.T) {
	isolate(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))

	// a Gemini-protocol relay added from the editor is known by its
	// Gemini URL: the same key there again is the one already here
	first := Provider{Name: "Gemini Relay", Key: "sk-g", Gemini: "https://g.example.com"}
	if _, err := Add(first); err != nil {
		t.Fatal(err)
	}
	if id, err := Add(Provider{Name: "Gemini Relay", Key: "sk-g", Gemini: "https://g.example.com"}); err == nil {
		t.Fatalf("the same relay was added again as %q", id)
	}

	// an import entry at the relay over another protocol is the provider
	// already here at its Gemini URL, the same key in hand
	it := settle([]AppImport{{Ref: "r", Provider: Provider{
		ID: "gr", Name: "Gemini Relay", Key: "sk-g", Chat: "https://g.example.com/v1",
	}}}, All(), map[string]bool{})[0]
	if it.Status != "same" || it.Existing != "Gemini Relay" {
		t.Fatalf("the relay's import entry: %+v", it)
	}
}

// While magpie routes Claude Code, its settings.json points at the
// gateway and what the user had there stands by in the stash. The import
// reads the stash back as magpie stepping out would put it back: the
// tier and subagent models beside the endpoint, token and main model.
func TestClaudeImportWhileRoutedTakesTheStashedEnv(t *testing.T) {
	isolate(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("APPDATA", filepath.Join(home, "AppData", "Roaming"))
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
	t.Setenv("MAGPIE_ADDR", "127.0.0.1:49999")
	path := claudeSettingsPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	// routed: magpie wrote its own address and key over the user's relay
	if err := os.WriteFile(path, []byte(`{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:49999","ANTHROPIC_AUTH_TOKEN":"sk-magpie"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(Path()), 0o700); err != nil {
		t.Fatal(err)
	}
	stash := map[string]string{
		"claude.base_url":   "https://relay.example.com/anthropic",
		"claude.auth_token": "sk-claude",
		"claude.model":      "claude-sonnet-5",
		"claude.env.ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-5-x",
		"claude.env.ANTHROPIC_SMALL_FAST_MODEL":     "claude-haiku-x",
	}
	b, _ := json.Marshal(stash)
	if err := os.WriteFile(filepath.Join(filepath.Dir(Path()), "stash.json"), b, 0o600); err != nil {
		t.Fatal(err)
	}
	it := itemsOf(t, "claude-code")["settings"]
	if it.Skip != "" || it.Provider.Key != "sk-claude" {
		t.Fatalf("the relay in the stash: %+v", it)
	}
	for _, m := range []string{"claude-sonnet-5", "claude-sonnet-5-x", "claude-haiku-x"} {
		if !slices.Contains(it.Provider.Models, m) {
			t.Fatalf("models %v miss %s", it.Provider.Models, m)
		}
	}
}
