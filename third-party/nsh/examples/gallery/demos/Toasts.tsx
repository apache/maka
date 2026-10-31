import { LayoutAnimation, signal, Text, View } from "nsh";
import { dismissToast, toast, updateToast } from "../toast";
import { Button, Caption, Card, colors, DemoPage, Row, Tip, Toggle } from "../ui";
import { Avatar, createEvents, pointer, Trigger } from "./OverlayUi";

type Message = { id: number; from: string; subject: string };

/**
 * The gallery's toasts (`toast.tsx`, on `nsh/base`'s `ToastManager`,
 * `ToastStack` and `Toast`) as an app sends them: one of each kind, with
 * an action where there is something to do; a loading toast that counts
 * its progress and becomes its result in place; an undo for what was just
 * done; a burst that stacks. They come in from below, leave shrinking, and
 * a swipe takes one away.
 */
export function Toasts() {
  const { log, Events } = createEvents("Show a toast");

  function Kinds() {
    const send = async () => {
      const answer = await toast({ id: "send", kind: "error", title: "Couldn't send the message", description: "You're offline", action: "Retry", duration: 8000 });
      log(`error toast: ${answer ?? "gone"}`);
      if (answer !== "Retry") return;
      void toast({ id: "send", kind: "loading", title: "Sending…", duration: Infinity });
      setTimeout(() => updateToast("send", { kind: "success", title: "Message sent", description: "To Mira Chen", duration: 3000 }), 1200);
    };
    return (
      <Card icon="system" title="Kinds" subtitle="Success, information, a warning and an error, each with what to do next">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Button label="Save changes" variant="secondary" onPress={() => void toast({ kind: "success", title: "Changes saved", description: "Q3 roadmap.md · just now" })} />
          <Button
            label="Check for updates"
            variant="secondary"
            onPress={async () => log(`update toast: ${(await toast({ id: "update", kind: "info", title: "Version 2.4 is ready", description: "Restart to finish updating", action: "Restart" })) ?? "gone"}`)}
          />
          <Button label="Fill the disk" variant="secondary" onPress={() => void toast({ id: "disk", kind: "warning", title: "Storage almost full", description: "14.2 of 15 GB used", action: "Manage" })} />
          <Button label="Send a message" variant="secondary" onPress={send} />
        </View>
        <Caption label="Retry turns the error into a loading toast, then its result" />
      </Card>
    );
  }

  function Upload() {
    const failing = signal(false);
    const running = signal(false);
    const photos = 3;
    const start = () => {
      running.set(true);
      log("upload started");
      void toast({ id: "upload", kind: "loading", title: `Uploading ${photos} photos`, description: `0 of ${photos}`, progress: 0, close: "Cancel the upload", duration: Infinity }).then((answer) => {
        running.set(false);
        log(`upload toast: ${answer ?? "gone"}`);
        if (answer === "Retry") start();
      });
      let done = 0;
      const step = () => {
        done += 1;
        if (failing() && done === photos) {
          updateToast("upload", { kind: "error", title: "Upload failed", description: `${done - 1} of ${photos} uploaded`, action: "Retry", duration: 8000 });
          return;
        }
        // Dismissed (its cross, a swipe, back): the upload stops.
        if (!updateToast("upload", { description: `${done} of ${photos}`, progress: done / photos })) return log("upload cancelled");
        if (done < photos) setTimeout(step, 700);
        else setTimeout(() => updateToast("upload", { kind: "success", title: `${photos} photos uploaded`, description: "Added to Trip photos", action: "View", duration: 4000 }), 300);
      };
      setTimeout(step, 700);
    };
    return (
      <Card icon="photos" title="Loading, then its result" subtitle="One toast counts its progress and becomes what happened, in place">
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Text style={{ flex: 1, fontSize: pointer ? 13 : 15, color: colors.text }}>Fail the last one</Text>
          <Toggle label="Fail the last one" value={failing()} onChange={(v) => failing.set(v)} />
        </View>
        <Button label={running() ? "Uploading…" : `Upload ${photos} photos`} icon="arrow-up" disabled={running()} onPress={start} />
      </Card>
    );
  }

  function Undo() {
    const inbox = signal<Message[]>([
      { id: 1, from: "Mira Chen", subject: "Motion review notes" },
      { id: 2, from: "Ravi Patel", subject: "Invoice for October" },
      { id: 3, from: "Ana Silva", subject: "Lunch on Friday?" },
    ]);
    const archive = async (message: Message) => {
      const at = inbox().findIndex((m) => m.id === message.id);
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      inbox.set(inbox().filter((m) => m.id !== message.id));
      const answer = await toast({ id: `archived-${message.id}`, title: "Conversation archived", description: message.subject, action: "Undo", close: "Dismiss", duration: 6000 });
      log(`archive ${message.subject}: ${answer === "Undo" ? "undone" : "kept"}`);
      if (answer !== "Undo") return;
      LayoutAnimation.configureNext(LayoutAnimation.Presets.spring);
      const list = inbox();
      inbox.set([...list.slice(0, at), message, ...list.slice(at)]);
    };
    return (
      <Card icon="lists" title="Undo" subtitle="What was just done, with a way back while the toast shows">
        <If when={inbox().length > 0} else={<Caption label="Inbox zero" />}>
          <View>
            <Each of={inbox()} key={(m) => m.id}>
              {(m, i) => (
                <Row first={i() === 0}>
                  <Avatar name={m().from} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ numberOfLines: 1, fontSize: pointer ? 13 : 15, fontWeight: "500", color: colors.text }}>{m().from}</Text>
                    <Text style={{ numberOfLines: 1, fontSize: pointer ? 12 : 13, color: colors.muted }}>{m().subject}</Text>
                  </View>
                  <Trigger icon="archive" variant="ghost" accessibilityLabel={`Archive ${m().subject}`} tip={<Tip label="Archive" />} onPress={() => void archive(m())} />
                </Row>
              )}
            </Each>
          </View>
        </If>
      </Card>
    );
  }

  function Burst() {
    let count = 0;
    return (
      <Card icon="layers" title="A stack" subtitle="Three show at once; the others wait their turn">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Button
            label="Copy the link"
            variant="secondary"
            onPress={() => {
              count += 1;
              void toast({ kind: "success", title: "Copied", description: `The link is on the clipboard (${count})` });
            }}
          />
          <Button label="Dismiss all" variant="ghost" onPress={() => dismissToast()} />
        </View>
        <Caption label={pointer ? "The pointer on the stack spreads it and stops their time; swipe one away" : "Touch the stack to spread it; swipe one away"} />
      </Card>
    );
  }

  return <DemoPage cards={[Kinds, Upload, Undo, Burst, Events]} />;
}
