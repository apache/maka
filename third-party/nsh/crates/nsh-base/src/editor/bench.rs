//! What highlighting a 200 000 line file costs (ignored; it prints):
//!
//! `cargo test --release -p nsh-base --lib bench_highlight_200k -- --ignored --nocapture`
//!
//! The text is this repository's own code, Rust and TSX, repeated to
//! 200 000 lines. The controller's task is played as it runs: each pass's
//! job one after another (on a blocking thread there), the lines in view
//! first, then on up to [`LOOKAHEAD`] lines past them. Times are of the
//! jobs (off the engine thread) unless they say "engine thread".

use std::{
    ops::Range,
    time::{Duration, Instant},
};

use nsh_core::prelude::*;

use super::{
    commands::{EditOptions, Outcome},
    highlight::{GUESS_CONTEXT, LOOKAHEAD, SLICE},
    state::{Font, State},
    types::{Selection, Selections},
};

const LINES: usize = 200_000;
/// The controller parses the lines in view first (else straight on to
/// the lookahead, as before it did).
const VIEW_FIRST: bool = true;
/// The lines a window shows.
const VIEW: usize = 60;

/// `count` lines of the repository's files with extension `ext` under
/// `dirs`, in order, repeated.
fn corpus(ext: &str, dirs: &[&str], count: usize) -> String {
    fn walk(dir: &std::path::Path, ext: &str, out: &mut Vec<std::path::PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<_> = entries.flatten().map(|e| e.path()).collect();
        entries.sort();
        for path in entries {
            if path.is_dir() {
                walk(&path, ext, out);
            } else if path.extension().is_some_and(|e| e == ext) {
                out.push(path);
            }
        }
    }
    let root = std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."));
    let mut files = Vec::new();
    for dir in dirs {
        walk(&root.join(dir), ext, &mut files);
    }
    let mut text = String::new();
    let mut lines = 0;
    'fill: loop {
        for file in &files {
            let source = std::fs::read_to_string(file).unwrap();
            for line in source.lines() {
                text.push_str(line);
                lines += 1;
                if lines == count {
                    break 'fill;
                }
                text.push('\n');
            }
        }
    }
    text
}

fn state(text: &str, language: &str) -> State {
    let font = Font {
        family: "monospace".into(),
        size: px(13.0),
        line_height: px(20.0),
    };
    let measure: std::rc::Rc<dyn Fn(&str) -> Points> =
        std::rc::Rc::new(|s: &str| px(s.chars().count() as f32 * 8.0));
    State::new(
        text,
        State::language_for(Some(language)),
        EditOptions::default(),
        font,
        measure,
    )
}

/// What the passes until a condition cost.
#[derive(Default)]
struct Passes {
    /// The jobs' time, one after another.
    time: Duration,
    jobs: usize,
    /// The lines they parsed.
    lines: usize,
}

impl std::fmt::Display for Passes {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{:>9.2?} ({} jobs, {} lines)",
            self.time, self.jobs, self.lines
        )
    }
}

/// Runs the controller's passes for lines `view` in view until the lines
/// up to `until` are current.
fn passes(st: &mut State, view: Range<usize>, until: usize) -> Passes {
    let mut out = Passes::default();
    let last = view.end - 1;
    loop {
        let rope = st.buffer.rope().clone();
        let h = st.highlighter.as_mut().unwrap();
        if h.frontier() > until {
            return out;
        }
        let to = match VIEW_FIRST && h.frontier() <= last {
            true => last,
            false => last + LOOKAHEAD,
        };
        let Some(job) = h.job(&rope, to, SLICE) else {
            return out;
        };
        let start = Instant::now();
        let done = job.run();
        out.time += start.elapsed();
        out.jobs += 1;
        let parsed = *h.parses();
        h.finish(done);
        out.lines += *h.parses() - parsed;
    }
}

/// Resident memory, in bytes (Linux).
fn resident() -> usize {
    std::fs::read_to_string("/proc/self/statm")
        .ok()
        .and_then(|s| s.split_whitespace().nth(1)?.parse::<usize>().ok())
        .map_or(0, |pages| pages * 4096)
}

/// `text` typed at offset `at`: what it costs the engine thread (the
/// layout, the highlighter told, the marks).
fn typed(st: &mut State, at: usize, text: &str) -> Duration {
    st.selections = Selections::single(Selection::caret(at));
    let start = Instant::now();
    if let Outcome::Edited(changes) = st.editing(40, |e| e.insert(text)) {
        st.changed(&changes);
    }
    start.elapsed()
}

fn median(times: &mut [Duration]) -> Duration {
    times.sort();
    times[times.len() / 2]
}

fn line_view(line: usize) -> Range<usize> {
    let first = line.saturating_sub(20);
    first..first + VIEW
}

fn bench(name: &str, language: &str, text: &str) {
    println!("\n{name}: {LINES} lines, {:.1} MB", text.len() as f64 / 1e6);
    crate::editor::highlight::Highlighter::load();
    let start = Instant::now();
    let mut st = state(text, language);
    println!(
        "  open (State::new, engine thread)        {:>9.2?}",
        start.elapsed()
    );

    // Opening: the first screen's colors, the language's regexes cold.
    let first = passes(&mut st, 0..VIEW, VIEW - 1);
    println!("  first screen colored                    {first}");
    let lookahead = passes(&mut st, 0..VIEW, VIEW - 1 + LOOKAHEAD);
    println!("  + the lookahead ({LOOKAHEAD} lines)              {lookahead}");

    // A jump to the end: the guess, then the parse from the top reaching it.
    let at = LINES - VIEW;
    let rope = st.buffer.rope().clone();
    let from = at - GUESS_CONTEXT;
    let h = st.highlighter.as_mut().unwrap();
    let guess = h
        .guess(&rope, from, st.buffer.line_start(from), LINES - 1)
        .unwrap();
    let start = Instant::now();
    let guessed = guess.run();
    println!(
        "  jump to line {at}: guessed colors        {:>9.2?}",
        start.elapsed()
    );
    st.highlighter.as_mut().unwrap().guessed(guessed);
    // Typing there before the parse from the top reaches it: the view is
    // guessed again when the controller asks.
    let line = LINES - 30;
    let at = st.buffer.line_start(line) + 4;
    let engine = typed(&mut st, at, "x");
    let rope = st.buffer.rope().clone();
    let h = st.highlighter.as_mut().unwrap();
    match h.guess(&rope, from, st.buffer.line_start(from), LINES - 1) {
        Some(guess) => {
            let start = Instant::now();
            let guessed = guess.run();
            let time = start.elapsed();
            h.guessed(guessed);
            println!(
                "  ... typed there: engine thread {engine:>9.2?}, colors guessed again {time:>9.2?}"
            );
        }
        None => println!(
            "  ... typed there: engine thread {engine:>9.2?}, colors kept from before until the parse reaches it"
        ),
    }
    let before = resident();
    let all = passes(&mut st, at..LINES, LINES - 1);
    println!(
        "  ... the parse from the top reaching it   {all} = {:.0} lines/s, +{:.0} MB resident",
        LINES as f64 / all.time.as_secs_f64(),
        resident().saturating_sub(before) as f64 / 1e6
    );

    // Typing, everything parsed: a character inside a line (the engine
    // thread's share, then the jobs until the view is current), median of
    // 20 keys, at the top, the middle and the end.
    for line in [100, LINES / 2, LINES - 30] {
        let view = line_view(line);
        let mut engine = Vec::new();
        let mut jobs = Vec::new();
        for i in 0..20 {
            let at = st.buffer.line_start(line) + 8 + i;
            let e = typed(&mut st, at, "x");
            engine.push(e);
            jobs.push(passes(&mut st, view.clone(), view.end - 1).time);
        }
        println!(
            "  type at line {line:>6}: engine thread {:>9.2?}, colors {:>9.2?} (medians)",
            median(&mut engine),
            median(&mut jobs)
        );
    }

    // Enter in the middle.
    let line = LINES / 2;
    let view = line_view(line);
    let at = st.buffer.line_start(line) + 4;
    let engine = typed(&mut st, at, "\n");
    let colors = passes(&mut st, view.clone(), view.end - 1);
    println!("  Enter at line {line}: engine thread {engine:>9.2?}, colors {colors}");

    // Pasting 1000 lines in the middle.
    let paste: String = text.split_inclusive('\n').skip(5000).take(1000).collect();
    let at = st.buffer.line_start(line);
    let engine = typed(&mut st, at, &paste);
    let colors = passes(&mut st, view.clone(), view.end - 1);
    let count = st.buffer.line_count();
    let settled = passes(&mut st, view.clone(), count - 1);
    println!(
        "  paste 1000 lines at {line}: engine thread {engine:>9.2?}, colors {colors}, settled {settled}"
    );

    // Edits that change what follows: a block comment opened near the top
    // (closed again by the next `*/` in the code), then closed.
    let view = line_view(100);
    let at = st.buffer.line_start(100);
    let engine = typed(&mut st, at, "/*");
    let colors = passes(&mut st, view.clone(), view.end - 1);
    let count = st.buffer.line_count();
    let all = passes(&mut st, view.clone(), count - 1);
    println!("  open /* at line 100: engine thread {engine:>9.2?}, colors {colors}, settled {all}");
    let engine = typed(&mut st, at, "*/");
    let colors = passes(&mut st, view.clone(), view.end - 1);
    let all = passes(&mut st, view.clone(), count - 1);
    println!("  close it with */: engine thread {engine:>9.2?}, colors {colors}, settled {all}");
    // A lone quote: every string after it turns inside out, to the end.
    let engine = typed(&mut st, at, "\"");
    let colors = passes(&mut st, view.clone(), view.end - 1);
    let all = passes(&mut st, view.clone(), count - 1);
    println!(
        "  a lone \" at line 100: engine thread {engine:>9.2?}, colors {colors}, settled {all}"
    );
}

#[test]
#[ignore]
fn bench_highlight_200k() {
    let rust = corpus("rs", &["crates"], LINES);
    bench("Rust", "rust", &rust);
    let tsx = corpus("tsx", &["examples", "website/demos"], LINES);
    bench("TSX", "tsx", &tsx);
}
