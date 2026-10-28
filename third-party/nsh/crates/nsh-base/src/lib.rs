//! `nsh/base`: the behavior and infrastructure foundation of NSH apps' UI,
//! written in Rust, with no look of its own (as `gpui-base` is GPUI Kit's):
//! controls (`Button`, `Checkbox`, `NumberInput`, `Radio` in a
//! `RadioGroup`, `Slider`, `Switch`, a scroll bar of the app's own look (`Scrollbar`), `Tab` in `Tabs`, `Select`, `Combobox`, a one-time code: `OtpInput`), a progress bar (`Progress`), disclosure (`Collapsible`),
//! the parts of charts (`plot`: `nsh/base/plot`), navigation (stacks and pages), dialogs, popups on the core's overlays
//! (`Popover`, `Menu`, `ContextMenu`, `Tooltip`, `Sheet`), a code editor
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

mod alert_dialog;
mod button;
mod checkbox;
mod collapsible;
mod combobox;
mod data_table;
mod diff;
pub mod dock;
pub mod editor;
mod keys;
mod listbox;
mod menu;
mod navigation;
mod number_input;
mod numeric;
mod otp_input;
pub mod plot;
mod popover;
mod popup;
mod progress;
mod radio;
mod resizable;
pub mod rich_editor;
mod roving;
mod scrollbar;
mod select;
mod sheet;
mod slider;
mod switch;
mod syntax;
mod table;
mod tabs;
pub mod text_view;
mod theme;
mod toast;
mod tooltip;
mod window;

use std::sync::Arc;

use nsh_core::element::{ComponentSpec, Registry};
/// `Input`, the native text input (UITextField / UITextView, EditText):
/// TSX's `Input` of `nsh/base`, a host element the core makes.
pub use nsh_core::element::{Input, input};

pub use crate::{
    alert_dialog::{
        AlertDialog, AlertDialogAction, AlertDialogOptions, AlertDialogPresentation,
        AlertDialogResult, AlertDialogRole, alert_dialog,
    },
    button::{Button, ButtonElement, ButtonEvent, ButtonProps, button},
    checkbox::{Checkbox, CheckboxElement, CheckboxEvent, CheckboxProps, checkbox},
    collapsible::{Collapsible, CollapsibleElement, CollapsibleProps, collapsible},
    combobox::{Combobox, ComboboxElement, ComboboxEvent, ComboboxProps, combobox},
    data_table::{
        DataTable, DataTableAlign, DataTableApi, DataTableCell, DataTableClasses, DataTableColumn,
        DataTableColumnGroup, DataTableColumnMove, DataTableContextMenu, DataTableDump,
        DataTableElement, DataTableEvent, DataTableHeaderCell, DataTablePart, DataTablePress,
        DataTableProps, DataTableRange, DataTableRows, DataTableSelection, DataTableSort,
        DataTableSortDirection, DataTableStyles, DataTableTarget, data_table,
    },
    diff::{
        DiffAnnotation, DiffChange, DiffExpand, DiffFile, DiffFileStatus, DiffHunk, DiffIndicators,
        DiffInline, DiffLayout, DiffLine, DiffLineRange, DiffSeparator, DiffSide, DiffStats,
        DiffView, DiffViewApi, DiffViewClasses, DiffViewElement, DiffViewEvent, DiffViewPart,
        DiffViewProps, DiffViewStyles, diff_view,
    },
    dock::{DockArea, DockAreaElement, DockAreaEvent, DockAreaProps, dock_area},
    editor::{
        Editor, EditorApi, EditorBounds, EditorClasses, EditorCommand, EditorContextMenuEvent,
        EditorDecoration, EditorDiagnostic, EditorDiagnosticCodeDescription,
        EditorDiagnosticRelatedInformation, EditorDiagnosticSeverity, EditorDiagnosticTag,
        EditorElement, EditorEvent, EditorFoldRange, EditorHoverEvent, EditorLocation, EditorPart,
        EditorPosition, EditorProps, EditorRange, EditorRect, EditorReplaceAll, EditorScrollBeyond,
        EditorSearch, EditorSearchResult, EditorSelection, EditorStyles, EditorTextPressEvent,
        EditorToken, editor,
    },
    menu::{
        ContextMenu, ContextMenuElement, ContextMenuProps, Menu, MenuElement, MenuEvent, MenuItem,
        MenuItemElement, MenuItemEvent, MenuItemProps, MenuProps, MenuSeparator,
        MenuSeparatorElement, MenuSeparatorProps, Submenu, SubmenuElement, SubmenuProps,
        context_menu, menu, menu_item, menu_separator, submenu,
    },
    navigation::{dialog, nav_page, nav_stack},
    number_input::{
        NumberInput, NumberInputElement, NumberInputEvent, NumberInputProps, number_input,
    },
    otp_input::{
        OtpInput, OtpInputApi, OtpInputCompleteEvent, OtpInputElement, OtpInputEvent,
        OtpInputProps, otp_input,
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
        Select, SelectElement, SelectEvent, SelectGroup, SelectItem, SelectItemState, SelectProps,
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
        TextView, TextViewClasses, TextViewCodeAction, TextViewCodeActionEvent, TextViewElement,
        TextViewEvent, TextViewImageContext, TextViewImageFlow, TextViewLabels,
        TextViewLinkPressEvent, TextViewLinkTarget, TextViewLinks, TextViewMath, TextViewPart,
        TextViewParts, TextViewProps, TextViewStyles, text_view,
    },
    theme::{DEFAULT_THEME, Theme, ThemeError, theme, theme_overrides, tokens_of},
    toast::{
        Anchor, SwipeDirection, Toast, ToastAdvance, ToastElement, ToastEvent, ToastManager,
        ToastMotion, ToastOptions, ToastProps, ToastStack, ToastStackElement, ToastStackEvent,
        ToastStackProps, ToastStackState, ToastTransitionStatus, toast, toast_stack,
    },
    tooltip::{Tooltip, TooltipElement, TooltipEvent, TooltipProps, tooltip},
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
        .tokens_from(tokens_of);
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

    use crate::{
        AlertDialog, Button, Checkbox, Collapsible, Combobox, ContextMenu, DataTable, DiffView,
        DockArea, Editor, Menu, MenuItem, MenuSeparator, NumberInput, OtpInput, Popover, Progress,
        Radio, RadioGroup, ResizablePanel, ResizablePanelGroup, Scrollbar, Select, Sheet, Slider,
        Submenu, Switch, Tab, Table, TableBody, TableCaption, TableCell, TableFooter, TableHead,
        TableHeader, TableRow, Tabs, TextView, Toast, ToastStack, Tooltip, plot, rich_editor,
        toast,
    };

    /// What a part does: registers its components, classes and modules.
    pub type Part = fn(&mut Registry);

    /// Every part by its name, the order [`crate::registry`] registers them.
    pub const ALL: &[(&str, Part)] = &[
        ("core", core),
        ("text_view", text_view),
        ("editor", editor),
        ("diff", diff),
        ("rich_editor", rich_editor),
        ("data_table", data_table),
        ("table", table),
        ("dock", dock),
        ("resizable", resizable),
        ("plot", plot),
    ];

    /// The controls, popups, toasts and dialogs every app may use: buttons,
    /// checkboxes, radios, switches, sliders, scroll bars, number inputs, one-time code inputs, selects, comboboxes, tabs, collapsibles, progress,
    /// menus, popovers, sheets, tooltips, toasts and system alerts.
    pub fn core(registry: &mut Registry) {
        registry
            .register::<Button>()
            .register::<ContextMenu>()
            .register::<Menu>()
            .register::<MenuItem>()
            .register::<MenuSeparator>()
            .register::<Submenu>()
            .register::<Popover>()
            .register::<Sheet>()
            .register::<Tooltip>()
            .register::<Checkbox>()
            .register::<Collapsible>()
            .register::<Combobox>()
            .register::<Select>()
            .register::<NumberInput>()
            .register::<OtpInput>()
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
            .register::<Toast>()
            .register::<ToastStack>()
            .class::<toast::ToastManagerClass>()
            .module::<AlertDialog>();
    }

    /// `TextView`: Markdown and HTML documents.
    pub fn text_view(registry: &mut Registry) {
        registry
            .register::<TextView>()
            .class::<crate::text_view::TextViewLinkTarget>()
            .module::<TextView>();
    }

    /// The `Editor`: a code editor.
    pub fn editor(registry: &mut Registry) {
        registry.register::<Editor>();
    }

    /// `DiffView`: the changes between two texts or of a patch.
    pub fn diff(registry: &mut Registry) {
        registry.register::<DiffView>();
    }

    /// `RichEditor`, with its schema, session and plugin classes and its
    /// module.
    pub fn rich_editor(registry: &mut Registry) {
        registry.register::<rich_editor::view::RichEditor>();
        rich_editor::js::register(registry);
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
    #[test]
    fn the_exports_are_pinned() {
        let registry = super::registry();
        let components: Vec<_> = registry.specs().iter().map(|s| s.export.clone()).collect();
        assert_eq!(
            components,
            [
                "Button",
                "Checkbox",
                "Collapsible",
                "Combobox",
                "ContextMenu",
                "DataTable",
                "DiffView",
                "DockArea",
                "Editor",
                "Menu",
                "MenuItem",
                "MenuSeparator",
                "NumberInput",
                "OtpInput",
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
                "TextView",
                "Toast",
                "ToastStack",
                "Tooltip"
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
                "Arc", "Area", "Bar", "Grid", "Line", "Pie", "Plot", "PlotAxis"
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
        assert_eq!(super::plot::registry().undocumented(), Vec::<String>::new());
    }
}
