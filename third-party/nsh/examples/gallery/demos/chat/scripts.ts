import type { Tone } from "../../ui";

/** Fictional models: the picker changes the voice and whether the reply thinks first. */
export type Model = "Swift" | "Deep" | "Vision";

export type ToolState = "pending" | "running" | "done" | "cancelled";
export type Source = { title: string; site: string; tone: Tone };
export type Tool =
  | { id: string; kind: "search"; state: ToolState; query: string; sources: Source[] }
  | { id: string; kind: "weather"; state: ToolState; city: string; temp: number; condition: string; high: number; low: number; hours: number[] }
  | { id: string; kind: "code"; state: ToolState; lang: string; code: string; output: string; ms: number };

export type FileRef = { name: string; size: string };
export type Reasoning = { text: string; seconds: number; open: boolean };
export type Status = "done" | "stopped" | "error";

export type Msg =
  | { kind: "date"; id: string; label: string }
  | { kind: "user"; id: string; text: string; image?: string; file?: FileRef; waiting?: boolean }
  | {
      kind: "assistant";
      id: string;
      model: Model;
      script: string;
      reasoning?: Reasoning;
      tools: Tool[];
      md: string;
      status: Status;
      error?: string;
      rating?: "up" | "down";
    };

export type Step =
  | { think: string }
  | { tool: Tool; ms: number }
  | { say: string }
  | { fail: string }
  | { offline: number };

export type Scenario = {
  id: string;
  /** The suggestion chip. */
  chip: string;
  /** What the user "sends". */
  prompt: string;
  model: Model;
  image?: string;
  file?: FileRef;
  steps: Step[];
};

export const photo = "https://pbs.twimg.com/media/HS6UIKjWcAAIFCz?format=jpg&name=small";

const guide = `## Rendering a long list
A list only keeps the rows **near the viewport** alive; the rest exist as *data*. Three ideas make it fast:

1. **Windowing**: rows outside the window are not built at all.
2. **Recycling**: a row that scrolls out is reused for the one scrolling in.
3. **Measuring once**: heights are cached per item, so scrolling never lays out twice.

### What it costs
| Approach | Views | Memory |
| --- | --- | --- |
| Plain scroll view | 10,000 | 412 MB |
| Windowed list | 24 | 18 MB |

Keep per-row state in your data, never inside the row:

\`\`\`tsx
<List each={photos()} estimatedItemSize={76}>
  {(photo) => <Row photo={photo()} />}
</List>
\`\`\`

> A recycled row shows another item tomorrow. Anything it remembers on its own goes with it.

- Use \`keyExtractor\` when items have no \`id\`.
- Prefer fixed heights for rows you can predict.`;

const story = `The lighthouse keeper had not spoken to anyone in eleven days when the radio crackled back to life. It was not a voice at first, only a pattern: three short bursts, a pause, then three again, as if someone on the other side of the fog were knocking politely on a door.

She wrote the pattern down in the margin of the logbook, next to the tide tables and the price of lamp oil. By morning the knocking had become a sentence, and by noon the sentence had become a question she had been waiting her whole life to be asked.

*Is the light still on?* it said.

She looked up at the great lens turning slowly above her, throwing its beam across a sea nobody sailed anymore, and she smiled for the first time in eleven days. **Yes,** she answered. **It always is.**`;

export const scenarios: Scenario[] = [
  {
    id: "story",
    chip: "Tell me a short story",
    prompt: "Tell me a short story about a lighthouse.",
    model: "Swift",
    steps: [{ say: story }],
  },
  {
    id: "guide",
    chip: "Explain list virtualization",
    prompt: "How do recycled lists stay fast? Use a table and an example.",
    model: "Swift",
    steps: [{ say: guide }],
  },
  {
    id: "reason",
    chip: "Think it through",
    prompt: "A bat and a ball cost 1.10 in total. The bat costs 1.00 more than the ball. How much is the ball?",
    model: "Deep",
    steps: [
      {
        think:
          "The quick answer is 0.10, but let me check it. If the ball were 0.10, the bat would be 1.10 and the total 1.20, which is too much. Call the ball x. Then the bat is x + 1.00, so x + x + 1.00 = 1.10, which gives 2x = 0.10 and x = 0.05. Check: 0.05 + 1.05 = 1.10, and the difference is exactly 1.00. That works.",
      },
      {
        say: `The ball costs **0.05**.

If the ball is *x*, the bat is *x* + 1.00, so 2*x* + 1.00 = 1.10 and *x* = 0.05. The intuitive answer, 0.10, would make the total 1.20.`,
      },
    ],
  },
  {
    id: "search",
    chip: "Search the web",
    prompt: "What changed in the latest release of the Harbor runtime?",
    model: "Swift",
    steps: [
      {
        tool: {
          id: "search",
          kind: "search",
          state: "pending",
          query: "Harbor runtime release notes",
          sources: [
            { title: "Harbor 4.2 release notes", site: "harbor.dev", tone: "accent" },
            { title: "What's new in the Harbor scheduler", site: "blog.harbor.dev", tone: "info" },
            { title: "Benchmarks: Harbor 4.1 vs 4.2", site: "perfweekly.io", tone: "warn" },
            { title: "Migrating to the new config format", site: "docs.harbor.dev", tone: "up" },
          ],
        },
        ms: 1600,
      },
      {
        say: `Harbor **4.2** shipped last week. The highlights, from the release notes and two write-ups:

- A new **work-stealing scheduler** that cuts tail latency by about 30 %.
- Configuration moved to a single \`harbor.toml\`; the old flags still work for one more release.
- Cold starts are roughly **2× faster** thanks to lazy module loading.

The benchmark post notes the gains are smallest on single-core machines.`,
      },
    ],
  },
  {
    id: "weather",
    chip: "Weather in Lisbon",
    prompt: "Do I need a jacket in Lisbon this evening?",
    model: "Swift",
    steps: [
      {
        tool: { id: "weather", kind: "weather", state: "pending", city: "Lisbon", temp: 21, condition: "Partly cloudy", high: 24, low: 16, hours: [22, 23, 24, 23, 21, 19, 17, 16] },
        ms: 1000,
      },
      { say: "It's **21°** now and drops to about **16°** after sunset, with a breeze off the river. A light jacket is a good idea for the evening." },
    ],
  },
  {
    id: "code",
    chip: "Run some code",
    prompt: "How many primes are there below 10,000?",
    model: "Deep",
    steps: [
      { think: "Counting by hand is error-prone. A sieve of Eratosthenes up to 10,000 is quick to run, so I will run one and report the count." },
      {
        tool: {
          id: "code",
          kind: "code",
          state: "pending",
          lang: "python",
          code: "n = 10_000\nsieve = [True] * n\nsieve[0] = sieve[1] = False\nfor i in range(2, int(n ** 0.5) + 1):\n    if sieve[i]:\n        sieve[i*i::i] = [False] * len(sieve[i*i::i])\nprint(sum(sieve))",
          output: "1229",
          ms: 38,
        },
        ms: 1800,
      },
      { say: "There are **1,229** primes below 10,000. I counted them with a sieve of Eratosthenes, which runs in a few milliseconds." },
    ],
  },
  {
    id: "vision",
    chip: "Describe a photo",
    prompt: "What's in this photo? And summarize the attached notes.",
    model: "Vision",
    image: photo,
    file: { name: "trip-notes.pdf", size: "2.4 MB" },
    steps: [
      {
        say: `**The photo** shows a harbor at dusk: a few moored boats, low warm light on the water and a line of buildings along the far shore.

**trip-notes.pdf** (4 pages) is an itinerary:
- Day 1: arrive, walk the old town.
- Day 2: boat tour of the harbor, the one in your photo.
- Day 3: museum, then the evening train back.`,
      },
    ],
  },
  {
    id: "error",
    chip: "Fail a reply",
    prompt: "Summarize this week's meeting notes.",
    model: "Swift",
    steps: [{ say: "Here's a summary of the four meetings this week. The planning session agreed on" }, { fail: "The model is overloaded right now (error 529)." }],
  },
  {
    id: "offline",
    chip: "Go offline",
    prompt: "Remind me what we decided about the launch date.",
    model: "Swift",
    steps: [{ offline: 2600 }, { say: "You decided to launch on **Tuesday, November 3**, after the final review on Monday afternoon." }],
  },
];

/** What a retried reply says. */
export const retried: Scenario = {
  id: "retry",
  chip: "",
  prompt: "",
  model: "Swift",
  steps: [
    {
      say: `Here's a summary of the four meetings this week:

1. **Planning**: the launch moves to November 3.
2. **Design review**: the new onboarding is approved with two copy changes.
3. **Infra sync**: the database migration runs on Saturday night.
4. **Retro**: fewer meetings next sprint.`,
    },
  ],
};

/** A free-form prompt: the model echoes it in its own voice. */
export function freeform(prompt: string, model: Model): Scenario {
  const quote = prompt.length > 60 ? `${prompt.slice(0, 57)}…` : prompt;
  const steps: Step[] = [];
  if (model === "Deep") steps.push({ think: `The user asked: "${quote}". This is a simulated assistant, so I will explain that and show what a structured answer would look like.` });
  steps.push({
    say: `You asked: *${quote}*

This assistant is simulated, so here is the shape a ${model === "Deep" ? "careful" : model === "Vision" ? "visual" : "quick"} answer would take:

- **A direct answer** in the first sentence.
- **The reasoning** behind it, kept short.
- **A next step** you can take.

Try the suggestions for streaming, tools, reasoning and errors.`,
  });
  return { id: "free", chip: "", prompt, model, steps };
}

const pastPrompts = [
  ["Can you suggest a name for a hiking club?", "How about **Switchback Society**, **Trail Mix** or **The Ridge Walkers**? The first one sounds the friendliest."],
  ["What's a quick dinner with eggs and spinach?", "A **frittata**: sauté the spinach, pour in six beaten eggs, cook on low for 8 minutes, then finish under the grill for 3."],
  ["Convert 3 cups of flour to grams.", "About **375 g** of all-purpose flour (125 g per cup, spooned and leveled)."],
  ["Is it 'affect' or 'effect' here: the rain will ___ the game?", "**Affect**: it's the verb. *Effect* is usually the noun, as in *the effect of the rain*."],
  ["Give me a one-line summary of photosynthesis.", "Plants use sunlight to turn water and carbon dioxide into sugar, releasing oxygen."],
  ["How do I center a view in a flex container?", "Set `alignItems: \"center\"` and `justifyContent: \"center\"` on the container."],
  ["What's the capital of Australia?", "**Canberra**, not Sydney: it was chosen as a compromise between Sydney and Melbourne."],
  ["Write a haiku about Mondays.", "*Alarm sings too soon*\n\n*coffee steams against the glass*\n\n*the week opens slow*"],
];

/** A long conversation over three days, for scrolling. */
export function history(nextId: () => string): Msg[] {
  const out: Msg[] = [];
  const days = ["Monday, October 12", "Yesterday", "Today"];
  days.forEach((label, day) => {
    out.push({ kind: "date", id: nextId(), label });
    for (let i = 0; i < 20; i++) {
      const [q, a] = pastPrompts[(day * 20 + i) % pastPrompts.length];
      out.push({ kind: "user", id: nextId(), text: q });
      out.push({ kind: "assistant", id: nextId(), model: "Swift", script: "history", tools: [], md: a, status: "done" });
    }
  });
  return out;
}
