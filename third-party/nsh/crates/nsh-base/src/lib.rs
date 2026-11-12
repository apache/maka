//! `nsh/base`: the behavior and infrastructure foundation of NSH apps' UI,
//! written in Rust, with no look of its own (as `gpui-base` is GPUI Kit's):
//! controls (`Button`, a link (`Link`), `Checkbox`, avatars (`Avatar`, `AvatarGroup`), a carousel (`Carousel` and its parts), a color picker: `ColorPicker` and its parts, `NumberInput`, `Radio` in a
//! `RadioGroup`, `Slider`, `Switch`, `Toggle` in a `ToggleGroup`, a bar of them and of buttons and links (`Toolbar`, `ToolbarGroup`, `ToolbarSeparator`), a scroll bar of the app's own look (`Scrollbar`), `Tab` in `Tabs`, `Select`, `Combobox`, a command palette (`Command`), an emoji picker (`EmojiPicker`), a one-time code: `OtpInput`), the pages of a set (`Pagination`), items that hold items (`Tree`), a progress bar (`Progress`), disclosure (`Collapsible`, `Accordion` and its parts),
//! the parts of charts (`plot`: `nsh/base/plot`), navigation (stacks and pages), dialogs, popups on the core's overlays
//! (`Popover`, `HoverCard`, `Menu`, `ContextMenu`, `Tooltip`, `Sheet`), a code editor
//! (`Editor`), the changes between two texts (`DiffView`), tables over any number of rows and columns (`DataTable`) and static tables
//! with a table's semantics (`Table` and its parts), toasts (`Toast`,
//! `ToastStack`, `ToastManager`), text input (`Input`), the system's
//! dialogs, and the theme's semantic
//! tokens (`Theme`, as `gpui-base`'s).
//!
//! What it renders lays out or tells the platform, never styles: the look
//! of an app is the app's, drawn with nsh's primitives or the components of
//! its own crate. Its JS face (the `nsh/base` export and its TypeScript
//! declarations) is generated from the components' props and events and the
//! modules' functions. Every host serves it.

mod accordion;
mod alert_dialog;
#[cfg(any(feature = "editor", feature = "rich-editor"))]
mod autoscroll;
mod avatar;
mod button;
mod calendar;
mod carousel;
mod checkbox;
mod collapsible;
mod color_picker;
mod combobox;
mod command;
pub mod data_table;
mod date_picker;
#[cfg(feature = "editor")]
mod diff;
pub mod dock;
#[cfg(feature = "editor")]
pub mod editor;
#[cfg(feature = "emoji-picker")]
mod emoji_picker;
mod hover_card;
mod keys;
mod link;
mod link_hint;
mod listbox;
mod menu;
mod navigation;
mod number_input;
mod numeric;
mod otp_input;
mod pagination;
#[cfg(feature = "plot")]
pub mod plot;
mod popover;
mod popup;
mod progress;
mod radio;
mod resizable;
#[cfg(feature = "rich-editor")]
pub mod rich_editor;
mod roving;
mod scrollbar;
mod select;
mod sheet;
mod slider;
mod sort;
mod status_line;
mod switch;
mod syntax;
mod table;
mod tabs;
#[cfg(feature = "term")]
mod term;
pub mod terminal;
pub mod text_view;

/// `EmojiPicker`'s emoji (`emoji_picker/emoji.tsv`): the native runtimes
/// embed them; `nsh` publishes them next to a web runtime, which fetches
/// them for its first picker.
#[cfg(all(feature = "emoji-picker", not(target_arch = "wasm32")))]
#[doc(hidden)]
pub use crate::emoji_picker::EMOJI_DATA;

/// The KaTeX fonts `TextView` draws formulas with, in one file,
/// zstd-compressed (about 230 kB of 500 kB; license in
/// `fonts/katex.LICENSE.txt`). The native runtimes embed them; `nsh` publishes
/// them next to a web runtime, which fetches them for its first formula.
#[cfg(not(target_arch = "wasm32"))]
#[doc(hidden)]
pub const MATH_FONTS: &[u8] = include_bytes!("../fonts/katex.pack.zst");
mod theme;
mod time_field;
mod toast;
mod toggle;
mod toolbar;
mod tooltip;
mod tree;
mod window;

use std::sync::Arc;

use nsh_core::element::{ComponentSpec, Registry};
/// `Input`, the native text input (UITextField / UITextView, EditText):
/// TSX's `Input` of `nsh/base`, a host element the core makes.
pub use nsh_core::element::{Input, input};

#[cfg(feature = "emoji-picker")]
pub use crate::emoji_picker::{
    EmojiAnnotation, EmojiEntry, EmojiGroup, EmojiGroupId, EmojiGroupLabels, EmojiPicker,
    EmojiPickerApi, EmojiPickerElement, EmojiPickerEvent, EmojiPickerProps, EmojiSkinTone,
    emoji_picker,
};
#[cfg(feature = "term")]
pub use crate::term::{
    Terminal, TerminalApi, TerminalColor, TerminalCursor, TerminalElement, TerminalEmulator,
    TerminalEmulatorEvent, TerminalEmulatorFactory, TerminalEvent, TerminalLine, TerminalModes,
    TerminalProps, TerminalRun, TerminalSize, TerminalStyle, VtEmulator, terminal,
};
pub use crate::{
    accordion::{
        Accordion, AccordionElement, AccordionEvent, AccordionHeader, AccordionHeaderElement,
        AccordionHeaderProps, AccordionItem, AccordionItemElement, AccordionItemProps,
        AccordionPanel, AccordionPanelElement, AccordionPanelProps, AccordionProps,
        AccordionTrigger, AccordionTriggerElement, AccordionTriggerProps, accordion,
        accordion_header, accordion_item, accordion_panel, accordion_trigger,
    },
    alert_dialog::{
        AlertDialog, AlertDialogAction, AlertDialogOptions, AlertDialogPresentation,
        AlertDialogResult, AlertDialogRole, alert_dialog,
    },
    avatar::{
        Avatar, AvatarElement, AvatarEvent, AvatarGroup, AvatarGroupElement, AvatarGroupProps,
        AvatarProps, AvatarStatus, avatar, avatar_group,
    },
    button::{Button, ButtonElement, ButtonEvent, ButtonProps, button},
    calendar::{
        Calendar, CalendarElement, CalendarEntry, CalendarEvent, CalendarItemKind, CalendarProps,
        CalendarValue, Date, Matcher, YearRange, calendar,
    },
    carousel::{
        Carousel, CarouselContent, CarouselContentElement, CarouselContentProps,
        CarouselControlProps, CarouselElement, CarouselEvent, CarouselItem, CarouselItemElement,
        CarouselItemProps, CarouselNext, CarouselNextElement, CarouselPagination,
        CarouselPaginationElement, CarouselPaginationItem, CarouselPaginationItemElement,
        CarouselPaginationItemProps, CarouselPaginationProps, CarouselPrevious,
        CarouselPreviousElement, CarouselProps, carousel, carousel_content, carousel_item,
        carousel_next, carousel_pagination, carousel_pagination_item, carousel_previous,
    },
    checkbox::{Checkbox, CheckboxElement, CheckboxEvent, CheckboxProps, checkbox},
    collapsible::{Collapsible, CollapsibleElement, CollapsibleProps, collapsible},
    color_picker::{
        ColorArea, ColorAreaElement, ColorAreaProps, ColorChannel, ColorEyeDropper,
        ColorEyeDropperElement, ColorEyeDropperEvent, ColorEyeDropperProps, ColorField,
        ColorFieldElement, ColorFieldProps, ColorFormat, ColorPicker, ColorPickerElement,
        ColorPickerEvent, ColorPickerProps, ColorSlider, ColorSliderElement, ColorSliderProps,
        ColorSpace, ColorSwatch, ColorSwatchElement, ColorSwatchEvent, ColorSwatchProps,
        color_area, color_eye_dropper, color_field, color_picker, color_slider, color_swatch,
    },
    combobox::{Combobox, ComboboxElement, ComboboxEvent, ComboboxProps, combobox},
    command::{
        Command, CommandApi, CommandElement, CommandEntry, CommandEvent, CommandGroup, CommandItem,
        CommandProps, command,
    },
    data_table::{
        DataTable, DataTableAlign, DataTableApi, DataTableCell, DataTableClasses, DataTableColumn,
        DataTableColumnGroup, DataTableColumnMove, DataTableContextMenu, DataTableDump,
        DataTableElement, DataTableEvent, DataTableHeaderCell, DataTablePart, DataTablePress,
        DataTableProps, DataTableRange, DataTableRows, DataTableSelection, DataTableSort,
        DataTableSortDirection, DataTableStyles, DataTableTarget, data_table,
    },
    date_picker::{
        DatePicker, DatePickerElement, DatePickerEvent, DatePickerProps, DatePickerValue,
        DateRangePreset, DateTime, PickedDate, date_picker,
    },
    dock::{DockArea, DockAreaElement, DockAreaEvent, DockAreaProps, dock_area},
    hover_card::{HoverCard, HoverCardElement, HoverCardEvent, HoverCardProps, hover_card},
    link::{Link, LinkElement, LinkEvent, LinkOpenWith, LinkProps, link},
    menu::{
        ContextMenu, ContextMenuElement, ContextMenuProps, Menu, MenuElement, MenuEvent, MenuItem,
        MenuItemElement, MenuItemEvent, MenuItemProps, MenuList, MenuListElement, MenuListEntry,
        MenuListProps, MenuProps, MenuSeparator, MenuSeparatorElement, MenuSeparatorProps, Submenu,
        SubmenuElement, SubmenuEvent, SubmenuProps, context_menu, menu, menu_item, menu_list,
        menu_separator, submenu,
    },
    navigation::{dialog, nav_page, nav_stack},
    number_input::{
        NumberInput, NumberInputElement, NumberInputEvent, NumberInputProps, number_input,
    },
    otp_input::{
        OtpInput, OtpInputApi, OtpInputCompleteEvent, OtpInputElement, OtpInputEvent,
        OtpInputProps, otp_input,
    },
    pagination::{
        Pagination, PaginationElement, PaginationEvent, PaginationItem, PaginationItemKind,
        PaginationItemState, PaginationProps, pagination, pagination_items,
    },
    popover::{Popover, PopoverElement, PopoverEvent, PopoverProps, popover},
    popup::OpenChangeReason,
    progress::{Progress, ProgressElement, ProgressProps, progress},
    radio::{
        Radio, RadioElement, RadioEvent, RadioGroup, RadioGroupElement, RadioGroupProps,
        RadioProps, radio, radio_group,
    },
    resizable::{
        HandleEdge, PANEL_MAX_SIZE, PANEL_MIN_SIZE, ResizablePanel, ResizablePanelElement,
        ResizablePanelEvent, ResizablePanelGroup, ResizablePanelGroupElement,
        ResizablePanelGroupEvent, ResizablePanelGroupProps, ResizablePanelProps, ResizableState,
        ResizeHandle, ResizeHandleContext, ResizeHandleElement, ResizeHandleEvent,
        ResizeHandleProps, ResizeHandleState, h_resizable, resizable_panel, resizable_panel_group,
        resize_handle, v_resizable,
    },
    scrollbar::{
        Scrollbar, ScrollbarElement, ScrollbarEntrance, ScrollbarLook, ScrollbarMode,
        ScrollbarMotion, ScrollbarProps, ScrollbarTarget, ScrollbarTheme, scrollbar,
        set_scrollbar_theme,
    },
    select::{
        Select, SelectElement, SelectEntry, SelectEvent, SelectGroup, SelectItem, SelectProps,
        SelectValue, select,
    },
    sheet::{Sheet, SheetElement, SheetEvent, SheetProps, sheet},
    slider::{Slider, SliderElement, SliderEvent, SliderProps, SliderScale, SliderValue, slider},
    switch::{Switch, SwitchElement, SwitchEvent, SwitchProps, switch},
    table::{
        Table, TableBody, TableBodyElement, TableCaption, TableCaptionElement, TableCell,
        TableCellElement, TableElement, TableFooter, TableFooterElement, TableHead,
        TableHeadElement, TableHeader, TableHeaderElement, TablePartProps, TableProps, TableRow,
        TableRowElement, table, table_body, table_caption, table_cell, table_footer, table_head,
        table_header, table_row,
    },
    tabs::{Tab, TabElement, TabEvent, TabProps, Tabs, TabsElement, TabsProps, tab, tabs},
    text_view::{
        CodeHighlighter, MarkdownExtension, MarkdownOptions, MarkdownPlugin, MarkdownPlugins,
        TextSelectionFormat, TextSelectionOptions, TextView, TextViewApi, TextViewClasses,
        TextViewCodeAction, TextViewCodeActionEvent, TextViewElement, TextViewEvent,
        TextViewImageContext, TextViewImageFlow, TextViewLabels, TextViewLinkPressEvent,
        TextViewLinkTarget, TextViewLinks, TextViewMath, TextViewPart, TextViewParts,
        TextViewProps, TextViewSelectionEvent, TextViewStyles, text_view,
    },
    theme::{DEFAULT_THEME, Theme, ThemeError, theme, theme_overrides, tokens_of},
    time_field::{
        HourCycle, TimeField, TimeFieldElement, TimeFieldEvent, TimeFieldProps,
        TimeFieldSegmentEntry, TimeOfDay, TimePrecision, TimeSegment, time_field,
    },
    toast::{
        Anchor, SwipeDirection, Toast, ToastAdvance, ToastElement, ToastEvent, ToastManager,
        ToastMotion, ToastOptions, ToastProps, ToastStack, ToastStackElement, ToastStackEvent,
        ToastStackProps, ToastStackState, ToastTransitionStatus, toast, toast_stack,
    },
    toggle::{
        Toggle, ToggleElement, ToggleEvent, ToggleGroup, ToggleGroupElement, ToggleGroupProps,
        ToggleProps, toggle, toggle_group,
    },
    toolbar::{
        Toolbar, ToolbarElement, ToolbarGroup, ToolbarGroupElement, ToolbarGroupProps,
        ToolbarProps, ToolbarSeparator, ToolbarSeparatorElement, ToolbarSeparatorProps, toolbar,
        toolbar_group, toolbar_separator,
    },
    tooltip::{Tooltip, TooltipElement, TooltipEvent, TooltipProps, tooltip},
    tree::{Tree, TreeApi, TreeElement, TreeEntry, TreeEvent, TreeItem, TreeProps, tree},
};
#[cfg(feature = "editor")]
pub use crate::{
    diff::{
        DiffAnnotation, DiffChange, DiffExpand, DiffFile, DiffFileStatus, DiffHunk, DiffHunkBounds,
        DiffIndicators, DiffInline, DiffLayout, DiffLine, DiffLineRange, DiffSeparator, DiffSide,
        DiffStats, DiffView, DiffViewApi, DiffViewClasses, DiffViewElement, DiffViewEvent,
        DiffViewPart, DiffViewProps, DiffViewStyles, diff_view,
    },
    editor::{
        Editor, EditorApi, EditorBounds, EditorClasses, EditorCommand, EditorContextMenuEvent,
        EditorDecoration, EditorDiagnostic, EditorDiagnosticCodeDescription,
        EditorDiagnosticRelatedInformation, EditorDiagnosticSeverity, EditorDiagnosticTag,
        EditorElement, EditorEvent, EditorFoldRange, EditorGutterMark, EditorGutterPlacement,
        EditorHoverEvent, EditorLocation, EditorOverviewRulerLane, EditorOverviewRulerMark,
        EditorPart, EditorPosition, EditorProps, EditorRange, EditorRect, EditorReplaceAll,
        EditorScrollBeyond, EditorSearch, EditorSearchResult, EditorSelection, EditorStyles,
        EditorTextPressEvent, EditorToken, editor,
    },
};

/// The JS module apps import the foundation as.
pub const SPECIFIER: &str = "nsh/base";

/// Every component and module of `nsh/base`, for an engine to serve.
pub fn registry() -> Registry {
    registry_of(parts::ALL.iter().map(|(_, part)| *part))
}

/// The parts of `nsh/base` in `parts` ([`parts`]), for a runtime that
/// serves only those: what no part registers is left out of its binary.
/// Every set has the navigation, `Input` and the theme's tokens.
pub fn registry_of(parts: impl IntoIterator<Item = parts::Part>) -> Registry {
    let mut registry = Registry::ui_set(SPECIFIER);
    for part in parts {
        part(&mut registry);
    }
    registry
        // Navigation and `Input`: made by `nsh-js` (`navigation.rs`,
        // `env.rs`), declared by hand.
        .native_values(&["NavStack", "NavPage", "Dialog", "createNavStack", "Input"])
        // The theme: the app's over the default, as design tokens.
        .tokens_from(theme::read_tokens);
    registry
}

/// The parts [`registry_of`] makes `nsh/base` of. Each registers one
/// component, or a few that go together, with its classes and modules;
/// [`core`](parts::core) the controls every app has. A runtime built with
/// some of them carries the code of those only, the components' own
/// dependencies included (Markdown's parser with `TextView`, ropey with
/// the `Editor`).
pub mod parts {
    use nsh_core::element::Registry;

    #[cfg(feature = "emoji-picker")]
    use crate::EmojiPicker;
    #[cfg(feature = "plot")]
    use crate::plot;
    #[cfg(feature = "rich-editor")]
    use crate::rich_editor;
    use crate::{
        Accordion, AccordionHeader, AccordionItem, AccordionPanel, AccordionTrigger, AlertDialog,
        Avatar, AvatarGroup, Button, Calendar, Carousel, CarouselContent, CarouselItem,
        CarouselNext, CarouselPagination, CarouselPaginationItem, CarouselPrevious, Checkbox,
        Collapsible, ColorArea, ColorEyeDropper, ColorField, ColorPicker, ColorSlider, ColorSwatch,
        Combobox, Command, ContextMenu, DataTable, DatePicker, DockArea, HoverCard, Link, Menu,
        MenuItem, MenuSeparator, NumberInput, OtpInput, Pagination, Popover, Progress, Radio,
        RadioGroup, ResizablePanel, ResizablePanelGroup, Scrollbar, Select, Sheet, Slider, Submenu,
        Switch, Tab, Table, TableBody, TableCaption, TableCell, TableFooter, TableHead,
        TableHeader, TableRow, Tabs, TextView, TimeField, Toast, ToastStack, Toggle, ToggleGroup,
        Toolbar, ToolbarGroup, ToolbarSeparator, Tooltip, Tree,
    };
    #[cfg(feature = "editor")]
    use crate::{DiffView, Editor};

    /// What a part does: registers its components, classes and modules.
    pub type Part = fn(&mut Registry);

    /// Every part by its name, the order [`crate::registry`] registers them.
    pub const ALL: &[(&str, Part)] = &[
        ("core", core),
        ("menu", menu),
        ("overlays", overlays),
        ("select", select),
        ("command", command),
        ("combobox", combobox),
        ("toast", toast),
        ("pickers", pickers),
        ("color_picker", color_picker),
        #[cfg(feature = "emoji-picker")]
        ("emoji_picker", emoji_picker),
        ("carousel", carousel),
        ("tree", tree),
        ("fields", fields),
        ("text_view", text_view),
        #[cfg(feature = "editor")]
        ("editor", editor),
        #[cfg(feature = "editor")]
        ("diff", diff),
        #[cfg(feature = "rich-editor")]
        ("rich_editor", rich_editor),
        ("data_table", data_table),
        ("table", table),
        ("dock", dock),
        ("resizable", resizable),
        #[cfg(feature = "plot")]
        ("plot", plot),
        #[cfg(feature = "term")]
        ("term", term),
    ];

    /// The controls every app may use: buttons, links, checkboxes, radios,
    /// switches, toggles, toolbars, sliders, scroll bars, paginations,
    /// tabs, collapsibles, accordions, avatars, progress and system
    /// alerts. It also draws the built-in scroll bars. Menus, popups,
    /// pickers, the command palette and toasts are parts of their own, so a
    /// web runtime linked for an app leaves out those it does not use.
    pub fn core(registry: &mut Registry) {
        registry
            .register::<Accordion>()
            .register::<AccordionItem>()
            .register::<AccordionHeader>()
            .register::<AccordionTrigger>()
            .register::<AccordionPanel>()
            .register::<Avatar>()
            .register::<AvatarGroup>()
            .register::<Button>()
            .register::<Link>()
            .register::<Checkbox>()
            .register::<Collapsible>()
            .register::<Pagination>()
            .register::<Radio>()
            .register::<RadioGroup>()
            .register::<Slider>()
            .register::<Scrollbar>()
            .module::<Scrollbar>()
            .scrollbars_from(crate::scrollbar::built_in)
            .register::<Switch>()
            .register::<Progress>()
            .register::<Tab>()
            .register::<Tabs>()
            .register::<Toggle>()
            .register::<ToggleGroup>()
            .register::<Toolbar>()
            .register::<ToolbarGroup>()
            .register::<ToolbarSeparator>()
            .module::<AlertDialog>();
    }

    /// `Menu`, `ContextMenu` and their items.
    pub fn menu(registry: &mut Registry) {
        registry
            .register::<ContextMenu>()
            .register::<Menu>()
            .register::<MenuItem>()
            .register::<MenuSeparator>()
            .register::<Submenu>();
    }

    /// `Popover`, `HoverCard`, `Sheet` and `Tooltip`.
    pub fn overlays(registry: &mut Registry) {
        registry
            .register::<Popover>()
            .register::<HoverCard>()
            .register::<Sheet>()
            .register::<Tooltip>();
    }

    /// `Select`.
    pub fn select(registry: &mut Registry) {
        registry.register::<Select>();
    }

    /// `Command`: a command palette.
    pub fn command(registry: &mut Registry) {
        registry.register::<Command>();
    }

    /// `Combobox`.
    pub fn combobox(registry: &mut Registry) {
        registry.register::<Combobox>();
    }

    /// `Toast`, `ToastStack` and the toast manager.
    pub fn toast(registry: &mut Registry) {
        registry
            .register::<Toast>()
            .register::<ToastStack>()
            .class::<crate::toast::ToastManagerClass>();
    }

    /// `Calendar`, `DatePicker` and `TimeField`: dates and times.
    pub fn pickers(registry: &mut Registry) {
        registry
            .register::<Calendar>()
            .register::<DatePicker>()
            .register::<TimeField>();
    }

    /// `ColorPicker` and its parts.
    pub fn color_picker(registry: &mut Registry) {
        registry
            .register::<ColorPicker>()
            .register::<ColorArea>()
            .register::<ColorSlider>()
            .register::<ColorField>()
            .register::<ColorSwatch>()
            .register::<ColorEyeDropper>();
    }

    /// `EmojiPicker`: a search field over every emoji, with the emoji's
    /// data (fetched by the web runtime the first time a picker shows).
    #[cfg(feature = "emoji-picker")]
    pub fn emoji_picker(registry: &mut Registry) {
        registry.register::<EmojiPicker>();
    }

    /// `Carousel` and its parts.
    pub fn carousel(registry: &mut Registry) {
        registry
            .register::<Carousel>()
            .register::<CarouselContent>()
            .register::<CarouselItem>()
            .register::<CarouselPrevious>()
            .register::<CarouselNext>()
            .register::<CarouselPagination>()
            .register::<CarouselPaginationItem>();
    }

    /// `Tree`: items that hold items.
    pub fn tree(registry: &mut Registry) {
        registry.register::<Tree>();
    }

    /// `NumberInput` and `OtpInput`.
    pub fn fields(registry: &mut Registry) {
        registry.register::<NumberInput>().register::<OtpInput>();
    }

    /// `TextView`: Markdown and HTML documents.
    pub fn text_view(registry: &mut Registry) {
        registry
            .register::<TextView>()
            .class::<crate::text_view::TextViewLinkTarget>()
            .module::<TextView>();
    }

    /// The `Editor`: a code editor.
    #[cfg(feature = "editor")]
    pub fn editor(registry: &mut Registry) {
        registry.register::<Editor>();
    }

    /// `DiffView`: the changes between two texts or of a patch.
    #[cfg(feature = "editor")]
    pub fn diff(registry: &mut Registry) {
        registry.register::<DiffView>();
    }

    /// `RichEditor`, with its schema, session and plugin classes and its
    /// module.
    #[cfg(feature = "rich-editor")]
    pub fn rich_editor(registry: &mut Registry) {
        registry.register::<rich_editor::view::RichEditor>();
        rich_editor::js::register(registry);
    }

    /// `Terminal`.
    #[cfg(feature = "term")]
    pub fn term(registry: &mut Registry) {
        registry.register::<crate::Terminal>();
    }

    /// `DataTable`.
    pub fn data_table(registry: &mut Registry) {
        registry.register::<DataTable>();
    }

    /// `Table` and its parts.
    pub fn table(registry: &mut Registry) {
        registry
            .register::<Table>()
            .register::<TableHeader>()
            .register::<TableBody>()
            .register::<TableFooter>()
            .register::<TableRow>()
            .register::<TableHead>()
            .register::<TableCell>()
            .register::<TableCaption>();
    }

    /// `DockArea`: a dockable workspace.
    pub fn dock(registry: &mut Registry) {
        registry.register::<DockArea>();
    }

    /// `ResizablePanelGroup` and `ResizablePanel`.
    pub fn resizable(registry: &mut Registry) {
        registry
            .register::<ResizablePanelGroup>()
            .register::<ResizablePanel>();
    }

    /// Charts' parts, a module of their own: `nsh/base/plot`.
    #[cfg(feature = "plot")]
    pub fn plot(registry: &mut Registry) {
        registry.submodule(plot::registry());
    }
}

/// The specs of `nsh/base`, for the generated JS glue.
pub fn specs() -> Vec<Arc<ComponentSpec>> {
    registry().specs()
}

#[cfg(test)]
mod tests {
    /// The exports are named after the types (`std::any::type_name`): a
    /// renamed type, or a compiler that formats type names differently,
    /// changes what apps import.
    #[cfg(all(
        feature = "editor",
        feature = "emoji-picker",
        feature = "plot",
        feature = "rich-editor"
    ))]
    #[test]
    fn the_exports_are_pinned() {
        let registry = super::registry();
        let components: Vec<_> = registry.specs().iter().map(|s| s.export.clone()).collect();
        assert_eq!(
            components,
            [
                "Accordion",
                "AccordionHeader",
                "AccordionItem",
                "AccordionPanel",
                "AccordionTrigger",
                "Avatar",
                "AvatarGroup",
                "Button",
                "Calendar",
                "Carousel",
                "CarouselContent",
                "CarouselItem",
                "CarouselNext",
                "CarouselPagination",
                "CarouselPaginationItem",
                "CarouselPrevious",
                "Checkbox",
                "Collapsible",
                "ColorArea",
                "ColorEyeDropper",
                "ColorField",
                "ColorPicker",
                "ColorSlider",
                "ColorSwatch",
                "Combobox",
                "Command",
                "ContextMenu",
                "DataTable",
                "DatePicker",
                "DiffView",
                "DockArea",
                "Editor",
                "EmojiPicker",
                "HoverCard",
                "Link",
                "Menu",
                "MenuItem",
                "MenuSeparator",
                "NumberInput",
                "OtpInput",
                "Pagination",
                "Popover",
                "Progress",
                "Radio",
                "RadioGroup",
                "ResizablePanel",
                "ResizablePanelGroup",
                "RichEditor",
                "Scrollbar",
                "Select",
                "Sheet",
                "Slider",
                "Submenu",
                "Switch",
                "Tab",
                "Table",
                "TableBody",
                "TableCaption",
                "TableCell",
                "TableFooter",
                "TableHead",
                "TableHeader",
                "TableRow",
                "Tabs",
                "Terminal",
                "TextView",
                "TimeField",
                "Toast",
                "ToastStack",
                "Toggle",
                "ToggleGroup",
                "Toolbar",
                "ToolbarGroup",
                "ToolbarSeparator",
                "Tooltip",
                "Tree"
            ]
        );
        let modules: Vec<_> = registry.module_specs().iter().map(|m| m.name).collect();
        assert_eq!(
            modules,
            [
                "AlertDialog",
                "RichEditorApi",
                "RichExtensionApi",
                "RichTableApi",
                "Scrollbar",
                "TextView"
            ]
        );
        let sets: Vec<_> = registry.sets().iter().map(|s| s.specifier()).collect();
        assert_eq!(sets, [Some("nsh/base"), Some("nsh/base/plot")]);
        let plot: Vec<_> = super::plot::registry()
            .specs()
            .iter()
            .map(|s| s.export.clone())
            .collect();
        assert_eq!(
            plot,
            [
                "Arc",
                "Area",
                "Bar",
                "Cell",
                "Dot",
                "Grid",
                "Line",
                "Pie",
                "Plot",
                "PlotAppearScope",
                "PlotAxis",
                "PlotLabel",
                "RadialGrid",
                "RadialLine",
                "Rule",
                "Sankey",
                "Treemap"
            ]
        );
    }

    /// The parts split `nsh/base` without overlap: together they export
    /// what the whole set does, each export in one part only.
    #[test]
    fn the_parts_split_the_exports() {
        use std::collections::BTreeSet;

        let exports = |registry: &super::Registry| -> BTreeSet<String> {
            let mut out: BTreeSet<String> = registry
                .specs()
                .iter()
                .map(|s| s.export.to_string())
                .collect();
            out.extend(registry.class_specs().iter().map(|c| c.name.to_owned()));
            out.extend(registry.module_specs().iter().map(|m| m.name.to_owned()));
            let sets = registry.sets();
            out.extend(
                sets.iter()
                    .skip(1)
                    .filter_map(|s| s.specifier())
                    .map(str::to_owned),
            );
            out
        };
        let mut seen = BTreeSet::new();
        for (name, part) in super::parts::ALL {
            for export in exports(&super::registry_of([*part])) {
                assert!(
                    seen.insert(export.clone()),
                    "`{export}` is in two parts, one `{name}`"
                );
            }
        }
        assert_eq!(seen, exports(&super::registry()));
        // What every set has, whatever its parts.
        let bare = super::registry_of([]);
        assert_eq!(
            bare.native_value_names(),
            ["NavStack", "NavPage", "Dialog", "createNavStack", "Input"]
        );
        assert!(bare.specs().is_empty());
    }

    /// Every export TS sees has a doc comment (the declarations show it).
    #[test]
    fn every_export_is_documented() {
        assert_eq!(super::registry().undocumented(), Vec::<String>::new());
        #[cfg(feature = "plot")]
        assert_eq!(super::plot::registry().undocumented(), Vec::<String>::new());
    }
}
