import { Image, mount, signal, Text, View } from "nsh";
import { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPagination, CarouselPaginationItem, CarouselPrevious } from "nsh/base";
import { carouselArrowLook, CarouselDot, carouselDotItemLook, carouselPaginationLook, carouselSizes, desktop, focusRing, Icon, Log, photoUrl, Split, tint, ui, type PhotoName } from "./palette";

// Photos of the launch pad, the gallery's (`photoUrl`), each with a caption
// over a shade at its foot. The arrows, the dots and the pill that springs
// between them come from the shared look (`carouselArrowLook`,
// `carouselPaginationLook`, `carouselDotItemLook`, `CarouselDot`): raised
// arrows that sink a little while pressed, fade out with nothing to move to
// and take the palette's hover and focus ring.
const shots: { photo: PhotoName; name: string; detail: string }[] = [
  { photo: "rays", name: "On the pad", detail: "Dusk at the launch site" },
  { photo: "fairing", name: "The fairing", detail: "Close up, before stacking" },
  { photo: "day", name: "At the tower", detail: "The stack by daylight" },
  { photo: "rollout", name: "Rollout", detail: "Moved to the pad at night" },
  { photo: "liftoff", name: "Liftoff", detail: "Clear of the tower" },
];

function App() {
  const shown = signal(0);
  const events = signal<string[]>([]);
  const log = (line: string) => events.set([line, ...events()].slice(0, 3));
  const arrow = carouselArrowLook();
  const dots = carouselPaginationLook();
  return (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>carousel</Text>
      <Text style={{ color: ui().muted }}>
        {desktop
          ? "Scroll with the touchpad, click the arrows or a dot, or focus it and press ← →; after the last photo comes the first"
          : "Swipe the photos, or tap the arrows or a dot; after the last photo comes the first"}
      </Text>

      <Split gap={14} inspector={<Log title={`onChange · ${shots[shown()].name}`} lines={events()} minHeight={76} />}>
        {/* Five cards at 85% span more than the view and a card: the loop is seamless. */}
        <Carousel
          looping
          accessibilityLabel="Photos of the launch pad"
          onChange={({ index }) => {
            shown.set(index);
            log(`index: ${index} (${shots[index].name})`);
          }}
          style={{ gap: 12, borderRadius: 14 }}
          focusStyle={focusRing(4)}
        >
          {/* Each card is 85% of the view: the next one peeks in. */}
          <CarouselContent style={{ height: desktop ? 150 : 170, gap: 10 }}>
            <Each of={shots}>
              {(p, i) => (
                <CarouselItem
                  accessibilityLabel={`${i() + 1} of ${shots.length}: ${p().name}`}
                  style={{
                    width: "85%",
                    height: "100%",
                    padding: 16,
                    justifyContent: "flex-end",
                    gap: 2,
                    borderRadius: 14,
                    borderCurve: "continuous",
                    overflow: "hidden",
                    backgroundColor: ui().raised.backgroundColor,
                  }}
                >
                  <Image src={photoUrl(p().photo)} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, objectFit: "cover" }} />
                  {/* A shade at the foot, so the caption reads on any photo. */}
                  <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundImage: "linear-gradient(180deg, rgba(0,0,0,0) 40%, rgba(0,0,0,0.62) 100%)" }} />
                  <Text style={{ fontSize: 20, fontWeight: "700", color: "#ffffff" }}>{p().name}</Text>
                  <Text style={{ fontSize: 13, color: tint("#ffffff", 0.82) }}>{p().detail}</Text>
                </CarouselItem>
              )}
            </Each>
          </CarouselContent>

          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <CarouselPrevious accessibilityLabel="Previous photo" {...arrow}>
              <Icon name="back" size={carouselSizes.arrowIcon} tint={ui().text} />
            </CarouselPrevious>
            {/* The dots: a pill springs to the one of the photo shown. */}
            <CarouselPagination accessibilityLabel="Choose a photo" {...dots} style={{ ...dots.style, flex: 1, justifyContent: "center" }}>
              <Each of={shots}>
                {(p, i) => (
                  <CarouselPaginationItem index={i()} accessibilityLabel={p().name} {...carouselDotItemLook()}>
                    <CarouselDot selected={i() === shown()} />
                  </CarouselPaginationItem>
                )}
              </Each>
            </CarouselPagination>
            <CarouselNext accessibilityLabel="Next photo" {...arrow}>
              <Icon name="chevron" size={carouselSizes.arrowIcon} tint={ui().text} />
            </CarouselNext>
          </View>
        </Carousel>
      </Split>
    </View>
  );
}

mount(App);
