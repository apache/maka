import { mount, signal, Text, View } from "nsh";
import { Accordion, AccordionHeader, AccordionItem, AccordionPanel, AccordionTrigger } from "nsh/base";
import { desktop, Log, Panel, Segmented, Split, ui, controlSize, listRow, RowLabel, sectionSurface, DisclosureChevron, disclosurePanel, disclosureTriggerLook } from "./palette";

// An FAQ: each item a heading whose trigger (a button that says whether it
// is expanded) opens its answer. The app owns which items are open
// (`value`) and sets what `onChange` reports; one at a time, or several
// with `multiple`. The panels spring open and shut (`reveal`) and the
// items below move with them; the chevron turns with `group-aria-expanded:`.
// Each trigger is a shared row (`listRow`, through `disclosureTriggerLook`:
// the hover fill reaching past the content, the keyboard's focus ring, a
// press that dims, dimmed while disabled), its chevron and panel the shared
// ones (`DisclosureChevron`, `disclosurePanel`); the reveal and the chevron
// stay still with reduced motion.

const FAQ: { value: string; question: string; answer: string; disabled?: boolean }[] = [
  { value: "shipping", question: "How long does shipping take?", answer: "Orders leave the warehouse within a day and arrive in two to five working days." },
  { value: "returns", question: "Can I return an item?", answer: "Within 30 days, unused and in its box: print the label from your order and drop it off." },
  { value: "warranty", question: "What does the warranty cover?", answer: "Two years against defects in materials and workmanship, parts and labour included." },
  { value: "gift", question: "Can I send it as a gift?", answer: "Gift wrapping opens with the holiday season.", disabled: true },
];

const MODES = ["one at a time", "several"] as const;

function App() {
  const open = signal<string[]>(["shipping"]);
  const mode = signal<(typeof MODES)[number]>("one at a time");
  const events = signal<string[]>([]);
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>accordion</Text>
      <Text style={{ color: ui().muted }}>{desktop ? "Click a question, or Tab to it and press Space" : "Tap a question to read its answer"}</Text>

      <Split
        gap={14}
        inspector={
          <>
            <Panel title="multiple">
              <Segmented
                options={MODES}
                value={mode()}
                onChange={(value) => {
                  mode.set(value);
                  // One at a time keeps the item opened last.
                  if (value === "one at a time") open.set(open().slice(-1));
                }}
              />
            </Panel>
            <Panel title="value">
              <Text style={{ fontSize: 13, color: ui().text }}>{open().length ? open().join(", ") : "none open"}</Text>
            </Panel>
            <Log title="onChange({ value })" lines={events()} minHeight={92} />
          </>
        }
      >
        <Accordion
          value={open()}
          multiple={mode() === "several"}
          onChange={({ value }) => {
            open.set(value);
            events.set([`[${value.join(", ")}]`, ...events()].slice(0, 4));
          }}
          style={sectionSurface({ padded: true })}
        >
          {FAQ.map((item, i) => (
            <AccordionItem value={item.value} disabled={item.disabled}>
              <View style={{ height: i === 0 ? 0 : 1, backgroundColor: ui().line }} />
              <AccordionHeader>
                <AccordionTrigger {...disclosureTriggerLook({ first: true, disabled: item.disabled })}>
                  <RowLabel label={item.question} />
                  <DisclosureChevron accordion />
                </AccordionTrigger>
              </AccordionHeader>
              <AccordionPanel reveal accessibilityLabel={item.question}>
                <View style={disclosurePanel()}>
                  <Text style={{ fontSize: controlSize.label, lineHeight: Math.round(controlSize.label * 1.45), color: ui().muted }}>{item.answer}</Text>
                </View>
              </AccordionPanel>
            </AccordionItem>
          ))}
        </Accordion>
      </Split>
    </View>
  );
}

mount(App);
