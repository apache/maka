package pii

import (
	"context"
	"errors"
	"testing"
	"time"
)

// Stop ("off" in Settings → Privacy) ends pf-serve, and the request on it
// fails (TestStatusAndStopDontWaitForARequest). A request still waiting
// for the turn goes with it, without starting pf-serve again: the model
// was turned off, and nothing asked for it since. Today it doesn't: its
// turn comes, heldBack knows of no failure (Stop cleared it), and
// classify starts pf-serve again — a 1.6 GB load, minutes of it, for a
// model the user turned off. (Also, for the one whose chunk was cut off
// by Stop, the chunks after it go the same way, while its caller waits.)
func TestStopKeepsAQueuedRequestFromStartingServeAgain(t *testing.T) {
	log := fakeInstall(t, "hang", false)
	was := classifyTimeout
	classifyTimeout = func(int) time.Duration { return time.Hour }
	t.Cleanup(func() { classifyTimeout = was })

	// the first request reaches pf-serve, which never answers
	first := findAsync(context.Background(), "hi Alice")
	waitFor(t, "the first request reaching pf-serve", func() bool { return len(fakeLines(t, log, "request")) == 1 })

	// the second waits for the turn
	second := findAsync(context.Background(), "another Alice")
	waitFor(t, "the second request waiting", func() bool { return Now().Waiting == 1 })

	// the model is turned off: the request on pf-serve fails
	Stop()
	r := within10s(t, "the stopped request", func() found { return <-first })
	if !errors.Is(r.err, errStopped) {
		t.Fatalf("the request on a stopped pf-serve: %v, want errStopped", r.err)
	}

	// and no pf-serve is started again: the queued request goes with it
	// (errStopped), instead of loading the model over minutes
	waitFor(t, "pf-serve started again for a turned-off model", func() bool {
		return len(fakeLines(t, log, "start")) == 2
	})
	if n := len(fakeLines(t, log, "start")); n != 1 {
		t.Fatalf("pf-serve started %d times, want once: the queued request started a turned-off model", n)
	}
	r2 := within10s(t, "the queued request", func() found { return <-second })
	if !errors.Is(r2.err, errStopped) {
		t.Fatalf("the queued request: %v, want errStopped", r2.err)
	}
}
