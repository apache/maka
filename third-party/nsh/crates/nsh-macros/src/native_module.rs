//! `#[native_module("gallery/native")]`: the UI set of an app's crate
//! (`nsh.json` `"rust"`), which the workspace nsh generates for the app
//! (`nsh-cli` `rust_app.rs`) finds by a fixed name.

use proc_macro2::{Span, TokenStream as TokenStream2};
use quote::{quote, quote_spanned};
use syn::{FnArg, ItemFn, LitStr, ReturnType, spanned::Spanned};

/// The entry the generated workspace calls
/// (`app_<package>::__nsh_native_module()`); keep in sync with
/// `rust_app.rs`.
const ENTRY: &str = "__nsh_native_module";

/// The public function that makes the set, at the crate's root, for tests
/// and other Rust code (`my_app_native::registry()`, as
/// `nsh_base::registry()`).
const PUBLIC: &str = "registry";

pub(crate) fn expand(specifier: LitStr, item: ItemFn) -> syn::Result<TokenStream2> {
    check_specifier(&specifier.value()).map_err(|e| syn::Error::new(specifier.span(), e))?;
    let sig = &item.sig;
    if let Some(token) = sig
        .constness
        .map(|t| t.span())
        .or(sig.asyncness.map(|t| t.span()))
    {
        return Err(syn::Error::new(
            token,
            "`#[native_module]` takes a plain `fn(registry: &mut Registry)`",
        ));
    }
    if !sig.generics.params.is_empty() || sig.generics.where_clause.is_some() {
        return Err(syn::Error::new(
            sig.generics.span(),
            "`#[native_module]`'s function is not generic",
        ));
    }
    let mut inputs = sig.inputs.iter();
    match (inputs.next(), inputs.next()) {
        (Some(FnArg::Typed(_)), None) => {}
        (Some(FnArg::Receiver(r)), _) => {
            return Err(syn::Error::new(
                r.span(),
                "`#[native_module]` goes on a free function: `fn native(registry: &mut Registry)`",
            ));
        }
        _ => {
            return Err(syn::Error::new(
                sig.inputs.span(),
                "`#[native_module]`'s function takes one parameter: `registry: &mut Registry`",
            ));
        }
    }
    if let ReturnType::Type(_, ty) = &sig.output {
        return Err(syn::Error::new(
            ty.span(),
            "`#[native_module]`'s function returns nothing: it registers into `registry`",
        ));
    }
    let ident = &sig.ident;
    // Spanned at the attribute: a second `#[native_module]` in the crate
    // fails as "the name `__nsh_native_module` is defined multiple times"
    // there.
    let span = Span::call_site();
    let entry = syn::Ident::new(ENTRY, span);
    let ui = quote!(::nsh_core::element);
    // The generated workspace calls `app_<package>::__nsh_native_module`,
    // so the entry has to be at the crate's root. A glob in a block shadows
    // the names of the module around it: in a module of its own,
    // `crate::*` finds the entry when it is at the root, the fallback says
    // where it goes when not.
    let at_root = quote_spanned! {span=>
        const _: () = {
            mod __nsh_native_module_at_root {
                #[allow(unused_imports)]
                use #ui::__private::native_module_not_at_root as #entry;

                #[allow(dead_code)]
                fn check() -> #ui::Registry {
                    #[allow(unused_imports)]
                    use crate::*;
                    #entry()
                }
            }
        };
    };
    let public = syn::Ident::new(PUBLIC, span);
    let doc = format!(
        " The crate's UI set: what TSX imports as `{}` (`#[native_module]` on `{ident}`), as \
         `nsh` serves it: what tests run next to nsh's own sets (`nsh_base::registry()`).",
        specifier.value()
    );
    Ok(quote! {
        #item

        #[doc = #doc]
        pub fn #public() -> #ui::Registry {
            let mut registry = #ui::Registry::ui_set(#specifier);
            #ident(&mut registry);
            registry
        }

        /// The app's UI set, which nsh's generated workspace calls
        /// (`#[native_module]`).
        #[doc(hidden)]
        pub fn #entry() -> #ui::Registry {
            #public()
        }

        #at_root
    })
}

/// Whether `specifier` is one an import can name the set by: a bare
/// specifier (`gallery/native`, `@acme/ui/forms`), not a path or URL, and
/// not nsh's own (`nsh`, `nsh/...`).
fn check_specifier(specifier: &str) -> Result<(), String> {
    let wanted = "a bare import specifier such as \"my-app/native\" or \"@acme/ui\"";
    if specifier.is_empty() {
        return Err(format!("the specifier is empty: {wanted}"));
    }
    if specifier == "nsh" || specifier.starts_with("nsh/") {
        return Err(format!(
            "`{specifier}` is nsh's own: the app's set needs a specifier of its own ({wanted})"
        ));
    }
    if specifier.starts_with('.') {
        return Err(format!(
            "`{specifier}` is a relative path: it must be {wanted}"
        ));
    }
    let segments: Vec<_> = specifier.split('/').collect();
    let scoped = specifier.starts_with('@');
    if scoped && segments.len() < 2 {
        return Err(format!(
            "`{specifier}`: a scoped specifier names a package (`@scope/name`)"
        ));
    }
    for (i, segment) in segments.iter().enumerate() {
        let name = if i == 0 && scoped {
            &segment[1..]
        } else {
            segment
        };
        if name.is_empty() || name == "." || name == ".." {
            return Err(format!("`{specifier}` is not {wanted}"));
        }
        if let Some(c) = name
            .chars()
            .find(|c| !(c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~')))
        {
            return Err(format!("`{specifier}` has `{c}`: it must be {wanted}"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::check_specifier;

    #[test]
    fn specifiers_are_bare_and_not_nshs() {
        for ok in [
            "gallery/native",
            "app",
            "@acme/ui",
            "@acme/ui/forms",
            "my-app_2/v1.0",
        ] {
            assert_eq!(check_specifier(ok), Ok(()), "{ok}");
        }
        for bad in [
            "",
            "nsh",
            "nsh/base",
            "nsh/base/mobile",
            "./native",
            "../native",
            "/native",
            "app/",
            "app//native",
            "app/../x",
            "@acme",
            "@/ui",
            "https://x.io/a",
            "app native",
            "app\\native",
            ".hidden",
        ] {
            assert!(check_specifier(bad).is_err(), "{bad:?}");
        }
    }
}
