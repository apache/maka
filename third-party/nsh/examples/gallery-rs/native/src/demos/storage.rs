//! Storage: the app's key-value storage from Rust (`nsh_core::storage`,
//! the entries `nsh/storage` keeps for JS): a count of this demo's
//! openings, a note saved as it is typed, and every key the app keeps (the
//! gallery's own last demo among them), all still there after a restart
//! (as the TSX gallery's `demos/Storage.tsx`).

use nsh_base::{alert_dialog, input};
use nsh_core::{element::AnyElement, prelude::*, storage::Storage};

use crate::ui::{
    Badge, Button, ButtonVariant, Card, DemoPage, Figure, Finish, Finished, IconName, MONO, Row,
    Tone, caption, colors, icon, radius,
};

const LAUNCHES: &str = "launches";
const NOTE: &str = "note";

/// A stored key and its value's length.
type Entry = (String, usize);

/// A length as JS counts it (UTF-16 code units), as the TSX gallery shows
/// it.
fn length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Every stored key and its value's length, in order.
fn entries() -> Vec<Entry> {
    Storage::get_all_keys()
        .into_iter()
        .map(|key| {
            let length = Storage::get_item(&key).map_or(0, |v| length(&v));
            (key, length)
        })
        .collect()
}

/// What the note's last write did.
#[derive(Debug, Clone, Copy, PartialEq)]
enum NoteState {
    Idle,
    Saved,
    Failed,
}

/// The launch count: read as the demo opens, kept one higher.
fn launches_card(count: ReadSignal<u32>) -> AnyElement {
    Card::new()
        .icon(IconName::Storage)
        .title("Launches")
        .subtitle("Counted each time this demo opens")
        .right(Badge::new("Kept").tone(Tone::Up))
        .child(Figure::new(move || count.get().to_string()).unit(move || {
            if count.get() == 1 {
                "opening"
            } else {
                "openings"
            }
        }))
        .child(
            text(move || format!("set_item(\"{LAUNCHES}\", \"{}\")", count.get()))
                .text_size(px(12.0))
                .text_color(colors::MUTED)
                .font_family(MONO),
        )
        .into_element()
}

/// The note, saved as it is typed.
fn note_card(
    value: ReadSignal<String>,
    saved: ReadSignal<NoteState>,
    write: impl Fn(&str) + 'static,
) -> AnyElement {
    let hint = move || match saved.get() {
        NoteState::Idle => "",
        NoteState::Saved => "Saved",
        NoteState::Failed => "Not saved",
    };
    Card::new()
        .icon(IconName::Form)
        .title("Note")
        .subtitle("Saved as you type, back when the demo opens again")
        .child(
            view()
                .rounded(px(radius::CONTROL))
                .border_curve(BorderCurve::Continuous)
                .border_1()
                .border_color(colors::BORDER)
                .bg(colors::INSET)
                .finish(Finish::Inset)
                .child(
                    input()
                        .multiline(true)
                        .value(move || value.get())
                        .on_change(move |text: &str| write(text))
                        .placeholder("Write something, then come back to it")
                        .placeholder_color(|| color(colors::FAINT))
                        .selection_color(|| color(colors::ACCENT))
                        .label("Note")
                        .h(px(120.0))
                        .px(px(14.0))
                        .pt(px(12.0))
                        .pb(px(12.0))
                        .text_size(px(15.0))
                        .text_color(colors::TEXT),
                ),
        )
        .child(
            view()
                .flex_row()
                .items_center()
                .gap(px(6.0))
                .min_h(px(16.0))
                .child(when(
                    move || saved.get() == NoteState::Saved,
                    || icon().name(IconName::Check).size(14.0).tint(colors::UP),
                ))
                .child(text(hint).flex_1().text_size(px(12.0)).text_color(
                    move || match saved.get() {
                        NoteState::Failed => colors::DANGER,
                        NoteState::Saved => colors::UP,
                        NoteState::Idle => colors::FAINT,
                    },
                ))
                .child(
                    text(move || format!("{} chars", value.with(|v| length(v))))
                        .text_size(px(12.0))
                        .text_color(colors::FAINT)
                        .tabular_nums(),
                ),
        )
        .into_element()
}

/// Every stored key with its value's length; "Clear all" asks first.
fn keys_card(entries: ReadSignal<Vec<Entry>>, clear_all: impl Fn() + 'static) -> AnyElement {
    let count = move || entries.with(Vec::len);
    let total = move || {
        entries.with(|e| {
            e.iter()
                .map(|(key, value)| length(key) + value)
                .sum::<usize>()
        })
    };
    let rows = each(
        move || entries.get(),
        |entry: &Entry| entry.0.clone(),
        |entry, i| {
            Row::new(i.get_untracked() == 0)
                .child(
                    text(entry.with_untracked(|e| e.0.clone()))
                        .number_of_lines(1)
                        .flex_1()
                        .text_size(px(14.0))
                        .text_color(colors::TEXT)
                        .font_family(MONO),
                )
                .child(
                    text(move || format!("{} chars", entry.with(|e| e.1)))
                        .text_size(px(13.0))
                        .text_color(colors::MUTED)
                        .tabular_nums(),
                )
        },
    );
    Card::new()
        .icon(IconName::Lists)
        .title("Stored keys")
        .subtitle("get_all_keys() and each value's length")
        .child(view().child(rows))
        .child(when(
            move || count() == 0,
            || caption("Nothing stored", None::<&str>),
        ))
        .child(caption(
            move || {
                let n = count();
                format!("{n} {}", if n == 1 { "key" } else { "keys" })
            },
            Some(move || format!("{} chars of 5 MB", total())),
        ))
        .child(
            Button::new("Clear all", move |_: &()| clear_all())
                .variant(ButtonVariant::Secondary)
                .disabled(Prop::bind(move || count() == 0)),
        )
        .child(
            text(
                "The data stays on this device and survives restarts, under the app's id from \
                 nsh.json.",
            )
            .text_size(px(12.0))
            .text_color(colors::FAINT),
        )
        .into_element()
}

/// The demo's page.
#[component]
pub(crate) fn StorageDemo() -> impl IntoElement {
    // Counted once per opening: here, not in a card, which the desktop
    // layout makes again when its columns change. The write is in memory at
    // once and reaches the disk in the background.
    let opened = Storage::get_item(LAUNCHES)
        .and_then(|n| n.parse::<u32>().ok())
        .unwrap_or(0)
        + 1;
    if let Err(full) = Storage::set_item(LAUNCHES, opened.to_string()) {
        log::warn!("{full}");
    }
    let launches = signal(opened);
    let value = signal(Storage::get_item(NOTE).unwrap_or_default());
    let saved = signal(NoteState::Idle);
    let stored = signal(entries());
    let write = move |text: &str| {
        value.set(text.to_owned());
        if text.is_empty() {
            Storage::remove_item(NOTE);
            saved.set(NoteState::Saved);
        } else {
            saved.set(match Storage::set_item(NOTE, text) {
                Ok(()) => NoteState::Saved,
                Err(_) => NoteState::Failed,
            });
        }
        stored.set(entries());
    };
    let owner = Owner::current();
    let clear_all = move || {
        let chosen = alert_dialog()
            .title("Clear the storage?")
            .description(
                "Removes every key the gallery keeps, the launch count and the note among them.",
            )
            .cancel("Cancel")
            .destructive("Clear")
            .close_on_escape(true)
            .close_on_backdrop_press(true)
            .show();
        owner.run(|| {
            spawn(async move {
                if chosen.await != Ok(Some("Clear".into())) {
                    return;
                }
                Storage::clear();
                launches.set(0);
                value.set(String::new());
                saved.set(NoteState::Idle);
                stored.set(entries());
            })
        });
    };
    DemoPage::new()
        .card(move || launches_card(launches.read_only()))
        .card(move || note_card(value.read_only(), saved.read_only(), write))
        .card(move || keys_card(stored.read_only(), clear_all))
}
