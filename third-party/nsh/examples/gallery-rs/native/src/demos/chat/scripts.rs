//! What the simulated assistant says (as the TSX gallery's
//! `demos/chat/scripts.ts`): the scenarios, their steps, a free-form
//! reply and a long history.

use crate::ui::Tone;

/// Fictional models: the picker changes the voice and whether the reply
/// thinks first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum Model {
    #[default]
    Swift,
    Deep,
    Vision,
}

pub(crate) const MODELS: [Model; 3] = [Model::Swift, Model::Deep, Model::Vision];

impl Model {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Model::Swift => "Swift",
            Model::Deep => "Deep",
            Model::Vision => "Vision",
        }
    }
}

/// Where a tool call is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ToolState {
    Pending,
    Running,
    Done,
    Cancelled,
}

impl ToolState {
    pub(crate) fn label(self) -> &'static str {
        match self {
            ToolState::Pending => "Queued",
            ToolState::Running => "Running",
            ToolState::Done => "Done",
            ToolState::Cancelled => "Stopped",
        }
    }

    pub(crate) fn tone(self) -> Tone {
        match self {
            ToolState::Pending => Tone::Neutral,
            ToolState::Running => Tone::Info,
            ToolState::Done => Tone::Up,
            ToolState::Cancelled => Tone::Warn,
        }
    }
}

/// A search result.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Source {
    pub(crate) title: &'static str,
    pub(crate) site: &'static str,
    pub(crate) tone: Tone,
}

/// What a tool does, and what it found.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ToolKind {
    Search {
        query: &'static str,
        sources: Vec<Source>,
    },
    Weather {
        city: &'static str,
        temp: i32,
        condition: &'static str,
        high: i32,
        low: i32,
        hours: Vec<i32>,
    },
    Code {
        lang: &'static str,
        code: &'static str,
        output: &'static str,
        ms: u32,
    },
}

/// A tool call.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Tool {
    pub(crate) id: &'static str,
    pub(crate) state: ToolState,
    pub(crate) kind: ToolKind,
}

/// An attached file.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct FileRef {
    pub(crate) name: &'static str,
    pub(crate) size: &'static str,
}

/// A reply's thinking.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Reasoning {
    pub(crate) text: String,
    pub(crate) seconds: u64,
    pub(crate) open: bool,
}

/// How a reply ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Status {
    Done,
    Stopped,
    Error,
}

/// A rating of a reply.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Rating {
    Up,
    Down,
}

/// An assistant's reply.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Assistant {
    pub(crate) id: String,
    pub(crate) model: Model,
    pub(crate) script: &'static str,
    pub(crate) reasoning: Option<Reasoning>,
    pub(crate) tools: Vec<Tool>,
    pub(crate) md: String,
    pub(crate) status: Status,
    pub(crate) error: Option<&'static str>,
    pub(crate) rating: Option<Rating>,
}

/// A message of the conversation.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Msg {
    Date {
        id: String,
        label: &'static str,
    },
    User {
        id: String,
        text: String,
        image: Option<&'static str>,
        file: Option<FileRef>,
        waiting: bool,
    },
    Assistant(Assistant),
}

impl Msg {
    pub(crate) fn id(&self) -> &str {
        match self {
            Msg::Date { id, .. } | Msg::User { id, .. } => id,
            Msg::Assistant(a) => &a.id,
        }
    }
}

/// A step of a scripted reply.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Step {
    Think(String),
    Tool(Tool, u64),
    Say(String),
    Fail(&'static str),
    Offline(u64),
}

/// A scripted exchange.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Scenario {
    pub(crate) id: &'static str,
    /// The suggestion chip.
    pub(crate) chip: &'static str,
    /// What the user "sends".
    pub(crate) prompt: &'static str,
    pub(crate) model: Model,
    pub(crate) image: Option<&'static str>,
    pub(crate) file: Option<FileRef>,
    pub(crate) steps: Vec<Step>,
}

pub(crate) const PHOTO: &str = "https://pbs.twimg.com/media/HS6UIKjWcAAIFCz?format=jpg&name=small";

/// The notes attached with the photo.
pub(crate) const NOTES: FileRef = FileRef {
    name: "trip-notes.pdf",
    size: "2.4 MB",
};

const GUIDE: &str = r#"## Rendering a long list
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

```tsx
<List each={photos()} estimatedItemSize={76}>
  {(photo) => <Row photo={photo()} />}
</List>
```

> A recycled row shows another item tomorrow. Anything it remembers on its own goes with it.

- Use `keyExtractor` when items have no `id`.
- Prefer fixed heights for rows you can predict."#;

const STORY: &str = "The lighthouse keeper had not spoken to anyone in eleven days when the radio crackled back to life. It was not a voice at first, only a pattern: three short bursts, a pause, then three again, as if someone on the other side of the fog were knocking politely on a door.

She wrote the pattern down in the margin of the logbook, next to the tide tables and the price of lamp oil. By morning the knocking had become a sentence, and by noon the sentence had become a question she had been waiting her whole life to be asked.

*Is the light still on?* it said.

She looked up at the great lens turning slowly above her, throwing its beam across a sea nobody sailed anymore, and she smiled for the first time in eleven days. **Yes,** she answered. **It always is.**";

/// The scripted exchanges, in the order the suggestions list them.
pub(crate) fn scenarios() -> Vec<Scenario> {
    let say = |s: &str| Step::Say(s.to_owned());
    vec![
        Scenario {
            id: "story",
            chip: "Tell me a short story",
            prompt: "Tell me a short story about a lighthouse.",
            model: Model::Swift,
            image: None,
            file: None,
            steps: vec![say(STORY)],
        },
        Scenario {
            id: "guide",
            chip: "Explain list virtualization",
            prompt: "How do recycled lists stay fast? Use a table and an example.",
            model: Model::Swift,
            image: None,
            file: None,
            steps: vec![say(GUIDE)],
        },
        Scenario {
            id: "reason",
            chip: "Think it through",
            prompt: "A bat and a ball cost 1.10 in total. The bat costs 1.00 more than the ball. How much is the ball?",
            model: Model::Deep,
            image: None,
            file: None,
            steps: vec![
                Step::Think("The quick answer is 0.10, but let me check it. If the ball were 0.10, the bat would be 1.10 and the total 1.20, which is too much. Call the ball x. Then the bat is x + 1.00, so x + x + 1.00 = 1.10, which gives 2x = 0.10 and x = 0.05. Check: 0.05 + 1.05 = 1.10, and the difference is exactly 1.00. That works.".into()),
                say("The ball costs **0.05**.\n\nIf the ball is *x*, the bat is *x* + 1.00, so 2*x* + 1.00 = 1.10 and *x* = 0.05. The intuitive answer, 0.10, would make the total 1.20."),
            ],
        },
        Scenario {
            id: "search",
            chip: "Search the web",
            prompt: "What changed in the latest release of the Harbor runtime?",
            model: Model::Swift,
            image: None,
            file: None,
            steps: vec![
                Step::Tool(
                    Tool {
                        id: "search",
                        state: ToolState::Pending,
                        kind: ToolKind::Search {
                            query: "Harbor runtime release notes",
                            sources: vec![
                                Source { title: "Harbor 4.2 release notes", site: "harbor.dev", tone: Tone::Accent },
                                Source { title: "What's new in the Harbor scheduler", site: "blog.harbor.dev", tone: Tone::Info },
                                Source { title: "Benchmarks: Harbor 4.1 vs 4.2", site: "perfweekly.io", tone: Tone::Warn },
                                Source { title: "Migrating to the new config format", site: "docs.harbor.dev", tone: Tone::Up },
                            ],
                        },
                    },
                    1600,
                ),
                say("Harbor **4.2** shipped last week. The highlights, from the release notes and two write-ups:\n\n- A new **work-stealing scheduler** that cuts tail latency by about 30 %.\n- Configuration moved to a single `harbor.toml`; the old flags still work for one more release.\n- Cold starts are roughly **2× faster** thanks to lazy module loading.\n\nThe benchmark post notes the gains are smallest on single-core machines."),
            ],
        },
        Scenario {
            id: "weather",
            chip: "Weather in Lisbon",
            prompt: "Do I need a jacket in Lisbon this evening?",
            model: Model::Swift,
            image: None,
            file: None,
            steps: vec![
                Step::Tool(
                    Tool {
                        id: "weather",
                        state: ToolState::Pending,
                        kind: ToolKind::Weather {
                            city: "Lisbon",
                            temp: 21,
                            condition: "Partly cloudy",
                            high: 24,
                            low: 16,
                            hours: vec![22, 23, 24, 23, 21, 19, 17, 16],
                        },
                    },
                    1000,
                ),
                say("It's **21°** now and drops to about **16°** after sunset, with a breeze off the river. A light jacket is a good idea for the evening."),
            ],
        },
        Scenario {
            id: "code",
            chip: "Run some code",
            prompt: "How many primes are there below 10,000?",
            model: Model::Deep,
            image: None,
            file: None,
            steps: vec![
                Step::Think("Counting by hand is error-prone. A sieve of Eratosthenes up to 10,000 is quick to run, so I will run one and report the count.".into()),
                Step::Tool(
                    Tool {
                        id: "code",
                        state: ToolState::Pending,
                        kind: ToolKind::Code {
                            lang: "python",
                            code: "n = 10_000\nsieve = [True] * n\nsieve[0] = sieve[1] = False\nfor i in range(2, int(n ** 0.5) + 1):\n    if sieve[i]:\n        sieve[i*i::i] = [False] * len(sieve[i*i::i])\nprint(sum(sieve))",
                            output: "1229",
                            ms: 38,
                        },
                    },
                    1800,
                ),
                say("There are **1,229** primes below 10,000. I counted them with a sieve of Eratosthenes, which runs in a few milliseconds."),
            ],
        },
        Scenario {
            id: "vision",
            chip: "Describe a photo",
            prompt: "What's in this photo? And summarize the attached notes.",
            model: Model::Vision,
            image: Some(PHOTO),
            file: Some(NOTES),
            steps: vec![say("**The photo** shows a harbor at dusk: a few moored boats, low warm light on the water and a line of buildings along the far shore.\n\n**trip-notes.pdf** (4 pages) is an itinerary:\n- Day 1: arrive, walk the old town.\n- Day 2: boat tour of the harbor, the one in your photo.\n- Day 3: museum, then the evening train back.")],
        },
        Scenario {
            id: "error",
            chip: "Fail a reply",
            prompt: "Summarize this week's meeting notes.",
            model: Model::Swift,
            image: None,
            file: None,
            steps: vec![
                say("Here's a summary of the four meetings this week. The planning session agreed on"),
                Step::Fail("The model is overloaded right now (error 529)."),
            ],
        },
        Scenario {
            id: "offline",
            chip: "Go offline",
            prompt: "Remind me what we decided about the launch date.",
            model: Model::Swift,
            image: None,
            file: None,
            steps: vec![
                Step::Offline(2600),
                say("You decided to launch on **Tuesday, November 3**, after the final review on Monday afternoon."),
            ],
        },
    ]
}

/// What a retried reply says.
pub(crate) fn retried() -> Scenario {
    Scenario {
        id: "retry",
        chip: "",
        prompt: "",
        model: Model::Swift,
        image: None,
        file: None,
        steps: vec![Step::Say(
            "Here's a summary of the four meetings this week:\n\n1. **Planning**: the launch moves to November 3.\n2. **Design review**: the new onboarding is approved with two copy changes.\n3. **Infra sync**: the database migration runs on Saturday night.\n4. **Retro**: fewer meetings next sprint."
                .into(),
        )],
    }
}

/// A free-form prompt: the model echoes it in its own voice.
pub(crate) fn freeform(prompt: &str, model: Model) -> Scenario {
    let chars: Vec<char> = prompt.chars().collect();
    let quote = if chars.len() > 60 {
        format!("{}…", chars[..57].iter().collect::<String>())
    } else {
        prompt.to_owned()
    };
    let mut steps = Vec::new();
    if model == Model::Deep {
        steps.push(Step::Think(format!(
            "The user asked: \"{quote}\". This is a simulated assistant, so I will explain that and show what a structured answer would look like."
        )));
    }
    let voice = match model {
        Model::Deep => "careful",
        Model::Vision => "visual",
        Model::Swift => "quick",
    };
    steps.push(Step::Say(format!(
        "You asked: *{quote}*\n\nThis assistant is simulated, so here is the shape a {voice} answer would take:\n\n- **A direct answer** in the first sentence.\n- **The reasoning** behind it, kept short.\n- **A next step** you can take.\n\nTry the suggestions for streaming, tools, reasoning and errors."
    )));
    Scenario {
        id: "free",
        chip: "",
        prompt: "",
        model,
        image: None,
        file: None,
        steps,
    }
}

const PAST: [(&str, &str); 8] = [
    (
        "Can you suggest a name for a hiking club?",
        "How about **Switchback Society**, **Trail Mix** or **The Ridge Walkers**? The first one sounds the friendliest.",
    ),
    (
        "What's a quick dinner with eggs and spinach?",
        "A **frittata**: sauté the spinach, pour in six beaten eggs, cook on low for 8 minutes, then finish under the grill for 3.",
    ),
    (
        "Convert 3 cups of flour to grams.",
        "About **375 g** of all-purpose flour (125 g per cup, spooned and leveled).",
    ),
    (
        "Is it 'affect' or 'effect' here: the rain will ___ the game?",
        "**Affect**: it's the verb. *Effect* is usually the noun, as in *the effect of the rain*.",
    ),
    (
        "Give me a one-line summary of photosynthesis.",
        "Plants use sunlight to turn water and carbon dioxide into sugar, releasing oxygen.",
    ),
    (
        "How do I center a view in a flex container?",
        "Set `alignItems: \"center\"` and `justifyContent: \"center\"` on the container.",
    ),
    (
        "What's the capital of Australia?",
        "**Canberra**, not Sydney: it was chosen as a compromise between Sydney and Melbourne.",
    ),
    (
        "Write a haiku about Mondays.",
        "*Alarm sings too soon*\n\n*coffee steams against the glass*\n\n*the week opens slow*",
    ),
];

/// A long conversation over three days, for scrolling.
pub(crate) fn history(mut next_id: impl FnMut() -> String) -> Vec<Msg> {
    let mut out = Vec::new();
    for (day, label) in ["Monday, October 12", "Yesterday", "Today"]
        .into_iter()
        .enumerate()
    {
        out.push(Msg::Date {
            id: next_id(),
            label,
        });
        for i in 0..20 {
            let (q, a) = PAST[(day * 20 + i) % PAST.len()];
            out.push(Msg::User {
                id: next_id(),
                text: q.into(),
                image: None,
                file: None,
                waiting: false,
            });
            out.push(Msg::Assistant(Assistant {
                id: next_id(),
                model: Model::Swift,
                script: "history",
                reasoning: None,
                tools: Vec::new(),
                md: a.into(),
                status: Status::Done,
                error: None,
                rating: None,
            }));
        }
    }
    out
}
