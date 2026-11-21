// Alma is told that each of magpie's models calls tools natively, in the
// model's capabilityOverrides: like its id, this too is looked up by models.dev
// and found nowhere for magpie's (group/smart-split), so Alma fell back to
// writing the tools into the prompt for XML tool calls — which the model
// answered with a promise of a call and none (#5573). Every model magpie
// offers is served tools by magpie's gateway, groups included, as magpie
// already tells WorkBuddy ("supportsToolCall": true); one the user turned
// off in Alma themselves stays off.
func TestAlmaToldFunctionCalling(t *testing.T) {
	syncHome(t)
	if err := provider.Save(provider.Provider{ID: "kimi-code-cn", Name: "Kimi Coding Plan", Chat: "https://kimi.example/v1", Key: "key",
		Models: []string{"k3.1-pro", "k3.1-air"}}); err != nil {
		t.Fatal(err)
	}
	if err := provider.SaveGroup(provider.Group{ID: "smart-split", Name: "难题给强模型，简单的给便宜模型 · routing group",
		Members: []string{"kimi-code-cn/k3.1-pro", "kimi-code-cn/k3.1-air"}}); err != nil {
		t.Fatal(err)
	}
	if err := catalog.SaveLive("kimi-code-cn", "https://kimi.example/v1", []catalog.Model{
		{ID: "k3.1-pro", Context: 1048576, Output: 131072, Reasoning: true, Efforts: []string{"low", "high", "max"}, Images: true},
	}); err != nil {
		t.Fatal(err)
	}
	f := startAlma(t)
	a := alma()
	if err := os.MkdirAll(a.Dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := a.Apply("model", "magpie/group/smart-split"); err != nil {
		t.Fatal(err)
	}
	var mine map[string]any
	for _, p := range f.providers {
		if p["name"] == "magpie" {
			mine = p
		}
	}
	if mine == nil {
		t.Fatalf("no magpie provider: %v", f.providers)
	}
	caps := func(id string) map[string]any {
		t.Helper()
		av, _ := mine["availableModels"].([]any)
		for _, m := range av {
			if o := m.(map[string]any); o["id"] == id {
				c, _ := o["capabilityOverrides"].(map[string]any)
				return c
			}
		}
		t.Fatalf("%s not in %v", id, av)
		return nil
	}
	for _, id := range []string{"group/smart-split", "kimi-code-cn/k3.1-pro", "kimi-code-cn/k3.1-air"} {
		if c := caps(id); c["functionCalling"] != true {
			t.Fatalf("%s: functionCalling = %v, want true (#5573: Alma falls back to XML tool calls without it)", id, c["functionCalling"])
		}
	}
	f.takeWrites()

	// tools turned off in Alma by the user: theirs to keep, so told again
	// and it stays off
	for _, m := range mine["availableModels"].([]any) {
		o := m.(map[string]any)
		if o["id"] == "group/smart-split" {
			o["capabilityOverrides"] = map[string]any{"functionCalling": false}
		}
	}
	if err := a.Sync(); err != nil {
		t.Fatal(err)
	}
	if w := f.takeWrites(); len(w) != 1 || w[0] != "PUT /api/providers/"+mine["id"].(string)+"/models" {
		t.Fatalf("sync wrote %v", w)
	}
	if c := caps("group/smart-split"); c["functionCalling"] != false {
		t.Fatalf("group/smart-split synced: functionCalling = %v, want the user's false kept", c["functionCalling"])
	}
	if c := caps("kimi-code-cn/k3.1-pro"); c["functionCalling"] != true {
		t.Fatalf("kimi-code-cn/k3.1-pro synced: functionCalling = %v, want true", c["functionCalling"])
	}
}
