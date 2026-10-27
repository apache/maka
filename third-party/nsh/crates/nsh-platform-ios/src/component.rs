//! Native components the embedding app registers (`nsh/native`'s
//! `nativeComponent`): a map, a player, its own views.
//!
//! The core creates a [`ViewKind::Native`](nsh_core::ViewKind::Native)
//! container (decoration, frames, touches and accessibility are its, as for
//! any view), then names the component ([`MountItem::Component`]) and sends
//! its props as JSON as they change. The mounter makes the component with
//! the factory registered under that name and fills the container with its
//! view. Components emit events and report their own size through their
//! [`ComponentContext`].
//!
//! [`MountItem::Component`]: nsh_core::MountItem::Component

use std::{cell::RefCell, rc::Rc, sync::Arc};

use nsh_core::{
    EventKind, EventPayload, JsonValue, NodeId, Points, Size,
    platform::{TAB_BAR_COMPONENT, is_reserved_component},
};
use nsh_engine::EngineControl;
use objc2_ui_kit::UIView;
use rustc_hash::{FxHashMap, FxHashSet};

/// A native component made by a registered factory.
pub trait NativeComponent {
    /// Its view; it fills the container nsh lays out.
    fn view(&self) -> &UIView;

    /// Prop `name` changed (`None`: removed). Every prop the app set comes
    /// right after the component is made.
    fn set_prop(&mut self, name: &str, value: Option<&JsonValue>);

    /// JS called `ref.command(name, args)`.
    fn command(&mut self, name: &str, args: &JsonValue) {
        let _ = (name, args);
    }

    /// Prop `name`, bound to an animated value, moved to `value` (on the
    /// frames it changes, without JS). By default, [`Self::set_prop`] with
    /// a JSON number.
    fn set_animated_number(&mut self, name: &str, value: f64) {
        let json = serde_json::Number::from_f64(value).map_or(JsonValue::Null, JsonValue::Number);
        self.set_prop(name, Some(&json));
    }

    /// Prop `name`, bound to an animated color, moved to `argb`
    /// (`0xAARRGGBB`). By default, [`Self::set_prop`] with a JSON number.
    fn set_animated_color(&mut self, name: &str, argb: u32) {
        self.set_prop(name, Some(&JsonValue::from(argb)));
    }
}

/// What a component can tell its app. Cheap to clone; usable from any
/// thread.
#[derive(Clone)]
pub struct ComponentContext {
    id: NodeId,
    control: EngineControl,
}

impl std::fmt::Debug for ComponentContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ComponentContext")
            .field("id", &self.id)
            .finish()
    }
}

impl ComponentContext {
    /// Emits event `name` with `data`: the handler `on<Name>` gets it.
    pub fn emit(&self, name: &str, data: JsonValue) {
        self.control.dispatch_event(
            self.id,
            EventKind::NativeEvent,
            EventPayload::Native {
                name: name.into(),
                data,
            },
        );
    }

    /// The component's own size (points): used where its style leaves a
    /// dimension open.
    pub fn set_size(&self, width: f32, height: f32) {
        self.control
            .set_component_size(self.id, Size::new(Points(width), Points(height)));
    }
}

// Components may emit from any thread (their own callbacks, queues).
const _: () = {
    const fn send_sync<T: Send + Sync>() {}
    send_sync::<ComponentContext>();
};

/// Makes a component for an element, given its context.
pub type ComponentFactory = Rc<dyn Fn(ComponentContext) -> Box<dyn NativeComponent>>;

/// The components registered with a surface (shared with its mounter, so
/// registrations apply to elements created from then on), NSH's own among
/// them.
#[derive(Clone)]
pub struct Components {
    factories: Rc<RefCell<FxHashMap<Arc<str>, ComponentFactory>>>,
    /// Names already reported as unknown.
    missing: Rc<RefCell<FxHashSet<Arc<str>>>>,
}

impl std::fmt::Debug for Components {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_set()
            .entries(self.factories.borrow().keys())
            .finish()
    }
}

impl Default for Components {
    fn default() -> Self {
        let components = Components {
            factories: Rc::default(),
            missing: Rc::default(),
        };
        // NSH's own: what `nsh/base`'s exports render.
        components.insert(TAB_BAR_COMPONENT, crate::system_tab_bar::factory());
        components
    }
}

impl Components {
    /// Registers `factory` under `name` (replacing an earlier one). Names
    /// under `nsh/` are NSH's own: registering one logs a warning and
    /// changes nothing.
    pub fn register(&self, name: &str, factory: ComponentFactory) {
        if is_reserved_component(name) {
            log::warn!("native component `{name}` is not registered: names under `nsh/` are NSH's");
            return;
        }
        self.insert(name, factory);
    }

    fn insert(&self, name: &str, factory: ComponentFactory) {
        self.factories.borrow_mut().insert(name.into(), factory);
        self.missing.borrow_mut().remove(name);
    }

    /// Makes component `name` for element `id`; `None` (logged once per
    /// name) if nothing is registered under it.
    pub(crate) fn make(
        &self,
        name: &Arc<str>,
        id: NodeId,
        control: &EngineControl,
    ) -> Option<Box<dyn NativeComponent>> {
        let factory = self.factories.borrow().get(name).cloned();
        match factory {
            Some(factory) => Some(factory(ComponentContext {
                id,
                control: control.clone(),
            })),
            None => {
                if self.missing.borrow_mut().insert(name.clone()) {
                    log::warn!(
                        target: "js",
                        "no native component is registered as `{name}`: it renders an empty view"
                    );
                }
                None
            }
        }
    }
}

/// A component element: the container nsh lays out and the component in it.
pub(crate) struct ComponentHost {
    pub(crate) container: objc2::rc::Retained<crate::native_view::NshView>,
    pub(crate) component: Option<Box<dyn NativeComponent>>,
    /// The names of its animated prop slots (`MountItem::ComponentPropSlots`).
    pub(crate) slots: Vec<std::sync::Arc<str>>,
    /// Slot -> the value last handed to the component.
    handed: Vec<(u16, nsh_core::animation::AnimatedPropValue)>,
}

impl ComponentHost {
    pub(crate) fn new(container: objc2::rc::Retained<crate::native_view::NshView>) -> Self {
        ComponentHost {
            container,
            component: None,
            slots: Vec::new(),
            handed: Vec::new(),
        }
    }

    /// Hands the component the bound props' values that changed since
    /// they were last handed over.
    pub(crate) fn push(
        &mut self,
        bindings: &[(
            nsh_core::animation::AnimationProp,
            nsh_core::animation::NodeId,
        )],
        animator: &crate::animation::Animator,
    ) {
        use nsh_core::animation::{AnimatedPropValue, AnimationProp};
        let Some(component) = self.component.as_mut() else {
            return;
        };
        for &(prop, node) in bindings {
            let AnimationProp::ComponentSlot(slot) = prop else {
                continue;
            };
            let Some(name) = self.slots.get(slot as usize) else {
                continue;
            };
            let value = AnimatedPropValue::from(animator.eval(node));
            match self.handed.iter_mut().find(|(s, _)| *s == slot) {
                Some((_, v)) if *v == value => continue,
                Some((_, v)) => *v = value,
                None => self.handed.push((slot, value)),
            }
            match value {
                AnimatedPropValue::Color(argb) => component.set_animated_color(name, argb),
                AnimatedPropValue::Number(n) => component.set_animated_number(name, n),
                _ => {}
            }
        }
    }

    /// Its bindings changed or its component is new: what is bound is
    /// handed over again.
    pub(crate) fn forget(&mut self) {
        self.handed.clear();
    }

    /// Puts `component` in the container, filling it.
    pub(crate) fn attach(&mut self, component: Box<dyn NativeComponent>) {
        let view = component.view();
        view.setFrame(self.container.bounds());
        view.setAutoresizingMask(
            objc2_ui_kit::UIViewAutoresizing::FlexibleWidth
                | objc2_ui_kit::UIViewAutoresizing::FlexibleHeight,
        );
        self.container.addSubview(view);
        self.component = Some(component);
    }
}
