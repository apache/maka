// A case of the API's test suite (docs/dev/compatibility.md): `Accordion`
// of `nsh/base` and its parts. The app owns `value`, the open items'
// values; a trigger's press reports the next one (one item open at a time,
// several with `multiple`). Each item is a 20-point trigger in a level-2
// heading over a 30-point panel: the first panel kept mounted while closed,
// the second revealed with a springing height (in the layout while closed,
// zero high), the third item disabled.
import { Text, View, signal } from "nsh";
import { Accordion, AccordionHeader, AccordionItem, AccordionPanel, AccordionTrigger } from "nsh/base";

function App() {
  const open = signal<string[]>([]);
  const multiple = signal(false);
  const changes = signal(0);
  const item = (value: string, title: string, panel: { reveal?: boolean; keepMounted?: boolean }, disabled = false) => (
    <AccordionItem testID={`item-${value}`} value={value} disabled={disabled}>
      <AccordionHeader testID={`header-${value}`} level={2}>
        <AccordionTrigger
          testID={`trigger-${value}`}
          style={{ height: 20 }}
          class="aria-expanded:bg-[#00ff00]"
          expandedStyle={{ opacity: 0.5 }}
        >
          <Text>{title}</Text>
        </AccordionTrigger>
      </AccordionHeader>
      <AccordionPanel testID={`panel-${value}`} accessibilityLabel={title} reveal={panel.reveal} keepMounted={panel.keepMounted}>
        <View style={{ height: 30 }}>
          <Text>{`${title} details`}</Text>
        </View>
      </AccordionPanel>
    </AccordionItem>
  );
  return (
    <View style={{ flex: 1, paddingTop: 20 }}>
      <Accordion
        testID="faq"
        value={open()}
        multiple={multiple()}
        onChange={({ value }) => {
          changes.set(changes() + 1);
          open.set(value);
        }}
      >
        {item("a", "Shipping", { keepMounted: true })}
        {item("b", "Returns", { reveal: true })}
        {item("c", "Billing", {}, true)}
      </Accordion>
      <View testID="multiple" style={{ height: 10 }} onPress={() => multiple.set(!multiple())} />
      <View testID="open-billing" style={{ height: 10 }} onPress={() => open.set(["c"])} />
      <Text>{`Open: ${open().join(",") || "none"}`}</Text>
      <Text>{`Changes: ${changes()}`}</Text>
    </View>
  );
}

export default App;
