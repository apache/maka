import { mount, signal, Text, View } from "nsh";
import { Button, Dialog, Input, RichEditor, StarterKit, createRichEditor } from "nsh/base";

// A dialog opened while a field under it has the focus: an editor, then a
// plain input.
const editor = createRichEditor({ extensions: [StarterKit] });
const open = signal(false);
const closed = signal(0);

mount(() => (
  <View>
    <RichEditor testID="editor" editor={editor} />
    <Input testID="input" />
    <Button testID="open" onPress={() => open.set(true)}>
      <Text>Open</Text>
    </Button>
    <Text>{`Cancelled: ${closed()}`}</Text>
    <Dialog
      open={open()}
      onCancel={() => {
        closed.set(closed() + 1);
        open.set(false);
      }}
    >
      <Text>In dialog</Text>
    </Dialog>
  </View>
));
