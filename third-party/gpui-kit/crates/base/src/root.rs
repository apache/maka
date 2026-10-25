//! Window roots and presentation-layer plugins.
use crate::{StyledExt, TextSelectionLayer, WindowBorderStyle, window_border};
use gpui::{
    AnyElement, AnyView, App, AppContext, ClipboardItem, Context, Div, Entity, Global,
    InteractiveElement, IntoElement, Keystroke, ParentElement, Render, Stateful, StyleRefinement,
    Styled, Subscription, Window, div,
};
use std::{any::TypeId, rc::Rc};

/// Scan at most one cycle of the rendered tab order, preserving containment
/// regardless of how many controls exist behind a modal. GPUI exposes traversal
/// but not candidate enumeration. This scan is synchronous: only the final
/// focus path is published at the next draw, not the background candidates.
fn advance_focus(window: &mut Window, cx: &mut App, advance: fn(&mut Window, &mut App)) {
    let Some(container) = crate::active_focus_trap(window, cx) else {
        advance(window, cx);
        return;
    };

    advance(window, cx);
    // GPUI's tab order can cycle short of the whole window (a stop whose
    // previous stop is itself), so the walk ends at the first repeated stop,
    // not only on a return to the one it began with.
    let mut visited = Vec::new();
    while !container.contains_focused(window, cx) {
        let focused = window.focused(cx);
        if visited.contains(&focused) {
            // No tab stop in the trap is reachable. Its own handle remains a
            // safe focus target even when excluded from ordinary tab order.
            container.focus(window, cx);
            break;
        }
        visited.push(focused);
        advance(window, cx);
    }
}

/// A presentation layer's retained, per-window facilities.
///
/// Register during explicit application initialization, before creating windows.
/// The view renders above application content. Base owns the root regardless of
/// which plugins are registered; Cargo features never select its type.
///
/// On every root render, each plugin participates in three stages:
///
/// 1. [`RootPlugin::prepare`] synchronizes window state before elements are built.
/// 2. [`RootPlugin::style`] supplies defaults for the root surface.
/// 3. [`RootPlugin::decorate`] wraps the completed surface in presentation owned
///    by the plugin.
///
/// The plugin's [`Render`] output is mounted as an overlay above application
/// content. Plugins and their overlays are processed in registration order, so
/// later plugins appear above earlier ones. Notify the plugin entity after its
/// state changes to render the root again; `prepare` and `style` must not notify,
/// because they run during that render.
///
/// Factories are captured when a root is created, so registration affects only
/// future windows.
pub trait RootPlugin: Render + Sized {
    /// Synchronize settings derived from this plugin with the window.
    ///
    /// This runs before the root surface and plugin overlays are built. It is
    /// intended for window-scoped state such as rem size or the active text
    /// selection scope, not for producing elements.
    fn prepare(&mut self, _window: &mut Window, _cx: &mut Context<Self>) {}

    /// Apply this plugin's default styles directly to the root surface.
    ///
    /// Styles set on the [`Root`] instance are refined onto the surface after
    /// this hook and therefore take precedence over plugin defaults.
    fn style(&self, _surface: &mut Stateful<Div>, _window: &mut Window, _cx: &mut App) {}

    /// Add presentation around the completed root surface.
    ///
    /// This runs after plugin defaults and instance styles have been applied.
    /// Return `surface` unchanged when no outer presentation is needed.
    /// Platform frame mechanics belong to Root and wrap the resulting surface.
    /// `root` provides read-only access to the root and its application view.
    fn decorate(
        &self,
        surface: AnyElement,
        _root: &Root,
        _window: &mut Window,
        _cx: &mut App,
    ) -> impl IntoElement {
        surface
    }
}

type PluginFactory = Rc<dyn Fn(&mut Window, &mut Context<Root>) -> Plugin>;
type Prepare = Rc<dyn Fn(&mut Window, &mut App)>;
type SurfaceStyle = Rc<dyn Fn(&mut Stateful<Div>, &mut Window, &mut App)>;
type Decorate = Rc<dyn Fn(AnyElement, &Root, &mut Window, &mut App) -> AnyElement>;
#[derive(Default)]
struct PluginRegistry(Vec<(TypeId, PluginFactory)>);
impl Global for PluginRegistry {}
struct Plugin {
    view: AnyView,
    prepare: Prepare,
    style: SurfaceStyle,
    decorate: Decorate,
}

/// The window's content and overlay host, independent of any styled component library.
pub struct Root {
    view: AnyView,
    style: StyleRefinement,
    plugins: Vec<Plugin>,
    _keyboard: Subscription,
    _appearance: Subscription,
    window_border_style: WindowBorderStyle,
}

impl Root {
    /// Register a presentation plugin once per application. Re-registering its
    /// type replaces the factory for future windows rather than mounting it twice.
    pub fn register_plugin<V: RootPlugin>(
        cx: &mut App,
        build: fn(&mut Window, &mut Context<V>) -> V,
    ) {
        if !cx.has_global::<PluginRegistry>() {
            cx.set_global(PluginRegistry::default());
        }
        let factory: PluginFactory = Rc::new(move |window, cx| {
            let entity = cx.new(|cx| build(window, cx));
            let root = cx.weak_entity();
            let observed = entity.clone();
            // Plugin construction can enqueue notifications. Observe only after
            // that effect cycle so mounting a Root does not immediately render
            // application content a second time.
            cx.defer(move |cx| {
                cx.observe(&observed, move |_, cx| {
                    let _ = root.update(cx, |_, cx| cx.notify());
                })
                .detach();
            });
            let prepare = entity.clone();
            let style = entity.clone();
            let decorate = entity.clone();
            Plugin {
                view: entity.into(),
                prepare: Rc::new(move |window, cx| {
                    prepare.update(cx, |state, cx| state.prepare(window, cx))
                }),
                style: Rc::new(move |surface, window, cx| {
                    style.update(cx, |state, cx| state.style(surface, window, cx))
                }),
                decorate: Rc::new(move |surface, root, window, cx| {
                    decorate.update(cx, |state, cx| {
                        state.decorate(surface, root, window, cx).into_any_element()
                    })
                }),
            }
        });
        let plugins = &mut cx.global_mut::<PluginRegistry>().0;
        if let Some(entry) = plugins.iter_mut().find(|(id, _)| *id == TypeId::of::<V>()) {
            entry.1 = factory;
        } else {
            plugins.push((TypeId::of::<V>(), factory));
        }
    }

    pub fn new(view: impl Into<AnyView>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        #[cfg(all(target_os = "macos", not(test)))]
        crate::install_window_hit_test_forwarder(window);
        let factories = cx
            .try_global::<PluginRegistry>()
            .map(|e| e.0.clone())
            .unwrap_or_default();
        let window_id = window.window_handle().window_id();
        let owner = cx.weak_entity();
        let keyboard = App::observe_keystrokes(cx, move |event, window, cx| {
            if window.window_handle().window_id() != window_id
                || event.action.is_some()
                || !cx.is_propagating()
                || window.default_prevented()
                || !window
                    .root::<Self>()
                    .flatten()
                    .is_some_and(|current| current.entity_id() == owner.entity_id())
            {
                return;
            }
            let _ = owner.update(cx, |root, cx| {
                root.apply_default(&event.keystroke, window, cx)
            });
        });
        let appearance_owner = cx.weak_entity();
        let appearance = window.observe_window_appearance(move |_, cx| {
            let _ = appearance_owner.update(cx, |_, cx| cx.notify());
        });
        Self {
            view: view.into(),
            _keyboard: keyboard,
            _appearance: appearance,
            window_border_style: WindowBorderStyle::default(),
            style: StyleRefinement::default(),
            plugins: factories
                .into_iter()
                .map(|(_, build)| build(window, cx))
                .collect(),
        }
    }

    /// Update immutable frame values on this original per-window owner.
    pub fn set_window_border_style(&mut self, style: WindowBorderStyle, cx: &mut Context<Self>) {
        if self.window_border_style != style {
            self.window_border_style = style;
            cx.notify();
        }
    }

    /// The original application content entity.
    pub fn view(&self) -> &AnyView {
        &self.view
    }

    /// Find a presentation plugin owned by this window.
    pub fn plugin<V: RootPlugin>(&self) -> Option<Entity<V>> {
        self.plugins
            .iter()
            .find_map(|entry| entry.view.clone().downcast::<V>().ok())
    }

    pub fn read<'a>(window: &'a Window, cx: &'a App) -> &'a Self {
        window
            .root::<Self>()
            .flatten()
            .expect("window must have a Base Root")
            .read(cx)
    }
    pub fn update<R>(
        window: &mut Window,
        cx: &mut App,
        f: impl FnOnce(&mut Self, &mut Window, &mut Context<Self>) -> R,
    ) -> R {
        let root = window
            .root::<Self>()
            .flatten()
            .expect("window must have a Base Root");
        root.update(cx, |root, cx| f(root, window, cx))
    }
    // Native defaults run after component bindings and raw bubble decisions,
    // including with no focused descendant. A plugin can veto a default while
    // preserving ancestor observation.
    fn apply_default(&mut self, key: &Keystroke, window: &mut Window, cx: &mut Context<Self>) {
        if window.default_prevented() {
            return;
        }
        let modifiers = key.modifiers;
        let plain_tab = key.key == "tab"
            && !modifiers.control
            && !modifiers.alt
            && !modifiers.platform
            && !modifiers.function;
        let copy_modifier = if cfg!(target_os = "macos") {
            modifiers.platform && !modifiers.control
        } else {
            modifiers.control && !modifiers.platform
        };
        let copy = key.key == "c"
            && copy_modifier
            && !modifiers.alt
            && !modifiers.shift
            && !modifiers.function;
        let consumed = if plain_tab {
            if modifiers.shift {
                self.focus_prev(window, cx);
            } else {
                self.focus_next(window, cx);
            }
            true
        } else {
            copy && self.copy_selection(window, cx)
        };
        if consumed {
            window.prevent_default();
            cx.stop_propagation();
        }
    }

    fn focus_next(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        advance_focus(window, cx, Window::focus_next);
    }

    fn focus_prev(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        advance_focus(window, cx, Window::focus_prev);
    }

    fn copy_selection(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let text = crate::TextSelection::selected_text(window, cx)
            .trim()
            .to_string();
        if text.is_empty() {
            return false;
        }
        cx.write_to_clipboard(ClipboardItem::new_string(text));
        true
    }
}
impl Styled for Root {
    fn style(&mut self) -> &mut StyleRefinement {
        &mut self.style
    }
}
impl Render for Root {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        for plugin in &self.plugins {
            (plugin.prepare)(window, cx);
        }
        let mut content = div()
            .id("root")
            .relative()
            .size_full()
            .child(TextSelectionLayer)
            .child(self.view.clone())
            .child(
                div()
                    .absolute()
                    .inset_0()
                    .children(self.plugins.iter().map(|plugin| plugin.view.clone())),
            );
        for plugin in &self.plugins {
            (plugin.style)(&mut content, window, cx);
        }
        let mut content = content.refine_style(&self.style).into_any_element();
        for plugin in &self.plugins {
            content = (plugin.decorate)(content, self, window, cx);
        }
        window_border()
            .style(self.window_border_style.clone())
            .child(content)
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::FocusTrapElement as _;
    use gpui::{FocusHandle, Subscription, TestAppContext, VisualTestContext, px};
    use std::cell::Cell;

    struct TrapContent {
        background: Vec<FocusHandle>,
        container: FocusHandle,
        controls: Vec<FocusHandle>,
        _focus_subscriptions: Vec<Subscription>,
    }

    impl Render for TrapContent {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div()
                .tab_group()
                .size_full()
                .children(self.background.iter().enumerate().map(|(index, handle)| {
                    div()
                        .id(("background", index))
                        .track_focus(handle)
                        .tab_index(0)
                        .size(px(1.))
                }))
                .child(
                    div()
                        .id("trap")
                        .track_focus(&self.container)
                        .tab_stop(false)
                        .children(self.controls.iter().enumerate().map(|(index, handle)| {
                            div()
                                .id(("control", index))
                                .track_focus(handle)
                                .tab_index(0)
                                .size(px(1.))
                        }))
                        .focus_trap("modal", &self.container),
                )
        }
    }

    fn trap_harness(
        cx: &mut TestAppContext,
        control_count: usize,
    ) -> (
        &mut VisualTestContext,
        FocusHandle,
        Vec<FocusHandle>,
        Vec<FocusHandle>,
        Rc<Cell<usize>>,
    ) {
        cx.update(crate::init);
        let (container, controls, background) = cx.update(|cx| {
            (
                cx.focus_handle(),
                (0..control_count)
                    .map(|_| cx.focus_handle().tab_stop(true))
                    .collect::<Vec<_>>(),
                // Regression: traversing past the modal must cross more than
                // the former 100-attempt limit before reaching its other end.
                (0..256)
                    .map(|_| cx.focus_handle().tab_stop(true))
                    .collect::<Vec<_>>(),
            )
        });
        let background_focuses = Rc::new(Cell::new(0));
        let (_, cx) = cx.add_window_view({
            let container = container.clone();
            let controls = controls.clone();
            let background = background.clone();
            let background_focuses = background_focuses.clone();
            move |window, cx| {
                let content = cx.new(|cx| {
                    let subscriptions = background
                        .iter()
                        .map(|handle| {
                            let focuses = background_focuses.clone();
                            cx.on_focus(handle, window, move |_, _, _| {
                                focuses.set(focuses.get() + 1)
                            })
                        })
                        .collect();
                    TrapContent {
                        background,
                        container,
                        controls,
                        _focus_subscriptions: subscriptions,
                    }
                });
                Root::new(content, window, cx)
            }
        });
        cx.update(|window, _| window.activate_window());
        cx.executor().run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
        (cx, container, controls, background, background_focuses)
    }

    fn assert_trapped_focus(
        cx: &mut VisualTestContext,
        container: &FocusHandle,
        expected: &FocusHandle,
    ) {
        cx.update(|window, cx| {
            window.draw(cx).clear(cx);
            assert_eq!(window.focused(cx).as_ref(), Some(expected));
            assert!(container.contains_focused(window, cx));
        });
    }

    #[gpui::test]
    fn focus_trap_wraps_forward_past_more_than_100_background_stops(cx: &mut TestAppContext) {
        let (cx, container, controls, _, background_focuses) = trap_harness(cx, 2);
        cx.update(|window, cx| {
            controls[1].focus(window, cx);
            window.draw(cx).clear(cx);
        });

        cx.simulate_keystrokes("tab");
        assert_trapped_focus(cx, &container, &controls[0]);
        cx.simulate_keystrokes("tab");
        assert_trapped_focus(cx, &container, &controls[1]);
        assert_eq!(background_focuses.get(), 0);
    }

    #[gpui::test]
    fn focus_trap_wraps_backward_past_more_than_100_background_stops(cx: &mut TestAppContext) {
        let (cx, container, controls, _, background_focuses) = trap_harness(cx, 2);
        cx.update(|window, cx| {
            controls[0].focus(window, cx);
            window.draw(cx).clear(cx);
        });

        cx.simulate_keystrokes("shift-tab");
        assert_trapped_focus(cx, &container, &controls[1]);
        cx.simulate_keystrokes("shift-tab");
        assert_trapped_focus(cx, &container, &controls[0]);
        assert_eq!(background_focuses.get(), 0);
    }

    #[gpui::test]
    fn focus_trap_without_tab_stops_keeps_its_container_focused(cx: &mut TestAppContext) {
        let (cx, container, _, _, background_focuses) = trap_harness(cx, 0);
        cx.update(|window, cx| {
            container.focus(window, cx);
            window.draw(cx).clear(cx);
        });

        cx.simulate_keystrokes("tab");
        assert_trapped_focus(cx, &container, &container);
        cx.simulate_keystrokes("shift-tab");
        assert_trapped_focus(cx, &container, &container);
        assert_eq!(background_focuses.get(), 0);
    }

    thread_local! {
        static SCRIPTED_STOPS: std::cell::RefCell<Vec<FocusHandle>> =
            const { std::cell::RefCell::new(Vec::new()) };
    }

    /// Moves focus to the next scripted stop, in place of `focus_prev`. Running
    /// out fails the test, so a search that never stops cannot hang it.
    fn scripted_advance(window: &mut Window, cx: &mut App) {
        SCRIPTED_STOPS
            .with(|stops| stops.borrow_mut().pop())
            .expect("the search kept advancing after a stop repeated")
            .focus(window, cx);
    }

    #[gpui::test]
    fn focus_trap_search_ends_at_a_short_cycle_on_its_container(cx: &mut TestAppContext) {
        let (cx, container, controls, background, _) = trap_harness(cx, 2);
        cx.update(|window, cx| {
            controls[0].focus(window, cx);
            window.draw(cx).clear(cx);
        });
        // A tab order in which the second stop is its own neighbor never
        // returns to the first. Popped from the end: first, second, second.
        let (first, second) = (background[0].clone(), background[1].clone());
        SCRIPTED_STOPS.with(|stops| *stops.borrow_mut() = vec![second.clone(), second, first]);

        cx.update(|window, cx| advance_focus(window, cx, scripted_advance));
        assert_trapped_focus(cx, &container, &container);
        assert!(SCRIPTED_STOPS.with(|stops| stops.borrow().is_empty()));
    }

    #[gpui::test]
    fn inactive_focus_trap_does_not_capture_background_navigation(cx: &mut TestAppContext) {
        let (cx, _, _, background, background_focuses) = trap_harness(cx, 2);
        cx.update(|window, cx| {
            background[0].focus(window, cx);
            window.draw(cx).clear(cx);
        });
        // Prove that the observers used by the containment regressions really
        // receive native focus notifications when a background control is used.
        assert_eq!(background_focuses.get(), 1);

        cx.simulate_keystrokes("tab");
        cx.update(|window, cx| {
            window.draw(cx).clear(cx);
            assert_eq!(window.focused(cx), Some(background[1].clone()));
        });
        cx.simulate_keystrokes("shift-tab");
        cx.update(|window, cx| {
            window.draw(cx).clear(cx);
            assert_eq!(window.focused(cx), Some(background[0].clone()));
        });
        assert_eq!(background_focuses.get(), 3);
    }

    struct Content;
    impl Render for Content {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div()
        }
    }
    struct SelectableContent;
    impl Render for SelectableContent {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div().child(crate::TextView::markdown(
                "copy-content",
                "quick select value",
            ))
        }
    }

    #[gpui::test]
    fn root_copy_default_preserves_actual_selection_and_obeys_native_veto(cx: &mut TestAppContext) {
        use gpui::{
            Modifiers, MouseButton, MouseDownEvent, MouseUpEvent, VisualTestContext, point, px,
        };
        cx.update(crate::init);
        let (_, cx) = cx.add_window_view(|window, cx| {
            let content = cx.new(|_| SelectableContent);
            Root::new(content, window, cx)
        });
        let cx: &mut VisualTestContext = cx;
        cx.run_until_parked();
        cx.update(|window, cx| window.draw(cx).clear(cx));
        let position = point(px(10.), px(16.));
        cx.simulate_event(MouseDownEvent {
            position,
            modifiers: Modifiers::default(),
            button: MouseButton::Left,
            click_count: 2,
            first_mouse: false,
        });
        cx.simulate_event(MouseUpEvent {
            position,
            modifiers: Modifiers::default(),
            button: MouseButton::Left,
            click_count: 2,
        });
        cx.update(|window, cx| {
            window.draw(cx).clear(cx);
            assert_eq!(
                crate::TextSelection::selected_text(window, cx).trim(),
                "quick"
            );
            window.blur(cx);
            cx.write_to_clipboard(ClipboardItem::new_string("Original clipboard".into()));
        });
        let veto = Rc::new(std::cell::Cell::new(true));
        let _intercept = cx.update(|window, cx| {
            let window_id = window.window_handle().window_id();
            let veto = veto.clone();
            cx.intercept_keystrokes(move |event, window, _| {
                if window.window_handle().window_id() == window_id
                    && event.keystroke.key == "c"
                    && veto.get()
                {
                    window.prevent_default();
                }
            })
        });
        let copy = if cfg!(target_os = "macos") {
            "cmd-c"
        } else {
            "ctrl-c"
        };
        cx.simulate_keystrokes(copy);
        cx.update(|window, cx| {
            assert!(window.focused(cx).is_none());
            assert_eq!(
                crate::TextSelection::selected_text(window, cx).trim(),
                "quick"
            );
            assert_eq!(
                cx.read_from_clipboard().unwrap().text().as_deref(),
                Some("Original clipboard")
            );
        });
        veto.set(false);
        cx.simulate_keystrokes(if cfg!(target_os = "macos") {
            "cmd-c"
        } else {
            "ctrl-c"
        });
        cx.update(|_, cx| {
            assert_eq!(
                cx.read_from_clipboard().unwrap().text().as_deref(),
                Some("quick")
            )
        });
    }

    struct FocusPair {
        first: gpui::FocusHandle,
        second: gpui::FocusHandle,
    }
    impl FocusPair {
        fn new(cx: &mut Context<Self>) -> Self {
            Self {
                first: cx.focus_handle().tab_stop(true),
                second: cx.focus_handle().tab_stop(true),
            }
        }
    }
    impl Render for FocusPair {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div().children([
                div()
                    .id("first")
                    .track_focus(&self.first)
                    .tab_stop(true)
                    .h(gpui::px(24.)),
                div()
                    .id("second")
                    .track_focus(&self.second)
                    .tab_stop(true)
                    .h(gpui::px(24.)),
            ])
        }
    }
    #[gpui::test]
    fn root_tab_starts_from_no_focus_and_replaced_root_cannot_apply_defaults(
        cx: &mut TestAppContext,
    ) {
        cx.update(crate::init);
        let (root, cx) = cx.add_window_view(|window, cx| {
            let content = cx.new(FocusPair::new);
            Root::new(content, window, cx)
        });
        let cx: &mut gpui::VisualTestContext = cx;
        cx.run_until_parked();
        let (first, second) = cx.update(|window, cx| {
            window.draw(cx).clear(cx);
            let content = root.read(cx).view.clone().downcast::<FocusPair>().unwrap();
            let pair = content.read(cx);
            let handles = (pair.first.clone(), pair.second.clone());
            window.blur(cx);
            handles
        });
        cx.run_until_parked();
        cx.update(|window, cx| {
            assert!(
                window.focused(cx).is_none(),
                "blur itself never starts navigation"
            )
        });
        cx.simulate_keystrokes("tab");
        cx.update(|window, _| assert!(first.is_focused(window)));
        cx.update(|window, cx| window.blur(cx));
        cx.simulate_keystrokes("shift-tab");
        cx.update(|window, _| assert!(second.is_focused(window)));
        cx.update(|window, cx| {
            window.replace_root(cx, |_, cx| FocusPair::new(cx));
            window.blur(cx);
            window.draw(cx).clear(cx);
        });
        cx.simulate_keystrokes("tab");
        cx.update(|window, cx| {
            assert!(
                window.focused(cx).is_none(),
                "retained old Root cannot act for a replaced native root"
            );
            assert!(
                root.read(cx).view.clone().downcast::<FocusPair>().is_ok(),
                "old entity is genuinely retained"
            );
        });
    }

    struct Layer;
    impl Render for Layer {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div()
        }
    }
    impl RootPlugin for Layer {}
    fn layer(_: &mut Window, _: &mut Context<Layer>) -> Layer {
        Layer
    }

    #[gpui::test]
    fn plugin_registration_is_idempotent_and_state_is_per_window(cx: &mut TestAppContext) {
        cx.update(|cx| {
            crate::init(cx);
            Root::register_plugin(cx, layer);
            Root::register_plugin(cx, layer);
        });
        let mut ids = Vec::new();
        for _ in 0..2 {
            let (root, _) = cx.add_window_view(|window, cx| {
                let content = cx.new(|_| Content);
                Root::new(content, window, cx)
            });
            let id = root.read_with(cx, |root, _| {
                assert_eq!(root.plugins.len(), 1);
                root.plugin::<Layer>().unwrap().entity_id()
            });
            ids.push(id);
        }
        assert_ne!(ids[0], ids[1]);
    }

    mod nested_traps {
        use super::*;

        struct NestedTraps {
            containers: Vec<FocusHandle>,
            controls: Vec<[FocusHandle; 2]>,
            depth: usize,
        }

        impl Render for NestedTraps {
            fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
                let mut child = div().into_any_element();
                for index in (0..self.depth).rev() {
                    let control = |side: usize| {
                        div()
                            .id(("nested-control", index * 2 + side))
                            .track_focus(&self.controls[index][side])
                            .tab_index(0)
                            .size(px(10.))
                    };
                    child = div()
                        .tab_stop(false)
                        .child(control(0))
                        .child(child)
                        .child(control(1))
                        .focus_trap(("nested-trap", index), &self.containers[index])
                        .into_any_element();
                }
                div().tab_group().size_full().child(child)
            }
        }

        #[gpui::test]
        fn nested_traps_keep_the_innermost_scope_across_close_and_reopen(cx: &mut TestAppContext) {
            cx.update(crate::init);
            let (containers, controls) = cx.update(|cx| {
                (
                    (0..6).map(|_| cx.focus_handle()).collect::<Vec<_>>(),
                    (0..6)
                        .map(|_| {
                            [
                                cx.focus_handle().tab_stop(true),
                                cx.focus_handle().tab_stop(true),
                            ]
                        })
                        .collect::<Vec<_>>(),
                )
            });
            let (root, cx) = cx.add_window_view({
                let containers = containers.clone();
                let controls = controls.clone();
                move |window, cx| {
                    let view = cx.new(|_| NestedTraps {
                        containers,
                        controls,
                        depth: 6,
                    });
                    Root::new(view, window, cx)
                }
            });
            let view = root.read_with(cx, |root, _| {
                root.view.clone().downcast::<NestedTraps>().unwrap()
            });

            // Retain every container handle while inner scopes disappear and
            // return. Rendered containment, not registration order or ownership
            // lifetime, must decide which remaining scope handles Tab.
            for depth in [6, 5, 4, 3, 2, 1, 2, 3, 4, 5, 6] {
                view.update(cx, |view, cx| {
                    view.depth = depth;
                    cx.notify();
                });
                let index = depth - 1;
                cx.update(|window, cx| {
                    controls[index][1].focus(window, cx);
                    window.draw(cx).clear(cx);
                });
                cx.simulate_keystrokes("tab");
                assert_trapped_focus(cx, &containers[index], &controls[index][0]);
                cx.simulate_keystrokes("shift-tab");
                assert_trapped_focus(cx, &containers[index], &controls[index][1]);
            }
        }
    }
}

#[cfg(test)]
mod focus_reveal;

#[cfg(test)]
mod click_target;
