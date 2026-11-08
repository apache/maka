import { Notifications, signal } from "nsh";
import { Badge, Button, Caption, Card, DemoPage, Row } from "../ui";

/**
 * `Notifications` of `nsh`: the permission asked for when the user wants
 * notifications, one shown and replaced under its id, its press, the badge
 * on the app's icon.
 */
export function NotificationsDemo() {
  const permission = signal("…");
  const last = signal("Nothing pressed yet");
  const badge = signal(0);
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
            <Row>
              <Button label="Allow notifications" onPress={() => asked(Notifications.requestPermission())} />
              <Badge label={permission()} />
            </Row>
          </Card>
        ),
        () => (
          <Card title="A message" subtitle="Showing the same id replaces it; pressing it reports the id">
            <Row>
              <Button label="Show" onPress={() => show("chat:ada", "Ada", "Are you coming tonight?")} />
              <Button label="Replace" variant="secondary" onPress={() => show("chat:ada", "Ada", "I saved you a seat.")} />
              <Button label="Remove" variant="ghost" onPress={() => Notifications.close("chat:ada")} />
            </Row>
            <Caption label={last()} />
          </Card>
        ),
        () => (
          <Card title="Badge" subtitle="The count on the app's icon, in the Dock on macOS">
            <Row>
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
