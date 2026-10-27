//! CSS grid syntax for style strings and classes: track lists
//! (`repeat(3, minmax(0, 1fr))`, `1fr 2fr 100px`, `[full-start] 1fr
//! [content-start] 2fr [content-end full-end]`), placements
//! (`span 2 / span 2`, `1 / -1`, `content-start / full-end`, `span col`)
//! and `grid-auto-flow`.

use taffy::{
    GridAutoFlow, GridPlacement, GridTemplateComponent, GridTemplateRepetition, Line,
    MaxTrackSizingFunction, MinTrackSizingFunction, RepetitionCount, TrackSizingFunction,
    style_helpers::{TaffyGridLine, TaffyGridSpan},
};

type Max = MaxTrackSizingFunction;
type Min = MinTrackSizingFunction;

use crate::{
    css::{self, split_top, words},
    geometry::{DefiniteLength, REM_SIZE},
};

/// A template track list (`grid-template-columns`) and the names of its
/// lines, as taffy takes them (`grid_template_column_names`): one set per
/// line between the components, a `repeat()` counting as one component,
/// or none at all when no line is named.
pub(crate) type Template = (Vec<GridTemplateComponent<String>>, Vec<Vec<String>>);

/// A template track list: `1fr 2fr`, `[a] 40px [b c] 1fr [d]`,
/// `repeat(2, [col] 1fr)`; `none` is empty.
pub(crate) fn template(s: &str) -> Option<Template> {
    let s = s.trim();
    if s == "none" || s.is_empty() {
        return Some((Vec::new(), Vec::new()));
    }
    let mut out = Vec::new();
    let mut names: Vec<Vec<String>> = vec![Vec::new()];
    for word in words(s) {
        if let Some(group) = word.strip_prefix('[') {
            // Adjacent groups name the same line (`[a] [b]` is `[a b]`).
            names
                .last_mut()?
                .extend(line_names(group.strip_suffix(']')?)?);
        } else if let Some(args) = word.strip_prefix("repeat(") {
            let args = args.strip_suffix(')')?;
            let (count, tracks) = args.split_once(',')?;
            let count = match count.trim() {
                "auto-fill" => RepetitionCount::AutoFill,
                "auto-fit" => RepetitionCount::AutoFit,
                n => RepetitionCount::Count(n.parse().ok().filter(|&n: &u16| n > 0)?),
            };
            let (tracks, line_names) = named_track_list(tracks)?;
            out.push(GridTemplateComponent::Repeat(GridTemplateRepetition {
                count,
                tracks,
                line_names,
            }));
            names.push(Vec::new());
        } else {
            out.push(GridTemplateComponent::Single(track(word)?));
            names.push(Vec::new());
        }
    }
    if names.iter().all(Vec::is_empty) {
        names.clear();
    }
    Some((out, names))
}

/// The tracks of a `repeat()` and the names of their lines: one set per
/// line, both edges included, or none when no line is named (what taffy
/// requires).
fn named_track_list(s: &str) -> Option<(Vec<TrackSizingFunction>, Vec<Vec<String>>)> {
    let mut tracks = Vec::new();
    let mut names: Vec<Vec<String>> = vec![Vec::new()];
    for word in words(s) {
        if let Some(group) = word.strip_prefix('[') {
            names
                .last_mut()?
                .extend(line_names(group.strip_suffix(']')?)?);
        } else {
            tracks.push(track(word)?);
            names.push(Vec::new());
        }
    }
    if tracks.is_empty() {
        return None;
    }
    if names.iter().all(Vec::is_empty) {
        names.clear();
    }
    Some((tracks, names))
}

/// The names of a `[a b]` group.
fn line_names(s: &str) -> Option<Vec<String>> {
    s.split_whitespace()
        .map(|name| ident(name).map(str::to_owned))
        .collect()
}

/// A CSS `<custom-ident>` that can name a line (`span` and `auto` are
/// keywords of placements).
fn ident(s: &str) -> Option<&str> {
    let mut chars = s.chars();
    let first = chars.next()?;
    let starts = first.is_alphabetic()
        || first == '_'
        || (first == '-' && chars.next().is_some_and(|c| !c.is_ascii_digit()));
    let valid = starts
        && s.chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_');
    (valid && !matches!(s, "span" | "auto")).then_some(s)
}

/// Implicit track sizes (`grid-auto-rows`).
pub(crate) fn auto_tracks(s: &str) -> Option<Vec<TrackSizingFunction>> {
    track_list(s)
}

fn track_list(s: &str) -> Option<Vec<TrackSizingFunction>> {
    words(s).into_iter().map(track).collect()
}

/// One track size: `1fr`, `100px`, `25%`, `auto`, `min-content`,
/// `max-content`, `minmax(a, b)`, `fit-content(100px)`.
fn track(s: &str) -> Option<TrackSizingFunction> {
    let s = s.trim();
    if let Some(args) = s.strip_prefix("minmax(") {
        let parts = split_top(args.strip_suffix(')')?, ',');
        let [min, max] = parts.as_slice() else {
            return None;
        };
        return Some(TrackSizingFunction {
            min: min_track(min)?,
            max: max_track(max)?,
        });
    }
    if let Some(arg) = s.strip_prefix("fit-content(") {
        let max = match css::length_or_percent(arg.strip_suffix(')')?)? {
            DefiniteLength::Absolute(a) => Max::fit_content_px(a.to_points(REM_SIZE).0),
            DefiniteLength::Fraction(f) => Max::fit_content_percent(f.0),
        };
        return Some(TrackSizingFunction {
            min: Min::auto(),
            max,
        });
    }
    let max = max_track(s)?;
    // A flexible track's minimum is `auto` (CSS); fixed tracks are their
    // own minimum.
    let min = if s.ends_with("fr") {
        Min::auto()
    } else {
        min_track(s)?
    };
    Some(TrackSizingFunction { min, max })
}

fn min_track(s: &str) -> Option<Min> {
    Some(match s.trim() {
        "auto" => Min::auto(),
        "min-content" => Min::min_content(),
        "max-content" => Min::max_content(),
        s => match css::length_or_percent(s)? {
            DefiniteLength::Absolute(a) => Min::length(a.to_points(REM_SIZE).0),
            DefiniteLength::Fraction(f) => Min::percent(f.0),
        },
    })
}

fn max_track(s: &str) -> Option<Max> {
    let s = s.trim();
    if let Some(fr) = s.strip_suffix("fr") {
        return Some(Max::fr(css::number(fr)?.max(0.0)));
    }
    Some(match s {
        "auto" => Max::auto(),
        "min-content" => Max::min_content(),
        "max-content" => Max::max_content(),
        s => match css::length_or_percent(s)? {
            DefiniteLength::Absolute(a) => Max::length(a.to_points(REM_SIZE).0),
            DefiniteLength::Fraction(f) => Max::percent(f.0),
        },
    })
}

/// One end of a placement: `auto`, `3`, `-1`, `span 2`, a line name
/// (`content-start`), its `n`th line (`2 col`, `-1 col`) or a span to a
/// named line (`span col`, `span 2 col`); the parts in any order, as CSS.
pub(crate) fn placement(s: &str) -> Option<GridPlacement<String>> {
    let s = s.trim();
    if s == "auto" {
        return Some(GridPlacement::Auto);
    }
    let mut span = false;
    let mut number: Option<i16> = None;
    let mut name: Option<&str> = None;
    for word in s.split_whitespace() {
        if word == "span" && !span {
            span = true;
        } else if let Ok(n) = word.parse::<i16>() {
            if number.is_some() || n == 0 {
                return None;
            }
            number = Some(n);
        } else if name.is_none() {
            name = Some(ident(word)?);
        } else {
            return None;
        }
    }
    Some(match (span, number, name) {
        (true, Some(n), None) => {
            GridPlacement::from_span(u16::try_from(n).ok().filter(|&n| n > 0)?)
        }
        (true, None, Some(name)) => GridPlacement::NamedSpan(name.to_owned(), 1),
        (true, Some(n), Some(name)) => {
            GridPlacement::NamedSpan(name.to_owned(), u16::try_from(n).ok().filter(|&n| n > 0)?)
        }
        (false, Some(n), None) => GridPlacement::from_line_index(n),
        (false, None, Some(name)) => GridPlacement::NamedLine(name.to_owned(), 0),
        (false, Some(n), Some(name)) => GridPlacement::NamedLine(name.to_owned(), n),
        (_, None, None) => return None,
    })
}

/// `grid-column` / `grid-row`: `start [/ end]`. A lone line name is both
/// ends (CSS: the area of that name, else the track after the line); a
/// lone span or line keeps `end` automatic.
pub(crate) fn line(s: &str) -> Option<Line<GridPlacement<String>>> {
    match s.split_once('/') {
        Some((a, b)) => Some(Line {
            start: placement(a)?,
            end: placement(b)?,
        }),
        None => Some(line_from(placement(s)?)),
    }
}

/// A placement given only its start (`grid-column: 3`): it ends where
/// CSS ends it, at the same name for a named line, else `auto`.
pub(crate) fn line_from(start: GridPlacement<String>) -> Line<GridPlacement<String>> {
    let end = match &start {
        GridPlacement::NamedLine(name, 0) => GridPlacement::NamedLine(name.clone(), 0),
        _ => GridPlacement::Auto,
    };
    Line { start, end }
}

/// Line `n` (1 is the first, -1 the last).
pub(crate) fn line_number(n: i16) -> GridPlacement<String> {
    GridPlacement::from_line_index(n)
}

/// `span n / span n`.
pub(crate) fn span(n: u16) -> Line<GridPlacement<String>> {
    Line {
        start: GridPlacement::from_span(n),
        end: GridPlacement::from_span(n),
    }
}

/// `repeat(n, minmax(0, 1fr))`: `n` equal tracks.
pub(crate) fn equal_tracks(n: u16) -> Template {
    let track = TrackSizingFunction {
        min: Min::length(0.0),
        max: Max::fr(1.0),
    };
    let repeat = GridTemplateRepetition {
        count: RepetitionCount::Count(n),
        tracks: vec![track],
        line_names: Vec::new(),
    };
    (vec![GridTemplateComponent::Repeat(repeat)], Vec::new())
}

/// `grid-auto-flow`.
pub(crate) fn auto_flow(s: &str) -> Option<GridAutoFlow> {
    let w = words(s);
    let dense = w.contains(&"dense");
    let column = w.contains(&"column");
    if w.iter().any(|x| !matches!(*x, "dense" | "column" | "row")) {
        return None;
    }
    Some(match (column, dense) {
        (false, false) => GridAutoFlow::Row,
        (true, false) => GridAutoFlow::Column,
        (false, true) => GridAutoFlow::RowDense,
        (true, true) => GridAutoFlow::ColumnDense,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typed_values_are_their_css() {
        assert_eq!(
            equal_tracks(3),
            template("repeat(3, minmax(0, 1fr))").unwrap()
        );
        assert_eq!(span(2), line("span 2 / span 2").unwrap());
        assert_eq!(line_from(placement("3").unwrap()), line("3").unwrap());
        assert_eq!(line_from(placement("a").unwrap()), line("a").unwrap());
    }

    #[test]
    fn templates() {
        let (t, names) = template("repeat(3, minmax(0, 1fr))").unwrap();
        assert_eq!(t.len(), 1);
        assert!(names.is_empty());
        assert!(matches!(&t[0], GridTemplateComponent::Repeat(r) if r.tracks.len() == 1));
        let (t, _) = template("1fr 2fr 100px auto").unwrap();
        assert_eq!(t.len(), 4);
        assert!(template("none").unwrap().0.is_empty());
        assert!(template("1zz").is_none());
    }

    #[test]
    fn line_names() {
        let (t, names) = template("[a] 40px [b] 60px [c] 1fr [d]").unwrap();
        assert_eq!(t.len(), 3);
        assert_eq!(names, [vec!["a"], vec!["b"], vec!["c"], vec!["d"]]);
        // Several names per line, unnamed lines, adjacent groups.
        let (t, names) = template("[full-start main] 1fr [x] [y] 2fr 3fr").unwrap();
        assert_eq!(t.len(), 3);
        assert_eq!(
            names,
            [vec!["full-start", "main"], vec!["x", "y"], vec![], vec![]]
        );
        // Names inside a repetition: one set per line of a repetition.
        let (t, names) = template("[a] repeat(2, [col] 1fr [gap] 10px) [z]").unwrap();
        assert_eq!(names, [vec!["a"], vec!["z"]]);
        let GridTemplateComponent::Repeat(r) = &t[0] else {
            panic!("a repetition");
        };
        assert_eq!(r.line_names, [vec!["col"], vec!["gap"], vec![]]);
        assert!(template("[1a] 1fr").is_none());
        assert!(template("[span] 1fr").is_none());
        assert!(template("[a 1fr").is_none());
    }

    #[test]
    fn placements() {
        let l = line("span 2 / span 2").unwrap();
        assert_eq!(l.start, GridPlacement::Span(2));
        let l = line("1 / -1").unwrap();
        assert_eq!(l.end, GridPlacement::from_line_index(-1));
        assert_eq!(line("3").unwrap().end, GridPlacement::Auto);
        assert!(placement("0").is_none());
        assert_eq!(auto_flow("column dense"), Some(GridAutoFlow::ColumnDense));
    }

    #[test]
    fn named_placements() {
        let named = |s: &str, n| GridPlacement::NamedLine(s.to_owned(), n);
        assert_eq!(placement("a"), Some(named("a", 0)));
        assert_eq!(placement("2 col"), Some(named("col", 2)));
        assert_eq!(placement("col -1"), Some(named("col", -1)));
        assert_eq!(
            placement("span col"),
            Some(GridPlacement::NamedSpan("col".into(), 1))
        );
        assert_eq!(
            placement("span 2 col"),
            Some(GridPlacement::NamedSpan("col".into(), 2))
        );
        let l = line("a / c").unwrap();
        assert_eq!((l.start, l.end), (named("a", 0), named("c", 0)));
        let l = line("main").unwrap();
        assert_eq!((l.start, l.end), (named("main", 0), named("main", 0)));
        assert!(placement("a b").is_none());
        assert!(placement("span -1 col").is_none());
        assert!(placement("span").is_none());
        assert!(placement("1 2").is_none());
    }
}
