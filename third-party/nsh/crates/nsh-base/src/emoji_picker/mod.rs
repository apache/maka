//! `EmojiPicker`: a search field over every emoji, in groups, with no look
//! of its own (`gpui-kit` has none: the name is its `*Picker`s', the
//! behavior and names `Command`'s; the features frimousse's and AndroidX's
//! `EmojiPickerView`'s).
//!
//! - **The data** (`data.rs`): the emoji of emojibase-data with their
//!   English names and keywords (CLDR's), made by `cargo xtask
//!   emoji-data`, carried by the native runtimes and fetched by the web's
//!   the first time a picker shows. The app's `annotations` name them in
//!   its language; a query matches both.
//! - **The model** (`grid.rs`, pure): the groups shown cut into rows of
//!   `columns` cells under their headers, each group's first row, the
//!   highlight's moves (along the cells, down a column, a page). A query
//!   shows its matches in one group without a header; a query that holds
//!   the last one searches only its matches (as `Command`'s).
//! - **The view**: the app's `header`, the search field (with the app's
//!   `searchPrefix` and `searchSuffix`), the rows in a virtualized list
//!   (`viewport: parent`) in a scroll view, the app's `loading` until the
//!   data is there and `empty` while nothing matches, the app's `footer`.
//!   A cell's look is the app's (`itemClass`, `renderItem`, which gets what
//!   the emoji is, never its state); its highlight is its `focus:`.
//! - **Its cost**: a move of the highlight notifies the cells it leaves and
//!   reaches (spread over [`LIT`] signals); a query filters natively and
//!   rows keep their cells by key.
//!
//! The keys are bound while the search field (or, without one, the picker,
//! then one stop of the keyboard focus) has the focus: Up and Down move
//! the highlight down a column, Left and Right along the cells (while the
//! query is empty: otherwise they are the field's caret's; swapped in a
//! right-to-left layout), Page Up and Down by a page, Return chooses
//! (`onSelect`), Escape clears the query and, once it is empty, is
//! `onCancel`. An input method's composition keeps its keys (the platforms'
//! keymaps leave them to it). The highlighted cell is projected `focus:`
//! (NSH has no active descendant): the keyboard's focus stays in the
//! search field, and screen readers hear the highlighted emoji's name.

mod data;
mod grid;

use std::rc::Rc;

use nsh_core::{
    element::{InputPartStyle, Style, TextPartStyle, input, layout_rtl},
    keymap::When,
    prelude::*,
};
use rustc_hash::FxHashMap;

#[cfg(not(target_arch = "wasm32"))]
#[doc(hidden)]
pub use self::data::EMOJI_DATA;
use self::{
    data::{Catalog, Version, catalog},
    grid::{Grid, Move, Row, Section},
};
use crate::{keys::directed, listbox::Via};

/// How many signals the highlight is spread over for the cells to read
/// ([`Picker::is_highlighted`]): more than the cells a list shows.
const LIT: usize = 128;

/// A row is in view when this much of it shows.
const IN_VIEW: Percentage = Percentage(0.995);

/// The rows a page moves by before the list says how many show.
const PAGE: usize = 6;

/// A row's height before one is laid out, in points.
const ROW_ESTIMATE: f32 = 40.0;

/// A group of emoji (emojibase's and Unicode's, the skin tone modifiers'
/// left out), and the app's recent ones.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, PropEnum)]
pub enum EmojiGroupId {
    /// The app's `recent` emoji.
    Recent,
    /// Smileys and emotion.
    #[default]
    SmileysEmotion,
    /// People and body.
    PeopleBody,
    /// Animals and nature.
    AnimalsNature,
    /// Food and drink.
    FoodDrink,
    /// Travel and places.
    TravelPlaces,
    /// Activities.
    Activities,
    /// Objects.
    Objects,
    /// Symbols.
    Symbols,
    /// Flags.
    Flags,
}

impl EmojiGroupId {
    /// The groups a picker shows by default, in order.
    const ALL: [EmojiGroupId; 10] = [
        Self::Recent,
        Self::SmileysEmotion,
        Self::PeopleBody,
        Self::AnimalsNature,
        Self::FoodDrink,
        Self::TravelPlaces,
        Self::Activities,
        Self::Objects,
        Self::Symbols,
        Self::Flags,
    ];

    /// emojibase's group of number `n` (2, the skin tone modifiers', is
    /// none).
    fn of_emojibase(n: u8) -> Option<Self> {
        Some(match n {
            0 => Self::SmileysEmotion,
            1 => Self::PeopleBody,
            3 => Self::AnimalsNature,
            4 => Self::FoodDrink,
            5 => Self::TravelPlaces,
            6 => Self::Activities,
            7 => Self::Objects,
            8 => Self::Symbols,
            9 => Self::Flags,
            _ => return None,
        })
    }
}

/// A skin tone, set on every emoji that takes one (Unicode's five
/// modifiers, Fitzpatrick's scale).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum)]
pub enum EmojiSkinTone {
    /// The emoji's own yellow.
    #[default]
    None,
    /// Light (U+1F3FB).
    Light,
    /// Medium-light (U+1F3FC).
    MediumLight,
    /// Medium (U+1F3FD).
    Medium,
    /// Medium-dark (U+1F3FE).
    MediumDark,
    /// Dark (U+1F3FF).
    Dark,
}

impl EmojiSkinTone {
    fn modifier(self) -> Option<char> {
        Some(match self {
            Self::None => return None,
            Self::Light => '\u{1F3FB}',
            Self::MediumLight => '\u{1F3FC}',
            Self::Medium => '\u{1F3FD}',
            Self::MediumDark => '\u{1F3FE}',
            Self::Dark => '\u{1F3FF}',
        })
    }
}

/// An emoji's name and keywords in the app's language (emojibase's
/// `compact.json` of a locale has them as `unicode`, `label` and `tags`).
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct EmojiAnnotation {
    /// The emoji, with or without its variation selector.
    pub emoji: SharedString,
    /// Its name: what its cell's screen reader label, `EmojiEntry.label`
    /// and `onSelect`'s `label` say, and what queries match.
    pub label: SharedString,
    /// More words queries match.
    #[prop(default)]
    pub keywords: Vec<SharedString>,
}

impl EmojiAnnotation {
    /// `emoji` named `label`.
    pub fn new(emoji: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        Self {
            emoji: emoji.into(),
            label: label.into(),
            ..Self::default()
        }
    }

    /// More words queries match ([`EmojiAnnotation::keywords`]).
    pub fn keywords<I, S>(mut self, keywords: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<SharedString>,
    {
        self.keywords.extend(keywords.into_iter().map(Into::into));
        self
    }
}

/// The headings of the groups, the app's words: a group without one shows
/// no header row (unless `renderGroup` draws one).
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct EmojiGroupLabels {
    /// The app's recent emoji.
    #[prop(skip_none)]
    pub recent: Option<SharedString>,
    /// Smileys and emotion.
    #[prop(skip_none)]
    pub smileys_emotion: Option<SharedString>,
    /// People and body.
    #[prop(skip_none)]
    pub people_body: Option<SharedString>,
    /// Animals and nature.
    #[prop(skip_none)]
    pub animals_nature: Option<SharedString>,
    /// Food and drink.
    #[prop(skip_none)]
    pub food_drink: Option<SharedString>,
    /// Travel and places.
    #[prop(skip_none)]
    pub travel_places: Option<SharedString>,
    /// Activities.
    #[prop(skip_none)]
    pub activities: Option<SharedString>,
    /// Objects.
    #[prop(skip_none)]
    pub objects: Option<SharedString>,
    /// Symbols.
    #[prop(skip_none)]
    pub symbols: Option<SharedString>,
    /// Flags.
    #[prop(skip_none)]
    pub flags: Option<SharedString>,
}

impl EmojiGroupLabels {
    fn of(&self, group: EmojiGroupId) -> Option<&SharedString> {
        match group {
            EmojiGroupId::Recent => self.recent.as_ref(),
            EmojiGroupId::SmileysEmotion => self.smileys_emotion.as_ref(),
            EmojiGroupId::PeopleBody => self.people_body.as_ref(),
            EmojiGroupId::AnimalsNature => self.animals_nature.as_ref(),
            EmojiGroupId::FoodDrink => self.food_drink.as_ref(),
            EmojiGroupId::TravelPlaces => self.travel_places.as_ref(),
            EmojiGroupId::Activities => self.activities.as_ref(),
            EmojiGroupId::Objects => self.objects.as_ref(),
            EmojiGroupId::Symbols => self.symbols.as_ref(),
            EmojiGroupId::Flags => self.flags.as_ref(),
        }
    }
}

/// An emoji as `renderItem`, `onHighlightChange` and the ref's `entry`
/// give it: what it is, never its state.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct EmojiEntry {
    /// The emoji as shown and chosen: with the `skinTone` when it takes
    /// one.
    pub emoji: SharedString,
    /// The emoji without a skin tone: what the app keeps as a recent one.
    pub base: SharedString,
    /// Its name: the app's `annotations`', else English (CLDR's).
    pub label: SharedString,
    /// The words it is also found by besides its name: English, and the
    /// app's `annotations`'.
    pub keywords: Vec<SharedString>,
    /// Its group (never `"recent"`).
    pub group: EmojiGroupId,
    /// The Emoji version that added it (`"15.1"`).
    pub version: SharedString,
    /// It takes a skin tone.
    pub has_skin_tones: bool,
}

/// A group's header as `renderGroup` draws it.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct EmojiGroup {
    /// The group.
    pub id: EmojiGroupId,
    /// Its heading in `groupLabels` (empty without one).
    pub label: SharedString,
    /// Its first emoji (with the skin tone): an icon for it.
    pub first: SharedString,
}

/// The props of [`EmojiPicker`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct EmojiPickerProps {
    /// The query (controlled): the app owns it and sets the one
    /// `onQueryChange` reports. Without it the search field keeps its own.
    pub query: Prop<Option<SharedString>>,
    /// The query at first, while `query` is not set.
    pub default_query: Prop<Option<SharedString>>,
    /// The skin tone of every emoji that takes one (default `"none"`): the
    /// app owns it (a `RadioGroup` of its own sets it) and keeps it.
    #[prop(default)]
    pub skin_tone: Prop<EmojiSkinTone>,
    /// The cells of a row (default 8).
    #[prop(default = 8)]
    pub columns: Prop<u32>,
    /// The groups shown, in order (default every group, `"recent"` first).
    pub groups: Prop<Option<Vec<EmojiGroupId>>>,
    /// The app's recent emoji, most recent first: the `"recent"` group
    /// (none while empty). The app keeps them (`onSelect`'s `base`); an
    /// emoji the data does not have is left out.
    #[prop(default)]
    pub recent: Prop<Vec<SharedString>>,
    /// The groups' headings, the app's words.
    #[prop(default)]
    pub group_labels: Prop<EmojiGroupLabels>,
    /// The emoji's names and keywords in the app's language (emojibase's
    /// data of a locale): the names shown and said, and words queries match
    /// besides the English ones.
    #[prop(default)]
    pub annotations: Prop<Vec<EmojiAnnotation>>,
    /// The newest Emoji version shown (`"15.1"`): emoji added later are
    /// left out, for systems whose fonts do not draw them. Without it every
    /// emoji shows.
    pub emoji_version: Prop<Option<SharedString>>,
    /// A search field above the rows (default `true`). Without it the
    /// picker is one stop of the keyboard focus whose arrows move the
    /// highlight.
    #[prop(default = true)]
    pub searchable: Prop<bool>,
    /// The search field's placeholder.
    pub placeholder: Prop<Option<SharedString>>,
    /// The search field takes the keyboard focus once shown (`Input`'s
    /// `autoFocus`): on the desktops; a touch keyboard would cover the
    /// emoji on a phone.
    #[prop(default)]
    pub auto_focus: Prop<bool>,
    /// What screen readers call the list, and the search field while
    /// `searchAccessibilityLabel` is not set.
    pub accessibility_label: Prop<Option<SharedString>>,
    /// What screen readers call the search field (default
    /// `accessibilityLabel`).
    pub search_accessibility_label: Prop<Option<SharedString>>,
    /// The classes of the search bar: the row of `searchPrefix`, the
    /// search field and `searchSuffix`.
    pub search_bar_class: Prop<Option<SharedString>>,
    /// The inline style of the search bar, over its classes.
    #[prop(default)]
    pub search_bar_style: Prop<Style>,
    /// The classes of the search field.
    pub search_class: Prop<Option<SharedString>>,
    /// The inline style of the search field, over its classes: its text
    /// styles too.
    #[prop(default)]
    pub search_style: Prop<InputPartStyle>,
    /// The classes of the list, the scroll view of the rows: it takes the
    /// picker's height its other parts leave (`h-*` sets its own).
    pub list_class: Prop<Option<SharedString>>,
    /// The inline style of the list, over its classes.
    #[prop(default)]
    pub list_style: Prop<Style>,
    /// The classes of each row of cells (laid out in a row).
    pub row_class: Prop<Option<SharedString>>,
    /// The inline style of each row of cells, over its classes.
    #[prop(default)]
    pub row_style: Prop<Style>,
    /// The classes of each cell: its size (`size-9`, or `flex-1` for the
    /// row's width shared), `focus:` while highlighted (the keys or the
    /// pointer are on it), `hover:` and `active:`; `group` for its content
    /// to follow them. A short last row keeps its cells' places.
    pub item_class: Prop<Option<SharedString>>,
    /// The inline style of each cell, over its classes: its text styles
    /// too (`fontSize`), which the emoji inherits.
    #[prop(default)]
    pub item_style: Prop<TextPartStyle>,
    /// The classes of each group's header.
    pub group_class: Prop<Option<SharedString>>,
    /// The inline style of each group's header, over its classes: its text
    /// styles too, which its heading inherits.
    #[prop(default)]
    pub group_style: Prop<TextPartStyle>,
    /// What shows above the search field: the groups' tabs (`Tabs` with
    /// the ref's `scrollToGroup` and `onGroupChange`), a skin tone choice.
    pub header: Prop<Option<Slot>>,
    /// What shows below the rows: the highlighted emoji and its name
    /// (`onHighlightChange`), the groups' tabs on a phone.
    pub footer: Prop<Option<Slot>>,
    /// What shows while no emoji does: a query that matches nothing.
    pub empty: Prop<Option<Slot>>,
    /// What shows until the emoji are there (on the web, until the page
    /// fetched them).
    pub loading: Prop<Option<Slot>>,
    /// What shows before the search field in its bar: a search icon.
    pub search_prefix: Prop<Option<Slot>>,
    /// What shows after the search field in its bar.
    pub search_suffix: Prop<Option<Slot>>,
    /// A cell's content drawn by the app, for the cells in view; without
    /// it a cell shows the emoji as text.
    pub render_item: Prop<Option<Renderer<EmojiEntry>>>,
    /// A group's header drawn by the app; without it a header shows the
    /// group's heading.
    pub render_group: Prop<Option<Renderer<EmojiGroup>>>,
}

/// The events of an [`EmojiPicker`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum EmojiPickerEvent {
    /// The user chose an emoji (Return, a press): the emoji to insert (with
    /// the skin tone), its form without one (to keep as a recent emoji),
    /// the skin tone and its name.
    #[args(emoji, base, skin_tone, label)]
    Select(SharedString, SharedString, EmojiSkinTone, SharedString),
    /// The highlight moved (the keys, the pointer, a new query, the ref's
    /// `highlight`): the highlighted emoji, `null` while none is (a
    /// preview of its name).
    #[args(highlighted)]
    HighlightChange(Option<EmojiEntry>),
    /// The user typed in the search field, or Escape cleared it: the
    /// query. Set `query` to follow it.
    #[args(query)]
    QueryChange(SharedString),
    /// Another group is at the top of the list (scrolled there, or the
    /// ref's `scrollToGroup`): the groups' tabs follow it. Not while a
    /// query shows its matches.
    #[args(group)]
    GroupChange(EmojiGroupId),
    /// Escape with an empty query: close what holds the picker.
    Cancel,
}

/// What the ref's `entry` looks up: an emoji's entry by its text.
type EntryOf = dyn Fn(&str) -> Option<EmojiEntry>;

/// The methods of an [`EmojiPicker`]'s ref.
pub struct EmojiPickerApi {
    focus: Rc<dyn Fn()>,
    highlight: Rc<dyn Fn(&str) -> bool>,
    scroll_to_group: Rc<dyn Fn(EmojiGroupId, bool) -> bool>,
    entry: Rc<EntryOf>,
    count: Rc<dyn Fn() -> u32>,
}

#[methods]
impl EmojiPickerApi {
    /// Takes the keyboard focus: the search field, else the picker.
    pub fn focus(&self) {
        (self.focus)();
    }

    /// Highlights `emoji` and brings it into view. An emoji that is not
    /// shown does nothing (and is logged).
    pub fn highlight(&self, emoji: String) {
        if !(self.highlight)(&emoji) {
            log::warn!("EmojiPicker.highlight: `{emoji}` is not shown");
        }
    }

    /// Scrolls the group's first row to the top (`animated`, default
    /// `true`), as a group's tab does. A group that is not shown does
    /// nothing (and is logged).
    pub fn scroll_to_group(&self, group: EmojiGroupId, animated: Option<bool>) {
        if !(self.scroll_to_group)(group, animated.unwrap_or(true)) {
            log::warn!("EmojiPicker.scrollToGroup: `{group:?}` is not shown");
        }
    }

    /// What `emoji` is (a reaction's name), whether shown or not; `null`
    /// for one the data does not have.
    pub fn entry(&self, emoji: String) -> Option<EmojiEntry> {
        (self.entry)(&emoji)
    }

    /// How many emoji the query shows.
    pub fn matched_count(&self) -> u32 {
        (self.count)()
    }
}

/// What queries match, made again only when the app's annotations change:
/// each emoji's names (English, then the app's), then its keywords, in
/// lower case, a line each.
struct Index {
    folded: Box<[Box<str>]>,
    /// Where each folded text's names end: a word of them that starts with
    /// the query ranks first.
    names: Box<[u32]>,
    /// The app's names and keywords by emoji.
    annotations: FxHashMap<u32, (SharedString, Vec<SharedString>)>,
}

impl Index {
    fn new(catalog: &Catalog, annotations: &[EmojiAnnotation]) -> Self {
        let mut by_emoji = FxHashMap::default();
        for a in annotations {
            if let Some(i) = catalog.find(&a.emoji) {
                by_emoji.insert(i as u32, (a.label.clone(), a.keywords.clone()));
            }
        }
        let mut names = Vec::with_capacity(catalog.emoji.len());
        let folded = catalog
            .emoji
            .iter()
            .enumerate()
            .map(|(i, e)| {
                let app = by_emoji.get(&(i as u32));
                let mut text = e.label.to_lowercase();
                if let Some((label, _)) = app {
                    text.push('\n');
                    text.push_str(&label.to_lowercase());
                }
                names.push(text.len() as u32);
                let app_words = app.into_iter().flat_map(|(_, keywords)| keywords);
                for word in e.keywords.iter().chain(app_words) {
                    text.push('\n');
                    text.push_str(&word.to_lowercase());
                }
                text.into_boxed_str()
            })
            .collect();
        Self {
            folded,
            names: names.into_boxed_slice(),
            annotations: by_emoji,
        }
    }

    /// How well emoji `i` matches `query`: 0 a word of a name starts with
    /// it, 1 a keyword's word does, 2 it is inside a word (`cat` in
    /// `intoxicated`, or text without spaces); `None` no match.
    fn rank(&self, i: usize, query: &str) -> Option<u8> {
        let text = &*self.folded[i];
        let names = self.names[i] as usize;
        let mut best = None;
        for (at, _) in text.match_indices(query) {
            let starts = text[..at]
                .chars()
                .next_back()
                .is_none_or(|c| !c.is_alphanumeric());
            let rank = match (starts, at < names) {
                (true, true) => 0,
                (true, false) => 1,
                _ => 2,
            };
            best = Some(best.map_or(rank, |b: u8| b.min(rank)));
            if rank == 0 {
                break;
            }
        }
        best
    }
}

/// The [`Index`] now, compared by identity.
#[derive(Clone)]
struct Indexed(Option<Rc<Index>>);

impl PartialEq for Indexed {
    fn eq(&self, other: &Self) -> bool {
        match (&self.0, &other.0) {
            (Some(a), Some(b)) => Rc::ptr_eq(a, b),
            (None, None) => true,
            _ => false,
        }
    }
}

/// The emoji whose folded text holds `query`, those whose names start a
/// word with it first, then their keywords', then the rest, each in the
/// catalog's order: among `among` when given (the matches of a query this
/// one holds, which hold all of its matches).
fn matching(index: &Index, query: &str, among: Option<&[u32]>) -> Vec<u32> {
    let rank = |i: u32| index.rank(i as usize, query).map(|r| (r, i));
    let mut ranked: Vec<(u8, u32)> = match among {
        Some(among) => among.iter().filter_map(|&i| rank(i)).collect(),
        None => (0..index.folded.len() as u32).filter_map(rank).collect(),
    };
    ranked.sort_unstable();
    ranked.into_iter().map(|(_, i)| i).collect()
}

/// The last query the rows were made for, and its matches.
struct Narrow {
    index: Rc<Index>,
    query: String,
    matches: Vec<u32>,
}

/// The rows now, compared by what they show.
#[derive(Clone, Default)]
struct Shown(Rc<Grid>);

impl PartialEq for Shown {
    fn eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0) || self.0 == other.0
    }
}

/// The list's state: its rows, the highlighted cell, what reveals it.
#[derive(Clone, Copy)]
struct Picker {
    index: Memo<Indexed>,
    shown: Memo<Shown>,
    skin_tone: Prop<EmojiSkinTone>,
    /// A query shows its matches.
    searching: Memo<bool>,
    /// The highlighted cell.
    highlight: Signal<Option<usize>>,
    /// The highlight as each cell reads it ([`Picker::is_highlighted`]).
    lit: Stored<[Signal<Option<usize>>; LIT]>,
    /// The highlighted emoji, which the highlight follows when the rows
    /// change.
    highlighted: Stored<Option<u32>>,
    /// The rows wholly in view, as the list last said.
    visible: Stored<Option<(usize, usize)>>,
    /// A row to reveal once the list says what is in view.
    reveal: Stored<Option<usize>>,
    /// The group last reported at the top.
    group: Stored<Option<EmojiGroupId>>,
    /// The height of a row of cells, once one is laid out: the estimate of
    /// the rows not made yet, so a far scroll lands near its target.
    row_size: Signal<Points>,
    list: ElementRef,
    /// Where the pointer last was over the cells.
    pointer: Stored<Option<Point<Points>>>,
    cx: Scope<EmojiPickerEvent>,
}

impl Picker {
    /// The emoji of cell `cell`.
    fn emoji_of(self, cell: usize) -> Option<u32> {
        self.shown.with_untracked(|s| s.0.cells.get(cell).copied())
    }

    /// What emoji `emoji` is, with the skin tone.
    fn entry(self, emoji: u32) -> Option<EmojiEntry> {
        let e = catalog()?.emoji.get(emoji as usize)?;
        let tone = self.skin_tone.get_untracked();
        let app = self.index.with_untracked(|ix| {
            ix.0.as_ref()
                .and_then(|ix| ix.annotations.get(&emoji).cloned())
        });
        let (label, keywords) = match app {
            Some((label, words)) => (label, e.keywords.iter().cloned().chain(words).collect()),
            None => (e.label.clone(), e.keywords.to_vec()),
        };
        Some(EmojiEntry {
            emoji: e.with_tone(tone),
            base: e.emoji.clone(),
            label,
            keywords,
            group: e.group,
            version: e.version.to_string().into(),
            has_skin_tones: e.has_skin_tones(),
        })
    }

    fn lit_of(self, cell: usize) -> Signal<Option<usize>> {
        self.lit.with(|lit| lit[cell % LIT])
    }

    /// Whether `cell` is highlighted (tracked).
    fn is_highlighted(self, cell: usize) -> bool {
        self.lit_of(cell).get() == Some(cell)
    }

    /// Highlights `cell`, reported when it is another emoji; by a key it
    /// is revealed and screen readers hear of it.
    fn set_highlight(self, cell: Option<usize>, via: Via) {
        let emoji = cell.and_then(|c| self.emoji_of(c));
        let changed = self.highlighted.replace(emoji) != emoji;
        let was = self.highlight.get_untracked();
        if was != cell {
            batch(|| {
                if let Some(was) = was {
                    self.lit_of(was).set(None);
                }
                if let Some(cell) = cell {
                    self.lit_of(cell).set(Some(cell));
                }
                self.highlight.set(cell);
            });
        }
        if changed {
            let entry = emoji.and_then(|e| self.entry(e));
            if via == Via::Keyboard
                && let Some(entry) = &entry
            {
                self.tell_screen_reader(entry);
            }
            self.cx.emit(EmojiPickerEvent::HighlightChange(entry));
        }
        if via == Via::Keyboard
            && let Some(cell) = cell
        {
            self.reveal(cell);
        }
    }

    /// Moves the highlight by a key.
    fn move_by(self, by: Move) {
        let next = self
            .shown
            .with_untracked(|s| s.0.step(self.highlight.get_untracked(), by));
        if next.is_some() {
            self.set_highlight(next, Via::Keyboard);
        }
    }

    /// The rows changed: a new query highlights the first cell (`reset`);
    /// otherwise the highlighted emoji keeps it while shown. The first
    /// rows' highlight (`initial`) is neither revealed nor announced, nor
    /// is a highlight the pointer never asked for while browsing the
    /// groups.
    fn follow(self, reset: bool, initial: bool) {
        let searching = self.searching.get_untracked();
        let kept = if reset {
            None
        } else {
            self.highlighted
                .get()
                .and_then(|e| self.shown.with_untracked(|s| s.0.cell_of(e)))
        };
        let next = match kept {
            Some(cell) => Some(cell),
            // Browsing the groups highlights nothing until a key or the
            // pointer does; a query's first match is Return's.
            None if searching => self.shown.with_untracked(|s| s.0.step(None, Move::First)),
            None => None,
        };
        let via = if !initial && reset && next.is_some() {
            Via::Keyboard
        } else {
            Via::Pointer
        };
        self.set_highlight(next, via);
    }

    /// How many rows a page is: the rows wholly in view.
    fn page(self) -> usize {
        self.visible
            .get()
            .map_or(PAGE, |(first, last)| last + 1 - first)
            .max(1)
    }

    /// Cell `cell` comes into view, once.
    fn reveal(self, cell: usize) {
        let Some(row) = self.shown.with_untracked(|s| s.0.row_of(cell)) else {
            return;
        };
        match self.visible.get() {
            Some(visible) => self.scroll_to(row, visible),
            None => {
                self.reveal.replace(Some(row));
            }
        }
    }

    fn scroll_to(self, row: usize, (first, last): (usize, usize)) {
        if (first..=last).contains(&row) {
            return;
        }
        if row < first {
            // Up to the row, with its group's header when it is the
            // group's first.
            let header = row.checked_sub(1).filter(|&r| {
                self.shown
                    .with_untracked(|s| matches!(s.0.rows.get(r), Some(Row::Header(_))))
            });
            self.list.scroll_to_index(
                header.unwrap_or(row) as u32,
                Percentage(0.0),
                px(0.0),
                false,
            );
        } else {
            self.list
                .scroll_to_index(row as u32, Percentage(1.0), px(0.0), false);
        }
    }

    /// The rows wholly in view changed: a pending reveal, and the group at
    /// the top.
    fn viewable(self, items: &ViewableItems) {
        self.visible.replace(items.viewable);
        let Some(visible) = items.viewable else {
            return;
        };
        if let Some(row) = self.reveal.replace(None) {
            self.scroll_to(row, visible);
        }
        if self.searching.get_untracked() {
            return;
        }
        let group = self.shown.with_untracked(|s| {
            let section = s.0.rows.get(visible.0)?.section();
            s.0.sections.get(section as usize).map(|&(g, _)| g)
        });
        if let Some(group) = group {
            self.report_group(group);
        }
    }

    fn report_group(self, group: EmojiGroupId) {
        if self.group.replace(Some(group)) != Some(group) {
            self.cx.emit(EmojiPickerEvent::GroupChange(group));
        }
    }

    /// Screen readers hear of the highlighted emoji: while the search
    /// field edits its name is announced; else its cell takes their focus
    /// (as `Command`'s, the cell's label says it).
    fn tell_screen_reader(self, entry: &EmojiEntry) {
        if !untracked(screen_reader) {
            return;
        }
        announce_for_accessibility(entry.label.to_string());
    }

    /// The pointer moved over cell `cell` to `at` (in the root view): it is
    /// highlighted, unless the pointer is where it was.
    fn hovered(self, cell: usize, at: Point<Points>) {
        if self.pointer.replace(Some(at)) == Some(at) {
            return;
        }
        if self.highlight.get_untracked() != Some(cell) {
            self.set_highlight(Some(cell), Via::Pointer);
        }
    }

    /// The user chose cell `cell`.
    fn choose(self, cell: usize) {
        let Some(entry) = self.emoji_of(cell).and_then(|e| self.entry(e)) else {
            return;
        };
        self.cx.emit(EmojiPickerEvent::Select(
            entry.emoji,
            entry.base,
            self.skin_tone.get_untracked(),
            entry.label,
        ));
    }

    /// The highlighted cell is chosen (Return).
    fn accept(self) {
        if let Some(cell) = self.highlight.get_untracked() {
            self.choose(cell);
        }
    }
}

/// The parts the rows take from the props.
#[derive(Clone, Copy)]
struct Parts {
    columns: Prop<u32>,
    row_class: Prop<Option<SharedString>>,
    row_style: Prop<Style>,
    item_class: Prop<Option<SharedString>>,
    item_style: Prop<TextPartStyle>,
    group_class: Prop<Option<SharedString>>,
    group_style: Prop<TextPartStyle>,
    group_labels: Prop<EmojiGroupLabels>,
    render_item: Prop<Option<Renderer<EmojiEntry>>>,
    render_group: Prop<Option<Renderer<EmojiGroup>>>,
}

/// The query now: the app's, else the field's (tracked).
fn query_of(controlled: Prop<Option<SharedString>>, own: Signal<String>) -> String {
    match controlled.get() {
        Some(q) => q.to_string(),
        None => own.get(),
    }
}

/// The groups' sections when no query shows: each group of `groups` with
/// its emoji up to `max`, `"recent"` the app's.
fn sections(
    catalog: &Catalog,
    groups: &[EmojiGroupId],
    recent: &[SharedString],
    max: Option<Version>,
    labelled: impl Fn(EmojiGroupId) -> bool,
) -> Vec<Section> {
    let shown = |e: &&data::Emoji| max.is_none_or(|max| e.version <= max);
    groups
        .iter()
        .map(|&group| {
            let emoji = match group {
                EmojiGroupId::Recent => {
                    let mut seen = Vec::with_capacity(recent.len());
                    for text in recent {
                        match catalog.find(text) {
                            Some(i) if shown(&&catalog.emoji[i]) && !seen.contains(&(i as u32)) => {
                                seen.push(i as u32);
                            }
                            Some(_) => {}
                            None => {
                                log::debug!("EmojiPicker: no recent emoji `{text}` in the data")
                            }
                        }
                    }
                    seen
                }
                _ => catalog
                    .emoji
                    .iter()
                    .enumerate()
                    .filter(|(_, e)| e.group == group && shown(e))
                    .map(|(i, _)| i as u32)
                    .collect(),
            };
            Section {
                group,
                emoji,
                header: labelled(group),
            }
        })
        .collect()
}

/// An emoji picker: a search field over every emoji (Unicode's, with
/// English names and keywords from CLDR, and the app's `annotations` in
/// its language), in groups (`groups`, the app's `recent` first) of rows of
/// `columns` cells in a virtualized list that makes only the rows in view,
/// filtered natively as the user types (a name or keyword holds the query,
/// ignoring case). The keys move the highlight along the cells and down
/// the columns, Return or a press chooses (`onSelect({ emoji, base,
/// skinTone, label })`, the emoji with the app's `skinTone`), Escape clears
/// the query and then reports `onCancel`; the pointer highlights the cell
/// it moves over (`onHighlightChange`: a preview), and the group at the
/// top is reported (`onGroupChange`) for the app's tabs, which scroll with
/// the ref's `scrollToGroup`. It looks like nothing and says nothing of
/// its own: the app styles every part, draws the cells and headers
/// (`renderItem`, `renderGroup`), names the groups (`groupLabels`) and
/// fills the `header`, `footer`, `empty`, `loading`, `searchPrefix` and
/// `searchSuffix` slots. `emojiVersion` leaves out emoji the system's fonts
/// may not draw yet. Screen readers hear a list box of the emoji by name,
/// the highlighted one announced.
#[component(methods = EmojiPickerApi)]
pub fn EmojiPicker(props: EmojiPickerProps, cx: Scope<EmojiPickerEvent>) -> impl IntoElement {
    let loaded = signal(catalog().is_some());
    if !loaded.get_untracked() {
        spawn(async move {
            if data::load().await {
                loaded.set(true);
            }
        });
    }
    let own_query = signal(
        props
            .default_query
            .get_untracked()
            .map(|q| q.to_string())
            .unwrap_or_default(),
    );
    let index = computed(move || {
        let catalog = loaded.get().then(catalog).flatten();
        Indexed(catalog.map(|c| props.annotations.with(|a| Rc::new(Index::new(c, a)))))
    });
    let query = computed(move || {
        if props.searchable.get() {
            query_of(props.query, own_query).trim().to_lowercase()
        } else {
            String::new()
        }
    });
    let searching = computed(move || query.with(|q| !q.is_empty()));
    let max = computed(move || {
        let text = props.emoji_version.get()?;
        let version = Version::parse(&text);
        if version.is_none() {
            log::warn!("EmojiPicker: `emojiVersion` `{text}` is no Emoji version");
        }
        version
    });
    let narrow = stored(None::<Narrow>);
    let shown = computed(move || {
        let Some(index) = index.get().0 else {
            return Shown::default();
        };
        let Some(catalog) = catalog() else {
            return Shown::default();
        };
        let columns = props.columns.get() as usize;
        let max = max.get();
        let groups = props
            .groups
            .get()
            .unwrap_or_else(|| EmojiGroupId::ALL.to_vec());
        let query = query.get();
        if query.is_empty() {
            narrow.replace(None);
            let custom = props.render_group.with(Option::is_some);
            let sections = props.recent.with(|recent| {
                props.group_labels.with(|labels| {
                    sections(catalog, &groups, recent, max, |g| {
                        custom || labels.of(g).is_some()
                    })
                })
            });
            return Shown(Rc::new(Grid::new(&sections, columns)));
        }
        let matches = narrow.with(|last| {
            let among = last
                .as_ref()
                .filter(|n| Rc::ptr_eq(&n.index, &index) && query.contains(n.query.as_str()))
                .map(|n| n.matches.as_slice());
            let matches = matching(&index, &query, among);
            *last = Some(Narrow {
                index: index.clone(),
                query,
                matches: matches.clone(),
            });
            matches
        });
        let emoji: Vec<u32> = matches
            .into_iter()
            .filter(|&i| {
                let e = &catalog.emoji[i as usize];
                groups.contains(&e.group) && max.is_none_or(|max| e.version <= max)
            })
            .collect();
        let group = emoji.first().map_or(EmojiGroupId::SmileysEmotion, |&i| {
            catalog.emoji[i as usize].group
        });
        Shown(Rc::new(Grid::new(
            &[Section {
                group,
                emoji,
                header: false,
            }],
            columns,
        )))
    });
    let picker = Picker {
        index,
        shown,
        skin_tone: props.skin_tone,
        searching,
        highlight: signal(None),
        lit: stored(std::array::from_fn(|_| signal(None))),
        highlighted: stored(None),
        visible: stored(None),
        reveal: stored(None),
        group: stored(None),
        row_size: signal(px(ROW_ESTIMATE)),
        list: element_ref(),
        pointer: stored(None),
        cx,
    };
    // Each change of the rows: a new query highlights its first match,
    // other changes keep the highlighted emoji while it shows.
    let last_query = stored(None::<String>);
    effect(move || {
        let query = query.get();
        shown.with(|_| ());
        untracked(|| {
            let last = last_query.replace(Some(query.clone()));
            picker.follow(last.as_ref() != Some(&query), last.is_none());
        });
    });
    // Leaving a query reports the group at the top again.
    effect(move || {
        if searching.get() {
            untracked(|| picker.group.replace(None));
        }
    });

    let root = element_ref();
    let field = element_ref();
    let field_focused = signal(false);
    let root_focused = signal(false);
    let focused = computed(move || {
        if props.searchable.get() {
            field_focused.get()
        } else {
            root_focused.get()
        }
    });
    effect(move || {
        if !focused.get() {
            return;
        }
        let searchable = props.searchable.get();
        let when = if searchable {
            When::Always
        } else {
            When::NotEditing
        };
        // Left and Right are the caret's while there is a query to move it
        // in.
        let along = !searchable || !searching.get();
        let rtl = layout_rtl();
        let bind = |keys: &str, when: When, repeat: bool, f: Rc<dyn Fn()>| {
            on_key_with(
                &directed(keys, rtl),
                KeyOptions {
                    when,
                    repeat,
                    for_focus: true,
                    ..Default::default()
                },
                move |_| f(),
            );
        };
        let mut moves = vec![
            ("up", Move::Up, when),
            ("down", Move::Down, when),
            // A search field's own while it edits.
            ("home", Move::First, When::NotEditing),
            ("end", Move::Last, When::NotEditing),
        ];
        if along {
            moves.push(("left", Move::Previous, when));
            moves.push(("right", Move::Next, when));
        }
        for (keys, by, when) in moves {
            bind(keys, when, true, Rc::new(move || picker.move_by(by)));
        }
        bind(
            "pageup",
            when,
            true,
            Rc::new(move || picker.move_by(Move::PageUp(picker.page()))),
        );
        bind(
            "pagedown",
            when,
            true,
            Rc::new(move || picker.move_by(Move::PageDown(picker.page()))),
        );
        bind("enter", when, false, Rc::new(move || picker.accept()));
        if !searchable {
            bind(
                "space",
                When::NotEditing,
                false,
                Rc::new(move || picker.accept()),
            );
        }
    });
    let edited = move |text: &str| {
        if props.query.get_untracked().is_none() {
            own_query.set(text.to_owned());
        }
        cx.emit(EmojiPickerEvent::QueryChange(text.to_owned().into()));
    };
    // Escape clears a query, and with none it is `onCancel`: an unbound
    // Escape would not reach a popover around it, as a focused text field
    // only leaves the field.
    effect(move || {
        if !focused.get() {
            return;
        }
        on_key_with(
            "escape",
            KeyOptions {
                when: When::Always,
                repeat: false,
                ..Default::default()
            },
            move |_| {
                let has_query = props.searchable.get_untracked()
                    && untracked(|| !query_of(props.query, own_query).is_empty());
                if has_query {
                    edited("");
                } else {
                    cx.emit(EmojiPickerEvent::Cancel);
                }
            },
        );
    });

    cx.methods(EmojiPickerApi {
        focus: Rc::new(move || {
            if props.searchable.get_untracked() {
                field.focus();
            } else {
                root.focus();
            }
        }),
        highlight: Rc::new(move |text| {
            let cell = catalog()
                .and_then(|c| c.find(text))
                .and_then(|e| shown.with_untracked(|s| s.0.cell_of(e as u32)));
            if cell.is_some() {
                picker.set_highlight(cell, Via::Keyboard);
            }
            cell.is_some()
        }),
        scroll_to_group: Rc::new(move |group, animated| {
            let Some(row) = shown.with_untracked(|s| s.0.row_of_group(group)) else {
                return false;
            };
            picker
                .list
                .scroll_to_index(row as u32, Percentage(0.0), px(0.0), animated);
            if !searching.get_untracked() {
                picker.report_group(group);
            }
            true
        }),
        entry: Rc::new(move |text| {
            let emoji = catalog()?.find(text)?;
            picker.entry(emoji as u32)
        }),
        count: Rc::new(move || shown.with_untracked(|s| s.0.cells.len() as u32)),
    });

    let search = when(
        move || props.searchable.get(),
        move || {
            view()
                .app_class(props.search_bar_class)
                .inline_style(props.search_bar_style)
                .child(props.search_prefix.place(|e| e))
                .child(
                    input()
                        .element_ref(&field)
                        .value(move || query_of(props.query, own_query))
                        .placeholder(move || {
                            props
                                .placeholder
                                .get()
                                .map(|p| p.to_string())
                                .unwrap_or_default()
                        })
                        .auto_focus(props.auto_focus)
                        // A touch keyboard's return key chooses and keeps
                        // the field.
                        .submit_behavior(SubmitBehavior::Submit)
                        .optional_label(move || {
                            props
                                .search_accessibility_label
                                .get()
                                .or_else(|| props.accessibility_label.get())
                        })
                        .app_class(props.search_class)
                        .inline_style(move || props.search_style.get())
                        .on_focus(move || field_focused.set(true))
                        .on_blur(move || field_focused.set(false))
                        .on_change(move |text: &str| edited(text))
                        .on_submit(move |_: &str| picker.accept()),
                )
                .child(props.search_suffix.place(|e| e))
        },
    );
    let rule = when(
        move || crate::terminal::is_terminal() && props.searchable.get(),
        crate::terminal::rule_line,
    );
    effect(move || {
        if !props.searchable.get() {
            untracked(|| field_focused.set(false));
        }
    });

    let parts = Parts {
        columns: props.columns,
        row_class: props.row_class,
        row_style: props.row_style,
        item_class: props.item_class,
        item_style: props.item_style,
        group_class: props.group_class,
        group_style: props.group_style,
        group_labels: props.group_labels,
        render_item: props.render_item,
        render_group: props.render_group,
    };
    // A list of its own scroll view: a group's tab scrolls far, and the
    // core follows the target as the rows on the way are measured (a list
    // in its parent's scroll view lands where the estimates said).
    let list = virtual_list(
        move || shown.with(|s| s.0.rows.len()),
        move |at| row(picker, parts, at),
    )
    .keys(move || shown.with(|s| s.0.keys.clone()))
    .estimated_item_size(move || picker.row_size.get())
    .viewability(Viewability {
        item_visible_threshold: Some(IN_VIEW),
        ..Viewability::default()
    })
    .on_viewable_items_change(move |v: &ViewableItems| picker.viewable(v))
    .element_ref(&picker.list)
    .role(AccessibilityRole::Listbox)
    .optional_label(props.accessibility_label)
    // The picker's height left by its other parts: a list of its own
    // scroll view has no height of its content.
    .flex_grow(1.0)
    .flex_shrink(1.0)
    .min_h(px(0.0))
    .app_class(props.list_class)
    .inline_style(props.list_style);
    let loading = when(move || !loaded.get(), move || props.loading.place(|e| e));
    let empty = when(
        move || loaded.get() && shown.with(|s| s.0.cells.is_empty()),
        move || props.empty.place(|e| e),
    );
    view()
        .element_ref(&root)
        .focusable(move || !props.searchable.get())
        .on_focus(move || root_focused.set(true))
        .on_blur(move || root_focused.set(false))
        .child(props.header.place(|e| e))
        .child(search)
        .child(rule)
        .child(list)
        .child(loading)
        .child(empty)
        .child(props.footer.place(|e| e))
}

/// The row the list shows at `at`: a group's header or a row of cells.
fn row(p: Picker, parts: Parts, at: Position) -> AnyElement {
    let entry = computed(move || p.shown.with(|s| s.0.rows.get(at.index()).copied()));
    let header = computed(move || matches!(entry.get(), Some(Row::Header(_))));
    dynamic(move || {
        if header.get() {
            header_row(p, entry, parts)
        } else {
            cells_row(p, entry, parts)
        }
    })
}

/// A group's header: the app's `renderGroup`, else its heading.
fn header_row(p: Picker, entry: Memo<Option<Row>>, parts: Parts) -> AnyElement {
    let group = computed(move || {
        let Some(Row::Header(section)) = entry.get() else {
            return None;
        };
        let (id, first_row) = p
            .shown
            .with(|s| s.0.sections.get(section as usize).copied())?;
        let first = p
            .shown
            .with(|s| match s.0.rows.get(first_row as usize + 1) {
                Some(Row::Cells { start, .. }) => s.0.cells.get(*start as usize).copied(),
                _ => None,
            });
        let tone = p.skin_tone.get();
        let first = first
            .and_then(|e| catalog()?.emoji.get(e as usize).map(|e| e.with_tone(tone)))
            .unwrap_or_default();
        let label = parts
            .group_labels
            .with(|l| l.of(id).cloned())
            .unwrap_or_default();
        Some(EmojiGroup { id, label, first })
    });
    let custom = computed(move || parts.render_group.with(Option::is_some));
    view()
        .role(AccessibilityRole::Header)
        .focusable(false)
        .app_class(parts.group_class)
        .inline_style(move || parts.group_style.get())
        .child(dynamic(move || {
            if custom.get() {
                return dynamic(move || {
                    let render = parts.render_group.get()?;
                    let group = group.get()?;
                    Some(render.render(format!("group:{:?}", group.id), group))
                });
            }
            text(move || group.get().map(|g| g.label).unwrap_or_default()).into_element()
        }))
        .into_element()
}

/// A row of cells, `columns` of them: those past the row's emoji keep
/// their places, invisible.
fn cells_row(p: Picker, entry: Memo<Option<Row>>, parts: Parts) -> AnyElement {
    let span = computed(move || match entry.get() {
        Some(Row::Cells { start, len, .. }) => (start as usize, len as usize),
        _ => (0, 0),
    });
    view()
        .flex_row()
        .app_class(parts.row_class)
        .inline_style(parts.row_style)
        .on_layout(move |bounds: &Bounds<Points>| {
            let height = bounds.size.height;
            if height > px(0.0) && p.row_size.get_untracked() != height {
                p.row_size.set(height);
            }
        })
        .child(dynamic(move || {
            let columns = parts.columns.get().max(1) as usize;
            (0..columns)
                .map(|column| cell(p, span, column, parts))
                .collect::<Vec<_>>()
        }))
        .into_element()
}

/// Cell `column` of a row spanning cells `span`.
fn cell(p: Picker, span: Memo<(usize, usize)>, column: usize, parts: Parts) -> AnyElement {
    let at = computed(move || {
        let (start, len) = span.get();
        (column < len).then_some(start + column)
    });
    let emoji = computed(move || {
        at.get()
            .and_then(|c| p.shown.with(|s| s.0.cells.get(c).copied()))
    });
    let entry = computed(move || {
        p.skin_tone.get();
        p.index.with(|_| ());
        emoji.get().and_then(|e| p.entry(e))
    });
    let absent = computed(move || at.get().is_none());
    let highlighted = computed(move || at.get().is_some_and(|c| p.is_highlighted(c)));
    let label = move || entry.with(|e| e.as_ref().map(|e| e.label.clone()).unwrap_or_default());
    let desktop = is_desktop();
    let downed = stored(false);
    let choose = move || {
        if let Some(c) = at.get_untracked() {
            p.choose(c);
        }
    };
    let custom = computed(move || parts.render_item.with(Option::is_some));
    view()
        .role(AccessibilityRole::Option)
        .focusable(false)
        .label(label)
        .accessibility_elements_hidden(absent)
        .style_when(absent, |s| s.invisible())
        .project_focused(highlighted)
        .when(!crate::terminal::is_terminal(), |v| {
            v.app_class(parts.item_class)
                .inline_style(move || parts.item_style.get())
        })
        .on_mouse_move(move |e: &MouseEvent| {
            if e.pressed_button.is_none()
                && let Some(c) = at.get_untracked()
            {
                p.hovered(c, e.page_position);
            }
        })
        // The desktops choose as the button goes down, so the search field
        // keeps the keyboard focus.
        .on(EventKind::PressDown, move |_: &EventPayload| {
            if desktop {
                downed.replace(true);
                choose();
            }
        })
        .on_press(move || {
            if !downed.replace(false) {
                choose();
            }
        })
        .child(dynamic(move || {
            if custom.get() {
                return dynamic(move || {
                    let render = parts.render_item.get()?;
                    let entry = entry.get()?;
                    Some(render.render(format!("item:{}", entry.base), entry))
                });
            }
            text(move || entry.with(|e| e.as_ref().map(|e| e.emoji.clone()).unwrap_or_default()))
                .into_element()
        }))
        .into_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index() -> Index {
        Index::new(catalog().unwrap(), &[])
    }

    #[test]
    fn queries_match_names_and_keywords() {
        let catalog = catalog().unwrap();
        let ix = index();
        let names = |q: &str| -> Vec<&str> {
            matching(&ix, q, None)
                .into_iter()
                .map(|i| &*catalog.emoji[i as usize].emoji)
                .collect()
        };
        assert!(names("thumbs up").contains(&"👍"));
        // A keyword, not in the name.
        assert!(names("cheerful").contains(&"😀"));
        assert!(names("zzzz no such").is_empty());
    }

    #[test]
    fn the_apps_annotations_match_beside_english() {
        let catalog = catalog().unwrap();
        let annotations = [EmojiAnnotation::new("👍", "赞").keywords(["好"])];
        let ix = Index::new(catalog, &annotations);
        let thumbs = catalog.find("👍").unwrap() as u32;
        assert_eq!(matching(&ix, "赞", None), [thumbs]);
        assert!(matching(&ix, "好", None).contains(&thumbs));
        assert!(matching(&ix, "thumbs up", None).contains(&thumbs));
        assert_eq!(ix.annotations[&thumbs].0, "赞");
    }

    #[test]
    fn a_word_that_starts_with_the_query_ranks_first() {
        let catalog = catalog().unwrap();
        let ix = index();
        let found = matching(&ix, "cat", None);
        let at = |e: &str| {
            let i = catalog.find(e).unwrap() as u32;
            found.iter().position(|&f| f == i).unwrap()
        };
        // A cat's name, before a keyword holding it (`intoxicated`).
        assert!(at("🐈") < at("🥴"));
        assert!(at("😺") < at("🥴"));
        let first = &catalog.emoji[found[0] as usize];
        assert!(
            first.label.split(' ').any(|w| w.starts_with("cat")),
            "{}",
            first.label
        );
    }

    #[test]
    fn a_longer_query_searches_the_last_ones_matches() {
        let ix = index();
        let face = matching(&ix, "face", None);
        let grinning = matching(&ix, "grinning face", Some(&face));
        assert_eq!(grinning, matching(&ix, "grinning face", None));
    }

    #[test]
    fn sections_follow_groups_recent_and_the_newest_version() {
        let catalog = catalog().unwrap();
        let recent: Vec<SharedString> =
            vec!["👍🏽".into(), "👍".into(), "not an emoji".into(), "😀".into()];
        let all = sections(catalog, &EmojiGroupId::ALL, &recent, None, |g| {
            g != EmojiGroupId::Flags
        });
        assert_eq!(all.len(), 10);
        let thumbs = catalog.find("👍").unwrap() as u32;
        let grin = catalog.find("😀").unwrap() as u32;
        assert_eq!(all[0].emoji, [thumbs, grin]);
        assert!(all[0].header && !all[9].header);
        let count: usize = all[1..].iter().map(|s| s.emoji.len()).sum();
        assert_eq!(count, catalog.emoji.len());
        let old = sections(
            catalog,
            &[EmojiGroupId::SmileysEmotion],
            &[],
            Version::parse("12"),
            |_| true,
        );
        assert!(old[0].emoji.len() < all[1].emoji.len());
        assert!(
            old[0]
                .emoji
                .iter()
                .all(|&i| catalog.emoji[i as usize].version <= Version::parse("12").unwrap())
        );
    }
}
