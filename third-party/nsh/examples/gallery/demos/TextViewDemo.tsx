import { cleanup, signal, Text, View } from "nsh";
import { TextView, type TextViewImage } from "nsh/base";
import { Button, Caption, Card, colors, DemoPage } from "../ui";
import { ImageViewer } from "./ImageViewer";

const MARKDOWN = `# Native Shell

**NSH** loads apps written in *TSX* into native apps at run time and renders them with each platform's ~~web views~~ own views. Press <kbd>⌘K</kbd> to search the docs, or read [the guide](https://github.com/longbridge/nsh).

## How it works

1. The bundler compiles TSX to QuickJS bytecode
2. The runtime runs it on a native core
   - the reactive graph and the renderer are Rust
   - layout is Taffy (flex and grid)

- [x] Signed packages, checked before they run
- [x] Hot reload on save
- [ ] A styled component library (that one is yours)

| Platform | Views | Text |
|:---------|:------|-----:|
| iOS      | UIKit | CoreText |
| Android  | Android views | StaticLayout |
| Linux    | GTK 4 | Pango |

\`\`\`tsx
import { mount, Text } from "nsh";

mount(() => <Text class="text-lg font-semibold">Hello, NSH</Text>);
\`\`\`

> Only the app's code is JS: everything else is native.

![Green mountains under low clouds](https://picsum.photos/id/1018/1200/750)

> [!TIP]
> Long-press any paragraph to select and copy it.

> [!WARNING]
> Apps are never rebuilt once delivered, so nothing that reached \`main\` is removed.

A list stays smooth at $60$ frames a second, $16.7\\,\\text{ms}$ each.

$$
t_{\\text{frame}} = \\tfrac{1000}{60}\\,\\text{ms}
$$

<details>
<summary>Why QuickJS</summary>

It is small, starts fast and runs **bytecode** delivered with the app, so nothing is parsed on the device.

</details>

---

Numbers come from the gallery's benchmarks.[^1]

[^1]: Release builds on a mid-range phone and a 2021 laptop.
`;

const HTML = `<article>
  <header>
    <h1 id="nsh-0-1-0">NSH 0.1.0: native UI from TSX</h1>
    <p><small>Posted by the NSH team &middot; 6 min read &middot; <a href="https://github.com/longbridge/nsh" title="Repository">GitHub</a></small></p>
  </header>

  <section>
    <h2 id="highlights">Highlights</h2>
    <p>
      NSH    0.1.0 is our <b>first</b> release:   apps written in TSX load
      <i>at run time</i> into native apps, render with <u>each platform's own views</u>, and the
      <s>Node.js</s> <mark>pure Rust</mark> toolchain needs nothing else. Hot reload is
      <mark color="yellow">about 120 ms</mark>, and every bundle is checked before it
      <mark style="background-color: #fecaca">runs</mark>.
    </p>
    <p>
      Styles mean what they mean in a browser: <code>w-1/2</code> or <code>bg-sky-500/15</code>, spacing in
      steps of 2<sup>2</sup> pt, and text sets H<sub>2</sub>O as you would expect. Press <kbd>Ctrl</kbd> + <kbd>B</kbd>
      to fold the gallery's sidebar, or run <code>nsh run examples/gallery</code> to try it. Our first rule says it
      best: <q>QuickJS is the slowest link: JS does as little as possible</q>. The <abbr title="Just-in-time">JIT</abbr>-free
      runtime behind it is open source.
    </p>
    <figure>
      <a href="https://picsum.photos/id/1015/600/300"><img src="https://picsum.photos/id/1015/320/160" alt="A river valley under clouds" width="320" height="160"></a>
      <figcaption>The gallery on a phone, a desktop and the web, one app. <em>Tap to open it full size.</em></figcaption>
    </figure>
    <figure>
      <img src="https://picsum.photos/id/1036/1200/750" alt="A tent in the snow below mountains" width="320" height="200">
      <figcaption>Where the renderer was written. <em>Press it to zoom in.</em></figcaption>
    </figure>
  </section>

  <section>
    <h2 id="getting-started">Getting started</h2>
    <h3>Step by step</h3>
    <ol start="3">
      <li>Create an app (steps 1 and 2 were installing Rust and building the CLI)</li>
      <li>Run <b>nsh run</b> and choose a target:
        <ul>
          <li><i>Desktop</i>: AppKit, Win32 or GTK 4, the default</li>
          <li><i>Mobile</i>: a simulator or a device
            <ol>
              <li>iOS with UIKit views</li>
              <li>or Android with Android views</li>
            </ol>
          </li>
        </ul>
      </li>
      <li>Edit, save, and watch it reload</li>
    </ol>

    <h3>Checklist</h3>
    <ul>
      <li><input type="checkbox" checked> Write the app in TSX</li>
      <li><input type="checkbox" checked> Test it headless with nsh test</li>
      <li><input type="checkbox"> Sign and publish the package</li>
    </ul>

    <h4>Terms</h4>
    <dl>
      <dt>Host</dt>
      <dd>The native app that embeds NSH and loads modules.</dd>
      <dt>Package</dt>
      <dd>A signed <code>.nshpkg</code>: an app's bundle, checked before it runs.</dd>
    </dl>
  </section>

  <section>
    <h2 id="components">Components</h2>
    <blockquote>
      <p>Nothing NSH ships has a look of its own: the app's classes and styles draw everything.</p>
      <p>&mdash; <cite>NSH's design rules</cite></p>
    </blockquote>
    <p>An app is a module that mounts a component:</p>
    <pre><code class="language-tsx">import { mount, signal, Text, View } from "nsh";

function Counter() {
  const count = signal(0);
  return (
    &lt;View class="p-4" onPress={() =&gt; count.set(count() + 1)}&gt;
      &lt;Text&gt;{\`Pressed \${count()} times\`}&lt;/Text&gt;
    &lt;/View&gt;
  );
}

mount(Counter);</code></pre>
  </section>

  <section>
    <h2 id="performance">Performance</h2>
    <table>
      <thead>
        <tr><th align="left">Operation</th><th align="right">Platform</th><th align="right">Time</th><th style="text-align: center">Items</th></tr>
      </thead>
      <tbody>
        <tr><td>Counter, first frame</td><td align="right">headless</td><td align="right">0.6 ms</td><td align="center">49</td></tr>
        <tr><td>Counter, one tap</td><td align="right">headless</td><td align="right">0.15 ms</td><td align="center">8</td></tr>
        <tr><td>List row while scrolling</td><td align="right">Android</td><td align="right">0.35 ms</td><td align="center">4</td></tr>
      </tbody>
      <tfoot>
        <tr><td colspan="3">Baselines from docs/dev/performance.md</td><td align="center">&#10003;</td></tr>
      </tfoot>
    </table>
  </section>

  <details>
    <summary>Known issues</summary>
    <p>Zooming scroll views run on iOS and Android only for now. The desktops follow in a later release.</p>
  </details>
  <details open>
    <summary>Thanks</summary>
    <p>
      NSH is created by <a href="https://github.com/sunli829"><img src="https://avatars.githubusercontent.com/u/20092316?s=48" alt="sunli829" style="width: 20px; height: 20px"></a> <a href="https://github.com/sunli829">@sunli829</a>
      and <a href="https://github.com/huacnlee"><img src="https://avatars.githubusercontent.com/u/5518?s=48" alt="huacnlee" width="20" height="20"></a> <a href="https://github.com/huacnlee">@huacnlee</a>,
      with&nbsp;&hearts;.
    </p>
  </details>
</article>`;

const EXTENDED = `Thanks @huacnlee and @sunli829 for the review!

\`\`\`chart
Mon 12
Tue 18
Wed 9
Thu 22
Fri 15
\`\`\`

<Callout kind="tip">

Extensions turn the app's own syntax into **custom nodes**.

</Callout>

:::note[Heads up]
Containers wrap Markdown, like *this*.
:::
`;

const extensions = [
  { name: "mention", pattern: "@(\\w+)" },
  { name: "chart", language: "chart" },
  { name: "callout", tag: "callout" },
  { name: "note", container: "note" },
];

const REPLY = `Here is how to put **an NSH app** in your iOS app:

1. Build the SDK with \`cargo xtask ios-embed\`
2. Add *NativeShell.xcframework* to the project
3. Show the app in an \`NshAppView\`

| Step | Where |
|------|------:|
| SDK | your Mac |
| View | your app |

\`\`\`sh
nsh package my-app --target ios-simulator --run
\`\`\`

That's it. Ping me if anything looks off.`;


/** A formula without a math renderer of the app's: its TeX, set apart. */
function Tex(props: { tex: string; display: boolean }) {
  return (
    <If when={props.display} else={<Text class="font-mono text-[13px] text-violet-600 dark:text-violet-300">{props.tex}</Text>}>
      <View class="items-center rounded-lg bg-violet-500/10 px-3 py-2">
        <Text class="font-mono text-[13px] text-violet-600 dark:text-violet-300">{props.tex}</Text>
      </View>
    </If>
  );
}

/** Links in the gallery's accent (a `TextView` draws them in the theme's `primary`). */
const links = { link: "text-brand decoration-brand/40" };

function Markdown() {
  const pressed = signal("nothing yet");
  const viewing = signal<TextViewImage | null>(null);
  return (
    <Card icon="text" title="Markdown" subtitle="CommonMark and GitHub's: tables, tasks, alerts, footnotes, math, HTML">
      <TextView
        markdown={MARKDOWN}
        selectable
        classes={links}
        codeBlockActions={[{ id: "copy", label: "Copy code" }]}
        renderMath={(math) => <Tex tex={math.tex} display={math.display} />}
        onLinkPress={({ url }) => pressed.set(url)}
        onImagePress={(image) => viewing.set(image)}
      />
      <Caption label="Link pressed" note={pressed()} />
      <ImageViewer image={viewing()} onClose={() => viewing.set(null)} />
    </Card>
  );
}

function Html() {
  const viewing = signal<TextViewImage | null>(null);
  return (
    <Card icon="text" title="HTML" subtitle="An article page: sections, figures, lists, tables, code">
      <TextView html={HTML} selectable classes={links} onImagePress={(image) => viewing.set(image)} />
      <ImageViewer image={viewing()} onClose={() => viewing.set(null)} />
    </Card>
  );
}

/** A tiny bar chart of a ```chart block's lines ("Mon 12"). */
function Chart(props: { source: string }) {
  const bars = () =>
    props.source
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((p) => p.length === 2)
      .map(([label, value]) => ({ label, value: Number(value) || 0 }));
  const max = () => Math.max(1, ...bars().map((b) => b.value));
  return (
    <View class="h-28 flex-row items-end gap-2 rounded-xl border border-border bg-inset p-3">
      <Each of={bars()}>
        {(bar) => (
          <View class="flex-1 items-center gap-1">
            <View class="w-full rounded-md bg-brand" style={{ height: (bar().value / max()) * 64 }} />
            <Text class="text-[11px] text-zinc-500">{bar().label}</Text>
          </View>
        )}
      </Each>
    </View>
  );
}

function Extensions() {
  return (
    <Card icon="components" title="Extensions" subtitle="Mentions, a chart block, a <Callout> tag, a :::note container">
      <TextView
        markdown={EXTENDED}
        extensions={extensions}
        renderCustom={(node) => {
          switch (node.name) {
            case "mention":
              return (
                <View class="translate-y-[7px] rounded-full bg-sky-500/15 px-2">
                  <Text class="text-[14px] font-medium text-sky-700 dark:text-sky-300">@{node.attributes?.["1"]}</Text>
                </View>
              );
            case "chart":
              return <Chart source={node.text ?? ""} />;
            case "callout":
              return (
                <View class="flex-row gap-3 rounded-xl bg-emerald-500/10 p-3">
                  <Text class="text-emerald-600 dark:text-emerald-400">✦</Text>
                  <TextView document={{ blocks: node.children ?? [] }} class="flex-1" />
                </View>
              );
            default:
              return (
                <View class="gap-1 rounded-xl border border-sky-500/40 p-3">
                  <Text class="text-xs font-semibold uppercase tracking-wide text-sky-600 dark:text-sky-400">{node.attributes?.label ?? node.name}</Text>
                  <TextView document={{ blocks: node.children ?? [] }} />
                </View>
              );
          }
        }}
      />
    </Card>
  );
}

function Caret() {
  return <View class="ml-0.5 h-4 w-2 animate-pulse rounded-sm bg-brand" />;
}

function Streaming() {
  const text = signal("");
  const streaming = signal(false);
  let timer: number | undefined;
  const stop = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    streaming.set(false);
  };
  cleanup(stop);
  const play = () => {
    stop();
    const tokens = REPLY.match(/\s*\S{1,4}|\s+/g) ?? [];
    let i = 0;
    text.set("");
    streaming.set(true);
    timer = setInterval(() => {
      if (i >= tokens.length) return stop();
      text.set(text() + tokens[i++]);
    }, 40);
  };
  return (
    <Card icon="chat" title="Streaming" subtitle="A reply as an AI model writes it, with a caret">
      <TextView
        markdown={text()}
        options={{ streaming: streaming() }}
        streamingCaret={streaming() ? <Caret /> : undefined}
        selectable
        codeBlockActions={[{ id: "copy", label: "Copy code" }]}
      />
      <Button label={streaming() ? "Streaming…" : "Stream it"} icon="play" variant="secondary" disabled={streaming()} onPress={play} />
    </Card>
  );
}

const QUESTION = "Which **platforms** does NSH run on?";

const ANSWER = `Every one with a native backend:

- iOS and Android: UIKit and Android views
- macOS, Windows and Linux: AppKit, Win32 and GTK 4`;

/** Two documents and a plain text that select as one, around a label that stays out. */
function Selection() {
  return (
    <Card icon="text" title="Selectable view" subtitle="One selection across texts and TextViews">
      <View selectable class="gap-3">
        <TextView markdown={QUESTION} />
        <TextView markdown={ANSWER} />
        <View class="flex-row items-baseline gap-2">
          <Text selectable={false} style={{ fontSize: 13, color: colors.faint }}>Not selectable</Text>
          <Text style={{ fontSize: 15, color: colors.text }}>A plain Text joins the selection too.</Text>
        </View>
      </View>
      <Caption label="Drag from the question into the answer, or long press and move the handles" />
    </Card>
  );
}

export function TextViewDemo() {
  return <DemoPage cards={[Streaming, Markdown, Selection, Extensions, Html]} />;
}
