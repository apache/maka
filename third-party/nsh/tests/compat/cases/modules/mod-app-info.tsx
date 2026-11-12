import { appInfo, Text, View } from "nsh";

// Read when the module runs, before the entry's code: the build hands the
// information over first.
const early = appInfo();

function App() {
  const info = appInfo();
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>{`App: ${info.id} ${info.name}`}</Text>
      <Text>{`Version: ${info.version} build ${info.build}`}</Text>
      <Text>{`Development: ${info.development}`}</Text>
      <Text>{`Early: ${early.version}`}</Text>
    </View>
  );
}

export default App;
