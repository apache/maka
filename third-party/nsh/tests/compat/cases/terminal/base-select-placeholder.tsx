// A case of the API's test suite (docs/dev/compatibility.md): `Select` of
// `nsh/base` in a terminal with nothing chosen: its trigger shows the app's
// `placeholder` (no `trigger` given) and screen readers hear it as the
// trigger's value; a select given its `trigger` shows the app's content.
// Its script checks each.
import { Text, View } from "nsh";
import { Select } from "nsh/base";

const TEAMS = [
  { value: "design", title: "Design" },
  { value: "build", title: "Build" },
];

export default function App() {
  return (
    <View style={{ flex: 1, gap: 8 }}>
      <Select items={TEAMS} value={null} placeholder="Choose a team" accessibilityLabel="Team" />
      <Select
        items={TEAMS}
        value="build"
        accessibilityLabel="Owner"
        trigger={<Text>Owner: Build team</Text>}
      />
    </View>
  );
}
