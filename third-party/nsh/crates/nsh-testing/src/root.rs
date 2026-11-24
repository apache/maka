//! A Rust app's root as every app declares it.
//!
//! On the desktops a Rust root declares its window
//! (`element::desktop::window()`): the core makes no implicit window for a
//! Rust view (a released JS app's plain root gets one from `mount`). A
//! terminal app fills the terminal, and elsewhere the root's view is the
//! app's screen. Tests mount their subject through [`windowed_root`] so the
//! app they drive is one a desktop shows.

use std::{marker::PhantomData, sync::Arc};

use nsh_core::{
    element::{
        AnyElement, AnyValue, Children, Component, NoEvent, PropError, PropSpec, Props, Root,
        Scope, Slot, TsTypes, desktop::window,
    },
    platform::Idiom,
    prelude::{IntoElement, idiom, os},
};

/// `content` on the desktops' first window, as the app's screen off them.
fn root_view<F: Fn() -> AnyElement + Clone + 'static>(content: F) -> AnyElement {
    // The OS's desktops, as the window model's `<Window>` scenes mean it: a
    // page laid out as a desktop is still the app's screen, and a terminal
    // app fills the terminal.
    if os().is_desktop() && idiom() != Idiom::Terminal {
        window().id("main").content(content).into_element()
    } else {
        content()
    }
}

/// Component `C` as an app root: its view is the first window's content on
/// the desktops, and the app's screen off them.
pub struct WindowedRoot<C>(PhantomData<C>);

impl<C: Component> Component for WindowedRoot<C>
where
    C::Props: Default,
{
    type Props = ();
    type Event = NoEvent;

    fn view(_: (), _: Scope<Self::Event>) -> impl IntoElement {
        root_view(|| C::element(C::Props::default()).into_element())
    }
}

/// The props of [`WindowedRootWith`]: the app's props made again whenever
/// the window's content renders (a window can open again).
pub struct RootProps<C: Component> {
    /// `None` only between [`Props::initial`] and the root's factory.
    make: Option<Arc<dyn Fn() -> C::Props + Send + Sync>>,
}

impl<C: Component> Clone for RootProps<C> {
    fn clone(&self) -> Self {
        Self {
            make: self.make.clone(),
        }
    }
}

impl<C: Component> PartialEq for RootProps<C> {
    fn eq(&self, other: &Self) -> bool {
        match (&self.make, &other.make) {
            (Some(a), Some(b)) => Arc::ptr_eq(a, b),
            (None, None) => true,
            _ => false,
        }
    }
}

impl<C: Component> Props for RootProps<C> {
    fn spec(_: &mut TsTypes) -> Vec<PropSpec> {
        Vec::new()
    }

    fn initial() -> Self {
        Self { make: None }
    }

    fn set(&mut self, _: &str, _: Option<AnyValue>) -> Result<bool, PropError> {
        Ok(false)
    }

    fn set_slot(&mut self, _: &str, _: Option<Slot>) -> bool {
        false
    }

    fn set_children(&mut self, _: Children) -> bool {
        false
    }
}

/// Component `C` as an app root whose props the test makes.
pub struct WindowedRootWith<C: Component>(PhantomData<C>);

impl<C: Component> Component for WindowedRootWith<C> {
    type Props = RootProps<C>;
    type Event = NoEvent;

    fn view(props: Self::Props, _: Scope<Self::Event>) -> impl IntoElement {
        let make = props
            .make
            .expect("windowed_root_with makes the root's props");
        root_view(move || C::element(make()).into_element())
    }
}

/// The [`Root`] of a Rust app whose root component is `C` with its default
/// props, declared as apps do: in a window on the desktops, as the screen off
/// them.
///
/// ```ignore
/// let mut app = nsh_testing::Headless::start(EngineConfig::new(
///     crate::windowed_root::<my_app::App>(),
/// ))
/// .unwrap();
/// ```
pub fn windowed_root<C: Component>() -> Root
where
    C::Props: Default,
{
    Root::of::<WindowedRoot<C>>()
}

/// [`windowed_root`] for a root component whose props the test makes, as
/// `Root::new::<C>(props)` does.
pub fn windowed_root_with<C: Component>(
    props: impl Fn() -> C::Props + Send + Sync + 'static,
) -> Root {
    let make: Arc<dyn Fn() -> C::Props + Send + Sync> = Arc::new(props);
    Root::new::<WindowedRootWith<C>>(move || RootProps {
        make: Some(make.clone()),
    })
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use nsh_core::{platform::Os, prelude::*};

    use super::*;

    static RAN: AtomicBool = AtomicBool::new(false);

    #[component]
    fn Probe() -> impl IntoElement {
        RAN.store(true, Ordering::Relaxed);
        view().child(text("Ready"))
    }

    #[test]
    fn a_desktop_root_renders_in_a_window() {
        let mut config = nsh_engine::EngineConfig::new(windowed_root::<Probe>());
        config.environment.os = Os::MacOs;
        let mut app = crate::Headless::start(config).unwrap();
        app.first_render().unwrap();
        assert!(RAN.load(Ordering::Relaxed));
        assert!(app.shows("Ready"));
    }
}
