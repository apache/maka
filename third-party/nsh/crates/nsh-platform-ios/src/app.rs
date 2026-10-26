use std::{cell::RefCell, sync::Mutex};

use nsh_engine::{Bundle, Root};
use objc2::{
    ClassType, MainThreadMarker, MainThreadOnly, define_class, msg_send, rc::Retained,
    runtime::AnyObject,
};
use objc2_core_foundation::CGSize;
use objc2_foundation::{NSObject, NSObjectProtocol, NSString};
use objc2_ui_kit::{
    UIApplication, UIApplicationDelegate, UIResponder, UIScene, UISceneConfiguration,
    UISceneConnectionOptions, UISceneDelegate, UISceneSession, UIViewController, UIWindow,
    UIWindowScene, UIWindowSceneDelegate, UIWindowSceneSessionRoleApplication,
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
    /// Where the apps keep their data, each in `<data_dir>/<app id>`:
    /// `None` uses the app's own data directory
    /// ([`SurfaceOptions::data_dir`]'s default).
    pub data_dir: Option<std::path::PathBuf>,
    /// Where the apps keep their caches (the images they downloaded) and
    /// how much each keeps ([`SurfaceOptions::cache`]).
    pub cache: nsh_engine::CacheOptions,
    /// Logs the performance monitor's readings once a second
    /// ([`SurfaceOptions::fps`]).
    pub fps: bool,
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
    _view: AppView,
}

thread_local! {
    static APP: RefCell<Option<AppState>> = const { RefCell::new(None) };
}

define_class!(
    #[unsafe(super(UIResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    struct AppDelegate;

    unsafe impl NSObjectProtocol for AppDelegate {}

    unsafe impl UIApplicationDelegate for AppDelegate {
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
            _options: &UISceneConnectionOptions,
        ) {
            // SAFETY: reading an immutable UIKit constant.
            if *session.role() != *unsafe { UIWindowSceneSessionRoleApplication } {
                return;
            }
            let Some(scene) = scene.downcast_ref::<UIWindowScene>() else {
                return;
            };
            connect(self.mtm(), scene);
        }
    }

    unsafe impl UIWindowSceneDelegate for SceneDelegate {}
);

define_class!(
    /// The window's root controller: shows the status bar the app sets.
    #[unsafe(super(UIViewController, UIResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    struct RootController;

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
    }
);

impl RootController {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        // SAFETY: UIViewController's designated initializer.
        unsafe { msg_send![Self::alloc(mtm), init] }
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
    let controller = RootController::new(mtm);
    let root = controller.view().expect("view controller has a view");
    // Behind an app that sets no background: white, as in React Native (a
    // window shows black otherwise, and text defaults to black).
    root.setBackgroundColor(Some(&objc2_ui_kit::UIColor::whiteColor()));
    window.setRootViewController(Some(&controller));
    window.makeKeyAndVisible();
    let view = AppView::new(
        mtm,
        root.bounds(),
        SurfaceOptions {
            trace: options.trace,
            fps: options.fps,
            asset_base: options.asset_base,
            data_dir: options
                .data_dir
                .or_else(|| SurfaceOptions::default().data_dir),
            cache: options.cache,
            // An app on its own (the development host, the release runner),
            // not a module embedded in another app.
            limits: nsh_engine::Limits::standalone(),
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
            _view: view,
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
/// Must be called on the main thread, before any other UIKit use.
pub fn run_app(source: AppSource, options: AppOptions) -> ! {
    let mtm = MainThreadMarker::new().expect("run_app must be called on the main thread");
    *LAUNCH.lock().expect("launch lock") = Some((source, options));
    let delegate = NSString::from_str(
        AppDelegate::class()
            .name()
            .to_str()
            .expect("class name is UTF-8"),
    );
    UIApplication::main(None, Some(&delegate), mtm)
}
