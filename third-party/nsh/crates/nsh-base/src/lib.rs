//! `nsh/base`: the behavior and infrastructure foundation of NSH apps' UI,
//! written in Rust, with no look of its own (as `gpui-base` is GPUI Kit's):
//! controls (`Button`, `Checkbox`, `Radio` in a `RadioGroup`, `Switch`,
//! `Tab` in `Tabs`), a progress bar (`Progress`), disclosure (`Collapsible`), navigation (stacks and pages), dialogs, popups on the core's overlays
//! (`Popover`, `Menu`, `ContextMenu`, `Tooltip`, `Sheet`), a code editor
//! (`Editor`), the changes between two texts (`DiffView`), tables over any number of rows and columns (`DataTable`) and static tables
//! with a table's semantics (`Table` and its parts), toasts (`Toast`,
//! `ToastStack`, `ToastManager`), safe areas,
//! selection areas,
//! the system's dialogs and the software keyboard, and the theme's semantic
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
mod data_table;
mod diff;
pub mod dock;
pub mod editor;
mod keyboard;
mod menu;
mod navigation;
mod popover;
mod popup;
mod progress;
mod radio;
mod resizable;
mod safe_area;
mod selection_area;
mod sheet;
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

use nsh_core::ui::{ComponentSpec, Registry};

pub use crate::{
    alert_dialog::{
        AlertDialog, AlertDialogAction, AlertDialogOptions, AlertDialogPresentation,
        AlertDialogRole, alert_dialog,
    },
    button::{Button, ButtonElement, ButtonEvent, ButtonProps, button},
    checkbox::{Checkbox, CheckboxElement, CheckboxEvent, CheckboxProps, checkbox},
    collapsible::{Collapsible, CollapsibleElement, CollapsibleProps, collapsible},
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
        EditorPosition, EditorProps, EditorRange, EditorRect, EditorScrollBeyond, EditorSearch,
        EditorSearchResult, EditorSelection, EditorStyles, EditorTextPressEvent, EditorToken,
        editor,
    },
    keyboard::{
        AvoidBehavior, Keyboard, KeyboardAvoidingView, KeyboardAvoidingViewElement,
        KeyboardAvoidingViewProps, keyboard_avoiding_view,
    },
    menu::{
        ContextMenu, ContextMenuElement, ContextMenuProps, Menu, MenuElement, MenuEvent, MenuItem,
        MenuItemElement, MenuItemEvent, MenuItemProps, MenuProps, MenuSeparator,
        MenuSeparatorElement, MenuSeparatorProps, Submenu, SubmenuElement, SubmenuProps,
        context_menu, menu, menu_item, menu_separator, submenu,
    },
    navigation::{dialog, nav_page, nav_stack},
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
    safe_area::{Edge, SafeAreaView, SafeAreaViewElement, SafeAreaViewProps, safe_area_view},
    selection_area::{SelectionArea, SelectionAreaElement, SelectionAreaProps, selection_area},
    sheet::{Sheet, SheetElement, SheetEvent, SheetProps, sheet},
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
    let mut registry = Registry::ui_set(SPECIFIER);
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
        .register::<SafeAreaView>()
        .register::<KeyboardAvoidingView>()
        .register::<SelectionArea>()
        .register::<Checkbox>()
        .register::<Collapsible>()
        .register::<DataTable>()
        .register::<DockArea>()
        .register::<DiffView>()
        .register::<Editor>()
        .register::<Radio>()
        .register::<RadioGroup>()
        .register::<ResizablePanelGroup>()
        .register::<ResizablePanel>()
        .register::<Switch>()
        .register::<Table>()
        .register::<TableHeader>()
        .register::<TableBody>()
        .register::<TableFooter>()
        .register::<TableRow>()
        .register::<TableHead>()
        .register::<TableCell>()
        .register::<TableCaption>()
        .register::<Progress>()
        .register::<Tab>()
        .register::<Tabs>()
        .register::<TextView>()
        .register::<Toast>()
        .register::<ToastStack>()
        .class::<toast::ToastManagerClass>()
        .class::<text_view::TextViewLinkTarget>()
        .module::<AlertDialog>()
        .module::<Keyboard>()
        .module::<TextView>()
        // The environment's accessors and hooks, as they are.
        .reexport(&["safeArea", "safeAreaInsets", "keyboardFrame"], &["Edges"])
        // Navigation: made by `nsh-js` (`navigation.rs`), declared by hand.
        .native_values(&["NavStack", "NavPage", "Dialog", "createNavStack"])
        // The theme: the app's over the default, as design tokens.
        .tokens_from(tokens_of);
    registry
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
                "ContextMenu",
                "DataTable",
                "DiffView",
                "DockArea",
                "Editor",
                "KeyboardAvoidingView",
                "Menu",
                "MenuItem",
                "MenuSeparator",
                "Popover",
                "Progress",
                "Radio",
                "RadioGroup",
                "ResizablePanel",
                "ResizablePanelGroup",
                "SafeAreaView",
                "SelectionArea",
                "Sheet",
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
        assert_eq!(modules, ["AlertDialog", "Keyboard", "TextView"]);
    }

    /// Every export TS sees has a doc comment (the declarations show it).
    #[test]
    fn every_export_is_documented() {
        assert_eq!(super::registry().undocumented(), Vec::<String>::new());
    }
}
