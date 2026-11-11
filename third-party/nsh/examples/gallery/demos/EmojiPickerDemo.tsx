import { type JSX, platform, signal, Text, View } from "nsh";
import { Input, Popover } from "nsh/base";
import { alpha, Caption, Card, colors, DemoPage, EmojiPanel, Icon, PopIn, popupSurface, radius, Sheet } from "../ui";

/** A pointer and a keyboard: the picker pops over its button; a phone opens it in a sheet. */
const pointer = platform.desktop;

/** The most recent first, each once, at most `max`. */
const remember = (list: string[], emoji: string, max = 18) => [emoji, ...list.filter((e) => e !== emoji)].slice(0, max);

/**
 * Where the picker opens from: over its button with a pointer, in a sheet
 * on a phone (the grid across its width, the tabs at its foot, the search
 * field taking the keyboard only when pressed). A choice closes it.
 */
function PickerFrom(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: JSX.Element;
  recent: string[];
  onSelect: (e: { emoji: string; base: string }) => void;
  placement?: "top" | "bottom";
}) {
  const choose = (e: { emoji: string; base: string }) => {
    props.onOpenChange(false);
    props.onSelect(e);
  };
  if (pointer) {
    return (
      <Popover open={props.open} onOpenChange={({ open }) => props.onOpenChange(open)} placement={props.placement ?? "top"} align="start" offset={8} margin={8} trigger={props.trigger}>
        <PopIn side={props.placement ?? "top"} style={{ ...popupSurface(), padding: 0, overflow: "hidden" }}>
          <EmojiPanel recent={props.recent} onSelect={choose} onCancel={() => props.onOpenChange(false)} />
        </PopIn>
      </Popover>
    );
  }
  return (
    <>
      {props.trigger}
      <Sheet open={props.open} onClose={() => props.onOpenChange(false)}>
        <View style={{ height: 420, marginHorizontal: -16 }}>
          <EmojiPanel fill recent={props.recent} onSelect={choose} />
        </View>
      </Sheet>
    </>
  );
}

/** The icon button the picker opens from: a rounded square at the controls' radius, as icon buttons are. */
function SmileButton(props: { open: boolean; onPress?: () => void; label: string }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.label}
      tooltip={pointer ? props.label : undefined}
      onPress={props.onPress}
      class="items-center justify-center hover:bg-hover active:scale-95 transition duration-100 motion-reduce:transition-none"
      style={{ width: pointer ? 32 : 40, height: pointer ? 32 : 40, borderRadius: radius.control, backgroundColor: props.open ? alpha(colors.text, 0.08) : undefined }}
    >
      <Icon name="smile" size={pointer ? 18 : 22} tint={props.open ? colors.text : colors.muted} />
    </View>
  );
}

/** A message's field with an emoji button: a choice goes in at the end, and leads the recent ones. */
function Composer() {
  const text = signal("Lunch at the new ramen place? ");
  const open = signal(false);
  const recent = signal<string[]>(["👍", "😂", "❤️", "🎉", "🙏", "🔥"]);
  return (
    <Card title="Message composer" subtitle={pointer ? "Tabs, search, skin tones, the name below" : "A sheet across the screen, the tabs at its foot"}>
      <View class="flex-row items-center gap-1 rounded-2xl border border-border bg-raised" style={{ paddingLeft: 4, paddingRight: 12, minHeight: pointer ? 40 : 48 }}>
        <PickerFrom
          open={open()}
          onOpenChange={(next) => open.set(next)}
          recent={recent()}
          onSelect={({ emoji, base }) => {
            text.set(text() + emoji);
            recent.set(remember(recent(), base));
          }}
          trigger={<SmileButton open={open()} onPress={pointer ? undefined : () => open.set(true)} label="Emoji" />}
        />
        <Input
          value={text()}
          onChange={({ value }) => text.set(value)}
          placeholder="Message"
          accessibilityLabel="Message"
          class={`flex-1 text-foreground placeholder:text-muted-foreground ${pointer ? "text-sm" : "text-base"}`}
        />
      </View>
      <Caption label={`Recent: ${recent().slice(0, 9).join(" ")}`} note={`${recent().length} kept`} />
    </Card>
  );
}

/** A reaction on the message: its emoji, how many, whether one is the reader's. */
type Reaction = { emoji: string; count: number; mine: boolean };

/** A message with reactions: the quick ones, and any emoji from the picker. */
function Reactions() {
  const reactions = signal<Reaction[]>([
    { emoji: "🎉", count: 4, mine: false },
    { emoji: "🚀", count: 2, mine: true },
    { emoji: "👀", count: 1, mine: false },
  ]);
  const recent = signal<string[]>(["👍", "❤️", "😂", "🎉", "🚀", "👀"]);
  const open = signal(false);
  const react = (emoji: string) => {
    const found = reactions().find((r) => r.emoji === emoji);
    if (!found) reactions.set([...reactions(), { emoji, count: 1, mine: true }]);
    else
      reactions.set(
        reactions()
          .map((r) => (r.emoji === emoji ? { ...r, count: r.count + (r.mine ? -1 : 1), mine: !r.mine } : r))
          .filter((r) => r.count > 0),
      );
  };
  return (
    <Card title="Reactions" subtitle="Recent ones first; any other from the picker">
      <View style={{ gap: 10 }}>
        <View style={{ flexDirection: "row", gap: 10 }}>
          <View class="items-center justify-center rounded-full" style={{ width: 32, height: 32, backgroundColor: colors.raised }}>
            <Text style={{ fontSize: 13, fontWeight: "600", color: colors.muted }}>MC</Text>
          </View>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={{ fontSize: 13, fontWeight: "600", color: colors.text }}>
              Mira Chen <Text style={{ fontWeight: "400", color: colors.faint }}>· 10:42</Text>
            </Text>
            <Text style={{ fontSize: pointer ? 14 : 15, color: colors.text, lineHeight: 20 }}>The emoji picker is in: search, skin tones, every group, on every platform.</Text>
          </View>
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingLeft: 42 }}>
          <Each of={reactions()} key={(r) => r.emoji}>
            {(r) => (
              <View
                role="button"
                accessibilityLabel={`${r().emoji} ${r().count}`}
                accessibilityState={{ selected: r().mine }}
                onPress={() => react(r().emoji)}
                class="flex-row items-center gap-1 rounded-full border px-2 active:opacity-70"
                style={{
                  height: 26,
                  borderColor: r().mine ? alpha(colors.accent, 0.45) : colors.border,
                  backgroundColor: r().mine ? alpha(colors.accent, 0.12) : colors.surface,
                }}
              >
                <Text style={{ fontSize: 14 }}>{r().emoji}</Text>
                <Text style={{ fontSize: 12, fontWeight: "600", color: r().mine ? colors.accent : colors.muted, fontVariant: ["tabular-nums"] }}>{r().count}</Text>
              </View>
            )}
          </Each>
        </View>
        <View class="flex-row items-center gap-0.5 self-start rounded-full border border-border" style={{ marginLeft: 42, padding: 3, backgroundColor: colors.surface }}>
          {recent().slice(0, 6).map((emoji) => (
            <View role="button" accessibilityLabel={`React ${emoji}`} onPress={() => react(emoji)} class="items-center justify-center hover:bg-hover active:scale-90" style={{ width: pointer ? 30 : 38, height: pointer ? 30 : 38, borderRadius: radius.control }}>
              <Text style={{ fontSize: pointer ? 18 : 22 }}>{emoji}</Text>
            </View>
          ))}
          <View style={{ width: 1, height: 18, marginHorizontal: 3, backgroundColor: colors.border }} />
          <PickerFrom
            open={open()}
            onOpenChange={(next) => open.set(next)}
            placement="bottom"
            recent={recent()}
            onSelect={({ base }) => {
              react(base);
              recent.set(remember(recent(), base));
            }}
            trigger={<SmileButton open={open()} onPress={pointer ? undefined : () => open.set(true)} label="More reactions" />}
          />
        </View>
      </View>
    </Card>
  );
}

/** `EmojiPicker` as a chat app has it: in a composer and for reactions. */
export function EmojiPickerDemo() {
  return <DemoPage cards={[Composer, Reactions]} />;
}
