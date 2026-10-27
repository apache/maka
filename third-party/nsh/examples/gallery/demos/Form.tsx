import { effect, type JSX, Scroll, signal, split, Text, View, type YNode } from "nsh";
import { Animated, createAnimatedValue, LayoutAnimation } from "nsh";
import { Dialog, Input, type InputProps, NavPage } from "nsh/base";
import { Keyboard, keyboardFrame, safeAreaInsets } from "nsh";
import { Icon, type IconName } from "../icons";
import { nav } from "../nav";
import { Appear, Badge, Button, Caption, Card, colors, DemoPage, finish, header, hint, IconTile, Inset, Meter, mono, PageHeader, Press, radius, RoundButton, Section, Segmented, tints, type Tone, toneColor } from "../ui";

/**
 * A labelled input (`api` names the prop it shows, `hint` is a plain note):
 * the border glows accent while focused (a ring fading in
 * natively), an error turns it red, slides a message in (layout animation)
 * and shakes the field. `next` focuses another input on return.
 */
function Field(
  props: InputProps & { label: string; api?: string; hint?: string; error?: string; prefix?: string; next?: () => YNode | undefined },
) {
  const [own, input] = split(props, ["label", "api", "hint", "error", "prefix", "next", "onFocus", "onBlur", "style"]);
  const focus = createAnimatedValue(0);
  const shake = createAnimatedValue(0);
  let shown = false;
  effect(() => {
    const has = !!own.error;
    if (has === shown) return;
    shown = has;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    if (has) Animated.sequence([9, -8, 6, -4, 2, 0].map((x) => Animated.timing(shake, { toValue: x, duration: 45 }))).start();
  });
  const box = () => (props.multiline ? { minHeight: 46, paddingTop: 13, paddingBottom: 13 } : { height: 46 });
  return (
    <View style={{ gap: 6, transform: [{ translateX: shake }] }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
        <Text style={{ flex: 1, fontSize: 13, fontWeight: "500", color: colors.muted }}>{own.label}</Text>
        <If when={own.api}>
          <Text style={{ fontSize: 12, color: colors.faint, fontFamily: mono }}>{own.api}</Text>
        </If>
        <If when={own.hint}>
          <Text style={{ fontSize: 13, color: colors.faint, fontVariant: ["tabular-nums"] }}>{own.hint}</Text>
        </If>
      </View>
      <View
        style={{
          flexDirection: "row",
          alignItems: props.multiline ? "flex-start" : "center",
          borderRadius: radius.control,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: own.error ? colors.danger : props.readonly ? colors.line : colors.fieldBorder,
          backgroundColor: colors.field,
          // Recessed while editable; a read-only field lies flat.
          ...(props.readonly ? {} : finish.field),
        }}
      >
        <If when={own.prefix}>
          <Text style={{ paddingLeft: 14, fontSize: 15, color: colors.muted }}>{own.prefix}</Text>
        </If>
        <Input
          returnKeyType={own.next ? "next" : "done"}
          onSubmit={() => own.next?.()?.focus()}
          onFocus={() => {
            focus.timing(1, { duration: 160 });
            own.onFocus?.();
          }}
          onBlur={() => {
            focus.timing(0, { duration: 220 });
            own.onBlur?.();
          }}
          {...input}
          style={[{ flex: 1, paddingHorizontal: 14, fontSize: 15, color: props.readonly ? colors.muted : colors.text, placeholderColor: colors.faint, selectionColor: colors.accent, ...box() }, ...(Array.isArray(own.style) ? own.style : [own.style])]}
        />
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: -1,
            left: -1,
            right: -1,
            bottom: -1,
            // Around the field's border: its radius plus the 1pt it reaches out.
            borderRadius: radius.control + 1,
            borderCurve: "continuous",
            borderWidth: 2,
            borderColor: own.error ? colors.danger : colors.accent,
            opacity: focus,
          }}
        />
      </View>
      <If when={own.error}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.danger }} />
          <Text style={{ flex: 1, fontSize: 13, color: colors.danger }}>{own.error}</Text>
        </View>
      </If>
    </View>
  );
}

/** A row that opens something: an icon, a title, the API it shows. */
function LinkRow(props: { icon: IconName; title: string; note: string; first?: boolean; onPress: () => void }) {
  return (
    <Press onPress={props.onPress} scale={0.98} accessibilityLabel={props.title}>
      <View
        style={{
          minHeight: 60,
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          paddingHorizontal: 10,
          paddingVertical: 8,
          borderTopWidth: props.first ? 0 : 1,
          borderTopColor: colors.line,
        }}
      >
        <IconTile name={props.icon} size={34} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ fontSize: 15, fontWeight: "500", color: colors.text }}>{props.title}</Text>
          <Text numberOfLines={1} style={{ fontSize: 12, color: colors.faint, fontFamily: mono }}>
            {props.note}
          </Text>
        </View>
        <Icon name="chevron" size={14} tint={colors.faint} />
      </View>
    </Press>
  );
}

/** Two items side by side, equal widths. */
function Pair(props: { children: [JSX.Element, JSX.Element] }) {
  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      <View style={{ flex: 1 }}>{props.children[0]}</View>
      <View style={{ flex: 1 }}>{props.children[1]}</View>
    </View>
  );
}

type Mode = "none" | "on-drag" | "interactive";

const modes = [
  { value: "none", label: "None" },
  { value: "on-drag", label: "On drag" },
  { value: "interactive", label: "Interactive" },
] as const;

const emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** 0–4: length, mixed case, a digit, a symbol. */
const strength = (p: string) =>
  p.length === 0 ? 0 : [p.length >= 8, /[a-z]/.test(p) && /[A-Z]/.test(p), /\d/.test(p), /[^\w\s]/.test(p)].filter(Boolean).length;
const strengthLabel = ["Empty", "Weak", "Fair", "Good", "Strong"];
const strengthTone: Tone[] = ["neutral", "danger", "warn", "info", "up"];

type Status = { tone: "up" | "danger"; text: string } | null;

/**
 * An account form in a scroll view: the focused input stays above the
 * keyboard (natively), return moves to the next one, dragging the form can
 * hide the keyboard; leaving a field or submitting checks it.
 */
export function Form() {
  const name = signal("");
  const email = signal("");
  const password = signal("");
  const code = signal("");
  const shout = signal("");
  const notes = signal("");
  const mode = signal<Mode>("on-drag");
  const status = signal<Status>(null);
  const sheet = signal(false);
  const touched = signal<Record<string, boolean>>({});
  const touch = (key: string) => () => touched.update((t) => ({ ...t, [key]: true }));
  // Inputs in return-key order.
  const refs: YNode[] = [];
  const next = (i: number) => () => refs[i + 1];
  const ref = (i: number) => (node: YNode) => (refs[i] = node);

  const nameError = () => (touched().name && !name().trim() ? "Enter your name" : undefined);
  const emailError = () =>
    touched().email && !emailPattern.test(email()) ? (email() ? "That address needs an @ and a domain" : "Enter your e-mail") : undefined;
  const passwordError = () => (touched().password && password().length < 8 ? "Use at least 8 characters" : undefined);
  const score = () => strength(password());

  const submit = () => {
    touched.set({ name: true, email: true, password: true });
    const issues = [nameError(), emailError(), passwordError()].filter(Boolean).length;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    status.set(
      issues
        ? { tone: "danger", text: `${issues} ${issues === 1 ? "field needs" : "fields need"} attention` }
        : { tone: "up", text: `Account created for ${name()} <${email()}>` },
    );
  };

  return (
    <DemoPage
      keyboardDismissMode={mode()}
      cards={[
        () => (
          <Card
            icon="form"
            title="Keyboard"
            subtitle="keyboardDismissMode while dragging"
            right={<Badge label={`${Math.round(keyboardFrame().height)} pt`} tone={keyboardFrame().height > 0 ? "accent" : "neutral"} />}
          >
            <Segmented options={modes} value={mode()} onChange={(m) => mode.set(m)} />
            <Caption label={hint("Drag the form with the keyboard up", "Desktops have no on-screen keyboard to dismiss")} note={mode()} />
          </Card>
        ),
        () => (
          <Section title="Account" note="autoComplete">
            <Field
              ref={ref(0)}
              next={next(0)}
              label="Name"
              value={name()}
              onChange={(v) => name.set(v)}
              onBlur={touch("name")}
              error={nameError()}
              autoCapitalize="words"
              autoComplete="name"
              placeholder="Ada Lovelace"
            />
            <Field
              ref={ref(1)}
              next={next(1)}
              label="E-mail"
              api="email-address"
              value={email()}
              onChange={(v) => email.set(v)}
              onBlur={touch("email")}
              error={emailError()}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              placeholder="ada@example.com"
            />
            <View style={{ gap: 8 }}>
              <Field
                ref={ref(2)}
                next={next(2)}
                label="Password"
                api="masked"
                value={password()}
                onChange={(v) => {
                  if (strength(v) !== score()) LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                  password.set(v);
                }}
                onBlur={touch("password")}
                error={passwordError()}
                masked
                autoComplete="new-password"
                placeholder="At least 8 characters"
              />
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <View style={{ flex: 1 }}>
                  <Meter value={score() / 4} tone={strengthTone[score()]} />
                </View>
                <Text style={{ width: 52, textAlign: "right", fontSize: 13, fontWeight: "500", color: score() ? toneColor(strengthTone[score()]) : colors.faint }}>
                  {strengthLabel[score()]}
                </Text>
              </View>
            </View>
            <Field ref={ref(3)} next={next(3)} label="Phone" api="phone-pad" keyboardType="phone-pad" autoComplete="tel" placeholder="+1 555 0100" />
            <Field
              ref={ref(4)}
              next={next(4)}
              label="Website"
              api="url"
              keyboardType="url"
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="https://"
            />
          </Section>
        ),
        () => (
          <Section title="Numbers" note="keyboardType">
            <Pair>
              <Field ref={ref(5)} next={next(5)} label="Age" hint="3 digits" keyboardType="number-pad" maxLength={3} placeholder="36" />
              <Field ref={ref(6)} next={next(6)} label="Amount" api="decimal-pad" prefix="$" keyboardType="decimal-pad" placeholder="0.00" />
            </Pair>
            <Field
              label="Offset"
              api="numbers-and-punctuation"
              hint="dark keyboard (iOS)"
              keyboardType="numbers-and-punctuation"
              ios={{ keyboardAppearance: "dark" }}
              placeholder="-12.5"
            />
            <Field
              ref={ref(7)}
              next={next(7)}
              label="Verification code"
              testID="code"
              hint={`${code().length}/6`}
              value={code()}
              onChange={(v) => code.set(v)}
              keyboardType="number-pad"
              maxLength={6}
              placeholder="······"
              style={{ letterSpacing: 10, fontSize: 22, fontWeight: "500", fontVariant: ["tabular-nums"], textAlign: "center" }}
            />
          </Section>
        ),
        () => (
          <Section title="Shipping address" note="scrolls into view">
            <Field ref={ref(8)} next={next(8)} label="Street" autoComplete="street-address" placeholder="12 Analytical Way" />
            <Pair>
              <Field ref={ref(9)} next={next(9)} label="City" placeholder="London" />
              <Field ref={ref(10)} next={next(10)} label="Postal code" autoCapitalize="characters" autoComplete="postal-code" placeholder="SW1A 1AA" />
            </Pair>
            <Field ref={ref(11)} next={next(11)} label="Country" placeholder="United Kingdom" />
          </Section>
        ),
        () => (
          <Section title="Selection and keys" note="onSelectionChange">
            <SelectionDemo />
          </Section>
        ),
        () => (
          <Section title="Text" note="Input props">
            <Field
              ref={ref(12)}
              next={next(12)}
              label="Controlled"
              testID="shout"
              hint="Uppercased as you type"
              value={shout()}
              onChange={(t) => shout.set(t.toUpperCase())}
              placeholder="TYPE IN LOWER CASE"
            />
            <Field label="Read only" api="readonly" value="Not editable" readonly />
            <Field
              ref={ref(13)}
              next={next(13)}
              label="Custom colors"
              api="placeholderColor, selectionColor"
              placeholder="A blue placeholder, an amber selection"
              style={{ placeholderColor: colors.info, selectionColor: colors.warn }}
            />
            <View style={{ gap: 8 }}>
              <Field
                ref={ref(14)}
                label="Notes"
                hint={`${notes().length}/280`}
                multiline
                maxLength={280}
                value={notes()}
                onChange={(v) => notes.set(v)}
                placeholder="Return adds a line"
                style={{ minHeight: 100 }}
              />
              <Meter value={notes().length / 280} tone={notes().length > 250 ? "warn" : "accent"} />
            </View>
            <AutoGrow />
            <Field label="No caret" api="caret" caret={false} defaultValue="No caret here" />
          </Section>
        ),
        () => (
          <Card
            icon="check"
            title="Create the account"
            subtitle="Submitting checks every field"
            right={<If when={status()}><Badge label={status()?.tone === "up" ? "Sent" : "Check"} tone={status()?.tone ?? "neutral"} /></If>}
          >
            <If when={status()}>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  padding: 12,
                  borderRadius: radius.control,
                  backgroundColor: status()?.tone === "up" ? tints.up : tints.danger,
                }}
              >
                <Icon name={status()?.tone === "up" ? "check" : "bell"} size={16} tint={status()?.tone === "up" ? colors.up : colors.danger} />
                <Text style={{ flex: 1, fontSize: 14, lineHeight: 19, color: status()?.tone === "up" ? colors.up : colors.danger }}>{status()?.text}</Text>
              </View>
            </If>
            <Pair>
              <Button label="Submit" onPress={submit} />
              <Button label="Hide keyboard" variant="secondary" onPress={() => Keyboard.dismiss()} />
            </Pair>
          </Card>
        ),
        () => (
          <Card title="More keyboards" subtitle="Sheets and bars that ride on the keyboard" flush>
            <Inset padding={0} gap={0}>
              <LinkRow first icon="components" title="Inputs in a sheet" note='presentation="pageSheet"' onPress={() => sheet.set(true)} />
              <LinkRow icon="text" title="A message bar at the bottom" note="env(keyboard-inset-height)" onPress={() => nav.push({ name: "page", page: MessageBar })} />
            </Inset>
          </Card>
        ),
      ]}
    >
      <Dialog open={sheet()} presentation="pageSheet" onOpenChange={(open) => sheet.set(open)} style={{ flex: 1 }}>
        <View
          style={{
            flex: 1,
            backgroundColor: colors.background,
            paddingTop: "env(safe-area-inset-top)",
            paddingRight: "env(safe-area-inset-right)",
            paddingBottom: "env(safe-area-inset-bottom)",
            paddingLeft: "env(safe-area-inset-left)",
          }}
        >
          <Scroll style={{ flex: 1 }} keyboardDismissMode="interactive">
            <View style={{ padding: 16, paddingBottom: 40, gap: 16 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingTop: 8, paddingLeft: 4 }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ fontSize: 24, fontWeight: "700", letterSpacing: -0.4, color: colors.text }}>A sheet</Text>
                  <Text style={{ fontSize: 13, color: colors.muted }}>Its inputs stay above the keyboard too</Text>
                </View>
                <Button label="Done" variant="secondary" onPress={() => sheet.set(false)} />
              </View>
              <Inset>
                <Each of={["First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh"]}>
                  {(label) => <Field label={label()} placeholder={`${label()} field`} />}
                </Each>
              </Inset>
            </View>
          </Scroll>
        </View>
      </Dialog>
    </DemoPage>
  );
}

/** A multiline input that grows with its text (onContentSizeChange), up to 5 lines. */
function AutoGrow() {
  const height = signal(0);
  const size = signal("–");
  return (
    <Field
      label="Grows with its text"
      hint={size()}
      multiline
      placeholder="Type several lines"
      onContentSizeChange={(e) => {
        size.set(`${Math.round(e.width)}×${Math.round(e.height)}`);
        height.set(Math.min(e.height, 110));
      }}
      style={{ height: Math.max(height(), 20) + 26 }}
    />
  );
}

type Message = { mine: boolean; text: string };

/** An input pinned to the bottom (outside any scroll view): it rides on the keyboard. */
function MessageBar() {
  const insets = safeAreaInsets();
  const messages = signal<Message[]>([
    { mine: false, text: "The bar below sits outside the scroll view." },
    { mine: false, text: "Bottom padding of env(keyboard-inset-height) lifts it with the keyboard. Say something." },
  ]);
  const draft = signal("");
  const send = () => {
    if (!draft().trim()) return;
    messages.update((m) => [...m, { mine: true, text: draft() }]);
    draft.set("");
  };
  return (
    <NavPage title="Message bar" {...header} header={<PageHeader title="Message bar" />}>
      <View style={{ flex: 1, backgroundColor: colors.background, paddingBottom: "env(keyboard-inset-height)" }}>
        <Scroll style={{ flex: 1 }} keyboardDismissMode="interactive">
          <View style={{ padding: 16, gap: 8 }}>
            <Text style={{ alignSelf: "center", fontSize: 12, fontWeight: "500", color: colors.faint, paddingBottom: 8 }}>Today</Text>
            <Each of={messages()}>
              {(m) => (
                <Appear>
                  <View
                    style={{
                      alignSelf: m().mine ? "flex-end" : "flex-start",
                      maxWidth: "80%",
                      paddingHorizontal: 14,
                      paddingVertical: 10,
                      borderRadius: 18,
                      borderCurve: "continuous",
                      borderBottomRightRadius: m().mine ? 6 : 18,
                      borderBottomLeftRadius: m().mine ? 18 : 6,
                      backgroundColor: m().mine ? colors.accentFill : colors.raised,
                      ...(m().mine ? finish.accent : finish.raised),
                    }}
                  >
                    <Text style={{ fontSize: 15, lineHeight: 20, color: m().mine ? colors.onAccent : colors.text }}>{m().text}</Text>
                  </View>
                </Appear>
              )}
            </Each>
          </View>
        </Scroll>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingHorizontal: 16,
            paddingTop: 8,
            // Above the home indicator, unless the keyboard covers it.
            paddingBottom: 8 + (keyboardFrame().height > 0 ? 0 : insets().bottom),
            backgroundColor: colors.surface,
            borderTopWidth: 1,
            borderTopColor: colors.border,
          }}
        >
          <Input
            value={draft()}
            onChange={(v) => draft.set(v)}
            onSubmit={send}
            submitBehavior="submit"
            placeholder="Message"
            returnKeyType="send"
            style={{
              placeholderColor: colors.faint,
              selectionColor: colors.accent,
              flex: 1,
              height: 44,
              paddingHorizontal: 16,
              fontSize: 15,
              color: colors.text,
              backgroundColor: colors.inset,
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: 22,
              ...finish.inset,
            }}
          />
          <RoundButton icon="arrow-up" label="Send" onPress={send} />
        </View>
      </View>
    </NavPage>
  );
}

/** `onSelectionChange`, `onKeyPress`, `selectedRange` and `(v) => selection.set(v)`. */
function SelectionDemo() {
  const text = signal("Select part of this text");
  const range = signal({ start: 0, end: 0 });
  const keys = signal<string[]>([]);
  const selection = signal<{ start: number; end?: number } | undefined>(undefined);
  let input: YNode | undefined;
  return (
    <View style={{ gap: 12 }}>
      <Field
        ref={(node) => (input = node)}
        label="Text"
        hint={`${range().start}–${range().end}`}
        value={text()}
        onChange={(v) => text.set(v)}
        selectedRange={selection()}
        onSelectionChange={(v) => range.set(v)}
        onKeyPress={(e) => keys.update((k) => [...k, e.key].slice(-8))}
        autoComplete="off"
      />
      <Caption label="Selected" note={`"${text().slice(range().start, range().end)}"`} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, minHeight: 28 }}>
        <If when={keys().length > 0} else={<Text style={{ fontSize: 13, color: colors.faint }}>Keys you press show here</Text>}>
          <Each of={keys()}>
            {(key) => (
              <View style={{ minWidth: 28, height: 28, paddingHorizontal: 8, borderRadius: 7, alignItems: "center", justifyContent: "center", backgroundColor: colors.raised, borderWidth: 1, borderColor: colors.border, ...finish.raised }}>
                <Text style={{ fontSize: 13, color: colors.text }}>{key() === " " ? "␣" : key()}</Text>
              </View>
            )}
          </Each>
        </If>
      </View>
      <Pair>
        <Button label="Select all" onPress={() => selection.set({ start: 0, end: text().length })} />
        <Button label="Caret to start" variant="secondary" onPress={() => input?.setSelection(0)} />
      </Pair>
      <Field label="One-time code" api="one-time-code" keyboardType="number-pad" autoComplete="one-time-code" maxLength={6} placeholder="123456" />
    </View>
  );
}
