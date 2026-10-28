//! The native peer of one `NshView`: runs the engine, hands commits to the
//! UI thread and owns the UI-thread animator. Every `Native.java` method is
//! exported here.

use std::{
    collections::{BTreeMap, VecDeque},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};

use jni::{
    JNIEnv,
    objects::{GlobalRef, JByteArray, JClass, JFloatArray, JObject, JObjectArray, JString, JValue},
    signature::{Primitive, ReturnType},
    sys::{jboolean, jfloat, jfloatArray, jint, jlong},
};
use nsh_core::{
    EventKind, EventPayload, MountBatch, MountItem, NodeId, PayloadValue, Points, Size,
    geometry::{DevicePixels, point, px, size},
};
use nsh_engine::{
    App, Assets, Bundle, ColorScheme, Edges, Engine, EngineConfig, EngineControl, Environment,
    Idiom, Locale, MountSink, Policy, Root,
};

use crate::{
    animation::UiAnimation,
    encode::{self, Obj},
    java::{java, with_env},
    text::{AndroidTextEngine, Density},
};

pub(crate) struct Host {
    /// The `NshView`.
    pub(crate) view: GlobalRef,
    density: Density,
    trace: bool,
    engine: Mutex<Option<Engine>>,
    /// The running engine's control, for answers the sink gives itself
    /// (never locked while an engine stops, unlike `engine`).
    answers: Mutex<Option<EngineControl>>,
    /// The app, waiting for the first non-empty size.
    pending: Mutex<Option<App>>,
    viewport: Mutex<Size<Points>>,
    environment: Mutex<Environment>,
    /// Animation items of submitted batches, by batch number, applied on the
    /// UI thread once Java has applied that batch.
    animation_queue: Mutex<VecDeque<(u64, Vec<MountItem>)>>,
    /// Retirement replies retain the engine that submitted their batch.
    retirements: Mutex<BTreeMap<(u64, NodeId, u64), EngineControl>>,
    seq: AtomicU64,
    ui: Mutex<UiAnimation>,
    epoch: Instant,
    /// What the embedding app grants loaded apps at most
    /// (`NshView.setGrantedCapabilities`).
    granted: Mutex<Option<nsh_engine::Capabilities>>,
    /// The VM limits of loaded apps (`NshView.setLimits`).
    limits: Mutex<nsh_engine::Limits>,
    /// Where loaded apps keep their data, each in a directory named by its
    /// id ([`EngineConfig::data_dir`]): `nsh` in the files directory.
    data_dir: Option<std::path::PathBuf>,
    /// The directory loaded apps keep their storage in, overriding their own
    /// (`NshView.setStorageDirectory`); `None`: theirs.
    storage: Mutex<Option<std::path::PathBuf>>,
    /// What the running app may reach (web view navigations check it).
    access: Mutex<Arc<nsh_engine::Access>>,
    /// The embedding app's theme overrides (`NshView.setThemeOverrides`).
    host_tokens: Mutex<Option<nsh_engine::Tokens>>,
    /// The bytes of the in-memory images (`data:` URIs, blobs) the app
    /// shows, by URI, for `Images.java` (`Native.imageBytes`).
    inline_images: Mutex<nsh_core::image::InlineImages>,
    /// Where loaded apps keep their caches (`NshView.setCacheOptions`).
    cache: Mutex<nsh_engine::CacheOptions>,
    /// What [`nsh_engine::CacheLocation::System`] is here: `nsh` in the
    /// Context's cache directory (only the platform knows it).
    system_cache_dir: Option<std::path::PathBuf>,
    /// The running app's disk cache of downloaded images, for
    /// `Images.java` (`Native.imageCacheLookup` / `imageCacheComplete`).
    image_cache: Mutex<Option<nsh_core::image::DiskCache>>,
    /// The embedding app's channel with the apps (`nsh/host`; Java
    /// `NshView.setParams`, `send`, `handle`).
    host: nsh_engine::HostChannel,
    /// The app's keyboard shortcuts, matched on the UI thread.
    pub(crate) keymap: Mutex<crate::keymap::KeymapState>,
    #[cfg(feature = "dev")]
    pub(crate) dev: Mutex<Option<crate::dev::DevSession>>,
    /// A test session's model of the app (`nsh test --target android`):
    /// every batch and error goes to it.
    #[cfg(feature = "dev")]
    pub(crate) test_model: Mutex<Option<Arc<nsh_testing::agent::Model>>>,
}

impl Host {
    /// The display's density: pixels per point.
    #[cfg(feature = "dev")]
    pub(crate) fn density(&self) -> f32 {
        self.density.get()
    }

    /// Whether the native animation graph animates.
    #[cfg(feature = "dev")]
    pub(crate) fn animating(&self) -> bool {
        self.ui.lock().is_ok_and(|ui| ui.animating())
    }

    fn control(&self) -> Option<EngineControl> {
        self.engine.lock().ok()?.as_ref().map(Engine::control)
    }

    /// Hands event `kind` of node `id` to the running app.
    pub(crate) fn dispatch(&self, id: NodeId, kind: EventKind, payload: EventPayload) {
        if let Some(control) = self.control() {
            control.dispatch_event(id, kind, payload);
        }
    }

    /// The VM limits of the apps loaded from now on.
    pub(crate) fn set_limits(&self, limits: nsh_engine::Limits) {
        *self.limits.lock().expect("limits") = limits;
    }

    /// The embedding app's theme overrides (`None`: the app's own theme):
    /// sent to the running app at once, and to every app loaded later
    /// before its first frame.
    fn set_host_tokens(&self, tokens: Option<nsh_engine::Tokens>) {
        *self.host_tokens.lock().expect("tokens") = tokens.clone();
        if let Some(control) = self.control() {
            control.set_tokens(tokens);
        }
    }

    /// Runs `app`, replacing the running app.
    pub(crate) fn load(self: &Arc<Self>, app: impl Into<App>) {
        let mut app = app.into();
        let access = match &mut app {
            App::Js(bundle) => {
                if let Some(granted) = self.granted.lock().expect("granted").clone() {
                    bundle.policy.granted = Some(granted);
                }
                bundle.policy.access()
            }
            // Native code reaches what the platform allows.
            App::Rust(_) => Policy::default().access(),
        };
        *self.access.lock().expect("access") = Arc::new(access);
        let viewport = *self.viewport.lock().expect("viewport");
        if viewport.width <= px(0.0) || viewport.height <= px(0.0) {
            *self.pending.lock().expect("pending") = Some(app);
            return;
        }
        // Stop the old engine first: its batches must not reach the new app.
        *self.answers.lock().expect("answers") = None;
        let old = self.engine.lock().expect("engine").take();
        if let Some(old) = old {
            drop(old);
            // No `Delete` follows for its views: its native components
            // are told here (`NshComponent.destroy`).
            self.app_stopped();
        }
        *self.animation_queue.lock().expect("queue") = VecDeque::new();
        self.retirements.lock().expect("retirements").clear();
        self.keymap
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.ui.lock().expect("ui").reset();
        let mut cache = self.cache.lock().expect("cache options").clone();
        if cache.location == nsh_engine::CacheLocation::System {
            cache.location = match &self.system_cache_dir {
                Some(dir) => nsh_engine::CacheLocation::Dir(dir.clone()),
                None => nsh_engine::CacheLocation::Off,
            };
        }
        #[allow(unused_mut)]
        let mut config = EngineConfig {
            app,
            viewport,
            trace: self.trace,
            network: Some(crate::net::network()),
            websocket: None,
            filesystem: None,
            chunk_loader: None,
            assets: Some(Arc::new(ViewAssets(self.clone()))),
            environment: *self.environment.lock().expect("environment"),
            // Android's toolbar is 56dp; it has no large titles.
            header_heights: (nsh_core::Points(56.0), nsh_core::Points(56.0)),
            limits: *self.limits.lock().expect("limits"),
            ui_sets: crate::ui_sets(),
            runtime: None,
            data_dir: self.data_dir.clone(),
            cache,
            storage: self.storage.lock().expect("storage").as_ref().map(|dir| {
                nsh_engine::FileStorage::open(dir) as Arc<dyn nsh_engine::StorageBackend>
            }),
            clock: Default::default(),
            context: Default::default(),
            pinned: Default::default(),
            clipboard: None,
            host: self.host.clone(),
            picker: None,
        };
        let density = self.density.clone();
        let control_slot = Arc::new(OnceLock::new());
        let sink = Sink(self.clone(), control_slot.clone());
        // A test session's app: the test's storage, network and trace.
        #[cfg(feature = "dev")]
        if let Some(model) = &*self.test_model.lock().unwrap_or_else(|e| e.into_inner()) {
            model.set_up_engine(&mut config);
        }
        // The embedding app's theme overrides are in the first frame.
        let tokens = self.host_tokens.lock().expect("tokens").clone();
        let setup = |control: &EngineControl| {
            let _ = control_slot.set(control.clone());
            if tokens.is_some() {
                control.set_tokens(tokens);
            }
        };
        match Engine::start_with(
            config,
            move || AndroidTextEngine {
                density: density.clone(),
            },
            sink,
            setup,
        ) {
            Ok(engine) => {
                // The app's downloaded images go through its disk cache.
                *self.image_cache.lock().expect("image cache") = engine.image_cache();
                // The test moves its clock through the engine.
                #[cfg(feature = "dev")]
                if let Some(model) = &*self.test_model.lock().unwrap_or_else(|e| e.into_inner()) {
                    model.engine_started(engine.control());
                }
                *self.answers.lock().expect("answers") = Some(engine.control());
                *self.engine.lock().expect("engine") = Some(engine);
            }
            Err(err) => log::error!("failed to start the engine: {err}"),
        }
    }

    /// Applies a development update to the running app; false when no app
    /// runs yet.
    #[cfg(feature = "dev")]
    pub(crate) fn hot_update(&self, update: nsh_engine::HotUpdate) -> bool {
        match self.control() {
            Some(control) => {
                control.hot_update(update);
                true
            }
            None => false,
        }
    }

    /// Tells Java the running app stopped for another one.
    fn app_stopped(&self) {
        with_env(|env| {
            // SAFETY: matches the signature checked in `java::init`.
            unsafe {
                env.call_method_unchecked(
                    self.view.as_obj(),
                    java().view_app_stopped,
                    ReturnType::Primitive(Primitive::Void),
                    &[],
                )
            }
            .map(|_| ())
        });
    }

    pub(crate) fn report_error(&self, message: &str) {
        with_env(|env| {
            let message = env.new_string(message)?;
            // SAFETY: matches the signature checked in `java::init`.
            unsafe {
                env.call_method_unchecked(
                    self.view.as_obj(),
                    java().view_report_error,
                    ReturnType::Primitive(Primitive::Void),
                    &[JValue::Object(&message).as_jni()],
                )
            }
            .map(|_| ())
        });
    }

    #[cfg(feature = "dev")]
    pub(crate) fn dev_status(&self, status: Option<&str>) {
        with_env(|env| {
            let status = match status {
                Some(s) => JObject::from(env.new_string(s)?),
                None => JObject::null(),
            };
            // SAFETY: matches the signature checked in `java::init`.
            unsafe {
                env.call_method_unchecked(
                    self.view.as_obj(),
                    java().view_dev_status,
                    ReturnType::Primitive(Primitive::Void),
                    &[JValue::Object(&status).as_jni()],
                )
            }
            .map(|_| ())
        });
    }

    /// Shows (or with `None`, hides) the development error screen; `prose`
    /// wraps the message, otherwise its lines are kept (code frames, stack
    /// traces) and it scrolls sideways.
    #[cfg(feature = "dev")]
    pub(crate) fn dev_error(&self, error: Option<(&str, &str)>, prose: bool) {
        with_env(|env| {
            let (title, message) = match error {
                Some((t, m)) => (
                    JObject::from(env.new_string(t)?),
                    JObject::from(env.new_string(m)?),
                ),
                None => (JObject::null(), JObject::null()),
            };
            // SAFETY: matches the signature checked in `java::init`.
            unsafe {
                env.call_method_unchecked(
                    self.view.as_obj(),
                    java().view_dev_error,
                    ReturnType::Primitive(Primitive::Void),
                    &[
                        JValue::Object(&title).as_jni(),
                        JValue::Object(&message).as_jni(),
                        JValue::Bool(prose.into()).as_jni(),
                    ],
                )
            }
            .map(|_| ())
        });
    }
}

/// Answers the clipboard's image and file reads, which Android's
/// clipboard holds as content URIs NSH does not read yet: no image, no
/// files.
fn answer_clipboard_reads(host: &Host, batch: &MountBatch) {
    use nsh_core::{Command, platform::clipboard};
    let reads = batch.items.iter().filter_map(|item| match item {
        MountItem::Command {
            command: Command::ReadClipboardImage { id, .. },
            ..
        } => Some(clipboard::image_answer(*id, false, None)),
        MountItem::Command {
            command: Command::ReadClipboardFiles { id },
            ..
        } => Some(clipboard::files_answer(*id, &[])),
        _ => None,
    });
    let mut reads = reads.peekable();
    if reads.peek().is_none() {
        return;
    }
    let Some(control) = host.answers.lock().ok().and_then(|c| c.clone()) else {
        return;
    };
    for payload in reads {
        control.dispatch_event(nsh_core::ROOT_ID, EventKind::Clipboard, payload);
    }
}

/// Makes the bytes of the in-memory images `batch` shows (`data:` URIs,
/// blobs) reachable by their URI for `Images.java`, and forgets those no
/// view's source holds any more.
fn register_inline_images(host: &Host, batch: &MountBatch) {
    let mut images = None;
    for item in &batch.items {
        let MountItem::Image {
            source, options, ..
        } = item
        else {
            continue;
        };
        for source in source.iter().chain(&options.placeholder) {
            if source.data.is_some() {
                images
                    .get_or_insert_with(|| host.inline_images.lock().expect("inline images"))
                    .register(source);
            }
        }
    }
    if let Some(mut images) = images {
        images.prune();
    }
}

/// Hands commits to the UI thread: one `NshView.submit(bytes, objects, seq)`
/// call per batch.
struct Sink(Arc<Host>, Arc<OnceLock<EngineControl>>);

impl MountSink for Sink {
    fn submit(&self, batch: MountBatch) {
        let host = &self.0;
        #[cfg(feature = "dev")]
        if let Some(model) = &*host.test_model.lock().unwrap_or_else(|e| e.into_inner()) {
            model.apply(&batch);
        }
        answer_clipboard_reads(host, &batch);
        register_inline_images(host, &batch);
        let retirements: Vec<_> = batch
            .items
            .iter()
            .filter_map(|item| match item {
                MountItem::RetireListCell { id, request, .. } => Some((*id, *request)),
                _ => None,
            })
            .collect();
        let mut encoded = encode::encode(batch);
        if let Some(keymap) = encoded.keymap.take() {
            host.keymap
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .set(keymap);
        }
        let seq = host.seq.fetch_add(1, Ordering::Relaxed) + 1;
        if !retirements.is_empty() {
            let control = self.1.get().expect("engine control before its first batch");
            let mut pending = host.retirements.lock().expect("retirements");
            for (id, request) in retirements {
                pending.insert((seq, id, request), control.clone());
            }
        }
        if !encoded.animation.is_empty() {
            host.animation_queue
                .lock()
                .expect("queue")
                .push_back((seq, encoded.animation));
        }
        with_env(|env| {
            let bytes = env.byte_array_from_slice(&encoded.bytes)?;
            let objects = env.new_object_array(
                encoded.objects.len() as i32,
                "java/lang/Object",
                JObject::null(),
            )?;
            for (i, obj) in encoded.objects.iter().enumerate() {
                match obj {
                    Obj::Str(s) => {
                        let s = env.new_string(s)?;
                        env.set_object_array_element(&objects, i as i32, s)?;
                    }
                    Obj::Layout(layout) => {
                        env.set_object_array_element(&objects, i as i32, layout.as_obj())?;
                    }
                }
            }
            // SAFETY: matches the signature checked in `java::init`.
            unsafe {
                env.call_method_unchecked(
                    host.view.as_obj(),
                    java().view_submit,
                    ReturnType::Primitive(Primitive::Void),
                    &[
                        JValue::Object(&bytes).as_jni(),
                        JValue::Object(&objects).as_jni(),
                        JValue::Long(seq as i64).as_jni(),
                    ],
                )
            }
            .map(|_| ())
        });
    }

    fn request_frame(&self) {
        let view = &self.0.view;
        with_env(|env| {
            // SAFETY: matches the signature checked in `java::init`.
            unsafe {
                env.call_method_unchecked(
                    view.as_obj(),
                    java().view_request_frame,
                    ReturnType::Primitive(Primitive::Void),
                    &[],
                )
            }
            .map(|_| ())
        });
    }

    #[cfg(feature = "dev")]
    fn hot_update_failed(&self) {
        if let Some(dev) = self.0.dev.lock().ok().as_ref().and_then(|d| d.as_ref()) {
            dev.reload(&self.0);
        }
    }

    fn report_error(&self, message: &str) {
        #[cfg(feature = "dev")]
        if let Some(model) = &*self.0.test_model.lock().unwrap_or_else(|e| e.into_inner()) {
            model.error(message);
        }
        #[cfg(feature = "dev")]
        if let Some(dev) = self.0.dev.lock().ok().as_ref().and_then(|d| d.as_ref()) {
            dev.show_error(&self.0, "Uncaught error", message);
        }
        self.0.report_error(message);
    }
}

/// `asset:/…` files through `NshView.readAsset` (APK assets, or the dev
/// server).
struct ViewAssets(Arc<Host>);

impl Assets for ViewAssets {
    fn read(&self, uri: &str) -> Result<Vec<u8>, String> {
        let bytes: Option<Vec<u8>> = with_env(|env| {
            let uri = env.new_string(uri)?;
            // SAFETY: matches the signature checked in `java::init`.
            let array = unsafe {
                env.call_method_unchecked(
                    self.0.view.as_obj(),
                    java().view_read_asset,
                    ReturnType::Array,
                    &[JValue::Object(&uri).as_jni()],
                )
            }?
            .l()?;
            if array.is_null() {
                return Ok(None);
            }
            env.convert_byte_array(JByteArray::from(array)).map(Some)
        });
        bytes.ok_or_else(|| format!("cannot read {uri}"))
    }
}

// --- JNI exports (`com.longbridge.nsh.Native`) ------------------------------------------

/// # Safety
///
/// `handle` must be a live handle returned by `nativeCreate`.
pub(crate) unsafe fn host<'a>(handle: jlong) -> &'a Arc<Host> {
    // SAFETY: guaranteed by the caller.
    unsafe { &*(handle as *const Arc<Host>) }
}

#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_create(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    view: JObject<'_>,
    density: jfloat,
    trace: jboolean,
    data_dir: JString<'_>,
    cache_dir: JString<'_>,
) -> jlong {
    let Ok(view) = env.new_global_ref(view) else {
        return 0;
    };
    let data_dir = env
        .get_string(&data_dir)
        .ok()
        .map(|dir| std::path::PathBuf::from(String::from(dir)));
    let cache_dir = (!cache_dir.is_null())
        .then(|| env.get_string(&cache_dir).ok())
        .flatten()
        .map(|dir| std::path::PathBuf::from(String::from(dir)));
    let host = Arc::new(Host {
        view,
        density: Density::new(density),
        trace: trace != 0,
        engine: Mutex::new(None),
        answers: Mutex::new(None),
        pending: Mutex::new(None),
        viewport: Mutex::new(Size::new(px(0.0), px(0.0))),
        environment: Mutex::new(Environment::default()),
        animation_queue: Mutex::new(VecDeque::new()),
        retirements: Mutex::new(BTreeMap::new()),
        seq: AtomicU64::new(0),
        ui: Mutex::new(UiAnimation::default()),
        epoch: Instant::now(),
        granted: Mutex::new(None),
        limits: Mutex::new(nsh_engine::Limits::default()),
        data_dir,
        storage: Mutex::new(None),
        access: Mutex::new(Arc::default()),
        host_tokens: Mutex::new(None),
        inline_images: Mutex::default(),
        cache: Mutex::default(),
        system_cache_dir: cache_dir,
        image_cache: Mutex::new(None),
        host: nsh_engine::HostChannel::new(),
        keymap: Mutex::default(),
        #[cfg(feature = "dev")]
        dev: Mutex::new(None),
        #[cfg(feature = "dev")]
        test_model: Mutex::new(None),
    });
    Box::into_raw(Box::new(host)) as jlong
}

/// What the embedding app grants the apps it loads at most (JSON in the
/// form of `nsh.json` `capabilities`; null: no ceiling). Returns false for
/// an invalid grant (which is then ignored). Applies from the next load.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_setGranted(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    json: JString<'_>,
) -> jboolean {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    let granted = if json.is_null() {
        None
    } else {
        let Ok(json) = env.get_string(&json) else {
            return 0;
        };
        match nsh_engine::parse_capabilities(&String::from(json)) {
            Ok(caps) => Some(caps),
            Err(err) => {
                log::error!("invalid grant: {err}");
                return 0;
            }
        }
    };
    *host.granted.lock().expect("granted") = granted;
    1
}

/// The VM limits of the apps loaded next: heap (MB), stack (KB), the
/// budgets (ms) of loading and of every other call into JS, and the node
/// quota; 0 keeps a default.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_setLimits(
    _: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    memory_mb: jint,
    stack_kb: jint,
    load_ms: jint,
    call_ms: jint,
    max_nodes: jint,
) {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    let set = |v: jint| (v > 0).then_some(v as usize);
    let ms = |v: jint| set(v).map(|ms| std::time::Duration::from_millis(ms as u64));
    let limits = nsh_engine::HostLimits {
        memory_bytes: set(memory_mb).map(|mb| mb << 20),
        stack_bytes: set(stack_kb).map(|kb| kb << 10),
        load_budget: ms(load_ms),
        call_budget: ms(call_ms),
        max_nodes: set(max_nodes),
    };
    host.set_limits(limits.limits());
}

/// The apps loaded next run on their own, without limits (the standalone
/// app's activities: `NshView.useStandaloneLimits`).
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_setStandaloneLimits(
    _: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
) {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    host.set_limits(nsh_engine::Limits::standalone());
}

/// The directory the storage of the apps loaded next is kept in (null: each
/// app's own in the data directory).
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_setStorage(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    dir: JString<'_>,
) {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    let dir = if dir.is_null() {
        None
    } else {
        match env.get_string(&dir) {
            Ok(dir) => Some(std::path::PathBuf::from(String::from(dir))),
            Err(err) => return log::error!("invalid storage directory: {err}"),
        }
    };
    *host.storage.lock().expect("storage") = dir;
}

/// Where the apps loaded next keep their caches and how much each keeps
/// (`NshView.setCacheOptions`): `location` 0 the system's (`nsh` in the
/// Context's cache directory), 1 `dir`, 2 none; `images` 0 its default
/// size, 1 `images_max_mb` megabytes, 2 none.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_setCache(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    location: jint,
    dir: JString<'_>,
    images: jint,
    images_max_mb: jint,
) {
    use nsh_engine::{ByteSize, CacheLocation, CacheOptions, CachePolicy};
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    let location = match location {
        0 => CacheLocation::System,
        1 => match (!dir.is_null()).then(|| env.get_string(&dir)) {
            Some(Ok(dir)) => CacheLocation::Dir(String::from(dir).into()),
            _ => return log::error!("invalid cache directory"),
        },
        _ => CacheLocation::Off,
    };
    let images = match images {
        0 => CachePolicy::Default,
        1 => CachePolicy::MaxSize(ByteSize::mib(images_max_mb.max(0) as u64)),
        _ => CachePolicy::Off,
    };
    *host.cache.lock().expect("cache options") = CacheOptions::at(location).with_images(images);
}

/// What the running app's disk cache holds for `url`: its bytes (`byte[]`)
/// when they are fresh, the conditional request headers to revalidate a
/// stale copy with (`String[]`, names and values; empty: none), or null (a
/// miss, or no disk cache). Called on the image threads.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_imageCacheLookup<'local>(
    mut env: JNIEnv<'local>,
    _: JClass<'local>,
    handle: jlong,
    url: JString<'local>,
) -> JObject<'local> {
    use nsh_core::image::Lookup;
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    let Some(cache) = host.image_cache.lock().expect("image cache").clone() else {
        return JObject::null();
    };
    let Ok(url) = env.get_string(&url).map(String::from) else {
        return JObject::null();
    };
    match cache.lookup(&url) {
        Lookup::Fresh(bytes) => env
            .byte_array_from_slice(&bytes)
            .map(JObject::from)
            .unwrap_or_else(|_| JObject::null()),
        lookup @ Lookup::Stale(_) => {
            let headers = lookup.request_headers();
            let strings: Vec<&str> = headers
                .iter()
                .flat_map(|(name, value)| [*name, value.as_str()])
                .collect();
            string_array(&mut env, &strings).unwrap_or_else(|| JObject::null())
        }
        Lookup::Miss => JObject::null(),
    }
}

/// `strings` as a Java `String[]`.
fn string_array<'local>(env: &mut JNIEnv<'local>, strings: &[&str]) -> Option<JObject<'local>> {
    let array = env
        .new_object_array(strings.len() as i32, "java/lang/String", JObject::null())
        .ok()?;
    for (i, s) in strings.iter().enumerate() {
        let s = env.new_string(s).ok()?;
        env.set_object_array_element(&array, i as i32, &s).ok()?;
    }
    Some(array.into())
}

/// Ends the download of `url` that `imageCacheLookup` started: `status` 0
/// when the request failed, else the response's status, `headers` (names
/// and values) and body (null without one). Stores, updates or drops the
/// cached copy, and returns the cached bytes when they are what to show
/// (a `304`; a stale copy when the request failed or the server erred), or
/// null: the response's own body (a `2xx`), or an error. Called on the
/// image threads.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_imageCacheComplete<'local>(
    mut env: JNIEnv<'local>,
    _: JClass<'local>,
    handle: jlong,
    url: JString<'local>,
    status: jint,
    headers: JObjectArray<'local>,
    body: JByteArray<'local>,
) -> JByteArray<'local> {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    let Some(cache) = host.image_cache.lock().expect("image cache").clone() else {
        return JByteArray::default();
    };
    let Ok(url) = env.get_string(&url).map(String::from) else {
        return JByteArray::default();
    };
    let response = if status <= 0 {
        Err("the request failed".to_owned())
    } else {
        let mut strings = Vec::new();
        if !headers.is_null() {
            let len = env.get_array_length(&headers).unwrap_or(0);
            for i in 0..len {
                let value = env
                    .get_object_array_element(&headers, i)
                    .ok()
                    .filter(|o| !o.is_null())
                    .and_then(|o| env.get_string(&JString::from(o)).ok().map(String::from));
                strings.push(value.unwrap_or_default());
            }
        }
        let pairs = strings
            .chunks_exact(2)
            .map(|pair| (pair[0].as_str(), pair[1].as_str()));
        let body = if body.is_null() {
            Vec::new()
        } else {
            env.convert_byte_array(&body).unwrap_or_default()
        };
        Ok(nsh_core::image::Fetched::new(
            status as u16,
            nsh_core::image::CacheHeaders::from_pairs(pairs),
            body,
        ))
    };
    // A 2xx's bytes are the body Java has.
    let own = (200..300).contains(&status);
    match cache.complete(&url, response) {
        Ok(bytes) if !own => env
            .byte_array_from_slice(&bytes)
            .unwrap_or_else(|_| JByteArray::default()),
        _ => JByteArray::default(),
    }
}

/// The embedding app's theme overrides: a theme file of shadcn/ui's
/// (`cssVars`, as `nsh.json`'s `"theme"`), whose tokens win over the app's
/// of the same names (null: the app's own theme again). Applies at once and
/// to every app loaded later. Returns why the file does not parse (nothing
/// changes), or null.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_setThemeOverrides<'local>(
    mut env: JNIEnv<'local>,
    _: JClass<'local>,
    handle: jlong,
    json: JString<'local>,
) -> JString<'local> {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    let tokens = if json.is_null() {
        Ok(None)
    } else {
        match env.get_string(&json) {
            Ok(json) => nsh_base::theme_overrides(&String::from(json))
                .map(Some)
                .map_err(|err| format!("invalid theme: {err}")),
            Err(err) => Err(format!("invalid theme: {err}")),
        }
    };
    match tokens {
        Ok(tokens) => {
            host.set_host_tokens(tokens);
            JString::from(JObject::null())
        }
        Err(err) => env
            .new_string(err)
            .unwrap_or_else(|_| JString::from(JObject::null())),
    }
}

/// Whether the running app's web views may navigate to `url`.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_allowsWebview(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    url: JString<'_>,
) -> jboolean {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    let Ok(url) = env.get_string(&url) else {
        return 0;
    };
    let access = host.access.lock().expect("access").clone();
    access.allows_webview(&String::from(url)).into()
}

/// The URL a media load redirected from `base` to `location` goes on to, or
/// null if the running app may not load it.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_mediaRedirect<'local>(
    mut env: JNIEnv<'local>,
    _: JClass<'local>,
    handle: jlong,
    base: JString<'local>,
    location: JString<'local>,
) -> JString<'local> {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    let (Ok(base), Ok(location)) = (env.get_string(&base), env.get_string(&location)) else {
        return JString::from(JObject::null());
    };
    let access = host.access.lock().expect("access").clone();
    match access.media_redirect(&String::from(base), &String::from(location)) {
        Ok(url) => env
            .new_string(url)
            .unwrap_or_else(|_| JString::from(JObject::null())),
        Err(_) => JString::from(JObject::null()),
    }
}

/// The bytes of the in-memory image `uri` (a source's `data:` URI or blob,
/// while a view shows it; an `Image.getSize` `data:` URI, decoded), or
/// null. Called on the image threads.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_imageBytes<'local>(
    mut env: JNIEnv<'local>,
    _: JClass<'local>,
    handle: jlong,
    uri: JString<'local>,
) -> JByteArray<'local> {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    let Ok(uri) = env.get_string(&uri) else {
        return JByteArray::default();
    };
    let uri = String::from(uri);
    let held = host.inline_images.lock().expect("inline images").get(&uri);
    let bytes = match &held {
        Some(data) => Ok(data.bytes().to_vec()),
        None => nsh_core::image::decode_data_uri(&uri).map(|(_, bytes)| bytes),
    };
    match bytes {
        Ok(bytes) => env
            .byte_array_from_slice(&bytes)
            .unwrap_or_else(|_| JByteArray::default()),
        Err(_) => JByteArray::default(),
    }
}

#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_destroy(
    _: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
) {
    if handle == 0 {
        return;
    }
    // SAFETY: the handle came from `create` and Java drops it exactly once.
    let host = unsafe { Box::from_raw(handle as *mut Arc<Host>) };
    #[cfg(feature = "dev")]
    drop(host.dev.lock().expect("dev").take());
    *host.answers.lock().expect("answers") = None;
    drop(host.engine.lock().expect("engine").take());
}

#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_load(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    code: JByteArray<'_>,
    bytecode: jboolean,
    source_map: JString<'_>,
    capabilities: JString<'_>,
    app: JString<'_>,
) {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    let Ok(code) = env.convert_byte_array(code) else {
        return;
    };
    let mut bundle = if bytecode != 0 {
        // SAFETY: Java passes bytecode only from the APK's own (signed)
        // assets (`NshView.loadAssetBundle`).
        unsafe { Bundle::bytecode(code) }
    } else {
        Bundle::source(String::from_utf8_lossy(&code).into_owned())
    };
    if !source_map.is_null()
        && let Ok(map) = env.get_string(&source_map)
    {
        bundle = bundle.with_source_map(String::from(map));
    }
    let declared = if capabilities.is_null() {
        None
    } else {
        env.get_string(&capabilities).ok().map(String::from)
    };
    // `app.json` next to the bundle (`nsh package`): the app's id.
    if !app.is_null()
        && let Ok(app) = env.get_string(&app)
    {
        let app = serde_json::from_str::<serde_json::Value>(&String::from(app)).ok();
        let id = app.as_ref().and_then(|app| app.get("id")?.as_str());
        bundle = bundle.with_app_id(id);
    }
    match bundle.with_capabilities_json(declared.as_deref()) {
        Ok(bundle) => host.load(bundle),
        Err(err) => log::error!("cannot load the bundle: {err}"),
    }
}

/// Runs a Rust app's root in the `NshView` with native handle `handle`
/// (its `Native.runRust`, which [`crate::main`] defines in the app's
/// library).
pub fn run_root(handle: jlong, root: Root) {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    host.load(root);
}

#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_connectDevServer(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    url: JString<'_>,
) -> jboolean {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    let Ok(url) = env.get_string(&url) else {
        return 0;
    };
    #[cfg(feature = "dev")]
    {
        let session = crate::dev::DevSession::start(host.clone(), String::from(url));
        *host.dev.lock().expect("dev") = session;
        1
    }
    #[cfg(not(feature = "dev"))]
    {
        let _ = (host, url);
        log::error!("this build of nsh has no development support");
        0
    }
}

#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_resize(
    _: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    width: jfloat,
    height: jfloat,
) {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    let size = Size::new(Points(width), Points(height));
    *host.viewport.lock().expect("viewport") = size;
    host.environment.lock().expect("environment").window = size;
    if let Some(control) = host.control() {
        control.resize(size);
        control.set_environment(*host.environment.lock().expect("environment"));
    } else if let Some(bundle) = host.pending.lock().expect("pending").take() {
        host.load(bundle);
    }
}

/// `values`: safe area top, right, bottom, left, keyboard height, keyboard
/// animation duration, font scale, right to left (1), reduce motion (1),
/// density, screen reader (1), API level, idiom (0 phone, 1 pad, 3 TV).
/// `locale`: `Locale.getDefault()`'s language tag.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_environment(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    values: JFloatArray<'_>,
    dark: jboolean,
    locale: JString<'_>,
) {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    let mut v = [0f32; 13];
    if env.get_float_array_region(&values, 0, &mut v).is_err() {
        return;
    }
    let mut environment = host.environment.lock().expect("environment");
    environment.safe_area = Edges {
        top: Points(v[0]),
        right: Points(v[1]),
        bottom: Points(v[2]),
        left: Points(v[3]),
    };
    environment.keyboard_height = Points(v[4]);
    environment.keyboard_duration = v[5];
    environment.font_scale = v[6];
    environment.rtl = v[7] != 0.0;
    environment.reduce_motion = v[8] != 0.0;
    environment.pixel_ratio = v[9];
    environment.screen_reader = v[10] != 0.0;
    environment.os = nsh_engine::Os::Android;
    environment.os_version = (v[11] as u16, 0);
    environment.idiom = match v[12] as u8 {
        1 => Idiom::Pad,
        3 => Idiom::Tv,
        _ => Idiom::Phone,
    };
    if let Ok(tag) = env.get_string(&locale) {
        environment.locale = Locale::parse(&String::from(tag)).unwrap_or_default();
    }
    environment.color_scheme = if dark != 0 {
        ColorScheme::Dark
    } else {
        ColorScheme::Light
    };
    let environment = *environment;
    // `wm density` or a display change: `NshView` resized the viewport in
    // dp, and every value it converted to pixels is sent again.
    let remount = host.density.set(environment.pixel_ratio);
    if let Some(control) = host.control() {
        control.set_environment(environment);
        if remount {
            control.remount();
        }
    }
}

/// A native event. The payload depends on `kind` (`EventKind` order):
/// scroll ends carry `(x, y)`, image loads `(width, height)`, errors
/// `text`, text inputs `(text, count)`.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_event(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    id: jint,
    kind: jint,
    text: JString<'_>,
    count: jint,
    x: jfloat,
    y: jfloat,
) {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    let Some(kind) = encode::kind_from(kind) else {
        return;
    };
    let mut read_text = || -> String {
        if text.is_null() {
            return String::new();
        }
        env.get_string(&text).map(String::from).unwrap_or_default()
    };
    let payload = match kind {
        EventKind::ScrollEnd
        | EventKind::ScrollDragStart
        | EventKind::ScrollDragEnd
        | EventKind::MomentumStart
        | EventKind::MomentumEnd => EventPayload::Scroll(point(px(x), px(y))),
        // The bitmap's width and height: whole pixels.
        EventKind::Load => {
            EventPayload::Image(size(DevicePixels(x as i32), DevicePixels(y as i32)))
        }
        EventKind::Error => EventPayload::Error {
            message: read_text(),
        },
        EventKind::ChangeText | EventKind::SubmitEditing => EventPayload::Text {
            text: read_text(),
            count: count as u32,
        },
        EventKind::AccessibilityAction => {
            EventPayload::Map(vec![("actionName", PayloadValue::Str(read_text()))])
        }
        // Insets: x / y carry top / bottom, `count` packs left and right.
        EventKind::Insets => EventPayload::Map(vec![
            ("top", PayloadValue::Number(x as f64)),
            ("right", PayloadValue::Number((count & 0xffff) as f64)),
            ("bottom", PayloadValue::Number(y as f64)),
            ("left", PayloadValue::Number((count >> 16) as f64)),
        ]),
        _ => EventPayload::None,
    };
    if let Some(control) = host.control() {
        control.dispatch_event(id as NodeId, kind, payload);
    }
}

/// A mouse event of view `id` (see `Native.mouse`): `onMouseEnter`,
/// `onMouseMove` or `onMouseLeave`.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
extern "system" fn Java_com_longbridge_nsh_Native_mouse(
    _: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    id: jint,
    kind: jint,
    x: jfloat,
    y: jfloat,
    page_x: jfloat,
    page_y: jfloat,
    modifiers: jint,
) {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    let Some(kind) = encode::kind_from(kind).filter(|k| {
        matches!(
            k,
            EventKind::MouseEnter | EventKind::MouseMove | EventKind::MouseLeave
        )
    }) else {
        return;
    };
    let modifiers = nsh_core::keymap::Modifiers {
        ctrl: modifiers & 1 != 0,
        alt: modifiers & 2 != 0,
        shift: modifiers & 4 != 0,
        cmd: modifiers & 8 != 0,
    };
    // Android's hover events only come with no button down.
    let event = nsh_core::MouseEvent::new(
        point(px(x), px(y)),
        point(px(page_x), px(page_y)),
        modifiers,
        None,
    );
    if let Some(control) = host.control() {
        control.dispatch_event(id as NodeId, kind, EventPayload::Mouse(event));
    }
}

/// A press event of node `id` (see `Native.press`).
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
extern "system" fn Java_com_longbridge_nsh_Native_press(
    _: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    id: jint,
    kind: jint,
    x: jfloat,
    y: jfloat,
    page_x: jfloat,
    page_y: jfloat,
    modifiers: jint,
    clicks: jint,
) {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    let Some(kind) = encode::kind_from(kind) else {
        return;
    };
    let event = nsh_core::PressEvent {
        position: point(px(x), px(y)),
        page_position: point(px(page_x), px(page_y)),
        modifiers: nsh_core::keymap::Modifiers {
            ctrl: modifiers & 1 != 0,
            alt: modifiers & 2 != 0,
            shift: modifiers & 4 != 0,
            cmd: modifiers & 8 != 0,
        },
        clicks: clicks.max(1) as u32,
    };
    if let Some(control) = host.control() {
        control.dispatch_event(id as NodeId, kind, EventPayload::Press(event));
    }
}

/// Touches for the JS responder system (see `Native.touch`).
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
extern "system" fn Java_com_longbridge_nsh_Native_touch(
    env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    phase: jint,
    ids: jni::objects::JIntArray<'_>,
    targets: jni::objects::JIntArray<'_>,
    path_lengths: jni::objects::JIntArray<'_>,
    paths: jni::objects::JIntArray<'_>,
    coords: JFloatArray<'_>,
    changed: jni::objects::JBooleanArray<'_>,
    time: jlong,
    activated: jint,
) {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    let ints = |a: &jni::objects::JIntArray<'_>| -> Vec<i32> {
        let n = env.get_array_length(a).unwrap_or(0) as usize;
        let mut v = vec![0; n];
        if env.get_int_array_region(a, 0, &mut v).is_err() {
            v.clear();
        }
        v
    };
    let (ids, targets, path_lengths, paths) = (
        ints(&ids),
        ints(&targets),
        ints(&path_lengths),
        ints(&paths),
    );
    let n = ids.len();
    let mut c = vec![0.0; n * 4];
    let mut flags = vec![0u8; n];
    if targets.len() != n
        || path_lengths.len() != n
        || env.get_float_array_region(&coords, 0, &mut c).is_err()
        || env
            .get_boolean_array_region(&changed, 0, &mut flags)
            .is_err()
    {
        return;
    }
    let mut at = 0;
    let points = (0..n)
        .map(|i| {
            let len = path_lengths[i].max(0) as usize;
            let path = paths
                .get(at..at + len)
                .map(|p| p.iter().map(|&id| id as NodeId).collect())
                .unwrap_or_default();
            at += len;
            nsh_core::TouchPoint {
                id: ids[i] as u32,
                target: targets[i] as NodeId,
                path,
                page: point(px(c[i * 4]), px(c[i * 4 + 1])),
                location: point(px(c[i * 4 + 2]), px(c[i * 4 + 3])),
                changed: flags[i] != 0,
            }
        })
        .collect();
    let phase = match phase {
        0 => nsh_core::TouchPhase::Start,
        1 => nsh_core::TouchPhase::Move,
        2 => nsh_core::TouchPhase::End,
        _ => nsh_core::TouchPhase::Cancel,
    };
    if let Some(control) = host.control() {
        control.dispatch_event(
            nsh_core::ROOT_ID,
            EventKind::Touch,
            EventPayload::Touch(Box::new(nsh_core::TouchEvent {
                phase,
                timestamp: time as f64,
                points,
                activated: (activated >= 0).then_some(activated as NodeId),
            })),
        );
    }
}

/// `onPaste`: the text, the images' encoded bytes (each a `File` in JS, the
/// bytes never through JS strings) and local files' `file:` URLs.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_paste(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    id: jint,
    text: JString<'_>,
    images: jni::objects::JObjectArray<'_>,
    uris: jni::objects::JObjectArray<'_>,
) {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    let mut paste =
        nsh_core::PasteEvent::new(env.get_string(&text).map(String::from).unwrap_or_default());
    for i in 0..env.get_array_length(&images).unwrap_or(0) {
        let Ok(image) = env.get_object_array_element(&images, i) else {
            continue;
        };
        let image = jni::objects::JByteArray::from(image);
        if let Ok(bytes) = env.convert_byte_array(&image) {
            paste.files.push(nsh_core::PastedFile::image(bytes));
        }
    }
    for i in 0..env.get_array_length(&uris).unwrap_or(0) {
        let Ok(uri) = env.get_object_array_element(&uris, i) else {
            continue;
        };
        if let Ok(uri) = env.get_string(&JString::from(uri)) {
            paste.uris.push(uri.into());
        }
    }
    if let Some(control) = host.control() {
        control.dispatch_event(
            id as NodeId,
            EventKind::Paste,
            EventPayload::Paste(Box::new(paste)),
        );
    }
}

/// Folds the caret Java reports as numbers (`caretX`, `caretY`,
/// `caretWidth`, `caretHeight`, in dp) into `onCaretMove`'s `bounds`.
fn caret_bounds(fields: &mut Vec<(&'static str, PayloadValue)>) {
    let mut caret = [0.0f32; 4];
    fields.retain(|(key, value)| {
        let slot = match *key {
            "caretX" => 0,
            "caretY" => 1,
            "caretWidth" => 2,
            "caretHeight" => 3,
            _ => return true,
        };
        if let PayloadValue::Number(n) = value {
            caret[slot] = *n as f32;
        }
        false
    });
    let [x, y, width, height] = caret;
    fields.push((
        "bounds",
        PayloadValue::Bounds(nsh_core::Bounds {
            origin: point(px(x), px(y)),
            size: size(px(width), px(height)),
        }),
    ));
}

/// An event with an object payload: `keys` and `values` (`Double`,
/// `Boolean` or `String`), or with a single `value` when `keys` is null.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_eventMap(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    id: jint,
    kind: jint,
    keys: jni::objects::JObjectArray<'_>,
    values: jni::objects::JObjectArray<'_>,
) {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    let Some(kind) = encode::kind_from(kind) else {
        return;
    };
    let read = |env: &mut JNIEnv<'_>, i: i32| -> Option<PayloadValue> {
        let v = env.get_object_array_element(&values, i).ok()?;
        if v.is_null() {
            return Some(PayloadValue::Null);
        }
        if env.is_instance_of(&v, "java/lang/String").ok()? {
            let s: String = env.get_string(&JString::from(v)).ok()?.into();
            return Some(PayloadValue::Str(s));
        }
        if env.is_instance_of(&v, "java/lang/Boolean").ok()? {
            let b = env
                .call_method(&v, "booleanValue", "()Z", &[])
                .ok()?
                .z()
                .ok()?;
            return Some(PayloadValue::Bool(b));
        }
        let n = env
            .call_method(&v, "doubleValue", "()D", &[])
            .ok()?
            .d()
            .ok()?;
        Some(PayloadValue::Number(n))
    };
    let payload = if keys.is_null() {
        match read(&mut env, 0) {
            Some(v) => EventPayload::Value(v),
            None => EventPayload::None,
        }
    } else {
        let len = env.get_array_length(&keys).unwrap_or(0);
        let mut fields = Vec::with_capacity(len as usize);
        for i in 0..len {
            let Ok(key) = env.get_object_array_element(&keys, i) else {
                continue;
            };
            let Ok(key) = env.get_string(&JString::from(key)).map(String::from) else {
                continue;
            };
            // Payload keys are static: intern the known ones.
            let key: &'static str = match key.as_str() {
                "url" => "url",
                "title" => "title",
                "loading" => "loading",
                "canGoBack" => "canGoBack",
                "canGoForward" => "canGoForward",
                "data" => "data",
                "message" => "message",
                "duration" => "duration",
                "width" => "width",
                "height" => "height",
                "currentTime" => "currentTime",
                "isBuffering" => "isBuffering",
                "id" => "id",
                "index" => "index",
                "start" => "start",
                "end" => "end",
                "key" => "key",
                "loaded" => "loaded",
                "total" => "total",
                "error" => "error",
                "text" => "text",
                "has" => "has",
                "opened" => "opened",
                "reason" => "reason",
                "intent" => "intent",
                "composing" => "composing",
                "caretX" => "caretX",
                "caretY" => "caretY",
                "caretWidth" => "caretWidth",
                "caretHeight" => "caretHeight",
                _ => continue,
            };
            if let Some(v) = read(&mut env, i) {
                fields.push((key, v));
            }
        }
        if kind == EventKind::CaretMove {
            caret_bounds(&mut fields);
        }
        EventPayload::Map(fields)
    };
    if let Some(control) = host.control() {
        control.dispatch_event(id as NodeId, kind, payload);
    }
}

fn native_focus_path(env: &JNIEnv<'_>, path: &jni::objects::JIntArray<'_>) -> Option<Vec<NodeId>> {
    let mut nodes = vec![0; env.get_array_length(path).ok()? as usize];
    env.get_int_array_region(path, 0, &mut nodes).ok()?;
    Some(nodes.into_iter().map(|id| id as NodeId).collect())
}

#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_focusPath(
    env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    path: jni::objects::JIntArray<'_>,
) {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    if let Some(path) = native_focus_path(&env, &path)
        && let Some(control) = host.control()
    {
        control.set_focus_path(path);
    }
}

#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
extern "system" fn Java_com_longbridge_nsh_Native_retireListCell(
    env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    seq: jlong,
    id: jint,
    request: jlong,
    retired: jboolean,
    path: jni::objects::JIntArray<'_>,
) {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    let Some(path) = native_focus_path(&env, &path) else {
        return;
    };
    let control = host.retirements.lock().expect("retirements").remove(&(
        seq as u64,
        id as NodeId,
        request as u64,
    ));
    if let Some(control) = control {
        control.set_focus_path(path);
        control.retire_list_cell(id as NodeId, request as u64, retired != 0);
    }
}

/// Applies the animation items of batches up to `seq` (already applied by
/// Java) and returns the bound values.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_afterBatch(
    env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    seq: jlong,
) -> jfloatArray {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    let mut items = Vec::new();
    {
        let mut queue = host.animation_queue.lock().expect("queue");
        while queue.front().is_some_and(|(s, _)| *s <= seq as u64) {
            items.extend(queue.pop_front().expect("front").1);
        }
    }
    let mut ui = host.ui.lock().expect("ui");
    for item in items {
        ui.apply(item);
    }
    finish(host, &mut ui);
    floats(&env, &ui.outputs())
}

/// A `Choreographer` frame (nanoseconds).
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_tick(
    env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    _frame_nanos: jlong,
) -> jfloatArray {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    let mut ui = host.ui.lock().expect("ui");
    let changed = ui.tick(host.epoch.elapsed().as_secs_f64());
    finish(host, &mut ui);
    // A frame only shader views asked for: no bound value moved.
    let mut out = if changed || ui.animating() {
        ui.outputs()
    } else {
        vec![0.0]
    };
    let shading = ui.shaders.render(host.view.as_obj());
    out[0] = if ui.animating() || shading { 1.0 } else { 0.0 };
    floats(&env, &out)
}

/// Shader view `id` (`Box.java`) is `width` × `height` pixels: its next
/// frame is rendered at that size. Whether frames should come
/// (`NshView.requestFrames`).
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_shaderSize(
    _: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    id: jint,
    width: jint,
    height: jint,
) -> jboolean {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    let mut ui = host.ui.lock().expect("ui");
    ui.shaders
        .resized(id as u32, width, height, host.density.get());
    ui.shaders.wants_frame().into()
}

/// A scroll view moved: the engine (lists) and its scroll value learn the
/// offset. Returns bound values when a scroll value changed, else null.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_scroll(
    env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    id: jint,
    x: jfloat,
    y: jfloat,
    applied: jint,
) -> jfloatArray {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    if let Some(control) = host.control() {
        control.scroll(id as NodeId, point(px(x), px(y)), applied as u32);
    }
    let mut ui = host.ui.lock().expect("ui");
    if !ui.scrolled(id as u32, x, y) {
        return std::ptr::null_mut();
    }
    finish(host, &mut ui);
    floats(&env, &ui.outputs())
}

/// A multiline input's text scrolled, or its text or size changed, while a
/// built-in bar replaces its indicator (`InputConfig::replaced`): the engine
/// learns the offset, the text's size and the viewport's (points).
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_inputScroll(
    _: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    id: jint,
    y: jfloat,
    content_width: jfloat,
    content_height: jfloat,
    width: jfloat,
    height: jfloat,
) {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    if let Some(control) = host.control() {
        control.input_scroll(
            id as NodeId,
            point(px(0.0), px(y)),
            size(px(content_width), px(content_height)),
            size(px(width), px(height)),
        );
    }
}

/// A vertical scroll view is pulled `distance` (points) past its top: its
/// pull value learns it. Returns bound values when one changed, else null.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_pull(
    env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    id: jint,
    distance: jfloat,
) -> jfloatArray {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    let mut ui = host.ui.lock().expect("ui");
    if !ui.pulled(id as u32, distance) {
        return std::ptr::null_mut();
    }
    finish(host, &mut ui);
    floats(&env, &ui.outputs())
}

/// A scroll view came to rest: the snapping values that follow its scroll
/// value settle. Returns bound values when one starts moving, else null.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_scrollEnded(
    env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    id: jint,
) -> jfloatArray {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    let mut ui = host.ui.lock().expect("ui");
    if !ui.scroll_ended(id as u32) {
        return std::ptr::null_mut();
    }
    finish(host, &mut ui);
    floats(&env, &ui.outputs())
}

/// A zoomable scroll view's zoom scale changed (before its offset report).
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_zoom(
    _: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    id: jint,
    scale: jfloat,
) {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    if let Some(control) = host.control() {
        control.zoom(id as NodeId, scale);
    }
}

/// Whether view `id` follows drags (it has `pan` values).
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_hasPan(
    _: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    id: jint,
) -> jboolean {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    host.ui.lock().expect("ui").has_pan(id as u32).into()
}

/// A drag on view `id`: `state` 0 began, 1 moved, 2 ended, 3 cancelled;
/// translation and velocity in points (per second).
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_pan(
    env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    id: jint,
    state: jint,
    tx: jfloat,
    ty: jfloat,
    vx: jfloat,
    vy: jfloat,
) -> jfloatArray {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    let control = host.control();
    let mut ui = host.ui.lock().expect("ui");
    if state == 0 {
        ui.pan_began(id as u32);
    }
    if state <= 1 {
        ui.pan_moved(id as u32, tx, ty);
    }
    let (value_x, value_y) = ui.pan_values(id as u32);
    let payload = if state == 3 {
        EventPayload::PanCancelled {
            translation: point(px(tx), px(ty)),
            velocity_x: vx,
            velocity_y: vy,
            value_x: value_x.map(Points),
            value_y: value_y.map(Points),
        }
    } else {
        EventPayload::Pan {
            translation: point(px(tx), px(ty)),
            velocity_x: vx,
            velocity_y: vy,
            value_x: value_x.map(Points),
            value_y: value_y.map(Points),
        }
    };
    match (state, &control) {
        (0, Some(c)) => c.dispatch_event(id as NodeId, EventKind::PanStart, payload),
        (1, _) | (_, None) => {}
        (_, Some(c)) => c.dispatch_event(id as NodeId, EventKind::PanEnd, payload),
    }
    finish(host, &mut ui);
    floats(&env, &ui.outputs())
}

/// A pinch (`rotation` false, `amount` the scale) or two-finger rotation
/// (`amount` in degrees) on view `id`: `state` 0 began, 1 moved, 2 ended,
/// 3 cancelled.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_transformGesture(
    env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    id: jint,
    rotation: jboolean,
    state: jint,
    amount: jfloat,
    velocity: jfloat,
) -> jfloatArray {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    let rotation = rotation != 0;
    let (start, end, key) = if rotation {
        (EventKind::RotationStart, EventKind::RotationEnd, "rotation")
    } else {
        (EventKind::PinchStart, EventKind::PinchEnd, "scale")
    };
    let payload = EventPayload::Map(vec![
        (key, PayloadValue::Number(amount as f64)),
        ("velocity", PayloadValue::Number(velocity as f64)),
    ]);
    let control = host.control();
    let mut ui = host.ui.lock().expect("ui");
    match state {
        0 => {
            ui.transform_began(id as u32, rotation);
            ui.transform_moved(id as u32, rotation, amount);
            if let Some(c) = &control {
                c.dispatch_event(id as NodeId, start, payload);
            }
        }
        1 => ui.transform_moved(id as u32, rotation, amount),
        _ => {
            if let Some(c) = &control {
                c.dispatch_event(id as NodeId, end, payload);
            }
        }
    }
    finish(host, &mut ui);
    floats(&env, &ui.outputs())
}

/// The platform shows root `id` (a modal) at `width` x `height` dp, with
/// insets covered by system UI.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_rootSize(
    _: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    id: jint,
    width: jfloat,
    height: jfloat,
    top: jfloat,
    right: jfloat,
    bottom: jfloat,
    left: jfloat,
) {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    if let Some(control) = host.control() {
        control.set_root_size(
            id as NodeId,
            Size::new(Points(width), Points(height)),
            nsh_core::EdgeInsets {
                top: px(top),
                right: px(right),
                bottom: px(bottom),
                left: px(left),
            },
        );
    }
}

/// Interaction states of a view the core tracks (`active:`, `hover:`, `focus:`).
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_states(
    _: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    id: jint,
    states: jint,
) {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    if let Some(control) = host.control() {
        control.set_states(id as u32, states as u16);
    }
}

/// A display frame began after `NshView.requestJsFrame`.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_frame(
    _: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
) {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    if let Some(control) = host.control() {
        control.frame();
    }
}

/// Reports finished animations to JS.
fn finish(host: &Host, ui: &mut UiAnimation) {
    if ui.finished.is_empty() {
        return;
    }
    if let Some(control) = host.control() {
        control.animations_finished(std::mem::take(&mut ui.finished));
    } else {
        ui.finished.clear();
    }
}

fn floats(env: &JNIEnv<'_>, values: &[f32]) -> jfloatArray {
    let Ok(array) = env.new_float_array(values.len() as i32) else {
        return std::ptr::null_mut();
    };
    if env.set_float_array_region(&array, 0, values).is_err() {
        return std::ptr::null_mut();
    }
    array.into_raw()
}

/// A registered native component emitted `name` (JSON data or `null`).
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_picked(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    id: jint,
    names: jni::objects::JObjectArray<'_>,
    types: jni::objects::JObjectArray<'_>,
    data: jni::objects::JObjectArray<'_>,
    sizes: jni::objects::JIntArray<'_>,
) {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    let count = env.get_array_length(&data).unwrap_or(0).max(0);
    let mut dims = vec![0; count as usize * 2];
    let _ = env.get_int_array_region(&sizes, 0, &mut dims);
    let string = |env: &mut JNIEnv<'_>, array: &jni::objects::JObjectArray<'_>, i: i32| {
        env.get_object_array_element(array, i)
            .ok()
            .filter(|v| !v.is_null())
            .and_then(|v| env.get_string(&JString::from(v)).ok().map(String::from))
            .unwrap_or_default()
    };
    let mut files = Vec::with_capacity(count as usize);
    for i in 0..count {
        let name = string(&mut env, &names, i);
        let mime = string(&mut env, &types, i);
        let Ok(bytes) = env.get_object_array_element(&data, i) else {
            continue;
        };
        let Ok(bytes) = env.convert_byte_array(JByteArray::from(bytes)) else {
            continue;
        };
        let mut file =
            nsh_core::picker::PickedFile::new(name, mime, nsh_core::ImageData::new(bytes));
        let (w, h) = (dims[i as usize * 2], dims[i as usize * 2 + 1]);
        if w > 0 && h > 0 {
            file.size = nsh_core::Size::new(
                nsh_core::geometry::DevicePixels(w),
                nsh_core::geometry::DevicePixels(h),
            );
        }
        files.push(file);
    }
    if let Some(control) = host.control() {
        control.dispatch_event(
            nsh_core::ROOT_ID,
            EventKind::Pick,
            EventPayload::Picked {
                id: id as u32,
                files,
            },
        );
    }
}

#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_componentEvent(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    id: jint,
    name: JString<'_>,
    json: JString<'_>,
) {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    let Ok(name) = env.get_string(&name).map(String::from) else {
        return;
    };
    let data = if json.is_null() {
        nsh_core::JsonValue::Null
    } else {
        match env.get_string(&json).map(String::from) {
            Ok(json) => serde_json::from_str(&json).unwrap_or_else(|err| {
                log::error!("component event data is not JSON: {err}");
                nsh_core::JsonValue::Null
            }),
            Err(_) => return,
        }
    };
    if let Some(control) = host.control() {
        control.dispatch_event(
            id as NodeId,
            EventKind::NativeEvent,
            EventPayload::Native {
                name: name.into(),
                data,
            },
        );
    }
}

/// A registered native component's own size (dp).
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_componentSize(
    _: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    id: jint,
    width: jfloat,
    height: jfloat,
) {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    if let Some(control) = host.control() {
        control.set_component_size(id as NodeId, Size::new(Points(width), Points(height)));
    }
}

/// A Java string argument, `None` for null.
fn optional_string(env: &mut JNIEnv<'_>, s: &JString<'_>) -> Option<String> {
    if s.is_null() {
        return None;
    }
    env.get_string(s).ok().map(String::from)
}

/// JSON text from Java (null: `null`), or why it is not JSON.
fn json_value(
    env: &mut JNIEnv<'_>,
    json: &JString<'_>,
    what: &str,
) -> Result<nsh_core::JsonValue, String> {
    match optional_string(env, json) {
        None => Ok(nsh_core::JsonValue::Null),
        Some(text) => {
            serde_json::from_str(&text).map_err(|err| format!("{what} is not JSON: {err}"))
        }
    }
}

/// The launch parameters of the apps loaded from now on (`host.params`):
/// a JSON object (null: none). False when it is not one.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_setHostParams(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    json: JString<'_>,
) -> jboolean {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    match json_value(&mut env, &json, "the parameters") {
        Ok(nsh_core::JsonValue::Null) => host.host.set_params(serde_json::Map::new()),
        Ok(nsh_core::JsonValue::Object(params)) => host.host.set_params(params),
        Ok(_) => {
            log::error!("the parameters are a JSON object");
            return 0;
        }
        Err(err) => {
            log::error!("{err}");
            return 0;
        }
    }
    1
}

/// Sends event `name` with `json` data (null: `null`) to the running app
/// (`host.on`). False when the name or the data is invalid.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_sendHostEvent(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    name: JString<'_>,
    json: JString<'_>,
) -> jboolean {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    let Some(name) = optional_string(&mut env, &name) else {
        return 0;
    };
    let sent =
        json_value(&mut env, &json, "the event data").and_then(|data| host.host.send(name, data));
    match sent {
        Ok(()) => 1,
        Err(err) => {
            log::error!("{err}");
            0
        }
    }
}

/// `NshView` handles the app's calls and posts of `name` (`handled`), or no
/// longer does: the channel hands them to `NshView.hostMessage` on the
/// engine thread, which runs the Java handler on the UI thread.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_setHostHandler(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    name: JString<'_>,
    handled: jboolean,
) {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    let Some(name) = optional_string(&mut env, &name) else {
        return;
    };
    if handled == 0 {
        return host.host.remove_handler(&name);
    }
    // The view's reference, not the host's: the channel the host owns keeps
    // the handler.
    let view = host.view.clone();
    host.host.handle(name.clone(), move |mut call| {
        let json = call.take_data().to_string();
        let call = if call.is_post() {
            0
        } else {
            Box::into_raw(Box::new(call)) as jlong
        };
        let delivered = with_env(|env| {
            let name = env.new_string(&name)?;
            let json = env.new_string(&json)?;
            // SAFETY: matches the signature checked in `java::init`.
            unsafe {
                env.call_method_unchecked(
                    view.as_obj(),
                    java().view_host_message,
                    ReturnType::Primitive(Primitive::Void),
                    &[
                        JValue::Object(&name).as_jni(),
                        JValue::Object(&json).as_jni(),
                        JValue::Long(call).as_jni(),
                    ],
                )
            }
            .map(|_| true)
        });
        if !delivered && call != 0 {
            // Java never got it: the call fails rather than waits.
            // SAFETY: made above and not handed over.
            drop(unsafe { Box::from_raw(call as *mut nsh_engine::HostCall) });
        }
    });
}

/// Answers a call `NshView.hostMessage` got (`json`, or `error` when it
/// failed) and frees it. Any thread.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_hostReply(
    mut env: JNIEnv<'_>,
    _: JClass<'_>,
    call: jlong,
    json: JString<'_>,
    error: JString<'_>,
) {
    if call == 0 {
        return;
    }
    // SAFETY: a call `setHostHandler`'s handler handed to Java, answered once.
    let call = unsafe { Box::from_raw(call as *mut nsh_engine::HostCall) };
    let result = match optional_string(&mut env, &error) {
        Some(message) => Err(message),
        None => json_value(&mut env, &json, "the answer"),
    };
    call.reply(result);
}

/// `NshView` takes the URLs the app opens first (`handled`), or no longer
/// does: the channel hands them to `NshView.openUrlMessage` on the engine
/// thread, which runs the Java handler on the UI thread and answers with
/// `openUrlReply`.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_setOpenUrlHandler(
    _: JNIEnv<'_>,
    _: JClass<'_>,
    handle: jlong,
    handled: jboolean,
) {
    // SAFETY: Java passes its live handle.
    let host = unsafe { host(handle) };
    if handled == 0 {
        return host.host.remove_open_url_handler();
    }
    // The view's reference, not the host's: the channel the host owns keeps
    // the handler.
    let view = host.view.clone();
    host.host.handle_open_url(move |request| {
        let url = request.url().to_owned();
        let request = Box::into_raw(Box::new(request)) as jlong;
        let delivered = with_env(|env| {
            let url = env.new_string(&url)?;
            // SAFETY: matches the signature checked in `java::init`.
            unsafe {
                env.call_method_unchecked(
                    view.as_obj(),
                    java().view_open_url_message,
                    ReturnType::Primitive(Primitive::Void),
                    &[
                        JValue::Object(&url).as_jni(),
                        JValue::Long(request).as_jni(),
                    ],
                )
            }
            .map(|_| true)
        });
        if !delivered {
            // Java never got it: the system opens the URL.
            // SAFETY: made above and not handed over.
            drop(unsafe { Box::from_raw(request as *mut nsh_engine::OpenUrlRequest) });
        }
    });
}

/// Answers a URL `NshView.openUrlMessage` got (`handled`: the embedding app
/// took it; else the system opens it) and frees it. Any thread.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_openUrlReply(
    _: JNIEnv<'_>,
    _: JClass<'_>,
    request: jlong,
    handled: jboolean,
) {
    if request == 0 {
        return;
    }
    // SAFETY: a request `setOpenUrlHandler`'s handler handed to Java,
    // answered once.
    let request = unsafe { Box::from_raw(request as *mut nsh_engine::OpenUrlRequest) };
    request.answer(handled != 0);
}

/// Frees a call unanswered: it fails in the app. Any thread.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_hostCallFree(
    _: JNIEnv<'_>,
    _: JClass<'_>,
    call: jlong,
) {
    if call != 0 {
        // SAFETY: as in `hostReply`.
        drop(unsafe { Box::from_raw(call as *mut nsh_engine::HostCall) });
    }
}
