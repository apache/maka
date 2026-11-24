import { Notifications, View, signal } from "nsh";
import { AppSettings } from "nsh/mobile";
import { Badge, Button, Caption, Card, DemoPage, Row } from "../ui";

/**
 * `Notifications` of `nsh`: the permission asked for when the user wants
 * notifications (and, on iOS and Android, `nsh/mobile`'s `AppSettings`: the
 * app's page in the system's settings, where a denied permission is turned
 * back on), one shown and replaced under its id, its press, the badge on
 * the app's icon.
 */
export function NotificationsDemo() {
  const permission = signal("…");
  const last = signal("Nothing pressed yet");
  const badge = signal(0);
  const settings = signal(false);
  void AppSettings.available().then((yes) => settings.set(yes));
  const asked = (value: Promise<string>) => void value.then((p) => permission.set(p));
  asked(Notifications.permission());
  Notifications.on("press", ({ id }) => last.set(`Pressed ${id}`));
  const setBadge = (count: number) => {
    badge.set(count);
    Notifications.setBadge(count);
  };
  const show = (id: string, title: string, body: string) =>
    void Notifications.show({ id, title, body }).then((shown) => {
      if (!shown) last.set("Not shown: allow notifications first");
    });
  return (
    <DemoPage
      cards={[
        () => (
          <Card title="Permission" subtitle="Asked once, when the user wants them">
            <Row first>
              <Button label="Allow notifications" onPress={() => asked(Notifications.requestPermission())} />
              <Badge label={permission()} />
            </Row>
            <If when={settings()}>
              <Row>
                {/* The text wraps; the button keeps its width on a phone. */}
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Caption
                    label={permission() === "denied" ? "Denied: only Settings turns them back on" : "Change it any time in Settings"}
                  />
                </View>
                <Button label="Open Settings" variant="secondary" onPress={() => void AppSettings.open()} />
              </Row>
            </If>
          </Card>
        ),
        () => (
          <Card title="A message" subtitle="The same id replaces it; a press reports it">
            <Row first>
              <Button label="Show" onPress={() => show("chat:ada", "Ada", "Are you coming tonight?")} />
              <Button label="Replace" variant="secondary" onPress={() => show("chat:ada", "Ada", "I saved you a seat.")} />
              <Button label="Remove" variant="ghost" onPress={() => Notifications.close("chat:ada")} />
            </Row>
            <Caption label={last()} />
          </Card>
        ),
        () => (
          <Card title="Badge" subtitle="The count on the app's icon, in the Dock on macOS">
            <Row first>
              <Button label="Add one" onPress={() => setBadge(badge() + 1)} />
              <Button label="Clear" variant="ghost" onPress={() => setBadge(0)} />
              <Badge label={String(badge())} />
            </Row>
          </Card>
        ),
      ]}
    />
  );
}
