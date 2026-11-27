use std::{
    cell::{Cell, RefCell},
    sync::Mutex,
};

use nsh_core::Color;
use nsh_engine::{Bundle, Root};
use objc2::{
    ClassType, DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send,
    rc::Retained, runtime::AnyObject,
};
use objc2_core_foundation::CGSize;
use objc2_foundation::{
    NSBundle, NSObject, NSObjectProtocol, NSSet, NSString, NSURL, NSUserActivity,
};
use objc2_ui_kit::{
    UIApplication, UIApplicationDelegate, UIColor, UIInterfaceOrientationMask, UIResponder,
    UIScene, UISceneConfiguration, UISceneConnectionOptions, UISceneDelegate, UISceneSession,
    UIUserInterfaceStyle, UIView, UIViewController, UIWindow, UIWindowScene, UIWindowSceneDelegate,
    UIWindowSceneSessionRoleApplication,
};

use crate::{image::AssetBase, surface::SurfaceOptions, view::AppView};

/// Size of the Mac Catalyst window: an iPhone-sized simulator.
const CATALYST_WINDOW: CGSize = CGSize {
    width: 390.0,
    height: 844.0,
};

/// What a standalone app runs.
#[derive(Debug, Clone)]
#[allow(
    clippy::large_enum_variant,
    reason = "one source per app; keep the public constructor API without allocation"
)]
pub enum AppSource {
    /// A Rust app: its root component.
    Rust(Root),
    /// A JS bundle shipped with (or passed to) the app.
    Bundle(Bundle),
    /// A dev server (`ws://host:port/ws`); bundles are pushed on every
    /// rebuild.
    #[cfg(feature = "dev")]
    DevServer(String),
}

/// Options for [`run_app`].
#[derive(Debug, Clone, Default)]
pub struct AppOptions {
    /// Log per-commit timings.
    pub trace: bool,
    /// Where bundled image assets are (for [`AppSource::Bundle`]); dev
    /// servers serve them themselves.
    pub asset_base: Option<AssetBase>,
    /// Where the apps keep their data, each in `<support_dir>/<app id>`:
    /// `None` uses the app's own data directory
    /// ([`SurfaceOptions::support_dir`]'s default).
    pub support_dir: Option<std::path::PathBuf>,
    /// Where the apps keep their caches (the images they downloaded) and
    /// how much each keeps ([`SurfaceOptions::cache`]).
    pub cache: nsh_engine::CacheOptions,
    /// Logs the performance monitor's readings once a second
    /// ([`SurfaceOptions::fps`]).
    pub fps: bool,
    /// The app's channel with the apps it runs (`nsh/host`): their launch
    /// parameters, events to them and handlers of their calls and posts
    /// ([`SurfaceOptions::host`]). A new one by default.
    pub host: nsh_engine::HostChannel,
    /// Runtime for app work. When omitted NSH owns the runtime.
    pub runtime: Option<tokio::runtime::Handle>,
}

/// Whether `path` is inside the app's own bundle (which the system verifies
/// and keeps read-only): the only place bytecode files load from.
pub fn in_app_bundle(path: &std::path::Path) -> bool {
    let bundle = objc2_foundation::NSBundle::mainBundle()
        .bundlePath()
        .to_string();
    match (std::fs::canonicalize(path), std::fs::canonicalize(bundle)) {
        (Ok(path), Ok(bundle)) => path.starts_with(bundle),
        _ => false,
    }
}

/// Launch parameters, handed from [`run_app`] to the scene delegate that
/// UIKit instantiates by class.
static LAUNCH: Mutex<Option<(AppSource, AppOptions)>> = Mutex::new(None);

/// Main-thread state of the standalone app.
struct AppState {
    _window: Retained<UIWindow>,
    view: AppView,
}

thread_local! {
    static APP: RefCell<Option<AppState>> = const { RefCell::new(None) };
}

define_class!(
    #[unsafe(super(UIResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    pub(crate) struct AppDelegate;

    unsafe impl NSObjectProtocol for AppDelegate {}

    unsafe impl UIApplicationDelegate for AppDelegate {
        // Before launching finishes, or a press that starts the app is lost.
        #[unsafe(method(application:willFinishLaunchingWithOptions:))]
        fn will_finish_launching(
            &self,
            _application: &UIApplication,
            _options: Option<&objc2::runtime::AnyObject>,
        ) -> bool {
            crate::notifications::install();
            true
        }

        #[unsafe(method_id(application:configurationForConnectingSceneSession:options:))]
        fn configuration_for_scene(
            &self,
            _application: &UIApplication,
            session: &UISceneSession,
            _options: &UISceneConnectionOptions,
        ) -> Retained<UISceneConfiguration> {
            let config = UISceneConfiguration::initWithName_sessionRole(
                UISceneConfiguration::alloc(self.mtm()),
                None,
                &session.role(),
            );
            // SAFETY: `SceneDelegate` implements `UIWindowSceneDelegate`.
            unsafe { config.setDelegateClass(Some(SceneDelegate::class())) };
            config
        }
    }
);

define_class!(
    #[unsafe(super(UIResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    struct SceneDelegate;

    unsafe impl NSObjectProtocol for SceneDelegate {}

    unsafe impl UISceneDelegate for SceneDelegate {
        #[unsafe(method(scene:willConnectToSession:options:))]
        fn will_connect(
            &self,
            scene: &UIScene,
            session: &UISceneSession,
            options: &UISceneConnectionOptions,
        ) {
            // SAFETY: reading an immutable UIKit constant.
            if *session.role() != *unsafe { UIWindowSceneSessionRoleApplication } {
                return;
            }
            let Some(scene) = scene.downcast_ref::<UIWindowScene>() else {
                return;
            };
            connect(self.mtm(), scene);
            // The link that launched the app, if one did.
            // SAFETY: a documented property, a set of `UIOpenURLContext`;
            // nil when no link launched the app (iOS 27 returns nil, not an
            // empty set).
            let contexts: Option<Retained<NSSet<AnyObject>>> =
                unsafe { msg_send![options, URLContexts] };
            if let Some(contexts) = contexts {
                url_schemes(&contexts);
            }
            // An address continued from another device (Handoff), or a
            // Universal Link, that launched the app.
            // SAFETY: a documented property, a set of `NSUserActivity`; read
            // as nullable, as `URLContexts` above.
            let activities: Option<Retained<NSSet<NSUserActivity>>> =
                unsafe { msg_send![options, userActivities] };
            for activity in activities.iter().flat_map(|set| set.iter()) {
                continue_activity(&activity);
            }
        }

        // Links of the schemes the app claims (`CFBundleURLTypes`) while it
        // runs.
        #[unsafe(method(scene:openURLContexts:))]
        fn open_url_contexts(&self, _scene: &UIScene, contexts: &NSSet<AnyObject>) {
            url_schemes(contexts);
        }

        // An address continued while the app runs (`SurfaceOptions::handoff`),
        // or a Universal Link.
        #[unsafe(method(scene:continueUserActivity:))]
        fn continue_user_activity(&self, _scene: &UIScene, activity: &NSUserActivity) {
            continue_activity(activity);
        }
    }

    unsafe impl UIWindowSceneDelegate for SceneDelegate {}
);

const WHITE_BACKDROP: Color = Color::rgba(255, 255, 255, 255);

define_class!(
    /// The window's root controller: shows the status bar the app sets,
    /// and takes the orientations of the page shown.
    #[unsafe(super(UIViewController, UIResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = Cell<Color>]
    pub(crate) struct RootController;

    impl RootController {
        #[unsafe(method(preferredStatusBarStyle))]
        fn preferred_status_bar_style(&self) -> objc2_ui_kit::UIStatusBarStyle {
            crate::system::preferred_status_bar_style()
        }

        #[unsafe(method(prefersStatusBarHidden))]
        fn prefers_status_bar_hidden(&self) -> bool {
            crate::system::prefers_status_bar_hidden()
        }

        #[unsafe(method(preferredStatusBarUpdateAnimation))]
        fn preferred_status_bar_update_animation(&self) -> objc2_ui_kit::UIStatusBarAnimation {
            crate::system::status_bar_animation()
        }

        #[unsafe(method(supportedInterfaceOrientations))]
        fn supported_interface_orientations(&self) -> UIInterfaceOrientationMask {
            if let Some(mask) = crate::system::page_orientations() {
                return mask;
            }
            // SAFETY: calling the superclass implementation.
            unsafe { msg_send![super(self), supportedInterfaceOrientations] }
        }
    }
);

impl RootController {
    fn install(window: &UIWindow) -> Retained<UIView> {
        let this = Self::alloc(window.mtm()).set_ivars(Cell::new(WHITE_BACKDROP));
        // SAFETY: the superclass's designated initializer, without a nib.
        let controller: Retained<Self> = unsafe {
            msg_send![super(this), initWithNibName: None::<&NSString>, bundle: None::<&NSBundle>]
        };
        controller.apply_appearance(window, crate::system::appearance());
        let root = controller.view().expect("view controller has a view");
        // A surface without a background still draws black text by default.
        let background = UIColor::whiteColor();
        root.setBackgroundColor(Some(&background));
        window.setBackgroundColor(Some(&background));
        window.setRootViewController(Some(&controller));
        root
    }

    pub(crate) fn for_surface(root: &UIView) -> Option<(Retained<Self>, Retained<UIWindow>)> {
        let window = root.window()?;
        let controller = window.rootViewController()?.downcast::<Self>().ok()?;
        let view = controller.viewIfLoaded()?;
        root.isDescendantOfView(&view)
            .then_some((controller, window))
    }

    pub(crate) fn set_backdrop(&self, window: &UIWindow, color: Option<Color>) {
        let color = color.unwrap_or(WHITE_BACKDROP);
        if self.ivars().replace(color) == color {
            return;
        }
        let background = if color == WHITE_BACKDROP {
            UIColor::whiteColor()
        } else {
            let (r, g, b, a) = color.to_f64();
            UIColor::colorWithRed_green_blue_alpha(r, g, b, a)
        };
        let root = self.view().expect("view controller has a view");
        root.setBackgroundColor(Some(&background));
        window.setBackgroundColor(Some(&background));
    }

    pub(crate) fn apply_appearance(&self, window: &UIWindow, style: UIUserInterfaceStyle) {
        window.setOverrideUserInterfaceStyle(style);
        self.setOverrideUserInterfaceStyle(style);
    }
}

/// Hands the address `activity` carries ([`nsh_platform_apple::handoff`])
/// to the app as a link: one handed off from another device, or a web link
/// (a Universal Link), which the core checks as every link.
fn continue_activity(activity: &NSUserActivity) {
    let Some(url) = nsh_platform_apple::handoff::continued_url(activity)
        .or_else(|| nsh_platform_apple::handoff::web_link(activity))
    else {
        return;
    };
    APP.with(|app| match &*app.borrow() {
        Some(app) => app.view.url_scheme(url),
        None => log::warn!("link dropped: no app runs"),
    });
}

/// Hands the URLs of `contexts` (`UIOpenURLContext`s) to the app.
fn url_schemes(contexts: &NSSet<AnyObject>) {
    for context in contexts.iter() {
        // SAFETY: `UIOpenURLContext`'s documented `URL` property.
        let url: Retained<NSURL> = unsafe { msg_send![&*context, URL] };
        let Some(url) = url.absoluteString() else {
            continue;
        };
        APP.with(|app| match &*app.borrow() {
            Some(app) => app.view.url_scheme(url.to_string()),
            None => log::warn!("link dropped: no app runs"),
        });
    }
}

fn connect(mtm: MainThreadMarker, scene: &UIWindowScene) {
    let Some((source, options)) = LAUNCH.lock().expect("launch lock").take() else {
        return log::error!("no app to launch");
    };
    if let Some(restrictions) = scene.sizeRestrictions() {
        // Only Mac Catalyst has resizable windows.
        restrictions.setMinimumSize(CATALYST_WINDOW);
        restrictions.setMaximumSize(CATALYST_WINDOW);
    }
    hide_title(scene);
    let window = UIWindow::initWithWindowScene(UIWindow::alloc(mtm), scene);
    let root = RootController::install(&window);
    window.makeKeyAndVisible();
    let view = AppView::new(
        mtm,
        root.bounds(),
        SurfaceOptions {
            trace: options.trace,
            fps: options.fps,
            host: options.host,
            runtime: options.runtime,
            asset_base: options.asset_base,
            support_dir: options
                .support_dir
                .or_else(|| SurfaceOptions::default().support_dir),
            cache: options.cache,
            // An app on its own (the development host, the release runner),
            // not a module embedded in another app.
            limits: nsh_engine::Limits::standalone(),
            handoff: nsh_platform_apple::handoff::declared(),
            ..SurfaceOptions::default()
        },
    );
    root.addSubview(view.view());
    match source {
        AppSource::Rust(root) => view.run(root),
        AppSource::Bundle(bundle) => view.load(bundle),
        #[cfg(feature = "dev")]
        AppSource::DevServer(url) => view.connect_dev_server(url),
    }
    APP.with(|app| {
        *app.borrow_mut() = Some(AppState {
            _window: window,
            view,
        })
    });
}

/// Mac Catalyst: hides the window's title and toolbar, so the title bar is
/// a transparent strip over the content (like iOS's status bar) and stacks
/// show their own header (kept in the window with the iPad style,
/// `navigation::keep_in_window`), with the app's colors, below the window
/// controls. The window's title would otherwise repeat the header's.
fn hide_title(scene: &UIWindowScene) {
    // `UIWindowScene.titlebar` exists only on Mac Catalyst (objc2 does not
    // declare it).
    if !scene.respondsToSelector(objc2::sel!(titlebar)) {
        return;
    }
    // SAFETY: `titlebar` returns a `UITitlebar` (or nil).
    let titlebar: Option<Retained<AnyObject>> = unsafe { msg_send![scene, titlebar] };
    let Some(titlebar) = titlebar else { return };
    // SAFETY: `UITitlebar`'s setters: `titleVisibility` is an NSInteger
    // enum (1 is `UITitlebarTitleVisibilityHidden`), `toolbar` a nullable
    // `NSToolbar`.
    unsafe {
        let _: () = msg_send![&*titlebar, setTitleVisibility: 1isize];
        let _: () = msg_send![&*titlebar, setToolbar: Option::<&AnyObject>::None];
    }
}

/// Runs a standalone app full-window. Never returns.
///
/// Must be called on the main thread, before any other UIKit use. The
/// application delegate's callbacks reach the observers added before it
/// ([`crate::on_application_event`]).
pub fn run_app(source: AppSource, options: AppOptions) -> ! {
    let mtm = MainThreadMarker::new().expect("run_app must be called on the main thread");
    *LAUNCH.lock().expect("launch lock") = Some((source, options));
    let delegate = NSString::from_str(
        crate::application::delegate_class()
            .name()
            .to_str()
            .expect("class name is UTF-8"),
    );
    UIApplication::main(None, Some(&delegate), mtm)
}

#[cfg(test)]
mod tests {
    use nsh_core::{Color, platform::Appearance};
    use objc2::MainThreadMarker;
    use objc2_core_foundation::CGRect;
    use objc2_ui_kit::{
        UIColor, UIUserInterfaceStyle as Style, UIView, UIViewController, UIWindow,
    };

    use super::{AppView, RootController};
    use crate::system::set_appearance;

    #[test]
    #[ignore = "requires a UIKit main-thread harness"]
    fn standalone_backdrops_keep_unstyled_text_readable_and_follow_app_colors() {
        let mtm = MainThreadMarker::new().expect("UIKit needs the main thread");
        let surface = UIView::new(mtm);
        set_appearance(Appearance::Dark, &surface);

        let window = UIWindow::new(mtm);
        let root = RootController::install(&window);
        let controller = window.rootViewController().unwrap();
        let assert_backdrop = |expected: &UIColor| {
            assert_eq!(root.backgroundColor().as_deref(), Some(expected));
            assert_eq!(window.backgroundColor().as_deref(), Some(expected));
        };
        assert_backdrop(&UIColor::whiteColor());
        assert_eq!(window.overrideUserInterfaceStyle(), Style::Dark);
        assert_eq!(controller.overrideUserInterfaceStyle(), Style::Dark);

        window.addSubview(&root);
        root.addSubview(&surface);
        for (appearance, style) in [
            (Appearance::Light, Style::Light),
            (Appearance::Dark, Style::Dark),
            (Appearance::System, Style::Unspecified),
        ] {
            set_appearance(appearance, &surface);
            assert_eq!(window.overrideUserInterfaceStyle(), style);
            assert_eq!(controller.overrideUserInterfaceStyle(), style);
            assert_eq!(surface.overrideUserInterfaceStyle(), style);
            assert_backdrop(&UIColor::whiteColor());
        }

        let controller = controller.downcast::<RootController>().unwrap();
        for color in [Color::BLACK, Color::rgba(242, 242, 247, 255)] {
            controller.set_backdrop(&window, Some(color));
            let (r, g, b, a) = color.to_f64();
            assert_backdrop(&UIColor::colorWithRed_green_blue_alpha(r, g, b, a));
        }
        controller.set_backdrop(&window, None);
        assert_backdrop(&UIColor::whiteColor());
    }

    #[cfg(feature = "js")]
    #[test]
    #[ignore = "requires a UIKit main-thread harness"]
    fn animated_backdrop_follows_color_only_while_the_view_covers_the_surface() {
        use std::{cell::RefCell, sync::Arc};

        use dispatch2::MainThreadBound;
        use nsh_core::{
            ApproxTextEngine, ClipInset, ColorStop, Effects, Gradient, GradientKind,
            KeyframeAnimation, Keyframes, LayoutAnimation, LayoutCurve, LayoutTransition,
            MountBatch, MountItem, ROOT_ID, Transition, TransitionProps, ViewKind, ViewStyle,
            animation::{AnimationOp, AnimationProp, Easing, Extrapolate, Output},
            geometry::{Radians, point, px, size},
        };
        use nsh_engine::{Bundle, Engine, EngineConfig, MountSink, Policy};
        use objc2_core_foundation::{CGPoint, CGSize};
        use objc2_foundation::{NSDate, NSRunLoop, ns_string};
        use objc2_quartz_core::{CABasicAnimation, CAMediaTiming};

        use crate::mount::Mounter;

        struct IgnoreMounts;
        impl MountSink for IgnoreMounts {
            fn submit(&self, _: MountBatch) {}
        }

        let mtm = MainThreadMarker::new().expect("UIKit needs the main thread");
        let engine = Engine::start(
            EngineConfig::new(Bundle::source(String::new())),
            || ApproxTextEngine,
            IgnoreMounts,
        )
        .unwrap();
        let window = UIWindow::new(mtm);
        let bounds = CGRect::new(CGPoint::ZERO, CGSize::new(390.0, 844.0));
        window.setFrame(bounds);
        let root = RootController::install(&window);
        window.addSubview(&root);
        window.setHidden(false);
        let surface = UIView::initWithFrame(mtm.alloc(), bounds);
        root.addSubview(&surface);
        let shared = Arc::new(MainThreadBound::new(RefCell::new(None), mtm));
        let mounter = Mounter::new(
            mtm,
            surface,
            engine.control(),
            shared.clone(),
            None,
            Arc::new(Policy::default().access()),
            Default::default(),
        );
        *shared.get(mtm).borrow_mut() = Some(mounter);
        let apply = |items| {
            shared
                .get(mtm)
                .borrow_mut()
                .as_mut()
                .unwrap()
                .apply(MountBatch { items });
        };
        let assert_backdrop = |expected: &UIColor| {
            assert_eq!(root.backgroundColor().as_deref(), Some(expected));
            assert_eq!(window.backgroundColor().as_deref(), Some(expected));
        };

        let id = 2;
        let light = Color::rgba(242, 242, 247, 255);
        apply(vec![
            MountItem::Create {
                id,
                kind: ViewKind::View,
            },
            MountItem::Insert {
                parent: ROOT_ID,
                child: id,
                before: None,
            },
            MountItem::Frame {
                id,
                frame: nsh_core::Bounds::new(point(px(0.0), px(0.0)), size(px(390.0), px(844.0))),
            },
            MountItem::Animation(AnimationOp::CreateValue {
                node: 1,
                value: 0.0,
            }),
            MountItem::Animation(AnimationOp::CreateInterpolate {
                node: 2,
                input: 1,
                input_range: vec![0.0, 1.0],
                output: Output::Colors(vec![Color::BLACK.0, light.0]),
                extrapolate_left: Extrapolate::Clamp,
                extrapolate_right: Extrapolate::Clamp,
                easing: Easing::Linear,
            }),
            MountItem::AnimationBindings {
                id,
                bindings: vec![(AnimationProp::BackgroundColor, 2)],
            },
        ]);
        let black = UIColor::colorWithRed_green_blue_alpha(0.0, 0.0, 0.0, 1.0);
        assert_backdrop(&black);
        apply(vec![MountItem::Animation(AnimationOp::Set {
            node: 1,
            value: 1.0,
        })]);
        let (r, g, b, a) = light.to_f64();
        assert_backdrop(&UIColor::colorWithRed_green_blue_alpha(r, g, b, a));

        apply(vec![MountItem::Animation(AnimationOp::Set {
            node: 1,
            value: 0.0,
        })]);
        assert_backdrop(&black);
        let rounded = ViewStyle {
            border_radius: px(24.0),
            ..Default::default()
        };
        let clipped = ViewStyle {
            effects: Some(Arc::new(Effects {
                clip_path: Some(ClipInset::new().inset(px(8.0))),
                ..Default::default()
            })),
            ..Default::default()
        };
        let masked = ViewStyle {
            effects: Some(Arc::new(Effects {
                mask_images: vec![Gradient {
                    kind: GradientKind::Linear {
                        angle: Radians(0.0),
                    },
                    stops: [Color::BLACK, Color::TRANSPARENT]
                        .map(|color| ColorStop {
                            color,
                            position: None,
                        })
                        .to_vec(),
                    repeating: false,
                }],
                ..Default::default()
            })),
            ..Default::default()
        };
        let pulsing = ViewStyle {
            animation: Some(KeyframeAnimation::new(Keyframes::Pulse)),
            ..Default::default()
        };
        for style in [rounded, clipped, masked, pulsing] {
            apply(vec![MountItem::ViewStyle {
                id,
                style: Box::new(ViewStyle::default()),
            }]);
            assert_backdrop(&black);
            apply(vec![MountItem::ViewStyle {
                id,
                style: Box::new(style),
            }]);
            assert_backdrop(&UIColor::whiteColor());
        }
        let mut transition = Transition::default();
        transition.properties = TransitionProps(TransitionProps::OPACITY);
        transition.duration = 100.0;
        let fade_in = ViewStyle {
            transition: Some(transition),
            ..Default::default()
        };
        apply(vec![MountItem::ViewStyle {
            id,
            style: Box::new(fade_in.clone()),
        }]);
        assert_backdrop(&black);
        apply(vec![MountItem::ViewStyle {
            id,
            style: Box::new(ViewStyle {
                opacity: 0.5,
                ..Default::default()
            }),
        }]);
        apply(vec![MountItem::ViewStyle {
            id,
            style: Box::new(fade_in),
        }]);
        assert_backdrop(&UIColor::whiteColor());
        let run_animation = || {
            NSRunLoop::mainRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(1.0));
        };
        run_animation();
        assert_backdrop(&black);

        let incoming = 4;
        apply(vec![
            MountItem::Remove { id },
            MountItem::Delete { id },
            MountItem::LayoutAnimation(LayoutAnimation {
                create: Some(LayoutTransition::new(LayoutCurve::Linear, 100.0)),
                ..Default::default()
            }),
            MountItem::Create {
                id: incoming,
                kind: ViewKind::View,
            },
            MountItem::Frame {
                id: incoming,
                frame: nsh_core::Bounds::new(point(px(0.0), px(0.0)), size(px(390.0), px(844.0))),
            },
            MountItem::Insert {
                parent: ROOT_ID,
                child: incoming,
                before: None,
            },
            MountItem::ViewStyle {
                id: incoming,
                style: Box::new(ViewStyle {
                    background_color: Color::BLACK,
                    ..Default::default()
                }),
            },
        ]);
        assert_backdrop(&UIColor::whiteColor());
        run_animation();
        assert_backdrop(&black);
        {
            let mut mounter = shared.get(mtm).borrow_mut();
            let mounter = mounter.as_mut().unwrap();
            let layer = mounter.ui_view(incoming).unwrap().layer();
            let opacity = ns_string!("opacity");
            let viewport = size(px(390.0), px(844.0));
            for (repeat_count, speed) in [(f32::MAX, 1.0), (0.0, 0.0)] {
                let animation = CABasicAnimation::animationWithKeyPath(Some(opacity));
                animation.setDuration(1.0);
                animation.setRepeatCount(repeat_count);
                animation.setSpeed(speed);
                layer.addAnimation_forKey(&animation, Some(opacity));
                mounter.resized(viewport);
                assert_backdrop(&UIColor::whiteColor());
                assert!(mounter.frame_link_paused());
                layer.removeAnimationForKey(opacity);
                mounter.resized(viewport);
                assert_backdrop(&black);
            }
        }
        shared.get(mtm).borrow_mut().take();
    }

    #[test]
    #[ignore = "requires a UIKit main-thread harness"]
    fn embedded_appearance_keeps_a_full_screen_presenters_style() {
        let mtm = MainThreadMarker::new().expect("UIKit needs the main thread");
        let window = UIWindow::new(mtm);
        let controller = UIViewController::new(mtm);
        window.setOverrideUserInterfaceStyle(Style::Light);
        controller.setOverrideUserInterfaceStyle(Style::Light);
        window.setRootViewController(Some(&controller));
        let presenter_view = controller.view().unwrap();
        let presented = UIViewController::new(mtm);
        let shown_view = presented.view().unwrap();
        // After a full-screen presentation UIKit removes the presenting view.
        window.addSubview(&shown_view);
        assert!(presenter_view.window().is_none());
        let app = AppView::new(mtm, CGRect::ZERO, Default::default());
        shown_view.addSubview(app.view());

        set_appearance(Appearance::Dark, app.view());
        assert_eq!(app.view().overrideUserInterfaceStyle(), Style::Dark);
        assert_eq!(window.overrideUserInterfaceStyle(), Style::Light);
        assert_eq!(controller.overrideUserInterfaceStyle(), Style::Light);
        assert_eq!(presented.overrideUserInterfaceStyle(), Style::Unspecified);
    }
}
