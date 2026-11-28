// A case of the API's test suite (docs/dev/compatibility.md): a component's
// host takes a view's accessibility props, as it takes its classes and mouse
// events: `accessibilityDescription`, `accessibilityLevel`,
// `accessible`, `role`, `accessibilityLabel`, `accessibilityHint`,
// `accessibilityState`, `accessibilityValue`, `accessibilityElementsHidden`,
// `importantForAccessibility`, `accessibilityLiveRegion`,
// `accessibilityActions`, `accessibilityActiveDescendant`,
// `accessibilityControls`, `accessibilityDescribedBy` and the actions an
// assistive technology performs (`onAccessibilityAction`), on the views of
// `nsh/base`'s components that do not declare them. Its script checks each.
import { Text, View, signal, type ViewRef } from "nsh";
import { Button, Collapsible } from "nsh/base";

function App() {
  const error = signal<ViewRef>();
  const list = signal<ViewRef>();
  return (
    <View style={{ flex: 1, paddingTop: 20, gap: 4 }}>
      <Button testID="button" accessibilityDescription="Deletes the draft" accessibilityLevel={2}>
        <Text>Delete</Text>
      </Button>
      <Collapsible
        testID="details"
        accessible
        role="region"
        accessibilityLabel="Details"
        accessibilityHint="Shows the details"
        accessibilityState={{ expanded: true }}
        accessibilityValue={{ text: "three" }}
        accessibilityElementsHidden={false}
        accessibilityLiveRegion="polite"
        accessibilityActions={[{ name: "activate" }]}
        accessibilityActiveDescendant={error() ?? null}
        accessibilityControls={list() ?? null}
        accessibilityDescribedBy={error() ?? null}
        onAccessibilityAction={() => {}}
      >
        <Text>Details</Text>
      </Collapsible>
      <Collapsible testID="hidden" importantForAccessibility="no-hide-descendants">
        <Text>Hidden details</Text>
      </Collapsible>
      <Collapsible testID="hidden-elements" accessibilityElementsHidden={true}>
        <Text>Hidden elements</Text>
      </Collapsible>
      <View testID="error" ref={error}>
        <Text>Enter a name</Text>
      </View>
      <View testID="list" ref={list}>
        <Text>List</Text>
      </View>
    </View>
  );
}

export default App;
