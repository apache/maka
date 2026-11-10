import { Image, type JSX, signal, Text, View } from "nsh";
import { fontScale } from "nsh";
import pacifico from "../fonts/Pacifico-Regular.ttf";
import logo from "../logo@2x.png";
import { alpha, Caption, Card, colors, DemoPage, finish, isDark, mono, photoUrl, type PhotoName, Press, radius, TERMINAL_COLUMN, TERMINAL_GAP, TERMINAL_ROW, terminal, tints } from "../ui";

const LOREM =
  "Native text, typeset once on the engine thread with CoreText and drawn on the main thread without any layout work.";

const body = () => ({ fontSize: 15, lineHeight: 22, color: colors.text }) as const;
const link = () => ({ color: colors.accent, textDecorationLine: "underline", textDecorationColor: alpha(colors.accent, 0.5) }) as const;

/** A labeled specimen: a quiet label (and the prop it shows, in code) above
 * the text; in the terminal the label right under the rule, which takes a
 * row of its own. */
function Specimen(props: { label: string; code?: string; first?: boolean; children: JSX.Element }) {
  const ruleSpace = terminal ? TERMINAL_ROW - 1 : 12;
  return (
    <View style={{ gap: terminal ? 0 : 8, paddingTop: props.first ? 0 : ruleSpace, borderTopWidth: props.first ? 0 : 1, borderTopColor: colors.line }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
        <Text style={{ flex: 1, fontSize: 13, color: colors.muted }}>{props.label}</Text>
        <If when={props.code}>
          <Text style={{ numberOfLines: 1, fontSize: 12, color: colors.faint, fontFamily: mono }}>
            {props.code}
          </Text>
        </If>
      </View>
      {props.children}
    </View>
  );
}

function Links() {
  const tapped = signal("nothing yet");
  return (
    <Card icon="text" title="Spans and links" subtitle="Nested spans with presses of their own">
      <Text style={{ ...body(), fontSize: 16, lineHeight: 25 }} onPress={() => tapped.set("the sentence (not a link)")}>
        {"By continuing you agree to the "}
        <Text style={link()} onPress={() => tapped.set("Terms of service")} onLongPress={() => tapped.set("Terms (long press)")}>
          Terms of service
        </Text>
        {" and the "}
        <Text style={link()} onPress={() => tapped.set("Privacy policy")}>
          Privacy policy
        </Text>
        {", which mention "}
        <Text style={{ fontWeight: "700" }}>
          nested{" "}
          <Text style={link()} onPress={() => tapped.set("a link inside bold text")}>
            links
          </Text>{" "}
          too
        </Text>
        .
      </Text>
      <Caption label="Pressed" note={tapped()} />
    </Card>
  );
}

function Inline() {
  const likes = signal(3);
  return (
    <Card icon="image" title="Inline views and images" subtitle="They wrap with the line">
      <Text style={{ ...body(), fontSize: 16, lineHeight: 28 }}>
        {"Made with "}
        <If when={!terminal}>
          <Image src={logo} style={{ width: 18, height: 18, borderRadius: 5 }} />
        </If>
        {terminal ? "nsh. Status " : " nsh. Status "}
        <View style={{ backgroundColor: tints.up, borderRadius: 9, paddingHorizontal: 8, height: terminal ? TERMINAL_ROW : 18, flexDirection: "row", alignItems: "center", gap: 4 }}>
          <If when={!terminal}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.up }} />
          </If>
          <Text style={{ color: colors.up, fontSize: 11, fontWeight: "700", letterSpacing: 0.5 }}>LIVE</Text>
        </View>
        {" and a button inside the sentence "}
        <Press onPress={() => likes.set(likes() + 1)} scale={0.9} accessibilityLabel="Like" hitSlop={10}>
          <View
            style={{
              backgroundColor: colors.raised,
              ...finish.raised,
              borderRadius: 11,
              paddingHorizontal: terminal ? TERMINAL_COLUMN : 9,
              height: terminal ? TERMINAL_ROW : 22,
              justifyContent: "center",
              borderWidth: 1,
              borderColor: colors.border,
            }}
          >
            <Text style={{ color: colors.accent, fontSize: 13, fontVariant: ["tabular-nums"] }}>♥ {likes()}</Text>
          </View>
        </Press>
        {" that takes presses of its own."}
      </Text>
    </Card>
  );
}

function Fonts() {
  return (
    <Card icon="styles" title="Type" subtitle="Custom fonts, weights, styles, spacing">
      <Specimen label="Custom font" code="Pacifico-Regular.ttf" first>
        <Text style={{ fontFamily: pacifico, fontSize: 34, color: colors.accent, lineHeight: 52 }}>Custom fonts</Text>
      </Specimen>
      <Specimen label="Weight, style, spacing" code="fontWeight, fontStyle">
        <Text style={{ fontSize: 17, color: colors.text }}>
          <Text style={{ fontWeight: "300" }}>Light </Text>
          <Text style={{ fontWeight: "bold" }}>Bold </Text>
          <Text style={{ fontStyle: "italic" }}>Italic </Text>
          <Text style={{ fontWeight: "bold", fontStyle: "italic" }}>Both </Text>
          <Text style={{ letterSpacing: 4, color: colors.muted }}>Spaced</Text>
        </Text>
      </Specimen>
      <Specimen label="Decorations" code="textDecorationLine">
        <Text style={{ fontSize: 17, color: colors.text }}>
          <Text style={{ textDecorationLine: "underline" }}>Underline</Text>{" "}
          <Text style={{ textDecorationLine: "line-through", textDecorationColor: colors.danger, color: colors.muted }}>Strikethrough</Text>{" "}
          <Text style={{ textDecorationLine: "underline line-through", color: colors.info }}>Both</Text>
        </Text>
      </Specimen>
      <Specimen label="Transforms" code="textTransform">
        <Text style={{ fontSize: 17, color: colors.text, textTransform: "uppercase" }}>
          uppercase <Text style={{ textTransform: "capitalize", color: colors.muted }}>capitalized words here</Text>
        </Text>
      </Specimen>
      <Specimen label="Shadows" code="textShadow">
        <View style={{ flexDirection: "row", gap: terminal ? TERMINAL_GAP : 12 }}>
          <ShadowPhoto photo="booster" label="Glow" color="#ffe9c7" shadow="0 0 12px rgba(255,150,60,1)" />
          <ShadowPhoto photo="day" label="Drop shadow" color="#ffffff" shadow="0 1px 8px rgba(5,25,45,0.75)" />
        </View>
      </Specimen>
    </Card>
  );
}

/** A line of text over a photo, where a text shadow does its work. */
function ShadowPhoto(props: { photo: PhotoName; label: string; color: string; shadow: string }) {
  return (
    <View style={{ flex: 1, height: terminal ? TERMINAL_ROW : 96, borderRadius: radius.control, borderCurve: "continuous", overflow: "hidden", backgroundColor: colors.raised }}>
      {/* A terminal has no photo to set the text on, so the line uses its own color. */}
      <If when={!terminal}>
        <Image src={photoUrl(props.photo, "small")} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, objectFit: "cover" }} />
      </If>
      {/* The padding keeps the shadow inside the text's own box. */}
      <Text style={{ numberOfLines: 1, padding: terminal ? 0 : 14, fontSize: 19, fontWeight: "600", color: terminal ? colors.text : props.color, textShadow: props.shadow }}>{props.label}</Text>
    </View>
  );
}

function Scaling() {
  return (
    <Card icon="search" title="System text size" subtitle="fontScale and its limits" right={<Text style={{ fontSize: 15, fontWeight: "500", color: colors.accent, fontVariant: ["tabular-nums"] }}>{`${fontScale().toFixed(2)}×`}</Text>}>
      <Specimen label="Default" first>
        <Text style={{ ...body(), fontSize: 17 }}>Scales with the system setting</Text>
      </Specimen>
      <Specimen label="Fixed" code="allowFontScaling={false}">
        <Text allowFontScaling={false} style={{ ...body(), fontSize: 17 }}>
          Fixed size
        </Text>
      </Specimen>
      <Specimen label="Capped" code="maxFontSizeMultiplier={1.2}">
        <Text maxFontSizeMultiplier={1.2} style={{ ...body(), fontSize: 17 }}>
          At most 1.2×
        </Text>
      </Specimen>
    </Card>
  );
}

function Truncation() {
  return (
    <Card icon="lists" title="Truncation" subtitle="numberOfLines and textOverflow">
      <Specimen label="Two lines, tail" code="numberOfLines: 2" first>
        <Text style={[body(), { numberOfLines: 2 }]}>
          {LOREM}
        </Text>
      </Specimen>
      <Specimen label="One line, head" code={`textOverflow: "ellipsis-start"`}>
        <Text style={[body(), { numberOfLines: 1, textOverflow: "ellipsis-start" }]}>
          {LOREM}
        </Text>
      </Specimen>
      <Specimen label="One line, middle" code={`textOverflow: "ellipsis-middle"`}>
        <Text style={[body(), { numberOfLines: 1, textOverflow: "ellipsis-middle" }]}>
          {LOREM}
        </Text>
      </Specimen>
      <Specimen label="One line, clip" code={`textOverflow: "clip"`}>
        <Text style={[body(), { numberOfLines: 1, textOverflow: "clip" }]}>
          {LOREM}
        </Text>
      </Specimen>
      <Specimen label="Centered, three lines" code={`textAlign="center"`}>
        <Text style={{ numberOfLines: 3, ...body(), textAlign: "center", color: colors.muted }}>
          {LOREM} {LOREM}
        </Text>
      </Specimen>
    </Card>
  );
}

const CHINESE =
  "原生文本在引擎线程上一次排版，在主线程上直接绘制。中文在任意两个汉字之间都可以换行，但句号、逗号和右括号不会出现在行首，左括号也不会留在行尾（就像这样）。";
const JAPANESE = "日本語の文章は、ひらがな・カタカナ・漢字に Latin の単語や数字（2024年）を混ぜて組みます。句読点は行頭に来ません。";
const ARABIC = "النص الأصلي يُنضَّد مرة واحدة على خيط المحرك ثم يُرسم على الخيط الرئيسي دون أي عمل إضافي في التخطيط.";

function Cjk() {
  return (
    <Card icon="text" title="Chinese and Japanese" subtitle="Lines break between characters, never before closing punctuation">
      <Specimen label="Chinese paragraph" first>
        <Text style={body()}>{CHINESE}</Text>
      </Specimen>
      <Specimen label="Japanese: kana, kanji and Latin">
        <Text style={body()}>{JAPANESE}</Text>
      </Specimen>
      <Specimen label="Two lines, tail" code="numberOfLines: 2">
        <Text style={[body(), { numberOfLines: 2 }]}>
          {CHINESE}
        </Text>
      </Specimen>
      <Specimen label="One line, middle" code={`textOverflow: "ellipsis-middle"`}>
        <Text style={[body(), { numberOfLines: 1, textOverflow: "ellipsis-middle" }]}>
          {JAPANESE}
        </Text>
      </Specimen>
    </Card>
  );
}

function RightToLeft() {
  return (
    <Card icon="text" title="Right to left" subtitle="Arabic and Hebrew, mixed with Latin text and numbers">
      <Specimen label="Arabic paragraph" code={`writingDirection="rtl"`} first>
        <Text style={{ ...body(), writingDirection: "rtl" }}>{ARABIC}</Text>
      </Specimen>
      <Specimen label="Arabic, English and numbers in one line">
        <Text style={body()}>تم شحن الطلب رقم 4521 عبر DHL في 12 مارس، والتسليم خلال 3 أيام.</Text>
      </Specimen>
      <Specimen label="Hebrew">
        <Text style={body()}>שלום! הגרסה 2.0 של nsh זמינה עכשיו (גם ב-Linux).</Text>
      </Specimen>
      <Specimen label="One line, tail" code="numberOfLines: 1">
        <Text style={[body(), { numberOfLines: 1 }]}>
          {ARABIC}
        </Text>
      </Specimen>
    </Card>
  );
}

function Alignment() {
  const sentence = "Short, aligned in its box";
  const paragraph =
    "Justified text spreads the spaces of every line across the box, except on the last line of a paragraph, which stays at its start.";
  return (
    <Card icon="lists" title="Alignment" subtitle="textAlign in left-to-right and right-to-left text">
      <Specimen label="Left" code={`textAlign="left"`} first>
        <Text style={{ ...body(), textAlign: "left" }}>{sentence}</Text>
      </Specimen>
      <Specimen label="Center" code={`textAlign="center"`}>
        <Text style={{ ...body(), textAlign: "center" }}>{sentence}</Text>
      </Specimen>
      <Specimen label="Right" code={`textAlign="right"`}>
        <Text style={{ ...body(), textAlign: "right" }}>{sentence}</Text>
      </Specimen>
      <Specimen label="Justify" code={`textAlign="justify"`}>
        <Text style={{ ...body(), textAlign: "justify" }}>{paragraph}</Text>
      </Specimen>
      <Specimen label="Justify, Chinese" code={`textAlign="justify"`}>
        <Text style={{ ...body(), textAlign: "justify" }}>{CHINESE}</Text>
      </Specimen>
      <Specimen label="Left, in Arabic" code={`textAlign="left"`}>
        <Text style={{ ...body(), textAlign: "left" }}>{ARABIC}</Text>
      </Specimen>
    </Card>
  );
}

export function TextDemo() {
  const cards = [Links, Inline, Fonts, Scaling, Truncation, Cjk, RightToLeft, Alignment];
  return <DemoPage cards={cards} />;
}
