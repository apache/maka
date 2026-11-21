package gateway

// Fallback: a provider can name models to use when it can't take a request
// — a coding plan out of quota, a rate limit, an overloaded or failing
// vendor. The request goes to the next one only while none of the reply has
// been sent, so an agent sees one clean answer from whoever gave it, never a
// half from each. A provider that just failed that way waits at the back of
// the line for a minute, rather than costing every request a doomed try.
//
// A provider with several keys on is several candidates, one per key, in
// order, and so is a subscription with several accounts on: when one
// account runs out, the next account of the same provider takes the
// request before any fallback model does. A key can be made for one
// protocol only, as some relays hand them out; see perKey.

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/yetone/magpie/internal/provider"
	"github.com/yetone/magpie/internal/settings"
)

const fallbackCooldown = time.Minute

type candidate struct {
	p     provider.Provider
	model string
	rest  string // what rests after a failure: the provider, or one of its keys
	// effort is the reasoning the group's member it is of is fixed at
	// ("provider/model:low"); "" for one that follows the agent or the group
	effort string
	// fast is set on a member the group sends in its vendor's fast mode
	// (Group.Fast); ultra on an agent's fast pick sent Ultrafast (#1954)
	fast, ultra bool
	// rank is its place in its provider's own list of accounts or keys,
	// the order the provider's page shows and a drag sets (#217)
	rank int
	// capped is set on an account left out as held at its usage cap
	capped *capHold
	// noURL is the protocol its provider's keys are all set to that the
	// provider has no URL for (#1702): the provider is tried whole, on the
	// URLs it has, and the routing trace says why
	noURL provider.Protocol
	// seats are its places in the rounds of the groups routed by weight
	// it is in (weightedUnits), for affinity to charge the member that
	// keeps a conversation (weightedKept)
	seats []wrrSeat
	// firstToken is the FirstToken of the innermost group of those the
	// member is in that sets one (#2246): a group in a group times its own
	// members' first tokens, the group asked for only those that set none
	firstToken int
}

// capHold is how an account is held at its usage cap: the cap of the
// fullest window at or past its own cap, that window's share used, and when the last such window
// renews (zero when one doesn't say). noCredits: it is a Codex account
// held at 100% as it is set not to spend its credits (cap is 100 then).
type capHold struct {
	cap       int
	used      float64
	back      time.Time
	noCredits bool
}

// label names a candidate in a call's record: the provider, and the key
// when it has several on.
func (c candidate) label() string {
	if c.rest == c.p.ID {
		return c.p.ID
	}
	if c.p.Account != nil {
		return c.p.ID + " (" + c.p.Account.User + ")"
	}
	if c.p.KeyName != "" {
		return c.p.ID + " (" + c.p.KeyName + ")"
	}
	return c.p.ID + " (" + provider.Mask(c.p.Key) + ")"
}

// restKey is what a candidate rests by: an account by its user, whether
// or not the agent is signed in to it — magpie can sign Codex in to the
// next account when the one it is on is out, and the one out stays out.
func (c candidate) restKey() string {
	if a := c.p.Account; a != nil && a.User != "" {
		return c.p.ID + "@" + strings.ToLower(a.User)
	}
	return c.rest
}

// seat is the candidate as one of a group's members has it: its key or
// account, the model, and the effort the member is fixed at.
func (c candidate) seat() string {
	return provider.WithMemberEffort(c.rest+"/"+c.model, c.effort)
}

func (c candidate) isOpenRouterFree() bool {
	return c.p.Preset == "openrouter" && strings.HasSuffix(c.model, ":free")
}

// restID is the candidate's model's own rest key: a free OpenRouter
// model's, whose rate limit is its free-tier limit, a subscription's, out
// of a pool of its allowance that counts some models only (pooled), and
// any key's or account's model its vendor said it doesn't serve it
// (modelRefused). An account-level rest stays on restKey.
func (c candidate) restID() string {
	return c.restKey() + "/" + c.model
}

// pooled says whether the candidate's subscription, refused for its
// allowance, is out for its model alone (provider.Allowance.Pooled).
func (c candidate) pooled(now time.Time) bool {
	if c.p.Account == nil {
		return false
	}
	return allowances(c.p.Account.UsageAgent())[c.p.Account.User].Pooled(c.model, provider.SpentShareOf(c.p.Routing), now)
}

// who is the key or account itself, however many the provider has on: a
// provider's one key rests as the provider, and as itself once another
// is added, and a conversation it answered stays with it all the same.
// An account is its user, signed in to or not: rest names the one the
// agent is on by the provider's id alone, which a switch of the agent's
// account hands to another (#209).
func (c candidate) who() string {
	if c.p.Account == nil && c.p.Key != "" {
		return c.p.ID + "#" + provider.KeyID(c.p.Key)
	}
	return c.restKey()
}

// perKey is a provider once per key it has on, in order — or, for a
// signed-in agent, once per account it has on, its own first. A key made
// for one protocol only serves on that one's endpoint, and the keys that
// suit the request go first: the Anthropic key for a Claude model, the
// OpenAI one for a GPT model, else the key that speaks what the agent
// spoke, so nothing is translated that needn't be.
func perKey(p provider.Provider, model string, from provider.Protocol) []candidate {
	out, aside, _ := perKeyOf(p, model, from)
	return append(out, aside...)
}

// perKeyOf is perKey, split: the keys routing goes over, those made for
// another protocol, and the accounts or keys it left out as not listing
// the model. Keys made for different protocols are not one pool: routing
// weighs, rotates and keeps conversations over those made for the
// protocol that suits the request best, and the others are tried only
// after them, in the order they suit it.
func perKeyOf(p provider.Provider, model string, from provider.Protocol) (out, aside, left []candidate) {
	out, aside, left, _ = perKeyBarred(p, model, from)
	return out, aside, left
}

// perKeyBarred is perKeyOf, and the accounts or keys the user set not to
// serve the model (provider.AccountModels, #474): never tried, whatever
// else there is — none, when every one of them is.
func perKeyBarred(p provider.Provider, model string, from provider.Protocol) (out, aside, left, barred []candidate) {
	if _, off := provider.ModelDisabled(p.ID, model); off || provider.DisabledUnknown() {
		return nil, nil, nil, nil // the user disabled it (#1867): never planned, a fallback no more than the model asked
	}
	if p.Account != nil {
		also := p.AlsoOn()
		var all []candidate
		// the account the agent is signed in to, unless the user paused
		// it for the others on (#263)
		if len(also) == 0 || !p.OwnPaused() {
			all = append(all, candidate{p: p, model: model, rest: p.ID})
		}
		for i, q := range also {
			all = append(all, candidate{p: q, model: model, rest: p.ID + "@" + q.Account.User, rank: i + 1})
		}
		// kept signed in to an account of the user's choosing, the one
		// signed in to stands at its own place in the order, not first
		// (#524)
		if ranks := p.LoginRanks(); ranks != nil {
			at := func(c candidate) int {
				if r, ok := ranks[strings.ToLower(c.p.Account.User)]; ok {
					return r
				}
				return len(ranks)
			}
			slices.SortStableFunc(all, func(a, b candidate) int { return at(a) - at(b) })
			for i := range all {
				all[i].rank = i
			}
		}
		all = slices.DeleteFunc(all, func(c candidate) bool {
			if p.AccountServes(c.p.Account.User, model) {
				return false
			}
			barred = append(barred, c)
			return true
		})
		// an account at its usage cap is used up for routing until the
		// window it filled renews: never tried, so groups, fallbacks and
		// the other accounts take the request (provider/account_caps.go);
		// so is a Codex account at 100% set not to spend its credits
		// (provider/codex_credits.go)
		all = slices.DeleteFunc(all, func(c candidate) bool {
			h := capHeld(p, c.p, model, time.Now())
			if h == nil {
				return false
			}
			c.capped = h
			barred = append(barred, c)
			return true
		})
		// an account whose plan lacks the model (a Free one behind a Plus)
		// would only answer 400; it is tried only when none lists it
		for _, c := range all {
			if c.p.Account.Lists(model) {
				out = append(out, c)
			} else {
				left = append(left, c)
			}
		}
		if len(out) == 0 {
			return all, nil, nil, barred
		}
		return out, nil, left, barred
	}
	keys := p.KeysOn()
	serves := p.Serving(model) // the lists read once, not once a key (@NetRozee on X)
	var unlisted []candidate
	var noURL provider.Protocol
	for i, k := range keys {
		q := p.WithKey(k)
		if len(q.Speaks()) == 0 && !q.DecidesModel(model) {
			if noURL == "" {
				noURL = k.Protocol
			}
			continue // made for a protocol this provider has no endpoint for
		}
		rest := p.ID
		if len(keys) > 1 {
			rest += "#" + provider.KeyID(k.Key)
		}
		if !p.AccountServes(provider.KeyID(k.Key), model) {
			barred = append(barred, candidate{p: q, model: model, rest: rest, rank: i})
			continue
		}
		if !serves(k) {
			// the vendor lists the model to another key only
			unlisted = append(unlisted, candidate{p: q, model: model, rest: rest, rank: i})
			continue
		}
		out = append(out, candidate{p: q, model: model, rest: rest, rank: i})
	}
	if len(out) == 0 {
		out, unlisted = unlisted, nil // no key lists it: try them all the same
	}
	if len(out) == 0 && len(barred) > 0 {
		return nil, nil, nil, barred
	}
	if len(out) == 0 {
		// every key is set to a protocol the provider has no URL for (or
		// it has none on): the provider as it is, on the URLs it has,
		// marked so Routing says so rather than sending it there quietly
		return []candidate{{p: p, model: model, rest: p.ID, noURL: noURL}}, nil, nil, nil
	}
	sort.SliceStable(out, func(i, j int) bool { return keyFit(out[i].p, model, from) < keyFit(out[j].p, model, from) })
	pool := out[:0:0]
	for _, c := range out {
		if c.p.KeyProtocol == out[0].p.KeyProtocol {
			pool = append(pool, c)
		} else {
			aside = append(aside, c)
		}
	}
	return pool, aside, unlisted, barred
}

// keyFit ranks how well a key suits a request, best first: 0 fits, 1 needs
// the request translated, 2 is made for another vendor's models.
func keyFit(q provider.Provider, model string, from provider.Protocol) int {
	if q.KeyProtocol == "" {
		return 0
	}
	switch modelFamily(model) {
	case provider.Anthropic:
		if q.KeyProtocol == provider.Anthropic {
			return 0
		}
		return 2
	case provider.Chat:
		if q.KeyProtocol != provider.Anthropic {
			return 0
		}
		return 2
	}
	if q.Base(from) != "" {
		return 0
	}
	return 1
}

// modelFamily is the protocol a model is at home in, when its name says:
// Anthropic for Claude, Chat (standing for OpenAI's) for GPT and the o-series.
func modelFamily(model string) provider.Protocol {
	m := strings.ToLower(model)
	if i := strings.LastIndex(m, "/"); i >= 0 {
		m = m[i+1:]
	}
	switch {
	case strings.HasPrefix(m, "claude"):
		return provider.Anthropic
	case strings.HasPrefix(m, "gpt-"), strings.Contains(m, "codex"), len(m) > 1 && m[0] == 'o' && m[1] >= '1' && m[1] <= '9':
		return provider.Chat
	}
	return ""
}

// candidates is the primary and then its fallbacks, each provider's keys
// or accounts as its routing orders them, those resting after a recent
// failure moved behind the rest.
func (s *Server) candidates(p provider.Provider, model string, from provider.Protocol) []candidate {
	out, _ := s.plan(p, model, from)
	return out
}

// plan is candidates, and for the routing trace what each stood where it
// did by, and those left out.
func (s *Server) plan(p provider.Provider, model string, from provider.Protocol) ([]candidate, planned) {
	var pl planned
	add := func(q provider.Provider, m string, fallback bool) []candidate {
		cs, aside, left, barred := perKeyBarred(q, m, from)
		pl.left = append(pl.left, barredOf(barred, q, fallback, from, nil)...)
		pl.held = append(pl.held, creditsHeld(barred)...)
		pl.capped = append(pl.capped, capHeldOnly(barred)...)
		cs, wg := weigh(q, cs, m, from)
		for i, c := range cs {
			w := weighed(c, q, wg, fallback, from)
			w.Turn = i == 0 && goesRound(q.Routing) && len(cs) > 1
			pl.order = append(pl.order, w)
		}
		pl.order = append(pl.order, asideOf(aside, q, fallback, from)...)
		cs = append(cs, aside...)
		for _, c := range left {
			w := weighed(c, q, weighing{}, fallback, from)
			w.Unlisted = true
			pl.left = append(pl.left, w)
		}
		return cs
	}
	out := add(p, model, false)
	seen := map[string]bool{p.ID + "/" + model: true}
	for _, id := range p.Fallback {
		fp, fm, ok := provider.Resolve(id)
		if !ok || seen[fp.ID+"/"+fm] {
			continue
		}
		seen[fp.ID+"/"+fm] = true
		out = append(out, add(fp, fm, true)...)
	}
	return restLast(out, pl)
}

// planGroup is plan for a routing group: every member's keys or accounts
// weighed together as the group's routing says — in order, member by
// member, each as its own provider's routing orders it; else all as one,
// so a subscription whose allowance renews soonest goes first whichever
// provider it is of, but for a provider set to route another way, which
// is planned as a group in the group is (ownRouting). A group in the group is planned by its own routing
// alone, whatever the group's (#576): in order, in its place; else as
// one, weighed with the rest by the one it would try first, and tried
// whole where that one goes — the group's routing picks between its
// groups, never within them. A group in the group sinks by its own Sink
// too, within its own order (#2255), before g's Sink orders the whole.
// A member's fallbacks are not the group's.
func (s *Server) planGroup(g provider.Group, ms []provider.Member, from provider.Protocol) ([]candidate, planned) {
	var pl planned
	var asides []candidate
	var wAsides []Weighed
	out := planLevel(g, ms, 0, from, &pl, &asides, &wAsides)
	if sinks(g.Sink, g.Routing) {
		out, pl.order = sinkPlanned(out, pl.order)
	}
	out, pl.order = append(out, asides...), append(pl.order, wAsides...)
	if len(out) == 0 {
		return nil, pl
	}
	return restLast(out, pl)
}

// innerFirstToken is the FirstToken of the innermost group m is in
// (m.Via, the outermost first) that sets one, 0 for none.
func innerFirstToken(m provider.Member) int {
	for i := len(m.Via) - 1; i >= 0; i-- {
		if m.Via[i].FirstToken > 0 {
			return m.Via[i].FirstToken
		}
	}
	return 0
}

// planLevel orders the models ms of g, a group depth groups down from the
// one asked for, adding to pl's order as it goes: those set aside and
// those unlisted it gathers for planGroup to put last.
func planLevel(g provider.Group, ms []provider.Member, depth int, from provider.Protocol, pl *planned, asides *[]candidate, wAsides *[]Weighed) []candidate {
	keys := func(m provider.Member) []candidate {
		cs, aside, left, barred := perKeyBarred(m.Provider, m.Model, from)
		// the effort the member is fixed at goes with each of its keys:
		// the same model at another effort is another member's
		for _, l := range [][]candidate{cs, aside, left, barred} {
			for i := range l {
				l[i].effort, l[i].fast = m.Effort, m.Fast
				l[i].firstToken = innerFirstToken(m)
			}
		}
		pl.left = append(pl.left, barredOf(barred, m.Provider, false, from, m.Groups())...)
		pl.held = append(pl.held, creditsHeld(barred)...)
		pl.capped = append(pl.capped, capHeldOnly(barred)...)
		*asides = append(*asides, aside...)
		for _, w := range asideOf(aside, m.Provider, false, from) {
			w.Via = m.Groups()
			*wAsides = append(*wAsides, w)
		}
		for _, c := range left {
			w := weighed(c, m.Provider, weighing{}, false, from)
			w.Unlisted, w.Via = true, m.Groups()
			pl.left = append(pl.left, w)
		}
		return cs
	}
	if routingOf(g.Routing) != provider.Ordered {
		// what the group weighs: each of its models' keys or accounts,
		// and each group in it as one — planned by its own routing, put
		// where the one it would try first is, the rest of it after
		type unit struct {
			m      provider.Member // the model, for one of its keys
			cs     []candidate     // a group in g, or a provider routed its own way: its own order
			order  []Weighed
			member string // as g spells it, for a unit of a group routed by weight
		}
		// a group routed by weight weighs its members, each whole: a
		// model's keys in its provider's order, a group in it in its own
		byWeight := routingOf(g.Routing) == provider.Weighted
		var units []unit
		var heads []candidate
		at := map[string][]int{} // a head's seat → its units, in turn
		add := func(u unit, head candidate) {
			at[head.seat()] = append(at[head.seat()], len(units))
			units, heads = append(units, u), append(heads, head)
		}
		for i := 0; i < len(ms); {
			m := ms[i]
			if len(m.Path) > depth+1 {
				j := i + 1
				for j < len(ms) && len(ms[j].Path) > depth+1 && ms[j].Path[depth] == m.Path[depth] {
					j++
				}
				var sub planned
				cs := planLevel(m.Via[depth], ms[i:j], depth+1, from, &sub, asides, wAsides)
				cs, sub.order = sinkOwn(m.Via[depth], cs, sub.order)
				pl.left = append(pl.left, sub.left...)
				pl.capped = append(pl.capped, sub.capped...)
				if len(cs) > 0 {
					add(unit{cs: cs, order: sub.order, member: m.Path[depth]}, firstAwake(cs))
				}
				i = j
				continue
			}
			if ownRouting(m.Provider, g) || byWeight {
				// a provider routed its own way keeps it, as a group
				// in the group does: weighed as one by the first it
				// would try, and tried whole in its own order (kchen0x
				// on X: Antigravity in order inside a Smart group)
				cs, wg := weigh(m.Provider, keys(m), m.Model, from)
				var order []Weighed
				for k, c := range cs {
					w := weighed(c, m.Provider, wg, false, from)
					w.Turn = k == 0 && goesRound(m.Provider.Routing) && len(cs) > 1
					w.Via = m.Groups()
					order = append(order, w)
				}
				if len(cs) > 0 {
					add(unit{cs: cs, order: order, member: m.Path[depth]}, firstAwake(cs))
				}
				i++
				continue
			}
			for _, c := range keys(m) {
				add(unit{m: m}, c)
			}
			i++
		}
		if byWeight {
			members := make([]string, len(units))
			for i, u := range units {
				members[i] = u.member
			}
			var out []candidate
			for i, k := range weightedUnits(g, members, heads) {
				u := units[k]
				seat := wrrSeat{round: provider.GroupPrefix + g.ID, member: u.member}
				for _, c := range u.cs {
					c.seats = append(slices.Clip(c.seats), seat)
					out = append(out, c)
				}
				order := slices.Clone(u.order)
				if i == 0 && len(units) > 1 && len(order) > 0 {
					order[0].Turn = true
				}
				pl.order = append(pl.order, order...)
			}
			return out
		}
		routing := g.Routing
		if routing == provider.Manual {
			routing = "" // the member picked, its keys or accounts weighed smartly
		}
		weighedHeads, wg := weigh(provider.Provider{ID: provider.GroupPrefix + g.ID, Routing: routing}, heads, "", from)
		var out []candidate
		for i, c := range weighedHeads {
			k := at[c.seat()][0]
			at[c.seat()] = at[c.seat()][1:]
			u := units[k]
			if u.cs != nil {
				out = append(out, u.cs...)
				pl.order = append(pl.order, u.order...)
				continue
			}
			w := weighed(c, u.m.Provider, wg, false, from)
			w.Routing, w.Via = g.Routing, u.m.Groups()
			w.Sunk = nil // weighed as the group's, whose own Sink tells
			w.Turn = i == 0 && routingOf(g.Routing) == provider.Rotate && len(weighedHeads) > 1
			pl.order = append(pl.order, w)
			out = append(out, c)
		}
		return out
	}
	var out []candidate
	for i := 0; i < len(ms); {
		m := ms[i]
		if len(m.Path) > depth+1 {
			// a group in g: its models, planned by its routing and
			// sunk by its Sink
			j := i + 1
			for j < len(ms) && len(ms[j].Path) > depth+1 && ms[j].Path[depth] == m.Path[depth] {
				j++
			}
			at := len(pl.order)
			cs := planLevel(m.Via[depth], ms[i:j], depth+1, from, pl, asides, wAsides)
			var order []Weighed
			cs, order = sinkOwn(m.Via[depth], cs, pl.order[at:])
			pl.order = append(pl.order[:at], order...)
			out = append(out, cs...)
			i = j
			continue
		}
		cs, wg := weigh(m.Provider, keys(m), m.Model, from)
		for k, c := range cs {
			w := weighed(c, m.Provider, wg, false, from)
			w.Turn = k == 0 && goesRound(m.Provider.Routing) && len(cs) > 1
			w.Via = m.Groups()
			pl.order = append(pl.order, w)
		}
		out = append(out, cs...)
		i++
	}
	return out
}

// sinkOwn is cs, the keys and accounts of sub, a group in a group, as
// planLevel planned them, with those that sank behind the others when
// sub's own Sink is on, and order, what the trace says of each, kept with
// them (#2255, ggbdpq): a nested group is planned by its own routing
// (#576) and rules, and its Sink was left unread, only the group the
// agent asked for sinking.
func sinkOwn(sub provider.Group, cs []candidate, order []Weighed) ([]candidate, []Weighed) {
	if !sinks(sub.Sink, sub.Routing) {
		return cs, order
	}
	return sinkPlanned(cs, order)
}

// firstAwake is the first of cs that isn't resting, else the first: what
// a group in a group, or a provider routed its own way, is weighed by.
func firstAwake(cs []candidate) candidate {
	for _, c := range cs {
		if _, resting := restOf(c.restKey()); !resting {
			if _, resting = restOf(c.restID()); !resting {
				return c
			}
		}
	}
	return cs[0]
}

// ownRouting: p, a model's provider in g, is routed by its own routing
// rather than weighed key by key with the rest of g. One left on Smart,
// the default, or routed as g is, is weighed with g's other keys and
// accounts as one pool, so a subscription whose allowance renews soonest
// goes first whichever provider it is of; one set another way keeps it,
// as the user set it, whatever g's routing.
func ownRouting(p provider.Provider, g provider.Group) bool {
	return p.Routing != "" && p.Routing != g.Routing
}

// capHeld is how the account acct of p is held at its usage cap for
// model at now — a window at or past its own cap, else the account's — or
// at 100% as a Codex account set not to spend its credits; nil when
// nothing holds it or every window is below its share. Its windows
// are those last read (allowances), as smart routing weighs them.
func capHeld(p, acct provider.Provider, model string, now time.Time) *capHold {
	if acct.Account == nil {
		return nil
	}
	a := acct.Account
	caps := provider.HoldCaps(p, a.Agent, a.User)
	if a.Agent == "codex" && freeOnChatGPT(model) {
		// a call ChatGPT counts in no window spends nothing a usage cap
		// keeps (#1593); credits set not to be spent still hold it at
		// 100%, as nothing says the backend answers it there
		caps = provider.WindowCaps{Credits: caps.Credits}
	}
	if !caps.Holds() {
		return nil
	}
	h := allowances(a.UsageAgent())[a.User].CapHeld(model, caps, now)
	if h == nil {
		return nil
	}
	return &capHold{cap: h.Cap, used: h.Used, back: h.Back, noCredits: h.Credits}
}

// cappedError says why a request for model went nowhere when every account
// that could take it is held at its usage cap, as the vendor's own refusal
// would when all are used up; the soonest one is back is the wait.
func cappedError(model string, ws []Weighed, now time.Time) (string, time.Time) {
	held, soonest := heldReasons(ws, now)
	capped, noCredits := heldBy(ws)
	switch {
	case !noCredits:
		return fmt.Sprintf("usage cap reached: every account that serves %q is held at the usage cap set on it in magpie — %s. magpie uses it again once that window renews; %s", model, strings.Join(held, "; "), heldAdvice(capped, noCredits)), soonest
	case !capped:
		return fmt.Sprintf("usage limit reached: every account that serves %q has used up its allowance and is set in magpie not to spend its credits — %s. magpie uses it again once that window renews; %s", model, strings.Join(held, "; "), heldAdvice(capped, noCredits)), soonest
	}
	return fmt.Sprintf("usage limit reached: every account that serves %q is held by magpie — %s. magpie uses it again once that window renews; %s", model, strings.Join(held, "; "), heldAdvice(capped, noCredits)), soonest
}

// checkpointCappedError is cappedError for a request whose native
// compaction only the account that sealed it can read (#1099), when that
// one is held: the other accounts that serve model weren't tried for it,
// not because they are held too (#2517).
func checkpointCappedError(model string, cp checkpointWriter, ws []Weighed, now time.Time) (string, time.Time) {
	held, soonest := heldReasons(ws, now)
	capped, noCredits := heldBy(ws)
	return fmt.Sprintf("usage limit reached on the one account this conversation can go to — %s. The conversation was compacted natively by %s, and only that key or account can read the compaction it sealed, so magpie doesn't send it to another account that serves %q, which would refuse it; the routing mode and how conversations stay don't change that. magpie uses it again once that window renews; %s, or start a new conversation", strings.Join(held, "; "), cp.Who, model, heldAdvice(capped, noCredits)), soonest
}

// heldReasons is what holds each account of ws held at a share, and the
// soonest one is back.
func heldReasons(ws []Weighed, now time.Time) ([]string, time.Time) {
	var held []string
	var soonest time.Time
	for _, w := range ws {
		if w.Capped == 0 {
			continue
		}
		s := fmt.Sprintf("%s (%s) is at %.0f%% of a usage window, past its %d%% cap", w.Name, w.Who, w.Used, w.Capped)
		if w.NoCredits {
			s = fmt.Sprintf("%s (%s) has used up a usage window and is set not to spend its credits", w.Name, w.Who)
		}
		if w.CapBack != nil {
			s += ", until " + heldClock(*w.CapBack, now)
			if soonest.IsZero() || w.CapBack.Before(soonest) {
				soonest = *w.CapBack
			}
		}
		held = append(held, s)
	}
	return held, soonest
}

// heldAdvice is how to go on now past what heldBy says holds.
func heldAdvice(capped, noCredits bool) string {
	switch {
	case !noCredits:
		return "raise or lift the cap in magpie (Providers → the account's cap, or magpie provider account-cap)"
	case !capped:
		return "to go on now, if an account holds credits, let it spend them (Usage → the account's Use credits, or magpie quota credits <account> on)"
	}
	return "to go on now, raise or lift a cap (Providers → the account's cap, or magpie provider account-cap) or, if an account holds credits, let it spend them (Usage → the account's Use credits, or magpie quota credits <account> on)"
}

// heldBy says what holds the accounts of ws held at a share: a usage cap
// set on one, credits it is set not to spend, or both.
func heldBy(ws []Weighed) (capped, noCredits bool) {
	for _, w := range ws {
		if w.Capped > 0 {
			capped, noCredits = capped || !w.NoCredits, noCredits || w.NoCredits
		}
	}
	return capped, noCredits
}

// checkpointCappedRecord is the call's record of checkpointCappedError's
// refusal, told apart as cappedRecord's.
func checkpointCappedRecord(ws []Weighed) string {
	switch capped, noCredits := heldBy(ws); {
	case !noCredits:
		return "native compaction's account at its usage cap"
	case !capped:
		return "native compaction's account held: set not to spend its credits"
	}
	return "native compaction's account held: at its usage cap or set not to spend its credits"
}

// cappedRecord is the call's record of the same refusal as cappedError,
// told apart the same way.
func cappedRecord(ws []Weighed) string {
	switch capped, noCredits := heldBy(ws); {
	case !noCredits:
		return "every account at its usage cap"
	case !capped:
		return "every account held: set not to spend its credits"
	}
	return "every account held: at its usage cap or set not to spend its credits"
}

// creditsHeld are those of cs held only as they won't spend their
// credits: out of their allowance at the vendor's own 100%, where one
// that spends its resets by itself spends one (codex_autoreset.go). One
// held at the user's cap never does.
func creditsHeld(cs []candidate) []candidate {
	var out []candidate
	for _, c := range cs {
		if c.capped != nil && c.capped.noCredits {
			out = append(out, c)
		}
	}
	return out
}

// capHeldOnly are those of cs held at the usage cap the user set on them,
// not for credits they won't spend: a conversation kept strictly on one
// goes on there past the cap (provider.AffinityStrict, #1797).
func capHeldOnly(cs []candidate) []candidate {
	var out []candidate
	for _, c := range cs {
		if c.capped != nil && !c.capped.noCredits {
			out = append(out, c)
		}
	}
	return out
}

// barredOf is how the trace tells the accounts or keys the user set not
// to serve the model: left out, as those not listing it are.
func barredOf(cs []candidate, q provider.Provider, fallback bool, from provider.Protocol, via []string) []Weighed {
	var out []Weighed
	for _, c := range cs {
		w := weighed(c, q, weighing{}, fallback, from)
		w.Unlisted, w.Via = true, via
		if h := c.capped; h != nil {
			w.Capped, w.Used, w.NoCredits = h.cap, h.used, h.noCredits
			if !h.back.IsZero() {
				w.CapBack = &h.back
			}
		} else {
			w.Barred = true
		}
		out = append(out, w)
	}
	return out
}

// barredError says why a request for model went nowhere when every account
// or key that could take it was set not to serve it.
func barredError(model string, ws []Weighed) string {
	var names []string
	for _, w := range ws {
		if !slices.Contains(names, w.Name) {
			names = append(names, w.Name)
		}
	}
	return fmt.Sprintf("model %q is set not to be served by any account or key of %s: each one's own list of models leaves it out. Add it to an account's models in magpie (Providers → the account's Models), or pick another model", model, strings.Join(names, ", "))
}

// asideOf is how the trace tells the keys made for another protocol than
// those routed over: after them, in the order they suit the request.
func asideOf(cs []candidate, q provider.Provider, fallback bool, from provider.Protocol) []Weighed {
	var out []Weighed
	for _, c := range cs {
		w := weighed(c, q, weighing{}, fallback, from)
		w.Aside = true
		out = append(out, w)
	}
	return out
}

// restLast moves those resting after a recent failure behind the rest.
func restLast(out []candidate, pl planned) ([]candidate, planned) {
	if len(out) == 1 {
		if r, ok := restingOf(out[0]); ok {
			pl.order[0].Rest = &r // tried all the same: there is no other
		}
		return out, pl
	}
	var ready, resting []candidate
	var wReady, wResting []Weighed
	for i, c := range out {
		if r, ok := restingOf(c); ok {
			pl.order[i].Rest = &r
			resting, wResting = append(resting, c), append(wResting, pl.order[i])
		} else {
			ready, wReady = append(ready, c), append(wReady, pl.order[i])
		}
	}
	pl.order = append(wReady, wResting...)
	return append(ready, resting...), pl
}

// probeOne keeps, of the candidates resting after a failure, only the one
// back soonest (the first in order on a tie), at its place; the ready ones
// all stay (#1799). Before, every request asked each resting member in
// turn once those ahead of it failed, so a member that was down was asked
// by every request its rest was meant to spare it from, and in an outage
// of the whole group each request went to all of them. Now a request asks
// at most one resting member: the one whose rest is nearest its end,
// whose answer tells whether it is back, as AxonHub's error-aware
// balancing lets a failed channel's penalty decay rather than send it
// every request. A lone candidate is always kept, so a request still gets
// a real answer, and nothing about the request's own content or model
// rests a member (only the model, by restID), so it isn't left out over
// those. The trace keeps every member, the resting ones with their rest.
func probeOne(cs []candidate) []candidate {
	if len(cs) < 2 {
		return cs
	}
	soonest := -1
	var until time.Time
	rests := 0
	rest := make([]bool, len(cs))
	for i, c := range cs {
		r, ok := restOf(c.restKey())
		if !ok && c.restID() != c.restKey() {
			r, ok = restOf(c.restID())
		}
		if !ok {
			continue
		}
		rests, rest[i] = rests+1, true
		if soonest < 0 || r.Until.Before(until) {
			soonest, until = i, r.Until
		}
	}
	if rests < 2 {
		return cs
	}
	out := make([]candidate, 0, len(cs)-rests+1)
	for i, c := range cs {
		if i == soonest || !rest[i] {
			out = append(out, c)
		}
	}
	return out
}

// restingOf is why c rests, by its own key or else its provider's, while
// it does. A key resting out of its own windows has them read again as it
// is planned, behind the request and once a minute at most: an ordered
// group weighs nothing by them, and a reading that finds them full no
// more is what brings it back (renewed).
func restingOf(c candidate) (Rest, bool) {
	r, ok := restOf(c.restKey())
	if !ok && c.restID() != c.restKey() {
		r, ok = restOf(c.restID())
	}
	if ok && r.agent == "" && r.user != "" {
		keyAllowance(c.p)
	}
	return r, ok
}

// quotaHeld is, when every candidate of cs is a key resting out of its
// allowance or its credit — refused with a 429 or a 402 for it, the
// vendor's words kept — the rest of the first, and when the first of them
// is back: asked before then, each would be refused the same (#1772). A
// subscription account isn't held so: its resets may be spent for it
// (autoReset), and its windows are read again as it is planned.
func quotaHeld(cs []candidate) (Rest, time.Time, bool) {
	var first Rest
	var back time.Time
	for i, c := range cs {
		r, ok := restingOf(c)
		if !ok || c.p.Account != nil || r.Why != failQuota && r.Why != failCredit || !quotaStatus(r.Status) || r.said == "" {
			return Rest{}, time.Time{}, false
		}
		if i == 0 {
			first = r
		}
		if back.IsZero() || r.Until.Before(back) {
			back = r.Until
		}
	}
	return first, back, len(cs) > 0
}

// quotaStatus is a status a vendor says a key is out of its allowance with.
func quotaStatus(status int) bool {
	return status == http.StatusTooManyRequests || status == http.StatusPaymentRequired
}

// soonestBack is when the first of cs is back from its rest; false when
// one of them isn't resting.
func soonestBack(cs []candidate) (time.Time, bool) {
	var back time.Time
	for _, c := range cs {
		r, ok := restingOf(c)
		if !ok {
			return time.Time{}, false
		}
		if back.IsZero() || r.Until.Before(back) {
			back = r.Until
		}
	}
	return back, !back.IsZero()
}

// spentAfter says whether every candidate in cs rests with its allowance
// run out: none of them is likely to answer.
func spentAfter(cs []candidate) bool {
	for _, c := range cs {
		r, ok := restOf(c.restKey())
		if !ok && c.restID() != c.restKey() {
			r, ok = restOf(c.restID())
		}
		if !ok || r.Why != failQuota && r.Why != failCredit {
			return false
		}
	}
	return len(cs) > 0
}

// spentModel says whether every account or key routing would try for
// p's model is out of its allowance as last known: held at its usage cap,
// resting after the vendor said it is out of quota or credit (the
// account's, or its model's own pool), or with a window that counts the
// model used up. back is when the first of them is, zero when none says.
// A model magpie picks for a call of its own (AutoVision, autoSearcher)
// is one routing would still try: a turn's own model goes to the one
// candidate it has all the same, but the describer or searcher picked in
// its place can be another (#1801). Unknown allowance, or a rest for a
// rate limit or an error, is not spent.
func spentModel(p provider.Provider, model string, from provider.Protocol, now time.Time) (back time.Time, spent bool) {
	out, aside, _, barred := perKeyBarred(p, model, from)
	soonest := func(t time.Time) {
		if !t.IsZero() && (back.IsZero() || t.Before(back)) {
			back = t
		}
	}
	for _, c := range barred {
		if c.capped != nil {
			soonest(c.capped.back)
		}
	}
	for _, c := range append(out, aside...) {
		if r, ok := restingOf(c); ok && (r.Why == failQuota || r.Why == failCredit) {
			soonest(r.Until)
			continue
		}
		if t := c.full(now); !t.IsZero() {
			soonest(t)
			continue
		}
		return time.Time{}, false
	}
	return back, true
}

var restingUntil = struct {
	sync.Mutex
	m    map[string]time.Time
	note map[string]Rest // why each rests
}{m: map[string]time.Time{}, note: map[string]Rest{}}

func (s *Server) resting(id string) bool {
	_, ok := restOf(id)
	return ok
}

// restOf is why a candidate is resting, while it is.
func restOf(id string) (Rest, bool) {
	restingUntil.Lock()
	defer restingUntil.Unlock()
	until := restingUntil.m[id]
	if !time.Now().Before(until) {
		return Rest{}, false
	}
	r := restingUntil.note[id]
	r.Until = until
	return r, true
}

// quotaWords are how vendors say "out of quota" or "slow down" when their
// status code doesn't: some answer 400 or 403 with it.
var quotaWords = regexp.MustCompile(`(?i)quota|insufficient|balance|credit|billing|out of budget|budget (exceeded|exhausted)|exceeded|rate.?limit|usage.?limit|limit.?reached|hit your .*limit|limit.{0,24}resets|too many requests|overloaded|余额|额度|欠费|限流|频率|套餐|用量|上限`)

// quotaSaid is whether an error's words, with no status to go by, say
// out of quota or slow down: quotaWords, unless they say the conversation
// is too long for the model, whose "context_length_exceeded" or "exceeds
// the maximum" holds quotaWords' "exceeded" (#1944).
func quotaSaid(msg string) bool {
	return quotaWords.MatchString(msg) && !tooLong(http.StatusBadRequest, msg)
}

// unservedWords are how a vendor says the model isn't one it serves this
// key, or this way — words another provider, or key, may not answer with.
var unservedWords = regexp.MustCompile(`(?i)model.{0,80}(not (supported|accessible|available|found|enabled|allowed)|unsupported|does ?n[o']t exist|unknown|invalid)|(no such|unknown|invalid|unsupported) model|model_not_found|模型.{0,12}(不存在|不支持|无权|未开通)`)

// modelRefused says the vendor turned the request away over its model
// alone — not one this key's plan, or this key, may use: SenseNova's 403
// "model is not available in the current token plan" for
// deepseek-v4.1-flash, while the same key serves deepseek-v4-flash
// (#1235). The key or account isn't at fault, so only its model rests,
// and its other models are asked as before. A refusal that also says
// quota, credit or a rate limit is about the account, and rests it.
func modelRefused(status int, body []byte) bool {
	if modelRetired(status, body) {
		return true
	}
	switch status {
	case 400, 403, 404, 422:
	default:
		return false
	}
	// the words are matched decoded, too (#1669)
	body = wordsOf(body)
	return unservedWords.Match(body) && !quotaWords.Match(body) && !refusedWords.Match(body)
}

// codeAssistModelMissing says a Google account's Code Assist — the
// Antigravity or Gemini CLI built-in's — answered 404 NOT_FOUND
// ("Requested entity was not found."). Its endpoint is the same for every
// model, so what isn't there is the model: one fetchAvailableModels lists
// that the account's plan doesn't serve (Packing1 on Discord: Argon on
// Google AI Pro). Only that model rests, on that account; its others are
// asked as before.
func codeAssistModelMissing(p provider.Provider, status int, body []byte) bool {
	if status != http.StatusNotFound || p.Account == nil || p.IsPlugin() {
		return false
	}
	if p.Account.Agent != "antigravity" && p.Account.Agent != "gemini" {
		return false
	}
	return bytes.Contains(body, []byte("NOT_FOUND")) || bytes.Contains(bytes.ToLower(body), []byte("not found"))
}

// retiredWords are how a vendor says the model is retired, though its
// list may still name it: OpenCode Zen's 410 {"type":"error","error":
// {"type":"ModelDeprecated","message":"Model exo-free has been
// deprecated."}} (MOMO on Discord), OpenAI's "The model … has been
// deprecated".
var retiredWords = regexp.MustCompile(`(?i)"ModelDeprecated"|model_deprecated|model.{0,80}(has been|was|is now|is) (deprecated|retired|discontinued|decommissioned|sunset)`)

// modelRetired says the vendor turned the request away because the model
// is retired there: it leaves that provider's place in the lists
// (provider.Retire), only it rests, and another provider of it, or the
// group's next member, is asked. Not when it also says quota or credit.
func modelRetired(status int, body []byte) bool {
	switch status {
	case 400, 404, 410, 422:
	case 401:
		// OpenCode Zen's word for a model it serves no more, said with
		// its sign-in status: the key is good (a bad one is AuthError)
		return zenModelGone.Match(body)
	default:
		return false
	}
	// the words are matched decoded, too (#1669)
	body = wordsOf(body)
	return retiredWords.Match(body) && !quotaWords.Match(body)
}

// zenModelGone is OpenCode Zen's 401 for a model it no longer serves,
// as it answered glm-5-free and kimi-k2.5-free on 2026-10-10 once they
// left its free list: {"type":"error","error":{"type":"ModelError",
// "message":"Model glm-5-free is not supported"}}. Read in the vendor's
// body, or in the message magpie put it into ("OpenCode Zen Free: Model
// glm-5-free is not supported"). Not its "is not supported for format
// anthropic", a model served on another API (wrongEndpoint), and not its
// AuthError "Invalid API key." for a key it doesn't take.
var zenModelGone = regexp.MustCompile(`(^|[\s:"])Model [^"\s]+ is not supported("|\s*$)`)

// refusedWords are how a vendor says it won't take requests from this
// client at all — WorkBuddy's "Illegal API invocation from an unapproved
// channel" to a chat opening with another agent's own system prompt — a
// refusal of the provider, not of the request, another member may serve.
var refusedWords = regexp.MustCompile(`(?i)unapproved channel|illegal api invocation`)

// promptRefused says a vendor answered with that refusal: the agent's
// prompt, not the account, is at fault.
func promptRefused(status int, body []byte) bool {
	return status >= 400 && refusedWords.Match(body)
}

// shapeWords are how a vendor says it can't read the request's shape — an
// item, field or parameter it doesn't know, which another vendor's API may
// take: xAI's 422 "Failed to deserialize the JSON body …: unknown item type"
// (#350), OpenAI's "Unknown parameter", and a limit of its own on a tool's
// JSON schema: OpenCode Go's 400 "JSON schema exceeds the maximum nesting
// depth of 10 levels" on muse-spark-1.3-contributor for Claude Code's MCP
// tools (#1870), which another member's model may take as they are. A
// request missing what every API requires ("field required") or too long
// for the model isn't one.
var shapeWords = regexp.MustCompile(`(?i)failed to deserialize|unknown (item |content |input )?(type|variant|field|parameter)|unknown_parameter|unrecognized (request argument|field|parameter)|extra (inputs|fields) are not permitted|additional properties are not allowed|schema exceeds the maximum (nesting )?depth|schema[^"]{0,60}\bnesting depth\b`)

// unsaidWords are Command Code's Provider API turning a request away with
// nothing but a trace id: {"message":"invalid request error trace_id:
// <hex>","type":"invalid_request_error"}, a 400 (a 422 before), no code,
// no param (#2313, lqisgod). What it turns away is the request's size:
// the reporter's A/B on one agent conversation (~748K tokens of history
// and tools) answered 200 with max_completion_tokens 64000 and this 400
// with 384000, the model's own listed max output, so the history and the
// output asked for together are over a limit below the 1M context it
// lists; its tracker has more of the kind (CommandCodeAI/command-code#960,
// #976). The key and the account are fine, and another member, whose
// model has room for it, may well take the same request: it is asked,
// once, as for shapeWords, and Command Code doesn't rest. Its overflow
// that says so names the model's context length before the trace id, and
// isn't one. The message may come after a provider's name ("Command Code:
// "), as magpie tells it on.
var unsaidWords = regexp.MustCompile(`(?i)(^|"|\\"|: )invalid request error trace_id: [0-9a-f]{16,}(\\?"|\s*$)`)

// shapeRefused says a request failed over its shape alone: the next
// member is asked, and this one doesn't rest, as nothing is wrong with it.
func shapeRefused(status int, body []byte) bool {
	// the words are matched decoded, too (#1669)
	body = wordsOf(body)
	return (status == 400 || status == 422) && (shapeWords.Match(body) || unsaidWords.Match(body)) &&
		!quotaWords.Match(body) && !unservedWords.Match(body) && !refusedWords.Match(body)
}

// regionWords are how a vendor says it doesn't serve where the request
// comes from: Google's 400 FAILED_PRECONDITION "User location is not
// supported for the API use." (Gemini, Antigravity, Code Assist; #1621),
// and OpenAI's "unsupported_country_region_territory", which a relay may
// pass on as a 400. It is about the address the request leaves from, not
// the request or the model: another member, going another way, may
// answer, and this one rests only as briefly as any other failure does.
// A request's own field named location ("location field is not
// supported") isn't one.
var regionWords = regexp.MustCompile(`(?i)\buser location is not supported for the api use\b|unsupported_country_region_territory|country, region,? or territory not supported`)

// regionRefused says the vendor refused the request for where it came
// from, with regionWords.
func regionRefused(status int, body []byte) bool {
	return status >= 400 && regionWords.Match(body)
}

// protectionWords are how the ChatGPT backend answers a long Codex
// conversation it won't take as it is: 502 "response protection is
// unavailable" (vs on Discord, 0.1.1108). It comes back the same for the
// same history on every account and model the backend serves, and the
// history as plain text is answered, so it is about the request, not the
// account: asked again there, it only drains the accounts' allowances.
var protectionWords = regexp.MustCompile(`(?i)response protection is unavailable`)

// protectionRefused says the vendor turned the request's content away
// with protectionWords: the account is not at fault, and none of its
// provider's other accounts or models is asked the same.
func protectionRefused(status int, body []byte) bool {
	return status >= 400 && protectionWords.Match(body)
}

// elsewhere is, of the candidates left, those not at c's provider, whose
// every account and model the same request reaches the same backend
// through.
func elsewhere(left []candidate, c candidate) []candidate {
	var out []candidate
	for _, x := range left {
		if x.p.ID != c.p.ID {
			out = append(out, x)
		}
	}
	return out
}

// retryable says whether another provider may do better with a request
// that failed this way: the vendor was busy, out of quota or failing, or
// this key or provider can't serve it — not the request itself at fault.
func retryable(status int, body []byte) bool {
	// the words are matched decoded, too (#1669)
	body = wordsOf(body)
	switch {
	case overflowed(status, body):
		// a conversation too long for the model is as long on every
		// account of it: the agent is told, and compacts
		return false
	case status == 401, status == 402, status == 403, status == 404, status == 408, status == 429, status >= 500:
		return true
	case modelRetired(status, body):
		// another provider of the model may still serve it
		return true
	case status >= 400 && provider.EdgeBlocked(body):
		// the vendor's firewall blocked this address (Alibaba Cloud's 405
		// in front of zcode.z.ai): another provider goes another way
		return true
	case status == 400, status == 422:
		return quotaWords.Match(body) || unservedWords.Match(body) || refusedWords.Match(body) || shapeWords.Match(body) || unsaidWords.Match(body) || regionWords.Match(body)
	}
	return false
}

// lateRests says whether a reply that broke off after it began, with this
// error, was the vendor failing (#733): unreachable, overloaded, out of
// quota. A conversation grown too long for the model, or a request the
// vendor turned away as it reads, would fail the same at the next asked:
// nobody rests for it. Nor does an account rest when a model generated
// empty output (#1221).
func lateRests(msg string) bool {
	return !tooLong(http.StatusBadRequest, msg) && !refusedWords.MatchString(msg) && !protectionWords.MatchString(msg) && !strings.Contains(msg, emptyReply)
}

// unsaidMargin is how far past a model's window a request's estimate
// must go to be taken as too long for it: estimate counts a token as four
// bytes, which most text runs under (Devin counted 173,954 tokens of one
// estimated at 151,851), so one past it by a fifth hardly fits.
const unsaidMargin = 1.2

// tooLongUnsaid says a failure that doesn't say why was the request being too
// long for the model, as some vendors put it: Devin's 502 "capacity
// issues", WorkBuddy's 400 "Invalid request parameters", Qoder's 400
// "Error in upstream response" — each for a conversation well past the
// model's window, and answered at a size it holds. Retried, or asked of
// another account of the model, it fails the same, and the agent, told it
// as a vendor's error, never compacts. The message it is told instead
// says the prompt is too long. Not for a rate limit, an account's
// trouble, a model it doesn't serve, a region it doesn't serve, or one
// already saying it overflowed.
func tooLongUnsaid(p provider.Provider, model string, tokens, status int, body []byte) (string, bool) {
	switch status {
	case 400, 413, 422, 500, 502, 503, 504:
	default:
		return "", false
	}
	// the words are matched decoded, too (#1669)
	body = wordsOf(body)
	if overflowed(status, body) || failure(status, body) != failOther || quotaWords.Match(body) ||
		unservedWords.Match(body) || refusedWords.Match(body) || provider.EdgeBlocked(body) || regionRefused(status, body) {
		return "", false
	}
	window := windowOf(p, model)
	if window <= 0 || float64(tokens) < float64(window)*unsaidMargin {
		return "", false
	}
	msg := fmt.Sprintf("prompt is too long: about %d tokens, more than %s's context window of %d", tokens, model, window)
	said := strings.TrimSpace(vendorMessage(body))
	if len(said) > 200 {
		said = said[:200] + "…"
	}
	// the vendor's words, unless they'd read as a limit of another kind
	if full := fmt.Sprintf("%s (%s answered %d: %s)", msg, p.Name, status, said); said != "" && tooLong(400, full) {
		return full, true
	}
	return fmt.Sprintf("%s (%s answered %d)", msg, p.Name, status), true
}

// windowOf is the tokens a provider's model takes, where known: the
// user's for the model, else its catalog entry's (Provider.WindowOf, where
// the one set for all the provider's models is no larger than the model's
// own, #2112), else the one set for all of them.
func windowOf(p provider.Provider, model string) int {
	return windowIn(provider.Served, p, model)
}

// windowIn is windowOf with the catalog read from served, for a caller
// that weighs several models to read it once.
func windowIn(served func() []provider.Entry, p provider.Provider, model string) int {
	if n := p.Contexts[model]; n > 0 {
		return n
	}
	for _, e := range served() {
		if e.Group == "" && e.Provider.ID == p.ID && (e.Model == model || e.ID == model) && e.Context > 0 {
			return e.Context
		}
	}
	return p.ContextOf(model)
}

const (
	// lastRetries is how many times the last one left is tried again after
	// a failure that passes — a busy vendor, a dropped connection.
	lastRetries = 2
	// rateRetries is as many for a rate limit, which takes longer to
	// clear than a busy moment: pauses of 1, 2 and 4s, or what Retry-After
	// says, under half a minute in all
	rateRetries = 3
	// longestPause is the longest the vendor's Retry-After is waited for
	// before that; longer, and the agent gets the error.
	longestPause = 8 * time.Second
)

// retryPause is the first pause before the last one left is tried again;
// each pause after is twice the one before.
var retryPause = time.Second

// passing says whether a failure is one that may be gone a moment later,
// and how long to wait before trying the same one again, the again'th time.
// An upstream that answered a stream request with a whole reply
// (didNotStream) isn't one: it fails the same every time it is asked.
func passing(status int, header http.Header, body []byte, again int) (time.Duration, bool) {
	wait := retryPause << again
	if d := retryAfter(header, time.Now()); d > 0 {
		wait = d
	}
	switch {
	case wait > longestPause:
		return 0, false
	case status == 408, status == 500, status == 502, status == 503, status == 504, status == 529:
		if strings.Contains(string(body), didNotStream) {
			return 0, false
		}
		return wait, again < lastRetries
	case status == 429:
		// a relay's 429 often says nothing of when (#503: "负载已饱和，请稍
		// 后再试"); a plan used up or no money left won't clear in seconds
		return wait, again < rateRetries && failure(status, body) == failRate && !creditWords.Match(wordsOf(body))
	}
	return 0, false
}

// withRoom is, of the candidates left, those another member than c's may
// answer a request of about tokens that c's model found too long: not an
// account of c's model at c's provider, which holds it no better, nor one
// whose window it is known to be past.
func withRoom(left []candidate, c candidate, tokens int) []candidate {
	var out []candidate
	for _, x := range left {
		if x.p.ID == c.p.ID && x.model == c.model {
			continue
		}
		if !holds(x, tokens) {
			continue
		}
		out = append(out, x)
	}
	return out
}

// holds is whether c's model may hold a request of about tokens: its
// window isn't known, or is larger.
func holds(c candidate, tokens int) bool {
	w := windowOf(c.p, c.model)
	return w <= 0 || tokens < w
}

// roomy leaves out, before any is asked, the candidates whose model is
// known to take less than the request (dgqyushen on Discord: OpenCode
// Zen's free DeepSeek V4.1 Flash, 200K, first in a group with a 1M
// subscription of it second). Asked, such a member only refuses it, a
// request spent against its limits, and a refusal that doesn't say why,
// for a request short of tooLongUnsaid's margin past the window, reached
// the agent as the vendor's error while the next member had room. The
// request's size is estimate's, which mostly counts low (four bytes a
// token), so a member is passed over only when the request is past its
// window by that count; one nearer may still be refused and falls over
// (withRoom). A model whose window isn't known is kept, a
// request that doesn't parse leaves every one, and so does one no
// candidate holds: the first is asked, and the agent told it overflowed,
// to compact.
func roomy(cs []candidate, pl planned, from provider.Protocol, body []byte) ([]candidate, planned) {
	if len(cs) < 2 {
		return cs, pl
	}
	served := sync.OnceValue(provider.Served) // the catalog, read once
	least, windows := 0, map[string]int{}
	key := func(c candidate) string { return c.p.ID + "\x00" + c.model }
	for _, c := range cs {
		if _, ok := windows[key(c)]; ok {
			continue
		}
		w := windowIn(served, c.p, c.model)
		windows[key(c)] = w
		if w > 0 && (least == 0 || w < least) {
			least = w
		}
	}
	// one model has nothing to choose between, and a body shorter than
	// the least window can't estimate past it: neither is parsed
	if len(windows) < 2 || least == 0 || len(body)/4 < least {
		return cs, pl
	}
	req, err := parse(from, body)
	if err != nil {
		return cs, pl
	}
	tokens := estimate(req)
	var out []candidate
	var order []Weighed
	parallel := len(pl.order) == len(cs)
	for i, c := range cs {
		if w := windows[key(c)]; w > 0 && tokens >= w {
			continue
		}
		out = append(out, c)
		if parallel {
			order = append(order, pl.order[i])
		}
	}
	if len(out) == 0 || len(out) == len(cs) {
		return cs, pl
	}
	if parallel {
		pl.order = order
	}
	return out, pl
}

// matesFirst puts first, of the candidates left, the other keys or
// accounts of the member c is of — its model, at its effort — that aren't
// resting: what one account's safety filter refused, another may answer
// (one verified for the vendor's trusted access), the same model before
// the group's next (#248). A conversation kept on the account that
// answered it last has that one alone first, and its member's other
// accounts where the member is in the group: after Sonnet, first in it,
// when Codex's gpt-6.1-sol refused.
func matesFirst(left []candidate, c candidate) {
	mate := func(x candidate) bool {
		if x.p.ID != c.p.ID || x.model != c.model || x.effort != c.effort || x.who() == c.who() {
			return false
		}
		_, resting := restOf(x.restKey())
		return !resting
	}
	var mates, others []candidate
	for _, x := range left {
		if mate(x) {
			mates = append(mates, x)
		} else {
			others = append(others, x)
		}
	}
	copy(left, append(mates, others...))
}

// matesLast puts last, of the candidates left, the other keys or accounts
// of the member c is of: what turns one of them away is in the request, so
// it turns them all away the same, and the group is better spent on a
// member that answers (#666). Antigravity refuses Claude Code's and its
// Agent SDK's system prompt whichever account is asked.
func matesLast(left []candidate, c candidate) {
	mate := func(x candidate) bool {
		if x.p.ID != c.p.ID || x.model != c.model || x.effort != c.effort || x.who() == c.who() {
			return false
		}
		_, resting := restOf(x.restKey())
		return !resting
	}
	var mates, others []candidate
	for _, x := range left {
		if mate(x) {
			mates = append(mates, x)
		} else {
			others = append(others, x)
		}
	}
	copy(left, append(others, mates...))
}

// holdWriter keeps an error reply back while another provider may still
// answer: headers and body wait until release, or are dropped for the next
// try. Anything else goes straight through — but for a stream, only once
// its first content comes: an error before that is a failure another may
// answer, as an error status is. So is a safety refusal with nothing said
// before it (#248), and a reply that isn't streamed is held whole to read
// for one.
type holdWriter struct {
	w       http.ResponseWriter
	hold    bool
	header  http.Header
	status  int
	passing bool
	held    bytes.Buffer

	stream     bool      // a stream held until its first content
	since      time.Time // when it began
	scanned    int       // how much of held has been read as events
	failure    int       // the status the stream's error stands for
	failMsg    string
	sharedPool bool // an OpenRouter upstream pool rejected this attempt

	// turnedAway: the account is asked with the system prompt Antigravity
	// answers with a 429 whatever quota it has left — Claude Code's, its
	// Agent SDK's — so the account isn't at fault and doesn't rest (#666)
	turnedAway bool

	// refused: the vendor's safety filter ended the reply before any of it
	// was said — Anthropic's stop_reason "refusal", OpenAI's content_filter
	// — which another account or model may answer (#248)
	refused bool
	// refusedAfter: the same filter ended a reply that had already begun,
	// which the scan of a held stream never sees, as the reply goes
	// through as it comes. A refusal isn't a failure of the account, so
	// nobody rests for it, whatever its timing (#248)
	refusedAfter bool
	// after is what came of the reply once it began, for a refusal in it
	// to be read event by event
	after []byte
	whole bool // a reply that isn't streamed, held whole until release
	// wholeUnsure: held whole only as the agent has a stream's headers,
	// under a type that says neither JSON nor a stream: the reply's first
	// bytes say whether it streams after all (Write)
	wholeUnsure bool

	// buffered: the vendor said it holds the reply back for safety checks,
	// which may end in a refusal: held longer (holdBuffered)
	buffered bool
	// thinking: the reply has reasoned but said nothing yet, which a
	// refusal may still end: held longer (holdThinking)
	thinking bool
	// thinkingShown: the model's vendor never refuses after reasoning
	// (refusesAfterThinking), so its reasoning goes through as it comes
	thinkingShown bool

	ended bool   // the stream's last event was written: the reply is whole
	tail  []byte // the end of the last write, for a marker split across two
	// ctx is the agent's request: a stream's last event written once it
	// has gone reached nobody, and doesn't make the reply whole (#751)
	ctx context.Context

	// alive is the request's, shared by its tries: a stream held for its
	// reasoning keeps the agent from its idle timeout with SSE comments
	// meanwhile (#751)
	alive *keptAlive
	// notes are the headers magpie says of the try (noteMember), set
	// under mu: all keepAlive sends of the try's before it has its status,
	// as until then the try is still writing header, with no lock
	notes http.Header

	first firstToken // when its first content and text came (#196)

	// stop ends the try's request to the vendor: a stream whose error
	// came before any content has failed, and one that kept its
	// connection open after it — a 429 said as an event — kept the agent
	// waiting with nothing sent, the next account never asked
	stop func()

	// streams: the agent asked for a stream, which watch keeps alive
	// while the vendor says nothing (#947)
	streams bool
	// heard is when the vendor last gave the try something to write, and
	// wrote when the agent was last written to; atLine says that was a
	// whole line, after which an SSE comment may go
	heard, wrote time.Time
	atLine       bool

	// mu keeps a try's writes apart from watch, which ends a try that is
	// slow to start and keeps a quiet one's agent alive from its own
	// goroutine
	mu sync.Mutex
	// firstWait is how long a try may take to its first content before
	// the next member is asked (Group.FirstToken), 0 for as long as it
	// takes; slow says it took longer, and was let go with nothing sent
	firstWait time.Duration
	slow      bool

	// loop reads a streamed reply for a loop it won't leave (#1359), nil
	// when Settings' NoLoopGuard is on or the agent asked for no stream;
	// looped is what the agent was told once one was found, the reply
	// ended there
	loop   *loopGuard
	looped string
	// reask, when the try's reply can be asked again in place
	// (streamTranslated), is told of a loop first, and says whether the
	// reply is asked again instead of ended: the guard then reads the
	// next try's afresh
	reask func(loopTrip) bool
	// reasked is how many times reask asked the reply again in place,
	// tries of the request its route doesn't list (#2436)
	reasked int
	// reloop: a reply passed through, whose reasoning loops before it
	// said anything, may be let go for the request to ask it again
	// (loopReasks, #2436); relooped says it was
	reloop, relooped bool

	// wantWhole: a reply wanted only whole, a compaction's summary (#2274): its
	// stream is held to its end, never let through at its first content,
	// so an error or a cut anywhere in it is a failure the next candidate
	// answers, and its account rests for, as one before any content is.
	// Let through at its first content, Antigravity's "the reply ended
	// before it was complete" and its 429 halfway went to the summary
	// as the only answer, the next account never asked
	wantWhole bool
}

// onLoop sets what is told of a loop before it ends the reply (reask),
// nil for nobody.
func (h *holdWriter) onLoop(f func(loopTrip) bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.reask = f
}

// errSlowStart is what a try's writes get once it was let go for taking
// longer than its group waits for a first token.
var errSlowStart = errors.New("let go: no first token in time")

// errLooped is what a try's writes get once its reply was ended for
// looping (cutLoop).
var errLooped = errors.New("ended: the reply was stuck in a loop")

func newHoldWriter(w http.ResponseWriter, hold bool) *holdWriter {
	return &holdWriter{w: w, hold: hold, header: http.Header{}, first: firstToken{start: time.Now()}}
}

func (h *holdWriter) Header() http.Header { return h.header }

// note sets a header magpie says of the try, which keepAlive may send
// from watch's goroutine before the try has its status.
func (h *holdWriter) note(k, v string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.header.Set(k, v)
	if h.notes == nil {
		h.notes = http.Header{}
	}
	h.notes.Set(k, v)
}

func (h *holdWriter) WriteHeader(code int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.writeHeader(code)
}

func (h *holdWriter) writeHeader(code int) {
	if h.status != 0 || h.slow {
		return
	}
	h.status = code
	if h.hold && code >= 400 {
		return
	}
	if h.hold && strings.HasPrefix(h.header.Get("Content-Type"), "text/event-stream") {
		h.stream, h.since = true, time.Now()
		return
	}
	if h.hold && strings.HasPrefix(h.header.Get("Content-Type"), "application/json") {
		// read whole for a refusal once the try is over (settle)
		h.whole = true
		return
	}
	if h.hold && h.alive != nil && h.alive.sent {
		// any other reply, once the agent has a stream's headers: held
		// whole for release to send as that stream, unless it begins as
		// one
		h.whole, h.wholeUnsure = true, true
		return
	}
	h.pass()
}

func (h *holdWriter) pass() {
	if h.alive != nil && h.alive.sent {
		// the agent has the stream's headers already, from keepAlive
		h.passing = true
		return
	}
	dst := h.w.Header()
	for k, v := range h.header {
		if k != resetsHeader && k != refusedHeader { // magpie's own notes, for restAfter and settle
			dst[k] = v
		}
	}
	h.w.WriteHeader(h.status)
	h.passing, h.wrote, h.atLine = true, time.Now(), true
}

func (h *holdWriter) Write(b []byte) (int, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.slow {
		return 0, errSlowStart
	}
	if h.looped != "" || h.relooped {
		return 0, errLooped
	}
	if h.status == 0 {
		h.writeHeader(http.StatusOK)
	}
	if h.loop != nil && !h.whole && h.status < 400 {
		if t, ok := h.loop.feed(b); ok {
			switch {
			case h.reask != nil && h.reask(t):
				h.reasked++
				h.loop = &loopGuard{}
			case h.reask == nil && h.mayReloop(t):
				return h.letGoLoop(b)
			default:
				return h.cutLoop(b, t)
			}
		}
	}
	h.see(b)
	h.first.see(b)
	h.heard = time.Now()
	if h.wholeUnsure {
		head := append(h.held.Bytes()[:h.held.Len():h.held.Len()], b...)
		if sse, sure := sseStart(head); sure {
			h.wholeUnsure = false
			if sse {
				// a stream under a type that doesn't say so: held as a
				// stream from here, its events read as they come, so an
				// error before anything is said still goes to the next
				// candidate. It went through at once before, and a 200
				// that only framed a reply and then failed reached the
				// agent (#1418)
				h.whole, h.stream, h.since = false, true, time.Now()
			}
		}
	}
	if h.first.first != 0 || h.passing {
		h.refusalAfter(b)
	}
	if h.passing {
		h.sent(b)
		return h.w.Write(b)
	}
	n, err := h.held.Write(b)
	if h.stream && h.failure == 0 {
		h.scan()
	}
	return n, err
}

// cutLoop ends a reply found stuck in a loop (loopGuard): what came of it
// goes to the agent as it would have, the held part of it too, and then
// the stream's error in the agent's protocol, which Codex asks again on
// and other agents show; the vendor's request is let go, and the try's
// writes after it fail. The stream is no longer held for another to
// answer: its loop was said as it came, unless the model's reasoning is
// held for a refusal, and then it goes now.
func (h *holdWriter) cutLoop(b []byte, t loopTrip) (int, error) {
	msg := t.message()
	if h.passing {
		h.sent(b)
		h.w.Write(b)
	} else {
		h.held.Write(b)
		h.flow()
	}
	proto := provider.Chat
	if h.alive != nil {
		proto = h.alive.proto
	}
	// what is appended begins after a blank line, as in passthrough: the
	// reply's last write may have stopped mid-line, and an event joined
	// onto it is one the client can't parse (TestLoopCutMidLine)
	if h.atLine {
		io.WriteString(h.w, "\n")
	} else {
		io.WriteString(h.w, "\n\n")
	}
	streamError(h.w, proto, http.StatusBadGateway, msg)
	h.looped, h.ended = msg, true
	h.flush()
	if h.stop != nil {
		h.stop()
	}
	return 0, errLooped
}

// mayReloop says whether a reply passed through, found stuck in a loop
// (t), is let go for the request to ask it again (letGoLoop) rather than
// ended: its reasoning looped before it said a text or a call, the
// request has an ask left (reloop), and the next try's stream can follow
// what the agent has. Nothing of it sent, any can; sent, only a Chat
// stream, whose chunks are deltas the agent adds up: a second stream's
// follow the first's as they would its own. An Anthropic or Responses
// stream begun can't be followed by another's message_start or
// response.created, so it ends with the loop's error, as before.
func (h *holdWriter) mayReloop(t loopTrip) bool {
	if !h.reloop || !t.reasoning || h.loop.spoke || h.alive == nil || h.ctx != nil && h.ctx.Err() != nil {
		return false
	}
	return !h.passing || h.alive.proto == provider.Chat
}

// letGoLoop lets a reply go whose reasoning looped before it said a word
// (mayReloop), for the request to ask it again: the vendor's request is
// let go, and the try's writes after it fail. Held, none of it reaches
// the agent; passing, its events go up to the end of the one the loop was
// found in, for the next try's stream to begin on a whole event.
func (h *holdWriter) letGoLoop(b []byte) (int, error) {
	if h.passing {
		b = b[:max(len(b)-len(h.loop.pending), 0)]
		h.sent(b)
		h.w.Write(b)
		h.flush()
		// the next try's stream follows this one: its 200 and headers
		// are not sent again
		h.alive.sent = true
	} else {
		h.held.Reset()
	}
	h.relooped = true
	if h.stop != nil {
		h.stop()
	}
	return 0, errLooped
}

// sseStart reports whether a body that begins with head is server-sent
// events, by the field its first line begins with, and whether head is
// enough to tell.
func sseStart(head []byte) (sse, sure bool) {
	head = bytes.TrimLeft(head, " \t\r\n")
	if len(head) == 0 {
		return false, false
	}
	for _, field := range []string{"data:", "event:", "id:", "retry:", ":"} {
		if bytes.HasPrefix(head, []byte(field)) {
			return true, true
		}
		if len(head) < len(field) && strings.HasPrefix(field, string(head)) {
			return false, false
		}
	}
	return false, true
}

// streamEnds are how each protocol's stream says it is over, in every
// spelling a relay sends: SSE makes the space after "data:" and "event:"
// optional, and JSON the one after a colon (data:[DONE] from a relay was
// logged 499 when the agent hung up on it, #1978). A JSON marker can only
// appear outside a quoted string, as text that says so is escaped; an SSE
// one starts a line, which text inside the JSON can't.
var streamEnds = [][]byte{
	[]byte(`"type":"response.completed"`), []byte(`"type": "response.completed"`), // Responses
	[]byte(`"type":"response.incomplete"`), []byte(`"type": "response.incomplete"`),
	[]byte(`"type":"message_stop"`), []byte(`"type": "message_stop"`), // Anthropic
	[]byte("\nevent: message_stop"), []byte("\nevent:message_stop"),
	[]byte("\ndata: [DONE]"), []byte("\ndata:[DONE]"), // Chat Completions
}

// see notes a stream's last event going by. An agent may hang up as soon as
// it has that — Codex does — and a reply it had whole is not canceled.
func (h *holdWriter) see(b []byte) {
	if h.ended || h.ctx != nil && h.ctx.Err() != nil {
		return
	}
	buf := append(h.tail, b...)
	if len(h.tail) == 0 {
		buf = append([]byte{'\n'}, b...) // the stream starts a line
	}
	for _, m := range streamEnds {
		if bytes.Contains(buf, m) {
			h.ended = true
			return
		}
	}
	h.tail = append(h.tail[:0], buf[max(len(buf)-32, 0):]...)
}

// holdLongest is the longest a stream is held waiting for its first
// content, and holdMost the most of it.
const (
	holdLongest = 15 * time.Second
	holdMost    = 1 << 20
)

// holdBuffered is how long a stream is held once the ChatGPT backend has
// said it holds the reply back for extra safety checks (response.metadata,
// safety_buffering): gpt-6.x at xhigh said nothing for 35s and then failed
// with bio_policy, which went to Codex as its "This content can't be
// shown" once 15s had let the stream through (#248). Codex waits 300s for
// a stream's next event.
const holdBuffered = 4 * time.Minute

// holdThinking is how long a stream is held while all it has is reasoning,
// shown to nobody yet: Claude refused Claude Code after 10–25s of thinking,
// which had let the stream through, so Claude Code got the refusal ("…'s
// safeguards stopped the response above") and the next account was never
// asked (#248). A reply that goes on to say something is let through, its
// reasoning with it, as soon as it does.
const holdThinking = 4 * time.Minute

// holdLead is how long a stream with nothing but the frames that come
// before a reply is held, when its agent is kept alive meanwhile
// (keptQuiet): as long as one that only reasons, under the 300s Codex
// waits for its next event. With nothing to keep the agent alive (a
// Gemini stream), it is let through at holdLongest as before.
const holdLead = holdThinking

// keptQuiet says whether the agent of a held stream is kept alive with
// SSE comments while it is held (keepQuiet, keepAlive): it asked for a
// stream, in a protocol that takes a comment.
func (h *holdWriter) keptQuiet() bool {
	return h.streams && h.alive != nil && h.alive.proto != provider.Gemini
}

// refusesAfterThinking tells whether a model's vendor may end a reply that
// has only reasoned with its safety filter's refusal: Claude's stop_reason
// refusal, OpenAI's content_filter or bio_policy, Gemini's SAFETY (#248).
// Anybody else's reasoning — GLM's, DeepSeek's, Kimi's… — is shown as it
// comes: held, GLM on a ZCode account through a group showed Claude Code
// its thinking only once the text began, all at once (悠悠哥 on Discord).
func refusesAfterThinking(model string) bool {
	if modelFamily(model) != "" {
		return true
	}
	m := strings.ToLower(model)
	if i := strings.LastIndex(m, "/"); i >= 0 {
		m = m[i+1:]
	}
	return strings.HasPrefix(m, "gemini")
}

// scan reads the held stream's events so far: an error before any content
// fails it; content, or waiting too long for it, lets it through.
func (h *holdWriter) scan() {
	for {
		rest := h.held.Bytes()[h.scanned:]
		end := eventEnd(rest)
		if end < 0 {
			break
		}
		h.scanned += end
		switch kind, status, msg := streamEvent(rest[:end]); kind {
		case eventLead:
			continue
		case eventBuffering:
			h.buffered = true
			continue
		case eventThinking:
			if h.thinkingShown && !h.wantWhole {
				h.flow()
				return
			}
			h.thinking = true
			continue
		case eventError, eventRefusalError:
			h.failure, h.failMsg = status, msg
			h.refused = kind == eventRefusalError
			if h.stop != nil {
				h.stop()
			}
			return
		case eventRefusal:
			// A refusal's stop marker can still have usage and the
			// protocol's terminator after it; an error above cannot.
			h.failure, h.failMsg, h.refused = status, msg, true
			return
		}
		if h.wantWhole {
			if why, ok := endedIncomplete(rest[:end]); ok {
				h.failure, h.failMsg = http.StatusBadGateway, why
				return
			}
			continue // content, held with the rest (whole)
		}
		h.flow()
		return
	}
	if h.wantWhole {
		return
	}
	if h.alive.tooQuiet(0) {
		// Codex has gone as long as it waits for an event: what is held
		// goes now, or it hangs up (agentQuietMost)
		h.flow()
		return
	}
	longest := holdLongest
	if h.buffered {
		longest = holdBuffered
	}
	if h.thinking {
		longest = max(longest, holdThinking)
	}
	if h.keptQuiet() {
		// a stream of nothing but its frames — response.created, pings,
		// an empty message begun — while its agent is kept alive with
		// comments: let through at 15s, the 200 the agent then had made
		// the vendor's server_is_overloaded 21s later the agent's error,
		// with the group's next member never asked (#1418)
		longest = max(longest, holdLead)
	}
	// a group that asks the next member when one is slow to start holds
	// the stream until then, for nothing of it to have reached the agent
	waiting := h.firstWait > 0 && h.first.first == 0
	if waiting {
		longest = max(longest, h.firstWait+time.Second)
	}
	if h.held.Len() > holdMost || time.Since(h.since) > longest {
		h.flow()
		return
	}
	if (h.thinking || h.buffered || waiting || h.keptQuiet()) && (time.Since(h.since) >= keepHeldAfter || h.alive != nil && h.alive.sent) {
		h.keepAlive()
	}
}

// keepHeldAfter is how long a stream held for its reasoning waits before
// its agent is first kept alive, as long as a stream with nothing in it
// is held where its agent can't be (holdLongest); a refusal after it still
// goes to another account,
// whose stream follows the comments in the same response.
var keepHeldAfter = holdLongest

// keptAlive is what a request's held streams have sent its agent ahead of
// a reply: the stream's headers and SSE comments, nothing of the reply.
type keptAlive struct {
	proto provider.Protocol
	sent  bool      // the stream's 200 and headers went out
	at    time.Time // the last comment
	// told is when the agent was last sent anything of a reply, else when
	// it asked; streams, whether it asked for a stream
	told    time.Time
	streams bool
	// Only opted-in Claude cache reporting can defer initial keepalives.
	// Selection releases it before process startup; expiry keeps the stream alive.
	cacheReportUntil time.Time
}

// agentQuietMost is the longest a streaming Responses agent goes with no
// event while its tries are held, one after another, and the pauses
// between them. Codex counts only events toward its stream idle timeout,
// 300s by default, not the SSE comments keepAlive sends: codex-cli 0.162
// on a server sending nothing but ": keepalive" every 2s, with
// stream_idle_timeout_ms 6000, failed "stream disconnected before
// completion: idle timeout waiting for SSE" and reconnected (fadenoob on
// Discord). Each try was held for up to holdThinking or holdLead by
// itself, so a second held try, or a group's pause (#1418), went past it.
var agentQuietMost = 4 * time.Minute

// tooQuiet says whether a Responses agent that has had no event of its
// reply would go agentQuietMost without one after d more.
func (a *keptAlive) tooQuiet(d time.Duration) bool {
	return a != nil && a.streams && a.proto == provider.Responses && !a.told.IsZero() && time.Since(a.told)+d >= agentQuietMost
}

// keepAlive tells the agent of a stream held past keepHeldAfter for its
// reasoning that it goes on, every keepaliveEvery: held for up to
// holdThinking (4 minutes), the agent heard nothing at all, and Alma's
// idle timeout for a reasoning model, 240s, ended the turn first (#751). A
// comment is no event in any protocol, so another account may still answer
// after it, its stream going on in the same response (pass).
func (h *holdWriter) keepAlive() {
	a := h.alive
	// a Gemini stream has none, as geminiEncoder.keepalive: agy fails on
	// the comment ("invalid stream chunk: : keepalive", #934)
	if a == nil || a.proto == provider.Gemini || time.Since(a.at) < keepaliveEvery {
		return
	}
	if !a.sent {
		if !a.cacheReportUntil.IsZero() {
			if time.Now().Before(a.cacheReportUntil) {
				return
			}
			a.cacheReportUntil = time.Time{}
			h.header.Del("X-Magpie-Cache-Marks-Dropped")
			h.notes.Del("X-Magpie-Cache-Marks-Dropped")
			log.Printf("claude: cache-mark report timed out before run selection; streaming without the dropped-mark header")
		}
		// the try's header is whole once it has its status (WriteHeader,
		// under mu); before, the vendor's are still being copied into it
		// from the try's goroutine, and only magpie's notes are read
		src := h.header
		if h.status == 0 {
			src = h.notes
		}
		dst := h.w.Header()
		for k, v := range src {
			if k != resetsHeader && k != refusedHeader && k != "Content-Length" {
				dst[k] = slices.Clone(v)
			}
		}
		dst.Set("Content-Type", "text/event-stream; charset=utf-8")
		h.w.WriteHeader(http.StatusOK)
		a.sent = true
	}
	// no blank line after it, as sseWriter.comment
	_, _ = io.WriteString(h.w, ": keepalive\n")
	a.at = time.Now()
	h.wrote, h.atLine = a.at, true
	if f, ok := h.w.(http.Flusher); ok {
		f.Flush()
	}
}

// sent notes b going to the agent.
func (h *holdWriter) sent(b []byte) {
	if len(b) > 0 {
		h.wrote, h.atLine = time.Now(), b[len(b)-1] == '\n'
		if h.alive != nil {
			h.alive.told = h.wrote
		}
	}
}

// refusalAfter reads the events of a reply that has begun, for the safety
// filter's refusal in one of them. The reply goes through as it comes, so
// the scan that reads a stream held for its first content never sees an
// event that comes after it, and the filter refusing a turn it had begun
// is no failure of the account, as one it refuses before any of it is said
// is not (#248). What is read is kept only as far as the event it is in is
// whole, as a write may end in the middle of one.
func (h *holdWriter) refusalAfter(b []byte) {
	// Every write is read, not only one that looks like a refusal: an
	// event's name may come in one write and its data in the next (#2400).
	// Only an unfinished event's bytes are kept.
	buf := b
	if len(h.after) > 0 {
		h.after = append(h.after, b...)
		buf = h.after
	}
	for {
		end := eventEnd(buf)
		if end < 0 {
			break
		}
		ev := buf[:end]
		buf = buf[end:]
		if mayRefuse(ev) {
			if kind, _, _ := streamEvent(ev); kind == eventRefusal || kind == eventRefusalError {
				h.refusedAfter = true
			}
		}
	}
	if len(buf) == 0 || len(buf) > holdMost {
		h.after = nil
		return
	}
	h.after = append([]byte(nil), buf...)
}

// mayRefuse is whether an event may be the safety filter's refusal, by the
// words its shapes carry, before it is read as JSON at all: every event of
// a reply that has begun goes through this.
func mayRefuse(ev []byte) bool {
	for _, w := range refusalSays {
		if bytes.Contains(ev, w) {
			return true
		}
	}
	return false
}

// refusalSays are the words the events a vendor's filter refuses a reply
// with carry: an error's code, or its event's name (event: error, with
// only a message for data), a stop reason's, a finish reason's, a Gemini
// block reason's.
var refusalSays = [][]byte{
	[]byte(`error`), []byte(`failed`), []byte(`refusal`), []byte(`filter`),
	[]byte(`incomplete`), []byte(`finishReason`), []byte(`blockReason`),
}

// flow lets a held stream through, and what follows it.
func (h *holdWriter) flow() {
	h.pass()
	h.sent(h.held.Bytes())
	h.w.Write(h.held.Bytes())
	h.held.Reset()
	h.flush()
}

func (h *holdWriter) Flush() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.flush()
}

func (h *holdWriter) flush() {
	if f, ok := h.w.(http.Flusher); ok && h.passing {
		f.Flush()
	}
}

// code is the status a try failed with: the reply's, or its stream's
// error's.
func (h *holdWriter) code() int {
	if h.failure != 0 {
		return h.failure
	}
	return h.status
}

// errBody is what the vendor said of the failure.
func (h *holdWriter) errBody() []byte {
	if h.failure != 0 {
		return []byte(h.failMsg)
	}
	return h.held.Bytes()
}

// settle reads a reply held, once the try is over, for a refusal with
// nothing said: a reply held whole, or an error status that is one.
func (h *holdWriter) settle() {
	if h.passing || h.failure != 0 {
		return
	}
	if h.status >= 400 {
		// an error status saying the safety filter refused it: OpenAI's
		// 400 bio_policy, which Codex was handed with the next account
		// never asked (#248)
		if msg := h.header.Get(refusedHeader); msg != "" {
			h.failure, h.failMsg, h.refused = refusedStatus, msg, true
		} else if msg, ok := policyRefusal(h.held.Bytes()); ok {
			h.failure, h.failMsg, h.refused = refusedStatus, msg, true
		}
		return
	}
	if h.wantWhole && h.stream && h.status < 400 && !h.ended && (h.ctx == nil || h.ctx.Err() == nil) {
		// a reply wanted whole that stopped before its last event, with
		// no error said (#2274)
		h.failure, h.failMsg = http.StatusBadGateway, errEndedShort.Error()
		return
	}
	if !h.whole {
		return
	}
	if msg, ok := refusedReply(h.held.Bytes()); ok {
		h.failure, h.failMsg, h.refused = refusedStatus, msg, true
		return
	}
	if h.alive != nil && h.alive.sent && h.status < 400 && wholeEvents(h.alive.proto, h.held.Bytes()) == nil {
		// a 200 that is no reply of the protocol's, once the agent has a
		// stream's headers: it can't go as that stream, so it failed, as
		// a translated reply that didn't stream does, for the next to
		// answer
		h.failure, h.failMsg = http.StatusBadGateway, didNotStream+": "+provider.APIError(h.held.Bytes(), "unexpected reply")
	}
}

// failed reports a held error another provider could answer instead.
func (h *holdWriter) failed() bool {
	if h.refused {
		return !h.passing
	}
	return !h.passing && h.code() >= 400 && retryable(h.code(), h.errBody())
}

// mayAskAgain tells whether a failure now is still held, for the request
// to ask again or of another: nothing of the try has reached the agent.
func (h *holdWriter) mayAskAgain() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.hold && !h.passing
}

// handBack sends a refusal held with nothing said as the vendor's own
// reply, a 200 that ends with its stop reason, and says whether it could:
// not a refusal said as an error status or event, which is no reply.
func (h *holdWriter) handBack() bool {
	if !h.refused || h.passing || h.status == 0 || h.status >= 400 || h.held.Len() == 0 {
		return false
	}
	h.failure, h.failMsg = 0, ""
	h.release()
	return true
}

// refusalAsksAgain says whether a request refused n times by the vendor's
// safety filter is asked of the next account or member left: as many
// times as Settings' RefusalRetries says, every one left when it is unset
// (#248).
func refusalAsksAgain(n int) bool {
	retries := settings.Load().RefusalRetries
	return retries == nil || *retries < 0 || n <= *retries
}

// release sends a held reply after all: nobody else is left to try.
func (h *holdWriter) release() {
	if h.passing || h.status == 0 {
		return
	}
	if h.alive != nil && h.alive.sent && !h.stream {
		h.passing = true
		switch {
		case h.failure != 0:
			// a 200 that is no reply of the protocol's (settle)
			who := cmp.Or(h.header.Get(providerHeader), "the provider")
			streamError(h.w, h.alive.proto, h.failure, who+" "+h.failMsg)
		case h.status >= 400:
			// an error status, once the agent has a stream: told as its error
			streamError(h.w, h.alive.proto, h.status, provider.APIError(h.held.Bytes(), http.StatusText(h.status)))
		default:
			// a reply given whole by a vendor that ignored stream:true,
			// after the agent was kept alive: sent as the stream it asked
			// for, not as an error "OK" with the reply in it
			wholeAsStream(h.w, h.alive.proto, h.held.Bytes())
		}
		return
	}
	h.pass()
	h.w.Write(h.held.Bytes())
	h.flush()
}

// watchEvery is how often watch looks at a try.
var watchEvery = time.Second

// keepQueued keeps the agent of a stream alive while its try waits for a
// slot of its key's or account's (MaxConcurrency) or for room in its
// minute (MaxRPM), before anything is sent to the vendor: past
// keepHeldAfter it is sent the stream's 200 and SSE comments
// (keepAlive), every keepaliveEvery for as long as the wait lasts, as a
// try's held stream is. A wait of up to 2 minutes for the minute, or
// QueueWait's for a slot, sent the agent nothing at all, which an agent's
// or a proxy's timeout for its headers ended first (coeo91 on Discord:
// WorkBuddy, Trae and Qoder said the request timed out). Once they are
// sent the try is held (hold), so that a failure, or the queue turning it
// away, reaches the agent as the stream's error (failTo), and another
// candidate may still answer in the same stream. A wait shorter than
// keepHeldAfter sends nothing, its 429 still a status with its
// Retry-After. The returned func ends it, and returns once it has.
func (h *holdWriter) keepQueued() func() {
	if !h.streams || h.alive == nil || h.alive.proto == provider.Gemini {
		return func() {}
	}
	done, over := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(over)
		tick := time.NewTicker(watchEvery)
		defer tick.Stop()
		began := time.Now()
		for {
			select {
			case <-done:
				return
			case <-tick.C:
				h.mu.Lock()
				if (time.Since(began) >= keepHeldAfter || h.alive.sent) && (h.ctx == nil || h.ctx.Err() == nil) {
					h.keepAlive()
					if h.alive.sent {
						h.hold = true
					}
				}
				h.mu.Unlock()
			}
		}
	}()
	return func() {
		close(done)
		<-over
	}
}

// watch lets the try go — stop, with slow said — once firstWait passes
// with no first content and nothing of it sent to the agent: the stream
// held, or no reply begun at all. And it keeps the agent of a stream alive
// while the vendor says nothing (keepQuiet), a vendor that says nothing
// running no scan. The returned func ends the watch, and returns once it
// has.
func (h *holdWriter) watch() func() {
	first := h.firstWait > 0 && h.stop != nil
	if !first && !h.streams {
		return func() {}
	}
	done, over := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(over)
		var deadline <-chan time.Time
		if first {
			t := time.NewTimer(h.firstWait)
			defer t.Stop()
			deadline = t.C
		}
		tick := time.NewTicker(watchEvery)
		defer tick.Stop()
		h.mu.Lock()
		began := time.Now()
		if h.heard.IsZero() {
			h.heard = began // the request to the vendor, nothing heard yet
		}
		h.mu.Unlock()
		for {
			select {
			case <-done:
				return
			case <-tick.C:
				h.mu.Lock()
				if first && h.started() {
					first = false
				}
				if !first && !h.streams {
					h.mu.Unlock()
					return
				}
				// an agent already kept alive (keepQueued, an earlier try)
				// goes on hearing one every keepaliveEvery: waiting
				// keepHeldAfter again left it up to twice that with none
				if time.Since(began) >= keepHeldAfter || h.alive != nil && h.alive.sent {
					h.keepQuiet()
				}
				h.mu.Unlock()
			case <-deadline:
				deadline = nil
				if !first {
					continue
				}
				h.mu.Lock()
				if !h.started() {
					h.slow = true
				}
				h.mu.Unlock()
				if h.slow {
					h.stop()
					return
				}
				first = false
			}
		}
	}()
	return func() {
		close(done)
		<-over
	}
}

// keepQuiet keeps the agent of a stream alive with SSE comments while the
// vendor says nothing, every keepaliveEvery for up to keepaliveLongest
// since it last did: a vendor that sent its 200 and response.created, then
// nothing while it reasoned, had the stream held with none of it sent,
// and Cloudflare in front of a remote magpie ended the request at 125s
// (524) with the agent sent nothing at all; one quiet mid-reply was reset
// by it as well (#947). Held, the agent is sent the stream's headers and
// comments only (keepAlive), none of the try, which another account may
// still answer instead; passed, a comment goes between two lines of it.
func (h *holdWriter) keepQuiet() {
	if h.slow || h.relooped || h.ended || h.alive == nil || h.alive.proto == provider.Gemini || h.ctx != nil && h.ctx.Err() != nil {
		return
	}
	if !h.heard.IsZero() && time.Since(h.heard) >= keepaliveLongest {
		return // a stream stuck this long is left for a timeout to end
	}
	if !h.passing && h.stream && h.failure == 0 && !h.whole && !h.wantWhole && h.held.Len() > 0 && h.alive.tooQuiet(0) {
		// a stream held while its vendor is quiet: Codex would hang up
		// before the next event let it through (agentQuietMost)
		h.flow()
		return
	}
	if !h.passing {
		// only a stream, no reply yet to an agent that asked for one, or
		// one yet to say whether it streams (wholeUnsure), none of it sent;
		// an error held is told as the stream's own once the 200 is out
		if h.hold && h.failure == 0 && (!h.whole || h.wholeUnsure) && h.status < 400 && (h.stream || h.status == 0 || h.wholeUnsure) {
			h.keepAlive()
		}
		return
	}
	if !h.atLine || time.Since(h.wrote) < keepaliveEvery || !strings.HasPrefix(h.w.Header().Get("Content-Type"), "text/event-stream") {
		return
	}
	// no blank line after it, as sseWriter.comment
	_, _ = io.WriteString(h.w, ": keepalive\n")
	h.wrote = time.Now()
	if f, ok := h.w.(http.Flusher); ok {
		f.Flush()
	}
}

// started says whether the try has begun its reply, or ended, as far as
// watch need know: its first content, anything sent on to the agent,
// a failure, or a reply that isn't streamed.
func (h *holdWriter) started() bool {
	return h.first.first != 0 || h.passing || h.ended || h.failure != 0 || h.whole || h.status >= 400
}

// endedIncomplete says a Responses event ends its reply cut short —
// response.incomplete, or a completed one whose status says so — and why:
// for a reply wanted whole (wantWhole), no answer (#2274). A filter's
// reason is a refusal, read before this (streamEvent).
func endedIncomplete(ev []byte) (string, bool) {
	if !bytes.Contains(ev, []byte("incomplete")) {
		return "", false
	}
	var data []byte
	for _, ln := range bytes.Split(ev, []byte("\n")) {
		if ln = bytes.TrimRight(ln, "\r"); bytes.HasPrefix(ln, []byte("data:")) {
			data = append(data, bytes.TrimSpace(ln[5:])...)
		}
	}
	var v struct {
		Type     string `json:"type"`
		Response struct {
			Status            string `json:"status"`
			IncompleteDetails *struct {
				Reason string `json:"reason"`
			} `json:"incomplete_details"`
		} `json:"response"`
	}
	if json.Unmarshal(data, &v) != nil {
		return "", false
	}
	if v.Type != "response.incomplete" && (v.Type != "response.completed" || v.Response.Status != "incomplete") {
		return "", false
	}
	why := "unknown"
	if d := v.Response.IncompleteDetails; d != nil && d.Reason != "" {
		why = d.Reason
	}
	return incompleteReply + " (" + why + ")", true
}

// incompleteReply opens what a reply wanted whole that ended incomplete
// failed with (endedIncomplete).
const incompleteReply = "the reply ended incomplete"

// eventEnd is where the first whole event in b ends, or -1.
func eventEnd(b []byte) int {
	for i := 0; i+1 < len(b); i++ {
		if b[i] != '\n' {
			continue
		}
		if b[i+1] == '\n' {
			return i + 2
		}
		if b[i+1] == '\r' && i+2 < len(b) && b[i+2] == '\n' {
			return i + 3
		}
	}
	return -1
}

const (
	eventContent = iota
	eventLead    // what comes before a reply's content: a start, a ping
	eventError
	eventRefusal      // the reply's end, by the vendor's safety filter
	eventRefusalError // the filter's error event: canceled like eventError
	eventBuffering    // a lead saying the reply is held back for safety checks
	eventThinking     // reasoning, before anything is said: a refusal may yet end it
)

// refusedStatus is what a refusal with nothing said is answered as: a
// request the agent is told not to send again as it is, rather than a
// reply that looks whole but empty, which Codex asks for again and again,
// each time paying for the prompt (#248).
const refusedStatus = http.StatusBadRequest

// filterReasons are how a vendor says its safety filter stopped the reply:
// Anthropic's stop_reason, OpenAI's finish_reason and incomplete reason,
// an OpenAI or Azure error's code, and Gemini's finishReason and
// blockReason.
var filterReasons = map[string]string{
	"refusal":                  "refusal",
	"content_filter":           "content_filter",
	"content_policy_violation": "content_filter",
	"SAFETY":                   "safety",
	"PROHIBITED_CONTENT":       "safety",
	"BLOCKLIST":                "safety",
	"SPII":                     "safety",
	"IMAGE_SAFETY":             "safety",
}

// refusedNote is what a refusal is noted as: the vendor's own reason.
func refusedNote(reason string) string {
	return "safety filter: " + reason
}

// refusedDetail is a refusal's note with what Anthropic's classifier said
// of it in stop_details, when it said anything (#1768: which of cyber,
// bio, frontier_llm… it was, for a user to tell one refusal from
// another): its category as given, unknown ones too, and its
// explanation, the vendor's own words, kept to a line. None is made up
// when it gave none.
func refusedDetail(reason string, details json.RawMessage) string {
	var d struct {
		Category    *string `json:"category"`
		Explanation *string `json:"explanation"`
	}
	note := refusedNote(reason)
	if len(details) == 0 || json.Unmarshal(details, &d) != nil {
		return note
	}
	var said []string
	if d.Category != nil && strings.TrimSpace(*d.Category) != "" {
		said = append(said, "category "+strings.TrimSpace(*d.Category))
	}
	if d.Explanation != nil && strings.TrimSpace(*d.Explanation) != "" {
		e := strings.Join(strings.Fields(*d.Explanation), " ")
		if r := []rune(e); len(r) > 200 {
			e = string(r[:200]) + "…"
		}
		said = append(said, e)
	}
	if len(said) == 0 {
		return note
	}
	return note + " (" + strings.Join(said, ": ") + ")"
}

// streamPart is what one event of a reply carries of its content, in any
// protocol, to tell a reply begun from its empty frame (#248).
type streamPart struct {
	Type  string `json:"type"`
	Text  string `json:"text"`
	Think string `json:"thinking"`
	// a Responses item's
	Content []struct {
		Text    string `json:"text"`
		Refusal string `json:"refusal"`
	} `json:"content"`
	Summary []struct {
		Text string `json:"text"`
	} `json:"summary"`
}

// thought tells whether a part is reasoning, said or not yet: a thinking
// block, a reasoning item or its summary. It says nothing to the reader.
func (p streamPart) thought() bool {
	switch p.Type {
	case "thinking", "redacted_thinking", "summary_text", "reasoning_text", "reasoning":
		return true
	}
	return false
}

// said tells whether a part says anything an agent would show or act on:
// text, reasoning, a call. Of what isn't known, a call or a tool's part
// (web_search_call, mcp_tool_use, server_tool_use, ...) says something;
// anything else only frames the reply until something does (#1418).
func (p streamPart) said() bool {
	switch p.Type {
	case "text", "output_text", "summary_text", "reasoning_text":
		return p.Text != ""
	case "thinking":
		return p.Think != ""
	case "redacted_thinking":
		return false
	case "message":
		for _, c := range p.Content {
			if c.Text != "" || c.Refusal != "" {
				return true
			}
		}
		return false
	case "reasoning":
		for _, c := range p.Summary {
			if c.Text != "" {
				return true
			}
		}
		for _, c := range p.Content {
			if c.Text != "" {
				return true
			}
		}
		return false
	}
	return strings.Contains(p.Type, "call") || strings.Contains(p.Type, "tool") || strings.HasPrefix(p.Type, "mcp_")
}

// streamEvent says what one server-sent event of a reply is, in any of the
// protocols an agent speaks: the start of a reply, its content, or an
// error — with the status that error stands for.
func streamEvent(ev []byte) (kind, status int, msg string) {
	var name string
	var data []byte
	for _, ln := range bytes.Split(ev, []byte("\n")) {
		ln = bytes.TrimRight(ln, "\r")
		switch {
		case bytes.HasPrefix(ln, []byte("event:")):
			name = strings.TrimSpace(string(ln[6:]))
		case bytes.HasPrefix(ln, []byte("data:")):
			data = append(data, bytes.TrimSpace(ln[5:])...)
		}
	}
	if name == "" && len(data) == 0 {
		return eventLead, 0, "" // a comment, a keep-alive
	}
	var v struct {
		Type     string          `json:"type"`
		Error    json.RawMessage `json:"error"`
		Message  json.RawMessage `json:"message"` // a Responses error's; an Anthropic start's is the message
		Response struct {
			Error             json.RawMessage `json:"error"`
			Status            string          `json:"status"`
			IncompleteDetails *struct {
				Reason string `json:"reason"`
			} `json:"incomplete_details"`
		} `json:"response"`
		Choices *[]struct {
			Delta        map[string]any `json:"delta"`
			FinishReason *string        `json:"finish_reason"`
		} `json:"choices"`
		// Anthropic's: a text delta's, or message_delta's stop_reason;
		// Responses': a string of text
		Delta        json.RawMessage `json:"delta"`
		ContentBlock streamPart      `json:"content_block"`
		Item         streamPart      `json:"item"`
		Part         streamPart      `json:"part"`
		Text         *string         `json:"text"`
		Candidates   *[]struct {
			Content struct {
				Parts []json.RawMessage `json:"parts"`
			} `json:"content"`
			FinishReason string `json:"finishReason"`
		} `json:"candidates"`
		PromptFeedback struct {
			BlockReason string `json:"blockReason"`
		} `json:"promptFeedback"`
	}
	if json.Unmarshal(data, &v) != nil {
		return eventContent, 0, "" // [DONE], or what isn't ours to read
	}
	typ := v.Type
	if typ == "" {
		typ = name
	}
	errOf := func(raw json.RawMessage) (int, int, string) {
		msg := string(raw)
		var m string
		if json.Unmarshal(v.Message, &m) == nil && m != "" {
			msg += " " + m
		}
		return eventError, streamStatus(msg), msg
	}
	refusal := func(reason string) (int, int, string) {
		return eventRefusal, refusedStatus, refusedNote(reason)
	}
	switch {
	case typ == "error" || typ == "response.failed":
		raw := v.Error
		if len(v.Response.Error) > 0 && string(v.Response.Error) != "null" {
			raw = v.Response.Error
		}
		if len(raw) == 0 || string(raw) == "null" {
			// Responses' own error event: its code and message on it
			if note, ok := policyRefusal(data); ok {
				return eventRefusalError, refusedStatus, note
			}
		}
		if note, ok := policyRefusal(raw); ok {
			return eventRefusalError, refusedStatus, note
		}
		return errOf(raw)
	case len(v.Error) > 0 && string(v.Error) != "null":
		if note, ok := policyRefusal(v.Error); ok {
			return eventRefusalError, refusedStatus, note
		}
		return errOf(v.Error)
	// reasoning, before a word of the reply: held with it, and longer, for
	// a refusal after it to go to another as one with nothing said (#248)
	case typ == "content_block_start" && v.ContentBlock.thought(),
		typ == "content_block_delta" && anthropicDeltaThinks(v.Delta),
		(typ == "response.output_item.added" || typ == "response.output_item.done") && v.Item.thought(),
		(typ == "response.reasoning_summary_part.added" || typ == "response.reasoning_summary_part.done") && v.Part.thought(),
		typ == "response.reasoning_summary_text.delta", typ == "response.reasoning_text.delta",
		typ == "response.reasoning_summary_text.done", typ == "response.reasoning_text.done":
		return eventThinking, 0, ""
	// what only frames a reply, before anything is said in it — held with
	// its start, so a refusal after it can still go to another
	case typ == "content_block_start" && !v.ContentBlock.said(),
		typ == "content_block_stop",
		typ == "content_block_delta" && !anthropicDeltaSays(v.Delta),
		typ == "response.output_item.added" && !v.Item.said(),
		typ == "response.output_item.done" && !v.Item.said(),
		typ == "response.content_part.added" && !v.Part.said(),
		typ == "response.content_part.done" && !v.Part.said(),
		typ == "response.reasoning_summary_part.added" && !v.Part.said(),
		typ == "response.reasoning_summary_part.done" && !v.Part.said(),
		(typ == "response.output_text.delta" || typ == "response.reasoning_summary_text.delta" || typ == "response.reasoning_text.delta") && string(v.Delta) == `""`,
		(typ == "response.output_text.done" || typ == "response.reasoning_summary_text.done" || typ == "response.reasoning_text.done") && v.Text != nil && *v.Text == "":
		return eventLead, 0, ""
	case typ == "message_delta":
		var d struct {
			StopReason  string          `json:"stop_reason"`
			StopDetails json.RawMessage `json:"stop_details"`
		}
		if json.Unmarshal(v.Delta, &d) == nil && d.StopReason == "refusal" {
			return eventRefusal, refusedStatus, refusedDetail(d.StopReason, d.StopDetails)
		}
	case typ == "response.incomplete" || typ == "response.completed" && v.Response.Status == "incomplete":
		if d := v.Response.IncompleteDetails; d != nil {
			if r, ok := filterReasons[d.Reason]; ok {
				return refusal(r)
			}
		}
	case typ == "" && v.Candidates != nil:
		// a Gemini chunk
		if r, ok := filterReasons[v.PromptFeedback.BlockReason]; ok {
			return refusal(r)
		}
		thinks := false
		for _, c := range *v.Candidates {
			for _, p := range c.Content.Parts {
				var part struct {
					Text    string `json:"text"`
					Thought bool   `json:"thought"`
				}
				if json.Unmarshal(p, &part) == nil && part.Thought && part.Text != "" {
					thinks = true // its reasoning, said to nobody yet
					continue
				}
				if json.Unmarshal(p, &part) != nil || part.Text != "" || !bytes.Contains(p, []byte(`"text"`)) {
					return eventContent, 0, "" // text, or a call
				}
			}
			if r, ok := filterReasons[c.FinishReason]; ok {
				return refusal(r)
			}
			if c.FinishReason != "" {
				return eventContent, 0, ""
			}
		}
		if thinks {
			return eventThinking, 0, ""
		}
		return eventLead, 0, ""
	case typ == "" && len(v.PromptFeedback.BlockReason) > 0:
		if r, ok := filterReasons[v.PromptFeedback.BlockReason]; ok {
			return refusal(r)
		}
	case typ == "ping", typ == "message_start", typ == "response.created", typ == "response.in_progress", typ == "response.queued":
		return eventLead, 0, ""
	case typ == "response.metadata":
		// the ChatGPT backend's word on the turn, ahead of the reply: its
		// safety buffering, moderation, a verification it recommends.
		// Taken for content, it let the stream through, and the
		// response.failed bio_policy after it went to Codex (#248)
		if bytes.Contains(data, []byte(`"safety_buffering"`)) {
			return eventBuffering, 0, ""
		}
		return eventLead, 0, ""
	case strings.HasPrefix(typ, "codex."):
		// the ChatGPT backend's word on the account (codex.rate_limits),
		// ahead of the reply: taken for content, it let the stream
		// through, and a refusal after it (response.failed) went to the
		// agent rather than tried again
		return eventLead, 0, ""
	case typ == "" && v.Choices != nil:
		// a Chat chunk: the first says only who speaks
		thinks := false
		for _, c := range *v.Choices {
			for k, x := range c.Delta {
				if k == "role" || x == nil || x == "" {
					continue
				}
				if k != "reasoning_content" && k != "reasoning" {
					return eventContent, 0, ""
				}
				thinks = true
			}
			if thinks && c.FinishReason == nil {
				continue
			}
			if c.FinishReason != nil {
				if r, ok := filterReasons[*c.FinishReason]; ok {
					return refusal(r)
				}
				return eventContent, 0, ""
			}
		}
		if thinks {
			return eventThinking, 0, ""
		}
		return eventLead, 0, ""
	}
	if replyEvent(typ) {
		return eventContent, 0, ""
	}
	// what isn't known to carry a reply only frames it: it lets the
	// stream through no more than a ping does. Taken for content, a 200
	// that sent only such frames went through, and the overloaded error
	// after them reached Codex with five candidates never asked
	// (Aliceonly on #1418). A stream that ends well is released whole
	return eventLead, 0, ""
}

// replyEvent tells whether an event, past the cases streamEvent tells
// apart, is one of a protocol's events that carry a reply or end it:
// Anthropic's blocks and stop, Responses' text, refusal, items, parts,
// calls and audio, and its end.
func replyEvent(typ string) bool {
	switch typ {
	case "content_block_start", "content_block_delta", "message_delta", "message_stop",
		"response.completed", "response.incomplete", "response.done":
		return true
	}
	rest, ok := strings.CutPrefix(typ, "response.")
	if !ok {
		return false
	}
	for _, p := range []string{"output_text.", "refusal.", "output_item.", "content_part.", "audio", "output_audio"} {
		if strings.HasPrefix(rest, p) {
			return true
		}
	}
	// a call's arguments or a hosted tool's progress: function_call_
	// arguments, custom_tool_call_input, web_search_call, mcp_call, ...
	return strings.Contains(rest, "_call") || strings.HasPrefix(rest, "mcp_")
}

// anthropicDeltaThinks tells whether an Anthropic content_block_delta is
// reasoning with something in it.
func anthropicDeltaThinks(raw json.RawMessage) bool {
	var d struct {
		Type     string `json:"type"`
		Thinking string `json:"thinking"`
	}
	return json.Unmarshal(raw, &d) == nil && d.Type == "thinking_delta" && d.Thinking != ""
}

// anthropicDeltaSays tells whether an Anthropic content_block_delta says
// anything: text or reasoning, or a call's input. A signature doesn't.
func anthropicDeltaSays(raw json.RawMessage) bool {
	var d struct {
		Type     string `json:"type"`
		Text     string `json:"text"`
		Thinking string `json:"thinking"`
	}
	if json.Unmarshal(raw, &d) != nil {
		return true
	}
	switch d.Type {
	case "text_delta":
		return d.Text != ""
	case "thinking_delta":
		return d.Thinking != ""
	case "signature_delta":
		return false
	}
	return true
}

// errorCode is an error's code, or its type when it has none.
func errorCode(raw json.RawMessage) string {
	var e struct {
		Code any    `json:"code"`
		Type string `json:"type"`
	}
	if json.Unmarshal(raw, &e) != nil {
		return ""
	}
	if c, ok := e.Code.(string); ok && c != "" {
		return c
	}
	return e.Type
}

// policyCode is an error code that names the vendor's usage policy:
// OpenAI's bio_policy ("This content was flagged for possible biological
// risk"), cyber_policy and the like (#248).
var policyCode = regexp.MustCompile(`^[a-z]+_policy$`)

// flaggedWords are how OpenAI's invalid_prompt says the prompt was held to
// its usage policy, rather than malformed.
var flaggedWords = regexp.MustCompile(`(?i)flagged|usage polic`)

// policyRefusal tells whether an error — an error object, a body holding
// one, or a stream's error event — is the vendor's safety filter refusing
// the request: Azure's content_filter, OpenAI's content_policy_violation,
// bio_policy and invalid_prompt flagged as against its usage policy. It is
// not the request at fault, as another 400 is: another account or model
// may answer it (#248).
func policyRefusal(raw []byte) (string, bool) {
	var e struct {
		Code    any    `json:"code"`
		Type    string `json:"type"`
		Message string `json:"message"`
		Error   *struct {
			Code    any    `json:"code"`
			Type    string `json:"type"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(raw, &e) != nil {
		return "", false
	}
	code, typ, msg := e.Code, e.Type, e.Message
	if e.Error != nil {
		code, typ, msg = e.Error.Code, e.Error.Type, e.Error.Message
	}
	c, _ := code.(string)
	if c == "" {
		c = typ
	}
	note := func(reason string) (string, bool) {
		if msg = strings.TrimSpace(msg); msg != "" {
			if len(msg) > 300 {
				msg = msg[:300] + "…"
			}
			return refusedNote(reason) + " — " + msg, true
		}
		return refusedNote(reason), true
	}
	switch r, ok := filterReasons[c]; {
	case ok:
		return note(r)
	case policyCode.MatchString(c):
		return note(c)
	case c == "invalid_prompt" && flaggedWords.MatchString(msg):
		return note(c)
	case strings.TrimSpace(msg) == highRiskRefusal:
		return note("high risk")
	}
	return "", false
}

// highRiskRefusal is an error's whole message that is a refusal with no
// code beside it (#2400, Jichao: what the agent showed, the vendor not
// known). It says the request was turned away, not the account, so it goes
// to the next candidate as other refusals do and rests nobody. Only an
// error's own message is matched, and only whole: an answer quoting it is
// an answer.
const highRiskRefusal = "The request was rejected because it was considered high risk"

// refusedCode is the code of a stream's error event (its data) when it is
// the vendor's safety filter refusing, for a translation of it to keep:
// said in another protocol as only its message, ChatGPT's bio_policy read
// to Claude Code as any failure, and the account was set aside for it
// rather than the next asked as after a refusal (#248).
func refusedCode(data string) string {
	var v struct {
		Error    json.RawMessage `json:"error"`
		Response struct {
			Error json.RawMessage `json:"error"`
		} `json:"response"`
	}
	if json.Unmarshal([]byte(data), &v) != nil {
		return ""
	}
	for _, raw := range []json.RawMessage{v.Response.Error, v.Error, json.RawMessage(data)} {
		if len(raw) == 0 || string(raw) == "null" {
			continue
		}
		if _, ok := policyRefusal(raw); ok {
			if c := errorCode(raw); c != "" && c != "error" {
				return c
			}
			return "content_filter"
		}
	}
	return ""
}

// refusedReply tells whether a whole reply, not streamed, is the vendor's
// safety filter refusing with nothing said: Anthropic's stop_reason
// "refusal", Chat's finish_reason "content_filter", Responses' incomplete
// for content_filter, Gemini's SAFETY — with no text or call in it.
func refusedReply(b []byte) (string, bool) {
	var v struct {
		// Anthropic's
		StopReason  string          `json:"stop_reason"`
		StopDetails json.RawMessage `json:"stop_details"`
		Content     []streamPart    `json:"content"`
		// Chat's
		Choices []struct {
			FinishReason string `json:"finish_reason"`
			Message      struct {
				Content   any   `json:"content"`
				ToolCalls []any `json:"tool_calls"`
			} `json:"message"`
		} `json:"choices"`
		// Responses'
		Status            string `json:"status"`
		IncompleteDetails *struct {
			Reason string `json:"reason"`
		} `json:"incomplete_details"`
		Output []streamPart `json:"output"`
		// Gemini's
		Candidates []struct {
			Content struct {
				Parts []json.RawMessage `json:"parts"`
			} `json:"content"`
			FinishReason string `json:"finishReason"`
		} `json:"candidates"`
		PromptFeedback struct {
			BlockReason string `json:"blockReason"`
		} `json:"promptFeedback"`
	}
	if json.Unmarshal(b, &v) != nil {
		return "", false
	}
	none := func(ps []streamPart) bool {
		return !slices.ContainsFunc(ps, streamPart.said)
	}
	if r, ok := filterReasons[v.StopReason]; ok && r == "refusal" && none(v.Content) {
		return refusedDetail(r, v.StopDetails), true
	}
	for _, c := range v.Choices {
		if r, ok := filterReasons[c.FinishReason]; ok && (c.Message.Content == nil || c.Message.Content == "") && len(c.Message.ToolCalls) == 0 {
			return refusedNote(r), true
		}
	}
	if d := v.IncompleteDetails; v.Status == "incomplete" && d != nil && none(v.Output) {
		if r, ok := filterReasons[d.Reason]; ok {
			return refusedNote(r), true
		}
	}
	if r, ok := filterReasons[v.PromptFeedback.BlockReason]; ok {
		return refusedNote(r), true
	}
	for _, c := range v.Candidates {
		if r, ok := filterReasons[c.FinishReason]; ok && len(c.Content.Parts) == 0 {
			return refusedNote(r), true
		}
	}
	return "", false
}

// streamStatus is the status an error in a stream stands for, as a vendor
// would have answered it before streaming.
func streamStatus(msg string) int {
	l := strings.ToLower(msg)
	switch {
	case tooLong(http.StatusBadRequest, msg):
		// before the quota words: the ChatGPT backend's response.failed
		// for a Codex conversation past the model's window says
		// "context_length_exceeded", whose "exceeded" read as a rate
		// limit, and the same request was sent again and again (#1944)
		return 400
	case strings.Contains(l, "overloaded"):
		return 529
	case creditWords.MatchString(msg) && !strings.Contains(l, "rate"):
		return 402
	case strings.Contains(l, "rate_limit"), strings.Contains(l, "rate limit"), strings.Contains(l, "too many"), quotaSaid(msg):
		return 429
	case unservedWords.MatchString(msg):
		return 400
	case strings.Contains(l, "invalid"), strings.Contains(l, "context_length"), strings.Contains(l, "too long"):
		return 400
	}
	return 502
}

// pinTo is cands narrowed to the account a request names in AccountHeader
// (its user, or its id in the routing trace), and pl with them. Nothing
// else is tried in its place: a caller that names one account asks about
// that one. The error says why none is left: no such account, one that
// doesn't list the model, or one resting.
func pinTo(want string, cands []candidate, pl planned) ([]candidate, planned, int, string) {
	match := func(w Weighed) bool { return strings.EqualFold(want, w.Who) || want == w.ID }
	var out []candidate
	var order []Weighed
	var rests []string
	for i, c := range cands {
		if i >= len(pl.order) || !match(pl.order[i]) {
			continue
		}
		r, ok := restOf(c.restKey())
		if !ok && c.restID() != c.restKey() {
			r, ok = restOf(c.restID())
		}
		if ok {
			rests = append(rests, fmt.Sprintf("%s rests until %s (%s)", c.label(), r.Until.Format(time.RFC3339), r.Why))
			continue
		}
		out, order = append(out, c), append(order, pl.order[i])
	}
	if len(out) > 0 {
		return out, planned{order: order}, 0, ""
	}
	if len(rests) > 0 {
		return nil, pl, http.StatusTooManyRequests, AccountHeader + ": " + strings.Join(rests, "; ") + "; no other account is tried in its place"
	}
	for _, w := range pl.left {
		if match(w) && w.Held {
			return nil, pl, http.StatusForbidden, fmt.Sprintf("%s: the gateway key may not use %s's account", AccountHeader, w.Who)
		}
		if match(w) && w.Capped > 0 {
			msg, _ := cappedError(w.Model, []Weighed{w}, time.Now())
			return nil, pl, http.StatusTooManyRequests, AccountHeader + ": " + msg + "; no other account is tried in its place"
		}
		if match(w) {
			return nil, pl, http.StatusBadRequest, fmt.Sprintf("%s: %s's plan doesn't list %s", AccountHeader, w.Who, w.Model)
		}
	}
	var have []string
	for _, w := range append(slices.Clone(pl.order), pl.left...) {
		if w.Kind == "account" && !slices.Contains(have, w.Who) {
			have = append(have, w.Who)
		}
	}
	msg := fmt.Sprintf("%s: no account %q serves this model", AccountHeader, want)
	if len(have) > 0 {
		msg += "; its accounts are " + strings.Join(have, ", ")
	}
	return nil, pl, http.StatusNotFound, msg
}
