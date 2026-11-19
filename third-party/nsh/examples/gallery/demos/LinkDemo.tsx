import { platform, signal, Text, View } from "nsh";
import { Link, TextView } from "nsh/base";
import { Button, Caption, Card, colors, DemoPage, density, linkColor, linkLook, LinkText, mono, textViewLinkClasses, LabeledToggle, ghostOutdent } from "../ui";

// `nsh/base`'s `Link` owns presses, Return and Space, the keyboard focus,
// the disabled state and the link role; the look is the gallery's: the
// citrus accent with a quiet underline that a bar grows over under the
// pointer, violet once visited (the app remembers what it opened), the
// gallery's focus ring, dimmed while disabled (`linkLook`, `LinkText`,
// `linkColor`). Colors move with `transition-colors`, the bar and the
// arrows with `transition-transform`; both stand still with reduced motion.

const pointer = platform.desktop;

/** The hrefs opened so far, for the visited look, and the event log. */
const visited = signal(new Set<string>());
const log = signal<string[]>([]);
const note = (line: string) => log.set([line, ...log()].slice(0, 5));
const remember = (href: string) => visited.set(new Set(visited()).add(href));

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
  title?: string;
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
  const color = () => linkColor({ disabled: props.disabled, current: props.current, visited: visited().has(props.href), quiet: props.quiet });
  return (
    <Link
      testID={props.testID}
      href={props.href}
      title={props.title}
      openWith={props.openWith ?? "app"}
      disabled={props.disabled}
      current={props.current}
      onOpen={({ href }: { href: string }) => {
        remember(href);
        note(`onOpen ${href}${(props.openWith ?? "app") === "system" ? " → the system" : ""}`);
        props.onRoute?.(href);
      }}
      onPress={() => note(`onPress ${props.label}`)}
      {...linkLook({ inline: props.inline })}
    >
      <LinkText label={props.label} color={color()} size={props.size} current={props.current} quiet={props.quiet} disabled={props.disabled} icon={props.icon} />
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
        <Caption label="Opened links turn violet; the app remembers them" note={`${visited().size} visited`} />
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
        right={<LabeledToggle label="Hiring" value={hiring()} onChange={(v) => hiring.set(v)} />}
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
        right={
          // A ghost button's label lines up with the card's edge, its
          // padding hanging past it as its hover fill does.
          <View style={ghostOutdent("right", "small")}>
            <Button label="Forget visited" variant="ghost" size="small" onPress={() => visited.set(new Set())} />
          </View>
        }
      >
        {/* No room held for the log: the hint alone until there is one, as the pagination's. */}
        <View style={{ gap: 4 }}>
          <If when={log().length > 0} else={<Caption label="Press a link" />}>
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

  function Destinations() {
    return (
      <Card
        title="Where it goes"
        subtitle={pointer ? "Rest the pointer on a link to see its URL" : "On a desktop, a resting pointer shows the URL"}
      >
        <View style={{ gap: 10 }}>
          <TextLink href="https://nsh.dev/" label="A short address" openWith="system" icon testID="where-short" />
          <TextLink
            href="https://nsh.dev/docs/elements/link"
            title="Link reference"
            label="A titled link"
            openWith="system"
            icon
            testID="where-titled"
          />
          <TextLink href={LONG_URL} label="A long address" openWith="system" icon testID="where-long" />
          <TextLink href={LOOK_ALIKE_URL} label={"exаmple.com, with a Cyrillic а"} openWith="system" icon testID="where-idn" />
        </View>
        <View style={{ paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.line }}>
          <TextView markdown={TITLED} classes={{ ...textViewLinkClasses, root: "text-[13px] leading-[19px]" }} onLinkPress={({ url }) => note(`onLinkPress ${url}`)} />
        </View>
        <Caption label="A title shows above the address; a long path loses its middle; a look-alike host shows as its ASCII form" />
      </Card>
    );
  }

  return <DemoPage cards={[Paragraph, Navigation, External, Destinations, Footer, Events]} />;
}

/** A path and query longer than a hint's line: the middle gives way. */
const LONG_URL = "https://docs.example.com/guides/getting-started/installation/linux/packages?channel=stable&arch=arm64#verify";

/** A host whose "а" is Cyrillic (U+0430): its hint shows the punycode it really is. */
const LOOK_ALIKE_URL = "https://exаmple.com/account/sign-in";

/** A Markdown link with a title: the title above the URL. */
const TITLED =
  // The link early in the sentence, so it stays whole on its first line rather than breaking at the line's end.
  'Read [the changelog](https://nsh.dev/changelog "What changed in this release") before you update: a Markdown link shows its title over the address.';
