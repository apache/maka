import { platform, signal, Text, token, View } from "nsh";
import { Link } from "nsh/base";
import { alpha, Button, Caption, Card, colors, DemoPage, density, focusRing, Icon, mono, Toggle } from "../ui";

// `nsh/base`'s `Link` owns presses, Return and Space, the keyboard focus,
// the disabled state and the link role; the look is the gallery's: the
// citrus accent with a quiet underline that a bar grows over under the
// pointer, violet once visited (the app remembers what it opened), the
// gallery's focus ring, dimmed while disabled. Colors move with
// `transition-colors`, the bar and the arrows with `transition-transform`;
// both stand still with reduced motion.

const pointer = platform.desktop;
const violet = token("violet");

/** The hrefs opened so far, for the visited look, and the event log. */
const visited = signal(new Set<string>());
const log = signal<string[]>([]);
const note = (line: string) => log.set([line, ...log()].slice(0, 5));
const remember = (href: string) => visited.set(new Set(visited()).add(href));

const motion = "transition-colors duration-200 motion-reduce:transition-none";
const slide = "transition-transform duration-300 ease-out motion-reduce:transition-none";

/**
 * A link of the gallery's look: `tone` its color (the accent, the text for
 * a footer, violet once visited), a faint underline (none when `quiet`)
 * and a bar over it that grows from the left under the pointer (always
 * there while `current`), `icon` an arrow
 * that nudges out of its box on hover (a site outside the app).
 */
function TextLink(props: {
  href: string;
  label: string;
  openWith?: "system" | "app";
  onRoute?: (href: string) => void;
  disabled?: boolean;
  current?: boolean;
  quiet?: boolean;
  icon?: boolean;
  size?: number;
  inline?: boolean;
  testID?: string;
}) {
  const seen = () => visited().has(props.href);
  const color = () =>
    props.disabled ? colors.faint : props.current ? colors.text : seen() ? violet : props.quiet ? colors.muted : colors.accent;
  const size = () => props.size ?? density.body;
  return (
    <Link
      testID={props.testID}
      href={props.href}
      openWith={props.openWith ?? "app"}
      disabled={props.disabled}
      current={props.current}
      onOpen={({ href }: { href: string }) => {
        remember(href);
        note(`onOpen ${href}${(props.openWith ?? "app") === "system" ? " → the system" : ""}`);
        props.onRoute?.(href);
      }}
      onPress={() => note(`onPress ${props.label}`)}
      class={`group flex-row items-center gap-1 rounded-sm active:opacity-60 ${motion} ${props.inline ? "align-text-bottom" : "self-start"}`}
      focusStyle={focusRing(2)}
    >
      <View>
        <Text
          class={motion}
          style={{
            fontSize: size(),
            fontWeight: props.current ? "600" : "500",
            color: color(),
          }}
        >
          {props.label}
        </Text>
        <If when={!props.quiet && !props.disabled}>
          <View class={`absolute left-0 right-0 bottom-0 h-px ${motion}`} style={{ backgroundColor: alpha(color(), 0.35) }} />
        </If>
        <If when={!props.disabled}>
          <View
            class={`absolute left-0 right-0 bottom-0 h-[1.5px] origin-left rounded-full ${slide} ${props.current ? "scale-x-100" : "scale-x-0 group-hover:scale-x-100"}`}
            style={{ backgroundColor: color() }}
          />
        </If>
      </View>
      <If when={props.icon}>
        <View class={`${slide} group-hover:translate-x-0.5 group-hover:-translate-y-0.5`}>
          <Icon name="external" size={Math.round(size() * 0.85)} tint={color()} />
        </View>
      </If>
    </Link>
  );
}

/**
 * Link: links in a paragraph, a navigation the app routes itself, sites
 * outside the app, a footer, and the states the app owns (visited,
 * disabled, the current page).
 */
export function LinkDemo() {
  function Paragraph() {
    return (
      <Card title="In a paragraph" subtitle="Each link an inline box of the text, on its baseline">
        <Text style={{ fontSize: 15, color: colors.text }}>
          {"Before you update, read the "}
          <TextLink href="/docs/release-notes" label="release notes" size={15} inline testID="release-notes" />
          {" and the "}
          <TextLink href="/docs/migration" label="migration guide" size={15} inline />
          {". By continuing you accept the "}
          <TextLink href="/legal/terms" label="terms" size={15} inline />
          {"."}
        </Text>
        <Caption label="Opened links turn violet: the app keeps what it opened" note={`${visited().size} visited`} />
      </Card>
    );
  }

  function Navigation() {
    const route = signal("/overview");
    const pages = [
      { href: "/overview", label: "Overview", body: "A native shell for AI-generated UI." },
      { href: "/pricing", label: "Pricing", body: "Free while in preview; a seat a month after." },
      { href: "/docs", label: "Docs", body: "Guides, elements and the modules apps import." },
      { href: "/changelog", label: "Changelog", body: "What each release added and fixed." },
    ];
    const page = () => pages.find((p) => p.href === route()) ?? pages[0];
    return (
      <Card title="Navigation" subtitle={`openWith="app": the app routes; current marks the page shown`}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 18, rowGap: 8 }}>
          <Each of={pages}>
            {(p) => (
              <TextLink
                href={p().href}
                label={p().label}
                quiet
                current={route() === p().href}
                onRoute={(href) => route.set(href)}
                testID={`nav-${p().label.toLowerCase()}`}
              />
            )}
          </Each>
        </View>
        <View style={{ gap: 4, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.line }}>
          <Text style={{ fontSize: 12, color: colors.faint, fontFamily: mono }}>{route()}</Text>
          <Text style={{ fontSize: density.body, color: colors.text }}>{page().body}</Text>
        </View>
      </Card>
    );
  }

  function External() {
    return (
      <Card title="Outside the app" subtitle={`openWith="system": the embedding app, then the browser`}>
        <View style={{ gap: 10 }}>
          <TextLink href="https://example.com/" label="example.com" openWith="system" icon testID="external" />
          <TextLink href="https://example.com/status" label="Service status" openWith="system" icon />
        </View>
        <Caption label={pointer ? "The arrow nudges out under the pointer" : "The browser opens; the app hears onOpen first"} />
      </Card>
    );
  }

  function Footer() {
    const hiring = signal(false);
    const columns: { title: string; links: [label: string, href: string][] }[] = [
      { title: "Product", links: [["Features", "/features"], ["Pricing", "/pricing"], ["Changelog", "/changelog"]] },
      { title: "Company", links: [["About", "/about"], ["Blog", "/blog"], ["Careers", "/careers"]] },
      { title: "Legal", links: [["Privacy", "/legal/privacy"], ["Terms", "/legal/terms"], ["Cookies", "/legal/cookies"]] },
    ];
    return (
      <Card
        title="Footer"
        subtitle="Quiet links; a closed page stays disabled"
        right={<Toggle value={hiring()} onChange={(v) => hiring.set(v)} label="Hiring" />}
      >
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 20 }}>
          <Each of={columns}>
            {(column) => (
              <View style={{ gap: 8, minWidth: 96 }}>
                <Text style={{ fontSize: 12, fontWeight: "600", color: colors.faint, letterSpacing: 0.4 }}>{column().title.toUpperCase()}</Text>
                <Each of={column().links}>
                  {(link) => (
                    <TextLink
                      href={link()[1]}
                      label={link()[0]}
                      quiet
                      disabled={link()[0] === "Careers" && !hiring()}
                      testID={`footer-${link()[0].toLowerCase()}`}
                    />
                  )}
                </Each>
              </View>
            )}
          </Each>
        </View>
        <Caption label={hiring() ? "Careers is open" : "Careers is closed: no press, no focus"} />
      </Card>
    );
  }

  function Events() {
    return (
      <Card
        title="Events"
        subtitle="onOpen({ href }) before onPress()"
        right={<Button label="Forget visited" variant="ghost" size="small" onPress={() => visited.set(new Set())} />}
      >
        <View style={{ gap: 4, minHeight: 96 }}>
          <If when={log().length > 0} else={<Text style={{ fontSize: 13, color: colors.faint }}>Press a link</Text>}>
            <Each of={log()}>
              {(line, i) => (
                <Text style={{ fontSize: 12, color: i() === 0 ? colors.text : colors.muted, fontFamily: mono }}>{line()}</Text>
              )}
            </Each>
          </If>
        </View>
      </Card>
    );
  }

  return <DemoPage cards={[Paragraph, Navigation, External, Footer, Events]} />;
}
