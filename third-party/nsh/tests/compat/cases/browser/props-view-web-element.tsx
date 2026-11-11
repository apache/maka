// A case of the API's test suite (docs/dev/compatibility.md): the HTML
// element the web draws a view or text as where `role` cannot say it
// (`web={{ element }}`). The platform receives it with the view's props;
// headings are `role="header"` with a level, links `Link`s with an `href`.
// Its script checks each.
import { Text, View } from "nsh";

function App() {
  return (
    <View testID="article" web={{ element: "article" }} style={{ flex: 1, paddingTop: 64 }}>
      <Text testID="heading" role="header" accessibilityLevel={1}>
        Notes
      </Text>
      <Text testID="date" web={{ element: "time" }}>
        2026-11-09
      </Text>
      <Text testID="paragraph" web={{ element: "p" }}>
        A paragraph
      </Text>
    </View>
  );
}

export default App;
