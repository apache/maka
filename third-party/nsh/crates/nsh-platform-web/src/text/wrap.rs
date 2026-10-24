//! Where lines break: the pieces a text is cut into (words, spaces, CJK
//! characters, attachments), the break opportunities between them and the
//! greedy filling of lines. It depends on nothing of the browser, so its
//! tests run off WebAssembly too (`tests/text`).
//!
//! Lines break after spaces and between pieces, except where the line
//! start and line end rules (kinsoku, a common subset of UAX #14 and JIS X
//! 4051) forbid it: closing brackets and quotes, full stops, commas and
//! similar punctuation never start a line, opening brackets and quotes
//! never end one. Small kana and the prolonged sound mark may start a line,
//! as with CSS `line-break: normal`.

/// What a piece of text is, for line breaking.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Piece {
    /// Text; the line may break after it.
    Text,
    /// Spaces (do not count at the end of a line).
    Space,
    /// A forced line break.
    Newline,
    /// An inline attachment.
    Object,
}

/// A piece of text that is never broken across lines.
pub(crate) trait Item {
    fn piece(&self) -> Piece;
    /// Its width on the line.
    fn width(&self) -> f32;
    /// Its text (empty for a newline or an attachment).
    fn text(&self) -> &str;
}

/// A line: items `start..end`, and its width without trailing spaces.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Line {
    pub(crate) start: usize,
    pub(crate) end: usize,
    pub(crate) width: f32,
}

/// Characters that are broken around one by one.
pub(crate) fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x2E80..=0x9FFF | 0xA960..=0xA97F | 0xAC00..=0xD7FF | 0xF900..=0xFAFF |
        0xFE30..=0xFE4F | 0xFF00..=0xFFEF | 0x20000..=0x3FFFF)
}

/// Characters a line never starts with: closing punctuation (UAX #14 CL,
/// CP, closing QU), full stops, commas, exclamation and question marks
/// (IS, EX), and the nonstarters of JIS X 4051 (iteration marks, middle
/// dots, the wave dash).
pub(crate) fn no_break_before(c: char) -> bool {
    matches!(
        c,
        ')' | ']'
            | '}'
            | ','
            | '.'
            | ':'
            | ';'
            | '!'
            | '?'
            | '’'
            | '”'
            | '…'
            | '‥'
            | '‼'
            | '⁇'
            | '⁈'
            | '⁉'
            | '、'
            | '。'
            | '〉'
            | '》'
            | '」'
            | '』'
            | '】'
            | '〕'
            | '〗'
            | '〙'
            | '〛'
            | '〞'
            | '〟'
            | '々'
            | '〻'
            | '〜'
            | 'ゝ'
            | 'ゞ'
            | '゠'
            | '・'
            | 'ヽ'
            | 'ヾ'
            | '！'
            | '）'
            | '，'
            | '．'
            | '：'
            | '；'
            | '？'
            | '］'
            | '｝'
            | '｠'
            | '｡'
            | '｣'
            | '､'
            | '･'
    )
}

/// Characters a line never ends with: opening punctuation (UAX #14 OP,
/// opening QU).
pub(crate) fn no_break_after(c: char) -> bool {
    matches!(
        c,
        '(' | '['
            | '{'
            | '‘'
            | '“'
            | '〈'
            | '《'
            | '「'
            | '『'
            | '【'
            | '〔'
            | '〖'
            | '〘'
            | '〚'
            | '〝'
            | '（'
            | '［'
            | '｛'
            | '｟'
            | '｢'
    )
}

/// Whether a line may break between `before` and `after`, two neighbouring
/// pieces. After spaces it always may (before them never: spaces end the
/// line); around attachments too.
pub(crate) fn breaks_between(before: &impl Item, after: &impl Item) -> bool {
    match (before.piece(), after.piece()) {
        (_, Piece::Space | Piece::Newline) => false,
        (Piece::Space | Piece::Newline, _) => true,
        (Piece::Object, _) | (_, Piece::Object) => true,
        (Piece::Text, Piece::Text) => {
            !before
                .text()
                .chars()
                .next_back()
                .is_some_and(no_break_after)
                && !after.text().chars().next().is_some_and(no_break_before)
        }
    }
}

/// The lines of `items` at `max` width (unbounded: `None`), filled
/// greedily. A piece that does not fit starts the next line; when the line
/// may not break before it, the line breaks at its last opportunity
/// instead, and only a line without one breaks there anyway. A newline
/// ends its line and belongs to none.
pub(crate) fn fill(items: &[impl Item], max: Option<f32>) -> Vec<Line> {
    let mut lines = Vec::new();
    let mut start = 0;
    // Width without and with trailing spaces.
    let mut width = 0.0f32;
    let mut advance = 0.0f32;
    let mut i = 0;
    while i < items.len() {
        let item = &items[i];
        match item.piece() {
            Piece::Newline => {
                lines.push(Line {
                    start,
                    end: i,
                    width,
                });
                start = i + 1;
                width = 0.0;
                advance = 0.0;
            }
            Piece::Space => advance += item.width(),
            Piece::Text | Piece::Object => {
                if let Some(max) = max
                    && start < i
                    && advance + item.width() > max + 0.01
                {
                    let at = (start + 1..=i)
                        .rev()
                        .find(|&j| breaks_between(&items[j - 1], &items[j]))
                        .unwrap_or(i);
                    if at < i {
                        width = content_width(&items[start..at]);
                    }
                    lines.push(Line {
                        start,
                        end: at,
                        width,
                    });
                    start = at;
                    width = 0.0;
                    advance = 0.0;
                    if at < i {
                        // The pieces after the break go on the next line.
                        i = at;
                        continue;
                    }
                }
                advance += item.width();
                width = advance;
            }
        }
        i += 1;
    }
    lines.push(Line {
        start,
        end: items.len(),
        width,
    });
    lines
}

/// The width of `items` without trailing spaces.
fn content_width(items: &[impl Item]) -> f32 {
    let end = items
        .iter()
        .rposition(|item| item.piece() != Piece::Space)
        .map_or(0, |last| last + 1);
    items[..end].iter().map(Item::width).sum()
}
