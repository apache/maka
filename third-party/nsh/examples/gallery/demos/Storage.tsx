import { signal, Text, View } from "nsh";
import { AlertDialog, Input } from "nsh/base";
import { Storage } from "nsh";
import { Icon } from "../icons";
import { Badge, Button, Caption, Card, colors, DemoPage, Figure, finish, mono, radius, Row } from "../ui";

const LAUNCHES = "launches";
const NOTE = "note";

type Entry = { key: string; length: number };

/**
 * nsh: a count of this demo's openings, a note saved as it is
 * typed, and every key the app keeps (the gallery's own last demo among
 * them), all still there after a restart.
 */
export function StorageDemo() {
  const launches = signal<number | null>(null);
  const note = signal("");
  const saved = signal<"idle" | "saving" | "saved" | "failed">("idle");
  const entries = signal<Entry[]>([]);

  const refresh = async () => {
    const keys = await Storage.keys();
    entries.set(await Promise.all(keys.map(async (key) => ({ key, length: (await Storage.getItem(key))?.length ?? 0 }))));
  };

  // Calls run in order: the read sees what earlier writes left, the
  // write is in memory at once and reaches the disk in the background.
  (async () => {
    const count = (parseInt((await Storage.getItem(LAUNCHES)) ?? "", 10) || 0) + 1;
    launches.set(count);
    await Storage.setItem(LAUNCHES, String(count));
    note.set((await Storage.getItem(NOTE)) ?? "");
    await refresh();
  })();

  const write = (text: string) => {
    note.set(text);
    saved.set("saving");
    (text ? Storage.setItem(NOTE, text) : Storage.removeItem(NOTE)).then(
      () => {
        saved.set("saved");
        refresh();
      },
      () => saved.set("failed"),
    );
  };

  const clearAll = async () => {
    const action = await AlertDialog.show({
      title: "Clear the storage?",
      description: "Removes every key the gallery keeps, the launch count and the note among them.",
      actions: [
        { label: "Cancel", role: "cancel" },
        { label: "Clear", role: "destructive" },
      ],
      closeOnEscape: true,
      closeOnBackdropPress: true,
    });
    if (action !== "Clear") return;
    await Storage.clear();
    launches.set(0);
    note.set("");
    saved.set("idle");
    await refresh();
  };

  function Launches() {
    return (
      <Card icon="storage" title="Launches" subtitle="Counted each time this demo opens" right={<Badge label="Kept" tone="up" />}>
        <Figure value={launches() === null ? "–" : String(launches())} unit={launches() === 1 ? "opening" : "openings"} />
        <Text style={{ fontSize: 12, color: colors.muted, fontFamily: mono }}>
          {`setItem("${LAUNCHES}", "${launches() ?? ""}")`}
        </Text>
      </Card>
    );
  }

  function Note() {
    const hint = () => ({ idle: "", saving: "Saving…", saved: "Saved", failed: "Not saved" })[saved()];
    return (
      <Card icon="form" title="Note" subtitle="Saved as you type, back when the demo opens again">
        <View
          style={{
            borderRadius: radius.control,
            borderCurve: "continuous",
            borderWidth: 1,
            borderColor: colors.fieldBorder,
            backgroundColor: colors.field,
            ...finish.field,
          }}
        >
          <Input
            multiline
            value={note()}
            onChange={write}
            placeholder="Write something, then come back to it"
            accessibilityLabel="Note"
            style={{
              height: 120,
              paddingHorizontal: 14,
              paddingTop: 12,
              paddingBottom: 12,
              fontSize: 15,
              color: colors.text,
              placeholderColor: colors.faint,
              selectionColor: colors.accent,
            }}
          />
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minHeight: 16 }}>
          <If when={saved() === "saved"}>
            <Icon name="check" size={14} tint={colors.up} />
          </If>
          <Text style={{ flex: 1, fontSize: 12, color: saved() === "failed" ? colors.danger : saved() === "saved" ? colors.up : colors.faint }}>{hint()}</Text>
          <Text style={{ fontSize: 12, color: colors.faint, fontVariant: ["tabular-nums"] }}>{`${note().length} chars`}</Text>
        </View>
      </Card>
    );
  }

  function Keys() {
    const total = () => entries().reduce((sum, e) => sum + e.key.length + e.length, 0);
    return (
      <Card icon="lists" title="Stored keys" subtitle="keys() and each value's length">
        <If when={entries().length > 0} else={<Caption label="Nothing stored" />}>
          <View>
            <Each of={entries()}>
              {(entry, i) => (
                <Row first={i() === 0}>
                  <Text numberOfLines={1} style={{ flex: 1, fontSize: 14, color: colors.text, fontFamily: mono }}>
                    {entry().key}
                  </Text>
                  <Text style={{ fontSize: 13, color: colors.muted, fontVariant: ["tabular-nums"] }}>{`${entry().length} chars`}</Text>
                </Row>
              )}
            </Each>
          </View>
        </If>
        <Caption label={`${entries().length} ${entries().length === 1 ? "key" : "keys"}`} note={`${total()} chars of 5 MB`} />
        <Button label="Clear all" variant="secondary" disabled={entries().length === 0} onPress={clearAll} />
        <Text style={{ fontSize: 12, color: colors.faint }}>The data stays on this device and survives restarts, under the app's id from nsh.json.</Text>
      </Card>
    );
  }

  return <DemoPage cards={[Launches, Note, Keys]} />;
}
