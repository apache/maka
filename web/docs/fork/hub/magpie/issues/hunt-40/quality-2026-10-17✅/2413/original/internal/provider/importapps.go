package provider

// Providers another app has already set up — CC Switch, Alma, Claude Code's
// own settings, OpenCode's sign-ins — offered for the user to bring over: each source is read
// (never written), every entry turned into the provider magpie would add,
// and matched against what is already here, so the picker can say which are
// new, which are already in, and which would take an id that is in use.
// Nothing is added until the user picks.

import (
	"cmp"
	"database/sql"
	"encoding/json"
	"errors"
	"io/fs"
	"maps"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/tidwall/jsonc"
	"github.com/yetone/magpie/internal/appdir"
	"github.com/yetone/magpie/internal/edit"
	"github.com/yetone/magpie/internal/plugin"
	"github.com/yetone/magpie/internal/settings"
	_ "github.com/yetone/magpie/internal/sqlitedb"
)

// AppSource is one app magpie can import from, with what it holds.
type AppSource struct {
	ID    string      `json:"id"`   // cc-switch, alma
	Name  string      `json:"name"` // as the app calls itself
	Path  string      `json:"path"` // the file read
	Found bool        `json:"found"`
	Error string      `json:"error,omitempty"`
	Items []AppImport `json:"items"`
}

// AppImport is one provider an app holds, as magpie would add it.
type AppImport struct {
	Ref      string   `json:"ref"`            // stable within its source
	From     string   `json:"from,omitempty"` // where in the app: Claude Code, Codex…
	Provider Provider `json:"provider"`
	// Status is "new", "same" (magpie has it already: same endpoint and
	// key) or "taken" (its id is another provider's here).
	Status   string `json:"status"`
	Existing string `json:"existing,omitempty"` // the magpie provider it matches or collides with
	// KeyOf is a magpie provider at the same address with another key:
	// this one can join it as one more key instead of being a provider
	// of its own.
	KeyOf string `json:"keyOf,omitempty"`
	// Reserved: its id is a subscription's (claude, workbuddy…), whose
	// name it happens to have. It can't replace that subscription, only
	// come in as a provider of its own beside it.
	Reserved bool   `json:"reserved,omitempty"`
	Off      string `json:"off,omitempty"`  // why it isn't picked by default
	Skip     string `json:"skip,omitempty"` // why it can't be imported at all
}

// AppPick is one entry the user chose, and how it comes in: as a provider
// ("add", beside any with its id), in place of the one with its id
// ("replace"), or as one more key of the provider KeyOf names ("key").
// Name is the name the user gave it in the picker, when its own collides
// with one magpie has (#1487); a renamed entry is added, never replaces.
type AppPick struct {
	Source string `json:"source"`
	Ref    string `json:"ref"`
	Mode   string `json:"mode,omitempty"`
	Name   string `json:"name,omitempty"`
}

// appReaders are the apps magpie knows, by name as the picker lists them.
// One asked is read only when the user opens the import, never by the
// Providers page's own look for configurations (DiscoverSources):
// OpenCode's auth.json holds every sign-in OpenCode has, not only keys.
var appReaders = []struct {
	id, name string
	path     func() string
	read     func(path string) ([]AppImport, error)
	asked    bool
}{
	{"alma", "Alma", almaPath, readAlma, false},
	{"cc-switch", "CC Switch", ccSwitchPath, readCCSwitch, false},
	{"claude-code", "Claude Code", claudeSettingsPath, readClaudeSettings, false},
	{"codex", "Codex", codexConfigPath, readCodexConfig, false},
	{"opencode", "OpenCode", openCodeAuthPath, readOpenCodeAuth, true},
}

// ImportSources reads every app magpie can import from, as the user asked.
func ImportSources() []AppSource { return importSources(true) }

// DiscoverSources reads the apps the Providers page looks in by itself:
// those not read only when asked.
func DiscoverSources() []AppSource { return importSources(false) }

func importSources(asked bool) []AppSource {
	have := load().Providers
	used := map[string]bool{} // ids across all sources, so two never collide
	var out []AppSource
	for _, r := range appReaders {
		if r.asked && !asked {
			continue
		}
		s := AppSource{ID: r.id, Name: r.name, Path: r.path(), Items: []AppImport{}}
		if _, err := os.Stat(s.Path); err == nil {
			s.Found = true
			items, err := r.read(s.Path)
			if err != nil {
				s.Error = err.Error()
			}
			s.Items = append(s.Items, settle(items, have, used)...) // [] rather than null when there is nothing
		} else if !errors.Is(err, fs.ErrNotExist) {
			// there, as far as anyone can tell, but not to be looked at: not
			// "not found", which would say the app has nothing
			s.Found, s.Error = true, err.Error()
		}
		out = append(out, s)
	}
	return out
}

// ImportFromApps adds what the user picked, reading the sources again so
// keys never pass through the window. It answers the names added.
func ImportFromApps(picks []AppPick) ([]string, error) {
	sources := map[string]AppSource{}
	for _, s := range ImportSources() {
		sources[s.ID] = s
	}
	var added []string
	for _, pk := range picks {
		var it *AppImport
		for i, x := range sources[pk.Source].Items {
			if x.Ref == pk.Ref {
				it = &sources[pk.Source].Items[i]
			}
		}
		if it == nil {
			return added, errorf("%s no longer has that provider; reopen the import", pk.Source)
		}
		if it.Skip != "" || it.Status == "same" {
			continue
		}
		p := it.Provider
		mode := pk.Mode
		if name := strings.TrimSpace(pk.Name); name != "" && name != p.Name {
			// renamed in the picker: its id follows the new name, unless it
			// is a preset's, which keeps the preset's id
			p.Name = name
			if p.Preset == "" {
				p.ID = cmp.Or(Slug(name), p.ID)
			}
			if mode != "key" {
				mode = "add"
			}
		}
		switch {
		case mode == "key" && it.KeyOf != "":
			h, err := Find(it.KeyOf)
			if err != nil {
				return added, errorf("%s: %v", p.Name, err)
			}
			if sameProvider(*h, p) {
				continue // picked twice, from two apps
			}
			// a key joins a provider only at its own address: one taken
			// to another host would be sent there
			if h.Account != nil || !sameProvider(Provider{Key: p.Key, Chat: h.Chat, Responses: h.Responses, Anthropic: h.Anthropic, Gemini: h.Gemini, Headers: h.Headers}, p) {
				return added, errorf("%s: %s isn't at %s; add it as a provider of its own", p.Name, h.Name, hostOf(firstURL(p)))
			}
			if err := AddKey(it.KeyOf, p.Name, p.Key, ""); err != nil {
				return added, errorf("%s: %v", p.Name, err)
			}
			added = append(added, p.Name+" ("+h.Name+")")
			continue
		case mode == "replace" && !reservedID(p.ID):
		case mode == "replace":
			// a subscription is never replaced by a provider of keys: its
			// sign-in would be lost, and Kiro's would take the key to its
			// own host
			return added, errorf("%s: %q is a subscription in magpie and can't be replaced; add it as a new provider", p.Name, p.ID)
		default:
			// an account a provider holds already is not added twice: the
			// same relay is often both a CC Switch entry and what Claude
			// Code's settings.json points at, and both are picked at once.
			// Two of it were added, and once one was removed the other made
			// the entry "Already added" (#1486)
			if holds(p) {
				continue
			}
			// the id may have been taken since, by an earlier pick
			if h, err := Find(p.ID); err == nil && sameProvider(*h, p) {
				continue
			}
			// a second one of a preset is still that preset's, under an id
			// of its own; one named as a subscription is (claude,
			// workbuddy) takes an id of its own too, whether or not that
			// subscription is signed in (#1487)
			p.ID = freeID(p.ID)
			p.Name = freeName(p.Name) // found by name too, so never two alike
		}
		if err := Save(p); err != nil {
			return added, errorf("%s: %v", p.Name, err)
		}
		added = append(added, p.Name)
	}
	return added, nil
}

// reservedID is an id no imported provider can have: the gateway's own, a
// subscription's or a plugin's, signed in or not.
func reservedID(id string) bool {
	if id == "magpie" || subscriptionID(id) {
		return true
	}
	_, ok := find(Accounts(), id)
	return ok
}

// holds says a provider of magpie's has p's account: its key at its
// address, as the import list's "same" says (settle).
func holds(p Provider) bool {
	for _, h := range load().Providers {
		if !h.Hidden && sameProvider(h, p) {
			return true
		}
	}
	return false
}

// freeID is id, or id-2, id-3… whichever no provider has.
func freeID(id string) string {
	taken := map[string]bool{"magpie": true}
	for _, id := range accountIDs {
		taken[id] = true
	}
	for _, pp := range plugin.Cached() { // signed in or not, as a built-in's
		taken[PluginID(pp.ID)] = true
	}
	for _, p := range All() {
		taken[p.ID] = true
	}
	for _, p := range load().Providers {
		taken[p.ID] = true
	}
	for n, try := 2, id; ; n++ {
		if !taken[try] {
			return try
		}
		try = id + "-" + itoa(n)
	}
}

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}

// settle gives each importable entry a unique id and says how it stands
// against the providers magpie has.
func settle(items []AppImport, have []Provider, used map[string]bool) []AppImport {
	for i := range items {
		it := &items[i]
		if it.Skip != "" {
			continue
		}
		p := &it.Provider
		if p.ID == "" || p.ID == "magpie" {
			p.ID = Slug(p.Name)
		}
		if p.ID == "" || p.ID == "magpie" {
			p.ID = "imported"
		}
		for base, n := p.ID, 2; used[p.ID]; n++ {
			p.ID = base + "-" + itoa(n)
		}
		used[p.ID] = true
		it.Status = "new"
		for _, h := range have {
			if h.Hidden {
				continue
			}
			if sameProvider(h, *p) {
				it.Status, it.Existing = "same", h.Name
				break
			}
			if h.ID == p.ID {
				it.Status, it.Existing = "taken", h.Name
			}
			if it.KeyOf == "" && h.Key != "" && sameProvider(Provider{
				Key: p.Key, Chat: h.Chat, Responses: h.Responses, Anthropic: h.Anthropic, Gemini: h.Gemini, Headers: h.Headers,
			}, *p) {
				it.KeyOf = h.ID
			}
		}
		if it.Status == "same" {
			it.KeyOf = ""
		} else if it.KeyOf != "" && it.Existing == "" {
			if h, err := Find(it.KeyOf); err == nil {
				it.Existing = h.Name
			}
		}
		if reservedID(p.ID) && it.Status != "same" {
			// named as a subscription: only ever added beside it (#1487)
			it.Status, it.Reserved = "taken", true
			if it.Existing == "" {
				it.Existing = p.ID
				if h, err := Find(p.ID); err == nil {
					it.Existing = h.Name
				}
			}
		}
	}
	// importable first, then by name; what can't be imported goes last
	sort.SliceStable(items, func(i, j int) bool { return (items[i].Skip == "") && (items[j].Skip != "") })
	return items
}

// sameProvider: the same key, host, and headers are the same account; a is
// the provider magpie has, which may hold the key among its others.
func sameProvider(a, b Provider) bool {
	if !maps.Equal(cleanHeaders(a.Headers), cleanHeaders(b.Headers)) {
		return false
	}
	has := a.Key == b.Key
	for _, k := range a.Keys {
		has = has || k.Key == b.Key
	}
	if !has {
		return false
	}
	hosts := map[string]bool{}
	for _, u := range []string{a.Chat, a.Responses, a.Anthropic, a.Gemini, a.Decide} {
		if h := hostOf(u); h != "" {
			hosts[h] = true
		}
	}
	for _, u := range []string{b.Chat, b.Responses, b.Anthropic, b.Gemini} {
		if hosts[hostOf(u)] {
			return true
		}
	}
	return false
}

func hostOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return strings.ToLower(u.Host)
}

// endpoints are the base URLs an entry names, by protocol.
type endpoints struct{ chat, responses, anthropic string }

// imported builds the provider for an entry: a preset's when the entry
// points at one magpie knows (its endpoints whole when the URL is the
// preset's own, only its name and logo when it is another path on the same
// host, like a coding plan), a custom one otherwise.
func imported(name, key string, e endpoints, models []string) (Provider, string) {
	e.chat, e.responses, e.anthropic = cleanBase(e.chat), cleanBase(e.responses), cleanBase(e.anthropic)
	for _, u := range []string{e.chat, e.responses, e.anthropic} {
		if u == "" {
			continue
		}
		pu, err := url.Parse(u)
		if err != nil || (pu.Scheme != "http" && pu.Scheme != "https") || pu.Host == "" || !strings.Contains(pu.Host, ".") && !strings.HasPrefix(pu.Host, "localhost") {
			return Provider{}, "its base URL isn't valid"
		}
		if gatewayURL(pu) {
			return Provider{}, "it points at magpie itself"
		}
	}
	if e.chat == "" && e.responses == "" && e.anthropic == "" {
		return Provider{}, "it has no base URL"
	}
	p := Provider{ID: Slug(name), Name: name, Key: key, Chat: e.chat, Responses: e.responses, Anthropic: e.anthropic, Models: models}
	if p.IsAzure() {
		// an Azure OpenAI resource, from any app: the preset's, its
		// endpoints on the resource's v1 API
		p = asAzure(p)
	} else if pr, r, exact := presetAt(e); pr != nil {
		p.ID, p.Icon, p.Catalog = pr.ID, pr.Icon, pr.Catalog
		if r != nil {
			p.Catalog = cmp.Or(r.Catalog, pr.Catalog)
		}
		if exact {
			p.Preset, p.Website, p.KeysURL = pr.ID, pr.Website, pr.KeysURL
			p.Chat, p.Responses, p.Anthropic = pr.Chat, pr.Responses, pr.Anthropic
			if r != nil {
				// at one of its regions: that region's endpoints and pages
				p.atRegionOf(pr, *r)
				p.Decide = ""
			}
			if n := strings.ToLower(name); n == "" || n == "default" {
				p.Name = pr.Name
			}
		}
	}
	if p.Key == "" && !keyOptional(p) {
		return Provider{}, "it has no API key"
	}
	return p, ""
}

func cleanBase(u string) string {
	u = strings.TrimRight(strings.TrimSpace(u), "/")
	if u != "" && !strings.Contains(u, "://") {
		u = "https://" + u
	}
	return u
}

// gatewayURL is magpie's own address, on the port it listens on now or
// the one Settings has: importing it would loop.
func gatewayURL(u *url.URL) bool {
	h := u.Hostname()
	if h != "127.0.0.1" && h != "localhost" {
		return false
	}
	for _, a := range []string{settings.GatewayAddr(), settings.SavedAddr()} {
		if _, p, err := net.SplitHostPort(a); err == nil && u.Port() == p {
			return true
		}
	}
	return false
}

// presetAt finds the preset serving an entry's host, the region of it the
// entry is at when it isn't the preset's own endpoints (Tencent Cloud's
// TokenHub), and whether the entry uses exactly those endpoints.
func presetAt(e endpoints) (*PresetDef, *Region, bool) {
	given := map[string]string{"chat": e.chat, "responses": e.responses, "anthropic": e.anthropic}
	// at endpoints own: whether the entry is at their host, and at them all
	at := func(chat, responses, anthropic string) (hit, exact bool) {
		own := map[string]string{"chat": chat, "responses": responses, "anthropic": anthropic}
		exact = true
		for k, u := range given {
			if u == "" {
				continue
			}
			if own[k] != "" && hostOf(own[k]) == hostOf(u) || hostOf(chat) == hostOf(u) || hostOf(anthropic) == hostOf(u) {
				hit = true
			}
			if !strings.EqualFold(own[k], u) {
				exact = false
			}
		}
		return hit, exact
	}
	// a preset whose endpoints the entry uses wins over an earlier one at
	// the same host: OpenCode Zen's are on opencode.ai beside OpenCode Go's
	var first *PresetDef
	var firstNear *Region
	for i := range presets {
		pr := &presets[i]
		if pr.Kind == KindLocal {
			continue
		}
		hit, exact := at(pr.Chat, pr.Responses, pr.Anthropic)
		if hit && exact {
			return pr, nil, true
		}
		var near *Region
		for j := range pr.Regions {
			r := &pr.Regions[j]
			if r.Chat == "" && r.Responses == "" && r.Anthropic == "" {
				continue
			}
			if hit, exact := at(r.Chat, r.Responses, r.Anthropic); exact && hit {
				return pr, r, true
			} else if hit && near == nil {
				near = r
			}
		}
		if first == nil && hit {
			first = pr
		} else if first == nil && near != nil {
			first, firstNear = pr, near
		}
	}
	return first, firstNear, false
}

// ---- CC Switch -------------------------------------------------------------

func ccSwitchPath() string {
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, ".cc-switch")
	if db := filepath.Join(dir, "cc-switch.db"); fileExists(db) {
		return db
	}
	if js := filepath.Join(dir, "config.json"); fileExists(js) {
		return js
	}
	return filepath.Join(dir, "cc-switch.db")
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func claudeSettingsPath() string {
	return filepath.Join(appdir.ClaudeDir(), "settings.json")
}

// readClaudeSettings is the relay Claude Code was pointed at in its own
// settings.json, before magpie: its base URL and token under env. While
// Claude Code goes through magpie those are in magpie's stash, to be put
// back when it leaves; the stash is read then.
func readClaudeSettings(path string) ([]AppImport, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var s map[string]any
	if err := json.Unmarshal(jsonc.ToJSON(edit.TrimBOM(raw)), &s); err != nil {
		return nil, errors.New("Claude Code's settings.json: " + err.Error())
	}
	env := mapOf(s["env"])
	if base, _ := env["ANTHROPIC_BASE_URL"].(string); base != "" {
		if u, err := url.Parse(cleanBase(base)); err == nil && gatewayURL(u) {
			var st map[string]string
			if b, err := os.ReadFile(filepath.Join(filepath.Dir(Path()), "stash.json")); err == nil {
				json.Unmarshal(b, &st)
			}
			// what routing put aside is what stepping out would put back:
			// the endpoint, token and main model, and with them the
			// models of the user's own the tiers and subagents ran on
			// (claude.env.<VAR>, internal/agent/claude.go)
			env = map[string]any{"ANTHROPIC_BASE_URL": st["claude.base_url"], "ANTHROPIC_AUTH_TOKEN": st["claude.auth_token"], "ANTHROPIC_MODEL": st["claude.model"]}
			for k, v := range st {
				if name, ok := strings.CutPrefix(k, "claude.env."); ok && v != "" {
					env[name] = v
				}
			}
		}
	}
	base, _ := env["ANTHROPIC_BASE_URL"].(string)
	if strings.TrimSpace(base) == "" {
		return nil, nil // Anthropic's own endpoint, the agent's sign-in
	}
	e := ccEntry{id: "settings", app: "claude", name: hostOf(cleanBase(base)), settings: map[string]any{"env": env}}
	it := AppImport{Ref: "settings", From: "settings.json"}
	name, key, eps, models, skip := ccSwitchEntry(e)
	if skip == "" {
		it.Provider, skip = imported(name, key, eps, models)
	}
	if skip != "" {
		it.Provider = Provider{Name: e.name}
		it.Skip = skip
	}
	return []AppImport{it}, nil
}

// ccSwitchApps names CC Switch's app types as the picker shows them.
var ccSwitchApps = map[string]string{
	"claude": "Claude Code", "claude-desktop": "Claude Desktop", "codex": "Codex",
	"gemini": "Gemini CLI", "opencode": "OpenCode", "openclaw": "OpenClaw", "pi": "Pi", "hermes": "Hermes",
}

type ccEntry struct {
	id, app, name, website, category string
	settings                         map[string]any
}

func readCCSwitch(path string) ([]AppImport, error) {
	var entries []ccEntry
	if strings.HasSuffix(path, ".db") {
		db, err := openReadOnly(path)
		if err != nil {
			return nil, err
		}
		defer db.Close()
		rows, err := db.Query(`SELECT id, app_type, name, settings_config, COALESCE(website_url,''), COALESCE(category,'') FROM providers ORDER BY app_type, COALESCE(sort_index, 0), created_at`)
		if err != nil {
			return nil, errors.New("CC Switch's database: " + err.Error())
		}
		defer rows.Close()
		for rows.Next() {
			var e ccEntry
			var raw string
			if rows.Scan(&e.id, &e.app, &e.name, &raw, &e.website, &e.category) != nil {
				continue
			}
			json.Unmarshal([]byte(raw), &e.settings)
			entries = append(entries, e)
		}
	} else {
		// CC Switch before its database: one config.json, a section per app
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		var cfg map[string]json.RawMessage
		if err := json.Unmarshal(jsonc.ToJSON(edit.TrimBOM(raw)), &cfg); err != nil {
			return nil, errors.New("CC Switch's config.json: " + err.Error())
		}
		for app, sec := range cfg {
			var s struct {
				Providers map[string]struct {
					Name     string         `json:"name"`
					Settings map[string]any `json:"settingsConfig"`
					Website  string         `json:"websiteUrl"`
					Category string         `json:"category"`
				} `json:"providers"`
			}
			if json.Unmarshal(sec, &s) != nil {
				continue
			}
			for id, p := range s.Providers {
				entries = append(entries, ccEntry{id: id, app: app, name: p.Name, website: p.Website, category: p.Category, settings: p.Settings})
			}
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].app+entries[i].id < entries[j].app+entries[j].id })
	}
	var out []AppImport
	for _, e := range entries {
		it := AppImport{Ref: e.app + "/" + e.id, From: ccSwitchApps[e.app]}
		if it.From == "" {
			it.From = e.app
		}
		name, key, eps, models, skip := ccSwitchEntry(e)
		if skip == "" {
			it.Provider, skip = imported(name, key, eps, models)
		}
		if skip != "" {
			it.Provider = Provider{Name: e.name}
			it.Skip = skip
		} else if w := cleanBase(e.website); strings.HasPrefix(w, "http") && it.Provider.Preset == "" {
			it.Provider.Website = w
		}
		out = append(out, merge(out, it)...)
	}
	return out, nil
}

// merge folds an entry into one already read for the same account — a
// relay set up for both Claude Code and Codex is one provider with two
// endpoints — or answers it to be added.
func merge(have []AppImport, it AppImport) []AppImport {
	if it.Skip != "" {
		return []AppImport{it}
	}
	for i := range have {
		h := &have[i].Provider
		if have[i].Skip != "" || h.Key != it.Provider.Key || h.Key == "" || !sameProvider(*h, it.Provider) && hostOf(firstURL(*h)) != hostOf(firstURL(it.Provider)) {
			continue
		}
		for _, f := range []struct{ dst, src *string }{{&h.Chat, &it.Provider.Chat}, {&h.Responses, &it.Provider.Responses}, {&h.Anthropic, &it.Provider.Anthropic}} {
			if *f.dst == "" {
				*f.dst = *f.src
			}
		}
		h.Models = append(h.Models, it.Provider.Models...)
		have[i].From += ", " + it.From
		return nil
	}
	return []AppImport{it}
}

func firstURL(p Provider) string {
	for _, u := range []string{p.Chat, p.Responses, p.Anthropic} {
		if u != "" {
			return u
		}
	}
	return ""
}

// ccSwitchEntry reads one CC Switch provider: its settings are the agent's
// own configuration, which differs per app.
func ccSwitchEntry(e ccEntry) (name, key string, eps endpoints, models []string, skip string) {
	s := e.settings
	name = strings.TrimSpace(e.name)
	env := mapOf(s["env"])
	str := func(m map[string]any, keys ...string) string {
		for _, k := range keys {
			if v, ok := m[k].(string); ok && strings.TrimSpace(v) != "" {
				return strings.TrimSpace(v)
			}
		}
		return ""
	}
	switch e.app {
	case "claude", "claude-desktop":
		base := str(env, "ANTHROPIC_BASE_URL")
		key = str(env, "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY")
		if base == "" && key == "" {
			return name, "", eps, nil, "it is the agent's own sign-in; add the subscription in magpie"
		}
		if base == "" {
			base = "https://api.anthropic.com"
		}
		eps.anthropic = base
		for _, k := range []string{"ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"} {
			if m := str(env, k); m != "" {
				models = append(models, m)
			}
		}
	case "codex":
		key = str(mapOf(s["auth"]), "OPENAI_API_KEY")
		cfg, _ := s["config"].(string)
		top, tables := parseTOML(cfg)
		mp := tables["model_providers."+top["model_provider"]]
		if top["model_provider"] != "" && mp == nil {
			mp = tables[`model_providers."`+top["model_provider"]+`"`]
		}
		base := mp["base_url"]
		if key == "" {
			key = mp["experimental_bearer_token"]
		}
		if base == "" && key == "" {
			return name, "", eps, nil, "it is the agent's own sign-in; add the subscription in magpie"
		}
		if base == "" {
			base = "https://api.openai.com/v1"
		}
		if mp["wire_api"] == "chat" {
			eps.chat = base
		} else {
			eps.responses = base
		}
		if m := top["model"]; m != "" {
			models = append(models, m)
		}
	case "gemini":
		key = str(env, "GEMINI_API_KEY", "GOOGLE_API_KEY")
		if str(env, "GOOGLE_GEMINI_BASE_URL") != "" {
			return name, "", eps, nil, "magpie doesn't talk the Gemini protocol to relays yet"
		}
		if key == "" {
			return name, "", eps, nil, "it is the agent's own sign-in"
		}
		pr := Preset("google")
		eps.chat, eps.responses, eps.anthropic = pr.Chat, pr.Responses, pr.Anthropic
		if m := str(env, "GEMINI_MODEL"); m != "" {
			models = append(models, m)
		}
	default:
		// OpenCode, OpenClaw, Pi…: a base URL and a key, with the API's
		// shape named by an api or npm field
		opts := mapOf(s["options"])
		base := str(s, "baseUrl", "baseURL", "base_url")
		if base == "" {
			base = str(opts, "baseURL", "baseUrl", "base_url")
		}
		key = str(s, "apiKey", "api_key")
		if key == "" {
			key = str(opts, "apiKey", "api_key")
		}
		if base == "" {
			return name, "", eps, nil, "it has no base URL"
		}
		switch api := strings.ToLower(str(s, "api", "npm", "type")); {
		case strings.Contains(api, "anthropic"):
			eps.anthropic = base
		case strings.Contains(api, "responses"):
			eps.responses = base
		default:
			eps.chat = base
		}
		switch ms := s["models"].(type) {
		case []any:
			for _, m := range ms {
				if id := str(mapOf(m), "id"); id != "" {
					models = append(models, id)
				} else if id, ok := m.(string); ok {
					models = append(models, id)
				}
			}
		case map[string]any:
			for id := range ms {
				models = append(models, id)
			}
			sort.Strings(models)
		}
	}
	return name, key, eps, models, ""
}

func mapOf(v any) map[string]any {
	m, _ := v.(map[string]any)
	if m == nil {
		return map[string]any{}
	}
	return m
}

// parseTOML reads the string values of a Codex config: top-level keys, and
// each table's keys under its header.
func parseTOML(s string) (map[string]string, map[string]map[string]string) {
	top, tables := map[string]string{}, map[string]map[string]string{}
	cur := top
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			name := strings.TrimSpace(strings.Trim(line, "[]"))
			cur = map[string]string{}
			tables[name] = cur
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		v = strings.TrimSpace(v)
		if i := strings.Index(v, " #"); i > 0 && !strings.HasPrefix(v, `"`) {
			v = strings.TrimSpace(v[:i])
		}
		if len(v) >= 2 && (v[0] == '"' || v[0] == '\'') {
			if end := strings.LastIndexByte(v, v[0]); end > 0 {
				v = v[1:end]
			}
		}
		cur[strings.Trim(strings.TrimSpace(k), `"`)] = v
	}
	return top, tables
}

// ---- Alma ------------------------------------------------------------------

func almaPath() string {
	dir, _ := os.UserConfigDir()
	return filepath.Join(dir, "alma", "chat_threads.db")
}

// almaPresets are Alma's built-in provider types by the preset they are.
var almaPresets = map[string]string{
	"openai": "openai", "anthropic": "anthropic", "google": "google", "deepseek": "deepseek",
	"openrouter": "openrouter", "moonshot": "moonshot", "xai": "xai", "mistral": "mistral",
	"groq": "groq", "aihubmix": "aihubmix", "together": "together", "fireworks": "fireworks",
	"siliconflow": "siliconflow", "ollama": "ollama", "lmstudio": "lmstudio", "opencode-go": "opencode-go",
}

// almaSignIns are Alma's types that are an app's own sign-in, not a key.
var almaSignIns = map[string]bool{
	"acp": true, "copilot": true, "claude-subscription": true, "codex-subscription": true,
	"gemini-cli": true, "antigravity": true, "cursor": true,
}

func readAlma(path string) ([]AppImport, error) {
	db, err := openReadOnly(path)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	rows, err := db.Query(`SELECT id, name, type, api_key, models, COALESCE(base_url,''), enabled, COALESCE(api_format,''), COALESCE(is_response_api,0), COALESCE(custom_headers,'') FROM providers ORDER BY created_at`)
	if err != nil {
		return nil, errors.New("Alma's database: " + err.Error())
	}
	defer rows.Close()
	var out []AppImport
	for rows.Next() {
		var id, name, typ, key, modelsJSON, base, format, headers string
		var enabled, responses bool
		if err := rows.Scan(&id, &name, &typ, &key, &modelsJSON, &base, &enabled, &format, &responses, &headers); err != nil {
			continue
		}
		it := AppImport{Ref: id}
		var models []string
		json.Unmarshal([]byte(modelsJSON), &models)
		var eps endpoints
		skip := ""
		switch {
		case almaSignIns[typ]:
			skip = "it is a sign-in, not a key; add the subscription in magpie"
		case typ == "azure":
			// the resource's endpoint (or only its name); one behind a
			// gateway of the user's is kept as it is, asked as Azure's
			if b, ok := AzureBase(base); ok {
				eps.chat = b
			} else if base != "" {
				eps.chat = base
			} else {
				skip = "it has no Azure OpenAI endpoint"
			}
		case base == "" && Preset(almaPresets[typ]) != nil:
			pr := Preset(almaPresets[typ])
			eps = endpoints{pr.Chat, pr.Responses, pr.Anthropic}
		case format == "anthropic" || typ == "anthropic":
			eps.anthropic = base
		case format == "gemini" || typ == "google" && base != "":
			skip = "magpie doesn't talk the Gemini protocol to relays yet"
		case responses || format == "openai-responses":
			eps.responses = base
		default:
			eps.chat = base
		}
		if skip == "" {
			it.Provider, skip = imported(name, key, eps, models)
			if skip == "" && typ == "azure" {
				it.Provider = asAzure(it.Provider)
			}
		}
		if skip != "" {
			it.Provider, it.Skip = Provider{Name: name}, skip
		} else {
			var hs map[string]string
			if json.Unmarshal([]byte(headers), &hs) == nil {
				it.Provider.Headers = hs
			}
			if !enabled {
				it.Off = "turned off in Alma"
			}
		}
		out = append(out, it)
	}
	return out, nil
}

// sqlitePath is a file's path as a SQLite URI wants it: slashed, and on
// Windows with a slash before the drive (file:///C:/…) — without it the
// drive letter is read as a host, and the open fails.
func sqlitePath(path string) string {
	p := filepath.ToSlash(path)
	if len(p) >= 2 && p[1] == ':' {
		p = "/" + p
	}
	return p
}

// openReadOnly opens another app's SQLite database without writing to it,
// waiting out the app's own writes.
func openReadOnly(path string) (*sql.DB, error) {
	u := url.URL{Scheme: "file", Path: sqlitePath(path), RawQuery: "mode=ro&_pragma=busy_timeout(3000)"}
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, err
	}
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, errors.New("can't open " + path + ": " + err.Error())
	}
	return db, nil
}

// OpenReadOnly opens another app's SQLite database without writing to it.
func OpenReadOnly(path string) (*sql.DB, error) { return openReadOnly(path) }

// CCSwitchSkillsDir is the folder CC Switch keeps the skills it installs in.
func CCSwitchSkillsDir() string { return filepath.Join(filepath.Dir(ccSwitchPath()), "skills") }

// CCSwitchSkillOrigin is the GitHub repository (owner/name) and branch CC
// Switch installed the skill in its folder dir from, as its database
// records it.
func CCSwitchSkillOrigin(dir string) (repo, branch string, ok bool) {
	p := ccSwitchPath()
	if filepath.Ext(p) != ".db" || !fileExists(p) {
		return "", "", false
	}
	db, err := openReadOnly(p)
	if err != nil {
		return "", "", false
	}
	defer db.Close()
	rows, err := db.Query(`SELECT directory, COALESCE(repo_owner,''), COALESCE(repo_name,''), COALESCE(repo_branch,'') FROM skills`)
	if err != nil {
		return "", "", false
	}
	defer rows.Close()
	for rows.Next() {
		var d, owner, name, ref string
		if rows.Scan(&d, &owner, &name, &ref) != nil || owner == "" || name == "" {
			continue
		}
		if d == dir || filepath.Base(filepath.FromSlash(d)) == dir {
			return owner + "/" + name, ref, true
		}
	}
	return "", "", false
}
