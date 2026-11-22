import { cleanup, signal } from "nsh";
import { GlobalShortcut, isAvailable } from "nsh/desktop";
import { Badge, Button, Caption, Card, DemoPage, Row } from "../ui";

/**
 * `GlobalShortcut` of `nsh/desktop`: a keystroke heard whichever app has
 * the keyboard.
 */
export function ShortcutDemo() {
  const registered = signal("Not registered");
  const presses = signal(0);
  const shortcut = "ctrl+alt+k";
  const register = () =>
    void GlobalShortcut.register(shortcut, () => presses.set(presses() + 1)).then((ok) =>
      registered.set(ok ? "Registered" : "Refused"),
    );
  const unregister = () => {
    GlobalShortcut.unregister(shortcut);
    registered.set("Not registered");
  };
  cleanup(() => GlobalShortcut.unregisterAll());
  return (
    <DemoPage
      cards={[
        () => (
          <Card title="Global shortcut" subtitle={isAvailable ? "Ctrl+Alt+K, from any app" : "Desktops only"}>
            <Row first>
              <Button label="Register" onPress={register} />
              <Button label="Unregister" variant="ghost" onPress={unregister} />
              <Badge label={registered()} />
            </Row>
            <Caption label={`Pressed ${presses()} times`} />
          </Card>
        ),
      ]}
    />
  );
}
