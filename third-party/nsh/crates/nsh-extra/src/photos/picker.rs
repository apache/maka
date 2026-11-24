//! The system's photo picker embedded in the app's layout
//! ([`PhotosPicker`]): a strip of the library the user selects photos in,
//! without the app reading the library. The system shows it out of the
//! app's process and hands over only what the user selects, so the app
//! needs no access to the library ([`access`](super::access) may be
//! anything).
//!
//! The picker reports the whole selection each time the user selects or
//! deselects a photo ([`PhotosPickerEvent::Change`]), as opaque ids: the
//! photos' bytes never cross as events. The app reads a selected photo with
//! [`load_picked`], prepared as `Picker.pickImages` prepares a picked image.
//! An id stays readable while its photo is selected and its picker shown;
//! deselected, or with its picker gone, it reads as
//! [`NOT_FOUND`](super::NOT_FOUND). The app deselects a photo itself with
//! [`PhotosPickerApi::deselect`] (the remove button of an attachment).
//!
//! iOS 17 and later embed the system's picker in its compact form; there
//! [`picker_view_available`] is `true`. Elsewhere (iOS 16 and earlier,
//! Android, the desktops, the web) the component takes no room and shows
//! nothing, and the app lets the user choose with `Picker.pickImages`.
//! Android's photo picker embeds only with a system extension recent
//! devices have, which NSH does not use yet.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use nsh_core::{
    JsonValue,
    element::{NativeEvent, native},
    picker::{MAX_PICKED, PickedFile},
    prelude::*,
};

use super::{PhotoRequest, PhotosError, PhotosFuture};

/// The name of the native component [`PhotosPicker`] renders, which the
/// platform registers where it embeds the system's picker.
pub const PICKER_COMPONENT: &str = "nsh-extra/photos.picker";

/// Whether [`PhotosPicker`] shows the system's picker here: on iOS 17 and
/// later. Elsewhere it takes no room, and the app lets the user choose
/// with `Picker.pickImages`. Any thread.
pub fn picker_view_available() -> bool {
    platform::available()
}

/// The photo `id` selected in a [`PhotosPicker`], prepared as `request`
/// says, as `Picker.pickImages` prepares a picked image: scaled down to
/// `max_dimension`, upright, a JPEG without its metadata (HEIC becomes
/// one) unless it is a PNG, GIF or WebP, which stay as they are when not
/// scaled. Needs no access to the library. A photo stored only in iCloud is
/// downloaded. Dropping the future cancels the read. Fails with
/// [`NOT_FOUND`](super::NOT_FOUND) for an id that is not selected (any
/// longer) in a picker shown. In a task.
pub async fn load_picked(id: &str, request: PhotoRequest) -> Result<PickedFile, PhotosError> {
    let source = picked(|picked| picked.get(id).cloned());
    let Some(source) = source else {
        return Err(PhotosError::not_found(format!(
            "no photo {id} is selected in a photos picker"
        )));
    };
    match source.load(request).await {
        Ok(file) => nsh_core::picker::finish(&request.pick_request(), vec![file])
            .pop()
            .ok_or_else(|| PhotosError::failed("the photo cannot be read")),
        Err(error) => {
            log::warn!("picked photo {id} not read: {error}");
            Err(error)
        }
    }
}

/// What reads one selected photo: the system's item for it.
pub(crate) trait PickedSource: Send + Sync {
    /// The photo, prepared for `request` as the platform sees fit;
    /// [`load_picked`] completes its type, size and name.
    fn load(&self, request: PhotoRequest) -> PhotosFuture<PickedFile>;
}

/// The photos selected in the pickers shown, by id. Process-wide: the ids
/// reach any engine's code, which reads them from any thread.
static PICKED: Mutex<Option<HashMap<String, Arc<dyn PickedSource>>>> = Mutex::new(None);

/// Runs `f` on [`PICKED`].
fn picked<R>(f: impl FnOnce(&mut HashMap<String, Arc<dyn PickedSource>>) -> R) -> R {
    let mut picked = PICKED.lock().unwrap_or_else(|e| e.into_inner());
    f(picked.get_or_insert_with(HashMap::new))
}

/// One picker's selection: its photos' ids, in the order the system
/// reports them, whose sources [`load_picked`] reads. An id is the
/// picker's serial and the photo's key in it (the library's identifier of
/// the photo), so two pickers selecting the same photo give two ids, each
/// gone with its own selection.
#[cfg(any(target_os = "ios", test))]
pub(crate) struct Selection {
    prefix: String,
    ids: Vec<String>,
}

#[cfg(any(target_os = "ios", test))]
impl Selection {
    pub(crate) fn new() -> Self {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SERIAL: AtomicU64 = AtomicU64::new(1);
        Self {
            prefix: format!("{}:", SERIAL.fetch_add(1, Ordering::Relaxed)),
            ids: Vec::new(),
        }
    }

    /// The id of the photo `key` in this picker.
    pub(crate) fn id(&self, key: &str) -> String {
        format!("{}{key}", self.prefix)
    }

    /// The key of the photo `id` names, when it is this picker's.
    pub(crate) fn key<'a>(&self, id: &'a str) -> Option<&'a str> {
        id.strip_prefix(&self.prefix)
    }

    /// The keys selected now.
    pub(crate) fn keys(&self) -> Vec<String> {
        self.ids
            .iter()
            .filter_map(|id| self.key(id).map(str::to_owned))
            .collect()
    }

    /// The selection is now `photos`, by key, each with what reads it. A
    /// photo selected already keeps its source (the system gives none for
    /// a photo it shows selected when the picker is made again). Returns
    /// the ids when they changed.
    pub(crate) fn set(
        &mut self,
        photos: Vec<(String, Arc<dyn PickedSource>)>,
    ) -> Option<Vec<String>> {
        let ids: Vec<String> = picked(|picked| {
            let ids: Vec<String> = photos
                .into_iter()
                .map(|(key, source)| {
                    let id = self.id(&key);
                    picked.entry(id.clone()).or_insert(source);
                    id
                })
                .collect();
            for gone in self.ids.iter().filter(|id| !ids.contains(id)) {
                picked.remove(gone);
            }
            ids
        });
        if ids == self.ids {
            return None;
        }
        self.ids = ids;
        Some(self.ids.clone())
    }

    /// The photo `id` is no longer selected. Returns the ids when they
    /// changed.
    pub(crate) fn remove(&mut self, id: &str) -> Option<Vec<String>> {
        let index = self.ids.iter().position(|selected| selected == id)?;
        self.ids.remove(index);
        picked(|picked| picked.remove(id));
        Some(self.ids.clone())
    }
}

/// A picker gone takes its selection with it.
#[cfg(any(target_os = "ios", test))]
impl Drop for Selection {
    fn drop(&mut self) {
        picked(|picked| {
            for id in &self.ids {
                picked.remove(id);
            }
        });
    }
}

/// Which photos a [`PhotosPicker`] shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
#[non_exhaustive]
pub enum PhotosPickerFilter {
    /// Every photo (default).
    #[default]
    Images,
    /// Live Photos.
    LivePhotos,
    /// Screenshots.
    Screenshots,
}

impl PhotosPickerFilter {
    /// The name the native component takes.
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Images => "images",
            Self::LivePhotos => "livePhotos",
            Self::Screenshots => "screenshots",
        }
    }
}

/// The props of [`PhotosPicker`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct PhotosPickerProps {
    /// At most this many photos are selected at once; 0 lets the user
    /// select as many as the system allows. Default 100, as many as
    /// `Picker.pickImages` picks.
    #[prop(default = MAX_PICKED)]
    pub selection_limit: Prop<u32>,
    /// Which photos it shows (default every photo).
    #[prop(default)]
    pub filter: Prop<PhotosPickerFilter>,
}

/// The events of a [`PhotosPicker`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum PhotosPickerEvent {
    /// The user selected or deselected a photo: the ids of every photo
    /// selected now, in the order the user selected them (the picker
    /// numbers them so). Each reads with
    /// `Photos.loadPicked` ([`load_picked`]) while it is selected.
    #[args(ids)]
    Change(Vec<SharedString>),
}

/// The methods of a [`PhotosPicker`]'s ref.
pub struct PhotosPickerApi {
    picker: ElementRef,
}

#[methods]
impl PhotosPickerApi {
    /// Deselects the photo `id` in the picker (the user removed it from
    /// what the app holds); `change` reports the selection without it. An
    /// id that is not selected changes nothing.
    pub fn deselect(&self, id: String) {
        self.picker.command("deselect", JsonValue::String(id));
    }
}

/// The system's photo picker, embedded in the layout: on iOS 17 and later,
/// its compact form, one row of the library's photos the user selects
/// and deselects in place, without the app reading the library (the
/// system shows it out of the app's process). Each change reports every
/// photo selected (`onChange`), as ids the app reads with
/// `Photos.loadPicked`; its ref's `deselect(id)` deselects one. Its size is
/// its style's: give it a height (the row fills it) and round its corners
/// with `borderRadius` and `overflow: "hidden"`. Where
/// `Photos.pickerViewAvailable()` is false (iOS 16 and earlier, Android,
/// the desktops, the web) it takes no room and shows nothing, and the app
/// lets the user choose with `Picker.pickImages`.
#[component(methods = PhotosPickerApi)]
pub fn PhotosPicker(props: PhotosPickerProps, cx: Scope<PhotosPickerEvent>) -> impl IntoElement {
    let picker = element_ref();
    // Registered where nothing shows too: `deselect` then changes nothing.
    cx.methods(PhotosPickerApi { picker });
    if !picker_view_available() {
        return view().hidden().into_element();
    }
    native(PICKER_COMPONENT)
        .element_ref(&picker)
        .prop("selectionLimit", move || {
            JsonValue::from(props.selection_limit.get())
        })
        .prop("filter", move || JsonValue::from(props.filter.get().name()))
        .on_native_event(move |event: &NativeEvent| {
            if &*event.name == "change"
                && let Some(ids) = event.data.as_array()
            {
                let ids = ids
                    .iter()
                    .filter_map(JsonValue::as_str)
                    .map(|id| SharedString::from(id.to_owned()))
                    .collect();
                cx.emit(PhotosPickerEvent::Change(ids));
            }
        })
        .into_element()
}

#[cfg(target_os = "ios")]
use super::ios_picker as platform;

/// Where no system picker embeds: iOS before 17 is the iOS part's answer;
/// here Android (its embedded picker needs a system extension NSH does not
/// use yet), the desktops, the web and headless runs.
#[cfg(not(target_os = "ios"))]
mod platform {
    pub(super) fn available() -> bool {
        false
    }
}
