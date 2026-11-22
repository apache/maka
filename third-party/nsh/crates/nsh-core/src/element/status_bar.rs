//! The status bar's settings, layered as UIKit's view controllers decide
//! it: the app's default (`nsh.json` `statusBar`, or a module's
//! `set_status_bar`) at the bottom, the `statusBar` of each page and dialog
//! over it, the most recently added winning field by field (a pushed page
//! or a presented dialog is over the pages below it; popping or closing
//! removes it). The core sends the merged result once per commit, when it
//! changed.

use crate::{StatusBarConfig, StatusBarSetting};

/// A page's or dialog's setting ([`StatusBars::add`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct StatusBarEntry(u64);

#[derive(Debug, Default)]
pub(crate) struct StatusBars {
    base: StatusBarSetting,
    stack: Vec<(u64, StatusBarSetting)>,
    next: u64,
    /// Changed since the last commit.
    dirty: bool,
    shown: Option<StatusBarConfig>,
}

impl StatusBars {
    /// Patches the base (fields `patch` sets).
    pub(crate) fn set_base(&mut self, patch: StatusBarSetting) {
        self.base = patch.over(self.base);
        self.dirty = true;
    }

    /// Adds `setting` over the others.
    pub(crate) fn add(&mut self, setting: StatusBarSetting) -> StatusBarEntry {
        self.next += 1;
        self.stack.push((self.next, setting));
        self.dirty = true;
        StatusBarEntry(self.next)
    }

    /// Changes `entry` in place (it keeps its place).
    pub(crate) fn set(&mut self, entry: StatusBarEntry, setting: StatusBarSetting) {
        if let Some((_, s)) = self.stack.iter_mut().find(|(id, _)| *id == entry.0) {
            *s = setting;
            self.dirty = true;
        }
    }

    pub(crate) fn remove(&mut self, entry: StatusBarEntry) {
        self.stack.retain(|(id, _)| *id != entry.0);
        self.dirty = true;
    }

    /// The merged config, when it changed since the last call (once per
    /// commit).
    pub(crate) fn take_changed(&mut self) -> Option<StatusBarConfig> {
        if !std::mem::take(&mut self.dirty) {
            return None;
        }
        let merged = self
            .stack
            .iter()
            .fold(self.base, |below, (_, s)| s.over(below));
        let config = StatusBarConfig {
            style: merged.style.unwrap_or_default(),
            hidden: merged.hidden.unwrap_or(false),
            animated: merged.animated.unwrap_or(false),
        };
        (self.shown != Some(config)).then(|| {
            self.shown = Some(config);
            config
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::StatusBarStyle;

    #[test]
    fn the_last_entry_wins_field_by_field_over_the_base() {
        let mut bars = StatusBars::default();
        let shown = |bars: &mut StatusBars| bars.take_changed().map(|c| (c.style, c.hidden));
        assert_eq!(bars.take_changed(), None, "nothing set");
        bars.set_base(StatusBarSetting::default().foreground(StatusBarStyle::Dark));
        assert_eq!(shown(&mut bars), Some((StatusBarStyle::Dark, false)));
        let first = bars.add(StatusBarSetting::default().foreground(StatusBarStyle::Light));
        let second = bars.add(StatusBarSetting::default().hidden(true));
        // Both in one commit.
        assert_eq!(shown(&mut bars), Some((StatusBarStyle::Light, true)));
        bars.set(second, StatusBarSetting::default().hidden(true));
        assert_eq!(shown(&mut bars), None, "unchanged");
        bars.remove(first);
        assert_eq!(shown(&mut bars), Some((StatusBarStyle::Dark, true)));
    }
}
