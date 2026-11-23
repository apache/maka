//! The embedded picker on iOS: `PHPickerViewController` in its compact
//! mode (iOS 17), selecting continuously and in order, as a child of the view controller
//! its component's view is in. The picker runs out of the app's process,
//! so the app needs no access to the library. It is made for the shared
//! library, which gives each result the photo's identifier (the key of its
//! id) and lets the app deselect a photo by it; it does not read the
//! library.
//!
//! The component's view holds the picker's: the picker joins the
//! controller the view is in when the view lays out in a window (its props
//! have arrived by then) and leaves it when the view leaves the window.
//! Each selection change comes to the delegate with every photo selected;
//! a photo is read later, from its item provider ([`ProviderSource`]),
//! prepared off the main thread as a picked image
//! (`nsh_platform_ios::prepare_image`).

use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
    sync::{Arc, Mutex},
};

use block2::RcBlock;
use nsh_core::{JsonValue, picker::PickedFile, prelude::*};
use nsh_platform_ios::{ComponentContext, Components, NativeComponent};
use objc2::{
    DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send,
    rc::{Allocated, Retained, autoreleasepool},
    runtime::{AnyClass, AnyObject},
    sel,
};
use objc2_core_foundation::CGRect;
use objc2_foundation::{NSArray, NSError, NSObject, NSObjectProtocol, NSString, NSURL};
use objc2_ui_kit::{UIResponder, UIView, UIViewAutoresizing, UIViewController};
use tokio::sync::oneshot;

use super::{
    PhotoRequest, PhotosError, PhotosFuture,
    picker::{PICKER_COMPONENT, PickedSource, Selection},
};

/// `PHPickerConfigurationAssetRepresentationModeCompatible`: HEIC comes as
/// JPEG, as `Picker.pickImages` asks.
const COMPATIBLE: isize = 2;

/// `PHPickerConfigurationSelectionContinuousAndOrdered` (iOS 17): each
/// change is reported as it happens, and each photo selected shows its
/// number in the order the user selected it.
const CONTINUOUS_AND_ORDERED: isize = 3;

/// `PHPickerModeCompact` (iOS 17): one row.
const COMPACT: isize = 1;

/// `NSDirectionalRectEdgeAll`: the photos reach the picker's edges.
const ALL_EDGES: usize = 0b1111;

/// `PHPickerCapabilities` the embedded row goes without: search, the
/// staging area, the albums and the Cancel / Add buttons.
const WITHOUT: usize = 0b1111;

/// Whether the system's picker embeds: `PHPickerConfiguration` has iOS
/// 17's `mode`. PhotosUI is linked (`ios.rs`), so its classes are there.
pub(super) fn available() -> bool {
    let Some(class) = AnyClass::get(c"PHPickerConfiguration") else {
        return false;
    };
    // SAFETY: `NSObject`'s documented class method, any thread.
    unsafe { msg_send![class, instancesRespondToSelector: sel!(setMode:)] }
}

/// Registers the picker's component where the system's picker embeds.
pub(crate) fn register(components: &Components) {
    if !available() {
        return;
    }
    components.register(
        PICKER_COMPONENT,
        Rc::new(|context: ComponentContext| -> Box<dyn NativeComponent> {
            let mtm = MainThreadMarker::new().expect("components are made on the main thread");
            Box::new(PickerComponent::new(context, mtm))
        }),
    );
}

/// What the component's view, its delegate and the component share.
struct State {
    context: ComponentContext,
    /// `selectionLimit`: 0 is the system's most.
    limit: Cell<u32>,
    /// `filter`'s name.
    filter: RefCell<String>,
    selection: RefCell<Selection>,
    picker: RefCell<Option<Retained<UIViewController>>>,
    delegate: Retained<PickerDelegate>,
}

impl State {
    /// Makes the picker (when there is none) and has it join the
    /// controller `host` is in, once `host` is in a window.
    fn attach(&self, host: &UIView) {
        if host.window().is_none() {
            return;
        }
        let picker = self.picker.borrow().clone();
        let picker = match picker {
            Some(picker) => picker,
            None => {
                let Some(picker) = self.make() else {
                    return;
                };
                *self.picker.borrow_mut() = Some(picker.clone());
                picker
            }
        };
        if picker.parentViewController().is_some() {
            return;
        }
        let Some(parent) = controller_of(host) else {
            log::warn!("the photos picker is in no view controller: it shows nothing");
            return;
        };
        parent.addChildViewController(&picker);
        if let Some(view) = picker.view() {
            view.setFrame(host.bounds());
            view.setAutoresizingMask(
                UIViewAutoresizing::FlexibleWidth | UIViewAutoresizing::FlexibleHeight,
            );
            host.addSubview(&view);
        }
        picker.didMoveToParentViewController(Some(&parent));
    }

    /// Takes the picker out of its parent controller (it is kept, with its
    /// selection, for when the view is shown again).
    fn detach(&self) {
        let picker = self.picker.borrow().clone();
        if let Some(picker) = picker
            && picker.parentViewController().is_some()
        {
            picker.willMoveToParentViewController(None);
            if let Some(view) = picker.view() {
                view.removeFromSuperview();
            }
            picker.removeFromParentViewController();
        }
    }

    /// A picker for the props, showing the photos selected now selected.
    fn make(&self) -> Option<Retained<UIViewController>> {
        let (Some(config_class), Some(filter_class), Some(picker_class), Some(library_class)) = (
            AnyClass::get(c"PHPickerConfiguration"),
            AnyClass::get(c"PHPickerFilter"),
            AnyClass::get(c"PHPickerViewController"),
            AnyClass::get(c"PHPhotoLibrary"),
        ) else {
            log::warn!("the photos picker cannot be made: PhotosUI is missing");
            return None;
        };
        let limit = self.limit.get();
        let selected: Vec<Retained<NSString>> = if limit == 1 {
            // The system takes no photos shown selected in a picker of one.
            Vec::new()
        } else {
            self.selection
                .borrow()
                .keys()
                .iter()
                .map(|key| NSString::from_str(key))
                .collect()
        };
        // SAFETY: PhotosUI's and Photos' documented API (iOS 17), sent
        // dynamically: `available` checked it is there.
        unsafe {
            let library: Retained<AnyObject> = msg_send![library_class, sharedPhotoLibrary];
            let config: Allocated<AnyObject> = msg_send![config_class, alloc];
            let config: Retained<AnyObject> = msg_send![config, initWithPhotoLibrary: &*library];
            let _: () = msg_send![&config, setSelectionLimit: limit as isize];
            let filter: Retained<AnyObject> = match self.filter.borrow().as_str() {
                "livePhotos" => msg_send![filter_class, livePhotosFilter],
                "screenshots" => msg_send![filter_class, screenshotsFilter],
                _ => msg_send![filter_class, imagesFilter],
            };
            let _: () = msg_send![&config, setFilter: &*filter];
            let _: () = msg_send![&config, setPreferredAssetRepresentationMode: COMPATIBLE];
            let _: () = msg_send![&config, setSelection: CONTINUOUS_AND_ORDERED];
            let _: () = msg_send![&config, setMode: COMPACT];
            let _: () = msg_send![&config, setEdgesWithoutContentMargins: ALL_EDGES];
            let _: () = msg_send![&config, setDisabledCapabilities: WITHOUT];
            let selected = NSArray::from_retained_slice(&selected);
            let _: () = msg_send![&config, setPreselectedAssetIdentifiers: &*selected];
            let picker: Allocated<AnyObject> = msg_send![picker_class, alloc];
            let picker: Option<Retained<AnyObject>> =
                msg_send![picker, initWithConfiguration: &*config];
            let picker: Retained<UIViewController> = Retained::cast_unchecked(picker?);
            let _: () = msg_send![&picker, setDelegate: &*self.delegate];
            Some(picker)
        }
    }

    /// Tells the app the selection is now `ids`.
    fn report(&self, ids: Vec<String>) {
        self.context.emit(
            "change",
            JsonValue::Array(ids.into_iter().map(JsonValue::String).collect()),
        );
    }

    /// The picker's selection is now `results` (`PHPickerResult`s).
    fn selected(&self, results: &NSArray<AnyObject>) {
        let photos = results
            .iter()
            .enumerate()
            .map(|(index, result)| {
                // SAFETY: `PHPickerResult`'s documented properties.
                let (key, provider) = unsafe {
                    let key: Option<Retained<NSString>> = msg_send![&result, assetIdentifier];
                    let provider: Retained<AnyObject> = msg_send![&result, itemProvider];
                    (key, provider)
                };
                // The shared library gives every result its photo's
                // identifier; without one, its place stands in.
                let key = key.map_or_else(|| format!("#{index}"), |key| key.to_string());
                let source: Arc<dyn PickedSource> = Arc::new(ProviderSource::new(provider));
                (key, source)
            })
            .collect();
        let changed = self.selection.borrow_mut().set(photos);
        if let Some(ids) = changed {
            self.report(ids);
        }
    }

    /// The app deselects the photo `id`.
    fn deselect(&self, id: &str) {
        let key = self.selection.borrow().key(id).map(str::to_owned);
        let Some(key) = key else {
            return;
        };
        if let Some(picker) = self.picker.borrow().as_ref() {
            let keys = NSArray::from_retained_slice(&[NSString::from_str(&key)]);
            // SAFETY: PhotosUI's documented API (iOS 16); the picker is
            // made for the shared library, which it needs.
            unsafe {
                let _: () = msg_send![picker, deselectAssetsWithIdentifiers: &*keys];
            }
        }
        // The system may not report a deselection it was told to make.
        let changed = self.selection.borrow_mut().remove(id);
        if let Some(ids) = changed {
            self.report(ids);
        }
    }

    /// The picker's selection limit changed while it is shown.
    fn update_limit(&self) {
        let picker = self.picker.borrow().clone();
        let (Some(picker), Some(class)) = (picker, AnyClass::get(c"PHPickerUpdateConfiguration"))
        else {
            return;
        };
        // SAFETY: PhotosUI's documented API (iOS 17).
        unsafe {
            let update: Retained<AnyObject> = msg_send![class, new];
            let _: () = msg_send![&update, setSelectionLimit: self.limit.get() as isize];
            let _: () = msg_send![&update, setEdgesWithoutContentMargins: ALL_EDGES];
            let _: () = msg_send![&picker, updatePickerUsingConfiguration: &*update];
        }
    }
}

/// The view controller whose view contains `view`.
fn controller_of(view: &UIView) -> Option<Retained<UIViewController>> {
    let mut responder: Option<Retained<UIResponder>> = view.nextResponder();
    while let Some(next) = responder {
        if let Ok(controller) = next.clone().downcast::<UIViewController>() {
            return Some(controller);
        }
        responder = next.nextResponder();
    }
    None
}

pub(crate) struct HostIvars {
    state: Weak<State>,
}

define_class!(
    /// The component's view: holds the picker's, and has the picker join
    /// and leave the controller it is in with the window.
    #[unsafe(super(UIView, UIResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = HostIvars]
    pub(crate) struct PickerHost;

    impl PickerHost {
        #[unsafe(method(didMoveToWindow))]
        fn did_move_to_window(&self) {
            // SAFETY: `UIView`'s method, called on to the superclass.
            let _: () = unsafe { msg_send![super(self), didMoveToWindow] };
            let Some(state) = self.ivars().state.upgrade() else {
                return;
            };
            if self.window().is_some() {
                // Joined at the next layout, after the props.
                self.setNeedsLayout();
            } else {
                state.detach();
            }
        }

        #[unsafe(method(layoutSubviews))]
        fn layout_subviews(&self) {
            // SAFETY: as above.
            let _: () = unsafe { msg_send![super(self), layoutSubviews] };
            if let Some(state) = self.ivars().state.upgrade() {
                state.attach(self);
            }
        }
    }
);

pub(crate) struct DelegateIvars {
    state: RefCell<Weak<State>>,
}

define_class!(
    /// The picker's delegate: hears each selection change.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = DelegateIvars]
    pub(crate) struct PickerDelegate;

    unsafe impl NSObjectProtocol for PickerDelegate {}

    impl PickerDelegate {
        /// `PHPickerViewControllerDelegate`'s one method: with the
        /// continuous selection, every photo selected after each change.
        #[unsafe(method(picker:didFinishPicking:))]
        fn did_finish(&self, _picker: &UIViewController, results: &NSArray<AnyObject>) {
            if let Some(state) = self.ivars().state.borrow().upgrade() {
                state.selected(results);
            }
        }
    }
);

/// The component: its view and what it shares.
struct PickerComponent {
    host: Retained<PickerHost>,
    state: Rc<State>,
}

impl PickerComponent {
    fn new(context: ComponentContext, mtm: MainThreadMarker) -> Self {
        let delegate = PickerDelegate::alloc(mtm).set_ivars(DelegateIvars {
            state: RefCell::new(Weak::new()),
        });
        // SAFETY: `NSObject`'s `init`.
        let delegate: Retained<PickerDelegate> = unsafe { msg_send![super(delegate), init] };
        let state = Rc::new(State {
            context,
            limit: Cell::new(nsh_core::picker::MAX_PICKED),
            filter: RefCell::new("images".into()),
            selection: RefCell::new(Selection::new()),
            picker: RefCell::new(None),
            delegate,
        });
        *state.delegate.ivars().state.borrow_mut() = Rc::downgrade(&state);
        let host = PickerHost::alloc(mtm).set_ivars(HostIvars {
            state: Rc::downgrade(&state),
        });
        // SAFETY: `UIView`'s designated initializer.
        let host: Retained<PickerHost> =
            unsafe { msg_send![super(host), initWithFrame: CGRect::ZERO] };
        host.setClipsToBounds(true);
        Self { host, state }
    }
}

impl NativeComponent for PickerComponent {
    fn view(&self) -> &UIView {
        &self.host
    }

    fn set_prop(&mut self, name: &str, value: Option<&JsonValue>) {
        let state = &self.state;
        match name {
            "selectionLimit" => {
                let limit = value
                    .and_then(JsonValue::as_u64)
                    .map_or(nsh_core::picker::MAX_PICKED, |limit| {
                        u32::try_from(limit).unwrap_or(u32::MAX)
                    });
                if limit != state.limit.replace(limit) {
                    state.update_limit();
                }
            }
            "filter" => {
                let filter = value.and_then(JsonValue::as_str).unwrap_or("images");
                if *state.filter.borrow() == filter {
                    return;
                }
                *state.filter.borrow_mut() = filter.into();
                // The filter is the configuration's: a new picker shows it,
                // the photos selected still selected.
                if state.picker.borrow().is_some() {
                    state.detach();
                    *state.picker.borrow_mut() = None;
                    self.host.setNeedsLayout();
                }
            }
            _ => {}
        }
    }

    fn command(&mut self, name: &str, args: &JsonValue) {
        if name == "deselect"
            && let Some(id) = args.as_str()
        {
            self.state.deselect(id);
        }
    }
}

impl Drop for PickerComponent {
    fn drop(&mut self) {
        self.state.detach();
        if let Some(picker) = self.state.picker.borrow_mut().take() {
            // SAFETY: the picker's documented delegate property.
            unsafe {
                let _: () = msg_send![&picker, setDelegate: Option::<&AnyObject>::None];
            }
        }
    }
}

/// An `NSItemProvider` read from any thread.
struct SentProvider(Retained<AnyObject>);

// SAFETY: `NSItemProvider` is documented thread-safe (Sendable), and its
// loading methods may be called from any thread.
unsafe impl Send for SentProvider {}
// SAFETY: as above.
unsafe impl Sync for SentProvider {}

/// Reads a selected photo from its item provider.
struct ProviderSource {
    provider: SentProvider,
}

impl ProviderSource {
    fn new(provider: Retained<AnyObject>) -> Self {
        Self {
            provider: SentProvider(provider),
        }
    }
}

/// The progress of a file's load, cancelled when dropped before it ended:
/// the future reading it went away.
struct Loading(Option<Retained<AnyObject>>);

// SAFETY: `NSProgress` is thread-safe.
unsafe impl Send for Loading {}

impl Loading {
    fn ended(mut self) {
        self.0 = None;
    }
}

impl Drop for Loading {
    fn drop(&mut self) {
        if let Some(progress) = self.0.take() {
            // SAFETY: `NSProgress`'s documented method, any thread.
            unsafe {
                let _: () = msg_send![&progress, cancel];
            }
        }
    }
}

impl PickedSource for ProviderSource {
    fn load(&self, request: PhotoRequest) -> PhotosFuture<PickedFile> {
        let provider = &self.provider.0;
        // SAFETY: `NSItemProvider`'s documented property (iOS 11).
        let suggested: Option<Retained<NSString>> = unsafe { msg_send![provider, suggestedName] };
        let name = suggested.map(|name| name.to_string()).unwrap_or_default();
        let (answer, answered) = oneshot::channel::<Result<(Vec<u8>, String), PhotosError>>();
        let answer = Mutex::new(Some(answer));
        let handler = RcBlock::new(move |url: *mut NSURL, error: *mut NSError| {
            let Some(answer) = answer.lock().unwrap_or_else(|e| e.into_inner()).take() else {
                return;
            };
            // SAFETY: the URL of the file the provider wrote and an error,
            // each nil or valid until this returns.
            let (url, error) = unsafe { (url.as_ref(), error.as_ref()) };
            // The file goes when this returns: its bytes are read now.
            let read = match url.and_then(|url| url.path()) {
                Some(path) => {
                    let path = path.to_string();
                    let extension = path.rsplit_once('.').map(|(_, e)| e.to_owned());
                    let file_name = match (name.is_empty(), extension) {
                        (false, Some(extension)) => format!("{name}.{extension}"),
                        (false, None) => name.clone(),
                        (true, _) => path.rsplit('/').next().unwrap_or("photo").to_owned(),
                    };
                    std::fs::read(&path)
                        .map(|bytes| (bytes, file_name))
                        .map_err(|e| PhotosError::failed(format!("the photo cannot be read: {e}")))
                }
                None => Err(PhotosError::failed(match error {
                    Some(error) => {
                        format!("the photo cannot be read: {}", error.localizedDescription())
                    }
                    None => "the photo cannot be read".into(),
                })),
            };
            drop(answer.send(read));
        });
        let image = NSString::from_str("public.image");
        // SAFETY: `NSItemProvider`'s documented API (iOS 11); the handler
        // runs once, on a queue of the provider's.
        let progress: Option<Retained<AnyObject>> = unsafe {
            msg_send![
                provider,
                loadFileRepresentationForTypeIdentifier: &*image,
                completionHandler: &*handler
            ]
        };
        let loading = Loading(progress);
        Box::pin(async move {
            let read = answered
                .await
                .map_err(|_| PhotosError::failed("the photo's read ended without its file"));
            loading.ended();
            let (bytes, name) = read??;
            blocking(move || {
                autoreleasepool(|_| {
                    nsh_platform_ios::prepare_image(bytes, &name, &request.pick_request())
                        .ok_or_else(|| PhotosError::failed("the photo cannot be decoded"))
                })
            })
            .await
            .map_err(|error| PhotosError::failed(format!("cannot prepare the photo: {error}")))?
        })
    }
}
