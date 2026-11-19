//! The app's address given to the system (`UrlScheme.setUrl`, Rust's
//! `set_app_url`; `Command::SetAppUrl`) as the current `NSUserActivity`, so
//! Handoff continues the page on the user's other devices. Shared by macOS
//! and iOS through `nsh-platform-apple`.
//!
//! An app opts in (`nsh.json` `"handoff": true`, which `nsh package` turns
//! into [`activity_type`] in Info.plist's `NSUserActivityTypes`; an embedding
//! app sets `NshAppView.handoff`). An `http(s)` address is a web page
//! (`NSUserActivityTypeBrowsingWeb`), which the other device opens in its
//! browser: the core takes no web links (Universal Links), so the app does
//! not continue one. Any other address is [`activity_type`], with the URL in
//! its `userInfo` ([`URL_KEY`]): the app on the other device continues it as
//! a link ([`continued_url`]). A relative address (no scheme) is the app's
//! alone and goes nowhere.

use objc2::{AnyThread, rc::Retained, runtime::AnyObject};
use objc2_foundation::{
    NSBundle, NSDictionary, NSString, NSURL, NSUserActivity, NSUserActivityTypeBrowsingWeb,
    ns_string,
};

/// The `userInfo` key of [`activity_type`]'s activities: the address.
pub const URL_KEY: &str = "url";

/// The activity type of the app's addresses that are no web pages:
/// `<bundle id>.url`. `None` without a bundle identifier (an executable run
/// from a terminal).
pub fn activity_type() -> Option<String> {
    let id = NSBundle::mainBundle().bundleIdentifier()?;
    Some(format!("{id}.url"))
}

/// Whether the app declares [`activity_type`] in its Info.plist
/// (`NSUserActivityTypes`, which `nsh package` writes for `nsh.json`
/// `"handoff": true`): the release runners then give the app's address to
/// the system.
pub fn declared() -> bool {
    let Some(kind) = activity_type() else {
        return false;
    };
    let Some(types) = NSBundle::mainBundle()
        .objectForInfoDictionaryKey(ns_string!("NSUserActivityTypes"))
        .and_then(|types| types.downcast::<objc2_foundation::NSArray>().ok())
    else {
        return false;
    };
    types
        .iter()
        .filter_map(|t| t.downcast::<NSString>().ok())
        .any(|t| t.to_string() == kind)
}

/// The activity of the address the app set last, current while it lives.
#[derive(Debug, Default)]
pub struct Activity {
    current: Option<(String, Retained<NSUserActivity>)>,
}

impl Activity {
    /// Makes `url` the current activity, in place of the one before.
    pub fn publish(&mut self, url: &str) {
        // The same address again: current again (another view's may have
        // become current since), with no new activity.
        if let Some((shown, activity)) = &self.current
            && shown == url
        {
            return activity.becomeCurrent();
        }
        if let Some((_, old)) = self.current.take() {
            old.invalidate();
        }
        let Some(activity) = activity_of(url, activity_type().as_deref()) else {
            return;
        };
        activity.becomeCurrent();
        self.current = Some((url.to_owned(), activity));
    }
}

/// The activity of `url`: a web page, or of `own` (the app's
/// [`activity_type`]) with the URL in its `userInfo`. `None` for a relative
/// address, and for one of another scheme without `own`.
fn activity_of(url: &str, own: Option<&str>) -> Option<Retained<NSUserActivity>> {
    let Some(link) = NSURL::URLWithString(&NSString::from_str(url)) else {
        log::debug!("handoff: {url} is not a URL");
        return None;
    };
    // None: relative, an address of the app's own.
    let scheme = link.scheme()?.to_string().to_ascii_lowercase();
    let activity = if scheme == "http" || scheme == "https" {
        // SAFETY: reading an immutable Foundation constant.
        let kind = unsafe { NSUserActivityTypeBrowsingWeb };
        let activity = NSUserActivity::initWithActivityType(NSUserActivity::alloc(), kind);
        activity.setWebpageURL(Some(&link));
        activity
    } else {
        let Some(kind) = own else {
            log::debug!("handoff: no bundle identifier, {url} stays the app's");
            return None;
        };
        let activity = NSUserActivity::initWithActivityType(
            NSUserActivity::alloc(),
            &NSString::from_str(kind),
        );
        let info: Retained<NSDictionary<NSString, NSString>> = NSDictionary::from_slices(
            &[&*NSString::from_str(URL_KEY)],
            &[&*NSString::from_str(url)],
        );
        // SAFETY: the same dictionary with its keys and values seen as
        // objects; property list values (strings), as `userInfo` requires.
        let info: Retained<NSDictionary> = unsafe { Retained::cast_unchecked(info) };
        // SAFETY: as above.
        unsafe { activity.setUserInfo(Some(&info)) };
        activity
    };
    // Handoff only: indexing for Spotlight would keep every address the app
    // shows (queries included) on the device, with no title to show it by.
    activity.setEligibleForHandoff(true);
    Some(activity)
}

impl Drop for Activity {
    fn drop(&mut self) {
        if let Some((_, activity)) = self.current.take() {
            activity.invalidate();
        }
    }
}

/// The address an activity the system continues carries (Handoff from
/// another device): the `userInfo` URL of [`activity_type`]. `None` for
/// other activities, web pages included.
pub fn continued_url(activity: &NSUserActivity) -> Option<String> {
    continued_url_of(activity, activity_type().as_deref())
}

/// [`continued_url`], with `own` as the app's [`activity_type`].
fn continued_url_of(activity: &NSUserActivity, own: Option<&str>) -> Option<String> {
    if activity.activityType().to_string() != own? {
        return None;
    }
    let info = activity.userInfo()?;
    let url: Retained<AnyObject> = info.objectForKey(&*NSString::from_str(URL_KEY))?;
    Some(url.downcast::<NSString>().ok()?.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_address_of_the_apps_comes_back_as_it_was_handed_off() {
        let own = Some("com.example.app.url");
        let link = activity_of("myapp://orders/7", own).unwrap();
        assert_eq!(link.activityType().to_string(), "com.example.app.url");
        assert!(link.isEligibleForHandoff());
        assert_eq!(
            continued_url_of(&link, own).as_deref(),
            Some("myapp://orders/7")
        );
        // Another app's activity type is not the app's.
        assert_eq!(continued_url_of(&link, Some("com.other.url")), None);
    }

    #[test]
    fn a_web_page_is_handed_off_to_the_browser() {
        let own = Some("com.example.app.url");
        let page = activity_of("https://example.com/orders/7?tab=all", own).unwrap();
        assert_eq!(
            page.webpageURL()
                .and_then(|url| url.absoluteString())
                .map(|url| url.to_string())
                .as_deref(),
            Some("https://example.com/orders/7?tab=all")
        );
        // The app does not continue it: the core takes no web links.
        assert_eq!(continued_url_of(&page, own), None);
        // It needs no type of the app's.
        assert!(activity_of("https://example.com/", None).is_some());
    }

    #[test]
    fn a_relative_address_or_one_without_a_type_goes_nowhere() {
        assert!(activity_of("/orders/7", Some("com.example.app.url")).is_none());
        assert!(activity_of("myapp://orders/7", None).is_none());
    }
}
