package gateway

import (
	"math/rand"
	"sort"
	"strings"
	"testing"
)

// TestProbe36bFuzz: a reply's think/text split may not depend on how the
// reply fell across chunks. Random strings over an adversarial alphabet,
// whole vs random rune-boundary multi-way splits.
func TestProbe36bFuzz(t *testing.T) {
	alphabet := []string{"<think>", "</think>", "<thought>", "</thought>", "`", "``", "```", "````", "\n", " ", "\t", "a", "<", ">", "x", "\n```", "`x`", "</thi"}
	rng := rand.New(rand.NewSource(3636))
	flaky := 0
	for i := 0; i < 20000; i++ {
		var sb strings.Builder
		n := 1 + rng.Intn(30)
		for j := 0; j < n; j++ {
			sb.WriteString(alphabet[rng.Intn(len(alphabet))])
		}
		s := sb.String()
		var runes []string
		for _, r := range s {
			runes = append(runes, string(r))
		}
		if len(runes) < 2 {
			continue
		}
		wantThink, wantText := probe36b([]string{s})
		parts := 2 + rng.Intn(3) // 2..4 ways
		if parts > len(runes) {
			parts = len(runes)
		}
		cuts := map[int]bool{}
		for len(cuts) < parts-1 {
			cuts[1+rng.Intn(len(runes)-1)] = true
		}
		sorted := make([]int, 0, len(cuts))
		for c := range cuts {
			sorted = append(sorted, c)
		}
		sort.Ints(sorted)
		var chunks []string
		prev := 0
		for _, c := range sorted {
			chunks = append(chunks, strings.Join(runes[prev:c], ""))
			prev = c
		}
		chunks = append(chunks, strings.Join(runes[prev:], ""))
		gotThink, gotText := probe36b(chunks)
		if gotThink != wantThink || gotText != wantText {
			if flaky < 10 {
				t.Errorf("seeded sample %q split %q: think %q text %q, want %q %q", s, chunks, gotThink, gotText, wantThink, wantText)
			}
			flaky++
		}
	}
	if flaky > 0 {
		t.Errorf("%d of 4000 splits diverged", flaky)
	}
}
