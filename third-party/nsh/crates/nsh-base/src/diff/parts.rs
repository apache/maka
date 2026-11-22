//! The parts of a [`super::DiffView`] the app styles: Tailwind classes
//! ([`DiffViewClasses`]) and inline styles ([`DiffViewStyles`]) by part,
//! over the view's defaults (the theme's tokens, green and red tints).

use nsh_core::{element::Style, prelude::*};

use crate::text_view::PartStyle;

macro_rules! parts {
    ($( $(#[doc = $doc:literal])* $field:ident => $variant:ident ),* $(,)?) => {
        /// Tailwind classes of a `DiffView`'s parts
        /// (`classes={{ lineAdded: "bg-green-500/10" }}`), after the part's
        /// own styles: at equal rank they win.
        #[derive(Debug, Clone, Default, PartialEq, JsObject)]
        #[non_exhaustive]
        pub struct DiffViewClasses {
            $( $(#[doc = $doc])* #[prop(skip_none)] pub $field: Option<SharedString>, )*
        }

        /// Inline styles of a `DiffView`'s parts, over its classes.
        #[derive(Debug, Clone, Default, PartialEq, JsObject)]
        #[non_exhaustive]
        pub struct DiffViewStyles {
            $( $(#[doc = $doc])* #[prop(skip_none)] pub $field: Option<PartStyle>, )*
        }

        /// A part of a [`super::DiffView`].
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        #[non_exhaustive]
        pub enum DiffViewPart {
            $( $(#[doc = $doc])* $variant, )*
        }

        impl DiffViewClasses {
            pub(crate) fn get(&self, part: DiffViewPart) -> Option<&SharedString> {
                match part {
                    $( DiffViewPart::$variant => self.$field.as_ref(), )*
                }
            }
        }

        impl DiffViewStyles {
            pub(crate) fn get(&self, part: DiffViewPart) -> Option<&Style> {
                match part {
                    $( DiffViewPart::$variant => self.$field.as_ref().map(|s| &s.0), )*
                }
            }
        }
    };
}

parts! {
    /// Each side (split) or the one column (unified): its gutter and text.
    side => Side,
    /// The gutter of a side: its line numbers and change indicators.
    gutter => Gutter,
    /// Every line number (muted, right-aligned).
    line_number => LineNumber,
    /// The numbers of added lines, after `lineNumber`.
    line_number_added => LineNumberAdded,
    /// The numbers of deleted lines, after `lineNumber`.
    line_number_deleted => LineNumberDeleted,
    /// The text of a side, beside its gutter (its padding is the room
    /// around the text).
    content => Content,
    /// Every row of a side.
    line => Line,
    /// Added lines' rows, after `line` (a green tint).
    line_added => LineAdded,
    /// Deleted lines' rows, after `line` (a red tint).
    line_deleted => LineDeleted,
    /// The empty half of a split row whose other side changed (a faint
    /// fill).
    filler => Filler,
    /// The words changed within an added line (a stronger green).
    word_added => WordAdded,
    /// The words changed within a deleted line (a stronger red).
    word_deleted => WordDeleted,
    /// The bar at the gutter's edge of an added line (`indicators="bars"`),
    /// or its `+` (`"classic"`).
    indicator_added => IndicatorAdded,
    /// The bar of a deleted line (`"bars"`), or its `−` (`"classic"`).
    indicator_deleted => IndicatorDeleted,
    /// A separator of collapsed unchanged lines (or a patch's hunk header),
    /// across the view.
    separator => Separator,
    /// The box of the app's hunk actions (`renderHunkActions`), at the top
    /// right of a change.
    hunk_actions => HunkActions,
    /// Over the selected lines' rows of their side, gutter and text (a
    /// faint tint of the theme's `primary`).
    line_selected => LineSelected,
    /// The box of an annotation (`renderAnnotation`), under its line
    /// across its side.
    annotation => Annotation,
    /// The box of the add control (`renderAddAnnotation`), as wide as the
    /// gutter and as tall as a line, the control at its right.
    add_annotation => AddAnnotation,
    /// The header of a file of a patch (the path and counts on
    /// `secondary`), across the view.
    file_header => FileHeader,
}
