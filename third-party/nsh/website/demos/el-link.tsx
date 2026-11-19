import { mount, signal, Text, View } from "nsh";
import { Link } from "nsh/base";
import { desktop, Log, Panel, Split, ui, sectionSurface, linkColor, linkLook, linkSize, LinkText } from "./palette";

// Links of the shared look (`linkLook`, `LinkText`, `linkColor`): the
// accent with a quiet underline that a bar grows over from the left under
// the pointer (always there on the current page), violet once visited (the
// app remembers what it opened), the palette's focus ring, faint while
// disabled; a site outside the app has an arrow that nudges out under the
// pointer. The color fades and the bar slides, still with reduced motion.
const visited = signal(new Set<string>());
const events = signal<string[]>([]);
const route = signal("/docs/link");

const opened = ({ href }: { href: string }) => {
  visited.set(new Set(visited()).add(href));
  events.set([`onOpen ${href}`, ...events()].slice(0, 4));
};

function DocLink(props: { href: string; label: string; openWith?: "system" | "app"; disabled?: boolean; current?: boolean; icon?: boolean; inline?: boolean }) {
  const color = () => linkColor({ disabled: props.disabled, current: props.current, visited: visited().has(props.href) });
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
      {...linkLook({ inline: props.inline })}
    >
      <LinkText label={props.label} color={color()} size={props.inline ? 15 : undefined} current={props.current} disabled={props.disabled} icon={props.icon} />
    </Link>
  );
}

function App() {
  const crumb = (href: string, label: string) => <DocLink href={href} label={label} current={route() === href} />;
  const slash = () => <Text style={{ color: ui().faint, fontSize: linkSize }}>/</Text>;
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
        <View style={{ ...sectionSurface({ padded: true }), gap: 14 }}>
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
