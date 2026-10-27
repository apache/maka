//! `#[derive(HostProps)]`: the JS names of an enum of host props, their
//! decoding, defaults and TypeScript types (`nsh_core::js::host`).

use proc_macro2::TokenStream as TokenStream2;
use quote::quote;
use syn::{Data, DeriveInput, Expr, Fields, LitStr, spanned::Spanned};

use crate::ts_doc;

/// One JS name of a variant.
struct Name {
    name: String,
    /// `ios = …` / `android = …` / `desktop = …` / `web = …`: inside
    /// `ios={{…}}` / `android={{…}}` / `desktop={{…}}` / `web={{…}}`.
    platform: TokenStream2,
}

#[derive(Default)]
struct VariantAttrs {
    names: Vec<Name>,
    default: Option<Expr>,
    min: Option<Expr>,
    max: Option<Expr>,
    on: Option<Expr>,
    ts: Option<String>,
    with: Option<Expr>,
    reset: Option<Expr>,
    required: bool,
    nested: bool,
    internal: bool,
    once: bool,
    shared: bool,
}

fn variant_attrs(attrs: &[syn::Attribute]) -> syn::Result<VariantAttrs> {
    let mut out = VariantAttrs::default();
    let platform = |p: &str| match p {
        "ios" => quote!(::nsh_core::js::host::Platform::Ios),
        "android" => quote!(::nsh_core::js::host::Platform::Android),
        "desktop" => quote!(::nsh_core::js::host::Platform::Desktop),
        "web" => quote!(::nsh_core::js::host::Platform::Web),
        _ => quote!(::nsh_core::js::host::Platform::All),
    };
    for attr in attrs {
        if !attr.path().is_ident("prop") {
            continue;
        }
        attr.parse_nested_meta(|meta| {
            let key = meta
                .path
                .get_ident()
                .map(|i| i.to_string())
                .unwrap_or_default();
            match key.as_str() {
                "js" | "ios" | "android" | "desktop" | "web" => out.names.push(Name {
                    name: meta.value()?.parse::<LitStr>()?.value(),
                    platform: platform(&key),
                }),
                "default" => out.default = Some(meta.value()?.parse()?),
                "min" => out.min = Some(meta.value()?.parse()?),
                "max" => out.max = Some(meta.value()?.parse()?),
                "on" => out.on = Some(meta.value()?.parse()?),
                "ts" => out.ts = Some(meta.value()?.parse::<LitStr>()?.value()),
                "with" => out.with = Some(meta.value()?.parse()?),
                "reset" => out.reset = Some(meta.value()?.parse()?),
                "required" => out.required = true,
                "nested" => out.nested = true,
                "internal" => out.internal = true,
                "once" => out.once = true,
                "shared" => out.shared = true,
                _ => {
                    return Err(meta.error(
                        "expected `js`, `ios`, `android`, `desktop`, `web`, `default`, `min`, `max`, `on`, `ts`, \
                         `with`, `reset`, `required`, `nested`, `internal`, `once` or `shared`",
                    ));
                }
            }
            Ok(())
        })?;
    }
    Ok(out)
}

pub(crate) fn host_props(input: DeriveInput) -> syn::Result<TokenStream2> {
    let name = &input.ident;
    let Data::Enum(data) = &input.data else {
        return Err(syn::Error::new(
            input.span(),
            "`HostProps` is derived for enums",
        ));
    };
    let host = quote!(::nsh_core::js::host);
    let mut decode_arms = Vec::new();
    let mut nested_decode = Vec::new();
    let mut reset_arms = Vec::new();
    let mut kind_arms = Vec::new();
    let mut specs = Vec::new();
    for v in &data.variants {
        let ident = &v.ident;
        let a = variant_attrs(&v.attrs)?;
        let doc = ts_doc(&v.attrs);
        let pattern = match &v.fields {
            Fields::Unit => quote!(Self::#ident),
            Fields::Unnamed(_) => quote!(Self::#ident(..)),
            Fields::Named(_) => quote!(Self::#ident { .. }),
        };
        let single = match &v.fields {
            Fields::Unnamed(f) if f.unnamed.len() == 1 => Some(&f.unnamed[0].ty),
            _ => None,
        };
        if a.nested {
            let Some(ty) = single else {
                return Err(syn::Error::new(
                    v.span(),
                    "a `nested` variant holds one enum",
                ));
            };
            nested_decode.push(quote! {
                if let ::core::option::Option::Some(p) = <#ty as #host::HostProps>::decode(name, input, cx) {
                    return ::core::option::Option::Some(p.map(Self::#ident));
                }
            });
            reset_arms.push(quote! {
                Self::#ident(p) => #host::HostProps::reset(p).map(Self::#ident),
            });
            kind_arms.push(quote! {
                (Self::#ident(a), Self::#ident(b)) => #host::HostProps::same_kind(a, b),
            });
            specs.push(quote! { <#ty as #host::HostProps>::specs(types, out); });
            continue;
        }
        // Same discriminant: the same property.
        kind_arms.push(quote! { (#pattern, #pattern) => true, });
        if a.names.is_empty() {
            // Set by the core or the runtime, never from a JS name.
            let reset = match &a.reset {
                Some(r) => quote!(::core::option::Option::Some(#r)),
                None => quote!(::core::option::Option::None),
            };
            reset_arms.push(quote! { #pattern => #reset, });
            continue;
        }
        // A name several platforms share (`ios = "x", desktop = "x"`) is
        // decoded once.
        let mut names: Vec<&String> = Vec::new();
        for n in &a.names {
            if !names.contains(&&n.name) {
                names.push(&n.name);
            }
        }
        // The value, then the prop.
        let decode = if let Some(with) = &a.with {
            quote! { ::core::option::Option::Some(#with(input, cx)) }
        } else {
            let Some(ty) = single else {
                return Err(syn::Error::new(
                    v.span(),
                    "a variant with several fields needs `with = …`",
                ));
            };
            let missing = if a.required {
                quote!(return ::core::option::Option::Some(::core::option::Option::None))
            } else {
                match &a.default {
                    Some(d) => quote!(#d),
                    None => quote!(::core::default::Default::default()),
                }
            };
            let clamp = if a.min.is_some() || a.max.is_some() {
                let opt = |e: &Option<Expr>| match e {
                    Some(e) => quote!(::core::option::Option::Some((#e) as f64)),
                    None => quote!(::core::option::Option::None),
                };
                let (min, max) = (opt(&a.min), opt(&a.max));
                quote!(let value = #host::Clamped::clamped(value, #min, #max);)
            } else {
                quote!()
            };
            quote! {{
                let value: #ty = match <#ty as #host::HostValue>::decode(input, cx) {
                    ::core::option::Option::Some(value) => value,
                    ::core::option::Option::None => #missing,
                };
                #clamp
                ::core::option::Option::Some(::core::option::Option::Some(Self::#ident(value)))
            }}
        };
        if a.shared {
            // A name other elements' props share (`src`, `placeholder`):
            // decoded as this variant on its own elements only.
            let Some(on) = &a.on else {
                return Err(syn::Error::new(
                    v.span(),
                    "a `shared` name needs the elements it is for: `on = …`",
                ));
            };
            decode_arms.push(quote! {
                #(#names)|* if cx.on_element({
                    #[allow(unused_imports)]
                    use #host::on::*;
                    #on
                }) => return #decode,
            });
        } else {
            decode_arms.push(quote! { #(#names)|* => return #decode, });
        }
        // What clearing it from JS sets.
        let reset = if let Some(r) = &a.reset {
            quote!(::core::option::Option::Some(#r))
        } else if a.with.is_some() || a.required || a.internal || a.once {
            quote!(::core::option::Option::None)
        } else {
            let value = match &a.default {
                Some(d) => quote!(#d),
                None => quote!(::core::default::Default::default()),
            };
            quote!(::core::option::Option::Some(Self::#ident(#value)))
        };
        reset_arms.push(quote! { #pattern => #reset, });
        if a.internal {
            continue;
        }
        let on = match &a.on {
            Some(e) => quote! {{
                #[allow(unused_imports)]
                use #host::on::*;
                #e
            }},
            None => quote!(#host::on::ALL),
        };
        let ts = match (&a.ts, single) {
            (Some(ts), _) => quote!(::std::string::String::from(#ts)),
            (None, Some(ty)) => quote!(<#ty as #host::HostValue>::ts_type(types)),
            (None, None) => {
                return Err(syn::Error::new(
                    v.span(),
                    "give the TypeScript type: `ts = \"…\"`",
                ));
            }
        };
        for n in &a.names {
            let js = &n.name;
            let platform = &n.platform;
            specs.push(quote! {
                out.push(#host::HostPropSpec {
                    name: #js,
                    ts: #ts,
                    doc: #doc,
                    on: #on,
                    platform: #platform,
                });
            });
        }
    }
    Ok(quote! {
        impl #host::HostProps for #name {
            fn decode<I: #host::HostInput>(
                name: &str,
                input: &I,
                cx: &mut #host::HostCx,
            ) -> ::core::option::Option<::core::option::Option<Self>> {
                let _ = (&input, &cx);
                #[allow(unreachable_code)]
                match name {
                    #(#decode_arms)*
                    _ => {}
                }
                #(#nested_decode)*
                ::core::option::Option::None
            }

            fn reset(&self) -> ::core::option::Option<Self> {
                #[allow(unreachable_patterns)]
                match self {
                    #(#reset_arms)*
                }
            }

            fn same_kind(&self, other: &Self) -> bool {
                #[allow(unreachable_patterns)]
                match (self, other) {
                    #(#kind_arms)*
                    _ => false,
                }
            }

            fn specs(types: &mut ::nsh_core::element::TsTypes, out: &mut ::std::vec::Vec<#host::HostPropSpec>) {
                let _ = (&types, &out);
                #(#specs)*
            }
        }
    })
}
