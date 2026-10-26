//! `#[derive(JsOps)]`: an enum of operations JS records into flat lists,
//! read back by code, and the methods and properties that record them
//! (`nsh_core::js::ops`).

use proc_macro2::TokenStream as TokenStream2;
use quote::{format_ident, quote};
use syn::{Data, DeriveInput, Expr, Fields, LitStr, Path, Type, spanned::Spanned};

use crate::{decl, ts_doc};

#[derive(Default)]
struct OpAttrs {
    code: Option<Path>,
    method: Option<String>,
    /// The method's parameters: names and JS defaults.
    params: Vec<(String, Option<String>)>,
    property: Option<String>,
    initial: Option<String>,
    ts: Option<String>,
    min: Option<Expr>,
    max: Option<Expr>,
    with: Option<Expr>,
    nested: bool,
}

fn op_attrs(attrs: &[syn::Attribute]) -> syn::Result<OpAttrs> {
    let mut out = OpAttrs::default();
    for attr in attrs {
        if !attr.path().is_ident("op") {
            continue;
        }
        attr.parse_nested_meta(|meta| {
            let key = meta
                .path
                .get_ident()
                .map(|i| i.to_string())
                .unwrap_or_default();
            let string = |meta: &syn::meta::ParseNestedMeta<'_>| -> syn::Result<String> {
                Ok(meta.value()?.parse::<LitStr>()?.value())
            };
            match key.as_str() {
                "code" => out.code = Some(meta.value()?.parse()?),
                "method" => out.method = Some(string(&meta)?),
                "params" => {
                    out.params = string(&meta)?
                        .split(',')
                        .map(str::trim)
                        .filter(|p| !p.is_empty())
                        .map(|p| match p.split_once('=') {
                            Some((name, default)) => {
                                (name.trim().to_owned(), Some(default.trim().to_owned()))
                            }
                            None => (p.to_owned(), None),
                        })
                        .collect()
                }
                "property" => out.property = Some(string(&meta)?),
                "initial" => out.initial = Some(string(&meta)?),
                "ts" => out.ts = Some(string(&meta)?),
                "min" => out.min = Some(meta.value()?.parse()?),
                "max" => out.max = Some(meta.value()?.parse()?),
                "with" => out.with = Some(meta.value()?.parse()?),
                "nested" => out.nested = true,
                _ => {
                    return Err(meta.error(
                        "expected `code`, `method`, `params`, `property`, `initial`, `ts`, `min`, \
                         `max`, `with` or `nested`",
                    ));
                }
            }
            Ok(())
        })?;
    }
    Ok(out)
}

/// The context type of `#[ops(cx = …)]`.
fn context(attrs: &[syn::Attribute]) -> syn::Result<Type> {
    let mut cx = None;
    for attr in attrs {
        if !attr.path().is_ident("ops") {
            continue;
        }
        attr.parse_nested_meta(|meta| {
            if meta.path.is_ident("cx") {
                cx = Some(meta.value()?.parse()?);
                Ok(())
            } else {
                Err(meta.error("expected `cx = Type`"))
            }
        })?;
    }
    Ok(cx.unwrap_or_else(|| syn::parse_quote!(())))
}

pub(crate) fn js_ops(input: DeriveInput) -> syn::Result<TokenStream2> {
    let name = &input.ident;
    let Data::Enum(data) = &input.data else {
        return Err(syn::Error::new(
            input.span(),
            "`JsOps` is derived for enums",
        ));
    };
    let cx = context(&input.attrs)?;
    let ops = quote!(::nsh_core::js::ops);
    let host = quote!(::nsh_core::js::host);
    let mut arms = Vec::new();
    let mut nested = Vec::new();
    let mut methods = Vec::new();
    let mut properties = Vec::new();
    for v in &data.variants {
        let ident = &v.ident;
        let a = op_attrs(&v.attrs)?;
        let fields: Vec<&Type> = v.fields.iter().map(|f| &f.ty).collect();
        if a.nested {
            let [ty] = fields[..] else {
                return Err(syn::Error::new(
                    v.span(),
                    "a `nested` variant holds one enum",
                ));
            };
            nested.push(quote! {
                if let ::core::option::Option::Some(op) =
                    <#ty as #ops::JsOps>::decode(code, r, cx)?
                {
                    return ::core::result::Result::Ok(::core::option::Option::Some(op.map(Self::#ident)));
                }
            });
            continue;
        }
        let Some(code) = &a.code else {
            return Err(syn::Error::new(
                v.span(),
                "give the operation's code: `code = CV_…`",
            ));
        };
        // Read every argument (they are in the list either way), then keep
        // the operation if each was valid.
        let decode = if let Some(with) = &a.with {
            quote!(#with(r, cx)?)
        } else {
            let locals: Vec<_> = (0..fields.len()).map(|i| format_ident!("f{i}")).collect();
            let reads = fields
                .iter()
                .zip(&locals)
                .map(|(ty, local)| quote!(let #local = <#ty as #ops::OpArg<#cx>>::read(r, cx)?;));
            let clamp = if a.min.is_some() || a.max.is_some() {
                let opt = |e: &Option<Expr>| match e {
                    Some(e) => quote!(::core::option::Option::Some((#e) as f64)),
                    None => quote!(::core::option::Option::None),
                };
                let (min, max) = (opt(&a.min), opt(&a.max));
                quote!(#(let #locals = #host::Clamped::clamped(#locals, #min, #max);)*)
            } else {
                quote!()
            };
            let build = match &v.fields {
                Fields::Unit => quote!(Self::#ident),
                Fields::Unnamed(_) => quote!(Self::#ident(#(#locals),*)),
                Fields::Named(named) => {
                    let names = named.named.iter().map(|f| &f.ident);
                    quote!(Self::#ident { #(#names: #locals),* })
                }
            };
            quote! {{
                #(#reads)*
                match (#(#locals,)*) {
                    (#(::core::option::Option::Some(#locals),)*) => {
                        #clamp
                        ::core::option::Option::Some(#build)
                    }
                    #[allow(unreachable_patterns)]
                    _ => ::core::option::Option::None,
                }
            }}
        };
        arms.push(quote! {
            #code => return ::core::result::Result::Ok(::core::option::Option::Some(#decode)),
        });
        let doc = decl(&ts_doc(&v.attrs));
        if let Some(method) = &a.method {
            let names = a.params.iter().map(|(n, _)| n);
            let defaults = a.params.iter().map(|(_, d)| match d {
                Some(d) => quote!(::core::option::Option::Some(#d)),
                None => quote!(::core::option::Option::None),
            });
            let count = a.params.len();
            methods.push(quote! {{
                let names: [(&'static str, ::core::option::Option<&'static str>); #count] =
                    [#((#names, #defaults)),*];
                let mut params = ::std::vec::Vec::with_capacity(#count);
                #({
                    let ts = if ::nsh_core::element::DECLARATIONS {
                        <#fields as #ops::OpArg<#cx>>::ts(types)
                    } else {
                        ::std::string::String::new()
                    };
                    for _ in 0..<#fields as #ops::OpArg<#cx>>::ARITY {
                        let (name, default) = names[params.len()];
                        params.push(#ops::OpParam { name, ts: ts.clone(), default });
                    }
                })*
                debug_assert_eq!(params.len(), #count, "the parameters of `{}`", #method);
                out.push(#ops::OpMethod { name: #method, code: #code, params, doc: #doc });
            }});
        }
        if let Some(property) = &a.property {
            let Some(initial) = &a.initial else {
                return Err(syn::Error::new(
                    v.span(),
                    "a property has an `initial` value",
                ));
            };
            let ts = match (&a.ts, &fields[..]) {
                (Some(ts), _) => quote!(::std::string::String::from(#ts)),
                (None, [ty]) => quote!(<#ty as #ops::OpArg<#cx>>::ts(types)),
                _ => {
                    return Err(syn::Error::new(
                        v.span(),
                        "a property of several values needs `ts = \"…\"`",
                    ));
                }
            };
            properties.push(quote! {
                out.push(#ops::OpProperty {
                    name: #property,
                    code: #code,
                    ts: if ::nsh_core::element::DECLARATIONS {
                        #ts
                    } else {
                        ::std::string::String::new()
                    },
                    initial: #initial,
                    doc: #doc,
                });
            });
        }
    }
    Ok(quote! {
        impl #ops::JsOps for #name {
            type Cx = #cx;

            fn decode<L: #host::HostList<Item: #host::HostInput>>(
                code: i32,
                r: &mut #ops::OpReader<'_, L>,
                cx: &mut Self::Cx,
            ) -> ::core::result::Result<::core::option::Option<::core::option::Option<Self>>, #ops::OpsError> {
                let _ = (&r, &cx);
                match code {
                    #(#arms)*
                    _ => {}
                }
                #(#nested)*
                ::core::result::Result::Ok(::core::option::Option::None)
            }

            fn methods(types: &mut ::nsh_core::element::TsTypes, out: &mut ::std::vec::Vec<#ops::OpMethod>) {
                let _ = (&types, &out);
                #(#methods)*
            }

            fn properties(types: &mut ::nsh_core::element::TsTypes, out: &mut ::std::vec::Vec<#ops::OpProperty>) {
                let _ = (&types, &out);
                #(#properties)*
            }
        }
    })
}
