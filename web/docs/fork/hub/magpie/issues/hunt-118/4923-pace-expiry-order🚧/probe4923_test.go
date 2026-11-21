package provider

// [DEBUG-4923] throwaway probe for issue #4923 — NOT for commit.
// Exercises the two plugin shapes (CodeArts, OfficeAce) through
// allowanceOf + Allowance.Pace as the plugins' usage answers build them.
import (
	"testing"
	"time"
)

func at4923(t time.Time) *time.Time { return &t }

func TestProbe4923Shapes(t *testing.T) {
	now := time.Now()
	day := 24 * time.Hour

	// Shape A: CodeArts (community plugin >= 0.2.0): the TOTAL window is
	// non-aside and carries runsOutAt/runsOut from the check-in batches;
	// the buckets themselves are aside.
	a := allowanceOf([]QuotaWindow{
		{Name: "总积分", Amount: 500, Limit: 5600, Unit: "credits", ResetsAt: at4923(now.Add(28 * day)), RunsOutAt: at4923(now.Add(20 * time.Hour)), RunsOut: 300},
		{Name: "基础包", Amount: 500, Limit: 2000, Unit: "credits", Aside: true},
	}, now)
	b := allowanceOf([]QuotaWindow{
		{Name: "总积分", Amount: 500, Limit: 5600, Unit: "credits", ResetsAt: at4923(now.Add(28 * day))},
	}, now)
	pa, duea := a.Pace("m", now)
	pb, _ := b.Pace("m", now)
	t.Logf("[DEBUG-4923] CodeArts  A(with expiring)=%v due=%v  B(no expiring)=%v", pa, duea.Sub(now), pb)
	if pa <= pb {
		t.Errorf("[DEBUG-4923] CodeArts shape: A does not go first (%v <= %v)", pa, pb)
	}

	// Shape B: OfficeAce fresh: each bucket is its own window whose
	// resetsAt IS its expiry; the check-in bonus expires tomorrow.
	oa := allowanceOf([]QuotaWindow{
		{Name: "套餐", Used: 10, Amount: 100, Limit: 1000, Unit: "credits", ResetsAt: at4923(now.Add(30 * day))},
		{Name: "签到bonus", Used: 0, Amount: 0, Limit: 200, Unit: "credits", ResetsAt: at4923(now.Add(20 * time.Hour))},
	}, now)
	ob := allowanceOf([]QuotaWindow{
		{Name: "套餐", Used: 0, Amount: 0, Limit: 1000, Unit: "credits", ResetsAt: at4923(now.Add(30 * day))},
	}, now)
	poa, dueoa := oa.Pace("m", now)
	pob, _ := ob.Pace("m", now)
	t.Logf("[DEBUG-4923] OfficeAce fresh A=%v due=%v  B=%v", poa, dueoa.Sub(now), pob)
	if poa <= pob {
		t.Errorf("[DEBUG-4923] OfficeAce fresh: A does not go first (%v <= %v)", poa, pob)
	}

	// Shape C: OfficeAce after its check-in is burned: the spent bonus
	// bucket (100% used, resets tomorrow) sets the pace.
	oc := allowanceOf([]QuotaWindow{
		{Name: "套餐", Used: 10, Amount: 100, Limit: 1000, Unit: "credits", ResetsAt: at4923(now.Add(30 * day))},
		{Name: "签到bonus", Used: 100, Amount: 200, Limit: 200, Unit: "credits", ResetsAt: at4923(now.Add(20 * time.Hour))},
	}, now)
	poc, dueoc := oc.Pace("m", now)
	t.Logf("[DEBUG-4923] OfficeAce burned A=%v due=%v  vs fresh B=%v", poc, dueoc.Sub(now), pob)
	if poc < pob {
		t.Errorf("[DEBUG-4923] OfficeAce burned: A (%v) ranks below a fresh B (%v)", poc, pob)
	}

	// What Smart would see for shape B: the renewals (first = soonest).
	t.Logf("[DEBUG-4923] OfficeAce fresh A renewals=%v  B renewals=%v", oa.Renewal("m", now), ob.Renewal("m", now))
}
