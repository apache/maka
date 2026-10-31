//! Input autofill hints in the DOM field's JSON config. Kept independent
//! of the browser so the encoder's tests run on the host too.

use std::fmt::Write as _;

use nsh_core::AutoFill;

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

#[cfg(test)]
mod tests {
    use super::*;

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
