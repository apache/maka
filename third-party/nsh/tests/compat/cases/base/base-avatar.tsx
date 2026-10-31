// A case of the API's test suite (docs/dev/compatibility.md): `Avatar` and
// `AvatarGroup` of `nsh/base`, with no look of their own. An avatar shows
// its fallback (the initials of `name`, or the app's `fallback`) while its
// image (`src`) loads, after `fallbackDelay`, and when it fails, and the
// image once it has loaded, reporting each with `onStatusChange`; screen
// readers get an image labelled with the name (`accessibilityLabel` over
// it). The parts take the app's look (`imageClass`, `imageStyle`,
// `fallbackClass`, `fallbackStyle`), and its children sit over the image:
// each avatar's dot is the image's next sibling, which is how the script
// reaches the image (`below:`). A group shows its first `limit` avatars
// and its `overflow` while more people are in it (`total`), styled by
// `overflowClass` / `overflowStyle`, which its script sees in its frame,
// and read by screen readers as `overflowAccessibilityLabel` says.
import { Text, View, signal } from "nsh";
import { Avatar, AvatarGroup } from "nsh/base";

const size = "w-[40px] h-[40px]";

function App() {
  const status = signal("idle");
  return (
    <View style={{ flex: 1, paddingTop: 20, gap: 4 }}>
      <Avatar
        testID="ada"
        src="https://example.com/ada.png"
        name="Ada Lovelace"
        class={size}
        imageClass="rounded-[20px]"
        imageStyle={{ borderWidth: 2 }}
        fallbackClass="bg-[#336699]"
        fallbackStyle={{ opacity: 0.5 }}
        onStatusChange={(e) => status.set(e.status)}
      >
        <View testID="ada-dot" style={{ position: "absolute", right: 0, bottom: 0, width: 10, height: 10 }} />
      </Avatar>
      <Avatar testID="grace" src="https://example.com/grace.png" name="Grace Hopper" fallbackDelay={300} class={size}>
        <View testID="grace-dot" style={{ position: "absolute", right: 0, bottom: 0, width: 10, height: 10 }} />
      </Avatar>
      <Avatar
        testID="edsger"
        name="Edsger Dijkstra"
        accessibilityLabel="Edsger, away"
        class={size}
        fallback={<Text>?</Text>}
      />
      <AvatarGroup
        testID="team"
        limit={2}
        accessibilityLabel="Team"
        class="flex-row self-start"
        overflowClass="w-[30px] h-[50px]"
        overflowStyle={{ height: 60 }}
        overflowAccessibilityLabel="1 more person"
        overflow={<Text>+1</Text>}
      >
        <Avatar name="Alan Turing" class={size} />
        <Avatar name="Barbara Liskov" class={size} />
        <Avatar name="Claude Shannon" class={size} />
      </AvatarGroup>
      <AvatarGroup testID="pair" total={4} class="flex-row self-start" overflow={<Text>+2</Text>}>
        <Avatar name="Donald Knuth" class={size} />
        <Avatar name="Frances Allen" class={size} />
      </AvatarGroup>
      <Text>{`Ada: ${status()}`}</Text>
    </View>
  );
}

export default App;
