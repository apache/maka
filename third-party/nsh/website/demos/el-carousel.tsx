import { mount, signal, Text, View } from "nsh";
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPagination, CarouselPaginationItem, CarouselPrevious } from "nsh/base";
import { desktop, focusRing, hoverFill, Icon, Log, Split, tint, ui } from "./palette";

const places: { name: string; detail: string; from: string; to: string }[] = [
  { name: "Lisbon", detail: "Tiles, trams and the river light", from: "#3d5a73", to: "#8fb3c9" },
  { name: "Kyoto", detail: "Temples, moss gardens, quiet lanes", from: "#5a3d4a", to: "#c98fa6" },
  { name: "Oaxaca", detail: "Markets, mole and mezcal", from: "#6b4a2f", to: "#d1a06b" },
  { name: "Tromsø", detail: "Fjords under the northern lights", from: "#2f4a4f", to: "#6bb3a8" },
  { name: "Marrakesh", detail: "Riads, souks and courtyards", from: "#73402f", to: "#d9875b" },
];

function App() {
  const shown = signal(0);
  const events = signal<string[]>([]);
  const log = (line: string) => events.set([line, ...events()].slice(0, 3));
  const arrow = {
    style: { width: desktop ? 28 : 34, height: desktop ? 28 : 34, borderRadius: 999, alignItems: "center", justifyContent: "center", ...ui().raised } as const,
    class: "transition-opacity active:opacity-70 disabled:opacity-30 motion-reduce:transition-none",
    hoverStyle: hoverFill(),
    focusStyle: focusRing(2),
  };
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>carousel</Text>
      <Text style={{ color: ui().muted }}>
        {desktop
          ? "Scroll with the touchpad, click the arrows or a dot, or focus it and press ← →; after the last place comes the first"
          : "Swipe the cards, or tap the arrows or a dot; after the last place comes the first"}
      </Text>

      <Split gap={14} inspector={<Log title={`onChange · ${places[shown()].name}`} lines={events()} minHeight={76} />}>
        {/* Five cards at 85% span more than the view and a card: the loop is seamless. */}
        <Carousel
          looping
          accessibilityLabel="Places to visit"
          onChange={({ index }) => {
            shown.set(index);
            log(`index: ${index} (${places[index].name})`);
          }}
          style={{ gap: 12, borderRadius: 14 }}
          focusStyle={focusRing(4)}
        >
          {/* Each card is 85% of the view: the next one peeks in. */}
          <CarouselContent style={{ height: desktop ? 150 : 170, gap: 10 }}>
            <Each of={places}>
              {(p, i) => (
                <CarouselItem
                  accessibilityLabel={`${i() + 1} of ${places.length}: ${p().name}`}
                  style={{
                    width: "85%",
                    height: "100%",
                    padding: 16,
                    justifyContent: "flex-end",
                    gap: 2,
                    borderRadius: 14,
                    borderCurve: "continuous",
                    backgroundColor: p().from,
                    backgroundImage: `linear-gradient(135deg, ${p().from} 0%, ${p().to} 100%)`,
                  }}
                >
                  <Text style={{ fontSize: 20, fontWeight: "700", color: "#ffffff" }}>{p().name}</Text>
                  <Text style={{ fontSize: 13, color: tint("#ffffff", 0.82) }}>{p().detail}</Text>
                </CarouselItem>
              )}
            </Each>
          </CarouselContent>

          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <CarouselPrevious accessibilityLabel="Previous place" {...arrow}>
              <Icon name="back" size={14} tint={ui().text} />
            </CarouselPrevious>
            {/* The dots: a pill springs to the one of the card shown. */}
            <CarouselPagination
              accessibilityLabel="Choose a place"
              style={{ flex: 1, flexDirection: "row", justifyContent: "center", alignItems: "center" }}
              indicatorStyle={{ top: 7, bottom: 7, marginHorizontal: 2, borderRadius: 4, backgroundColor: ui().accent }}
            >
              <Each of={places}>
                {(p, i) => (
                  <CarouselPaginationItem
                    index={i()}
                    accessibilityLabel={p().name}
                    class="group"
                    style={{ width: 20, height: 20, alignItems: "center", justifyContent: "center", borderRadius: 10 }}
                    focusStyle={focusRing()}
                  >
                    <View
                      class="opacity-60 group-hover:opacity-100 group-selected:opacity-0 transition-opacity motion-reduce:transition-none"
                      style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: tint(ui().text, 0.4) }}
                    />
                  </CarouselPaginationItem>
                )}
              </Each>
            </CarouselPagination>
            <CarouselNext accessibilityLabel="Next place" {...arrow}>
              <Icon name="chevron" size={14} tint={ui().text} />
            </CarouselNext>
          </View>
        </Carousel>
      </Split>
    </View>
  );
}

mount(App);
