import { cleanup, effect, type InputRef, type JSX, reduceMotion, Scroll, signal, split, Text, View } from "nsh";
import { Animated, createAnimatedValue, LayoutAnimation } from "nsh";
import { Dialog, Input, type InputProps, NavPage } from "nsh/base";
import { Keyboard, keyboardFrame, platform, safeAreaInsets } from "nsh";
import { Icon, type IconName } from "../icons";
import { nav } from "../nav";
import { alpha, Appear, Badge, Button, Caption, Card, colors, DemoPage, finish, focusRing, follow, header, hint, IconTile, Inset, Meter, mono, PageHeader, Press, radius, RoundButton, Section, Segmented, Spinner, tints, type Tone, toneColor } from "../ui";

/** A pointer and a keyboard: desktop density. */
const pointer = platform.desktop;

/** A field's text size and its side padding. */
const fieldFont = pointer ? 13 : 15;
const fieldPad = pointer ? 8 : 14;

/** The next commit's frames ease to their new places (a message sliding in), unless motion is reduced. */
const relayout = () => {
  if (!reduceMotion()) LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
};

/** A prefix or suffix of a field: quiet text inside it, or an `addon` set off on the inset color with a hairline. */
function Affix(props: { text: string; addon?: boolean; side: "start" | "end" }) {
  return (
    <If
      when={props.addon}
      else={<Text style={{ [props.side === "start" ? "paddingLeft" : "paddingRight"]: fieldPad, fontSize: fieldFont, color: colors.muted }}>{props.text}</Text>}
    >
      <View
        style={{
          alignSelf: "stretch",
          justifyContent: "center",
          paddingHorizontal: fieldPad,
          backgroundColor: colors.inset,
          [props.side === "start" ? "borderRightWidth" : "borderLeftWidth"]: 1,
          borderColor: colors.line,
          // The field's corners on its outer side, inside its border.
          ...(props.side === "start"
            ? { borderTopLeftRadius: radius.control - 1, borderBottomLeftRadius: radius.control - 1 }
            : { borderTopRightRadius: radius.control - 1, borderBottomRightRadius: radius.control - 1 }),
        }}
      >
        <Text style={{ fontSize: fieldFont, color: colors.muted }}>{props.text}</Text>
      </View>
    </If>
  );
}

/**
 * A labelled input (`api` names the prop it shows, `hint` is a plain note):
 * the border glows accent while focused (a ring springing in natively), an
 * error turns it red, slides a message in (layout animation) and shakes
 * the field, again each time `attempt` grows (a submit); `valid` fades a
 * check in at its end. `prefix` / `suffix` are text around the value
 * (`addon`: set off as segments), `leading` / `trailing` views inside it (an
 * icon, a button). `next` focuses another input on return. Disabled, it
 * dims; read-only, it lies flat.
 */
function Field(
  props: InputProps & {
    label: string;
    api?: string;
    hint?: string;
    /** The hint's color (a counter nearing its limit), faint by default. */
    hintColor?: string;
    error?: string;
    valid?: boolean;
    attempt?: number;
    prefix?: string;
    suffix?: string;
    addon?: boolean;
    leading?: JSX.Element;
    trailing?: JSX.Element;
    next?: () => InputRef | undefined;
  },
) {
  const [own, input] = split(props, ["label", "api", "hint", "hintColor", "error", "valid", "attempt", "prefix", "suffix", "addon", "leading", "trailing", "next", "onFocus", "onBlur", "style"]);
  // Made once: the views inside follow their own state.
  const leading = own.leading;
  const trailing = own.trailing;
  const focused = signal(false);
  const focus = follow(() => (focused() ? 1 : 0));
  const ok = follow(() => (own.valid && !own.error ? 1 : 0));
  const shake = createAnimatedValue(0);
  const wobble = () => {
    if (!reduceMotion()) Animated.sequence([9, -8, 6, -4, 2, 0].map((x) => Animated.timing(shake, { toValue: x, duration: 45 }))).start();
  };
  let shown = false;
  effect(() => {
    const has = !!own.error;
    if (has === shown) return;
    shown = has;
    relayout();
    if (has) wobble();
  });
  // A submit with the error still there shakes it again.
  let tried = own.attempt ?? 0;
  effect(() => {
    const n = own.attempt ?? 0;
    if (n === tried) return;
    tried = n;
    if (own.error) wobble();
  });
  // Desktop density with a pointer (28 pt, text 13), touch density otherwise.
  const box = () =>
    props.multiline ? (pointer ? { minHeight: 28, paddingTop: 6, paddingBottom: 6 } : { minHeight: 46, paddingTop: 13, paddingBottom: 13 }) : { height: pointer ? 28 : 46 };
  return (
    <View style={{ gap: 6, translate: [shake, 0], opacity: props.disabled ? 0.5 : 1 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
        <Text style={{ flex: 1, fontSize: 13, fontWeight: "500", color: colors.muted }}>{own.label}</Text>
        <If when={own.api}>
          <Text style={{ fontSize: 12, color: colors.faint, fontFamily: mono }}>{own.api}</Text>
        </If>
        <If when={own.hint}>
          <Text style={{ fontSize: 13, color: own.hintColor ?? colors.faint, fontVariant: ["tabular-nums"], transitionProperty: "color", transitionDuration: 150 }}>{own.hint}</Text>
        </If>
      </View>
      <View
        style={{
          flexDirection: "row",
          alignItems: props.multiline ? "flex-start" : "center",
          borderRadius: radius.control,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: own.error ? colors.danger : props.readonly || props.disabled ? colors.line : colors.fieldBorder,
          backgroundColor: colors.field,
          // Recessed while editable; a read-only or disabled field lies flat.
          ...(props.readonly || props.disabled ? {} : finish.field),
          transitionProperty: "border-color",
          transitionDuration: reduceMotion() ? 0 : 150,
        }}
      >
        <If when={own.prefix}>
          <Affix text={own.prefix!} addon={own.addon} side="start" />
        </If>
        <If when={leading}>
          <View style={{ paddingLeft: fieldPad, flexDirection: "row", alignItems: "center" }}>{leading}</View>
        </If>
        <Input
          returnKeyType={own.next ? "next" : "done"}
          onSubmit={() => own.next?.()?.focus()}
          onFocus={() => {
            focused.set(true);
            own.onFocus?.();
          }}
          onBlur={() => {
            focused.set(false);
            own.onBlur?.();
          }}
          {...input}
          style={[
            {
              flex: 1,
              paddingHorizontal: fieldPad,
              fontSize: fieldFont,
              color: props.readonly ? colors.muted : colors.text,
              placeholderColor: colors.faint,
              caretColor: colors.accent,
              selectionColor: colors.accent,
              ...box(),
            },
            ...(Array.isArray(own.style) ? own.style : [own.style]),
          ]}
        />
        <If when={own.valid !== undefined}>
          <View style={{ paddingRight: fieldPad, opacity: ok, transform: [{ scale: ok.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }) }] }}>
            <Icon name="check" size={pointer ? 13 : 16} tint={colors.up} weight={2} />
          </View>
        </If>
        <If when={trailing}>
          <View style={{ paddingRight: pointer ? 2 : 4, flexDirection: "row", alignItems: "center" }}>{trailing}</View>
        </If>
        <If when={own.suffix}>
          <Affix text={own.suffix!} addon={own.addon} side="end" />
        </If>
        <View
          style={{
            pointerEvents: "none",
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

/**
 * A small button inside a field (show the password, clear the text): its
 * name for screen readers, faint until the pointer is over it; it sinks
 * while pressed. `show` false shrinks and fades it out, untouchable.
 */
function FieldButton(props: { icon: IconName; label: string; show?: boolean; onPress: () => void }) {
  const size = pointer ? 22 : 36;
  const shown = follow(() => (props.show === false ? 0 : 1));
  return (
    <View
      onPress={props.onPress}
      role="button"
      accessibilityLabel={props.label}
      disabled={props.show === false}
      hitSlop={4}
      focusStyle={focusRing()}
      hoverStyle={{ backgroundColor: alpha(colors.text, 0.06) }}
      activeStyle={{ backgroundColor: alpha(colors.text, 0.12), transform: [{ scale: 0.9 }] }}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: "center",
        justifyContent: "center",
        opacity: shown,
        transform: [{ scale: shown.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) }],
        transitionProperty: "background-color",
        transitionDuration: 120,
      }}
    >
      <Icon name={props.icon} size={pointer ? 13 : 17} tint={colors.muted} />
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
          <Text style={{ numberOfLines: 1, fontSize: 12, color: colors.faint, fontFamily: mono }}>
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

/** What a strong password has, each checked on its own. */
const rules: { label: string; test: (p: string) => boolean }[] = [
  { label: "8 or more characters", test: (p) => p.length >= 8 },
  { label: "Upper and lower case", test: (p) => /[a-z]/.test(p) && /[A-Z]/.test(p) },
  { label: "A number", test: (p) => /\d/.test(p) },
  { label: "A symbol", test: (p) => /[^\w\s]/.test(p) },
];
/** 0–4: how many of the rules the password meets. */
const strength = (p: string) => (p.length === 0 ? 0 : rules.filter((r) => r.test(p)).length);
const strengthLabel = ["Empty", "Weak", "Fair", "Good", "Strong"];
const strengthTone: Tone[] = ["neutral", "danger", "warn", "info", "up"];

/**
 * A password's strength: four segments that fill in turn (each grows in on
 * `motion.control`'s spring, all in the tone of the score), its word, and
 * the rules, each ticking as it is met.
 */
function Strength(props: { password: string }) {
  const score = () => strength(props.password);
  const tone = () => (score() ? toneColor(strengthTone[score()]) : colors.faint);
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <View style={{ flex: 1, flexDirection: "row", gap: 4 }}>
          <Each of={[0, 1, 2, 3]}>
            {(i) => {
              const on = follow(() => (score() > i() ? 1 : 0));
              return (
                <View style={{ flex: 1, height: 6, borderRadius: 3, overflow: "hidden", backgroundColor: colors.track, borderWidth: 1, ...finish.track }}>
                  <View
                    style={{
                      position: "absolute",
                      top: 0,
                      bottom: 0,
                      left: 0,
                      right: 0,
                      backgroundColor: tone(),
                      transformOrigin: "left",
                      transform: [{ scaleX: on }],
                      transitionProperty: "background-color",
                      transitionDuration: 150,
                    }}
                  />
                </View>
              );
            }}
          </Each>
        </View>
        <Text testID="strength" style={{ width: 52, textAlign: "right", fontSize: 13, fontWeight: "500", color: tone(), transitionProperty: "color", transitionDuration: 150 }}>
          {strengthLabel[score()]}
        </Text>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", rowGap: 6, columnGap: 14 }}>
        <Each of={rules}>
          {(rule) => {
            const met = () => rule().test(props.password);
            const t = follow(() => (met() ? 1 : 0));
            return (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minWidth: pointer ? 150 : 140 }}>
                <View style={{ width: 14, height: 14, alignItems: "center", justifyContent: "center" }}>
                  <View style={{ position: "absolute", width: 5, height: 5, borderRadius: 3, backgroundColor: colors.faint, opacity: t.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }} />
                  <View style={{ opacity: t, transform: [{ scale: t.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) }] }}>
                    <Icon name="check" size={14} tint={colors.up} weight={2.2} />
                  </View>
                </View>
                <Text style={{ fontSize: 12.5, color: met() ? colors.text : colors.muted, transitionProperty: "color", transitionDuration: 150 }}>{rule().label}</Text>
              </View>
            );
          }}
        </Each>
      </View>
    </View>
  );
}

type Place = { name: string; country: string; zone: string };

const places: Place[] = [
  { name: "Amsterdam", country: "Netherlands", zone: "UTC+1" },
  { name: "Auckland", country: "New Zealand", zone: "UTC+13" },
  { name: "Berlin", country: "Germany", zone: "UTC+1" },
  { name: "Buenos Aires", country: "Argentina", zone: "UTC−3" },
  { name: "Cape Town", country: "South Africa", zone: "UTC+2" },
  { name: "Hong Kong", country: "China", zone: "UTC+8" },
  { name: "Lisbon", country: "Portugal", zone: "UTC±0" },
  { name: "London", country: "United Kingdom", zone: "UTC±0" },
  { name: "Long Beach", country: "United States", zone: "UTC−8" },
  { name: "Los Angeles", country: "United States", zone: "UTC−8" },
  { name: "Melbourne", country: "Australia", zone: "UTC+11" },
  { name: "Mexico City", country: "Mexico", zone: "UTC−6" },
  { name: "Montréal", country: "Canada", zone: "UTC−5" },
  { name: "New York", country: "United States", zone: "UTC−5" },
  { name: "Oslo", country: "Norway", zone: "UTC+1" },
  { name: "Paris", country: "France", zone: "UTC+1" },
  { name: "Reykjavík", country: "Iceland", zone: "UTC±0" },
  { name: "Seoul", country: "South Korea", zone: "UTC+9" },
  { name: "Singapore", country: "Singapore", zone: "UTC+8" },
  { name: "Tokyo", country: "Japan", zone: "UTC+9" },
];

/** How long typing must pause before the search runs. */
const DEBOUNCE = 300;

/**
 * A search field: a magnifier before the text, a clear button that grows
 * in once there is text, and results that wait for the typing to pause
 * (a spinner meanwhile), each match's letters in bold.
 */
function Search() {
  const query = signal("");
  const settled = signal("");
  const pending = signal(false);
  let ref: InputRef | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => clearTimeout(timer));
  const change = (value: string) => {
    query.set(value);
    clearTimeout(timer);
    if (!value.trim()) {
      relayout();
      settled.set("");
      pending.set(false);
      return;
    }
    pending.set(true);
    timer = setTimeout(() => {
      relayout();
      settled.set(value.trim());
      pending.set(false);
    }, DEBOUNCE);
  };
  const results = () => {
    const q = settled().toLowerCase();
    return q ? places.filter((p) => p.name.toLowerCase().includes(q) || p.country.toLowerCase().includes(q)).slice(0, 6) : [];
  };
  /** The name with the match in bold. */
  const marked = (name: string) => {
    const at = name.toLowerCase().indexOf(settled().toLowerCase());
    if (at < 0) return <Text>{name}</Text>;
    const end = at + settled().length;
    return (
      <Text>
        {name.slice(0, at)}
        <Text style={{ fontWeight: "700", color: colors.accent }}>{name.slice(at, end)}</Text>
        {name.slice(end)}
      </Text>
    );
  };
  return (
    <Card
      icon="search"
      title="Search"
      subtitle={`Results ${DEBOUNCE} ms after the typing stops`}
      right={<If when={settled()}><Badge label={`${results().length} found`} tone={results().length ? "accent" : "neutral"} /></If>}
    >
      <Field
        ref={(node) => (ref = node)}
        label="City"
        testID="search"
        value={query()}
        onChange={({ value }) => change(value)}
        placeholder="Search cities or countries"
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        leading={<Icon name="search" size={pointer ? 13 : 16} tint={colors.faint} />}
        trailing={
          <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
            <If when={pending()}>
              <Spinner size={pointer ? 12 : 15} tint={colors.faint} />
            </If>
            <FieldButton
              icon="close"
              label="Clear the search"
              show={query().length > 0}
              onPress={() => {
                change("");
                ref?.focus();
              }}
            />
          </View>
        }
      />
      <If when={settled()} else={<Caption label="Try “lon”, “united” or “o”" />}>
        <If
          when={results().length > 0}
          else={
            <Appear>
              <Text style={{ fontSize: 13, color: colors.muted }}>No city or country matches “{settled()}”.</Text>
            </Appear>
          }
        >
          <View testID="results">
            <Each of={results()} key={(p) => p.name}>
              {(p, i) => (
                <Appear index={i()}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: pointer ? 32 : 44, borderTopWidth: i() === 0 ? 0 : 1, borderTopColor: colors.line }}>
                    <Text style={{ flex: 1, fontSize: fieldFont, color: colors.text }}>
                      {marked(p().name)}
                      <Text style={{ color: colors.faint }}> · {p().country}</Text>
                    </Text>
                    <Text style={{ fontSize: 12, color: colors.faint, fontVariant: ["tabular-nums"] }}>{p().zone}</Text>
                  </View>
                </Appear>
              )}
            </Each>
          </View>
        </If>
      </If>
    </Card>
  );
}

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
  const refs: InputRef[] = [];
  const next = (i: number) => () => refs[i + 1];
  const ref = (i: number) => (node: InputRef) => (refs[i] = node);

  const nameError = () => (touched().name && !name().trim() ? "Enter your name" : undefined);
  const emailError = () =>
    touched().email && !emailPattern.test(email()) ? (email() ? "That address needs an @ and a domain" : "Enter your e-mail") : undefined;
  const passwordError = () => (touched().password && password().length < 8 ? "Use at least 8 characters" : undefined);
  const reveal = signal(false);
  // Submits so far: each one shakes the fields still in error.
  const attempt = signal(0);
  const creating = signal(false);
  let pending: ReturnType<typeof setTimeout> | undefined;
  cleanup(() => clearTimeout(pending));

  const submit = () => {
    touched.set({ name: true, email: true, password: true });
    attempt.set(attempt() + 1);
    const issues = [nameError(), emailError(), passwordError()].filter(Boolean).length;
    relayout();
    if (issues) {
      status.set({ tone: "danger", text: `${issues} ${issues === 1 ? "field needs" : "fields need"} attention` });
      return;
    }
    // The request: no second submit meanwhile, then the result by the button.
    status.set(null);
    creating.set(true);
    pending = setTimeout(() => {
      relayout();
      creating.set(false);
      status.set({ tone: "up", text: `Account created for ${name()} <${email()}>` });
    }, 900);
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
              onChange={({ value }) => name.set(value)}
              onBlur={touch("name")}
              error={nameError()}
              valid={name().trim().length > 1}
              attempt={attempt()}
              testID="name"
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
              onChange={({ value }) => email.set(value)}
              onBlur={touch("email")}
              error={emailError()}
              valid={emailPattern.test(email())}
              attempt={attempt()}
              testID="email"
              leading={<Icon name="mail" size={pointer ? 13 : 16} tint={colors.faint} />}
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
                testID="password"
                value={password()}
                onChange={({ value }) => password.set(value)}
                onBlur={touch("password")}
                error={passwordError()}
                attempt={attempt()}
                masked={!reveal()}
                autoComplete="new-password"
                placeholder="At least 8 characters"
                leading={<Icon name="lock" size={pointer ? 13 : 16} tint={colors.faint} />}
                trailing={<FieldButton icon={reveal() ? "eye-off" : "eye"} label={reveal() ? "Hide the password" : "Show the password"} onPress={() => reveal.set(!reveal())} />}
              />
              <Strength password={password()} />
            </View>
            <Field ref={ref(3)} next={next(3)} label="Phone" api="phone-pad" keyboardType="phone-pad" autoComplete="tel" placeholder="+1 555 0100" />
          </Section>
        ),
        () => (
          <Section title="Input groups" note="prefix and suffix">
            <Field
              ref={ref(4)}
              next={next(4)}
              label="Site address"
              api="url"
              testID="site"
              prefix="https://"
              suffix=".nsh.app"
              addon
              keyboardType="url"
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="my-team"
            />
            <Pair>
              <Field label="Price" api="decimal-pad" prefix="$" suffix="USD" keyboardType="decimal-pad" placeholder="0.00" />
              <Field label="Weight" api="decimal-pad" suffix="kg" keyboardType="decimal-pad" placeholder="2.5" />
            </Pair>
            <Pair>
              <Field label="Discount" api="number-pad" suffix="%" keyboardType="number-pad" maxLength={2} placeholder="15" />
              <Field label="Handle" prefix="@" autoCapitalize="none" autoCorrect={false} placeholder="ada" />
            </Pair>
          </Section>
        ),
        () => <Search />,
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
              onChange={({ value }) => code.set(value)}
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
              onChange={({ value }) => shout.set(value.toUpperCase())}
              placeholder="TYPE IN LOWER CASE"
            />
            <Pair>
              <Field label="Read only" api="readonly" value="Selectable, not editable" readonly />
              <Field label="Disabled" api="disabled" testID="disabled" value="Set by your admin" disabled leading={<Icon name="lock" size={pointer ? 12 : 15} tint={colors.faint} />} />
            </Pair>
            <Field
              ref={ref(13)}
              next={next(13)}
              label="Custom colors"
              api="placeholderColor, selectionColor"
              placeholder="A blue placeholder, an amber selection"
              style={{ placeholderColor: colors.info, caretColor: colors.warn, selectionColor: colors.warn }}
            />
            <View style={{ gap: 8 }}>
              <Field
                ref={ref(14)}
                label="Message"
                testID="notes"
                hint={`${notes().length}/280`}
                hintColor={notes().length >= 280 ? colors.danger : notes().length > 250 ? colors.warn : undefined}
                multiline
                maxLength={280}
                value={notes()}
                onChange={({ value }) => notes.set(value)}
                placeholder="Return adds a line"
                style={{ minHeight: 100 }}
              />
              <Meter value={notes().length / 280} tone={notes().length >= 280 ? "danger" : notes().length > 250 ? "warn" : "accent"} />
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
              <Button label={creating() ? "Creating…" : "Create account"} busy={creating()} onPress={submit} />
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
      <Dialog open={sheet()} presentation="pageSheet" onOpenChange={({ open }) => sheet.set(open)} style={{ flex: 1 }}>
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
        size.set(`${Math.round(e.size.width)}×${Math.round(e.size.height)}`);
        height.set(Math.min(e.size.height, 110));
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
            onChange={({ value }) => draft.set(value)}
            onSubmit={send}
            submitBehavior="submit"
            placeholder="Message"
            returnKeyType="send"
            style={{
              placeholderColor: colors.faint,
              caretColor: colors.accent,
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
  let input: InputRef | undefined;
  return (
    <View style={{ gap: 12 }}>
      <Field
        ref={(node) => (input = node)}
        label="Text"
        hint={`${range().start}–${range().end}`}
        value={text()}
        onChange={({ value }) => text.set(value)}
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
