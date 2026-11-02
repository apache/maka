import { type JSX, platform, signal, Text, View } from "nsh";
import { Accordion, AccordionHeader, AccordionItem, AccordionPanel, AccordionTrigger, Radio, RadioGroup, Switch } from "nsh/base";
import { alpha, Badge, Button, Card, colors, DemoPage, finish, focusRing, hovered, Icon, mono, Segmented, switchLook } from "../ui";

// `nsh/base`'s `Accordion` owns which triggers report what, the headings,
// the expanded state screen readers hear and the panels' reveal; the app
// owns `value` (the open items) and every look: the gallery's rows here,
// with the pointer's hover, the keyboard's focus ring, a press that dims,
// a chevron that turns (`group-aria-expanded:`) and panels that spring open
// and shut, all still with reduced motion. An FAQ opens one answer at a
// time; a settings page opens several sections, with controls inside and
// an accordion nested in its last one.

const pointer = platform.desktop;
/** The sizes of the page: a pointer's compact tier, a touch screen's roomier one. */
const size = pointer
  ? { row: 40, padding: 6, gap: 10, label: 14, detail: 12, icon: 12, control: 16, dot: 6, line: 32, switch: "small" as const }
  : { row: 56, padding: 8, gap: 12, label: 15, detail: 13, icon: 16, control: 22, dot: 8, line: 44, switch: "regular" as const };
/** How far a row's hover fill reaches past its content on each side. */
const BLEED = 8;
const pressed = { opacity: 0.7 };
const dimmed = { opacity: 0.4 };

/** A row the pointer hovers: its fill reaching `BLEED` past the content, rounded. */
const hoverRow = (start = 0) => ({
  minHeight: size.row,
  flexDirection: "row" as const,
  alignItems: "center" as const,
  gap: size.gap,
  paddingVertical: size.padding,
  marginHorizontal: -BLEED,
  paddingStart: BLEED + start,
  paddingEnd: BLEED,
  borderRadius: BLEED,
});

/** The hairline between two items. */
function Divider(props: { show: boolean }) {
  return <View style={{ height: props.show ? 1 : 0, backgroundColor: colors.line }} />;
}

/** A label, and a quieter line under it. */
function Label(props: { label: string; detail?: string }) {
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <Text style={{ fontSize: size.label, color: colors.text }}>{props.label}</Text>
      {props.detail ? <Text style={{ fontSize: size.detail, color: colors.muted }}>{props.detail}</Text> : null}
    </View>
  );
}

/**
 * An item's heading: its trigger is the row, the title and a summary, then
 * the chevron, which turns as the item opens (`group-aria-expanded:`). The
 * open trigger's title takes the full text color; a disabled one dims.
 */
function Heading(props: { title: string; detail?: string; leading?: JSX.Element; disabled?: boolean; level?: number }) {
  return (
    <AccordionHeader level={props.level}>
      <AccordionTrigger
        class="group"
        style={hoverRow()}
        activeStyle={pressed}
        hoverStyle={props.disabled ? undefined : hovered()}
        focusStyle={focusRing()}
        disabledStyle={dimmed}
      >
        {props.leading}
        <Label label={props.title} detail={props.detail} />
        <View
          class="transition-transform duration-200 motion-reduce:transition-none group-aria-expanded:rotate-180"
          style={{ width: size.icon, height: size.icon, alignItems: "center", justifyContent: "center" }}
        >
          <Icon name="chevron-down" size={size.icon} tint={colors.muted} />
        </View>
      </AccordionTrigger>
    </AccordionHeader>
  );
}

/**
 * A panel's content, under its heading: indented with the title, padded at
 * the bottom. The padding is the content's, not the panel's: a revealed
 * panel is zero high while closed.
 */
function Body(props: { start?: number; gap?: number; children: JSX.Element }) {
  return <View style={{ paddingStart: props.start ?? 0, paddingBottom: size.padding + 6, gap: props.gap ?? 6 }}>{props.children}</View>;
}

const FAQ: { value: string; icon: "spark" | "arrow-down" | "arrow-up" | "star" | "bell"; question: string; answer: string[]; disabled?: boolean }[] = [
  {
    value: "shipping",
    icon: "arrow-up",
    question: "When will my order ship?",
    answer: ["Orders placed before 2 pm leave the warehouse the same day.", "Standard delivery takes two to five working days; express arrives the next day."],
  },
  {
    value: "returns",
    icon: "arrow-down",
    question: "How do I return an item?",
    answer: ["Open the order, choose Return and print the label.", "Drop the parcel at any carrier point within 30 days: the refund lands in three to five days."],
  },
  {
    value: "warranty",
    icon: "star",
    question: "What does the warranty cover?",
    answer: ["Two years against defects in materials and workmanship.", "Repairs, parts and labour are included; accidental damage is not."],
  },
  {
    value: "gift",
    icon: "bell",
    question: "Can I add gift wrapping?",
    answer: ["Gift wrapping opens with the holiday season."],
    disabled: true,
  },
];

export function AccordionDemo() {
  const last = signal("—");

  function Faq() {
    const open = signal<string[]>(["shipping"]);
    const question = () => FAQ.find((q) => q.value === open()[0])?.question;
    return (
      <Card icon="collapsible" title="FAQ" subtitle="One answer at a time; gift wrapping opens later" right={<Badge label={open().length ? "1 open" : "All closed"} tone={open().length ? "accent" : "neutral"} />}>
        <Accordion
          value={open()}
          onChange={({ value }) => {
            open.set(value);
            last.set(value.length ? `FAQ: ${value.join(", ")}` : "FAQ: all closed");
          }}
        >
          {FAQ.map((q, i) => (
            <AccordionItem value={q.value} disabled={q.disabled}>
              <Divider show={i !== 0} />
              <Heading
                title={q.question}
                disabled={q.disabled}
                leading={
                  <View
                    style={{
                      width: size.control + 6,
                      height: size.control + 6,
                      borderRadius: 7,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: open().includes(q.value) ? colors.accentFill : colors.inset,
                      boxShadow: open().includes(q.value) ? finish.light.boxShadow : finish.chip.boxShadow,
                    }}
                    class="transition-colors duration-200 motion-reduce:transition-none"
                  >
                    <Icon name={q.icon} size={size.icon} tint={open().includes(q.value) ? colors.onAccent : colors.muted} />
                  </View>
                }
              />
              <AccordionPanel reveal accessibilityLabel={q.question}>
                <Body start={size.control + 6 + size.gap}>
                  {q.answer.map((line) => (
                    <Text style={{ fontSize: size.label, lineHeight: Math.round(size.label * 1.45), color: colors.muted }}>{line}</Text>
                  ))}
                </Body>
              </AccordionPanel>
            </AccordionItem>
          ))}
        </Accordion>
        <Text style={{ fontSize: size.detail, color: colors.faint }}>{question() ? `Reading: ${question()}` : "Pick a question to read its answer"}</Text>
      </Card>
    );
  }

  function Settings() {
    const SECTIONS = ["notifications", "privacy", "display", "advanced"];
    const open = signal<string[]>(["notifications"]);
    const nested = signal<string[]>([]);
    const alerts = signal({ messages: true, mentions: true, digest: false });
    const visibility = signal("Contacts");
    const textSize = signal<"small" | "default" | "large">("default");
    const cellular = signal(true);
    const bounds = signal(false);
    const onCount = () => Object.values(alerts()).filter(Boolean).length;
    const change = (value: string[]) => {
      open.set(value);
      last.set(`Settings: ${value.length ? value.join(", ") : "all closed"}`);
    };

    function Toggle(props: { label: string; detail: string; on: boolean; set: (on: boolean) => void }) {
      const look = switchLook(() => props.on, size.switch);
      return (
        <Switch
          checked={props.on}
          onChange={({ checked }) => {
            props.set(checked);
            last.set(`${props.label}: ${checked ? "on" : "off"}`);
          }}
          style={{ ...hoverRow(), flexDirection: "row-reverse" }}
          activeStyle={pressed}
          hoverStyle={hovered()}
          focusStyle={focusRing()}
          trackStyle={look.trackStyle}
          thumbStyle={look.thumbStyle}
        >
          <Label label={props.label} detail={props.detail} />
        </Switch>
      );
    }

    function Choice(props: { label: string; detail: string }) {
      const on = () => visibility() === props.label;
      return (
        <Radio
          checked={on()}
          onChange={() => {
            visibility.set(props.label);
            last.set(`Profile visible to: ${props.label}`);
          }}
          style={hoverRow()}
          activeStyle={pressed}
          hoverStyle={hovered()}
          focusStyle={focusRing()}
        >
          <View
            style={{
              width: size.control,
              height: size.control,
              borderRadius: size.control / 2,
              alignItems: "center",
              justifyContent: "center",
              borderWidth: 1,
              ...(on() ? finish.light : { backgroundColor: colors.field, borderColor: colors.fieldBorder, boxShadow: finish.field.boxShadow }),
            }}
          >
            {on() ? <View style={{ width: size.dot, height: size.dot, borderRadius: size.dot / 2, backgroundColor: colors.onAccent }} /> : null}
          </View>
          <Label label={props.label} detail={props.detail} />
        </Radio>
      );
    }

    return (
      <Card
        icon="collapsible"
        title="Settings"
        subtitle="Several sections open together, controls inside, one nested"
        right={
          <Button
            label={open().length === SECTIONS.length ? "Collapse all" : "Expand all"}
            variant="secondary"
            size="small"
            onPress={() => change(open().length === SECTIONS.length ? [] : SECTIONS)}
          />
        }
      >
        <Accordion multiple value={open()} onChange={({ value }) => change(value)}>
          <AccordionItem value="notifications">
            <Heading title="Notifications" detail={`${onCount()} of 3 on`} />
            <AccordionPanel reveal accessibilityLabel="Notifications">
              <Body start={BLEED}>
                <Toggle label="Messages" detail="A banner for every new message" on={alerts().messages} set={(on) => alerts.set({ ...alerts(), messages: on })} />
                <Toggle label="Mentions" detail="When someone writes your name" on={alerts().mentions} set={(on) => alerts.set({ ...alerts(), mentions: on })} />
                <Toggle label="Weekly digest" detail="A summary every Monday morning" on={alerts().digest} set={(on) => alerts.set({ ...alerts(), digest: on })} />
              </Body>
            </AccordionPanel>
          </AccordionItem>
          <Divider show />
          <AccordionItem value="privacy">
            <Heading title="Privacy" detail={`Profile visible to ${visibility().toLowerCase()}`} />
            <AccordionPanel reveal accessibilityLabel="Privacy">
              <Body start={BLEED}>
                <RadioGroup>
                  <Choice label="Everyone" detail="Anyone with the app can find you" />
                  <Choice label="Contacts" detail="Only people in your address book" />
                  <Choice label="Nobody" detail="Hidden from search and suggestions" />
                </RadioGroup>
              </Body>
            </AccordionPanel>
          </AccordionItem>
          <Divider show />
          <AccordionItem value="display">
            <Heading title="Display" detail={`Text size: ${textSize()}`} />
            <AccordionPanel reveal accessibilityLabel="Display">
              <Body start={0} gap={size.gap}>
                <Segmented
                  options={[
                    { value: "small", label: "Small" },
                    { value: "default", label: "Default" },
                    { value: "large", label: "Large" },
                  ]}
                  value={textSize()}
                  onChange={(value) => {
                    textSize.set(value);
                    last.set(`Text size: ${value}`);
                  }}
                  size={pointer ? "small" : "regular"}
                  fill
                />
                <View style={{ padding: 12, borderRadius: 8, backgroundColor: colors.inset, borderWidth: 1, borderColor: alpha(colors.text, 0.06) }}>
                  <Text style={{ fontSize: { small: 13, default: 15, large: 18 }[textSize()], color: colors.text }}>The quick brown fox jumps over the lazy dog.</Text>
                </View>
              </Body>
            </AccordionPanel>
          </AccordionItem>
          <Divider show />
          <AccordionItem value="advanced">
            <Heading title="Advanced" detail="Options most people leave alone" />
            <AccordionPanel reveal accessibilityLabel="Advanced">
              <Body start={size.gap}>
                {/* An accordion inside a panel: its own value, one section at a time, headings a level down. */}
                <Accordion
                  value={nested()}
                  onChange={({ value }) => {
                    nested.set(value);
                    last.set(`Advanced: ${value.length ? value.join(", ") : "all closed"}`);
                  }}
                >
                  <AccordionItem value="network">
                    <Heading level={4} title="Network" detail={cellular() ? "Cellular data on" : "Wi-Fi only"} />
                    <AccordionPanel reveal accessibilityLabel="Network">
                      <Body start={BLEED}>
                        <Toggle label="Use cellular data" detail="Sync when Wi-Fi is not around" on={cellular()} set={(on) => cellular.set(on)} />
                      </Body>
                    </AccordionPanel>
                  </AccordionItem>
                  <Divider show />
                  <AccordionItem value="developer">
                    <Heading level={4} title="Developer" detail="Tools for building the app" />
                    <AccordionPanel reveal accessibilityLabel="Developer">
                      <Body start={BLEED}>
                        <Toggle label="Show layout bounds" detail="Outline every view on screen" on={bounds()} set={(on) => bounds.set(on)} />
                      </Body>
                    </AccordionPanel>
                  </AccordionItem>
                </Accordion>
              </Body>
            </AccordionPanel>
          </AccordionItem>
        </Accordion>
      </Card>
    );
  }

  function Last() {
    return (
      <Card icon="system" title="Last event">
        <Text style={{ fontSize: 13, color: colors.text, fontFamily: mono }}>{last()}</Text>
      </Card>
    );
  }

  return <DemoPage cards={[Faq, Settings, Last]} />;
}
