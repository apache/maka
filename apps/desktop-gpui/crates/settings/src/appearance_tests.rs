/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! UI integration tests of the Appearance page's App icon and Custom pets
//! sections: the settings surface in a headless window over a temporary
//! State Root, with imported icons in a temporary directory and the Dock
//! replaced by a recorder.

// Test setup reads and writes fixture files synchronously.
#![allow(clippy::disallowed_methods)]

use std::cell::RefCell;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;

use futures_lite::future::Boxed;
use gpui_kit::component::{Root, Theme, ThemeMode};
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{
    AppContext as _, Context, ElementId, Entity, IntoElement, ParentElement as _, Render,
    Styled as _, TestAppContext, Window, WindowHandle, div, px, size,
};
use host_client::{ConnectionEvent, HostEvent};
use serde_json::json;
use shared::copy::appearance as copy;
use shared::domain_element_id;
use workspace::{ConnectionCatalog, HostSession, ProjectSelection};

use crate::app_icon::{APP_ICON_GROUPS, AppIcon, AppIconChoice, CustomIcons};
use crate::tests::{ScriptedHost, accepted, catalog_page, policy, reveal};
use crate::{
    AboutFacts, AppPreferences, Appearance, Language, NarrowSidebar, Preferences, PreferencesStore,
    SettingsContext, SettingsSection, SettingsView, install_app_icons,
};
use shared::copy::settings as settings_copy;

/// Records every save.
#[derive(Default)]
struct Saved(RefCell<Vec<Preferences>>);

impl PreferencesStore for Saved {
    fn load(&self) -> Boxed<io::Result<Option<Preferences>>> {
        Box::pin(async { Ok(None) })
    }

    fn save(&self, preferences: Preferences) -> Boxed<io::Result<()>> {
        self.0.borrow_mut().push(preferences);
        Box::pin(async { Ok(()) })
    }
}

struct Shell(Entity<SettingsView>);

impl Render for Shell {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(self.0.clone())
    }
}

/// A directory under the system's temporary one, removed when dropped.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("settings-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).expect("temp dir");
        Self(fs::canonicalize(path).expect("canonical"))
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).ok();
    }
}

struct Page {
    dir: TempDir,
    view: Entity<SettingsView>,
    window: WindowHandle<Root>,
    /// Every icon put on the Dock, in order, with its art's size.
    docked: Rc<RefCell<Vec<(AppIconChoice, (u32, u32))>>>,
    saved: Rc<Saved>,
}

impl Page {
    /// Settings on Appearance, with `preferences` restored and the Dock
    /// recorded.
    fn open(preferences: Preferences, cx: &mut TestAppContext) -> Self {
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init(cx);
            cx.set_reduce_motion(true);
        });
        let dir = TempDir::new("appearance");
        let saved = Rc::new(Saved::default());
        let docked = Rc::new(RefCell::new(Vec::new()));
        cx.update(|cx| {
            let store: Rc<dyn PreferencesStore> = saved.clone();
            AppPreferences::global(cx)
                .update(cx, |current, cx| current.restore(preferences, Some(store), cx));
            let docked = docked.clone();
            let dock = Rc::new(move |choice: AppIconChoice, art: &[u8], _: &mut gpui_kit::App| {
                let size = image::load_from_memory(art).map(|art| (art.width(), art.height()));
                docked.borrow_mut().push((choice, size.unwrap_or_default()));
            });
            install_app_icons(Some(dir.0.join("app-icons")), dock, cx);
        });
        let transport = Arc::new(ScriptedHost::default());
        transport.reply("runtime.policy.query", Ok(policy(3, "bypass")));
        transport.always("connection.catalog.query", Ok(catalog_page(6)));
        let host = cx.new(|_| HostSession::with_transport(dir.0.join("state"), transport.clone()));
        host.update(cx, |host, cx| {
            host.handle_host_event(
                HostEvent::Connection(ConnectionEvent::Connected { accepted: accepted() }),
                cx,
            )
        });
        let connections = cx.new(|cx| ConnectionCatalog::new(host.clone(), cx));
        let projects = cx.new(|cx| {
            ProjectSelection::new(host.clone(), Rc::new(workspace::UnavailableProjectCatalog), cx)
        });
        cx.run_until_parked();
        let context = SettingsContext::new(host, connections, projects, AboutFacts::new("9.9.9"));
        let mut view = None;
        let window = cx.open_window(size(px(1512.), px(885.)), |window, cx| {
            let settings =
                cx.new(|cx| SettingsView::new(context, SettingsSection::Appearance, window, cx));
            view = Some(settings.clone());
            Root::new(cx.new(|_| Shell(settings)), window, cx)
        });
        cx.run_until_parked();
        Self { dir, view: view.expect("the surface"), window, docked, saved }
    }

    fn with_window<R>(
        &self,
        cx: &mut TestAppContext,
        f: impl FnOnce(&mut Window, &mut gpui_kit::App) -> R,
    ) -> R {
        let result = cx
            .update_window(self.window.into(), |_, window, cx| {
                window.render_frame(cx);
                f(window, cx)
            })
            .expect("window");
        cx.run_until_parked();
        result
    }

    /// Clicks `id`, scrolling the page to it first.
    fn click(&self, id: impl Into<ElementId>, cx: &mut TestAppContext) {
        let id = id.into();
        self.with_window(cx, |window, cx| {
            reveal(window, &id, cx);
            window.click(id, cx);
        });
    }

    fn preferences(&self, cx: &mut TestAppContext) -> Preferences {
        cx.update(|cx| AppPreferences::current(cx))
    }

    fn docked(&self) -> Vec<AppIconChoice> {
        self.docked.borrow().iter().map(|(choice, _)| *choice).collect()
    }

    fn status(&self, key: &str, cx: &mut TestAppContext) -> Option<String> {
        let id = domain_element_id("settings-status", key);
        self.with_window(cx, |window, _| window.try_find(id)?.label().map(str::to_owned))
    }

    fn icons(&self) -> CustomIcons {
        CustomIcons::new(self.dir.0.join("app-icons"))
    }

    /// Answers the open dialog with `path`.
    fn pick(&self, path: &Path, cx: &mut TestAppContext) {
        assert!(cx.did_prompt_for_paths(), "a dialog asks");
        let path = path.to_owned();
        cx.simulate_path_prompt_response(move |_| Some(vec![path]));
        cx.run_until_parked();
    }
}

fn fresh() -> Preferences {
    Preferences::new(Language::English, Appearance::Light)
}

fn png(width: u32, height: u32) -> Vec<u8> {
    let image = image::RgbaImage::from_pixel(width, height, image::Rgba([10, 120, 200, 255]));
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut io::Cursor::new(&mut bytes), image::ImageFormat::Png)
        .expect("png");
    bytes
}

#[gpui_kit::test]
fn the_sidebar_setting_chooses_icons_or_hide_and_saves_it(cx: &mut TestAppContext) {
    let page = Page::open(fresh(), cx);
    let segment =
        |narrow: NarrowSidebar| domain_element_id("settings-narrow-sidebar", narrow.key());
    page.with_window(cx, |window, cx| {
        reveal(window, &segment(NarrowSidebar::Hide), cx);
        let control = window.find("settings-narrow-sidebar");
        assert_eq!(control.label(), Some(settings_copy::NARROW_SIDEBAR.en()));
        let icons = window.find(segment(NarrowSidebar::Icons));
        assert_eq!(icons.label(), Some(settings_copy::NARROW_SIDEBAR_ICONS.en()));
        assert_eq!(icons.checked(), Some(true), "icons by default");
        assert_eq!(window.find(segment(NarrowSidebar::Hide)).checked(), Some(false));
    });
    page.click(segment(NarrowSidebar::Hide), cx);
    assert_eq!(page.preferences(cx).narrow_sidebar, NarrowSidebar::Hide);
    assert_eq!(
        page.saved.0.borrow().last().map(|saved| saved.narrow_sidebar),
        Some(NarrowSidebar::Hide)
    );
    page.with_window(cx, |window, _| {
        assert_eq!(window.find(segment(NarrowSidebar::Hide)).checked(), Some(true));
        assert_eq!(window.find(segment(NarrowSidebar::Icons)).checked(), Some(false));
    });
    page.click(segment(NarrowSidebar::Icons), cx);
    assert_eq!(page.preferences(cx).narrow_sidebar, NarrowSidebar::Icons);
}

#[gpui_kit::test]
fn choosing_an_icon_puts_it_on_the_dock_and_saves_it(cx: &mut TestAppContext) {
    let page = Page::open(fresh(), cx);
    assert_eq!(page.docked(), [AppIcon::Sky.into()], "the fresh install's icon, at start");
    page.with_window(cx, |window, _| {
        assert_eq!(window.find(AppIcon::Sky.card()).checked(), Some(true));
        assert_eq!(window.find(AppIcon::Ink.card()).label(), Some("Ink"));
        let heading = domain_element_id("settings-group-title", "app-icon");
        assert_eq!(window.find(heading).label(), Some(copy::APP_ICON.en()));
    });
    page.click(AppIcon::Ink.card(), cx);
    assert_eq!(page.preferences(cx).app_icon, AppIcon::Ink.into());
    assert_eq!(page.preferences(cx).app_icon_dark, None, "one icon everywhere");
    assert_eq!(page.saved.0.borrow().last().map(|saved| saved.app_icon), Some(AppIcon::Ink.into()));
    assert_eq!(page.docked(), [AppIcon::Sky.into(), AppIcon::Ink.into()]);
    assert_eq!(page.docked.borrow()[1].1, (1024, 1024), "the full art");
    page.with_window(cx, |window, _| {
        assert_eq!(window.find(AppIcon::Ink.card()).checked(), Some(true));
        assert_eq!(window.find(AppIcon::Sky.card()).checked(), Some(false));
    });
    // An appearance flip with one icon everywhere changes nothing.
    cx.update(|cx| Theme::change(ThemeMode::Dark, None, cx));
    cx.run_until_parked();
    assert_eq!(page.docked().len(), 2);
}

#[gpui_kit::test]
fn a_dark_mode_icon_is_put_on_the_dock_when_the_appearance_flips(cx: &mut TestAppContext) {
    let page = Page::open(Preferences::new(Language::English, Appearance::System), cx);
    cx.update(|cx| Theme::change(ThemeMode::Light, None, cx));
    cx.run_until_parked();
    // The switch seeds the dark slot with Desktop's recommendation and
    // moves the grid to it.
    page.click("settings-toggle:app-icon-split", cx);
    let preferences = page.preferences(cx);
    assert_eq!(
        (preferences.app_icon, preferences.app_icon_dark),
        (AppIcon::Sky.into(), Some(AppIcon::Ink.into()))
    );
    page.with_window(cx, |window, _| {
        assert_eq!(window.find(AppIcon::Ink.card()).checked(), Some(true), "the dark slot shows");
        let dark = domain_element_id("settings-app-icon-slot", "dark");
        assert_eq!(window.find(dark).checked(), Some(true));
    });
    assert_eq!(page.docked(), [AppIcon::Sky.into()], "the app is light");
    page.click(AppIcon::Carbon.card(), cx);
    assert_eq!(page.preferences(cx).app_icon_dark, Some(AppIcon::Carbon.into()));
    assert_eq!(page.preferences(cx).app_icon, AppIcon::Sky.into(), "the light slot stays");

    // The system goes dark: the dark icon; light again: the light one.
    cx.update(|cx| Theme::change(ThemeMode::Dark, None, cx));
    cx.run_until_parked();
    assert_eq!(page.docked(), [AppIcon::Sky.into(), AppIcon::Carbon.into()]);
    cx.update(|cx| Theme::change(ThemeMode::Light, None, cx));
    cx.run_until_parked();
    assert_eq!(page.docked().last(), Some(&AppIcon::Sky.into()));

    // Editing the light slot while split leaves the dark one.
    page.click(domain_element_id("settings-app-icon-slot", "light"), cx);
    page.click(AppIcon::Ocean.card(), cx);
    let preferences = page.preferences(cx);
    assert_eq!(
        (preferences.app_icon, preferences.app_icon_dark),
        (AppIcon::Ocean.into(), Some(AppIcon::Carbon.into()))
    );
    // Off again: one icon everywhere, the light one.
    page.click("settings-toggle:app-icon-split", cx);
    assert_eq!(page.preferences(cx).app_icon_dark, None);
    cx.update(|cx| crate::choose_appearance(Appearance::Dark, cx));
    cx.run_until_parked();
    assert_eq!(page.docked().last(), Some(&AppIcon::Ocean.into()));
}

#[gpui_kit::test]
fn an_imported_icon_is_chosen_shown_and_removable(cx: &mut TestAppContext) {
    let page = Page::open(fresh(), cx);
    // What an import takes closes the section, 12 under the last group of
    // icons (Desktop's `appIconImportHelp`).
    page.with_window(cx, |window, _| {
        let help = window.find("settings-app-icon-import-help").bounds();
        let last = APP_ICON_GROUPS.last().map(|(key, _, _)| *key).expect("groups");
        let grid = window.find(domain_element_id("settings-app-icons", last)).bounds();
        assert_eq!(help.top() - grid.bottom(), gpui_kit::px(12.));
        assert_eq!(help.size.height, gpui_kit::px(20.), "12/20");
    });
    let picked = page.dir.0.join("wide.png");
    fs::write(&picked, png(600, 300)).expect("source");
    page.click("settings-app-icon-import", cx);
    page.pick(&picked, cx);
    let imported = page.icons().list();
    assert_eq!(imported.len(), 1, "stored as one PNG");
    let choice = AppIconChoice::Custom(imported[0]);
    assert_eq!(page.preferences(cx).app_icon, choice, "chosen as a tile click would");
    assert_eq!(page.docked.borrow().last().copied(), Some((choice, (1024, 1024))));
    let card = domain_element_id("settings-app-icon", &choice.key());
    page.with_window(cx, |window, _| {
        assert_eq!(window.find(card.clone()).checked(), Some(true));
        assert_eq!(window.find(card.clone()).label(), Some(copy::APP_ICON_CUSTOM.en()));
    });

    // Removing lets go of it, then deletes it.
    page.click(domain_element_id("settings-app-icon-remove", &imported[0].hex()), cx);
    assert_eq!(page.preferences(cx).app_icon, AppIcon::Sky.into(), "back to the default");
    assert_eq!(page.icons().list(), []);
    assert_eq!(page.docked().last(), Some(&AppIcon::Sky.into()));
    page.with_window(cx, |window, _| assert!(window.try_find(card).is_none()));

    // A picture too small is refused in Desktop's words.
    let small = page.dir.0.join("small.png");
    fs::write(&small, png(100, 100)).expect("small");
    page.click("settings-app-icon-import", cx);
    page.pick(&small, cx);
    assert_eq!(
        page.status("app-icon", cx).as_deref(),
        Some("Could not import the icon. That image is too small; 128×128 is the minimum.")
    );
    assert_eq!(page.icons().list(), []);
}

#[gpui_kit::test]
fn missing_imported_art_falls_back_to_the_brand_mark(cx: &mut TestAppContext) {
    let gone = AppIconChoice::parse("custom:0123456789abcdef0123456789abcdef").expect("custom");
    let page = Page::open(fresh().with_app_icon(gone, None), cx);
    assert_eq!(
        page.docked.borrow().first().map(|(choice, _)| *choice),
        Some(AppIcon::Default.into())
    );
}

/// A pack folder: 16px frames, two by two, as `pet.json` and `sheet.png`.
fn pack_folder(root: &Path, id: &str, manifest_fps: u32) -> PathBuf {
    let folder = root.join(format!("pack-{id}"));
    fs::create_dir_all(&folder).expect("folder");
    let manifest = json!({
        "schema": "maka.pet/v1",
        "id": id,
        "displayName": "Pixel",
        "description": "A test pet",
        "spriteSheet": {"path": "sheet.png", "format": "png", "frameWidth": 16, "frameHeight": 16,
                        "columns": 2, "rows": 2, "frameCount": 4},
        "animations": {
            "idle": {"frames": [0, 1], "fps": manifest_fps, "loop": true},
            "working": {"frames": [1, 2], "fps": 8, "loop": true},
            "needs-input": {"frames": [2], "fps": 1, "loop": true},
            "ready": {"frames": [3], "fps": 4, "loop": false},
            "blocked": {"frames": [3], "fps": 1, "loop": true}
        }
    });
    fs::write(folder.join("pet.json"), manifest.to_string()).expect("manifest");
    fs::write(folder.join("sheet.png"), png(32, 32)).expect("sheet");
    folder
}

fn pets(page: &Page, cx: &mut TestAppContext) -> Vec<String> {
    let section = page.view.read_with(cx, |view, cx| view.appearance().read(cx).pets().clone());
    section
        .read_with(cx, |section, _| section.pets().iter().map(|pet| pet.id().to_string()).collect())
}

#[gpui_kit::test]
fn a_pet_pack_is_imported_used_turned_off_and_removed(cx: &mut TestAppContext) {
    let page = Page::open(fresh(), cx);
    assert_eq!(pets(&page, cx), Vec::<String>::new());
    page.with_window(cx, |window, _| {
        let status = domain_element_id("settings-row", "pet-status");
        assert_eq!(window.find(status).label(), Some(copy::PET_STATUS.en()));
        // Desktop's compact EmptyState: the title, 8, its line, 16 around.
        let empty = window.find(domain_element_id("settings-empty", "pets-empty"));
        assert_eq!(empty.label(), Some(copy::PET_EMPTY.en()));
        assert_eq!(empty.bounds().size.height, gpui_kit::px(16. + 20. + 8. + 20. + 16.));
    });
    page.click("settings-pet-import", cx);
    page.pick(&pack_folder(&page.dir.0, "pixel", 4), cx);
    assert_eq!(pets(&page, cx), ["pixel"]);
    assert!(
        page.dir.0.join("state/pets/v1/pixel/pet.json").is_file(),
        "in the State Root's library"
    );
    assert_eq!(page.preferences(cx).selected_pet, None, "importing is not choosing");

    let id = pet::PetPackId::parse("pixel");
    page.click(domain_element_id("settings-pet-use", "pixel"), cx);
    assert_eq!(page.preferences(cx).selected_pet, id);
    assert_eq!(page.saved.0.borrow().last().and_then(|saved| saved.selected_pet), id);
    page.with_window(cx, |window, _| {
        assert!(
            window.try_find(domain_element_id("settings-pet-use", "pixel")).is_none(),
            "in use"
        );
    });
    page.click("settings-pet-disable", cx);
    assert_eq!(page.preferences(cx).selected_pet, None);

    // Removing asks first; Cancel keeps it.
    page.click(domain_element_id("settings-pet-use", "pixel"), cx);
    page.click(domain_element_id("settings-pet-remove", "pixel"), cx);
    page.with_window(cx, |window, cx| window.click("cancel", cx));
    assert_eq!(pets(&page, cx), ["pixel"]);
    page.click(domain_element_id("settings-pet-remove", "pixel"), cx);
    page.with_window(cx, |window, cx| window.click("ok", cx));
    assert_eq!(pets(&page, cx), Vec::<String>::new());
    assert_eq!(page.preferences(cx).selected_pet, None, "the pet in use went with it");
    assert!(!page.dir.0.join("state/pets/v1/pixel").exists());
}

#[gpui_kit::test]
fn a_bad_pack_is_refused_in_desktops_words(cx: &mut TestAppContext) {
    let page = Page::open(fresh(), cx);
    page.click("settings-pet-import", cx);
    page.pick(&pack_folder(&page.dir.0, "fast", 61), cx);
    assert_eq!(
        page.status("pets", cx).as_deref(),
        Some("Could not import pet. pet.json does not match the maka.pet/v1 format.")
    );
    assert_eq!(pets(&page, cx), Vec::<String>::new());
}

#[gpui_kit::test]
fn a_selection_the_library_no_longer_holds_is_cleared(cx: &mut TestAppContext) {
    let page = Page::open(fresh().with_selected_pet(pet::PetPackId::parse("gone")), cx);
    assert_eq!(page.preferences(cx).selected_pet, None);
}

#[gpui_kit::test]
fn the_page_scrolls_to_a_section_for_screenshots(cx: &mut TestAppContext) {
    let page = Page::open(fresh(), cx);
    let revealed = page.with_window(cx, |window, cx| {
        let revealed = page.view.update(cx, |view, cx| view.open_target("pets", window, cx));
        // One frame lays the page out, the next scrolls.
        window.simulate_next_frame(cx);
        window.render_frame(cx);
        window.simulate_next_frame(cx);
        revealed
    });
    assert!(revealed);
    let shown = |page: &Page, key: &str, cx: &mut TestAppContext| {
        page.with_window(cx, |window, _| {
            let body = window.find("settings-body").bounds();
            let title = window.find(domain_element_id("settings-group-title", key)).bounds();
            title.top() >= body.top() && title.bottom() <= body.bottom()
        })
    };
    assert!(shown(&page, "pets", cx));
    assert!(!shown(&page, "theme", cx), "scrolled past the top");
    page.with_window(cx, |window, cx| {
        assert!(page.view.update(cx, |view, cx| view.open_target("app-icon", window, cx)));
        assert!(!page.view.update(cx, |view, cx| view.open_target("palette", window, cx)));
        window.simulate_next_frame(cx);
        window.render_frame(cx);
        window.simulate_next_frame(cx);
    });
    assert!(shown(&page, "app-icon", cx));
    // Font size, which a capture of the page's top does not reach.
    page.with_window(cx, |window, cx| {
        assert!(page.view.update(cx, |view, cx| view.open_target("font-size", window, cx)));
        window.simulate_next_frame(cx);
        window.render_frame(cx);
        window.simulate_next_frame(cx);
    });
    assert!(shown(&page, "font-size", cx));
    // The last group of icons, whose cards a capture of the section's top
    // does not reach.
    page.with_window(cx, |window, cx| {
        assert!(page.view.update(cx, |view, cx| view.open_target("app-icon-end", window, cx)));
        window.simulate_next_frame(cx);
        window.render_frame(cx);
        window.simulate_next_frame(cx);
    });
    page.with_window(cx, |window, _| {
        let body = window.find("settings-body").bounds();
        let hazard = AppIconChoice::Shipped(AppIcon::Hazard).key();
        let card = window.find(domain_element_id("settings-app-icon", &hazard)).bounds();
        assert!(card.top() >= body.top() && card.bottom() <= body.bottom(), "{card:?} {body:?}");
        // The page's end stops short of the last group: a group's header
        // is the first thing under the page's top edge, not a group cut
        // through (review round 16).
        let headers: Vec<_> = crate::app_icon::APP_ICON_GROUPS
            .iter()
            .map(|(key, _, _)| {
                window.find(domain_element_id("settings-app-icon-group", key)).bounds().top()
            })
            .collect();
        assert!(
            headers.iter().any(|top| (*top - body.top()).abs() < px(1.)),
            "{headers:?} {body:?}"
        );
    });
    assert!(!shown(&page, "app-icon", cx), "scrolled past the section's top");
}
