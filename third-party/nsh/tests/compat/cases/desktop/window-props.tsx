// A case of the API's test suite (docs/dev/compatibility.md): the view props
// of a title bar the app draws (`desktop={{…}}`): `windowDrag` drags the
// window, `windowControl` makes a view act as a system window button, and
// `windowResize` resizes a frameless window by an edge or a corner. The
// platform answers each natively; the script checks what it is told.
import { Text, View } from "nsh";

function App() {
  return (
    <View style={{ flex: 1 }}>
      <View testID="bar" desktop={{ windowDrag: true }} style={{ height: 40, flexDirection: "row" }}>
        <Text>Document</Text>
        <View testID="minimize" desktop={{ windowControl: "minimize" }} style={{ width: 40, height: 32 }} />
        <View testID="maximize" desktop={{ windowControl: "maximize" }} style={{ width: 40, height: 32 }} />
        <View testID="close" desktop={{ windowControl: "close" }} style={{ width: 40, height: 32 }} />
      </View>
      <View testID="edge" desktop={{ windowResize: "right" }} style={{ position: "absolute", right: 0, top: 12, bottom: 12, width: 5 }} />
      <View testID="corner" desktop={{ windowResize: "bottomRight" }} style={{ position: "absolute", right: 0, bottom: 0, width: 12, height: 12 }} />
    </View>
  );
}

export default App;
