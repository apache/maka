import { type JSX, mount, signal, Text, View, type YNode } from "nsh";
import { Input } from "nsh/base";
import { button, buttonText, field, Inspector, Panel, Stage, ui, wide } from "./palette";

function App() {
  const name = signal("");
  const password = signal("");
  const notes = signal("");
  const submitted = signal("");
  let passwordInput!: YNode;
  const signIn = () => submitted.set(`Signed in as ${name() || "nobody"}`);
  const nameField = () => (
    <Input
      {...field()}
      value={name()}
      onChange={(text) => name.set(text)}
      placeholder="Ada Lovelace"
      autoCapitalize="words"
      maxLength={20}
      returnKeyType="next"
      onSubmit={() => passwordInput.focus()}
    />
  );
  const count = () => <Text style={{ fontSize: 12, color: ui().muted }}>{name().length} / 20</Text>;
  const passwordField = () => (
    <Input
      ref={passwordInput}
      {...field()}
      value={password()}
      onChange={(text) => password.set(text)}
      masked
      autoComplete="current-password"
      returnKeyType="done"
      onSubmit={signIn}
    />
  );
  const notesField = () => (
    <Input
      {...field({ style: { height: wide() ? 80 : 100 } })}
      multiline
      value={notes()}
      onChange={(text) => notes.set(text)}
      placeholder="Anything else?"
    />
  );
  const signInButton = () => (
    <View onPress={signIn} disabled={password().length === 0} {...button("primary", { style: { marginTop: 4 } })}>
      <Text style={buttonText("primary")}>Sign in</Text>
    </View>
  );
  /** A label above its field, and what describes it below. */
  const group = (label: string, input: JSX.Element, after?: JSX.Element) => (
    <View style={{ gap: 6 }}>
      <Text style={{ fontSize: 13, color: ui().muted }}>{label}</Text>
      {input}
      {after}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: ui().page }}>
      {() =>
        wide() ? (
          <View style={{ flex: 1, padding: 20, paddingTop: 24, gap: 14 }}>
            <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>input</Text>
            <Text style={{ color: ui().muted }}>Tab moves between the fields; Return in the name goes to the password</Text>
            <View style={{ flex: 1, flexDirection: "row", gap: 16 }}>
              <Stage width={340} gap={16}>
                {group("Name (controlled, maxLength 20)", nameField(), count())}
                {group("Password", passwordField())}
                {group("Notes (multiline)", notesField())}
                {signInButton()}
              </Stage>
              <Inspector>
                <Panel title="value">
                  <Text style={{ fontSize: 13, color: ui().text }}>name {name() ? `“${name()}”` : "—"}</Text>
                  <Text style={{ fontSize: 13, color: ui().text, fontVariant: ["tabular-nums"] }}>password {password().length} characters</Text>
                  <Text style={{ fontSize: 13, color: ui().text, fontVariant: ["tabular-nums"] }}>notes {notes().length} characters</Text>
                </Panel>
                <Panel title="onSubmit" grow>
                  <Text style={{ fontSize: 13, color: ui().up }}>{submitted()}</Text>
                </Panel>
              </Inspector>
            </View>
          </View>
        ) : (
          <View style={{ flex: 1, width: "100%", maxWidth: 480, alignSelf: "center", padding: 20, paddingTop: 24, gap: 10 }}>
            <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>input</Text>

            <Text style={{ color: ui().muted }}>Name (controlled, maxLength 20)</Text>
            {nameField()}
            {count()}

            <Text style={{ color: ui().muted }}>Password</Text>
            {passwordField()}

            <Text style={{ color: ui().muted }}>Notes (multiline)</Text>
            {notesField()}

            {signInButton()}
            <Text style={{ color: ui().up }}>{submitted()}</Text>
          </View>
        )
      }
    </View>
  );
}

mount(App);
