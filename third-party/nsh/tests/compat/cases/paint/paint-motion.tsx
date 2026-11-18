// A case of the API's test suite (docs/dev/compatibility.md): transitions
// and the built-in keyframe animations as the platform receives them:
// the animated properties, durations and delays in numbers, `ms` and `s`,
// every timing function (a cubic Bézier past 0..1 kept as written, NSH's
// spring as a style and as a class) and iteration counts, set in either
// order.
import { Text, View } from "nsh";

function App() {
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Text>Motion</Text>
      <View
        testID="fade"
        style={{
          height: 4,
          transitionProperty: "opacity, transform",
          transitionDuration: 300,
          transitionDelay: "50ms",
          transitionTimingFunction: "ease-in-out",
        }}
      />
      <View
        testID="all"
        style={{ height: 4, transitionProperty: "all", transitionDuration: "0.2s", transitionTimingFunction: "linear" }}
      />
      <View testID="colors" style={{ height: 4, transitionProperty: "colors", transitionTimingFunction: "ease" }} />
      <View testID="shadow" style={{ height: 4, transitionProperty: "boxShadow", transitionTimingFunction: "ease-in" }} />
      <View testID="shape" style={{ height: 4, transitionProperty: "borderRadius", transitionTimingFunction: "ease-out" }} />
      <View testID="none" style={{ height: 4, transitionProperty: "none" }} />
      <View
        testID="bezier"
        style={{ height: 4, transitionDuration: 150, transitionTimingFunction: "cubic-bezier(0.4, 0, 0.2, 1)" }}
      />
      <View
        testID="overshoot"
        style={{ height: 4, transitionDuration: 200, transitionTimingFunction: "cubic-bezier(0.3, 1.25, 0.6, 1)" }}
      />
      <View
        testID="spring"
        style={{ height: 4, transitionProperty: "transform", transitionTimingFunction: "spring(620, 36)" }}
      />
      <View testID="spring-class" class="transition-transform ease-spring-[992,45,2]" style={{ height: 4 }} />
      <View
        testID="spin"
        style={{
          height: 4,
          animationName: "spin",
          animationDuration: 1000,
          animationDelay: 0,
          animationTimingFunction: "linear",
          animationIterationCount: "infinite",
        }}
      />
      <View
        testID="ping"
        style={{
          height: 4,
          animationName: "ping",
          animationDuration: "1s",
          animationDelay: "200ms",
          animationTimingFunction: "cubic-bezier(0, 0, 0.2, 1)",
          animationIterationCount: 3,
        }}
      />
      <View testID="pulse" style={{ height: 4, animationName: "pulse", animationDuration: "2s", animationTimingFunction: "ease-in-out" }} />
      <View testID="bounce" style={{ height: 4, animationName: "bounce", animationIterationCount: 1 }} />
      <View testID="still" style={{ height: 4, animationName: "none" }} />
    </View>
  );
}

export default App;
