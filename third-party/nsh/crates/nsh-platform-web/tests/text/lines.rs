//! Line breaking (`wrap::fill`) and its line start and end rules.

use crate::wrap::{Item, Line, Piece, breaks_between, fill, is_cjk};

/// A piece as `WebTextEngine::prepare` cuts text: words, runs of spaces
/// and CJK characters one by one, each character 10 wide.
#[derive(Debug)]
struct Atom(String, Piece);

impl Item for Atom {
    fn piece(&self) -> Piece {
        self.1
    }
    fn width(&self) -> f32 {
        match self.1 {
            Piece::Newline => 0.0,
            Piece::Object => 10.0,
            _ => 10.0 * self.0.chars().count() as f32,
        }
    }
    fn text(&self) -> &str {
        &self.0
    }
}

fn atoms(text: &str) -> Vec<Atom> {
    let mut atoms = Vec::new();
    let mut word = String::new();
    let flush = |word: &mut String, atoms: &mut Vec<Atom>| {
        if !word.is_empty() {
            atoms.push(Atom(std::mem::take(word), Piece::Text));
        }
    };
    for c in text.chars() {
        match c {
            '\n' => {
                flush(&mut word, &mut atoms);
                atoms.push(Atom(String::new(), Piece::Newline));
            }
            ' ' => {
                flush(&mut word, &mut atoms);
                match atoms.last_mut() {
                    Some(Atom(s, Piece::Space)) => s.push(c),
                    _ => atoms.push(Atom(c.to_string(), Piece::Space)),
                }
            }
            '\u{fffc}' => {
                flush(&mut word, &mut atoms);
                atoms.push(Atom(String::new(), Piece::Object));
            }
            c if is_cjk(c) => {
                flush(&mut word, &mut atoms);
                atoms.push(Atom(c.to_string(), Piece::Text));
            }
            c => word.push(c),
        }
    }
    flush(&mut word, &mut atoms);
    atoms
}

/// The lines of `text` at `max`, as text (trailing spaces dropped).
fn lines(text: &str, max: f32) -> Vec<String> {
    let atoms = atoms(text);
    fill(&atoms, Some(max))
        .iter()
        .map(|l| {
            atoms[l.start..l.end]
                .iter()
                .map(|a| a.0.as_str())
                .collect::<String>()
                .trim_end()
                .to_owned()
        })
        .collect()
}

#[test]
fn closing_punctuation_does_not_start_a_line() {
    // Four characters fit; "。" would start the second line.
    assert_eq!(lines("一二三四。五六", 40.0), ["一二三", "四。五六"]);
    assert_eq!(lines("一二三四，五", 40.0), ["一二三", "四，五"]);
    assert_eq!(lines("一二三「四」", 40.0), ["一二三", "「四」"]);
    // Several in a row move back together.
    assert_eq!(lines("一二三四」。", 40.0), ["一二三", "四」。"]);
    assert_eq!(lines("一二三四）、五", 40.0), ["一二三", "四）、五"]);
    // Latin punctuation after CJK text.
    assert_eq!(lines("一二三四!", 40.0), ["一二三", "四!"]);
}

#[test]
fn opening_punctuation_does_not_end_a_line() {
    assert_eq!(lines("一二三（四五", 40.0), ["一二三", "（四五"]);
    assert_eq!(lines("一二三《四》", 40.0), ["一二三", "《四》"]);
    assert_eq!(lines("一二“三四", 30.0), ["一二", "“三四"]);
}

#[test]
fn small_kana_and_the_prolonged_sound_mark_may_start_a_line() {
    assert_eq!(lines("アイウエッ", 40.0), ["アイウエ", "ッ"]);
    assert_eq!(lines("アイウエー", 40.0), ["アイウエ", "ー"]);
}

#[test]
fn a_line_without_an_opportunity_breaks_where_it_overflows() {
    assert_eq!(lines("。。。。。", 40.0), ["。。。。", "。"]);
}

#[test]
fn spaces_still_break_and_latin_text_is_unchanged() {
    assert_eq!(lines("one two three", 70.0), ["one two", "three"]);
    assert_eq!(lines("abc 「中文」", 50.0), ["abc", "「中文」"]);
    // A break after spaces stays one even before a closing mark the line
    // could not otherwise start with: only pieces that touch are glued.
    assert_eq!(lines("one ）", 40.0), ["one", "）"]);
    assert_eq!(lines("a\n。b", 100.0), ["a", "。b"]);
}

#[test]
fn widths_leave_out_trailing_spaces() {
    let spaced = atoms("ab 一二三四。");
    let filled = fill(&spaced, Some(70.0));
    assert_eq!(
        filled,
        [
            Line {
                start: 0,
                end: 5,
                width: 60.0
            },
            Line {
                start: 5,
                end: 7,
                width: 20.0
            },
        ]
    );
    // Without a width there is one line, a newline ends its own.
    let unbounded = atoms("一。\n二");
    assert_eq!(
        fill(&unbounded, None),
        [
            Line {
                start: 0,
                end: 2,
                width: 20.0
            },
            Line {
                start: 3,
                end: 4,
                width: 10.0
            },
        ]
    );
}

#[test]
fn break_opportunities() {
    let a = |s: &str| Atom(s.to_owned(), Piece::Text);
    let space = Atom(" ".to_owned(), Piece::Space);
    let object = Atom(String::new(), Piece::Object);
    assert!(breaks_between(&a("中"), &a("文")));
    assert!(!breaks_between(&a("中"), &a("。")));
    assert!(!breaks_between(&a("（"), &a("中")));
    assert!(!breaks_between(&a("foo("), &a("中")));
    assert!(breaks_between(&space, &a("。")));
    assert!(!breaks_between(&a("中"), &space));
    assert!(breaks_between(&object, &a("。")));
    assert!(breaks_between(&a("「"), &object));
}
