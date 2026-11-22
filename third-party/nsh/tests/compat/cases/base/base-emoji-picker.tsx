import { Text, View, signal } from "nsh";
import { EmojiPicker, type EmojiPickerRef } from "nsh/base";

function App() {
  const chosen = signal("none");
  const lit = signal("none");
  const query = signal("");
  const group = signal("none");
  const looked = signal("none");
  let picker!: EmojiPickerRef;
  return (
    <View style={{ flex: 1, paddingTop: 20, gap: 4 }}>
      <Text>{`Chosen: ${chosen()}`}</Text>
      <Text>{`Lit: ${lit()}`}</Text>
      <Text>{`Query: ${query()}`}</Text>
      <Text>{`Group: ${group()}`}</Text>
      <Text>{`Looked: ${looked()}`}</Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Text role="button" onPress={() => picker.scrollToGroup("peopleBody", false)}>
          ToPeople
        </Text>
        <Text role="button" onPress={() => query.set("shaking")}>
          ToShaking
        </Text>
        <Text
          role="button"
          onPress={() => {
            void picker.entry("😂").then((entry) =>
              looked.set(entry ? `${entry.label}/${entry.group}/${entry.version}` : "null"),
            );
          }}
        >
          LookUp
        </Text>
      </View>
      <EmojiPicker
        ref={(r) => (picker = r)}
        query={query()}
        onQueryChange={({ query: next }) => query.set(next)}
        onSelect={({ emoji, base, skinTone, label }) => chosen.set(`${emoji} ${base} ${skinTone} ${label}`)}
        onHighlightChange={({ highlighted }) => lit.set(highlighted?.emoji ?? "none")}
        onGroupChange={({ group: next }) => group.set(next)}
        groups={["recent", "smileysEmotion", "peopleBody"]}
        recent={["👍", "🫨"]}
        groupLabels={{ recent: "Recent", smileysEmotion: "Smileys", peopleBody: "People" }}
        annotations={[{ emoji: "😂", label: "LaughCry", keywords: ["xiaoku"] }]}
        skinTone="dark"
        emojiVersion="15"
        columns={6}
        placeholder="FindEmoji"
        accessibilityLabel="Emoji"
        searchAccessibilityLabel="SearchEmoji"
        style={{ height: 320 }}
        searchBarClass="flex-row h-[44px]"
        searchClass="flex-1"
        listClass="bg-[#0000ff]"
        rowClass="h-[40px]"
        itemClass="w-[50px] h-[40px] focus:bg-[#00ff00]"
        groupClass="h-[24px]"
        header={<Text>PickerHeader</Text>}
        footer={<Text>PickerFooter</Text>}
        empty={<Text>NoEmoji</Text>}
        searchPrefix={<Text>Find:</Text>}
        renderGroup={(g) => <Text>{`[${g.label}]`}</Text>}
      />
      <EmojiPicker
        searchable={false}
        groups={["flags"]}
        renderItem={(entry) => <Text>{`<${entry.label}>`}</Text>}
        accessibilityLabel="Flags"
        style={{ height: 60 }}
      />
    </View>
  );
}

export default App;
