//! `nsh/base`'s components in a Rust app, run headless (`nsh_testing`):
//! what a user does with them and what the app hears and shows.

mod accordion;
mod alert_dialog;
mod avatar;
mod button;
mod calendar;
mod carousel;
mod checkbox;
mod collapsible;
mod color_picker;
mod combobox;
mod command;
mod data_table;
mod date_picker;
mod dialog;
mod diff;
mod dock;
mod dropdown_presence;
mod editor;
mod editor_completion;
mod editor_definition;
mod editor_diagnostics;
mod editor_languages;
#[cfg(feature = "emoji-picker")]
mod emoji_picker;
mod focus_within;
mod hover_card;
mod link;
mod menu;
mod menu_list;
mod menu_presentation;
mod menu_room;
mod menu_typeahead;
mod number_input;
mod otp_input;
mod pagination;
mod plot;
mod popups;
mod radio;
mod resizable;
mod rich_editor;
mod rust_root;
mod scrollbar;
mod select;
mod sheet;
mod slider;
mod split_view;
mod submenu;
mod switch;
mod tabs;
#[cfg(feature = "term")]
mod term;
#[cfg(feature = "term")]
mod term_cells;
#[cfg(feature = "term")]
mod term_input;
mod terminal;
mod text_view;
mod time_field;
mod toast;
mod toggle;
mod toolbar;
mod tree;
