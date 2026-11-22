import { type JSX, mount, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

const TEXT = "#e6e8ee";
const MUTED = "#9aa1b2";
const FAINT = "#5f6676";
const ACCENT = "#7aa2f7";
const DOWN = "#f85149";
const UP = "#3fb950";

function Button(props: { label: string; onPress: () => void }) {
  return (
    <View onPress={props.onPress} role="button" accessibilityLabel={props.label} style={{ height: 16 }}>
      <Text style={{ color: TEXT }}>{`[ ${props.label} ]`}</Text>
    </View>
  );
}

/** A one-row field between brackets, `[ text ]`, its error on the row below. */
function TextField(props: { value: string; onChange: (v: string) => void; placeholder: string; error?: string; masked?: boolean }) {
  const bracket = () => (props.error ? DOWN : FAINT);
  return (
    <View style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", height: 16 }}>
        <Text style={{ color: bracket() }}>[ </Text>
        <Input
          value={props.value}
          onChange={props.onChange}
          placeholder={props.placeholder}
          masked={props.masked}
          style={{ flex: 1, height: 16, color: TEXT, placeholderColor: FAINT }}
        />
        <Text style={{ color: bracket() }}> ]</Text>
      </View>
      <If when={props.error}>
        <Text style={{ color: DOWN }}>✗ {props.error}</Text>
      </If>
    </View>
  );
}

function Field(props: { label: string; children: JSX.Element }) {
  return (
    <View style={{ flexDirection: "row", gap: 16 }}>
      <Text style={{ width: 128, color: MUTED }}>{props.label}</Text>
      {props.children}
    </View>
  );
}

/** A sign-up form: three validated fields, a checkbox, and the account it creates. */
function Form() {
  const name = signal("");
  const email = signal("");
  const password = signal("");
  const subscribe = signal(true);
  const tried = signal(false);
  const sent = signal<string | null>(null);
  const errors = () => ({
    name: name().trim() ? undefined : "Enter your name",
    email: /^\S+@\S+\.\S+$/.test(email()) ? undefined : "Enter an email like ada@example.com",
    password: password().length >= 6 ? undefined : "At least 6 characters",
  });
  const shown = (key: "name" | "email" | "password") => (tried() ? errors()[key] : undefined);
  const submit = () => {
    tried.set(true);
    const e = errors();
    if (!e.name && !e.email && !e.password) sent.set(`${name()} <${email()}>${subscribe() ? ", subscribed" : ""}`);
  };
  return (
    <View style={{ flex: 1, padding: 8, gap: 16 }}>
      <Field label="Name">
        <TextField value={name()} onChange={(v) => name.set(v)} placeholder="Ada Lovelace" error={shown("name")} />
      </Field>
      <Field label="Email">
        <TextField value={email()} onChange={(v) => email.set(v)} placeholder="ada@example.com" error={shown("email")} />
      </Field>
      <Field label="Password">
        <TextField value={password()} onChange={(v) => password.set(v)} placeholder="6 characters or more" error={shown("password")} masked />
      </Field>
      <Field label="Newsletter">
        <View onPress={() => subscribe.set(!subscribe())} role="checkbox" style={{ flexDirection: "row", gap: 8 }}>
          <Text style={{ color: subscribe() ? ACCENT : MUTED }}>{subscribe() ? "[x]" : "[ ]"}</Text>
          <Text style={{ color: TEXT }}>Send me the monthly notes</Text>
        </View>
      </Field>
      <View style={{ flexDirection: "row", paddingLeft: 144 }}>
        <Button label="Create account" onPress={submit} />
      </View>
      <If when={sent()}>
        <Text style={{ color: UP }}>✓ Account created for {sent()}</Text>
      </If>
    </View>
  );
}

mount(Form);
