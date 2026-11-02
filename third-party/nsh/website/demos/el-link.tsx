import { mount, signal, Text, View } from "nsh";
import { Link } from "nsh/base";
import { desktop, focusRing, Icon, Log, Panel, size, Split, tint, ui } from "./palette";

// Links of the app's look: the accent with a quiet underline that fills in
// under the pointer, violet once visited (the app remembers what it
// opened), the palette's focus ring, dimmed while disabled. The color and
// the underline move with `transition-colors`, still with reduced motion.
const visited = signal(new Set<string>());
const events = signal<string[]>([]);
const route = signal("/docs/link");

const opened = ({ href }: { href: string }) => {
  visited.set(new Set(visited()).add(href));
  events.set([`onOpen ${href}`, ...events()].slice(0, 4));
};

function DocLink(props: { href: string; label: string; openWith?: "system" | "app"; disabled?: boolean; current?: boolean; icon?: boolean; inline?: boolean }) {
  const seen = () => visited().has(props.href);
  const color = () => (props.disabled ? ui().faint : props.current ? ui().text : seen() ? ui().violet : ui().accent);
  return (
    <Link
      href={props.href}
      openWith={props.openWith ?? "app"}
      disabled={props.disabled}
      current={props.current}
      onOpen={(e: { href: string }) => {
        opened(e);
        if ((props.openWith ?? "app") === "app") route.set(e.href);
      }}
      class={`flex-row items-center gap-1 rounded-sm transition-colors motion-reduce:transition-none active:opacity-60 ${props.inline ? "align-text-bottom" : "self-start"}`}
      focusStyle={focusRing(2)}
    >
      <Text
        class="transition-colors motion-reduce:transition-none"
        style={{
          fontSize: props.inline ? 15 : size.label,
          fontWeight: props.current ? "600" : "500",
          color: color(),
          textDecorationLine: props.current || props.disabled ? "none" : "underline",
          textDecorationColor: tint(color(), 0.4),
        }}
        hoverStyle={props.disabled || props.current ? undefined : { textDecorationColor: color() }}
      >
        {props.label}
      </Text>
      {props.icon ? <Icon name="external" size={13} tint={color()} /> : null}
    </Link>
  );
}

function App() {
  const crumb = (href: string, label: string) => <DocLink href={href} label={label} current={route() === href} />;
  const slash = () => <Text style={{ color: ui().faint, fontSize: size.label }}>/</Text>;
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>link</Text>
      <Text style={{ color: ui().muted }}>{desktop ? "Click a link, or Tab to one and press Return" : "Tap a link"}</Text>

      <Split
        gap={14}
        inspector={
          <>
            <Panel title="route · visited">
              <Text style={{ fontSize: 13, color: ui().text }}>
                {route()} · {visited().size} visited
              </Text>
            </Panel>
            <Log title="onOpen({ href })" lines={events()} minHeight={110} />
          </>
        }
      >
        <View style={{ ...ui().card, borderRadius: 16, padding: desktop ? 16 : 18, gap: 14 }}>
          <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
            {crumb("/docs", "Docs")}
            {slash()}
            {crumb("/docs/elements", "Elements")}
            {slash()}
            {crumb("/docs/link", "Link")}
          </View>
          <Text style={{ fontSize: 15, lineHeight: 22, color: ui().text }}>
            {"Read the "}
            <DocLink href="/docs/release-notes" label="release notes" inline />
            {" and the "}
            <DocLink href="/docs/migration" label="migration guide" inline />
            {" before you update."}
          </Text>
          <View style={{ height: 1, backgroundColor: ui().line }} />
          <View style={{ gap: 10 }}>
            <DocLink href="https://example.com/" label="example.com" openWith="system" icon />
            <DocLink href="/docs/archive" label="Archived docs" disabled />
          </View>
        </View>
      </Split>
    </View>
  );
}

mount(App);
