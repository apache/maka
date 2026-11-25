import { mount, signal, Text, View } from "nsh";
import { createNavStack, NavPage, NavStack } from "nsh/base";
import { TabBar } from "nsh/mobile";

type Route =
  | { name: "root" }
  | { name: "detail" }
  | { name: "nested" };

function App() {
  const activeTab = signal(0);
  const selected = signal(0);
  const bottomHits = signal(0);
  const firstNav = createNavStack<Route>([{ name: "root" }]);
  const secondNav = createNavStack<Route>([
    { name: "root" },
    { name: "detail" },
  ]);

  return (
    <View style={{ flex: 1 }}>
      <View
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          display: activeTab() === 0 ? "flex" : "none",
        }}
      >
        <NavStack state={firstNav} style={{ flex: 1 }}>
          {(route) => {
            if (route.name === "root") {
              return (
                <NavPage title="Home">
                  <View style={{ flex: 1, padding: 16, gap: 12 }}>
                    <Text>{`tab=${activeTab()} selected=${selected()} hits=${bottomHits()} depth=${firstNav.routes().length}`}</Text>
                    <View
                      testID="push-hiding"
                      role="button"
                      onPress={() => firstNav.push({ name: "detail" })}
                      style={{ padding: 12 }}
                    >
                      <Text>Push Hiding</Text>
                    </View>
                    <View
                      testID="switch-tab-1"
                      role="button"
                      onPress={() => activeTab.set(1)}
                      style={{ padding: 12 }}
                    >
                      <Text>Show Second Stack</Text>
                    </View>
                  </View>
                </NavPage>
              );
            }
            if (route.name === "detail") {
              return (
                <NavPage title="Detail" hidesBottomBarWhenPushed>
                  <View style={{ flex: 1, padding: 16, gap: 12 }}>
                    <Text>{`tab=${activeTab()} selected=${selected()} hits=${bottomHits()} depth=${firstNav.routes().length}`}</Text>
                    <View
                      testID="push-nested"
                      role="button"
                      onPress={() => firstNav.push({ name: "nested" })}
                      style={{ padding: 12 }}
                    >
                      <Text>Push Nested</Text>
                    </View>
                    <View
                      testID="pop-page"
                      role="button"
                      onPress={() => firstNav.pop()}
                      style={{ padding: 12 }}
                    >
                      <Text>Pop</Text>
                    </View>
                    <View
                      style={{
                        position: "absolute",
                        left: 0,
                        right: 0,
                        bottom: 24,
                        height: 72,
                        flexDirection: "row",
                      }}
                    >
                      <View style={{ flex: 1 }} />
                      <View
                        testID="bottom-right"
                        role="button"
                        onPress={() => bottomHits.set(bottomHits() + 1)}
                        style={{
                          flex: 1,
                          justifyContent: "center",
                          alignItems: "center",
                        }}
                      >
                        <Text>BottomRight</Text>
                      </View>
                    </View>
                  </View>
                </NavPage>
              );
            }
            return (
              <NavPage title="Nested">
                <View style={{ flex: 1, padding: 16, gap: 12 }}>
                  <Text>{`tab=${activeTab()} selected=${selected()} hits=${bottomHits()} depth=${firstNav.routes().length}`}</Text>
                  <View
                    testID="pop-to-root"
                    role="button"
                    onPress={() => firstNav.popToRoot()}
                    style={{ padding: 12 }}
                  >
                    <Text>Pop To Root</Text>
                  </View>
                  <View
                    style={{
                      position: "absolute",
                      left: 0,
                      right: 0,
                      bottom: 24,
                      height: 72,
                      flexDirection: "row",
                    }}
                  >
                    <View style={{ flex: 1 }} />
                    <View
                      testID="bottom-right-nested"
                      role="button"
                      onPress={() => bottomHits.set(bottomHits() + 1)}
                      style={{
                        flex: 1,
                        justifyContent: "center",
                        alignItems: "center",
                      }}
                    >
                      <Text>BottomRightNested</Text>
                    </View>
                  </View>
                </View>
              </NavPage>
            );
          }}
        </NavStack>
      </View>

      <View
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          display: activeTab() === 1 ? "flex" : "none",
        }}
      >
        <NavStack state={secondNav} style={{ flex: 1 }}>
          {(route) =>
            route.name === "root" ? (
              <NavPage title="Second Root">
                <View style={{ flex: 1 }} />
              </NavPage>
            ) : (
              <NavPage title="Second Hiding" hidesBottomBarWhenPushed>
                <View style={{ flex: 1, padding: 16, gap: 12 }}>
                  <Text>{`tab=${activeTab()} selected=${selected()} hits=${bottomHits()} second=${secondNav.routes().length}`}</Text>
                  <View
                    testID="switch-tab-0"
                    role="button"
                    onPress={() => activeTab.set(0)}
                    style={{ padding: 12 }}
                  >
                    <Text>Back To First Stack</Text>
                  </View>
                  <View
                    style={{
                      position: "absolute",
                      left: 0,
                      right: 0,
                      bottom: 24,
                      height: 72,
                      flexDirection: "row",
                    }}
                  >
                    <View style={{ flex: 1 }} />
                    <View
                      testID="bottom-right-second"
                      role="button"
                      onPress={() => bottomHits.set(bottomHits() + 1)}
                      style={{
                        flex: 1,
                        justifyContent: "center",
                        alignItems: "center",
                      }}
                    >
                      <Text>BottomRightSecond</Text>
                    </View>
                  </View>
                </View>
              </NavPage>
            )
          }
        </NavStack>
      </View>

      <View
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 24,
          height: 72,
          flexDirection: "row",
          pointerEvents: "box-none",
        }}
      >
        <View
          testID="tap-tab-records"
          role="button"
          onPress={() => bottomHits.set(bottomHits() + 1)}
          style={{ flex: 1 }}
        />
        <View
          testID="tap-tab-stats"
          role="button"
          onPress={() => bottomHits.set(bottomHits() + 1)}
          style={{ flex: 1 }}
        />
      </View>

      <View
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          pointerEvents: "box-none",
        }}
      >
        <TabBar
          items={[{ title: "Records" }, { title: "Stats" }]}
          selectedIndex={selected()}
          onChange={({ index }) => selected.set(index)}
        />
      </View>
    </View>
  );
}

mount(() => <App />);
