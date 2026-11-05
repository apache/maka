//! Input autofill hints in the DOM field's JSON config. Kept independent
//! of the browser so the encoder's tests run on the host too.

use std::fmt::Write as _;

use nsh_core::{AutoFill, InputConfig};

pub(crate) fn auto_complete(out: &mut String, fill: AutoFill) {
    // HTML's autofill field names, rather than the native platforms' names.
    let token = match fill {
        AutoFill::Default => return,
        AutoFill::Off => "off",
        AutoFill::Username => "username",
        AutoFill::Password => "current-password",
        AutoFill::NewPassword => "new-password",
        AutoFill::OneTimeCode => "one-time-code",
        AutoFill::Email => "email",
        AutoFill::Tel => "tel",
        AutoFill::Name => "name",
        AutoFill::GivenName => "given-name",
        AutoFill::FamilyName => "family-name",
        AutoFill::MiddleName => "additional-name",
        AutoFill::Nickname => "nickname",
        AutoFill::Organization => "organization",
        AutoFill::StreetAddress => "street-address",
        AutoFill::AddressLine1 => "address-line1",
        AutoFill::AddressLine2 => "address-line2",
        AutoFill::City => "address-level2",
        AutoFill::Region => "address-level1",
        AutoFill::PostalCode => "postal-code",
        AutoFill::Country => "country",
        AutoFill::CreditCardNumber => "cc-number",
        AutoFill::CreditCardExpiration => "cc-exp",
        AutoFill::CreditCardSecurityCode => "cc-csc",
        AutoFill::CreditCardName => "cc-name",
        AutoFill::Url => "url",
        AutoFill::Birthdate => "bday",
    };
    let _ = write!(out, ",\"autoComplete\":\"{token}\"");
}

/// Whether a field shows nothing of its own (an editor's text sink): no
/// caret, text and placeholder. The browser still paints an input method's
/// marks on its composing text (a bar at the editor's caret), so the field
/// is drawn transparent whole; it keeps the focus and the input method.
pub(crate) fn shows_nothing(c: &InputConfig) -> bool {
    c.caret_hidden && c.style.color.0 & 0xff == 0 && c.placeholder.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_field_without_caret_text_or_placeholder_shows_nothing() {
        let mut c = InputConfig::default();
        c.caret_hidden = true;
        c.style.color = nsh_core::Color(0);
        assert!(shows_nothing(&c));
        c.placeholder = "Message".to_owned();
        assert!(!shows_nothing(&c));
        c.placeholder.clear();
        c.style.color = nsh_core::Color(0x0000_00ff);
        assert!(!shows_nothing(&c));
        c.style.color = nsh_core::Color(0);
        c.caret_hidden = false;
        assert!(!shows_nothing(&c));
    }

    #[test]
    fn default_leaves_autocomplete_unset() {
        let mut out = String::from("{\"multiline\":false");
        auto_complete(&mut out, AutoFill::Default);
        assert_eq!(out, "{\"multiline\":false");
    }

    #[test]
    fn autofill_uses_html_tokens() {
        for (fill, token) in [
            (AutoFill::Off, "off"),
            (AutoFill::Username, "username"),
            (AutoFill::Password, "current-password"),
            (AutoFill::NewPassword, "new-password"),
            (AutoFill::OneTimeCode, "one-time-code"),
            (AutoFill::Email, "email"),
            (AutoFill::Tel, "tel"),
            (AutoFill::Name, "name"),
            (AutoFill::GivenName, "given-name"),
            (AutoFill::FamilyName, "family-name"),
            (AutoFill::MiddleName, "additional-name"),
            (AutoFill::Nickname, "nickname"),
            (AutoFill::Organization, "organization"),
            (AutoFill::StreetAddress, "street-address"),
            (AutoFill::AddressLine1, "address-line1"),
            (AutoFill::AddressLine2, "address-line2"),
            (AutoFill::City, "address-level2"),
            (AutoFill::Region, "address-level1"),
            (AutoFill::PostalCode, "postal-code"),
            (AutoFill::Country, "country"),
            (AutoFill::CreditCardNumber, "cc-number"),
            (AutoFill::CreditCardExpiration, "cc-exp"),
            (AutoFill::CreditCardSecurityCode, "cc-csc"),
            (AutoFill::CreditCardName, "cc-name"),
            (AutoFill::Url, "url"),
            (AutoFill::Birthdate, "bday"),
        ] {
            let mut out = String::new();
            auto_complete(&mut out, fill);
            assert_eq!(out, format!(",\"autoComplete\":\"{token}\""), "{fill:?}");
        }
    }
}
