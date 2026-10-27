//! AI Chat (as the TSX gallery's `demos/Chat.tsx` and `demos/chat/`): a
//! simulated assistant whose replies stream token by token (batched per
//! frame), think first, call tools, fail and recover; every scenario
//! comes from local scripts and timers. The desktop layout adds a list of
//! conversations on the left and keeps messages and the composer in a
//! readable column.
//!
//! The conversation is a signal of messages; its rows are a virtualized
//! list whose cells bind to the message they show. The reply being written
//! is [`Live`], signals only its row reads: a frame of tokens updates that
//! row's Markdown, whose view makes again only the last block.

mod glyphs;
mod markdown;
mod parts;
mod scripts;

use std::{rc::Rc, time::Duration};

use nsh_base::input;
use nsh_core::{
    LayoutAnimation, Points, Size,
    element::{AccessibilityState, ScrollEvent, View},
    prelude::*,
    time::Instant,
};

use self::{
    glyphs::{GlyphName, glyph},
    markdown::markdown,
    parts::{
        action_button, avatar, caret, date_separator, error_row, file_chip, photo, spinner,
        tool_card,
    },
    scripts::{
        Assistant, FileRef, MODELS, Model, Msg, NOTES, PHOTO, Rating, Reasoning, Scenario, Status,
        Step, Tool, ToolState, freeform, history, retried, scenarios,
    },
};
use crate::ui::{
    Badge, Finish, Finished, IconName, IconTile, RoundButton, Segment, SegmentedSize, Tone, appear,
    colors, desktop, icon, motion, press, radius, rgb_a, segmented,
};

/// Desktop: messages and the composer in a centered column.
fn column(v: View) -> View {
    v.w(relative(1.0)).max_w(px(820.0)).self_center()
}

/// The reply being written, as signals only its row reads. Finished
/// replies are plain data in the chat's messages.
#[derive(Clone, Copy)]
struct Live {
    /// Its message's id (none: no reply is being written).
    id: Signal<Option<String>>,
    /// Its reasoning so far.
    reason: Signal<String>,
    /// When the thinking started, and its seconds once it ended.
    thinking: Signal<Option<(Instant, Option<u64>)>>,
    /// Its tool calls so far.
    tools: Signal<Vec<Tool>>,
    /// Its Markdown so far.
    md: Signal<String>,
    /// Ticks once a second while thinking.
    now: Signal<Option<Instant>>,
}

/// What the rows ask of the chat.
#[derive(Debug, Clone, PartialEq)]
enum Action {
    Copy(String, String),
    Regenerate(String),
    Retry(String),
    Rate(String, Rating),
    Reasoning(String),
}

/// The connection banner.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Banner {
    #[default]
    Offline,
    Online,
}

/// The features the empty chat offers: scenario, icon, note.
const FEATURED: [(&str, IconName, &str); 4] = [
    ("guide", IconName::Text, "Markdown, a table, code"),
    ("reason", IconName::Spark, "Reasoning first"),
    ("search", IconName::Search, "A tool call"),
    ("vision", IconName::Image, "A photo and a file"),
];

/// A reply being run.
struct Run {
    id: String,
    model: Model,
    script: &'static str,
    md: String,
    reason: String,
    think_start: Instant,
    think_seconds: Option<u64>,
    /// Tokens collect here and reach [`Live`] once per frame.
    pending_text: String,
    pending_reason: String,
    frame: Option<Spawned<()>>,
    ticker: Option<Spawned<()>>,
    /// The run's steps: cancelled when it is stopped.
    task: Option<Spawned<()>>,
}

impl Run {
    /// Ends its tasks (the steps, the frame, the ticker).
    fn cancel(&mut self) {
        for task in [self.frame.take(), self.ticker.take(), self.task.take()]
            .into_iter()
            .flatten()
        {
            task.cancel();
        }
    }
}

/// Where streamed tokens go.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stream {
    Text,
    Reason,
}

/// What kind of row a message is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RowKind {
    Date,
    User,
    Assistant,
}

impl RowKind {
    fn of(msg: &Msg) -> Self {
        match msg {
            Msg::Date { .. } => RowKind::Date,
            Msg::User { .. } => RowKind::User,
            Msg::Assistant(_) => RowKind::Assistant,
        }
    }
}

/// A list cell's message (none past the end).
type Item = Memo<Option<Msg>>;

/// `f` of the reply `item` is, if it is one (a tracked read).
fn with_reply<R>(item: Item, f: impl FnOnce(&Assistant) -> R) -> Option<R> {
    item.with(|m| match m {
        Some(Msg::Assistant(a)) => Some(f(a)),
        _ => None,
    })
}

/// A task in `slot`, ending the one it replaces.
fn keep(slot: Stored<Option<Spawned<()>>>, task: Spawned<()>) {
    if let Some(old) = slot.replace(Some(task)) {
        old.cancel();
    }
}

/// Springs `value` to 1 while `on` holds and to 0 while it does not, as it
/// changes.
fn spring_on(value: AnimatedValue, on: impl Fn() -> bool + 'static) {
    let shown = stored(untracked(&on));
    effect(move || {
        let now = on();
        if shown.replace(now) != now {
            let _ = value.spring(if now { 1.0 } else { 0.0 }, motion::SETTLE);
        }
    });
}

/// Numbers in 0..1 (xorshift), seeded from the clock: the streams' jitter.
struct Jitter(u64);

impl Jitter {
    fn new() -> Self {
        let seed = (nsh_core::time::unix_ms() as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15);
        Self(seed | 1)
    }

    fn next(&mut self) -> f64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        (x >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// The tokens of `text`: a word piece of up to four characters with the
/// space before it, or a run of spaces.
fn tokens(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut chars = text.chars().peekable();
    while chars.peek().is_some() {
        let mut token = String::new();
        while let Some(&c) = chars.peek().filter(|c| c.is_whitespace()) {
            token.push(c);
            chars.next();
        }
        let mut word = 0;
        while let Some(&c) = chars.peek().filter(|c| !c.is_whitespace()) {
            if word == 4 {
                break;
            }
            token.push(c);
            chars.next();
            word += 1;
        }
        out.push(token);
    }
    out
}

/// The chat's state: signals the view binds to and what its actions keep
/// (`Copy`: closures and tasks capture it).
#[derive(Clone, Copy)]
struct ChatState {
    /// The chat's own owner: its tasks end with it, not with the row or
    /// branch whose button started them.
    owner: Owner,
    ids: Stored<u32>,
    messages: Signal<Vec<Msg>>,
    model: Signal<Model>,
    draft: Signal<String>,
    input_height: Signal<f32>,
    /// The photo and the notes are attached.
    attachment: Signal<bool>,
    menu: Signal<bool>,
    /// The connection banner shows, and what it says.
    banner: Signal<bool>,
    banner_kind: Signal<Banner>,
    /// The copied message or code block, for a moment.
    copied: Signal<Option<String>>,
    copy_timer: Stored<Option<Spawned<()>>>,
    /// Whether the user is at the bottom (the list then follows the
    /// stream natively); scrolling up clears it.
    following: Signal<bool>,
    dragging: Stored<bool>,
    list: Stored<ElementRef>,
    run: Stored<Option<Run>>,
    live: Live,
    offline: Stored<Option<Spawned<()>>>,
    settle: Stored<Option<Spawned<()>>>,
}

impl ChatState {
    fn next_id(self) -> String {
        self.ids.with(|ids| {
            *ids += 1;
            format!("m{}", *ids - 1)
        })
    }

    fn running(self) -> bool {
        self.run.with(|run| run.is_some())
    }

    /// Scrolls to the end on the user's own action (send, jump, load).
    fn scroll_to_end(self, animated: bool) {
        self.following.set(true);
        self.list.with(|list| list.scroll_to_end(animated));
    }

    /// Streams `text` at about `rate` tokens a second, with jitter.
    async fn stream(self, text: &str, rate: f64, into: Stream) {
        let mut random = Jitter::new();
        for token in tokens(text) {
            let delay = 1.0 / rate * (0.55 + random.next() * 0.9);
            timer(Duration::from_secs_f64(delay)).await;
            self.token(token, into);
        }
        self.flush();
    }

    /// The streamed tokens so far reach the live reply.
    fn flush(self) {
        let update = self.run.with(|run| {
            let run = run.as_mut()?;
            let frame = run.frame.take();
            let reason = !run.pending_reason.is_empty();
            let text = !run.pending_text.is_empty();
            if !reason && !text {
                return Some((frame, None, None));
            }
            run.reason
                .push_str(&std::mem::take(&mut run.pending_reason));
            run.md.push_str(&std::mem::take(&mut run.pending_text));
            Some((
                frame,
                reason.then(|| run.reason.clone()),
                text.then(|| run.md.clone()),
            ))
        });
        let Some((frame, reason, md)) = update else {
            return;
        };
        if let Some(frame) = frame {
            frame.cancel();
        }
        let live = self.live;
        batch(|| {
            if let Some(reason) = reason {
                live.reason.set(reason);
            }
            if let Some(md) = md {
                live.md.set(md);
            }
        });
    }

    /// A token arrives: it shows with the next frame.
    fn token(self, token: String, into: Stream) {
        let queue = self.run.with(|run| {
            let Some(run) = run.as_mut() else {
                return false;
            };
            match into {
                Stream::Text => run.pending_text.push_str(&token),
                Stream::Reason => run.pending_reason.push_str(&token),
            }
            run.frame.is_none()
        });
        if queue {
            let frame = self
                .owner
                .run(|| request_animation_frame(move |_| self.flush()));
            self.run.with(|run| {
                if let Some(run) = run.as_mut() {
                    run.frame = Some(frame);
                }
            });
        }
    }

    /// Freezes the reply into a message and ends the run.
    fn freeze(self, status: Status, error: Option<&'static str>) {
        let Some(mut run) = self.run.replace(None) else {
            return;
        };
        // From its own steps too: a task cancelled while it runs ends
        // once it yields.
        run.cancel();
        run.md.push_str(&run.pending_text);
        run.reason.push_str(&run.pending_reason);
        let seconds = run
            .think_seconds
            .unwrap_or_else(|| (run.think_start.elapsed().as_secs_f64().round() as u64).max(1));
        let tools = self
            .live
            .tools
            .get_untracked()
            .into_iter()
            .map(|t| {
                if t.state == ToolState::Done {
                    t
                } else {
                    Tool {
                        state: ToolState::Cancelled,
                        ..t
                    }
                }
            })
            .collect();
        let reply = Assistant {
            id: run.id.clone(),
            model: run.model,
            script: run.script,
            reasoning: (!run.reason.is_empty()).then(|| Reasoning {
                text: run.reason.clone(),
                seconds,
                open: false,
            }),
            tools,
            md: run.md.clone(),
            status,
            error,
            rating: None,
        };
        animate_layout(LayoutAnimation::EASE_IN_EASE_OUT);
        batch(|| {
            self.messages.update(|messages| {
                if let Some(m) = messages.iter_mut().find(|m| m.id() == reply.id) {
                    *m = Msg::Assistant(reply);
                }
            });
            self.live.id.set(None);
        });
        // The list follows the final layout natively; once the layout
        // animation has settled, a following list ends exactly at the
        // bottom.
        let (following, list) = (self.following, self.list);
        keep(
            self.settle,
            self.owner.run(|| {
                set_timeout(Duration::from_millis(360), move || {
                    if following.get_untracked() {
                        list.with(|list| list.scroll_to_end(true));
                    }
                })
            }),
        );
    }

    /// Runs a scenario's reply; `at` replaces that message (retry,
    /// regenerate).
    fn reply(self, s: Scenario, at: Option<String>) {
        let id = self.next_id();
        let placeholder = Assistant {
            id: id.clone(),
            model: s.model,
            script: s.id,
            reasoning: None,
            tools: Vec::new(),
            md: String::new(),
            status: Status::Done,
            error: None,
            rating: None,
        };
        animate_layout(LayoutAnimation::EASE_IN_EASE_OUT);
        let live = self.live;
        batch(|| {
            live.reason.set(String::new());
            live.thinking.set(None);
            live.tools.set(Vec::new());
            live.md.set(String::new());
            live.now.set(None);
            live.id.set(Some(id.clone()));
            self.messages.update(|messages| match at {
                Some(at) => {
                    if let Some(m) = messages.iter_mut().find(|m| m.id() == at) {
                        *m = Msg::Assistant(placeholder);
                    }
                }
                None => messages.push(Msg::Assistant(placeholder)),
            });
        });
        let steps = s.steps;
        let task = self.owner.run(|| {
            spawn(async move {
                let wait = |ms: u64| timer(Duration::from_millis(ms));
                wait(450).await;
                for step in steps {
                    match step {
                        Step::Think(text) => {
                            let now = Instant::now();
                            let ticker = self.owner.run(|| {
                                set_interval(Duration::from_secs(1), move || {
                                    live.now.set(Some(Instant::now()));
                                })
                            });
                            self.run.with(|run| {
                                if let Some(run) = run.as_mut() {
                                    run.think_start = now;
                                    run.ticker = Some(ticker);
                                }
                            });
                            batch(|| {
                                live.thinking.set(Some((now, None)));
                                live.now.set(Some(now));
                            });
                            self.stream(&text, 75.0, Stream::Reason).await;
                            let ended = self.run.with(|run| {
                                let run = run.as_mut()?;
                                let ticker = run.ticker.take();
                                let seconds =
                                    (run.think_start.elapsed().as_secs_f64().round() as u64).max(1);
                                run.think_seconds = Some(seconds);
                                Some((ticker, run.think_start, seconds))
                            });
                            if let Some((ticker, start, seconds)) = ended {
                                if let Some(ticker) = ticker {
                                    ticker.cancel();
                                }
                                live.thinking.set(Some((start, Some(seconds))));
                            }
                            wait(350).await;
                        }
                        Step::Tool(tool, ms) => {
                            let id = tool.id;
                            let set = move |state: ToolState| {
                                if state == ToolState::Done {
                                    animate_layout(LayoutAnimation::EASE_IN_EASE_OUT);
                                }
                                live.tools.update(|tools| {
                                    if let Some(t) = tools.iter_mut().find(|t| t.id == id) {
                                        t.state = state;
                                    }
                                });
                            };
                            live.tools.update(|tools| {
                                tools.push(Tool {
                                    state: ToolState::Pending,
                                    ..tool
                                });
                            });
                            wait(450).await;
                            set(ToolState::Running);
                            wait(ms).await;
                            set(ToolState::Done);
                            wait(400).await;
                        }
                        Step::Say(text) => self.stream(&text, 40.0, Stream::Text).await,
                        Step::Fail(error) => {
                            wait(900).await;
                            self.freeze(Status::Error, Some(error));
                            return;
                        }
                        Step::Offline(_) => {}
                    }
                }
                self.freeze(Status::Done, None);
            })
        });
        let run = Run {
            id,
            model: s.model,
            script: s.id,
            md: String::new(),
            reason: String::new(),
            think_start: Instant::now(),
            think_seconds: None,
            pending_text: String::new(),
            pending_reason: String::new(),
            frame: None,
            ticker: None,
            task: Some(task),
        };
        // A reply started while another waited for the connection ends it.
        if let Some(mut old) = self.run.replace(Some(run)) {
            old.cancel();
        }
    }

    fn stop(self) {
        // Its tasks end with it.
        self.freeze(Status::Stopped, None);
    }

    /// Sends the user's message for a scenario, then its reply.
    fn submit(self, s: Scenario, text: String, image: Option<&'static str>, file: Option<FileRef>) {
        if self.running() {
            return;
        }
        self.menu.set(false);
        self.following.set(true);
        let offline = s.steps.iter().find_map(|step| match step {
            Step::Offline(ms) => Some(*ms),
            _ => None,
        });
        let user_id = self.next_id();
        let user = Msg::User {
            id: user_id.clone(),
            text,
            image,
            file,
            waiting: offline.is_some(),
        };
        animate_layout(LayoutAnimation::EASE_IN_EASE_OUT);
        let date = self
            .messages
            .with_untracked(Vec::is_empty)
            .then(|| Msg::Date {
                id: self.next_id(),
                label: "Today",
            });
        batch(|| {
            self.messages.update(|messages| {
                messages.extend(date);
                messages.push(user);
            });
            self.draft.set(String::new());
            self.attachment.set(false);
            self.model.set(s.model);
        });
        self.scroll_to_end(true);
        let rest = Scenario {
            steps: s
                .steps
                .iter()
                .filter(|step| !matches!(step, Step::Offline(_)))
                .cloned()
                .collect(),
            ..s
        };
        match offline {
            Some(ms) => {
                batch(|| {
                    self.banner_kind.set(Banner::Offline);
                    self.banner.set(true);
                });
                let task = self.owner.run(|| {
                    spawn(async move {
                        timer(Duration::from_millis(ms)).await;
                        batch(|| {
                            self.banner_kind.set(Banner::Online);
                            self.messages.update(|messages| {
                                if let Some(Msg::User { waiting, .. }) =
                                    messages.iter_mut().find(|m| m.id() == user_id)
                                {
                                    *waiting = false;
                                }
                            });
                        });
                        timer(Duration::from_millis(900)).await;
                        self.banner.set(false);
                        self.reply(rest, None);
                    })
                });
                keep(self.offline, task);
            }
            None => self.reply(rest, None),
        }
    }

    fn send(self) {
        let text = self.draft.with_untracked(|d| d.trim().to_owned());
        let attachment = self.attachment.get_untracked();
        if text.is_empty() && !attachment {
            return;
        }
        let model = self.model.get_untracked();
        if attachment {
            let vision = scenarios()
                .into_iter()
                .find(|s| s.id == "vision")
                .expect("the vision scenario");
            let model = if model == Model::Swift {
                Model::Vision
            } else {
                model
            };
            let prompt = if text.is_empty() {
                vision.prompt.to_owned()
            } else {
                text
            };
            self.submit(
                Scenario { model, ..vision },
                prompt,
                Some(PHOTO),
                Some(NOTES),
            );
        } else {
            let s = freeform(&text, model);
            self.submit(s, text, None, None);
        }
    }

    fn play(self, id: &str) {
        if id == "history" {
            self.menu.set(false);
            let mut older = history(|| self.next_id());
            self.messages.update(|messages| {
                older.append(messages);
                *messages = older;
            });
            self.scroll_to_end(false);
            return;
        }
        let Some(s) = scenarios().into_iter().find(|s| s.id == id) else {
            return;
        };
        let (prompt, image, file) = (s.prompt.to_owned(), s.image, s.file.clone());
        self.submit(s, prompt, image, file);
    }

    fn prompt_before(self, id: &str) -> String {
        self.messages.with_untracked(|messages| {
            let at = messages.iter().position(|m| m.id() == id).unwrap_or(0);
            messages[..at]
                .iter()
                .rev()
                .find_map(|m| match m {
                    Msg::User { text, .. } => Some(text.clone()),
                    _ => None,
                })
                .unwrap_or_default()
        })
    }

    fn assistant(self, id: &str) -> Option<Assistant> {
        self.messages.with_untracked(|messages| {
            messages.iter().find_map(|m| match m {
                Msg::Assistant(a) if a.id == id => Some(a.clone()),
                _ => None,
            })
        })
    }

    fn update_assistant(self, id: &str, f: impl FnOnce(&mut Assistant)) {
        self.messages.update(|messages| {
            if let Some(Msg::Assistant(a)) = messages.iter_mut().find(|m| m.id() == id) {
                f(a);
            }
        });
    }

    fn act(self, action: Action) {
        match action {
            Action::Copy(key, text) => {
                set_clipboard(text);
                self.copied.set(Some(key.clone()));
                let copied = self.copied;
                let timer = self.owner.run(|| {
                    set_timeout(Duration::from_millis(1600), move || {
                        if copied.with_untracked(|c| c.as_deref() == Some(key.as_str())) {
                            copied.set(None);
                        }
                    })
                });
                keep(self.copy_timer, timer);
            }
            Action::Regenerate(id) => {
                if self.running() {
                    return;
                }
                let Some(m) = self.assistant(&id) else {
                    return;
                };
                self.following.set(true);
                let s = if m.script == "retry" {
                    retried()
                } else {
                    scenarios()
                        .into_iter()
                        .find(|s| s.id == m.script)
                        .unwrap_or_else(|| freeform(&self.prompt_before(&id), m.model))
                };
                let steps = s
                    .steps
                    .iter()
                    .filter(|step| !matches!(step, Step::Offline(_) | Step::Fail(_)))
                    .cloned()
                    .collect();
                self.reply(
                    Scenario {
                        model: m.model,
                        steps,
                        ..s
                    },
                    Some(id),
                );
            }
            Action::Retry(id) => {
                if self.running() {
                    return;
                }
                self.following.set(true);
                self.reply(retried(), Some(id));
            }
            Action::Rate(id, rating) => {
                self.update_assistant(&id, |a| {
                    a.rating = if a.rating == Some(rating) {
                        None
                    } else {
                        Some(rating)
                    };
                });
            }
            Action::Reasoning(id) => {
                animate_layout(LayoutAnimation::EASE_IN_EASE_OUT);
                self.update_assistant(&id, |a| {
                    if let Some(r) = a.reasoning.as_mut() {
                        r.open = !r.open;
                    }
                });
            }
        }
    }
}

/// The chat: the conversation, the menu, the banner and the composer; in
/// the desktop layout, the scenarios as conversations beside them.
#[component]
pub(crate) fn Chat(cx: Scope<NoEvent>) -> impl IntoElement {
    // The shell is made again when the layout changes: read once.
    let wide = untracked(desktop);
    let list = element_ref();
    let chat = ChatState {
        owner: Owner::current(),
        ids: stored(0),
        messages: signal(Vec::new()),
        model: signal(Model::Swift),
        draft: signal(String::new()),
        input_height: signal(20.0),
        attachment: signal(false),
        menu: signal(false),
        banner: signal(false),
        banner_kind: signal(Banner::Offline),
        copied: signal(None),
        copy_timer: stored(None),
        following: signal(true),
        dragging: stored(false),
        list: stored(list),
        run: stored(None),
        live: Live {
            id: signal(None),
            reason: signal(String::new()),
            thinking: signal(None),
            tools: signal(Vec::new()),
            md: signal(String::new()),
            now: signal(None),
        },
        offline: stored(None),
        settle: stored(None),
    };
    let ChatState {
        messages,
        model,
        draft,
        input_height,
        attachment,
        menu,
        banner_kind,
        following,
        ..
    } = chat;
    // The jump button, the menu and the banner: 0 hidden, 1 shown; they
    // spring natively as their state changes.
    let [jump, menu_value, banner_value] = [0.0; 3].map(animated_value);
    spring_on(jump, move || !following.get());
    spring_on(menu_value, move || menu.get());
    spring_on(banner_value, move || chat.banner.get());
    let streaming = computed(move || chat.live.id.with(Option::is_some));
    let chips: Rc<[(&'static str, &'static str)]> = scenarios()
        .iter()
        .map(|s| (s.id, s.chip))
        .chain([("history", "Load a long conversation")])
        .collect();
    let conversations = chips.clone();

    // One selection across messages: in the list, over the rows that are
    // mounted.
    let content = when(
        move || !messages.with(Vec::is_empty),
        move || {
            view()
                .selectable(true)
                .flex_1()
                .child(chat.list_view(list, wide))
        },
    )
    .otherwise(move || chat.empty());

    // Jump to the latest message: shown, and taking touches, while scrolled
    // up.
    let jump_button = view()
        .pointer_events(move || {
            if following.get() {
                PointerEvents::None
            } else {
                PointerEvents::Auto
            }
        })
        .absolute()
        .right_4()
        .bottom_3()
        .bind_opacity(&jump)
        .bind_scale(&jump.interpolate(&[0.0, 1.0], &[0.7, 1.0]))
        .child(
            RoundButton::new(
                IconName::ArrowDown,
                "Jump to the latest message",
                move |_: &()| chat.scroll_to_end(true),
            )
            .secondary(),
        )
        .child(when(streaming, || {
            view()
                .absolute()
                .top(px(2.0))
                .right(px(2.0))
                .size(px(10.0))
                .rounded(px(5.0))
                .bg(colors::ACCENT)
                .border_2()
                .border_color(colors::BACKGROUND)
        }));

    // The connection banner.
    let offline = computed(move || banner_kind.get() == Banner::Offline);
    let banner_tone = move || if offline.get() { Tone::Warn } else { Tone::Up };
    let banner = view()
        .pointer_events(PointerEvents::None)
        .absolute()
        .top_2()
        .left_4()
        .right_4()
        .bind_opacity(&banner_value)
        .bind_translate_y(&banner_value.interpolate(&[0.0, 1.0], &[-64.0, 0.0]))
        .child(
            view()
                .flex_row()
                .items_center()
                .gap_3()
                .min_h(px(48.0))
                .px(px(14.0))
                .rounded(px(radius::INSET))
                .border_curve(BorderCurve::Continuous)
                .finish(Finish::Menu)
                .border_1()
                .border_color(move || banner_tone().color().opacity(0.35))
                .child(
                    view()
                        .size(px(28.0))
                        .rounded(px(14.0))
                        .items_center()
                        .justify_center()
                        .bg(move || banner_tone().tint())
                        .child(
                            glyph()
                                .name(move || {
                                    if offline.get() {
                                        GlyphName::Offline
                                    } else {
                                        GlyphName::Check
                                    }
                                })
                                .size(15.0)
                                .tint(move || banner_tone().color()),
                        ),
                )
                .child(
                    view()
                        .flex_1()
                        .gap(px(1.0))
                        .child(
                            text(move || {
                                if offline.get() {
                                    "You're offline"
                                } else {
                                    "Back online"
                                }
                            })
                            .text_size(px(14.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(colors::TEXT),
                        )
                        .child(
                            text(move || {
                                if offline.get() {
                                    "Your message sends when the connection returns."
                                } else {
                                    "Sending your message."
                                }
                            })
                            .text_size(px(13.0))
                            .text_color(colors::MUTED),
                        ),
                ),
        );

    // The "+" menu: attachments and the scenarios, to replay them. The
    // backdrop and the menu take touches while it is open.
    let pointer = move || {
        if menu.get() {
            PointerEvents::Auto
        } else {
            PointerEvents::None
        }
    };
    let backdrop = view()
        .pointer_events(pointer)
        .on_press(move || menu.set(false))
        .absolute()
        .inset_0()
        .bg(rgb_a(0x000000, 0.45))
        .bind_opacity(&menu_value);
    let menu_view = chat.menu_view(pointer, &menu_value, &chips);

    // Suggestions while the conversation is empty.
    let suggestions = when(
        move || messages.with(Vec::is_empty),
        move || {
            scroll()
                .horizontal()
                .scrollbar(false)
                .keyboard_taps(KeyboardTaps::Handled)
                .flex_grow(0.0)
                .child(
                    view()
                        .flex_row()
                        .gap_2()
                        .px_4()
                        .py_2()
                        .children(chips.iter().map(|&(id, label)| {
                            press()
                                .hit_slop(4.0)
                                .label(label)
                                .on_press(move || chat.play(id))
                                .child(
                                    view()
                                        .h(px(36.0))
                                        .px(px(14.0))
                                        .rounded(px(18.0))
                                        .justify_center()
                                        .finish(Finish::Pill)
                                        .border_1()
                                        .child(
                                            text(label)
                                                .text_size(px(13.0))
                                                .font_weight(FontWeight::MEDIUM)
                                                .text_color(colors::TEXT),
                                        ),
                                )
                        })),
                )
        },
    );

    // The composer.
    let can_send = computed(move || !draft.with(|d| d.trim().is_empty()) || attachment.get());
    let send_button = move || {
        view()
            .opacity(move || if can_send.get() { 1.0_f32 } else { 0.35 })
            .pointer_events(move || {
                if can_send.get() {
                    PointerEvents::Auto
                } else {
                    PointerEvents::None
                }
            })
            .child(RoundButton::new(
                IconName::ArrowUp,
                "Send",
                move |_: &()| chat.send(),
            ))
    };
    let composer = view()
        .when(wide, column)
        .px_4()
        .pt_2()
        .pb(move || {
            px(8.0
                + if keyboard_height() > px(0.0) {
                    0.0
                } else {
                    cx.insets().bottom.0
                })
        })
        .gap_2()
        .child(when(attachment, move || {
            appear().index(0).child(
                view()
                    .flex_row()
                    .items_center()
                    .gap_2()
                    .child(photo(PHOTO, 48.0, 48.0))
                    .child(view().flex_1().child(file_chip(
                        &NOTES,
                        Some((move |_: &()| attachment.set(false)).into()),
                    ))),
            )
        }))
        .child(
            view()
                .rounded(px(24.0))
                .border_curve(BorderCurve::Continuous)
                // Glass like the menu above it, without the blur: nothing
                // scrolls under it.
                .finish_fill(Finish::Menu)
                .finish_shadow(Finish::Menu)
                .when_some(Finish::Menu.border_color(), |v, c| v.border_color(c))
                .border_1()
                .p(px(6.0))
                .gap_1()
                .child(
                    input()
                        .value(move || draft.get())
                        .multiline(true)
                        // Return sends on desktops, as in chat apps there
                        // (Shift+Return adds a line); phones keep return for
                        // line breaks.
                        .submit_behavior(if is_desktop() {
                            SubmitBehavior::Submit
                        } else {
                            SubmitBehavior::Newline
                        })
                        .on_submit(move |_: &str| {
                            if !streaming.get_untracked() {
                                chat.send();
                            }
                        })
                        .placeholder(move || format!("Message {}", model.get().name()))
                        .placeholder_color(|| color(colors::FAINT))
                        .selection_color(|| color(colors::ACCENT))
                        .on_focus(move || menu.set(false))
                        .on_content_size_change(move |size: &Size<Points>| {
                            input_height.set((size.height.clamp(px(20.0), px(100.0))).0);
                        })
                        .on_change(move |text: &str| draft.set(text.to_owned()))
                        .h(move || px(input_height.get() + 20.0))
                        .text_size(px(15.0))
                        .line_height(px(20.0))
                        .text_color(colors::TEXT)
                        .px(px(10.0))
                        .py(px(10.0)),
                )
                .child(
                    view()
                        .flex_row()
                        .items_center()
                        .gap_2()
                        .child(
                            view()
                                .style_with(move |s| {
                                    s.rotate(deg(if menu.get() { 45.0 } else { 0.0 }))
                                })
                                .transition_transform()
                                .duration(200.0)
                                .ease_out()
                                .child(
                                    RoundButton::new(IconName::Plus, "Add", move |_: &()| {
                                        menu.update(|m| *m = !*m);
                                    })
                                    .secondary(),
                                ),
                        )
                        .child(
                            view().flex_1().child(
                                segmented()
                                    .options(
                                        MODELS
                                            .iter()
                                            .map(|m| Segment::new(m.name()))
                                            .collect::<Vec<_>>(),
                                    )
                                    .selected(move || {
                                        let model = model.get();
                                        MODELS.iter().position(|m| *m == model).unwrap_or(0) as u32
                                    })
                                    .size(SegmentedSize::Small)
                                    .on_change(move |&i: &u32| {
                                        model.set(MODELS[i as usize]);
                                    }),
                            ),
                        )
                        .child(
                            when(streaming, move || {
                                press()
                                    .scale(0.9)
                                    .label("Stop generating")
                                    .on_press(move || chat.stop())
                                    .child(
                                        view()
                                            .size(px(44.0))
                                            .rounded(px(22.0))
                                            .items_center()
                                            .justify_center()
                                            .bg(colors::LIGHT)
                                            .finish(Finish::Light)
                                            .child(
                                                glyph()
                                                    .name(GlyphName::Stop)
                                                    .size(16.0)
                                                    .tint(colors::ON_LIGHT),
                                            ),
                                    )
                            })
                            .otherwise(send_button),
                        ),
                ),
        );

    let pane = view().flex_1().bg(colors::BACKGROUND).child(
        view()
            .pb_keyboard()
            .flex_1()
            .child(
                view()
                    .flex_1()
                    .child(content)
                    .child(jump_button)
                    .child(banner)
                    .child(backdrop)
                    .child(menu_view),
            )
            .child(suggestions)
            .child(composer),
    );
    if !wide {
        return pane;
    }

    // Desktop: the scenarios as conversations, each opened afresh.
    let current = signal(None::<&'static str>);
    let new_chat = move || {
        chat.stop();
        batch(|| {
            messages.set(Vec::new());
            attachment.set(false);
            menu.set(false);
            current.set(None);
        });
    };
    let open_chat = move |id: &'static str| {
        new_chat();
        current.set(Some(id));
        chat.play(id);
    };
    let all = scenarios();
    // TS: `bg-accent` when selected, `hover:bg-card active:bg-accent`
    // otherwise (the gallery theme's tokens).
    let fill = AdaptiveColor::new(colors::BORDER.light, colors::RAISED.dark);
    let rows = conversations.iter().map(|&(id, label)| {
        let selected = move || current.get() == Some(id);
        let prompt = all
            .iter()
            .find(|s| s.id == id)
            .map_or("Weeks of messages, loaded at once", |s| s.prompt);
        view()
            .on_press(move || open_chat(id))
            .role(AccessibilityRole::Button)
            .label(label)
            .accessibility_state(move || AccessibilityState {
                selected: selected(),
                ..AccessibilityState::default()
            })
            .style_when(selected, |s| s.bg(fill))
            .hover(|s| s.bg(move || if selected() { fill } else { colors::SURFACE }))
            .active(|s| s.bg(fill))
            .px_3()
            .py(px(9.0))
            .rounded(px(radius::CONTROL))
            .gap(px(2.0))
            .cursor_pointer()
            .child(
                text(label)
                    .number_of_lines(1)
                    .text_size(px(14.0))
                    .style_when(selected, |s| s.font_weight(FontWeight::SEMIBOLD))
                    .text_color(colors::TEXT),
            )
            .child(
                text(prompt)
                    .number_of_lines(1)
                    .text_size(px(12.0))
                    .text_color(colors::MUTED),
            )
    });
    let sidebar = view()
        .w(px(280.0))
        .border_r_1()
        .border_r_color(colors::LINE)
        .p_3()
        .gap(px(2.0))
        .child(
            press().label("New chat").on_press(new_chat).child(
                view()
                    .h(px(40.0))
                    .rounded(px(radius::CONTROL))
                    .border_curve(BorderCurve::Continuous)
                    .flex_row()
                    .items_center()
                    .justify_center()
                    .gap_2()
                    .bg(colors::RAISED)
                    .finish(Finish::Raised)
                    .border_1()
                    .border_color(colors::BORDER)
                    .cursor_pointer()
                    .child(icon().name(IconName::Plus).size(15.0).tint(colors::TEXT))
                    .child(
                        text("New chat")
                            .text_size(px(14.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(colors::TEXT),
                    ),
            ),
        )
        .child(
            text("CONVERSATIONS")
                .text_size(px(11.0))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(colors::FAINT)
                .letter_spacing(px(0.6))
                .px_3()
                .pt(px(18.0))
                .pb(px(6.0)),
        )
        .children(rows);
    view()
        .flex_1()
        .flex_row()
        .bg(colors::BACKGROUND)
        .child(sidebar)
        .child(pane)
}

impl ChatState {
    /// The "+" menu, taking touches with `pointer`.
    fn menu_view(
        self,
        pointer: impl IntoReactive<PointerEvents>,
        shown: &AnimatedValue,
        chips: &[(&'static str, &'static str)],
    ) -> View {
        let rows = std::iter::once(("attach", GlyphName::Clip, "Attach a photo and a file"))
            .chain(
                chips
                    .iter()
                    .map(|&(id, label)| (id, GlyphName::Regenerate, label)),
            )
            .enumerate()
            .map(|(i, (id, name, label))| {
                view()
                    .on_press(move || {
                        self.menu.set(false);
                        if id == "attach" {
                            self.attachment.set(true);
                        } else {
                            self.play(id);
                        }
                    })
                    .active(|s| s.bg(colors::TEXT.opacity(0.06)))
                    .role(AccessibilityRole::Button)
                    .label(label)
                    .flex_row()
                    .items_center()
                    .gap_3()
                    .h(px(48.0))
                    .px_4()
                    .child(glyph().name(name).size(16.0).tint(if i == 0 {
                        colors::ACCENT
                    } else {
                        colors::MUTED
                    }))
                    .child(
                        text(label)
                            .flex_1()
                            .text_size(px(15.0))
                            .text_color(colors::TEXT),
                    )
            })
            .collect::<Vec<_>>();
        view()
            .pointer_events(pointer)
            .absolute()
            .left_4()
            .right_4()
            .bottom_2()
            .bind_opacity(shown)
            .bind_translate_y(&shown.interpolate(&[0.0, 1.0], &[24.0, 0.0]))
            .bind_scale(&shown.interpolate(&[0.0, 1.0], &[0.97, 1.0]))
            .child(
                view()
                    .rounded(px(radius::CARD))
                    .border_curve(BorderCurve::Continuous)
                    .finish(Finish::Menu)
                    .border_1()
                    .py(px(6.0))
                    .max_h(px(460.0))
                    .overflow_hidden()
                    .child(
                        text("ADD AND REPLAY")
                            .text_size(px(12.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(colors::FAINT)
                            .px_4()
                            .pt_2()
                            .pb_1(),
                    )
                    .child(scroll().flex_grow(0.0).children(rows)),
            )
    }

    /// The empty conversation: a greeting and four features.
    fn empty(self) -> View {
        let all = scenarios();
        view()
            .flex_1()
            .justify_center()
            .px_4()
            .py_6()
            .gap_6()
            .child(
                appear().index(0).child(
                    view()
                        .items_center()
                        .gap_3()
                        .child(IconTile::new(IconName::Spark).tint(colors::ACCENT).size(56.0))
                        .child(
                            text("How can I help?")
                                .text_size(px(22.0))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(colors::TEXT),
                        )
                        .child(
                            text("A simulated assistant: every reply is scripted and streamed locally.")
                                .text_size(px(15.0))
                                .line_height(px(21.0))
                                .text_color(colors::MUTED)
                                .text_center(),
                        ),
                ),
            )
            .child(view().flex_row().flex_wrap().gap_3().children(
                FEATURED.iter().enumerate().map(|(i, &(id, name, note))| {
                    let chip = all.iter().find(|s| s.id == id).map_or("", |s| s.chip);
                    view().w(relative(0.47)).flex_grow(1.0).child(
                        appear().index(i as u32 + 1).child(
                            press().label(chip).on_press(move || self.play(id))
                            .child(
                                view()
                                    .min_h(px(104.0))
                                    .p_3()
                                    .gap_2()
                                    .rounded(px(radius::INSET))
                                    .border_curve(BorderCurve::Continuous)
                                    .bg(colors::SURFACE)
                                    .finish(Finish::Card)
                                    .border_1()
                                    .border_color(colors::BORDER)
                                    .child(icon().name(name).size(18.0).tint(colors::ACCENT))
                                    .child(
                                        text(chip)
                                            .text_size(px(14.0))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .text_color(colors::TEXT),
                                    )
                                    .child(
                                        text(note)
                                            .text_size(px(12.0))
                                            .text_color(colors::MUTED),
                                    ),
                            ),
                        ),
                    )
                }),
            ))
    }

    /// The conversation, virtualized: a cell binds to the message it shows,
    /// and is made again only when it shows another kind of message. `wide`
    /// (the desktop layout) keeps the rows in a centered column.
    fn list_view(self, list: ElementRef, wide: bool) -> VirtualList {
        let messages = self.messages;
        let count = messages.with_untracked(Vec::len);
        let (following, dragging) = (self.following, self.dragging);
        virtual_list(
            move || messages.with(Vec::len),
            move |at: Position| {
                let item = computed(move || messages.with(|m| m.get(at.index()).cloned()));
                let kind = computed(move || item.with(|m| m.as_ref().map(RowKind::of)));
                view().when(wide, column).child(dynamic(move || {
                    let kind = kind.get()?;
                    Some(untracked(|| match kind {
                        RowKind::Date => date_separator(move || {
                            item.with(|m| match m {
                                Some(Msg::Date { label, .. }) => *label,
                                _ => "",
                            })
                        }),
                        RowKind::User => user_row(item),
                        RowKind::Assistant => self.assistant_row(item),
                    }))
                }))
            },
        )
        .keys(move || messages.with(|m| m.iter().map(|m| m.id().to_owned()).collect::<Vec<_>>()))
        .estimated_item_size(px(140.0))
        .initial_scroll_index(count.saturating_sub(1))
        .flex_1()
        .content_padding_top(px(8.0))
        .content_padding_bottom(px(16.0))
        .keyboard_dismiss_mode(KeyboardDismissMode::Interactive)
        .follow_end(px(40.0))
        .event_throttle(100.0)
        .element_ref(&list)
        .on_scroll_drag_start(move |_: &Point<Points>| {
            dragging.replace(true);
        })
        .on_scroll(move |e: &ScrollEvent| {
            if dragging.get() {
                following.set(e.offset.y + e.size.height >= e.content_size.height - px(40.0));
            }
        })
        .on_momentum_end(move |_: &Point<Points>| {
            dragging.replace(false);
        })
        .on_scroll_end(move |_: &Point<Points>| {
            dragging.replace(false);
        })
    }

    /// A reply, finished or being written ([`Live`] while its id is the
    /// live one).
    fn assistant_row(self, item: Item) -> View {
        let (live, copied) = (self.live, self.copied);
        let id = computed(move || with_reply(item, |a| a.id.clone()).unwrap_or_default());
        let is_live = computed(move || {
            let id = id.get();
            live.id.with(|l| l.as_deref() == Some(id.as_str()))
        });
        let status = computed(move || with_reply(item, |a| a.status).unwrap_or(Status::Done));
        let model = computed(move || with_reply(item, |a| a.model).unwrap_or_default());
        let done =
            move |status_is: fn(Status) -> bool| move || !is_live.get() && status_is(status.get());
        let stopped = computed(done(|s| s == Status::Stopped));
        // The reasoning: the live one while it streams (open), else the
        // reply's.
        let reasoned = computed(move || {
            if is_live.get() {
                !live.reason.with(String::is_empty)
            } else {
                with_reply(item, |a| a.reasoning.is_some()) == Some(true)
            }
        });
        let open = computed(move || {
            is_live.get()
                || with_reply(item, |a| a.reasoning.as_ref().is_some_and(|r| r.open)) == Some(true)
        });
        let thinking_now = computed(move || {
            is_live.get() && live.thinking.with(|t| t.is_some_and(|(_, s)| s.is_none()))
        });
        let label = move || {
            if !is_live.get() {
                let seconds =
                    with_reply(item, |a| a.reasoning.as_ref().map(|r| r.seconds)).flatten();
                return format!("Thought for {} s", seconds.unwrap_or(1));
            }
            match live.thinking.get() {
                Some((start, None)) => {
                    let now = live.now.get().unwrap_or(start);
                    format!(
                        "Thinking… {} s",
                        now.saturating_duration_since(start).as_secs()
                    )
                }
                Some((_, Some(seconds))) => format!("Thought for {seconds} s"),
                None => "Thought for 1 s".into(),
            }
        };
        let reason = move || {
            if is_live.get() {
                live.reason.get()
            } else {
                with_reply(item, |a| a.reasoning.as_ref().map(|r| r.text.clone()))
                    .flatten()
                    .unwrap_or_default()
            }
        };
        let waiting = computed(move || {
            is_live.get()
                && live.md.with(String::is_empty)
                && live.tools.with(Vec::is_empty)
                && !thinking_now.get()
        });
        let act =
            move |action: fn(String) -> Action| move |_: &()| self.act(action(id.get_untracked()));
        let copied_reply = Prop::bind(move || {
            let id = id.get();
            copied.with(|c| c.as_deref() == Some(id.as_str()))
        });
        let rating = computed(move || with_reply(item, |a| a.rating).flatten());
        view()
            .px_4()
            .pt_2()
            .pb_1()
            .gap_3()
            .child(reply_header(model, stopped))
            .child(when(reasoned, move || {
                view()
                    .gap_2()
                    .child(
                        press()
                            .scale(0.98)
                            .label("Reasoning")
                            .selected(open)
                            .on_press(move || {
                                if !is_live.get_untracked() {
                                    self.act(Action::Reasoning(id.get_untracked()));
                                }
                            })
                            .child(reasoning_toggle(label, thinking_now, open)),
                    )
                    .child(when(open, move || reasoning_text(reason)))
            }))
            .child(each(
                move || {
                    if is_live.get() {
                        live.tools.get()
                    } else {
                        with_reply(item, |a| a.tools.clone()).unwrap_or_default()
                    }
                },
                |t: &Tool| t.id,
                |tool, _| tool_card(tool),
            ))
            .child(when(waiting, || {
                view().flex_row().h(px(22.0)).items_center().child(caret())
            }))
            .child(markdown(
                move || {
                    if is_live.get() {
                        live.md.get()
                    } else {
                        with_reply(item, |a| a.md.clone()).unwrap_or_default()
                    }
                },
                move || is_live.get(),
            ))
            .child(when(done(|s| s == Status::Error), move || {
                error_row(
                    move || {
                        with_reply(item, |a| a.error)
                            .flatten()
                            .unwrap_or("Something went wrong.")
                    },
                    act(Action::Retry),
                )
            }))
            .child(when(stopped, || {
                view()
                    .flex_row()
                    .items_center()
                    .gap_2()
                    .child(glyph().name(GlyphName::Stop).size(12.0).tint(colors::FAINT))
                    .child(
                        text("You stopped this reply")
                            .text_size(px(13.0))
                            .text_color(colors::FAINT),
                    )
            }))
            .child(when(done(|s| s != Status::Error), move || {
                view()
                    .flex_row()
                    .items_center()
                    .ml(px(-8.0))
                    .mt(px(-6.0))
                    .child(action_button(
                        Prop::bind(move || {
                            if copied_reply.get() {
                                GlyphName::Check
                            } else {
                                GlyphName::Copy
                            }
                        }),
                        "Copy",
                        copied_reply,
                        Tone::Up,
                        move |_: &()| {
                            let md = untracked(|| with_reply(item, |a| a.md.clone()));
                            self.act(Action::Copy(id.get_untracked(), md.unwrap_or_default()));
                        },
                    ))
                    .child(action_button(
                        GlyphName::Regenerate,
                        "Regenerate",
                        false.into(),
                        Tone::Accent,
                        act(Action::Regenerate),
                    ))
                    .child(action_button(
                        GlyphName::ThumbUp,
                        "Good reply",
                        Prop::bind(move || rating.get() == Some(Rating::Up)),
                        Tone::Accent,
                        act(|id| Action::Rate(id, Rating::Up)),
                    ))
                    .child(action_button(
                        GlyphName::ThumbDown,
                        "Bad reply",
                        Prop::bind(move || rating.get() == Some(Rating::Down)),
                        Tone::Danger,
                        act(|id| Action::Rate(id, Rating::Down)),
                    ))
            }))
    }
}

/// A message of the user: its attachments and its text in a bubble.
fn user_row(item: Item) -> View {
    let field = move |m: &Option<Msg>| match m {
        Some(Msg::User {
            text,
            image,
            file,
            waiting,
            ..
        }) => (text.clone(), *image, file.clone(), *waiting),
        _ => (String::new(), None, None, false),
    };
    let user = computed(move || item.with(field));
    let image = computed(move || user.with(|u| u.1));
    let file = computed(move || user.with(|u| u.2.clone()));
    let body = computed(move || user.with(|u| u.0.clone()));
    view()
        .items_end()
        .px_4()
        .py_2()
        .gap_2()
        .child(dynamic(move || {
            image.get().map(|src| photo(src, 220.0, 165.0))
        }))
        .child(dynamic(move || {
            file.with(|f| f.as_ref().map(|f| file_chip(f, None)))
        }))
        .child(when(
            move || !body.with(String::is_empty),
            move || {
                view()
                    .max_w(relative(0.82))
                    .px(px(14.0))
                    .py(px(10.0))
                    .rounded(px(20.0))
                    .rounded_br(px(6.0))
                    .border_curve(BorderCurve::Continuous)
                    .bg(colors::RAISED)
                    .finish(Finish::Raised)
                    .border_1()
                    .border_color(colors::BORDER)
                    .child(
                        text(move || body.get())
                            .selectable(true)
                            .text_size(px(15.0))
                            .line_height(px(21.0))
                            .text_color(colors::TEXT),
                    )
            },
        ))
        .child(when(
            move || user.with(|u| u.3),
            || {
                view()
                    .flex_row()
                    .items_center()
                    .gap(px(6.0))
                    .child(spinner(12.0, colors::WARN))
                    .child(
                        text("Waiting for a connection")
                            .text_size(px(12.0))
                            .text_color(colors::MUTED),
                    )
            },
        ))
}

/// The header of a reply: the avatar, the model, and a badge once stopped.
fn reply_header(model: Memo<Model>, stopped: Memo<bool>) -> View {
    view()
        .flex_row()
        .items_center()
        .gap_2()
        .h(px(26.0))
        .child(avatar())
        .child(
            text(move || model.get().name())
                .flex_1()
                .text_size(px(13.0))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(colors::MUTED),
        )
        .child(when(stopped, || Badge::new("Stopped").tone(Tone::Warn)))
}

/// The reasoning's toggle: a glyph (a spinner while thinking), its label
/// and a caret that turns.
fn reasoning_toggle(
    label: impl Fn() -> String + 'static,
    thinking: Memo<bool>,
    open: Memo<bool>,
) -> View {
    view()
        .flex_row()
        .items_center()
        .gap_2()
        .h(px(32.0))
        .self_start()
        .child(
            when(thinking, || spinner(14.0, colors::MUTED)).otherwise(|| {
                glyph()
                    .name(GlyphName::Brain)
                    .size(16.0)
                    .tint(colors::MUTED)
            }),
        )
        .child(
            text(label)
                .text_size(px(14.0))
                .text_color(colors::MUTED)
                .tabular_nums(),
        )
        .child(
            view()
                .style_with(move |s| s.rotate(deg(if open.get() { 0.0 } else { -90.0 })))
                .transition_transform()
                .duration(220.0)
                .ease_out()
                .child(
                    glyph()
                        .name(GlyphName::CaretDown)
                        .size(14.0)
                        .tint(colors::FAINT),
                ),
        )
}

/// The reasoning's text, beside a rule.
fn reasoning_text(reasoning: impl Fn() -> String + 'static) -> View {
    view()
        .flex_row()
        .gap_3()
        .pl(px(7.0))
        .child(view().w(px(2.0)).rounded(px(1.0)).bg(colors::BORDER))
        .child(
            text(reasoning)
                .selectable(true)
                .flex_1()
                .text_size(px(14.0))
                .line_height(px(20.0))
                .text_color(colors::MUTED),
        )
}
