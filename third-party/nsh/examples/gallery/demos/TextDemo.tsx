import { Image, type JSX, signal, Text, View } from "nsh";
import { fontScale } from "nsh";
import pacifico from "../fonts/Pacifico-Regular.ttf";
import logo from "../logo@2x.png";
import { alpha, Caption, Card, colors, DemoPage, finish, isDark, mono, Press, radius, tints } from "../ui";

const LOREM =
  "Native text, typeset once on the engine thread with CoreText and drawn on the main thread without any layout work.";

const body = () => ({ fontSize: 15, lineHeight: 22, color: colors.text }) as const;
const link = () => ({ color: colors.accent, textDecorationLine: "underline", textDecorationColor: alpha(colors.accent, 0.5) }) as const;

/** A labeled specimen: a quiet label (and the prop it shows, in code) above the text. */
function Specimen(props: { label: string; code?: string; first?: boolean; children: JSX.Element }) {
  return (
    <View style={{ gap: 8, paddingTop: props.first ? 0 : 12, borderTopWidth: props.first ? 0 : 1, borderTopColor: colors.line }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
        <Text style={{ flex: 1, fontSize: 13, color: colors.muted }}>{props.label}</Text>
        <If when={props.code}>
          <Text numberOfLines={1} style={{ fontSize: 12, color: colors.faint, fontFamily: mono }}>
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
        <Image src={logo} style={{ width: 18, height: 18, borderRadius: 5 }} />
        {" nsh. Status "}
        <View style={{ backgroundColor: tints.up, borderRadius: 9, paddingHorizontal: 8, height: 18, flexDirection: "row", alignItems: "center", gap: 4 }}>
          <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.up }} />
          <Text style={{ color: colors.up, fontSize: 11, fontWeight: "700", letterSpacing: 0.5 }}>LIVE</Text>
        </View>
        {" and a button inside the sentence "}
        <Press onPress={() => likes.set(likes() + 1)} scale={0.9} accessibilityLabel="Like" hitSlop={10}>
          <View
            style={{
              backgroundColor: colors.raised,
              ...finish.raised,
              borderRadius: 11,
              paddingHorizontal: 9,
              height: 22,
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
      <Specimen label="Shadows" code="textShadow*">
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Text
            style={{
              fontSize: 26,
              fontWeight: "800",
              color: colors.accent,
              textShadowColor: alpha(colors.accent, isDark() ? 0.6 : 0.3),
              textShadowOffset: { width: 0, height: 0 },
              textShadowRadius: 10,
            }}
          >
            Glow
          </Text>
          <View
            style={{
              height: 48,
              paddingHorizontal: 14,
              justifyContent: "center",
              borderRadius: radius.control,
              borderCurve: "continuous",
              backgroundColor: colors.raised,
              ...finish.raised,
              borderWidth: 1,
              borderColor: colors.border,
            }}
          >
            <Text
              style={{
                fontSize: 26,
                fontWeight: "800",
                color: colors.info,
                textShadowColor: isDark() ? "rgba(0,0,0,0.9)" : "rgba(20,20,10,0.22)",
                textShadowOffset: { width: 2, height: 3 },
                textShadowRadius: 3,
              }}
            >
              Drop shadow
            </Text>
          </View>
        </View>
      </Specimen>
    </Card>
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
    <Card icon="lists" title="Truncation" subtitle="numberOfLines and ellipsizeMode">
      <Specimen label="Two lines, tail" code="numberOfLines={2}" first>
        <Text numberOfLines={2} style={body()}>
          {LOREM}
        </Text>
      </Specimen>
      <Specimen label="One line, head" code={`ellipsizeMode="head"`}>
        <Text numberOfLines={1} ellipsizeMode="head" style={body()}>
          {LOREM}
        </Text>
      </Specimen>
      <Specimen label="One line, middle" code={`ellipsizeMode="middle"`}>
        <Text numberOfLines={1} ellipsizeMode="middle" style={body()}>
          {LOREM}
        </Text>
      </Specimen>
      <Specimen label="One line, clip" code={`ellipsizeMode="clip"`}>
        <Text numberOfLines={1} ellipsizeMode="clip" style={body()}>
          {LOREM}
        </Text>
      </Specimen>
      <Specimen label="Centered, three lines" code={`textAlign="center"`}>
        <Text numberOfLines={3} style={{ ...body(), textAlign: "center", color: colors.muted }}>
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
      <Specimen label="Two lines, tail" code="numberOfLines={2}">
        <Text numberOfLines={2} style={body()}>
          {CHINESE}
        </Text>
      </Specimen>
      <Specimen label="One line, middle" code={`ellipsizeMode="middle"`}>
        <Text numberOfLines={1} ellipsizeMode="middle" style={body()}>
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
      <Specimen label="One line, tail" code="numberOfLines={1}">
        <Text numberOfLines={1} style={body()}>
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
