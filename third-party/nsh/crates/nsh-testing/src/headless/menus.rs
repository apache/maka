//! The context menu steps: `rightClick(<selector>)`, the mouse's secondary
//! button over a view, and choosing from (or closing) the menu the app
//! then shows with `Menu.popup`, as a user does on a desktop; and the
//! system's edit menu an editor opens over the selection it draws
//! (`Command::OpenEditMenu`), with the platform's labels.

use nsh_core::{
    ContextMenuEvent, EditAction, EventKind, EventPayload, MouseButton, MouseEvent, PasteEvent,
    PayloadValue, PointerType, ROOT_ID, element::PropEnum, geometry::point, platform::Os,
};

use super::Headless;
use crate::{menu, selector::Selector};

impl Headless {
    /// The step `rightClick(<selector>)`: the mouse's secondary button over
    /// the middle of the view `selector` names, on a desktop (`open`'s
    /// `platform`): the view, or the nearest around it listening, hears
    /// `onContextMenu`; its handler shows a menu (`Menu.popup`) or its own
    /// UI. A phone has no mouse: there it fails.
    pub fn right_click(&mut self, selector: &str) -> Result<(), String> {
        let parsed = Selector::parse(selector)?;
        self.step(format!("rightClick({selector})"));
        self.input_with(nsh_core::platform::InputModality::Pointer);
        if !self.environment.desktop() {
            return Err(
                "a phone has no mouse to right-click with: open the app as a desktop (`platform`)"
                    .into(),
            );
        }
        let pick = self.screen.view(&parsed);
        let target = self.picked(pick, selector, "view")?;
        let at = self
            .screen
            .bounds_in_root(target)
            .ok_or_else(|| format!("`{selector}` is not on screen"))?
            .center();
        self.activate_window_of(target);
        if let Some(id) = self.screen.context_menu_target(target) {
            let origin = self
                .screen
                .bounds_in_root(id)
                .map_or(Default::default(), |b| b.origin);
            let event = ContextMenuEvent::new(
                point(at.x - origin.x, at.y - origin.y),
                at,
                Default::default(),
                Some(PointerType::Mouse),
            );
            self.send(id, EventKind::ContextMenu, EventPayload::ContextMenu(event));
        }
        // A click releases its button, as the desktop hosts report it.
        for id in self.screen.mouse_up_targets(target) {
            let origin = self
                .screen
                .bounds_in_root(id)
                .map_or(Default::default(), |b| b.origin);
            let event = MouseEvent::released(
                point(at.x - origin.x, at.y - origin.y),
                at,
                Default::default(),
                MouseButton::Right,
            );
            self.send(id, EventKind::MouseUp, EventPayload::Mouse(event));
        }
        self.done()
    }

    /// The actions of the context menu the app shows (`Menu.popup`), `None`
    /// when none is open.
    pub fn menu(&self) -> Option<Vec<menu::Entry>> {
        if let Some(items) = self.screen.menu() {
            return Some(menu::entries(items));
        }
        let (_, actions) = self.screen.edit_menu()?;
        let entries = self
            .edit_menu_items(actions)
            .into_iter()
            .map(|(label, _)| menu::Entry {
                label: label.into(),
                disabled: false,
                checked: None,
            })
            .collect();
        Some(entries)
    }

    /// What the platform's edit menu shows of `actions`, labelled as the
    /// system labels them: Paste only with something on the clipboard.
    fn edit_menu_items(&self, actions: &[EditAction]) -> Vec<(&'static str, EditAction)> {
        let android = self.environment.os == Os::Android;
        let pastes = self.screen.clipboard().is_some_and(|text| !text.is_empty());
        actions
            .iter()
            .filter_map(|&action| {
                let label = match action {
                    EditAction::Cut => "Cut",
                    EditAction::Copy => "Copy",
                    EditAction::Paste if pastes => "Paste",
                    EditAction::SelectAll if android => "Select all",
                    EditAction::SelectAll => "Select All",
                    _ => return None,
                };
                Some((label, action))
            })
            .collect()
    }

    /// Chooses `label` from the open edit menu: Paste pastes the clipboard
    /// into the input, the other actions go to it (`onEditAction`).
    fn choose_edit_menu_item(&mut self, label: &str) -> Result<(), String> {
        let (input, items) = {
            let (input, actions) = self.screen.edit_menu().ok_or("no menu is open")?;
            (input, self.edit_menu_items(actions))
        };
        let Some(&(_, action)) = items.iter().find(|(l, _)| *l == label) else {
            let shown: Vec<&str> = items.iter().map(|(l, _)| *l).collect();
            return Err(format!(
                "the edit menu has no `{label}`: it shows {}",
                shown.join(", ")
            ));
        };
        self.screen.edit_menu_closed();
        if action == EditAction::Paste {
            let text = self.screen.clipboard().unwrap_or_default().to_owned();
            self.paste_into(input, &PasteEvent::new(text));
        } else {
            self.send(
                input,
                EventKind::EditAction,
                EventPayload::Map(vec![("action", PayloadValue::Str(action.js_name().into()))]),
            );
        }
        Ok(())
    }

    /// The step `chooseMenuItem(<label>)`: chooses the open context menu's
    /// action labelled `label` (a submenu's: `"Share > Mail"`), as a click
    /// on it does: the app hears `onMenu` with its id, then the menu closes.
    pub fn choose_menu_item(&mut self, label: &str) -> Result<(), String> {
        self.step(format!("chooseMenuItem({label})"));
        if self.screen.menu().is_none() && self.screen.edit_menu().is_some() {
            self.choose_edit_menu_item(label)?;
            return self.done();
        }
        let items = self.screen.menu().ok_or("no context menu is open")?;
        let action = menu::find(items, label)?;
        let id = action.id;
        if id != 0 {
            self.menu_event(vec![("id", PayloadValue::Number(f64::from(id)))]);
        }
        self.close_open_menu();
        self.done()
    }

    /// The step `closeMenu()`: the open context menu closes with nothing
    /// chosen, as Escape or a click elsewhere closes it.
    pub fn close_menu(&mut self) -> Result<(), String> {
        self.step("closeMenu");
        if self.screen.menu().is_none() && self.screen.edit_menu().is_some() {
            self.screen.edit_menu_closed();
            return self.done();
        }
        if self.screen.menu().is_none() {
            return Err("no context menu is open".into());
        }
        self.close_open_menu();
        self.done()
    }

    fn close_open_menu(&mut self) {
        self.screen.menu_closed();
        // The app's `Menu.popup` promise settles.
        self.menu_event(vec![
            ("id", PayloadValue::Number(0.0)),
            ("closed", PayloadValue::Bool(true)),
        ]);
    }

    fn menu_event(&self, fields: Vec<(&'static str, PayloadValue)>) {
        self.engine
            .control()
            .dispatch_event(ROOT_ID, EventKind::Menu, EventPayload::Map(fields));
    }

    /// The step `dropFiles(<selector>, <uris>)`: local files (`file:`
    /// URLs) dragged from a file manager and dropped on the middle of the
    /// view `selector` names; it, or the nearest view around it listening,
    /// hears `onFileDrop`. Desktops only, as the platforms report it.
    pub fn drop_files(&mut self, selector: &str, uris: Vec<String>) -> Result<(), String> {
        let parsed = Selector::parse(selector)?;
        self.step(format!("dropFiles({selector})"));
        if !self.environment.desktop() {
            return Err("files are dropped on a desktop: open the app as one (`platform`)".into());
        }
        let pick = self.screen.view(&parsed);
        let target = self.picked(pick, selector, "view")?;
        let Some(id) = self
            .screen
            .chain(target)
            .into_iter()
            .find(|&id| self.screen.hears(id, EventKind::FileDrop))
        else {
            return Err(format!("no view at `{selector}` listens to `onFileDrop`"));
        };
        // Let go at the middle of what the selector names, as Linux
        // reports where.
        let at = self
            .screen
            .match_inside(&parsed, target)
            .and_then(|inner| self.screen.bounds_in_root(inner))
            .or_else(|| self.screen.bounds_in_root(target));
        let payload = match at {
            Some(b) => EventPayload::FileDropAt {
                uris,
                page_position: b.center(),
            },
            None => EventPayload::FileDrop(uris),
        };
        self.send(id, EventKind::FileDrop, payload);
        self.done()
    }
}
