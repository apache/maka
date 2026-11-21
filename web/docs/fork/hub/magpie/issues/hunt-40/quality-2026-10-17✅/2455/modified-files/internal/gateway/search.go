package gateway

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/yetone/magpie/internal/catalog"
	"github.com/yetone/magpie/internal/gwtool"
	"github.com/yetone/magpie/internal/netproxy"
	"github.com/yetone/magpie/internal/provider"
	"github.com/yetone/magpie/internal/settings"
)

// A client may offer its model the web search of the vendor it was made
// for: Claude Code's WebSearch, Codex's web_search, a Chat client's
// web_search_options, Gemini's googleSearch. A provider that searches by
// itself is asked to; any other model is given a web_search tool of
// magpie's, which a model that can search — the Claude subscription, a
// Codex account, OpenAI, Anthropic's API, OpenRouter — answers for it, or,
// with none of them, a search API the user gave a key to (search_api.go).
// A Kimi Code plan searches for its own models first, with its search
// service (search_kimi.go).

// searchRounds is how many times a reply may go back to its model with
// what a search found.
const searchRounds = 6

// searchTimeout is how long a search's vendor has to answer; a model's
// search (modelSearch) has it from when its request went out, each try's
// own, and searchWaitMost in all, its waits for a slot or a resting
// provider with it (sideDeadline, #2318).
const searchTimeout, searchWaitMost = 2 * time.Minute, 5 * time.Minute

// searchingKey marks a search magpie asks for itself, which must not
// search by way of another model again.
type searchingKey struct{}

func searching(ctx context.Context) bool {
	v, _ := ctx.Value(searchingKey{}).(bool)
	return v
}

// searchForKey holds the request magpie's searches are run for, which the
// Routing view names by a search's row: magpie's own call, on the model it
// searches with, not the conversation's (#314).
type searchForKey struct{}

// CallFor is the request a call magpie made on its own was made for: its
// agent, and the model that agent asked for.
type CallFor struct {
	Agent string `json:"agent"`
	Model string `json:"model"`
	// Unknown, on an image's description, is that the model was counted
	// text-only because nothing magpie knows says whether it sees images
	// (blindTo), not because its list or the user says it takes text only.
	// The Routing view says which, so a user whose model does see knows
	// to say so (#1287).
	Unknown bool `json:"unknown,omitempty"`
	// Missing, on an image's description, is the Image recognition model
	// the user picked in Settings that magpie can't find any more: the
	// model that described is the one magpie picks in its place
	// (VisionMissing), and the Routing view names both.
	Missing string `json:"missing,omitempty"`
	// MCP, on a web search or an image's description, is that the agent
	// called magpie's MCP server (SearchMCPPath, VisionMCPPath) itself, for
	// no model of magpie's.
	MCP bool `json:"mcp,omitempty"`
	// Instead, on a web search, is the searcher asked first that failed
	// or found nothing (Why, NothingFound): the searcher that did search
	// was the next one magpie tried in its place, and the Routing view
	// says so. Picked is that the first was the one picked in Settings.
	// A fallback that said nothing read as magpie ignoring the pick
	// (Gearclickist on Discord: Grok picked, Codex's model searched).
	// NotSearched is that the first answered without searching at all
	// (errNotSearched), apart from searching and naming no page.
	Instead      string `json:"instead,omitempty"`
	Why          string `json:"why,omitempty"`
	NothingFound bool   `json:"nothingFound,omitempty"`
	NotSearched  bool   `json:"notSearched,omitempty"`
	Picked       bool   `json:"picked,omitempty"`
}

func searchFor(ctx context.Context) *CallFor {
	f, _ := ctx.Value(searchForKey{}).(*CallFor)
	return f
}

// searchesItself says whether the provider searches the web by itself when
// asked on this API.
func searchesItself(p provider.Provider, proto provider.Protocol) bool {
	// a relay said to search (#359), and a plugin whose config hook says
	// its upstream does (#2027), on an API it has an address for: one with
	// only a Chat address would be sent no search tool at all. Another
	// sign-in's Searches is never read.
	saidTo := p.Searches && (proto == provider.Anthropic || proto == provider.Responses) && p.Base(proto) != ""
	if p.Account != nil {
		// Grok by its id: moved to its plugin, its account is the plugin's;
		// its plugin beside the built-in (grok-plugin) by the plugin's id
		return (p.Account.Agent == "codex" || p.ID == "grok" || p.PluginProvider() == "grok") && proto == provider.Responses ||
			p.IsPlugin() && saidTo
	}
	if saidTo {
		return true
	}
	return slices.Contains(searchHosts[proto], provider.HostOf(p.Base(proto)))
}

// googleAccount is a Google sign-in, Gemini CLI's or Antigravity's, which
// asks Code Assist; a plugin's is left to the plugin.
func googleAccount(p provider.Provider) bool {
	return p.Account != nil && (p.Account.Agent == "gemini" || p.Account.Agent == "antigravity") && !p.IsPlugin()
}

// codeAssistSearches is whether model, on a Google sign-in, searches with
// Google by itself: Gemini runs googleSearch on Code Assist, but not beside
// function tools — Antigravity turns the two down together, 400 "Please
// enable tool_config.include_server_side_tool_invocations to use Built-in
// tools with Function calling", with that flag set in toolConfig too — so
// only a request that declares none (searchesFor). One that does is given
// magpie's search, which the account answers itself (ownSearcher, #757).
func codeAssistSearches(p provider.Provider, proto provider.Protocol, model string) bool {
	return proto == provider.CodeAssist && googleAccount(p) && searchModel(model)
}

// searchModel is a model Code Assist runs googleSearch for: Gemini's, not
// Claude's or GPT-OSS's on Antigravity, nor an image model.
func searchModel(model string) bool {
	l := strings.ToLower(model)
	return strings.Contains(l, "gemini") && !catalog.DrawsID(l)
}

// searchesFor is searchesItself for one request: a Google sign-in's Gemini
// searches by itself only for a request without function tools.
func searchesFor(p provider.Provider, proto provider.Protocol, model string, req *Request) bool {
	if searchesModel(p, proto, model) {
		return true
	}
	return codeAssistSearches(p, proto, model) && (len(req.Tools) == 0 || req.ToolChoice == "none")
}

// searchesModel is searchesItself for one model: a Remote magpie searches
// for the models its list says it does, on any API (search_remote.go).
func searchesModel(p provider.Provider, proto provider.Protocol, model string) bool {
	return searchesItself(p, proto) || proto != provider.Gemini && remoteSearch(p, model) != "" || modelSearches(p, proto, model)
}

// searchModels are the models a provider runs web_search for only for some
// of its models, by API: Command Code's Provider API passes the tool on to
// the model's vendor, and 12 of its 87 models search (M3chD09's run of all
// of them, #1590); the rest take the tool and don't search, or have it
// stripped, so they keep magpie's searcher. Its Claude models search on
// Messages only, the others on Responses only.
var searchModels = map[string]map[provider.Protocol][]string{
	"commandcode": {
		provider.Anthropic: {"claude-sonnet-5-5", "claude-haiku-5-5"},
		provider.Responses: {"gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-luna",
			"meta/muse-spark-1.2", "meta/muse-spark-1.2-contributor", "meta/muse-spark-1.3", "meta/muse-spark-1.3-contributor",
			"xai/grok-4.5", "xai/grok-4.6", "xai/grok-4.7"},
	},
}

// searchModelsHosts are searchModels' providers by host, for one added by
// hand rather than from the preset.
var searchModelsHosts = map[string]string{"api.commandcode.ai": "commandcode"}

// modelSearches is whether a provider of searchModels searches by itself
// for model on proto. Command Code refuses every built-in tool under its
// zero-data-retention header (x-cmd-zdr: cmd_zdr_unsupported_tool), so a
// provider sent that header searches for none.
func modelSearches(p provider.Provider, proto provider.Protocol, model string) bool {
	if p.Account != nil || p.Base(proto) == "" {
		return false
	}
	id := p.Preset
	if _, ok := searchModels[id]; !ok {
		id = searchModelsHosts[provider.HostOf(p.Base(proto))]
	}
	for k, v := range p.Headers {
		if strings.EqualFold(k, "x-cmd-zdr") && strings.TrimSpace(v) != "" && v != "0" {
			return false
		}
	}
	return slices.Contains(searchModels[id][proto], model)
}

// searchHosts are the APIs that search by themselves: OpenAI's, xAI's,
// DeepSeek's, Zhipu's and Z.ai's web_search tool (Zhipu's on its Responses
// API only, DeepSeek's on its Responses and Anthropic APIs: their Chat APIs
// have no such tool), Anthropic's web_search_20250305 (DeepSeek's Anthropic
// API runs it too, answering web_search_tool_result blocks, #669),
// OpenRouter's web plugin, Gemini's googleSearch.
var searchHosts = map[provider.Protocol][]string{
	provider.Responses: {"api.openai.com", "api.x.ai", "api.deepseek.com", "open.bigmodel.cn", "api.z.ai"},
	provider.Anthropic: {"api.anthropic.com", "api.deepseek.com"},
	provider.Chat:      {"openrouter.ai"},
	provider.Gemini:    {"generativelanguage.googleapis.com"},
}

// searchAsked is whether a body offers the model web search, looked for
// cheaply before it is parsed.
func searchAsked(proto provider.Protocol, body []byte) bool {
	if !strings.Contains(string(body), "web_search") && !strings.Contains(string(body), "oogle_search") && !strings.Contains(string(body), "googleSearch") {
		return false
	}
	req, err := parse(proto, body)
	return err == nil && req.WebSearch
}

// searcher is the model magpie searches with: the one Settings names, while
// it can (chosenSearcher), else the first of the providers that search by
// themselves, with a small model of theirs, as searching needs no more.
// An explicit "off" leaves only the search APIs.
func searcher() (provider.Provider, string, bool) {
	if settings.Load().Searcher == "off" {
		return provider.Provider{}, "", false
	}
	if p, m, why := chosenSearcher(); why == "" && p != nil {
		return *p, m, true
	}
	return autoSearcher()
}

// searchRank is where a provider comes among those that can search for a
// model that can't, -1 when it can't. A relay said to search is left out:
// it would spend the relay's quota on other models' searches, and one that
// serves only Claude Code refuses magpie's own request, which has no
// metadata.user_id (#359).
func searchRank(p provider.Provider) int {
	p.Searches = false
	switch {
	case p.Account != nil && p.Account.Agent == "claude":
		return 0
	case p.Account != nil && p.Account.Agent == "codex":
		return 1
	case searchesItself(p, provider.Anthropic):
		return 2
	case searchesItself(p, provider.Responses):
		return 3
	case searchesItself(p, provider.Chat):
		return 4
	case googleAccount(p):
		// Gemini on a Google sign-in, by googleSearch (#757)
		return 5
	case remoteSearchesAny(p):
		// another magpie, with the models it searches natively for
		return 5
	}
	return -1
}

// manualRelayRank is after every provider magpie picks or falls back to by
// itself: a relay said to search is offered only to be named (#359).
const manualRelayRank = 6

// namedSearcherRank is searchRank as Settings may name it: a Kimi Code
// plan, by its search service, and a relay said to search on Anthropic's or
// Responses' API come last, and only by hand.
func namedSearcherRank(p provider.Provider) (int, bool) {
	if r := searchRank(p); r >= 0 {
		return r, false
	}
	if provider.KimiCodeSearch(p) != "" {
		return manualRelayRank, true
	}
	if p.Searches && (searchesItself(p, provider.Anthropic) || searchesItself(p, provider.Responses)) {
		return manualRelayRank, true
	}
	return -1, false
}

// autoSearcher is the searcher magpie picks by itself: the first by
// searchRank that is on, with its small model. One with allowance left
// goes before one whose every account or key is out of it (smallReady),
// which is picked only when every searcher is, so that magpie still
// offers its search (canSearch) (#1801).
func autoSearcher() (provider.Provider, string, bool) {
	p, m, _, ok := autoSearcherReady()
	return p, m, ok
}

// autoSearcherReady is autoSearcher, and whether its pick has allowance
// left.
func autoSearcherReady() (provider.Provider, string, bool, bool) {
	var best provider.Provider
	var model string
	top, bestReady := -1, false
	for _, p := range provider.All() {
		r := searchRank(p)
		if r < 0 || !p.On() || (bestReady && r >= top) {
			continue
		}
		m, ready := searcherReady(p)
		if m == "" || top >= 0 && (bestReady && !ready || ready == bestReady && r >= top) {
			continue
		}
		best, model, top, bestReady = p, m, r, ready
	}
	return best, model, bestReady, top >= 0
}

// Why the searcher Settings names isn't used, and magpie picks one itself.
const (
	SearcherGone   = "gone"    // no such provider any more
	SearcherOff    = "off"     // turned off, or signed out
	SearcherCant   = "cant"    // it can't search the web by itself
	SearcherNoneOf = "nomodel" // it lists no model to search with
)

// chosenSearcher is the provider and model Settings' Searcher names
// ("<provider>" for its small model, or "<provider>/<model>"), and why it
// can't be used, "" when it can. A model it no longer lists gives way to
// its small model, as when none is named. Nil when none is named or
// provider search is explicitly off.
func chosenSearcher() (*provider.Provider, string, string) {
	v := strings.TrimSpace(settings.Load().Searcher)
	if v == "" || v == "off" {
		return nil, "", ""
	}
	id, model, _ := strings.Cut(v, "/")
	i := slices.IndexFunc(provider.All(), func(p provider.Provider) bool { return p.ID == id })
	if i < 0 {
		return nil, "", SearcherGone
	}
	p := provider.All()[i]
	r, _ := namedSearcherRank(p)
	switch {
	case !p.On():
		return &p, "", SearcherOff
	case r < 0:
		return &p, "", SearcherCant
	case provider.KimiCodeSearch(p) != "":
		// it searches with no model
		return &p, "", ""
	}
	if model != "" && slices.ContainsFunc(p.Available(), func(m catalog.Model) bool { return m.ID == model }) && searchableModel(p, model) {
		return &p, model, ""
	}
	if m := searcherModel(p); m != "" {
		return &p, m, ""
	}
	if ms := p.Exposed(); len(ms) > 0 {
		return &p, ms[0].ID, ""
	}
	return &p, "", SearcherNoneOf
}

// Searchers are the providers Settings' Searcher may name: those magpie
// would pick, then relays said to search, each with the model it would
// search with.
func Searchers() []SearcherChoice {
	var out []SearcherChoice
	for _, p := range provider.All() {
		r, manualOnly := namedSearcherRank(p)
		if r < 0 || !p.On() {
			continue
		}
		if provider.KimiCodeSearch(p) != "" {
			out = append(out, SearcherChoice{Provider: p, rank: r, ManualOnly: manualOnly, Service: true})
			continue
		}
		var ms []catalog.Model
		for _, m := range p.Available() {
			if !strings.HasPrefix(m.ID, provider.GroupPrefix) && searchableModel(p, m.ID) {
				ms = append(ms, m)
			}
		}
		if len(ms) == 0 {
			continue
		}
		out = append(out, SearcherChoice{Provider: p, Small: searcherModel(p), Models: ms, rank: r, ManualOnly: manualOnly, Own: googleAccount(p)})
	}
	slices.SortStableFunc(out, func(a, b SearcherChoice) int { return cmp.Compare(a.rank, b.rank) })
	return out
}

// SearcherChoice is a provider Settings' Searcher may name.
type SearcherChoice struct {
	Provider   provider.Provider
	Small      string // the model it searches with when none is named
	Models     []catalog.Model
	rank       int
	ManualOnly bool // a relay said to search, which only Settings may name
	// Service is a Kimi Code plan, which searches by its search service,
	// with no model (and no Small or Models)
	Service bool
	// Own is a Google sign-in, whose Gemini searches for the provider's
	// own models first, whoever is named (ownSearcher)
	Own bool
}

// RelaysSaidToSearch are the providers on that are said to search by
// themselves but are not asked for another model unless Settings names them
// (#359).
func RelaysSaidToSearch() []provider.Provider {
	var out []provider.Provider
	for _, p := range provider.All() {
		if p.Searches && p.On() && searchRank(p) < 0 {
			out = append(out, p)
		}
	}
	return out
}

// smallModel is the provider's cheapest small model of a vendor that
// searches well, or its cheapest, or its first; only among those keep
// holds, when it is given. Only a model the user enabled is picked (what
// agents are offered, Exposed), never one of the rest of the vendor's
// list: OpenRouter turned away an unpicked anthropic/claude-haiku-5.5 for
// the user's region (JonahFu on X).
func smallModel(p provider.Provider, keep func(catalog.Model) bool) string {
	id, _ := smallReady(p, keep, provider.Chat)
	return id
}

// smallReady is smallModel of the models routing would still find an
// account or key with allowance for, asked on from (spentModel), and
// ready true; else smallModel of them all, and ready false. A model out
// of its allowance is only picked when every other is (#1801: Image
// recognition kept describing with an account out of its allowance, each
// image refused 429).
func smallReady(p provider.Provider, keep func(catalog.Model) bool, from provider.Protocol) (string, bool) {
	var ms []catalog.Model
	for _, m := range p.Exposed() {
		if keep != nil && !keep(m) {
			continue
		}
		l := strings.ToLower(m.ID)
		// a subscription's list can have what magpie wrote into its agent
		if strings.HasPrefix(m.ID, provider.GroupPrefix) || (p.Account != nil && strings.Contains(m.ID, "/")) ||
			strings.ContainsAny(l, ":~") || slices.ContainsFunc([]string{"nano", "lite", "image", "audio", "tts", "embed", "free"}, func(w string) bool { return strings.Contains(l, w) }) {
			continue
		}
		ms = append(ms, m)
	}
	now := time.Now()
	ready := slices.DeleteFunc(slices.Clone(ms), func(m catalog.Model) bool {
		_, spent := spentModel(p, m.ID, from, now)
		return spent
	})
	if id := pickSmall(ready); id != "" {
		return id, true
	}
	return pickSmall(ms), false
}

// pickSmall is smallModel's pick of ms.
func pickSmall(ms []catalog.Model) string {
	// on a router, a model of the big vendors
	if big := slices.DeleteFunc(slices.Clone(ms), func(m catalog.Model) bool {
		v, _, ok := strings.Cut(m.ID, "/")
		return ok && !slices.Contains([]string{"anthropic", "openai", "google", "x-ai"}, v)
	}); len(big) > 0 {
		ms = big
	}
	cost := func(m catalog.Model) float64 {
		if m.Price == nil {
			return 1e9
		}
		return m.Price.Input + m.Price.Output
	}
	cheapest := func(ms []catalog.Model) string {
		if len(ms) == 0 {
			return ""
		}
		return slices.MinFunc(ms, func(a, b catalog.Model) int { return cmp.Compare(cost(a), cost(b)) }).ID
	}
	small := slices.DeleteFunc(slices.Clone(ms), func(m catalog.Model) bool {
		// "gemini" has a "mini" in it, which made every Gemini small and
		// the first of them, a Pro, the one picked (#757)
		l := strings.ReplaceAll(strings.ToLower(m.ID), "gemini", "")
		return !strings.Contains(l, "haiku") && !strings.Contains(l, "mini") && !strings.Contains(l, "flash")
	})
	if id := cheapest(small); id != "" {
		return id
	}
	return cheapest(ms)
}

// searcherModel is the model p searches with when none is named: its
// small model, of those it can search with.
func searcherModel(p provider.Provider) string {
	m, _ := searcherReady(p)
	return m
}

// searcherReady is searcherModel, and whether it has allowance left
// (smallReady).
func searcherReady(p provider.Provider) (string, bool) {
	if googleAccount(p) || p.IsRemoteMagpie() {
		return smallReady(p, func(m catalog.Model) bool { return searchableModel(p, m.ID) }, provider.Anthropic)
	}
	return smallReady(p, nil, provider.Anthropic)
}

// searchTool is the tool a model that can't search is given, under a name
// the client's own tools leave free.
func searchTool(tools []Tool) Tool {
	name := "web_search"
	for slices.ContainsFunc(tools, func(t Tool) bool { return t.Name == name }) {
		name = "magpie_" + name
	}
	return Tool{Name: name,
		Description: "Search the web for current information: news, releases, documentation, prices, anything after your training or that you are unsure of. Returns what the pages found say, with their URLs. Cite the URLs you use.",
		Schema:      json.RawMessage(`{"type":"object","properties":{"query":{"type":"string","description":"What to search for"}},"required":["query"]}`)}
}

const searchSystem = "You are a web search tool. Search the web for what is asked and report what the results say: the facts that answer it, as specifically as they are given (numbers, dates, versions, names), each with the title and URL of its page. Report only what the pages say; don't answer from memory, don't add advice. Be concise."

// webSearch searches the web and says what it found, and on which pages:
// for a model of a Kimi Code plan, with the plan's search service first;
// then with the searcher's model, or, without one or when it fails, with
// the search APIs the user set up (#419). Settings can put the search APIs
// first (#928): the providers then search only when none of them answers.
// With provider search off, only the search APIs are asked.
func (s *Server) webSearch(ctx context.Context, query string) (string, []Hit, error) {
	// a search is magpie's own request, not the turn's provider's: the
	// search APIs go through the global proxy and each searcher through
	// its own (Provider.Via), never through the proxy the turn's provider
	// is set to (#1522: Codex asked while a "direct" provider served the
	// turn dialed chatgpt.com directly)
	ctx = netproxy.With(ctx, "")
	if !searchServed() {
		return "", nil, errSearchOff
	}
	if settings.Load().Searcher == "off" {
		if len(provider.SearchAPIs()) == 0 {
			return "", nil, errNoSearcher
		}
		return s.apiSearch(ctx, query)
	}
	var errs []error
	apiFirst := settings.Load().SearchFirst == settings.SearchFirstAPI && len(provider.SearchAPIs()) > 0
	if apiFirst {
		said, hits, err := s.apiSearch(ctx, query)
		if err == nil {
			return said, hits, nil
		}
		errs = append(errs, err)
	}
	if p, ok := ownSearcher(ctx); ok {
		said, hits, err := s.ownSearch(ctx, p, query)
		if err == nil {
			return said, hits, nil
		}
		errs = append(errs, err)
	}
	said, hits, err := s.modelSearch(ctx, query)
	if err == nil {
		return said, hits, nil
	}
	apis := len(provider.SearchAPIs()) > 0
	// that no provider searches is news only when nothing else was tried
	if !errors.Is(err, errNoSearcher) || len(errs) == 0 && !apis {
		errs = append(errs, err)
	}
	if !apis || apiFirst {
		return "", nil, errors.Join(errs...)
	}
	said, hits, err = s.apiSearch(ctx, query)
	if err != nil {
		return "", nil, errors.Join(append(errs, err)...)
	}
	return said, hits, nil
}

var errNoSearcher = errors.New("no provider that can search the web, nor a search API, is set up in magpie")

// errSearchOff is a search asked of magpie while plugins/search is off.
var errSearchOff = errors.New("magpie's web search is off: turn the Web search plugin on in magpie's Settings → Plugins")

// searchServed is whether plugins/search serves magpie's web search here
// (the gateway's tool point, gwtool): off, magpie neither offers its
// web_search nor answers one, and a vendor that searches by itself still
// does.
func searchServed() bool { return gwtool.Served(gwtool.WebSearch) }

// searchersInTurn is how many searchers a search is asked of, in turn,
// before it goes to the search APIs.
const searchersInTurn = 3

// modelSearch searches the web with the searcher's model; one magpie
// picked that fails or finds nothing gives way to the next searcher magpie
// would pick, all of them within searchWaitMost. One Settings names gives
// way to none: the search APIs, when set up, search in its place
// (webSearch), and Settings says it didn't search (SearcherFailed). Handed
// on, a search for Grok, picked, went to Codex's gpt-6-astra, a pricier
// model the user hadn't picked, on every search (Gearclickist on Discord).
func (s *Server) modelSearch(ctx context.Context, query string) (string, []Hit, error) {
	p, model, ok := searcher()
	if !ok {
		return "", nil, errNoSearcher
	}
	ctx, cancel := sideDeadline(context.WithValue(ctx, searchingKey{}, true), "search", searchTimeout, searchWaitMost)
	defer cancel()
	type pick struct{ id, model string }
	tried := []pick{{p.ID, model}}
	var said string
	var hits []Hit
	// one magpie picked that is out of its allowance isn't asked: it
	// would only be refused again (#1801); one the Settings name is
	err := searcherSpent(p, model)
	cp, _, why := chosenSearcher()
	named := why == "" && cp != nil && cp.ID == p.ID
	if named {
		err = nil
	}
	if err == nil {
		said, hits, err = s.searchBy(ctx, p, model, query, searchEffort(p, model))
	}
	if named {
		// a search the agent stopped waiting for is no failure of its
		if !errors.Is(ctx.Err(), context.Canceled) {
			namedFailed(p, model, err)
		}
		if err != nil {
			return "", nil, fmt.Errorf("%w (the searcher picked in Settings › Web search: no other provider searches in its place)", err)
		}
		return said, hits, nil
	}
	// the others in turn, those with allowance left first
	var turn, spent []SearcherChoice
	for _, c := range Searchers() {
		if c.ManualOnly || c.Small == "" {
			continue
		}
		if searcherSpent(c.Provider, c.Small) != nil {
			spent = append(spent, c)
		} else {
			turn = append(turn, c)
		}
	}
	for _, c := range append(turn, spent...) {
		if err == nil || ctx.Err() != nil || len(tried) >= searchersInTurn {
			break
		}
		if slices.ContainsFunc(tried, func(t pick) bool { return t.id == c.Provider.ID }) {
			continue
		}
		if len(tried) == 1 {
			ctx = searchingInstead(ctx, p, model, err)
		}
		tried = append(tried, pick{c.Provider.ID, c.Small})
		next := searcherSpent(c.Provider, c.Small)
		if next == nil {
			said, hits, next = s.searchWith(ctx, c.Provider, c.Small, query, searchEffort(c.Provider, c.Small))
		}
		if next != nil {
			err = errors.Join(err, next)
		} else {
			err = nil
		}
	}
	return said, hits, err
}

// lastNamedFail is the last search the searcher Settings names didn't
// make, for Settings to say (SearcherFailed); cleared when it searches.
var lastNamedFail struct {
	sync.Mutex
	f SearchFailure
}

// SearchFailure is a search the searcher Settings names didn't make: why,
// and when.
type SearchFailure struct {
	Searcher     string // "<provider>/<model>", or "<provider>"
	Why          string // the error, when it neither found nothing nor didn't search
	NothingFound bool   // it searched and named no page
	NotSearched  bool   // it answered without searching (errNotSearched)
	At           time.Time
}

func namedFailed(p provider.Provider, model string, err error) {
	name := p.ID
	if model != "" {
		name += "/" + model
	}
	lastNamedFail.Lock()
	defer lastNamedFail.Unlock()
	if err == nil {
		if lastNamedFail.f.Searcher == name {
			lastNamedFail.f = SearchFailure{}
		}
		return
	}
	f := SearchFailure{Searcher: name, At: time.Now(), NotSearched: errors.Is(err, errNotSearched)}
	f.NothingFound = !f.NotSearched && errors.Is(err, errFoundNothing)
	if !f.NothingFound && !f.NotSearched {
		f.Why = strings.TrimPrefix(err.Error(), name+": ")
	}
	lastNamedFail.f = f
}

// SearcherFailed is the last search the searcher Settings names now didn't
// make, since it last searched; ok false when there is none.
func SearcherFailed() (SearchFailure, bool) {
	p, m, why := chosenSearcher()
	if p == nil || why != "" {
		return SearchFailure{}, false
	}
	name := p.ID
	if m != "" {
		name += "/" + m
	}
	lastNamedFail.Lock()
	defer lastNamedFail.Unlock()
	f := lastNamedFail.f
	return f, f.Searcher != "" && f.Searcher == name
}

// searcherSpent is why a searcher's model isn't asked: every account or
// key of it is out of its allowance (spentModel). nil when it has
// allowance, or searches with no model (a Kimi Code plan's service).
func searcherSpent(p provider.Provider, model string) error {
	if model == "" || provider.KimiCodeSearch(p) != "" {
		return nil
	}
	back, spent := spentModel(p, model, provider.Anthropic, time.Now())
	if !spent {
		return nil
	}
	when := ""
	if !back.IsZero() {
		when = " until " + heldClock(back, time.Now())
	}
	return fmt.Errorf("%s/%s: out of its allowance%s, not asked", p.ID, model, when)
}

// searchingInstead is ctx with its web search's CallFor saying that the
// searcher asked first, p's model, failed with err, so the searches made
// with ctx are in its place.
func searchingInstead(ctx context.Context, p provider.Provider, model string, err error) context.Context {
	f := searchFor(ctx)
	if f == nil {
		f = &CallFor{}
	}
	g := *f
	g.Instead = p.ID
	if model != "" {
		g.Instead += "/" + model
	}
	g.Picked = false
	if c, _, why := chosenSearcher(); why == "" && c != nil && c.ID == p.ID {
		g.Picked = true
	}
	g.NotSearched = errors.Is(err, errNotSearched)
	g.NothingFound = !g.NotSearched && errors.Is(err, errFoundNothing)
	g.Why = ""
	if !g.NothingFound && !g.NotSearched {
		g.Why = strings.TrimPrefix(err.Error(), g.Instead+": ")
	}
	return context.WithValue(ctx, searchForKey{}, &g)
}

// errFoundNothing is a searcher's reply that names no page it found.
var errFoundNothing = errors.New("found nothing")

// errNotSearched is a searcher's reply with no search in it at all: the
// vendor ran no search, the tool dropped or left unused, and the model
// answered from what it knew (Gearclickist on Discord: grok-4.7 answered
// in 1.4k tokens, the size of a request with no search tool, where one
// that searched took 6k-66k). It is found nothing too.
var errNotSearched = fmt.Errorf("answered without searching the web: %w", errFoundNothing)

// searchWith asks one searcher's model to search: what it said, with the
// pages its searches found. A reply with no page found and no address in
// what it says found nothing: the model answered without searching (#669:
// DeepSeek on its Chat API, which has no search tool, said it couldn't, or
// wrote its own tool-call markup as text).
//
// effort is the level its model is asked to think at, "" for none sent:
// the searcher's is picked in Settings (searchEffort), and a provider
// searching for its own models is sent none.
func (s *Server) searchWith(ctx context.Context, p provider.Provider, model, query, effort string) (string, []Hit, error) {
	body, _ := json.Marshal(searchBody(p, model, query, effort))
	r, err := http.NewRequestWithContext(magpieChose(ctx), http.MethodPost, "http://magpie/v1/messages", nil)
	if err != nil {
		return "", nil, err
	}
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("User-Agent", SearchAgent)
	w := httptest.NewRecorder()
	s.serve(w, r, provider.Anthropic, body)
	var out struct {
		Content []struct {
			Type    string          `json:"type"`
			Text    string          `json:"text"`
			Content json.RawMessage `json:"content"`
		} `json:"content"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || w.Code >= 300 || out.Error != nil {
		msg := http.StatusText(w.Code)
		if out.Error != nil && out.Error.Message != "" {
			msg = out.Error.Message
		}
		if t, ok := sideTimeout(ctx); ok {
			msg = t.Error()
		}
		return "", nil, fmt.Errorf("%s/%s: %s", p.ID, model, msg)
	}
	var text strings.Builder
	var sources []string
	var found []Hit
	searched := false
	for _, b := range out.Content {
		switch b.Type {
		case "text":
			text.WriteString(b.Text)
		case "server_tool_use":
			searched = true
		case "web_search_tool_result":
			searched = true
			// each result read on its own, its title, address and age
			// only: a vendor's encrypted_content is for that vendor, and
			// an error ({"type":"web_search_tool_result_error"}) has none
			var results []json.RawMessage
			json.Unmarshal(b.Content, &results)
			for _, raw := range results {
				var h struct {
					Title   string `json:"title"`
					URL     string `json:"url"`
					PageAge any    `json:"page_age"`
				}
				if json.Unmarshal(raw, &h) != nil || h.URL == "" {
					continue
				}
				age, _ := h.PageAge.(string)
				sources = append(sources, "- "+h.Title+" — "+h.URL)
				found = append(found, Hit{Title: h.Title, URL: h.URL, PageAge: age})
			}
		}
	}
	said := strings.TrimSpace(text.String())
	if said == "" || (len(found) == 0 && !strings.Contains(said, "://")) {
		if !searched {
			return "", nil, fmt.Errorf("%s/%s %w", p.ID, model, errNotSearched)
		}
		return "", nil, fmt.Errorf("%s/%s %w", p.ID, model, errFoundNothing)
	}
	if len(sources) > 0 && len(sources) <= 20 {
		said += "\n\nSources:\n" + strings.Join(sources, "\n")
	}
	return said, found, nil
}

// searchBody is the Anthropic Messages request the searcher's model is
// asked to search with. A level of reasoning is asked as Claude Code asks
// it, a thinking budget with output_config.effort beside it, which the
// gateway fits to the vendor the model is on: adaptive thinking for a
// Claude that takes only that (adaptiveThinking), reasoning_effort, a
// Gemini thinking level. A Claude before adaptive thinking is sent the
// budget alone, as output_config.effort isn't its; "none" turns thinking
// off.
func searchBody(p provider.Provider, model, query, effort string) map[string]any {
	q := map[string]any{
		"model": p.ID + "/" + model, "max_tokens": replyRoom(4096, effort), "stream": false, "system": searchSystem,
		"messages": []map[string]any{{"role": "user", "content": "Search the web for: " + query}},
		"tools":    []map[string]any{{"type": "web_search_20250305", "name": "web_search", "max_uses": 3}},
	}
	switch effort {
	case "":
	case "none":
		q["thinking"] = map[string]any{"type": "disabled"}
	default:
		budget := 1024 // Anthropic's least
		if effort != "minimal" {
			budget = budgetOf(effortOf(effort))
		}
		q["thinking"] = map[string]any{"type": "enabled", "budget_tokens": budget}
		vendor := model
		if _, m, ok := provider.Resolve(p.ID + "/" + model); ok {
			vendor = m
		}
		if _, _, claude := claudeVersionOf(vendor); !claude || adaptiveOnly(vendor) {
			q["output_config"] = map[string]any{"effort": effort}
		}
	}
	return q
}

// SearchAgent is the User-Agent of the searches magpie makes for a model.
const SearchAgent = "magpie-search/1"

// round asks the model once and gives its reply's events, or the status
// and message of a failure.
type round func(ctx context.Context, req *Request) (<-chan Event, int, string)

// searchReply answers req through ask, running the searches its model
// asks for and asking it again with what they found; the client sees one
// reply. The first round's failure is a status, as another provider may
// take over.
func (s *Server) searchReply(w http.ResponseWriter, r *http.Request, from provider.Protocol, name string, req *Request, usage *Usage, ask round) (int, string) {
	ctx, cancel := context.WithCancel(context.WithValue(r.Context(), searchForKey{}, &CallFor{Agent: callerOf(r).agent, Model: unprefixed(req.Model)}))
	defer cancel()
	q := *req
	q.WebSearch = false
	tool := searchTool(q.Tools)
	q.Tools = append(slices.Clone(q.Tools), tool)
	q.Messages = slices.Clone(q.Messages)
	first, status, msg := ask(ctx, &q)
	if first == nil {
		return writeError(w, from, status, msg), msg
	}
	events := make(chan Event, 16)
	go func() {
		defer close(events)
		s.searchRounds(ctx, &q, tool.Name, first, ask, events)
	}()
	return relay(w, r, from, name, req, events, usage, cancel, nil, func(string, string, bool) {})
}

func (s *Server) searchRounds(ctx context.Context, q *Request, tool string, in <-chan Event, ask round, out chan<- Event) {
	send := func(ev Event) bool {
		select {
		case out <- ev:
			return true
		case <-ctx.Done():
			return false
		}
	}
	var before, this Usage
	started, said := false, false
	for n := 1; ; n++ {
		var col collector
		mine, theirs, gap := false, false, said
		var stop string
		for ev := range in {
			if ev.Kind == KAlive {
				// nothing of the reply: no part of what it collects
				if !send(ev) {
					return
				}
				continue
			}
			col.add(ev)
			switch ev.Kind {
			case KStart:
				this = ev.Usage
				ev.Usage = ev.Usage.plus(before, false)
				if started {
					ev = Event{Kind: KUsage, Usage: ev.Usage}
				}
				started = true
			case KUsage:
				this.add(ev.Usage)
				ev.Usage = ev.Usage.carryUpdate(this, before)
			case KText:
				if gap && ev.Text != "" {
					// what it says after a search goes on from what it
					// said before it
					ev.Text = "\n\n" + strings.TrimLeft(ev.Text, "\n")
					gap = false
				}
				said = said || ev.Text != ""
			case KToolStart:
				mine = ev.Name == tool
				theirs = theirs || !mine
				if mine {
					continue
				}
			case KToolArgs:
				if mine {
					continue
				}
			case KStop:
				stop = ev.Stop
				continue
			case KError:
				send(ev)
				return
			}
			if !send(ev) {
				return
			}
		}
		res := col.finish()
		var calls []Part
		for i, p := range res.Parts {
			if p.Kind == ToolCall && p.Name == tool {
				if p.ID == "" {
					res.Parts[i].ID = fmt.Sprintf("call_search_%d_%d", n, i)
				}
				calls = append(calls, res.Parts[i])
			}
		}
		// a reply that calls the client's tools goes to the client: it
		// can't answer a search, and doesn't see the ones left out
		if len(calls) == 0 || theirs || n > searchRounds+1 {
			if stop == "" || (len(calls) > 0 && !theirs) {
				stop = "stop"
			}
			send(Event{Kind: KStop, Stop: stop})
			return
		}
		results := make([]Part, len(calls))
		searches := make([]Event, len(calls))
		var wg sync.WaitGroup
		for i, c := range calls {
			wg.Add(1)
			go func() {
				defer wg.Done()
				results[i] = Part{Kind: ToolResult, CallID: c.ID}
				if n > searchRounds {
					results[i].Text, results[i].IsError = "No more searches: answer with what was found.", true
					return
				}
				var a struct {
					Query string `json:"query"`
				}
				json.Unmarshal(c.Args, &a)
				if strings.TrimSpace(a.Query) == "" {
					results[i].Text, results[i].IsError = "query is empty", true
					return
				}
				found, hits, err := s.webSearch(context.WithValue(ctx, searchCallKey{}, c.ID), a.Query)
				if err != nil {
					results[i].Text, results[i].IsError = "search failed: "+err.Error(), true
					return
				}
				results[i].Text = found
				searches[i] = Event{Kind: KSearch, Text: a.Query, Hits: hits}
			}()
		}
		wg.Wait()
		if ctx.Err() != nil {
			return
		}
		// the client hears of the searches as its provider's own
		for _, ev := range searches {
			if ev.Kind == KSearch && !send(ev) {
				return
			}
		}
		q.Messages = append(q.Messages, Message{Role: "assistant", Parts: res.Parts}, Message{Role: "user", Parts: results})
		before, this = before.plus(this, false), Usage{}
		var status int
		var msg string
		if in, status, msg = ask(ctx, q); in == nil {
			send(Event{Kind: KError, Text: fmt.Sprintf("%s (%d)", msg, status)})
			return
		}
	}
}

// askTranslated is a round for a provider asked on to.
func (s *Server) askTranslated(p provider.Provider, to provider.Protocol, model string, in http.Header, reply http.Header) round {
	first := true
	return func(ctx context.Context, req *Request) (<-chan Event, int, string) {
		q := *req
		q.Stream = true
		res, actual, err := s.forwardTranslated(ctx, p, to, &q, model, in)
		if err != nil {
			return nil, 502, p.Name + ": " + err.Error()
		}
		if res.StatusCode >= 400 {
			b, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
			res.Body.Close()
			if first {
				keepRetry(reply, res.Header, b)
			}
			return nil, res.StatusCode, p.Name + ": " + provider.APIError(b, res.Status)
		}
		first = false
		to = actual
		rd, sse := eventStream(res)
		if !sse {
			b, _ := io.ReadAll(io.LimitReader(rd, 1<<20))
			res.Body.Close()
			return nil, 502, p.Name + " " + didNotStream + ": " + provider.APIError(b, "unexpected reply")
		}
		events := make(chan Event, 16)
		go func() {
			defer close(events)
			defer res.Body.Close()
			dec := decoder(actual)
			send := func(ev Event) error {
				select {
				case events <- ev:
					return nil
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			var failed error
			told := time.Now() // when the reader was last sent anything
			err := readSSEAlive(rd, func(_, data string) error {
				if err := dec(data, func(ev Event) {
					if failed == nil {
						failed = send(ev)
						told = time.Now()
					}
				}); err != nil {
					return err
				}
				return failed
			}, func() {
				// a provider still queued or thinking — keepalives,
				// response.in_progress — is heard from with nothing to
				// translate: the reader hears that it goes on (#2316)
				if failed == nil && time.Since(told) >= keepaliveGap {
					failed = send(Event{Kind: KAlive})
					told = time.Now()
				}
			})
			if err != nil && failed == nil && ctx.Err() == nil {
				send(Event{Kind: KError, Text: p.Name + ": " + err.Error()})
			}
		}()
		return events, 0, ""
	}
}
