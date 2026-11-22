//! An edit of a long text keeps the pieces and lines of the text before it
//! outside what it changed (#1892): what it lays out is the same as the
//! edited text prepared afresh, and a keystroke's cost does not grow with
//! the text.

use std::time::{Duration, Instant};

use nsh_core::{
    AttributedText, Points, ResolvedTextStyle, Size, TextAttachment, TextEngine, TextLayout,
};

use crate::text::{Prepared, WebLayout, WebTextEngine};

/// The issue's paragraph, `n` times.
fn paragraph(n: usize) -> String {
    "看多 $NVDA.US @Alice 的下一个季度 ".repeat(n)
}

fn bold() -> ResolvedTextStyle {
    ResolvedTextStyle {
        font_size: Points(20.0),
        ..ResolvedTextStyle::default()
    }
}

/// `s` in the default style, with `bold` (UTF-16 offsets) in another.
fn text(s: &str, bold_range: Option<(usize, usize)>) -> AttributedText {
    let mut t = AttributedText::default();
    let units: Vec<u16> = s.encode_utf16().collect();
    let piece = |from: usize, to: usize| String::from_utf16_lossy(&units[from..to]);
    match bold_range {
        Some((from, to)) if from < to && to <= units.len() => {
            t.push(&piece(0, from), ResolvedTextStyle::default());
            t.push(&piece(from, to), bold());
            t.push(&piece(to, units.len()), ResolvedTextStyle::default());
        }
        _ => t.push(s, ResolvedTextStyle::default()),
    }
    // Each placeholder an attachment.
    t.attachments = units
        .iter()
        .enumerate()
        .filter(|&(_, &u)| u == 0xfffc)
        .map(|(i, _)| TextAttachment {
            index: i as u32,
            width: Points(14.0),
            height: Points(20.0),
        })
        .collect();
    t
}

/// What a layout shows: its lines and runs.
fn shown(engine: &WebTextEngine, layout: &TextLayout) -> String {
    let runs = layout
        .downcast::<WebLayout>()
        .map(|l| format!("{:?}", l.runs));
    format!("{:?}\n{runs:?}", engine.lines(layout))
}

/// Measures and lays `p` out at `widths` as the core does.
fn laid_out(engine: &WebTextEngine, p: &Prepared, widths: &[Option<f32>]) -> String {
    let mut out = String::new();
    for &width in widths {
        let size = engine.measure(p, width.map(Points));
        let baseline = width.and_then(|w| engine.first_baseline(p, Points(w)));
        let layout = engine.layout(p, Size::new(width.map_or(size.width, Points), size.height));
        out += &format!(
            "{width:?} {size:?} {baseline:?}\n{}\n",
            shown(engine, &layout)
        );
    }
    out
}

/// A small deterministic generator (xorshift).
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

#[test]
fn an_edit_lays_out_as_the_edited_text_prepared_afresh() {
    for seed in [0x1892, 7, 12345, 0xdead_beef] {
        edits_lay_out_afresh(seed);
    }
}

fn edits_lay_out_afresh(seed: u64) {
    // Words, spaces, CJK, hyphens, line breaks, punctuation that may not
    // start or end a line, an emoji (two UTF-16 units), an attachment, a
    // long word.
    const PIECES: &[&str] = &[
        "a",
        "b",
        "word",
        " ",
        "  ",
        "看",
        "多",
        "-",
        "x-y",
        "\n",
        "，",
        "。",
        "(",
        ")",
        "「",
        "」",
        "😀",
        "\u{fffc}",
        "averyveryveryverylongwordthatwillnotfit",
    ];
    let widths = [Some(600.0), Some(150.0), Some(37.0), None];
    let engine = WebTextEngine::default();
    let mut rng = Rng(seed);
    let mut s = paragraph(60);
    let mut bold_range = Some((40, 90));
    let mut edits = 0;
    let mut previous = engine.prepare(&text(&s, bold_range));
    laid_out(&engine, &previous, &widths);
    for step in 0..400 {
        let chars: Vec<char> = s.chars().collect();
        let at = rng.below(chars.len() + 1);
        let mut edited: String = chars[..at].iter().collect();
        match rng.below(4) {
            // Insert.
            0 | 1 => {
                edited += PIECES[rng.below(PIECES.len())];
                edited.extend(&chars[at..]);
            }
            // Delete.
            2 => edited.extend(&chars[(at + 1 + rng.below(3)).min(chars.len())..]),
            // Replace.
            _ => {
                edited += PIECES[rng.below(PIECES.len())];
                edited.extend(&chars[(at + 1).min(chars.len())..]);
            }
        }
        s = edited;
        if step % 25 == 24 {
            // The styled range moves too, now and then.
            let start = rng.below(200);
            bold_range = Some((start, start + rng.below(80)));
        }
        let t = text(&s, bold_range);
        let p = engine.prepare(&t);
        edits += usize::from(p.is_edit());
        let fresh = WebTextEngine::default();
        let again = fresh.prepare(&t);
        if p.atoms_debug() != again.atoms_debug() {
            let (a, b) = (p.atoms_debug(), again.atoms_debug());
            let at = a.bytes().zip(b.bytes()).take_while(|(x, y)| x == y).count();
            let mut from = at.saturating_sub(400);
            while !a.is_char_boundary(from) {
                from -= 1;
            }
            panic!(
                "seed {seed} step {step}: atoms differ near {}\n---\n{}",
                &a[from..],
                &b[from..]
            );
        }
        let (got, want) = (
            laid_out(&engine, &p, &widths),
            laid_out(&fresh, &fresh.prepare(&t), &widths),
        );
        if got != want {
            let at = got
                .bytes()
                .zip(want.bytes())
                .take_while(|(a, b)| a == b)
                .count();
            let mut from = at.saturating_sub(300);
            while !got.is_char_boundary(from) {
                from -= 1;
            }
            let near = |s: &str| {
                let mut to = (at + 200).min(s.len());
                while !s.is_char_boundary(to) {
                    to -= 1;
                }
                s[from..to].to_owned()
            };
            panic!(
                "seed {seed} step {step}, first difference:\n{}\n---\n{}",
                near(&got),
                near(&want)
            );
        }
        previous = p;
    }
    drop(previous);
    // Most were prepared as edits.
    assert!(edits > 300, "seed {seed}: only {edits} edits");
}

/// A keystroke's prepare, measure, baseline and layout, as the core does
/// them.
fn keystroke(engine: &WebTextEngine, t: &AttributedText) -> (Duration, Prepared) {
    let start = Instant::now();
    let p = engine.prepare(t);
    let width = Points(600.0);
    let size = engine.measure(&p, Some(width));
    let _ = engine.first_baseline(&p, width);
    let _ = engine.layout(&p, Size::new(width, size.height));
    (start.elapsed(), p)
}

/// Sorted per-keystroke timings of typing `keys` characters at `at` (a
/// fraction of the text) into the paragraph `n` times, with one engine,
/// or with a new engine for each keystroke (every text prepared afresh).
fn type_into(n: usize, keys: usize, at: f32, afresh: bool) -> Vec<Duration> {
    let mut engine = WebTextEngine::default();
    let mut chars: Vec<char> = paragraph(n).chars().collect();
    let mut previous = keystroke(&engine, &text(&chars.iter().collect::<String>(), None)).1;
    let at = (chars.len() as f32 * at) as usize;
    let mut times: Vec<_> = (0..keys)
        .map(|i| {
            chars.insert(at + i, ['a', 'b', 'c'][i % 3]);
            if afresh {
                engine = WebTextEngine::default();
            }
            let s: String = chars.iter().collect();
            let (time, p) = keystroke(&engine, &text(&s, None));
            previous = p;
            time
        })
        .collect();
    drop(previous);
    times.sort();
    times
}

/// `cargo test -p nsh-platform-web --release --test text_engine -- --ignored --nocapture`
#[test]
#[ignore = "a benchmark: prints per-keystroke timings"]
fn per_keystroke_timings() {
    println!("| characters | where | afresh median | afresh p95 | edit median | edit p95 |");
    println!("| --- | --- | --- | --- | --- | --- |");
    for n in [400, 4000, 28000] {
        for (name, at) in [("end", 1.0), ("middle", 0.5), ("start", 0.0)] {
            let afresh = type_into(n, 21, at, true);
            let edit = type_into(n, 21, at, false);
            let q = |t: &[Duration], p: usize| t[(t.len() - 1) * p / 100];
            println!(
                "| {} | {name} | {:.2?} | {:.2?} | {:.2?} | {:.2?} |",
                paragraph(n).chars().count(),
                q(&afresh, 50),
                q(&afresh, 95),
                q(&edit, 50),
                q(&edit, 95),
            );
        }
    }
}

#[test]
fn letter_spacing_is_counted_per_grapheme_cluster_across_spans() {
    let engine = WebTextEngine::default();
    let spacing = 5.0f32;
    for (sample, clusters) in [
        ("👨‍👩‍👧‍👦", 1usize),
        ("👍🏻", 1),
        ("🇨🇳", 1),
        ("e\u{0301}", 1),
        ("か\u{3099}", 1),
        ("葛\u{E0100}", 1),
    ] {
        let after_style = bold();
        let layout_for = |letter_spacing: f32| {
            let style = ResolvedTextStyle {
                letter_spacing: Points(letter_spacing),
                ..ResolvedTextStyle::default()
            };
            let mut t = AttributedText::default();
            t.push(sample, style);
            t.push("after", after_style);
            let p = engine.prepare(&t);
            let size = engine.measure(&p, None);
            engine.layout(&p, size)
        };
        let unspaced = layout_for(0.0);
        let spaced = layout_for(spacing);
        let unspaced_runs = &unspaced.downcast::<WebLayout>().unwrap().runs;
        let spaced_runs = &spaced.downcast::<WebLayout>().unwrap().runs;
        assert_eq!(unspaced_runs.len(), 2, "{sample}: {unspaced_runs:?}");
        assert_eq!(spaced_runs.len(), 2, "{sample}: {spaced_runs:?}");
        assert_eq!(spaced_runs[0].text, sample);
        assert_eq!(spaced_runs[1].text, "after");
        let shift = spaced_runs[1].x - unspaced_runs[1].x;
        let expected = spacing * clusters as f32;
        assert!(
            (shift - expected).abs() < 0.01,
            "{sample}: expected shift {expected}, got {shift}"
        );
    }

    // `break_split` also counts letter-spacing once per cluster when breaking
    // an oversized word across lines.
    let single = {
        let mut t = AttributedText::default();
        t.push(
            "👨‍👩‍👧‍👦",
            ResolvedTextStyle {
                letter_spacing: Points(spacing),
                ..ResolvedTextStyle::default()
            },
        );
        let p = engine.prepare(&t);
        engine.measure(&p, None).width.0
    };
    let mut doubled = AttributedText::default();
    doubled.push(
        "👨‍👩‍👧‍👦👨‍👩‍👧‍👦",
        ResolvedTextStyle {
            letter_spacing: Points(spacing),
            ..ResolvedTextStyle::default()
        },
    );
    let p = engine.prepare(&doubled);
    let size = engine.measure(&p, Some(Points(single + 1.0)));
    let layout = engine.layout(&p, size);
    let lines = engine.lines(&layout);
    assert_eq!(lines.len(), 2, "{lines:?}");
    for line in &lines {
        assert!(
            (line.width.0 - single).abs() < 0.01,
            "expected wrapped cluster width {single}, got {:?}",
            line.width
        );
    }
    let runs = &layout.downcast::<WebLayout>().unwrap().runs;
    assert_eq!(runs.len(), 2, "{runs:?}");
    assert_eq!(runs[0].text, "👨‍👩‍👧‍👦");
    assert_eq!(runs[1].text, "👨‍👩‍👧‍👦");
}
