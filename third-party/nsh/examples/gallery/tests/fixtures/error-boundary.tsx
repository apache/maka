import { ErrorBoundary, mount, signal, Text, View } from "nsh";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function Profile(props: { name: () => string | undefined }) {
  return <Text>Hello, {props.name()!.toUpperCase()}</Text>;
}

function App() {
  const name = signal<string | undefined>("ada");
  return (
    <View style={{ flex: 1, paddingTop: 100 }}>
      <Text>Header</Text>
      <ErrorBoundary
        fallback={(error, reset) => (
          <View>
            <Text>Failed: {message(error)}</Text>
            <View onPress={() => { name.set("grace"); reset(); }} style={{ padding: 20 }}>
              <Text>Try again</Text>
            </View>
          </View>
        )}
      >
        <Profile name={name} />
        <View onPress={() => { throw new Error("press failed"); }} style={{ padding: 20 }}>
          <Text>Throw</Text>
        </View>
      </ErrorBoundary>
      <View onPress={() => name.set(undefined)} style={{ padding: 20 }}>
        <Text>Forget name</Text>
      </View>
    </View>
  );
}

mount(App);
