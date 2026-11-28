//! A run in a line taller or shorter than its font carries its line's
//! height (`Run::line_height`), so the DOM gives it a line box that tall and
//! a selection highlights the whole line; a run of its font's own height
//! carries none.

use nsh_core::{AttributedText, Points, ResolvedTextStyle, TextEngine};

use crate::text::{WebLayout, WebTextEngine};

fn line_heights(line_height: Option<f32>) -> Vec<Option<f32>> {
    let engine = WebTextEngine::default();
    let mut t = AttributedText::default();
    let mut style = ResolvedTextStyle::default();
    if let Some(h) = line_height {
        style.line_height = Points(h);
    }
    t.push("one two three", style);
    let p = engine.prepare(&t);
    // Narrow enough for a line per word.
    let size = engine.measure(&p, Some(Points(60.0)));
    let layout = engine.layout(&p, size);
    layout
        .downcast::<WebLayout>()
        .unwrap()
        .runs
        .iter()
        .map(|r| r.line_height)
        .collect()
}

#[test]
fn runs_carry_their_lines_height_when_it_is_not_their_own() {
    // The stub's font is 12 + 4 high.
    assert_eq!(line_heights(None), vec![None; 3]);
    assert_eq!(line_heights(Some(16.0)), vec![None; 3]);
    assert_eq!(line_heights(Some(25.5)), vec![Some(25.5); 3]);
    assert_eq!(line_heights(Some(12.0)), vec![Some(12.0); 3]);
}
