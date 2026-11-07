//! `#[native_components(windows)]`: the native components an app's crate
//! (`nsh.json` `"rust"`) registers on one platform, which the hosts and
//! runners nsh generates for the app (`nsh-cli` `rust_app.rs`) find by a
//! fixed name per platform.

use proc_macro2::{Span, TokenStream as TokenStream2};
use quote::{quote, quote_spanned};
use syn::{FnArg, Ident, ItemFn, ReturnType, spanned::Spanned};

/// The prefix of the entry the generated hosts call
/// (`app_<package>::__nsh_native_components_windows(components)`); keep in
/// sync with `rust_app.rs`.
const ENTRY: &str = "__nsh_native_components_";

/// The platforms whose hosts register an app's native components, with the
/// `cfg` their backend compiles under.
const PLATFORMS: &[(&str, &str)] = &[
    ("windows", "target_os = \"windows\""),
    ("macos", "target_os = \"macos\""),
    ("linux", "target_os = \"linux\""),
    ("ios", "target_os = \"ios\""),
];

pub(crate) fn expand(platform: Ident, item: ItemFn) -> syn::Result<TokenStream2> {
    let name = platform.to_string();
    let Some((_, cfg)) = PLATFORMS.iter().find(|(p, _)| *p == name) else {
        let known: Vec<_> = PLATFORMS.iter().map(|(p, _)| format!("`{p}`")).collect();
        return Err(syn::Error::new(
            platform.span(),
            format!(
                "`#[native_components]` takes the platform the components are for: one of {}",
                known.join(", ")
            ),
        ));
    };
    let cfg: TokenStream2 = cfg.parse().expect("a cfg predicate");
    let sig = &item.sig;
    let usage = format!(
        "`#[native_components({name})]` takes a plain `fn(components: &nsh_platform_{name}::Components)`"
    );
    if let Some(token) = sig
        .constness
        .map(|t| t.span())
        .or(sig.asyncness.map(|t| t.span()))
    {
        return Err(syn::Error::new(token, usage));
    }
    if !sig.generics.params.is_empty() || sig.generics.where_clause.is_some() {
        return Err(syn::Error::new(
            sig.generics.span(),
            "`#[native_components]`'s function is not generic",
        ));
    }
    let mut inputs = sig.inputs.iter();
    let ty = match (inputs.next(), inputs.next()) {
        (Some(FnArg::Typed(arg)), None) => &arg.ty,
        (Some(FnArg::Receiver(r)), _) => return Err(syn::Error::new(r.span(), usage)),
        _ => return Err(syn::Error::new(sig.inputs.span(), usage)),
    };
    if let ReturnType::Type(_, ty) = &sig.output {
        return Err(syn::Error::new(
            ty.span(),
            "`#[native_components]`'s function returns nothing: it registers into `components`",
        ));
    }
    let ident = &sig.ident;
    // Spanned at the attribute: a second `#[native_components]` for the
    // platform fails as the entry defined twice there.
    let span = Span::call_site();
    let entry = Ident::new(&format!("{ENTRY}{name}"), span);
    // Hygienic: a call-site name would shadow the app's function when it
    // has the same name (`fn components(components: …)`).
    let arg = Ident::new("components", Span::mixed_site());
    let ui = quote!(::nsh_core::element);
    // As `#[native_module]`'s: the generated hosts call the entry at the
    // crate's root, so a glob of `crate::*` in a module of its own finds it
    // there, and the fallback says where it goes when it is not. The call
    // is never made: `unreachable!()` stands in for the components.
    let check = Ident::new(&format!("__nsh_native_components_{name}_at_root"), span);
    let at_root = quote_spanned! {span=>
        #[cfg(#cfg)]
        const _: () = {
            mod #check {
                #[allow(unused_imports)]
                use #ui::__private::native_components_not_at_root as #entry;

                #[allow(dead_code, unreachable_code, clippy::diverging_sub_expression)]
                fn check() {
                    #[allow(unused_imports)]
                    use crate::*;
                    let () = #entry(::core::unreachable!());
                }
            }
        };
    };
    Ok(quote! {
        #[cfg(#cfg)]
        #item

        /// The crate's native components on this platform, which nsh's
        /// generated hosts and runners register on every view
        /// (`#[native_components]`).
        #[cfg(#cfg)]
        #[doc(hidden)]
        pub fn #entry(#arg: #ty) {
            #ident(#arg)
        }

        #at_root
    })
}

#[cfg(test)]
mod tests {
    use quote::{format_ident, quote};

    /// What `#[native_components(<platform>)]` makes of `item`, or its
    /// error.
    fn expand(platform: &str, item: proc_macro2::TokenStream) -> Result<String, String> {
        super::expand(format_ident!("{platform}"), syn::parse2(item).unwrap())
            .map(|made| made.to_string())
            .map_err(|e| e.to_string())
    }

    #[test]
    fn each_platform_has_its_entry_under_its_cfg() {
        for (platform, cfg) in super::PLATFORMS {
            let made = expand(
                platform,
                quote!(
                    fn components(components: &C) {}
                ),
            )
            .unwrap();
            assert!(
                made.contains(&format!("pub fn __nsh_native_components_{platform}")),
                "{made}"
            );
            // The function, the entry and the root check: all only on the
            // platform, whose crate the function's type comes from.
            let cfg = cfg.parse::<proc_macro2::TokenStream>().unwrap().to_string();
            assert_eq!(made.matches(&cfg).count(), 3, "{made}");
        }
    }

    #[test]
    fn the_platform_is_one_whose_hosts_register_components() {
        for platform in ["android", "web", "gpui", "Windows"] {
            let error = expand(
                platform,
                quote!(
                    fn components(components: &C) {}
                ),
            )
            .unwrap_err();
            assert!(
                error.contains("one of `windows`, `macos`, `linux`, `ios`"),
                "{platform}: {error}"
            );
        }
    }

    #[test]
    fn the_function_is_plain_takes_the_components_and_returns_nothing() {
        let usage = "takes a plain `fn(components: &nsh_platform_windows::Components)`";
        for item in [
            quote!(
                async fn components(components: &C) {}
            ),
            quote!(
                const fn components(components: &C) {}
            ),
            quote!(
                fn components() {}
            ),
            quote!(
                fn components(components: &C, more: &C) {}
            ),
            quote!(
                fn components(&self) {}
            ),
        ] {
            let error = expand("windows", item.clone()).unwrap_err();
            assert!(error.contains(usage), "{item}: {error}");
        }
        for item in [
            quote!(
                fn components<T>(components: &T) {}
            ),
            quote!(
                fn components(components: &C)
                where
                    C: Sized,
                {
                }
            ),
        ] {
            let error = expand("windows", item.clone()).unwrap_err();
            assert!(error.contains("is not generic"), "{item}: {error}");
        }
        let error = expand(
            "windows",
            quote!(
                fn components(components: &C) -> bool {
                    true
                }
            ),
        )
        .unwrap_err();
        assert!(error.contains("returns nothing"), "{error}");
    }
}
