import { createMotion, mount, signal, Text, View } from "nsh";

function Press(props: { label: string; onPress: () => void }) {
  return (
    <View onPress={props.onPress}>
      <Text>{props.label}</Text>
    </View>
  );
}

function App() {
  const status = signal("idle");
  const angle = signal(-1);
  // A loading spinner: it spins until it is stopped, as a loading toast's
  // icon does.
  const spinner = createMotion({});
  const upload = () => {
    status.set("uploading");
    void spinner.play("spin", { duration: 900 });
    setTimeout(() => status.set("uploaded"), 1000);
  };
  return (
    <View style={{ flex: 1 }}>
      <View style={{ width: 18, height: 18, ...spinner.style }} />
      <Text>{`Status: ${status()}`}</Text>
      <Text>{`Angle: ${angle()}`}</Text>
      <Press label="Upload" onPress={upload} />
      <Press label="Read" onPress={() => void spinner.rotate.getValue().then((v) => angle.set(Math.round(v)))} />
    </View>
  );
}

mount(App);
