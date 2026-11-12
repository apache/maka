import { mount, platform, Scroll, signal, Text, View } from "nsh";

// An image viewer: a horizontal pager with a zoomable scroll view per page,
// the first one zoomed in twice.
function App() {
  const width = signal(0);
  const page = signal(0);
  const zoom = signal(2);
  // The first image's offset and how far it goes (zooming in starts it in the middle).
  const x = signal(0);
  const max = signal(0);
  const settle = (offset: { x: number }) => page.set(Math.round(offset.x / width()));
  return (
    <View style={{ flex: 1, paddingTop: 80 }}>
      <Text>{`page: ${page()}`}</Text>
      <Text>{`image: ${Math.round(x())} of ${Math.round(max())}`}</Text>
      <Text>{`Platform: ${platform.os}`}</Text>
      <View onPress={() => zoom.set(1)} style={{ height: 44, justifyContent: "center" }}>
        <Text>Zoom out</Text>
      </View>
      <Scroll
        horizontal
        pagingEnabled
        scrollbar={false}
        style={{ height: 320 }}
        onLayout={({ bounds }) => width.set(bounds.size.width)}
        onMomentumEnd={({ offset }) => settle(offset)}
        onScrollEnd={({ offset }) => settle(offset)}
      >
        {[1, 2, 3].map((n) => (
          <Scroll
            style={{ width: width(), height: 320 }}
            minimumZoomScale={1}
            maximumZoomScale={4}
            zoomScale={n === 1 ? zoom() : 1}
            onScroll={(e) => {
              if (n !== 1) return;
              x.set(e.offset.x);
              max.set(e.contentSize.width - e.size.width);
            }}
          >
            <View style={{ width: width(), height: 320, justifyContent: "center", alignItems: "center", backgroundColor: n === 1 ? "#d8e2f0" : "#f0e2d8" }}>
              <Text>{`Photo ${n}`}</Text>
            </View>
          </Scroll>
        ))}
      </Scroll>
    </View>
  );
}

mount(App);
