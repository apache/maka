import { mount, Scroll, signal, Text, View } from "nsh";

// Pin the former terminal gallery's 500-row workload and dark palette for comparable baselines.
const colors = {
  text: "#e6e8ee", muted: "#9aa1b2", faint: "#5f6676", accent: "#7aa2f7", focus: "#262c3a",
};

const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"];

export function LongList() {
  const items = Array.from({ length: 500 }, (_, i) => ({
    id: i + 1,
    title: `${WORDS[i % WORDS.length]} ${WORDS[(i * 7) % WORDS.length]}`,
    size: ((i * 7919) % 9000) + 120,
  }));
  const done = signal<Set<number>>(new Set());
  const toggle = (id: number) =>
    done.update((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <>
      <Text style={{ color: colors.muted }}>
        500 rows in one scroll view: wheel, ↑ ↓, PgUp / PgDn. Click a row to mark it ·{" "}
        <Text style={{ color: colors.accent }}>{done().size} marked</Text>
      </Text>
      <View>
        <Each of={items}>
          {(item) => {
            const it = item();
            const ticked = () => done().has(it.id);
            return (
              <View focusStyle={{ backgroundColor: colors.focus }} onPress={() => toggle(it.id)} style={{ flexDirection: "row", height: 16, gap: 16 }}>
                <Text style={{ width: 48, textAlign: "right", color: colors.faint }}>{String(it.id)}</Text>
                <Text style={{ color: ticked() ? colors.accent : colors.faint }}>{ticked() ? "*" : " "}</Text>
                <Text style={{ flex: 1, color: ticked() ? colors.accent : colors.text }}>{it.title}</Text>
                <Text style={{ width: 96, textAlign: "right", paddingRight: 8, color: colors.faint }}>{(it.size / 100).toFixed(1)} KB</Text>
              </View>
            );
          }}
        </Each>
      </View>
    </>
  );
}

mount(() => (
  <Scroll style={{ flex: 1 }}>
    <View style={{ paddingHorizontal: 8, paddingVertical: 16, gap: 16 }}><LongList /></View>
  </Scroll>
));
