//! `Avatar` and `AvatarGroup`: a person's picture, or a fallback while it
//! loads or when it fails, and a stack of them that shows the first few,
//! with no look of their own (`gpui-base`'s `Avatar`, `AvatarImage` and
//! `AvatarFallback`; `gpui-component`'s `Avatar` and `AvatarGroup`).

use std::time::Duration;

use nsh_core::{
    element::{ImageSrc, Style},
    prelude::*,
};

/// Where an avatar's image is (`onStatusChange`'s `status`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum AvatarStatus {
    /// No image: the avatar has no `src`.
    #[default]
    Idle,
    /// The image is loading.
    Loading,
    /// The image loaded and shows.
    Loaded,
    /// The image failed to load.
    Error,
}

/// The props of [`Avatar`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct AvatarProps {
    /// The picture: a URL, an `asset:/` URI, a `data:` URI or an imported
    /// image. It shows once it has loaded; the fallback shows while it
    /// loads (after `fallbackDelay`), when it fails, and without one.
    pub src: Prop<Option<ImageSrc>>,
    /// The person's name: what screen readers say (unless
    /// `accessibilityLabel` says otherwise), and the fallback's initials
    /// when the app passes no `fallback` (the first letters of the first
    /// two words, upper case: "Ada Lovelace" is "AL"; a single word gives
    /// its first two letters, "huacnlee" is "HU", or in a script without
    /// letter case its first character).
    pub name: Prop<Option<SharedString>>,
    /// What screen readers say, over `name`. An empty one makes the avatar
    /// decorative, hidden from screen readers (a picture beside the name
    /// it shows, as HTML's `alt=""`).
    pub accessibility_label: Prop<Option<SharedString>>,
    /// Milliseconds the fallback waits while the image loads (default 0):
    /// an image that loads within it shows without the fallback flashing
    /// first. Without an image, or once it fails, the fallback shows at
    /// once.
    #[prop(default)]
    pub fallback_delay: Prop<f64>,
    /// The Tailwind classes of the image, over the avatar's box: its fit,
    /// radius and motion (a `transition-opacity` fades it in once loaded,
    /// as it goes from transparent to opaque; an `opacity-*` class here
    /// wins over that).
    pub image_class: Prop<Option<SharedString>>,
    /// The style of the image, over `imageClass`.
    #[prop(default)]
    pub image_style: Prop<Style>,
    /// The Tailwind classes of the fallback, the part that holds the
    /// initials or the app's `fallback`, as large as the avatar: its
    /// background, text color and size, and the alignment of its content.
    pub fallback_class: Prop<Option<SharedString>>,
    /// The style of the fallback, over `fallbackClass`.
    #[prop(default)]
    pub fallback_style: Prop<Style>,
    /// The content of the fallback in place of the initials: an icon, a
    /// placeholder for someone without a name (`gpui-component`'s
    /// `placeholder`).
    pub fallback: Prop<Option<Slot>>,
    /// What shows over the picture: a presence dot, a badge, placed by the
    /// app (`absolute bottom-0 right-0`).
    pub children: Prop<Children>,
}

/// The events of an [`Avatar`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum AvatarEvent {
    /// The image's status changed: it started loading, loaded, failed, or
    /// the avatar has none any more (Radix's `onLoadingStatusChange`).
    #[args(status)]
    StatusChange(AvatarStatus),
}

/// A person's picture, or a fallback (initials, an icon) while it loads,
/// when it fails, and when there is none (a member of a team, the author of
/// a comment, the account in a header). It owns the image's loading state
/// natively (the image's load and error events change it, with no JS) and
/// what screen readers get (an image labelled with the person's name), and
/// leaves its look to the app: no size, shape, colors or font of its own.
/// Its parts are the fallback and the image over it, both as large as the
/// avatar, then its children; the app's `class` and `style` size and shape
/// the avatar, `imageClass` / `imageStyle` and `fallbackClass` /
/// `fallbackStyle` the parts. The image is transparent until it has
/// loaded, then the fallback goes: a loading or failed image changes those
/// two parts and nothing else. The avatar's size is the app's (`size-10`):
/// both parts fill it, so the fallback leaving lays nothing out again.
#[component]
pub fn Avatar(props: AvatarProps, cx: Scope<AvatarEvent>) -> impl IntoElement {
    // An empty URL is no image, as `<Image>`'s.
    let src = computed(move || props.src.get().filter(|src| !src.is_empty()));
    let status = signal(match src.get_untracked() {
        Some(_) => AvatarStatus::Loading,
        None => AvatarStatus::Idle,
    });
    let reported = stored(AvatarStatus::Idle);
    let set_status = move |next: AvatarStatus| {
        status.set(next);
        if reported.with(|r| *r != next) {
            reported.replace(next);
            cx.emit(AvatarEvent::StatusChange(next));
        }
    };
    // A new source loads from the start (its own load events follow).
    effect(move || {
        let next = match src.get() {
            Some(_) => AvatarStatus::Loading,
            None => AvatarStatus::Idle,
        };
        untracked(|| set_status(next));
    });
    // The delay holds the fallback back while the image loads. A timer
    // that a load, a failure or a new source overtook does nothing.
    let waits = |status: AvatarStatus, delay: f64| status == AvatarStatus::Loading && delay > 0.0;
    let waited = signal(!waits(
        status.get_untracked(),
        props.fallback_delay.get_untracked(),
    ));
    let generation = stored(0u64);
    effect(move || {
        let delay = props.fallback_delay.get();
        let waiting = waits(status.get(), delay);
        let current = generation.with(|g| {
            *g += 1;
            *g
        });
        untracked(|| waited.set(!waiting));
        if waiting {
            set_timeout(Duration::from_secs_f64(delay / 1000.0), move || {
                if generation.get() == current {
                    waited.set(true);
                }
            });
        }
    });
    let loaded = computed(move || status.get() == AvatarStatus::Loaded);
    let shows_fallback = computed(move || !loaded.get() && waited.get());
    let label = computed(move || props.accessibility_label.get().or_else(|| props.name.get()));
    let decorative = computed(move || label.get().is_none_or(|l| l.is_empty()));

    view()
        .accessible(move || !decorative.get())
        .accessibility_elements_hidden(decorative)
        .role(AccessibilityRole::Image)
        .optional_label(move || label.get().filter(|l| !l.is_empty()))
        .child(when(shows_fallback, move || {
            view()
                .size_full()
                // The avatar says the name once: its initials are not read
                // apart.
                .accessibility_elements_hidden(true)
                .app_class(props.fallback_class)
                .inline_style(props.fallback_style)
                .child(props.fallback.place(|content| content))
                .child(when(
                    move || props.fallback.get().is_none(),
                    move || text(move || initials(&props.name.get().unwrap_or_default())),
                ))
        }))
        .child(dynamic(move || {
            src.get().map(|src| {
                image(src)
                    .absolute()
                    .inset_0()
                    // Laid out (it loads once it has a frame) and
                    // transparent until it has loaded.
                    .opacity(move || if loaded.get() { 1.0_f32 } else { 0.0 })
                    .accessibility_elements_hidden(true)
                    .app_class(props.image_class)
                    .inline_style(props.image_style)
                    .on_load_start(move || set_status(AvatarStatus::Loading))
                    .on_load(move |_: &Size<DevicePixels>| set_status(AvatarStatus::Loaded))
                    .on_error(move |_: &str| set_status(AvatarStatus::Error))
            })
        }))
        .child(props.children)
}

/// The initials of `name`, as `gpui-component`'s avatar takes them: the
/// first characters of its first two words, upper case; a single word
/// gives its first two letters, or in a script without letter case (Han,
/// Kana, Hangul) its first character, which stands for a name there.
pub(crate) fn initials(name: &str) -> String {
    let mut words = name.split_whitespace();
    let Some(first) = words.next() else {
        return String::new();
    };
    let lead = |word: &str| word.chars().next();
    let picked: String = match words.next() {
        Some(second) => lead(first).into_iter().chain(lead(second)).collect(),
        None => {
            let cased = lead(first).is_some_and(|c| c.is_lowercase() || c.is_uppercase());
            first.chars().take(if cased { 2 } else { 1 }).collect()
        }
    };
    picked.to_uppercase()
}

/// The props of [`AvatarGroup`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct AvatarGroupProps {
    /// At most this many of its avatars show, the first ones (default 3,
    /// as `gpui-component`'s); the others stay out of the tree.
    #[prop(default = 3)]
    pub limit: Prop<u32>,
    /// How many people the group stands for, when the app passes only the
    /// first of them as children (a long list: only the avatars shown are
    /// made). By default the number of its children.
    pub total: Prop<Option<u32>>,
    /// What screen readers say of the group ("Ada, Grace and 5 others").
    pub accessibility_label: Prop<Option<SharedString>>,
    /// The Tailwind classes of the overflow part, after the avatars shown.
    pub overflow_class: Prop<Option<SharedString>>,
    /// The style of the overflow part, over `overflowClass`.
    #[prop(default)]
    pub overflow_style: Prop<Style>,
    /// What screen readers say of the overflow part in place of its
    /// content ("5 more people" for a "+5"); without it they read the
    /// content.
    pub overflow_accessibility_label: Prop<Option<SharedString>>,
    /// What stands for the people not shown, the count of them ("+5"; in
    /// `gpui-component` a "⋯" avatar, `ellipsis`), after the avatars while
    /// more than they are in the group; the app writes it, as it knows the
    /// count (`total - limit`).
    pub overflow: Prop<Option<Slot>>,
    /// The avatars, in order.
    pub children: Prop<Children>,
}

/// A row of avatars that shows the first few and stands for the rest (the
/// members of a project, the people in a thread). It decides which of its
/// avatars are in the tree (the first `limit`; the others make no views)
/// and when the overflow shows, and tells screen readers it is a group; its
/// look is the app's: the overlap (a negative margin on the avatars, or
/// `-space-x-*`), the rings and the overflow's shape. The app's `class` and
/// `style` lay the row out, `overflowClass` / `overflowStyle` style the
/// overflow part, `overflow` is its content and
/// `overflowAccessibilityLabel` what screen readers say of it.
#[component]
pub fn AvatarGroup(props: AvatarGroupProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let limit = move || props.limit.get() as usize;
    // The number of children, as their positions count them.
    let count = signal(0usize);
    let children = computed(move || match props.children.get().is_empty() {
        true => 0,
        false => count.get(),
    });
    let shown = computed(move || children.get().min(limit()));
    let total = computed(move || {
        props
            .total
            .get()
            .map_or_else(|| children.get(), |t| t as usize)
    });
    let more = computed(move || total.get() > shown.get() && props.overflow.get().is_some());

    view()
        .role(AccessibilityRole::Group)
        .optional_label(props.accessibility_label)
        .children_each(props.children, move |child, at| {
            effect(move || {
                let n = at.count();
                untracked(|| count.set(n));
            });
            when(move || at.index() < limit(), move || child)
        })
        .child(when(more, move || {
            view()
                .accessible(move || props.overflow_accessibility_label.get().is_some())
                .optional_label(props.overflow_accessibility_label)
                .app_class(props.overflow_class)
                .inline_style(props.overflow_style)
                .child(props.overflow.place(|content| content))
        }))
}

#[cfg(test)]
mod tests {
    use super::initials;

    #[test]
    fn initials_are_those_gpui_component_takes() {
        assert_eq!(initials("Jason Lee"), "JL");
        assert_eq!(initials("Foo Bar Dar"), "FB");
        assert_eq!(initials("huacnlee"), "HU");
        assert_eq!(initials("  ada   lovelace "), "AL");
        assert_eq!(initials("Ω"), "Ω");
        assert_eq!(initials(""), "");
    }

    #[test]
    fn a_name_in_a_script_without_case_gives_its_first_character() {
        assert_eq!(initials("王小明"), "王");
        assert_eq!(initials("さくら"), "さ");
        assert_eq!(initials("José Álvarez"), "JÁ");
    }
}
