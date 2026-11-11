// A case of the API's test suite (docs/dev/compatibility.md): `nsh/web` on
// the headless runtime, which is no page: a
// `Head` with every prop renders nothing (the views beside it stay as
// they are). In a browser it sets the page's `<head>`. Its script checks
// both.
import { Text, View, signal } from "nsh";
import { Head } from "nsh/web";

function App() {
  const title = signal("Notes");
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Head
        title={title()}
        description="Short notes on the markets"
        canonical="/notes"
        lang="en"
        meta={[
          { name: "robots", content: "index, follow" },
          { property: "og:type", content: "website" },
        ]}
        jsonLd={{ "@context": "https://schema.org", "@type": "WebSite", name: "Notes" }}
      />
      <Text testID="retitle" onPress={() => title.set("Q3 earnings")}>
        {`Title: ${title()}`}
      </Text>
    </View>
  );
}

export default App;
