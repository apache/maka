import { type JSX, mount, Scroll, signal, Text, View, type YNode } from "nsh";
import { Input } from "nsh/base";
import { button, buttonText, desktop, field, Inspector, Panel, Stage, ui, wide } from "./palette";

const label = () => ({ fontSize: 13, color: ui().muted });

function App() {
  const name = signal("");
  const email = signal("");
  const code = signal("");
  const notes = signal("");
  const notesHeight = signal(0);
  const focused = signal("nothing");
  const sent = signal("");
  let emailInput!: YNode;
  let passwordInput!: YNode;
  let notesInput!: YNode;

  let tries = 0;
  const submit = () => sent.set(`#${++tries}: signed up ${name() || "nobody"} <${email() || "no e-mail"}>`);

  type Style = () => object;
  const nameInput = (style?: Style) => (
    <Input
      {...field({ style })}
      value={name()}
      onChange={(t) => name.set(t)}
      placeholder="Ada Lovelace"
      autoCapitalize="words"
      autoComplete="name"
      returnKeyType="next"
      submitBehavior="submit"
      onSubmit={() => emailInput.focus()}
      onFocus={() => focused.set("name")}
    />
  );
  const emailField = (style?: Style) => (
    <Input
      ref={emailInput}
      {...field({ style })}
      value={email()}
      onChange={(t) => email.set(t.trim().toLowerCase())}
      placeholder="ada@example.com"
      keyboardType="email-address"
      autoCapitalize="none"
      autoCorrect={false}
      autoComplete="email"
      returnKeyType="next"
      submitBehavior="submit"
      onSubmit={() => passwordInput.focus()}
      onFocus={() => focused.set("e-mail")}
    />
  );
  const passwordField = (style?: Style) => (
    <Input
      ref={passwordInput}
      {...field({ style })}
      masked
      autoComplete="new-password"
      placeholder="At least 8 characters"
      returnKeyType="next"
      submitBehavior="submit"
      onSubmit={() => notesInput.focus()}
      onFocus={() => focused.set("password")}
    />
  );
  const codeField = (style?: Style) => (
    <Input
      {...field({ style })}
      value={code()}
      onChange={(t) => code.set(t.replace(/[^0-9]/g, ""))}
      keyboardType="number-pad"
      autoComplete="one-time-code"
      maxLength={6}
      onFocus={() => focused.set("code")}
    />
  );
  const notesField = (style?: Style) => (
    <Input
      ref={notesInput}
      multiline
      maxLength={200}
      value={notes()}
      onChange={(t) => notes.set(t)}
      onContentSizeChange={(e) => notesHeight.set(Math.min(e.height, 120))}
      placeholder="Return adds a line"
      {...field({ style })}
      onFocus={() => focused.set("notes")}
      onBlur={() => focused.set("nothing")}
    />
  );

  // A phone: one scrolling column, full-width fields and button.
  const column = () => (
    <Scroll style={{ flex: 1, backgroundColor: ui().page }} keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled">
      <View style={{ padding: 16, paddingTop: 24, gap: 12 }}>
        <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>Sign up</Text>
        <Text style={label()}>Focused: {focused()}</Text>

        <Text style={label()}>Name (controlled, return goes to the next field)</Text>
        {nameInput()}

        <Text style={label()}>E-mail</Text>
        {emailField()}

        <Text style={label()}>Password (uncontrolled)</Text>
        {passwordField()}

        <Text style={label()}>Code (number pad, 6 digits)</Text>
        {codeField(() => ({ letterSpacing: 8, textAlign: "center", fontSize: 22 }))}

        <Text style={label()}>About you (grows with its text, 200 max)</Text>
        {notesField(() => ({ height: Math.max(notesHeight(), 22) + 20 }))}
        <Text style={{ ...label(), textAlign: "right" }}>{`${notes().length}/200`}</Text>

        <View onPress={submit} {...button("primary")}>
          <Text style={buttonText("primary")}>Sign up</Text>
        </View>
        <Text style={{ color: ui().up }}>{sent()}</Text>
      </View>
    </Scroll>
  );

  // A wide window: a 360-point form, each label above its field, and its
  // state beside it.
  const group = (title: string, input: JSX.Element, help?: JSX.Element) => (
    <View style={{ gap: 6 }}>
      <Text style={{ fontSize: 13, fontWeight: "500", color: ui().text }}>{title}</Text>
      {input}
      {help}
    </View>
  );
  const form = () => (
    <View style={{ flex: 1, backgroundColor: ui().page, padding: 20, paddingTop: 24, gap: 14 }}>
      <Text style={{ fontSize: 22, fontWeight: "700", color: ui().text }}>Sign up</Text>
      <View style={{ flex: 1, flexDirection: "row", gap: 16 }}>
        <Stage width={360} gap={14}>
          {group("Name", nameInput(), <Text style={label()}>Controlled; Return goes to the next field</Text>)}
          {group("E-mail", emailField())}
          {group("Password", passwordField(), <Text style={label()}>Uncontrolled</Text>)}
          {group("Code", codeField(() => ({ width: 160, letterSpacing: 6, textAlign: "center", fontSize: 16 })), <Text style={label()}>6 digits</Text>)}
          {group(
            "About you",
            notesField(() => ({ height: Math.max(notesHeight(), 20) + 14 })),
            <Text style={{ ...label(), textAlign: "right", fontVariant: ["tabular-nums"] }}>{`${notes().length}/200`}</Text>,
          )}
          <View onPress={submit} {...button("primary")}>
            <Text style={buttonText("primary")}>Sign up</Text>
          </View>
        </Stage>
        <Inspector>
          <Panel title="onFocus · onBlur">
            <Text style={{ fontSize: 13, color: ui().text }}>Focused: {focused()}</Text>
          </Panel>
          <Panel title="onSubmit" minHeight={64}>
            <Text style={{ fontSize: 13, color: ui().up }}>{sent()}</Text>
          </Panel>
          <Text style={{ fontSize: 12, color: ui().faint }}>
            {desktop ? "Tab moves between fields; Return in a field goes to the next one." : "Return goes to the next field."}
          </Text>
        </Inspector>
      </View>
    </View>
  );

  return <>{() => (wide() ? form() : column())}</>;
}

mount(App);
