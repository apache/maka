//! Derive macros of nsh's Rust components (`nsh_core::element`):
//!
//! - `#[derive(Props)]` on a component's props struct: decoding the props JS
//!   sends (`$title`), defaults, slots and children, and the TypeScript
//!   declarations of the generated glue (doc comments included).
//! - `#[derive(PropEnum)]` on an enum of unit variants: a string union in
//!   JS (`"primary" | "plain"`).
//! - `#[derive(Event)]` on a component's event enum: the `on<Event>`
//!   handlers and their data types, and in Rust a listener method per event
//!   on the component's element (`.on_press(..)`).
//!
//! - `#[methods]` on an `impl` block of a component: its functions become
//!   methods of the component's ref in JS (`ref.setValue(5)`,
//!   `await ref.value()`).
//! - `#[module]` on an `impl` block of a unit struct: functions of a JS
//!   object (`AlertDialog.show(...)`).
//! - `#[class]` on a struct and on its `impl` block: a JS class backed by
//!   the Rust value (`new Tally(3)`, `tally.add(2)`).
//!
//! - `asset!("logo@2x.png")` / `assets!()`: the files a crate ships in its
//!   `assets/` directory, read at compile time.
//!
//! - `#[native_module("gallery/native")]` on a function of an app's crate:
//!   the UI set it registers, which nsh's generated workspace links.
//!
//! Doc comments become the TypeScript declarations' up to their first
//! heading: a `# Rust` section (or `# Panics`, `# Examples`) is for Rust
//! callers only.
//!
//! The code they generate names `::nsh_core::element`. `style_helpers!` is
//! internal to `nsh-core`: the spacing and sizing methods of `Styled`.

mod assets;
mod class;
mod host_props;
mod js_ops;
mod native_module;

use proc_macro::TokenStream;
use proc_macro2::{Span, TokenStream as TokenStream2};
use quote::{format_ident, quote};
use syn::{
    Attribute, Data, DeriveInput, Expr, Fields, FnArg, GenericArgument, Ident, ImplItem,
    ImplItemFn, ItemFn, ItemImpl, LitStr, Pat, PathArguments, ReturnType, Token, Type, bracketed,
    parse::Parse, parse_macro_input, punctuated::Punctuated, spanned::Spanned,
};

/// `text` as declaration text in generated code: left out of builds
/// without declarations (`nsh_core::element::DECLARATIONS`).
fn decl(text: &str) -> TokenStream2 {
    quote!(::nsh_core::decl!(#text))
}

/// The doc comment of an item as TypeScript shows it, lines joined: the
/// part before its first heading. The sections under headings (`# Rust`,
/// `# Panics`, `# Examples`, as rustdoc has them) are Rust's: notes about
/// `&self`, `cx` or how the call crosses stay out of the declarations.
fn docs(attrs: &[Attribute]) -> String {
    let mut lines = Vec::new();
    let mut fenced = false;
    for attr in attrs {
        if !attr.path().is_ident("doc") {
            continue;
        }
        if let syn::Meta::NameValue(nv) = &attr.meta
            && let Expr::Lit(lit) = &nv.value
            && let syn::Lit::Str(s) = &lit.lit
        {
            for line in s.value().lines() {
                let line = line.trim();
                if line.starts_with("```") {
                    fenced = !fenced;
                } else if !fenced && is_heading(line) {
                    // A heading (`# Rust`): the rest is Rust's.
                    return finish_docs(lines);
                }
                lines.push(line.to_owned());
            }
        }
    }
    finish_docs(lines)
}

/// Whether `line` is a Markdown heading: one to six `#` and a space.
fn is_heading(line: &str) -> bool {
    let hashes = line.bytes().take_while(|b| *b == b'#').count();
    (1..=6).contains(&hashes) && line[hashes..].starts_with(' ')
}

/// The TS doc of `lines`: one line, rustdoc links as code spans.
fn finish_docs(lines: Vec<String>) -> String {
    // Rustdoc links (`[`Button`]`) read as code spans in TypeScript.
    lines.join(" ").trim().replace("[`", "`").replace("`]", "`")
}

/// A variant's doc for TypeScript: its first paragraph (the others are for
/// Rust), without the leading JS name (`` `pagingEnabled`: stops at … ``
/// documents `pagingEnabled` as "Stops at …").
fn ts_doc(attrs: &[Attribute]) -> String {
    let mut lines = Vec::new();
    for attr in attrs {
        if !attr.path().is_ident("doc") {
            continue;
        }
        if let syn::Meta::NameValue(nv) = &attr.meta
            && let Expr::Lit(lit) = &nv.value
            && let syn::Lit::Str(s) = &lit.lit
        {
            let line = s.value().trim().to_owned();
            if line.is_empty() {
                break;
            }
            lines.push(line);
        }
    }
    let doc = lines.join(" ").replace("[`", "`").replace("`]", "`");
    if !doc.starts_with('`') {
        return doc;
    }
    // `name`. names the prop and nothing more.
    if doc.ends_with('`') || (doc.ends_with("`.") && doc[1..doc.len() - 2].find('`').is_none()) {
        return String::new();
    }
    // `name` (iOS): … / `a` / `b`: …
    match doc.split_once(": ") {
        Some((name, text)) if !name.contains(". ") => {
            let mut chars = text.chars();
            chars
                .next()
                .map(|c| c.to_uppercase().chain(chars).collect())
                .unwrap_or_default()
        }
        _ => doc,
    }
}

/// Whether a function of a `#[class]`, `#[module]` or `#[methods]` block
/// is exported: it has a visibility (`pub`, `pub(crate)`, ...). A private
/// one (none, or `pub(self)`) is the block's helper, Rust's only.
fn exported(vis: &syn::Visibility) -> bool {
    match vis {
        syn::Visibility::Inherited => false,
        syn::Visibility::Restricted(r) => !r.path.is_ident("self"),
        syn::Visibility::Public(_) => true,
    }
}

/// `accessibility_label` / `AccessibilityLabel` -> `accessibilityLabel`.
fn camel(name: &str) -> String {
    // A raw identifier is its name: `r#type` is `type`.
    let name = name.strip_prefix("r#").unwrap_or(name);
    let mut out = String::with_capacity(name.len());
    let mut upper = false;
    for (i, c) in name.chars().enumerate() {
        if c == '_' {
            upper = true;
        } else if i == 0 {
            out.push(c.to_ascii_lowercase());
        } else if upper {
            out.push(c.to_ascii_uppercase());
            upper = false;
        } else {
            out.push(c);
        }
    }
    out
}

/// What makes the methods of a type's derive on the element of a
/// `#[component]` using it: `defs` (trait impls carrying the field and
/// variant types, made where they are in scope) and a hidden macro of the
/// type's name (in the macro namespace, beside the type: imported with it)
/// whose `rules` the component's `#[component]` expands.
fn bridge(name: &Ident, what: &str, rules: TokenStream2, defs: TokenStream2) -> TokenStream2 {
    let mac = format_ident!("__nsh_{}_{}", what, name);
    quote! {
        #defs

        #[doc(hidden)]
        #[allow(unused_macros)]
        macro_rules! #mac {
            #rules
        }

        #[doc(hidden)]
        #[allow(unused_imports)]
        pub(crate) use #mac as #name;
    }
}

/// A primitive number type (`u32`, `f32`, ...).
fn is_number(ty: &Type) -> bool {
    matches!(
        last_segment(ty),
        Some((id, None)) if [
            "u8", "u16", "u32", "u64", "u128", "usize", "i8", "i16", "i32", "i64", "i128",
            "isize", "f32", "f64",
        ]
        .iter()
        .any(|n| id == n)
    )
}

/// Whether `ty` is a style (`nsh_core::element::Style`), whose setter takes the
/// typed styles' closure.
fn is_style(ty: &Type) -> bool {
    matches!(last_segment(ty), Some((id, None)) if id == "Style")
}

/// `PressDown` -> `press_down`, `HTMLView` -> `html_view`.
fn snake(name: &str) -> String {
    let name = name.strip_prefix("r#").unwrap_or(name);
    let chars: Vec<char> = name.chars().collect();
    let mut out = String::with_capacity(name.len() + 4);
    for (i, &c) in chars.iter().enumerate() {
        if c.is_ascii_uppercase() {
            let after_lower =
                i > 0 && (chars[i - 1].is_ascii_lowercase() || chars[i - 1].is_ascii_digit());
            let ends_acronym = i > 0
                && chars[i - 1].is_ascii_uppercase()
                && chars.get(i + 1).is_some_and(char::is_ascii_lowercase);
            if (after_lower || ends_acronym) && !out.ends_with('_') {
                out.push('_');
            }
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// The names `#[args(name, amount)]` among `attrs` gives a JS function's
/// arguments (a callback parameter's, an event handler's), in camel case.
fn args_attr(attrs: &[Attribute]) -> syn::Result<Option<(Vec<String>, Span)>> {
    let mut out = None;
    for attr in attrs {
        if !attr.path().is_ident("args") {
            continue;
        }
        if out.is_some() {
            return Err(syn::Error::new(attr.span(), "one `#[args(..)]`"));
        }
        let names = attr.parse_args_with(Punctuated::<Ident, Token![,]>::parse_terminated)?;
        if names.is_empty() {
            return Err(syn::Error::new(
                attr.span(),
                "`#[args(..)]` names the arguments: `#[args(name, amount)]`",
            ));
        }
        out = Some((
            names.iter().map(|n| camel(&n.to_string())).collect(),
            attr.span(),
        ));
    }
    Ok(out)
}

/// Removes the macros' `#[args(..)]` from the parameters of `sig` (the
/// compiler has no such attribute).
fn strip_args(sig: &mut syn::Signature) {
    for input in &mut sig.inputs {
        if let FnArg::Typed(t) = input {
            t.attrs.retain(|a| !a.path().is_ident("args"));
        }
    }
}

/// The TypeScript type of a parameter of type `ty`: a callback's with its
/// arguments named when `#[args(..)]` names them (`attrs`), checked at
/// compile time to name each.
fn param_ts(ty: &Type, attrs: &[Attribute]) -> syn::Result<TokenStream2> {
    let ui = quote!(::nsh_core::element);
    let private = quote!(#ui::__private);
    Ok(match args_attr(attrs)? {
        None => quote!(#private::arg_ts::<#ty>()),
        Some((names, span)) => {
            let n = names.len();
            let check = quote::quote_spanned! {span=>
                const {
                    ::core::assert!(
                        <#ty as #private::NamedArgs>::ARITY == #n,
                        "`#[args(..)]` names each argument of the callback, as many names as it has"
                    )
                }
            };
            quote!({
                #check;
                |types: &mut #ui::TsTypes| #private::named_arg_ts::<#ty>(types, &[#(#names),*])
            })
        }
    })
}

/// The options of `#[prop(...)]`.
#[derive(Default)]
struct PropAttr {
    /// `default` (`Some(None)`) or `default = expr`.
    default: Option<Option<Expr>>,
    rename: Option<String>,
    /// More names a `PropEnum` variant is read from.
    aliases: Vec<String>,
    /// `Children` made only while the view places them.
    lazy: bool,
    /// A `JsObject`'s `Option` field left out of the object when `None`.
    skip_none: bool,
}

fn prop_attr(attrs: &[Attribute]) -> syn::Result<PropAttr> {
    let mut out = PropAttr::default();
    for attr in attrs {
        if !attr.path().is_ident("prop") {
            continue;
        }
        attr.parse_nested_meta(|meta| {
            if meta.path.is_ident("default") {
                out.default = Some(if meta.input.peek(Token![=]) {
                    Some(meta.value()?.parse()?)
                } else {
                    None
                });
                Ok(())
            } else if meta.path.is_ident("rename") {
                out.rename = Some(meta.value()?.parse::<LitStr>()?.value());
                Ok(())
            } else if meta.path.is_ident("alias") {
                out.aliases.push(meta.value()?.parse::<LitStr>()?.value());
                Ok(())
            } else if meta.path.is_ident("lazy") {
                out.lazy = true;
                Ok(())
            } else if meta.path.is_ident("skip_none") {
                out.skip_none = true;
                Ok(())
            } else {
                Err(meta.error(
                    "expected `default`, `default = …`, `rename = \"…\"`, `alias = \"…\"`, `lazy` or `skip_none`",
                ))
            }
        })?;
    }
    Ok(out)
}

/// Whether field `ident` is not the `Children` field found so far.
fn kind_is_not_children(children: Option<&Ident>, ident: &Ident) -> bool {
    children != Some(ident)
}

/// The last segment of a type path (`Slot`, `Option`) and its first
/// generic argument.
fn last_segment(ty: &Type) -> Option<(&Ident, Option<&Type>)> {
    let Type::Path(p) = ty else { return None };
    let seg = p.path.segments.last()?;
    let arg = match &seg.arguments {
        PathArguments::AngleBracketed(a) => a.args.iter().find_map(|a| match a {
            GenericArgument::Type(t) => Some(t),
            _ => None,
        }),
        _ => None,
    };
    Some((&seg.ident, arg))
}

enum Kind<'a> {
    Value,
    /// `Option<Renderer<T>>`: the app's function rendering `T`s.
    Renderer(&'a Type),
    Slot,
    Children,
    Items,
}

/// `#[derive(Props)]`: a component's props. Every field is a prop named in
/// camel case (`accessibility_label` is `accessibilityLabel`):
///
/// - a field of a [`JsValue`] type; required in TypeScript unless it is an
///   `Option` or has `#[prop(default)]` / `#[prop(default = expr)]`.
///   Fields start with their default (`Default::default()` without one);
///   JS clearing a prop restores it.
/// - `Option<Slot>`: a named slot, JSX the app passes in that prop.
/// - `Option<Renderer<T>>`: a render function, `(value: T) => JSX.Element`
///   in TypeScript (optional), which the view calls with a key and a value
///   where it places the content.
/// - `Children`: the JSX children; with `#[prop(lazy)]` JS makes them only
///   while the view places them (made again each time it does, released
///   when it stops: a sheet's content starts fresh when it opens).
/// - `Items`: virtualized rows (in JS `each`, a row renderer and `List`'s
///   data props), at most one, and not with `Children`.
///
/// `#[prop(rename = "…")]` sets the JS name. The fields' doc comments
/// document the props in TypeScript (the component's own is its
/// `#[component] fn`'s; the struct's stays Rust's). The props
/// also get `Default` (every field at its default). In Rust each field is
/// a setter on the element of a `#[component]` taking them
/// (`button().disabled(..)`: a value, a signal or a closure; an `Option<T>`
/// takes a `T`; a slot the content to fill it with; the children are the
/// element's `.child(..)`ren). (The derive makes a hidden macro of the
/// struct's name, which the component's `#[component]` expands, so the
/// props and the component are of one crate.)
#[proc_macro_derive(Props, attributes(prop, props))]
pub fn derive_props(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    props(input)
        .unwrap_or_else(syn::Error::into_compile_error)
        .into()
}

fn props(input: DeriveInput) -> syn::Result<TokenStream2> {
    let name = &input.ident;
    let Data::Struct(data) = &input.data else {
        return Err(syn::Error::new(
            input.span(),
            "`Props` is derived for structs",
        ));
    };
    let Fields::Named(fields) = &data.fields else {
        return Err(syn::Error::new(input.span(), "`Props` needs named fields"));
    };
    let ui = quote!(::nsh_core::element);
    let mut specs = Vec::new();
    let mut initial = Vec::new();
    let mut set_arms = Vec::new();
    let mut slot_arms = Vec::new();
    let mut children = None;
    let mut lazy_children = false;
    // `#[props(generic)]`: TS declares the props generic over `T`, the
    // type of the rows a prop takes (`data: T[]`).
    let mut generic = false;
    for attr in input.attrs.iter().filter(|a| a.path().is_ident("props")) {
        attr.parse_nested_meta(|meta| {
            if meta.path.is_ident("generic") {
                generic = true;
                Ok(())
            } else {
                Err(meta.error("expected `generic`"))
            }
        })?;
    }
    let mut items: Option<Ident> = None;
    let mut items_js: Option<String> = None;
    // Fields of type `Prop<T>`: held in signals by an instance.
    let mut held = Vec::new();
    let mut updates = Vec::new();
    let mut any_held = false;
    // The setters of the component's element: (the type of the field as
    // its setter takes it, the method), by the field's index.
    let mut field_values = Vec::new();
    let mut setters = Vec::new();
    for (index, field) in fields.named.iter().enumerate() {
        let ident = field.ident.as_ref().expect("named");
        // A `Prop<T>` is a prop of type `T`, held in a signal.
        let (ty, is_held) = match last_segment(&field.ty) {
            Some((id, Some(inner))) if id == "Prop" => (inner, true),
            _ => (&field.ty, false),
        };
        any_held |= is_held;
        if is_held {
            held.push(quote!(#ident: self.#ident.__hold()));
            updates.push(quote!(self.#ident.__update_from(&new.#ident);));
        } else {
            held.push(quote!(#ident: ::core::clone::Clone::clone(&self.#ident)));
            updates.push(quote! {
                if self.#ident != new.#ident {
                    self.#ident = ::core::clone::Clone::clone(&new.#ident);
                    changed = true;
                }
            });
        }
        let attr = prop_attr(&field.attrs)?;
        let js = attr
            .rename
            .clone()
            .unwrap_or_else(|| camel(&ident.to_string()));
        let field_doc = decl(&docs(&field.attrs));
        let kind = match last_segment(ty) {
            Some((id, Some(inner))) if id == "Option" => match last_segment(inner) {
                Some((s, _)) if s == "Slot" => Kind::Slot,
                Some((r, Some(t))) if r == "Renderer" => Kind::Renderer(t),
                _ => Kind::Value,
            },
            Some((id, _)) if id == "Children" => Kind::Children,
            Some((id, _)) if id == "Items" => Kind::Items,
            _ => Kind::Value,
        };
        let is_option = matches!(last_segment(ty), Some((id, _)) if id == "Option");
        let init = match (&attr.default, &kind) {
            (_, Kind::Items) => quote!(#ui::Items::__new(#js)),
            (Some(Some(expr)), _) => quote!(#expr),
            _ => quote!(::core::default::Default::default()),
        };
        {
            let docs: Vec<_> = field
                .attrs
                .iter()
                .filter(|a| a.path().is_ident("doc"))
                .collect();
            let fallback = docs.is_empty().then(|| {
                let doc = format!(" Sets its prop `{js}`.");
                quote!(#[doc = #doc])
            });
            let value_ty = ty;
            let method = match (&kind, is_held) {
                // A style is set as an element's state styles are, with the
                // typed styles (`.selected_style(|s| s.bg(..))`).
                (Kind::Value, _) if is_style(value_ty) => {
                    field_values.push(quote! {
                        impl #ui::__private::PropField<#index> for #name {
                            type Value = #value_ty;
                        }
                    });
                    let value = quote! {
                        <<$props as #ui::__private::PropField<#index>>::Value as ::core::convert::From<#ui::StyleRefinement>>::from(
                            style(#ui::StyleRefinement::default()),
                        )
                    };
                    let assign = if is_held {
                        quote!(#ui::Prop::from(#value))
                    } else {
                        value
                    };
                    Some(quote! {
                        $($vis)* fn #ident(
                            mut self,
                            style: impl ::core::ops::FnOnce(#ui::StyleRefinement) -> #ui::StyleRefinement,
                        ) -> Self {
                            self.0.__props_mut().#ident = #assign;
                            self
                        }
                    })
                }
                (Kind::Value, true) => {
                    field_values.push(quote! {
                        impl #ui::__private::PropField<#index> for #name {
                            type Value = #value_ty;
                        }
                    });
                    // A number takes what element setters take: a literal
                    // is then of the field's type (`.index(1)`).
                    Some(if is_number(value_ty) {
                        quote! {
                            $($vis)* fn #ident(
                                mut self,
                                value: impl #ui::IntoReactive<<$props as #ui::__private::PropField<#index>>::Value>,
                            ) -> Self {
                                self.0.__props_mut().#ident = #ui::Prop::from(#ui::IntoReactive::into_reactive(value));
                                self
                            }
                        }
                    } else {
                        quote! {
                            $($vis)* fn #ident<M>(
                                mut self,
                                value: impl #ui::IntoProp<<$props as #ui::__private::PropField<#index>>::Value, M>,
                            ) -> Self {
                                self.0.__props_mut().#ident = #ui::Prop::from(#ui::IntoProp::into_prop(value));
                                self
                            }
                        }
                    })
                }
                (Kind::Value, false) => {
                    field_values.push(quote! {
                        impl #ui::__private::PropField<#index> for #name {
                            type Value = #value_ty;
                        }
                    });
                    // A number is taken as it is (a literal is then of the
                    // field's type), anything else converted.
                    Some(if is_number(value_ty) {
                        quote! {
                            $($vis)* fn #ident(
                                mut self,
                                value: <$props as #ui::__private::PropField<#index>>::Value,
                            ) -> Self {
                                self.0.__props_mut().#ident = value;
                                self
                            }
                        }
                    } else {
                        quote! {
                            $($vis)* fn #ident(
                                mut self,
                                value: impl ::core::convert::Into<<$props as #ui::__private::PropField<#index>>::Value>,
                            ) -> Self {
                                self.0.__props_mut().#ident = ::core::convert::Into::into(value);
                                self
                            }
                        }
                    })
                }
                // A render prop takes the Rust closure rendering a value
                // (`.render_image(|image| ..)`).
                (Kind::Renderer(_), _) => {
                    field_values.push(quote! {
                        impl #ui::__private::PropField<#index> for #name {
                            type Value = #value_ty;
                        }
                    });
                    let value = quote! {
                        ::core::option::Option::Some(#ui::Renderer::new(render))
                    };
                    let assign = if is_held {
                        quote!(#ui::Prop::from(#value))
                    } else {
                        value
                    };
                    Some(quote! {
                        $($vis)* fn #ident<E: #ui::IntoElement>(
                            mut self,
                            render: impl ::core::ops::Fn(
                                &<<$props as #ui::__private::PropField<#index>>::Value as #ui::__private::RendererOf>::Item,
                            ) -> E + 'static,
                        ) -> Self {
                            self.0.__props_mut().#ident = #assign;
                            self
                        }
                    })
                }
                (Kind::Slot, _) => Some(quote! {
                    $($vis)* fn #ident(self, content: impl #ui::IntoElement) -> Self {
                        Self(self.0.fill(#js, content))
                    }
                }),
                (Kind::Items, _) => Some(quote! {
                    $($vis)* fn #ident(self, list: #ui::VirtualList) -> Self {
                        Self(self.0.items(list))
                    }
                }),
                (Kind::Children, _) => None,
            };
            if let Some(method) = method {
                setters.push(quote! {
                    #(#docs)*
                    #fallback
                    #method
                });
            }
        }
        if is_held && matches!(kind, Kind::Items) {
            return Err(syn::Error::new(
                field.span(),
                "`Items` is not a `Prop`: the rows change, not the field",
            ));
        }
        // How a field takes a new value (`value`): a held one writes its
        // signal.
        let assign = |value: TokenStream2| {
            if is_held {
                quote!(self.#ident.__set(#ui::Reactive::Static(#value)))
            } else {
                quote! {{
                    let changed = self.#ident != #value;
                    self.#ident = #value;
                    changed
                }}
            }
        };
        if is_held {
            initial.push(quote!(#ident: #ui::Prop::new(#init)));
        } else {
            initial.push(quote!(#ident: #init));
        }
        match kind {
            Kind::Value => {
                let optional = is_option || attr.default.is_some();
                specs.push(quote! {
                    #ui::PropSpec {
                        name: #js,
                        ts: #ui::ts_of::<#ty>()(types),
                        optional: #optional,
                        doc: #field_doc,
                        kind: #ui::PropKind::Value,
                        decode: ::core::option::Option::Some(|v| {
                            <#ty as #ui::JsValue>::from_js(v).map(#ui::AnyValue::new)
                        }),
                    }
                });
                let take = assign(quote!(value));
                set_arms.push(quote! {
                    #js => {
                        let value: #ty = match value {
                            ::core::option::Option::Some(v) => v.take::<#ty>().ok_or_else(|| {
                                #ui::PropError(::std::format!("`{}`: a value of another type", #js))
                            })?,
                            ::core::option::Option::None => #init,
                        };
                        ::core::result::Result::Ok(#take)
                    }
                });
            }
            Kind::Renderer(t) => {
                specs.push(quote! {
                    #ui::PropSpec {
                        name: #js,
                        ts: ::std::format!("(value: {}) => JSX.Element", #ui::ts_of::<#t>()(types)),
                        optional: true,
                        doc: #field_doc,
                        kind: #ui::PropKind::Renderer,
                        decode: ::core::option::Option::Some(|v| match v.kind() {
                            #ui::JsKind::Function => ::core::result::Result::Ok(#ui::AnyValue::new(
                                ::core::option::Option::Some(#ui::Renderer::<#t>::__js(#js)),
                            )),
                            #ui::JsKind::Undefined | #ui::JsKind::Null => ::core::result::Result::Ok(
                                #ui::AnyValue::new(::core::option::Option::<#ui::Renderer<#t>>::None),
                            ),
                            _ => ::core::result::Result::Err(v.expected("a function")),
                        }),
                    }
                });
                let take = assign(quote!(value));
                set_arms.push(quote! {
                    #js => {
                        let value: #ty = match value {
                            ::core::option::Option::Some(v) => v.take::<#ty>().ok_or_else(|| {
                                #ui::PropError(::std::format!("`{}`: a value of another type", #js))
                            })?,
                            ::core::option::Option::None => #init,
                        };
                        ::core::result::Result::Ok(#take)
                    }
                });
            }
            Kind::Slot => {
                specs.push(quote! {
                    #ui::PropSpec {
                        name: #js,
                        ts: ::std::string::String::from("JSX.Element"),
                        optional: true,
                        doc: #field_doc,
                        kind: #ui::PropKind::Slot,
                        decode: ::core::option::Option::None,
                    }
                });
                let take = assign(quote!(slot));
                slot_arms.push(quote! {
                    #js => #take,
                });
            }
            Kind::Items => {
                if items.is_some() || children.is_some() {
                    return Err(syn::Error::new(
                        field.span(),
                        "one `Items` field at most, and no `Children` with it (the row renderer is the children)",
                    ));
                }
                specs.push(quote! {
                    #ui::PropSpec {
                        name: #js,
                        ts: ::std::string::String::new(),
                        optional: false,
                        doc: #field_doc,
                        kind: #ui::PropKind::Items,
                        decode: ::core::option::Option::None,
                    }
                });
                items = Some(ident.clone());
                items_js = Some(js.clone());
            }
            Kind::Children => {
                if children.is_some() || items.is_some() {
                    return Err(syn::Error::new(
                        field.span(),
                        "one `Children` field at most, and none with `Items`",
                    ));
                }
                specs.push(quote! {
                    #ui::PropSpec {
                        name: "children",
                        ts: ::std::string::String::from("JSX.Element"),
                        optional: true,
                        doc: #field_doc,
                        kind: #ui::PropKind::Children,
                        decode: ::core::option::Option::None,
                    }
                });
                children = Some((ident.clone(), assign(quote!(children))));
                lazy_children = attr.lazy;
            }
        }
        if attr.lazy && kind_is_not_children(children.as_ref().map(|c| &c.0), ident) {
            return Err(syn::Error::new(
                field.span(),
                "`#[prop(lazy)]` is for the `Children` field",
            ));
        }
    }
    let set_children = match &children {
        Some((_, take)) => quote!(#take),
        None => quote!({
            let _ = children;
            false
        }),
    };
    let held_fns = if any_held {
        quote! {
            fn held(&self) -> Self {
                Self { #(#held),* }
            }

            fn update_from(&mut self, new: &Self) -> bool {
                let mut changed = false;
                #(#updates)*
                changed
            }
        }
    } else {
        quote!()
    };
    let items_const = match &items_js {
        Some(js) => quote!(::core::option::Option::Some(#js)),
        None => quote!(::core::option::Option::None),
    };
    let (impl_generics, ty_generics, where_clause) = input.generics.split_for_impl();
    let setters = if input.generics.params.is_empty() {
        bridge(
            name,
            "props",
            quote! {
                ([$($vis:tt)*] $element:ty, $props:ty) => {
                    // Generated names: the fields' and events', not the lints' choices.
                    #[allow(dead_code, clippy::all, clippy::pedantic)]
                    impl $element {
                        #(#setters)*
                    }
                };
            },
            quote!(#(#field_values)*),
        )
    } else {
        quote!()
    };
    Ok(quote! {
        #setters

        /// Every prop at its default (`..Default::default()` when a Rust
        /// view makes the component).
        impl #impl_generics ::core::default::Default for #name #ty_generics #where_clause {
            fn default() -> Self {
                <Self as #ui::Props>::initial()
            }
        }

        impl #impl_generics #ui::Props for #name #ty_generics #where_clause {
            const ITEMS: ::core::option::Option<&'static str> = #items_const;
            const LAZY_CHILDREN: bool = #lazy_children;
            const GENERIC: bool = #generic;

            fn spec(types: &mut #ui::TsTypes) -> ::std::vec::Vec<#ui::PropSpec> {
                let _ = &types;
                ::std::vec![#(#specs),*]
            }

            fn initial() -> Self {
                Self { #(#initial),* }
            }

            fn set(
                &mut self,
                name: &str,
                value: ::core::option::Option<#ui::AnyValue>,
            ) -> ::core::result::Result<bool, #ui::PropError> {
                match name {
                    #(#set_arms)*
                    _ => {
                        let _ = value;
                        ::core::result::Result::Err(#ui::PropError(::std::format!("unknown prop `{name}`")))
                    }
                }
            }

            fn set_slot(&mut self, name: &str, slot: ::core::option::Option<#ui::Slot>) -> bool {
                match name {
                    #(#slot_arms)*
                    _ => {
                        let _ = slot;
                        false
                    }
                }
            }

            fn set_children(&mut self, children: #ui::Children) -> bool {
                #set_children
            }

            #held_fns
        }
    })
}

/// `#[derive(JsOps)]` on an enum of operations JS records into flat lists
/// (`nsh_core::js::ops`): `#[op(code = CV_…)]` on a variant reads its
/// fields in order after that code (each an `OpArg`; `min` / `max` clamp,
/// `with = path` reads the whole variant), `nested` delegates to another
/// enum of operations. `method = "name", params = "x, y = 0"` describes the
/// generated method recording it as is, `property = "name", initial =
/// "…"` (and `ts = "…"`) the property; their docs are the variant's.
/// `#[ops(cx = Type)]` on the enum is what reading needs.
#[proc_macro_derive(JsOps, attributes(op, ops))]
pub fn derive_js_ops(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    js_ops::js_ops(input)
        .unwrap_or_else(syn::Error::into_compile_error)
        .into()
}

/// `#[derive(HostProps)]` on an enum of host element props
/// (`nsh_core::js::host`): `#[prop(js = "name", …)]` on a variant gives
/// its JS name (several for aliases; `ios = …` / `android = …` inside
/// `ios={{…}}` / `android={{…}}`), how its payload decodes (its
/// `HostValue`; `default = …`, `min` / `max`, `required`, or a whole
/// decoder `with = path`), where it applies (`on = TEXT | INPUT`), its
/// TypeScript type (`ts = "…"` over the payload's) and its reset
/// (`reset = …`); `nested` delegates to an enum of the same kind,
/// `internal` keeps it out of the element types, and `shared` marks a name
/// other elements' props have too (`src`, `placeholder`): it decodes as
/// this variant only on the elements of its `on`. Doc comments document
/// the props.
#[proc_macro_derive(HostProps, attributes(prop))]
pub fn derive_host_props(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    host_props::host_props(input)
        .unwrap_or_else(syn::Error::into_compile_error)
        .into()
}

/// `#[derive(PropEnum)]`: an enum of unit variants as a string union in JS,
/// each variant in camel case (`SemiBold` is `"semiBold"`;
/// `#[prop(rename = "…")]` sets it, `#[prop(alias = "…")]` adds names it
/// is read from). It is a `JsValue` for components' props and a
/// `HostValue` for host props.
#[proc_macro_derive(PropEnum, attributes(prop))]
pub fn derive_prop_enum(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    prop_enum(input)
        .unwrap_or_else(syn::Error::into_compile_error)
        .into()
}

fn prop_enum(input: DeriveInput) -> syn::Result<TokenStream2> {
    let name = &input.ident;
    let Data::Enum(data) = &input.data else {
        return Err(syn::Error::new(
            input.span(),
            "`PropEnum` is derived for enums",
        ));
    };
    let ui = quote!(::nsh_core::element);
    let mut names = Vec::new();
    let mut idents = Vec::new();
    // Every name a variant is read from (its own, then its aliases).
    let mut read = Vec::new();
    let mut accepted = Vec::new();
    let mut patterns = Vec::new();
    for v in &data.variants {
        if !matches!(v.fields, Fields::Unit) {
            return Err(syn::Error::new(
                v.span(),
                "`PropEnum` variants have no fields",
            ));
        }
        let attr = prop_attr(&v.attrs)?;
        let own = attr.rename.unwrap_or_else(|| camel(&v.ident.to_string()));
        let mut all = vec![own.clone()];
        all.extend(attr.aliases);
        names.push(own);
        let ident = &v.ident;
        read.push(quote!(#(#all)|* => Self::#ident));
        patterns.push(quote!(#(#all)|*));
        accepted.extend(all);
        idents.push(&v.ident);
    }
    // The aliases are part of the type: JS may use them.
    let ts = accepted
        .iter()
        .map(|n| format!("{n:?}"))
        .collect::<Vec<_>>()
        .join(" | ");
    let expected = format!("one of {ts}");
    let type_name = name.to_string();
    let doc = docs(&input.attrs);
    let declaration = if doc.is_empty() {
        format!("export type {type_name} = {ts};")
    } else {
        format!("/** {doc} */\nexport type {type_name} = {ts};")
    };
    Ok(quote! {
        impl #ui::JsValue for #name {
            fn ts_type(types: &mut #ui::TsTypes) -> ::std::string::String {
                types.declare(#type_name, |_| ::std::string::String::from(#declaration))
            }

            fn from_js(value: #ui::JsIn<'_>) -> ::core::result::Result<Self, #ui::PropError> {
                ::core::result::Result::Ok(match value.as_string().as_deref() {
                    #(::core::option::Option::Some(#patterns) => Self::#idents,)*
                    _ => return ::core::result::Result::Err(value.expected(#expected)),
                })
            }

            fn to_js<'a>(
                &self,
                host: &'a dyn #ui::JsHost,
            ) -> ::core::result::Result<#ui::JsOwned<'a>, #ui::PropError> {
                let name = <Self as #ui::PropEnum>::js_name(self);
                ::core::result::Result::Ok(#ui::JsOwned::new(host, host.new_string(name)?))
            }
        }

        impl #ui::PropEnum for #name {
            fn js_name(&self) -> &'static str {
                match self {
                    #(Self::#idents => #names,)*
                }
            }
        }

        impl ::nsh_core::js::host::HostValue for #name {
            /// One of the names; anything else is none (the prop's
            /// default).
            fn decode<I: ::nsh_core::js::host::HostInput>(
                input: &I,
                _cx: &mut ::nsh_core::js::host::HostCx,
            ) -> ::core::option::Option<Self> {
                ::core::option::Option::Some(match input.as_string()?.as_str() {
                    #(#read,)*
                    _ => return ::core::option::Option::None,
                })
            }

            fn ts_type(types: &mut #ui::TsTypes) -> ::std::string::String {
                <Self as #ui::JsValue>::ts_type(types)
            }
        }
    })
}

/// `#[derive(Event)]`: a component's events. Each variant is an event in
/// camel case (`Press` is `onPress` in JS): a unit variant carries no
/// data, a variant with named fields an object of them (camel case), a
/// variant with one unnamed field that value. Doc comments document the
/// handlers. The handler's argument is `value` (one field) or `event`
/// (named fields) in TypeScript; `#[args(index)]` on the variant names it
/// (`onSelect?: (index: number) => void`).
///
/// In Rust, the element of a `#[component]` emitting them (`button()`)
/// gets a listener method per event, named as its handler in snake case
/// (`onPressDown` is `.on_press_down(..)`, as `view().on_press(..)`): a
/// unit variant's takes `move || ..`, a one-field variant's
/// `move |value: &T| ..`, a named-field variant's the event itself. (The
/// derive makes a hidden macro of the enum's name, which the component's
/// `#[component]` expands, so the enum and the component are of one
/// crate.)
#[proc_macro_derive(Event, attributes(args))]
pub fn derive_event(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    event(input)
        .unwrap_or_else(syn::Error::into_compile_error)
        .into()
}

fn event(input: DeriveInput) -> syn::Result<TokenStream2> {
    let name = &input.ident;
    let Data::Enum(data) = &input.data else {
        return Err(syn::Error::new(
            input.span(),
            "`Event` is derived for enums",
        ));
    };
    let ui = quote!(::nsh_core::element);
    let mut specs = Vec::new();
    let mut name_arms = Vec::new();
    let mut data_arms = Vec::new();
    // The listener methods: (variant docs, method, data type, pick arm).
    let mut listeners = Vec::new();
    let mut spread_arms = Vec::new();
    for v in &data.variants {
        let ident = &v.ident;
        let js = camel(&ident.to_string());
        let method = format_ident!("on_{}", snake(&ident.to_string()));
        let variant_docs: Vec<_> = v
            .attrs
            .iter()
            .filter(|a| a.path().is_ident("doc"))
            .collect();
        let doc = decl(&docs(&v.attrs));
        let args = args_attr(&v.attrs)?;
        // Several unnamed fields: the handler's arguments, one name each.
        if let (Fields::Unnamed(f), Some((names, span))) = (&v.fields, &args)
            && f.unnamed.len() > 1
        {
            if names.len() != f.unnamed.len() {
                return Err(syn::Error::new(
                    *span,
                    "`#[args(..)]` names each argument of an event of several fields",
                ));
            }
            let tys: Vec<_> = f.unnamed.iter().map(|f| &f.ty).collect();
            let vars: Vec<_> = (0..tys.len())
                .map(|i| syn::Ident::new(&format!("a{i}"), Span::call_site()))
                .collect();
            specs.push(quote! {
                #ui::EventSpec {
                    name: #js,
                    arg: "",
                    data: if #ui::DECLARATIONS {
                        let params: ::std::vec::Vec<::std::string::String> = ::std::vec![
                            #(::std::format!("{}: {}", #names, <#tys as #ui::JsValue>::ts_type(types))),*
                        ];
                        params.join(", ")
                    } else {
                        ::std::string::String::new()
                    },
                    doc: #doc,
                    spread: true,
                }
            });
            name_arms.push(quote!(Self::#ident(..) => #js));
            data_arms.push(quote! {
                Self::#ident(#(#vars),*) => {
                    let items = ::std::vec![#(#ui::JsValue::to_js(#vars, host)?.into_raw()),*];
                    ::core::result::Result::Ok(#ui::JsOwned::new(host, host.new_array(items)?))
                }
            });
            spread_arms.push(quote!(Self::#ident(..) => true));
            // Its listener gets the event, as one of named fields does.
            listeners.push((
                variant_docs,
                method,
                quote!(#name),
                quote!(e @ #name::#ident(..) => ::core::option::Option::Some(e)),
            ));
            continue;
        }
        let named = match args {
            None => None,
            Some((names, _)) if names.len() == 1 && !matches!(v.fields, Fields::Unit) => {
                Some(names[0].clone())
            }
            Some((_, span)) => {
                return Err(syn::Error::new(
                    span,
                    "`#[args(name)]` names the data of an event that has some: one name",
                ));
            }
        };
        let arg = named.unwrap_or_else(|| {
            match &v.fields {
                Fields::Named(_) => "event",
                _ => "value",
            }
            .to_owned()
        });
        match &v.fields {
            Fields::Unit => {
                specs.push(quote! {
                    #ui::EventSpec { name: #js, arg: #arg, data: ::std::string::String::from("void"), doc: #doc, spread: false }
                });
                name_arms.push(quote!(Self::#ident => #js));
                data_arms.push(quote!(Self::#ident => ::core::result::Result::Ok(#ui::JsOwned::new(host, host.undefined()))));
                listeners.push((
                    variant_docs,
                    method,
                    quote!(()),
                    quote!(#name::#ident => ::core::option::Option::Some(&())),
                ));
            }
            Fields::Unnamed(f) if f.unnamed.len() == 1 => {
                let ty = &f.unnamed[0].ty;
                specs.push(quote! {
                    #ui::EventSpec { name: #js, arg: #arg, data: #ui::ts_of::<#ty>()(types), doc: #doc, spread: false }
                });
                name_arms.push(quote!(Self::#ident(..) => #js));
                data_arms.push(quote!(Self::#ident(v) => #ui::JsValue::to_js(v, host)));
                listeners.push((
                    variant_docs,
                    method,
                    quote!(#ty),
                    quote!(#name::#ident(v) => ::core::option::Option::Some(v)),
                ));
            }
            Fields::Named(f) => {
                let idents: Vec<_> = f
                    .named
                    .iter()
                    .map(|f| f.ident.clone().expect("named"))
                    .collect();
                let keys: Vec<_> = idents.iter().map(|i| camel(&i.to_string())).collect();
                let tys: Vec<_> = f.named.iter().map(|f| &f.ty).collect();
                specs.push(quote! {
                    #ui::EventSpec {
                        name: #js,
                        arg: #arg,
                        data: if #ui::DECLARATIONS {
                            let fields: ::std::vec::Vec<::std::string::String> = ::std::vec![
                                #(::std::format!("{}: {}", #keys, <#tys as #ui::JsValue>::ts_type(types))),*
                            ];
                            ::std::format!("{{ {} }}", fields.join("; "))
                        } else {
                            ::std::string::String::new()
                        },
                        doc: #doc,
                        spread: false,
                    }
                });
                name_arms.push(quote!(Self::#ident { .. } => #js));
                data_arms.push(quote! {
                    Self::#ident { #(#idents),* } => {
                        let owned = #ui::JsOwned::new(host, host.new_object()?);
                        let object = owned.get().raw();
                        #(host.set_field(object, #keys, #ui::JsValue::to_js(#idents, host)?.into_raw())?;)*
                        ::core::result::Result::Ok(owned)
                    }
                });
                listeners.push((
                    variant_docs,
                    method,
                    quote!(#name),
                    quote!(e @ #name::#ident { .. } => ::core::option::Option::Some(e)),
                ));
            }
            Fields::Unnamed(f) => {
                return Err(syn::Error::new(
                    f.span(),
                    "an event variant of several unnamed fields names them: `#[args(open, reason)]`",
                ));
            }
        }
    }
    let (impl_generics, ty_generics, where_clause) = input.generics.split_for_impl();
    let listeners = if input.generics.params.is_empty() {
        let impls = listeners.iter().enumerate().map(|(i, (_, _, ty, arm))| {
            quote! {
                impl #ui::__private::EventVariant<#i> for #name {
                    type Data = #ty;

                    #[allow(unreachable_patterns)]
                    fn pick(event: &Self) -> ::core::option::Option<&#ty> {
                        match event {
                            #arm,
                            _ => ::core::option::Option::None,
                        }
                    }
                }
            }
        });
        let methods = listeners.iter().enumerate().map(|(i, (docs, method, _, _))| {
            let fallback = docs.is_empty().then(|| {
                let doc = format!(" Handles its event `{}`.", &method.to_string()[3..]);
                quote!(#[doc = #doc])
            });
            quote! {
                #(#docs)*
                #fallback
                $($vis)* fn #method<M>(
                    self,
                    listener: impl #ui::IntoListener<<$event as #ui::__private::EventVariant<#i>>::Data, M>,
                ) -> Self {
                    Self(self.0.__on_variant(<$event as #ui::__private::EventVariant<#i>>::pick, listener))
                }
            }
        });
        bridge(
            name,
            "event",
            quote! {
                ([$($vis:tt)*] $element:ty, $event:ty) => {
                    // Generated names: the fields' and events', not the lints' choices.
                    #[allow(dead_code, clippy::all, clippy::pedantic)]
                    impl $element {
                        #(#methods)*
                    }
                };
            },
            quote!(#(#impls)*),
        )
    } else {
        quote!()
    };
    Ok(quote! {
        #listeners

        impl #impl_generics #ui::Event for #name #ty_generics #where_clause {
            fn spec(types: &mut #ui::TsTypes) -> ::std::vec::Vec<#ui::EventSpec> {
                let _ = &types;
                ::std::vec![#(#specs),*]
            }

            fn name(&self) -> &'static str {
                match self {
                    #(#name_arms,)*
                }
            }

            fn data_js<'a>(
                &self,
                host: &'a dyn #ui::JsHost,
            ) -> ::core::result::Result<#ui::JsOwned<'a>, #ui::PropError> {
                match self {
                    #(#data_arms,)*
                }
            }

            fn spread(&self) -> bool {
                #[allow(unreachable_patterns)]
                match self {
                    #(#spread_arms,)*
                    _ => false,
                }
            }
        }
    })
}

/// One `name => [Key, ...]` line of `style_helpers!`.
struct Helper {
    doc: String,
    name: Ident,
    keys: Vec<Ident>,
}

impl Parse for Helper {
    fn parse(input: syn::parse::ParseStream<'_>) -> syn::Result<Self> {
        let attrs = input.call(Attribute::parse_outer)?;
        let name: Ident = input.parse()?;
        input.parse::<Token![=>]>()?;
        let content;
        bracketed!(content in input);
        let keys = Punctuated::<Ident, Token![,]>::parse_terminated(&content)?
            .into_iter()
            .collect();
        Ok(Helper {
            doc: docs(&attrs),
            name,
            keys,
        })
    }
}

/// Tailwind's spacing scale: method suffix and points (4pt steps).
const STEPS: &[(&str, f32)] = &[
    ("0", 0.0),
    ("0p5", 2.0),
    ("1", 4.0),
    ("1p5", 6.0),
    ("2", 8.0),
    ("2p5", 10.0),
    ("3", 12.0),
    ("3p5", 14.0),
    ("4", 16.0),
    ("5", 20.0),
    ("6", 24.0),
    ("7", 28.0),
    ("8", 32.0),
    ("9", 36.0),
    ("10", 40.0),
    ("11", 44.0),
    ("12", 48.0),
    ("14", 56.0),
    ("16", 64.0),
    ("20", 80.0),
    ("24", 96.0),
    ("28", 112.0),
    ("32", 128.0),
    ("36", 144.0),
    ("40", 160.0),
    ("44", 176.0),
    ("48", 192.0),
    ("52", 208.0),
    ("56", 224.0),
    ("60", 240.0),
    ("64", 256.0),
    ("72", 288.0),
    ("80", 320.0),
    ("96", 384.0),
];

/// A file of the crate's `assets/` directory (`asset!("logo@2x.png")`, the
/// path relative to it), as TS imports one: an image is an `ImageAsset`
/// with its natural size in points (`@2x` / `@3x` in the name divide its
/// pixels; an image named without a density lists the scales of its
/// `@1.5x`–`@4x` siblings, and images load the one for the screen), a font
/// (`.ttf`, `.otf`) a `FontAsset` with its family name, anything else a
/// `FileAsset`. Read at compile time: a missing or broken file fails the
/// build (a variant too, and one whose pixels are not the file's size times
/// its scale), and a changed one builds the crate again. The registry ships
/// the files (`Registry::assets(assets!())`).
#[proc_macro]
pub fn asset(input: TokenStream) -> TokenStream {
    let lit = parse_macro_input!(input as LitStr);
    assets::asset(lit)
        .unwrap_or_else(syn::Error::into_compile_error)
        .into()
}

/// Every file of the crate's `assets/` directory, as `&'static
/// [AssetFile]`: what `Registry::assets` ships with the app (`nsh run`
/// serves them, `nsh package` copies them; the engine registers the
/// fonts).
#[proc_macro]
pub fn assets(input: TokenStream) -> TokenStream {
    if !input.is_empty() {
        return syn::Error::new(
            Span::call_site(),
            "`assets!()` takes no arguments: it lists the crate's `assets/` directory",
        )
        .into_compile_error()
        .into();
    }
    assets::assets(Span::call_site())
        .unwrap_or_else(syn::Error::into_compile_error)
        .into()
}

/// `#[component]` on a function: a component that runs once
/// (`Component::view`), named after the function.
///
/// ```ignore
/// /// A number with − and + buttons.
/// #[component]
/// pub fn Stepper(props: StepperProps, cx: Scope<StepperEvent>) -> impl IntoElement {
///     let value = signal(0.0);
///     view().child(text(move || format!("{}", value.get())))
/// }
/// ```
///
/// makes `pub struct Stepper;` and its `Component` impl; the body is its
/// view, run once. Rust views make it as a primitive: `stepper()` (the
/// name in snake case, of the function's visibility) returns a
/// `StepperElement` with every prop at its default, a setter per prop and
/// a listener method per event (`stepper().max(10.0).on_change(..)`:
/// `ComponentBuilder`). Without a `Scope` parameter it emits no
/// events (`NoEvent`); without props it has none (`()`). The function's
/// doc comment documents the component in TypeScript (`Component::DOC`),
/// and a `#[module] impl` of the same name (its functions on the
/// component: `StatusBar.setHidden(..)`).
/// `#[component(methods = StepperApi)]` gives its ref in JS the methods of
/// that [`methods`] API, which the view registers with `cx.methods(..)`.
#[proc_macro_attribute]
pub fn component(attr: TokenStream, item: TokenStream) -> TokenStream {
    let mut methods = None;
    let parser = syn::meta::parser(|meta| {
        if meta.path.is_ident("methods") {
            methods = Some(meta.value()?.parse::<syn::Path>()?);
            Ok(())
        } else {
            Err(meta.error("`#[component]` takes `methods = Api`"))
        }
    });
    parse_macro_input!(attr with parser);
    let item = parse_macro_input!(item as ItemFn);
    component_fn(item, methods)
        .unwrap_or_else(syn::Error::into_compile_error)
        .into()
}

fn component_fn(item: ItemFn, methods: Option<syn::Path>) -> syn::Result<TokenStream2> {
    let ui = quote!(::nsh_core::element);
    let sig = &item.sig;
    if !sig.generics.params.is_empty() || sig.asyncness.is_some() {
        return Err(syn::Error::new(
            sig.span(),
            "a component is a plain function: no generics, not async",
        ));
    }
    let name = &sig.ident;
    let vis = &item.vis;
    let attrs = &item.attrs;
    let body = &item.block;
    let output = &sig.output;
    let mut props: Option<(Box<Pat>, Box<Type>)> = None;
    let mut scope: Option<(Box<Pat>, Box<Type>, Type)> = None;
    for input in &sig.inputs {
        let FnArg::Typed(arg) = input else {
            return Err(syn::Error::new(input.span(), "a component takes no `self`"));
        };
        match last_segment(&arg.ty) {
            Some((id, Some(event))) if id == "Scope" => {
                if scope.is_some() {
                    return Err(syn::Error::new(arg.span(), "one `Scope` parameter"));
                }
                scope = Some((arg.pat.clone(), arg.ty.clone(), event.clone()));
            }
            _ => {
                if props.is_some() {
                    return Err(syn::Error::new(
                        arg.span(),
                        "a component takes its props and its `Scope`",
                    ));
                }
                props = Some((arg.pat.clone(), arg.ty.clone()));
            }
        }
    }
    let (props_pat, props_ty) = match &props {
        Some((pat, ty)) => (quote!(#pat), quote!(#ty)),
        None => (quote!(_), quote!(())),
    };
    let (scope_pat, scope_ty, event) = match &scope {
        Some((pat, ty, event)) => (quote!(#pat), quote!(#ty), quote!(#event)),
        None => (
            quote!(_),
            quote!(#ui::Scope<#ui::NoEvent>),
            quote!(#ui::NoEvent),
        ),
    };
    let output = match output {
        ReturnType::Default => {
            return Err(syn::Error::new(
                sig.span(),
                "a component returns its view: `-> impl IntoElement`",
            ));
        }
        ReturnType::Type(_, ty) => quote!(#ty),
    };
    let methods =
        methods.map(|api| quote!(const METHODS: #ui::Methods = #ui::Methods::of::<#api>();));
    let doc = decl(&docs(attrs));
    // Its element, made like a primitive's: `button().disabled(..)`.
    let element = format_ident!("{}Element", name);
    let constructor = format_ident!("{}", snake(&name.to_string()));
    let element_doc = format!(
        " The element of [`{name}`], as [`{constructor}()`] makes it: a setter per prop \
         (`.disabled(..)`: a value, a signal or a closure), a listener method per event \
         (`.on_press(..)`), styles ([`Styled`]({ui_path}::Styled), the states' with \
         [`ComponentBuilder`]({ui_path}::ComponentBuilder)) and content \
         ([`ParentElement`]({ui_path}::ParentElement)).",
        ui_path = "::nsh_core::element",
    );
    let constructor_doc = format!(
        " A [`{name}`], each prop at its default: its element's setters set them \
         ([`{element}`])."
    );
    // The derives' macros, expanded on the element: a type's path as
    // written names its macro too.
    let bridge_of = |ty: &Type| -> Option<syn::Path> {
        let Type::Path(p) = ty else { return None };
        if p.qself.is_some() || p.path.segments.iter().any(|s| !s.arguments.is_empty()) {
            return None;
        }
        Some(p.path.clone())
    };
    let props_bridge = props
        .as_ref()
        .and_then(|(_, ty)| bridge_of(ty))
        .map(|path| quote!(#path! { [#vis] #element, #props_ty }));
    let event_bridge = scope
        .as_ref()
        .and_then(|(_, _, ty)| bridge_of(ty))
        .filter(|path| path.segments.last().is_some_and(|s| s.ident != "NoEvent"))
        .map(|path| quote!(#path! { [#vis] #element, #event }));
    Ok(quote! {
        #[doc = #element_doc]
        #[allow(dead_code)]
        #vis struct #element(#ui::ComponentElement<#name>);

        impl #ui::Element for #element {
            fn node(&mut self) -> &mut #ui::ElNode {
                #ui::Element::node(&mut self.0)
            }
        }

        impl #ui::ParentElement for #element {}

        impl #ui::IntoElement for #element {
            fn into_element(self) -> #ui::AnyElement {
                #ui::IntoElement::into_element(self.0)
            }
        }

        impl #ui::ComponentBuilder for #element {
            type Component = #name;

            fn __element(&mut self) -> &mut #ui::ComponentElement<#name> {
                &mut self.0
            }
        }

        #[doc = #constructor_doc]
        #[allow(dead_code)]
        #vis fn #constructor() -> #element {
            #element(#ui::ComponentElement::__new(<#props_ty as #ui::Props>::initial()))
        }

        #props_bridge
        #event_bridge

        #(#attrs)*
        #[derive(::core::fmt::Debug, ::core::default::Default, ::core::clone::Clone, ::core::marker::Copy)]
        #vis struct #name;

        // A `#[module] impl` of the component's name is documented by it.
        impl #ui::__private::ModuleDoc for #name {
            const DOC: &'static str = #doc;
        }

        impl #ui::Component for #name {
            type Props = #props_ty;
            type Event = #event;
            const DOC: &'static str = #doc;
            #methods

            #[allow(unused_variables)]
            fn view(#props_pat: #props_ty, #scope_pat: #scope_ty) -> #output #body
        }
    })
}

/// `#[native_module("gallery/native")]` on `fn native(registry: &mut
/// Registry)` at the root of an app's crate (`nsh.json` `"rust"`): the UI
/// set the app's TSX imports by that specifier. The function registers the
/// crate's components, modules and assets into the set's registry
/// (`Registry::ui_set("gallery/native")`), which the command line, hosts
/// and Android library nsh builds for the app serve:
///
/// ```ignore
/// #[native_module("gallery/native")]
/// fn native(registry: &mut Registry) {
///     registry.register::<Gallery>();
///     registry.assets(assets!());
/// }
/// ```
///
/// It also makes `pub fn registry() -> Registry` at the crate's root: the
/// set, for tests and other Rust code (`my_app_native::registry()`, next to
/// `nsh_base::registry()`), so the crate's root has no other item
/// named `registry`.
///
/// The specifier is checked at compile time: a bare import specifier
/// (`my-app/native`, `@acme/ui`), not a path, and not nsh's own (`nsh`,
/// `nsh/...`). A crate has one, at its root: it generates a hidden entry
/// of a fixed name the generated workspace calls, so a second one fails as
/// that name defined twice, one in a module as not at the root, and a
/// crate without one fails the generated workspace's build saying what to
/// add.
#[proc_macro_attribute]
pub fn native_module(attr: TokenStream, item: TokenStream) -> TokenStream {
    let specifier = match syn::parse::<LitStr>(attr) {
        Ok(lit) => lit,
        Err(_) => {
            return syn::Error::new(
                Span::call_site(),
                "`#[native_module]` takes the specifier the app imports the set by: `#[native_module(\"my-app/native\")]`",
            )
            .into_compile_error()
            .into();
        }
    };
    let item = parse_macro_input!(item as ItemFn);
    native_module::expand(specifier, item)
        .unwrap_or_else(syn::Error::into_compile_error)
        .into()
}

/// Internal to `nsh-core`: `name => [StyleKey, ...]` lines become a method
/// `name(length)` and one method per spacing step (`p_4()` is 16pt) of
/// the `Styled` trait.
#[proc_macro]
pub fn style_helpers(input: TokenStream) -> TokenStream {
    let helpers = parse_macro_input!(input with Punctuated::<Helper, Token![,]>::parse_terminated);
    let mut out = TokenStream2::new();
    for h in helpers {
        let Helper { doc, name, keys } = h;
        out.extend(quote! {
            #[doc = #doc]
            fn #name(mut self, length: impl crate::element::IntoReactive<crate::element::Length>) -> Self {
                self.style().bind_value(length, |s, length: crate::element::Length| {
                    s.lengths(&[#(crate::style::StyleKey::#keys),*], length);
                });
                self
            }
        });
        for (suffix, points) in STEPS {
            let method = format_ident!("{}_{}", name, suffix, span = Span::call_site());
            let step_doc = format!("{}: {points}pt.", doc.trim_end_matches('.'));
            out.extend(quote! {
                #[doc = #step_doc]
                fn #method(mut self) -> Self {
                    self.style().lengths(
                        &[#(crate::style::StyleKey::#keys),*],
                        crate::geometry::px(#points),
                    );
                    self
                }
            });
        }
    }
    out.into()
}

/// `#[methods]` on an `impl` block of a component's API (`Api`: a handle
/// its view makes, holding the signals the methods read and write): each
/// function with a visibility (`pub fn`, `pub(crate) fn`) becomes a method
/// of the component's ref in JS, named in camel case (`set_value` is
/// `setValue`), documented by its doc comment; a function without one is a
/// helper, Rust's only. A
/// function takes `&self`, then [`JsValue`] parameters, and returns
/// nothing or a [`JsValue`] (or a `Result` of one: an `Err` rejects with
/// its message), the call ordered with the props set before it. One
/// returning a value gives JS a `Promise` of it (`Promise<void>` for
/// `Result<(), E>`); one returning nothing gives `undefined` (`void`: JS
/// calls it and moves on, and a wrong argument throws). The view
/// registers the API with
/// `cx.methods(api)`, and the component names it in its spec with
/// `#[component(methods = StepperApi)]`.
#[proc_macro_attribute]
pub fn methods(attr: TokenStream, item: TokenStream) -> TokenStream {
    if !attr.is_empty() {
        return syn::Error::new(Span::call_site(), "`#[methods]` takes no arguments")
            .into_compile_error()
            .into();
    }
    let item = parse_macro_input!(item as ItemImpl);
    methods_impl(item)
        .unwrap_or_else(syn::Error::into_compile_error)
        .into()
}

fn methods_impl(mut item: ItemImpl) -> syn::Result<TokenStream2> {
    let ui = quote!(::nsh_core::element);
    let private = quote!(#ui::__private);
    let self_ty = item.self_ty.clone();
    let generics = item.generics.clone();
    let (impl_generics, _, where_clause) = generics.split_for_impl();
    let mut entries = Vec::new();
    for member in &item.items {
        let ImplItem::Fn(f) = member else { continue };
        if !exported(&f.vis) {
            continue;
        }
        let ident = &f.sig.ident;
        let js = camel(&ident.to_string());
        // The method's name: the host puts its component's before it (an
        // API may serve several components).
        let what = js.clone();
        let doc = decl(&docs(&f.attrs));
        let mut inputs = f.sig.inputs.iter();
        match inputs.next() {
            Some(FnArg::Receiver(r)) if r.reference.is_some() && r.mutability.is_none() => {}
            _ => {
                return Err(syn::Error::new(
                    f.sig.span(),
                    "a JS method takes `&self` (the API holds signals)",
                ));
            }
        }
        let mut params = Vec::new();
        let mut refs = Vec::new();
        let mut decode = Vec::new();
        let mut call_args = Vec::new();
        let typed: Vec<_> = inputs
            .map(|arg| match arg {
                FnArg::Typed(t) => Ok(t),
                FnArg::Receiver(r) => Err(syn::Error::new(r.span(), "one receiver")),
            })
            .collect::<syn::Result<_>>()?;
        // An `Option` parameter is optional in TypeScript when every one
        // after it is too (JS decodes a missing argument as `None`).
        let mut optional = vec![false; typed.len()];
        for i in (0..typed.len()).rev() {
            if !matches!(last_segment(&typed[i].ty), Some((id, _)) if id == "Option") {
                break;
            }
            optional[i] = true;
        }
        for (i, arg) in typed.iter().enumerate() {
            let ty = &arg.ty;
            let Pat::Ident(name) = &*arg.pat else {
                return Err(syn::Error::new(
                    arg.pat.span(),
                    "a JS method's parameters are named",
                ));
            };
            let name = camel(&name.ident.to_string());
            let local = format_ident!("__arg{}", i);
            let ts = param_ts(ty, &arg.attrs)?;
            let is_optional = optional[i];
            params.push(quote!((#name, #ts, #is_optional)));
            refs.push(quote!(#private::arg_classes::<#ty>(__out);));
            decode.push(quote! {
                let #local: #ty = #private::arg::<#ty>(host, #i, #what, #name)?;
            });
            call_args.push(quote!(#local));
        }
        let (returns, finish) = match &f.sig.output {
            ReturnType::Type(_, ty) if is_unit(ty) => (
                quote!(::core::option::Option::None),
                quote!(#private::boxed(__result)),
            ),
            ReturnType::Default => (
                quote!(::core::option::Option::None),
                quote!(#private::boxed(__result)),
            ),
            ReturnType::Type(_, ty) => match result_ok(ty) {
                Some(ok) => (
                    quote!(::core::option::Option::Some(#private::ret_ts::<#ok>())),
                    quote!(#private::boxed_result(__result)),
                ),
                None => (
                    quote!(::core::option::Option::Some(#private::ret_ts::<#ty>())),
                    quote!(#private::boxed(__result)),
                ),
            },
        };
        if let ReturnType::Type(_, ty) = &f.sig.output {
            let ty = result_ok(ty).unwrap_or(&**ty);
            refs.push(quote!(#private::ret_classes::<#ty>(__out);));
        }
        let cfgs = f.attrs.iter().filter(|a| a.path().is_ident("cfg"));
        entries.push(quote! {
            #(#cfgs)*
            #ui::Method {
                name: #js,
                doc: #doc,
                params: &[#(#params),*],
                returns: #returns,
                refs: |__out| {
                    let _ = &__out;
                    #(#refs)*
                },
                call: |host| {
                    let _ = host;
                    #(#decode)*
                    ::core::result::Result::Ok(::std::boxed::Box::new(move |api: &dyn ::core::any::Any| {
                        let this = api.downcast_ref::<Self>()?;
                        let __result = Self::#ident(this, #(#call_args),*);
                        ::core::option::Option::Some(#finish)
                    }))
                },
            }
        });
    }
    for member in &mut item.items {
        if let ImplItem::Fn(f) = member {
            strip_args(&mut f.sig);
        }
    }
    Ok(quote! {
        #item

        impl #impl_generics #ui::Api for #self_ty #where_clause {
            const METHODS: &'static [#ui::Method] = &[#(#entries),*];
        }
    })
}

/// `#[derive(JsObject)]` on a struct with named fields: a plain object in
/// JS (fields in camel case). A field is optional in TypeScript when it is
/// an `Option` or has `#[prop(default)]` / `#[prop(default = expr)]`;
/// missing, it takes its default. Doc comments document the fields.
/// `#[prop(exact)]` on the struct refuses an object with other own
/// enumerable keys (options where a typo must not pass unnoticed);
/// `#[prop(skip_none)]` on an `Option` field leaves it out of the object
/// when it is `None` (`"error" in exit` is false), instead of `null`.
#[proc_macro_derive(JsObject, attributes(prop))]
pub fn derive_js_object(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);
    js_object(input)
        .unwrap_or_else(syn::Error::into_compile_error)
        .into()
}

fn js_object(input: DeriveInput) -> syn::Result<TokenStream2> {
    let name = &input.ident;
    let Data::Struct(data) = &input.data else {
        return Err(syn::Error::new(
            input.span(),
            "`JsObject` is derived for structs",
        ));
    };
    let Fields::Named(fields) = &data.fields else {
        return Err(syn::Error::new(
            input.span(),
            "`JsObject` needs named fields",
        ));
    };
    let ui = quote!(::nsh_core::element);
    let mut exact = false;
    for attr in input.attrs.iter().filter(|a| a.path().is_ident("prop")) {
        attr.parse_nested_meta(|meta| {
            if meta.path.is_ident("exact") {
                exact = true;
                Ok(())
            } else {
                Err(meta.error("expected `exact` on a `JsObject` struct"))
            }
        })?;
    }
    let mut ts = Vec::new();
    let mut from_js = Vec::new();
    let mut to_js = Vec::new();
    let mut keys = Vec::new();
    for field in &fields.named {
        let ident = field.ident.as_ref().expect("named");
        let ty = &field.ty;
        let attr = prop_attr(&field.attrs)?;
        let js = attr
            .rename
            .clone()
            .unwrap_or_else(|| camel(&ident.to_string()));
        let doc = docs(&field.attrs);
        keys.push(js.clone());
        let is_option = matches!(last_segment(ty), Some((id, _)) if id == "Option");
        let optional = is_option || attr.default.is_some();
        let mark = if optional { "?" } else { "" };
        let doc_ts = if doc.is_empty() {
            String::new()
        } else {
            format!("/** {doc} */\n  ")
        };
        ts.push(quote!(
            ::std::format!("  {}{}{}: {};", #doc_ts, #js, #mark, <#ty as #ui::JsValue>::ts_type(types))
        ));
        let missing = match (&attr.default, is_option) {
            (Some(Some(expr)), _) => quote!(#expr),
            (Some(None), _) | (None, true) => quote!(::core::default::Default::default()),
            (None, false) => quote! {
                return ::core::result::Result::Err(#ui::PropError(::std::format!("`{}` is missing", #js)))
            },
        };
        from_js.push(quote! {
            #ident: {
                let v = value.field(#js)?;
                let v = v.get();
                if v.kind() != #ui::JsKind::Undefined && (#is_option || !v.is_nullish()) {
                    <#ty as #ui::JsValue>::from_js(v)
                        .map_err(|e| #ui::PropError(::std::format!("`{}`: {}", #js, e)))?
                } else {
                    #missing
                }
            }
        });
        if attr.skip_none && !is_option {
            return Err(syn::Error::new(
                field.span(),
                "`skip_none` is for an `Option` field",
            ));
        }
        to_js.push(if attr.skip_none {
            quote! {
                if let ::core::option::Option::Some(value) = &self.#ident {
                    host.set_field(object, #js, #ui::JsValue::to_js(value, host)?.into_raw())?;
                }
            }
        } else {
            quote! {
                host.set_field(object, #js, #ui::JsValue::to_js(&self.#ident, host)?.into_raw())?;
            }
        });
    }
    let check = exact.then(|| {
        quote! {
            for key in value.keys()? {
                if ![#(#keys),*].contains(&key.as_str()) {
                    return ::core::result::Result::Err(#ui::PropError(
                        ::std::format!("unknown field `{key}`"),
                    ));
                }
            }
        }
    });
    let (impl_generics, ty_generics, where_clause) = input.generics.split_for_impl();
    let type_name = name.to_string();
    let doc = docs(&input.attrs);
    let head = if doc.is_empty() {
        format!("export interface {type_name} {{")
    } else {
        format!("/** {doc} */\nexport interface {type_name} {{")
    };
    Ok(quote! {
        impl #impl_generics #ui::JsValue for #name #ty_generics #where_clause {
            fn ts_type(types: &mut #ui::TsTypes) -> ::std::string::String {
                types.declare(#type_name, |types| {
                    let fields: ::std::vec::Vec<::std::string::String> = ::std::vec![#(#ts),*];
                    ::std::format!("{}\n{}\n}}", #head, fields.join("\n"))
                })
            }

            fn from_js(value: #ui::JsIn<'_>) -> ::core::result::Result<Self, #ui::PropError> {
                if value.kind() != #ui::JsKind::Object {
                    return ::core::result::Result::Err(value.expected("an object"));
                }
                #check
                ::core::result::Result::Ok(Self { #(#from_js),* })
            }

            fn to_js<'a>(
                &self,
                host: &'a dyn #ui::JsHost,
            ) -> ::core::result::Result<#ui::JsOwned<'a>, #ui::PropError> {
                let owned = #ui::JsOwned::new(host, host.new_object()?);
                let object = owned.get().raw();
                #(#to_js)*
                ::core::result::Result::Ok(owned)
            }
        }
    })
}

/// Whether `ty` is `System`: the VM a call comes from, filled in by the
/// call rather than passed by JS.
fn system_param(ty: &Type) -> bool {
    matches!(last_segment(ty), Some((id, None)) if id == "System")
}

/// Whether `ty` is `CallCx`: what a synchronous call can do beyond
/// computing, filled in by the call.
fn call_cx_param(ty: &Type) -> bool {
    matches!(last_segment(ty), Some((id, None)) if id == "CallCx")
}

/// `Later<T>` -> `T`: work a synchronous call starts as a task.
fn later_of(ty: &Type) -> Option<&Type> {
    match last_segment(ty)? {
        (id, Some(t)) if id == "Later" => Some(t),
        _ => None,
    }
}

/// What a function that is not `async` returns: its JS result's type, and
/// whether it is a `Result` and a [`Later`]'s task.
fn sync_returns(output: &ReturnType) -> (Option<&Type>, bool, bool) {
    match output {
        ReturnType::Default => (None, false, false),
        ReturnType::Type(_, ty) => {
            let (ok, fallible) = match result_ok(ty) {
                Some(ok) => (ok, true),
                None => (&**ty, false),
            };
            match later_of(ok) {
                Some(t) => (Some(t), fallible, true),
                None => (Some(ok), fallible, false),
            }
        }
    }
}

/// Whether `ty` is `&mut ModuleCx`: a module function's context.
fn module_cx(ty: &Type) -> bool {
    matches!(ty, Type::Reference(r) if matches!(last_segment(&r.elem), Some((id, _)) if id == "ModuleCx"))
}

/// `#[module]` on an `impl` block of a unit struct: its functions with a
/// visibility (`pub fn`, `pub(crate) fn`; no receiver) become functions of
/// a JS object named after the struct
/// (`AlertDialog.show(...)`), documented by their doc comments. The struct
/// takes `#[module]` too, and its doc comment documents the object (a doc
/// comment on the block is an error: TS shows the struct's); a
/// component's struct (`#[component]`) needs none. The signature decides
/// how a call runs:
/// a function without a context runs in the JS call and returns its value
/// (`checksum(bytes)`), as a class's method does; one whose last parameter
/// is `cx: &mut ModuleCx` is an op, run in order with what JS set before it
/// (a dialog, the status bar, focus), a `Promise` when it returns a value
/// (`Promise<void>` for `Result<(), E>`: an `Err` rejects it) and
/// `undefined` (`void`) when it returns nothing (JS calls it and moves on,
/// and a wrong argument throws);
/// an `async fn` runs as a task of the core with the free functions views
/// use (`dialog(..)`, `clipboard_string()`, ...), a `Promise` (of `void`
/// too). Parameters
/// are [`JsValue`] types (a trailing `Option` is optional), instances
/// (`Instance<T>`) and JS functions (`Callback<A, R>`; `#[args(name,
/// amount)]` on the parameter names the function's arguments in TS); a
/// function returns
/// nothing, a [`JsValue`], an instance, or a `Result` of one (an `Err`
/// throws or rejects with its message). A UI set registers the module
/// (`Registry::module::<Alert>()`); a component exported under the same
/// name gets the functions too (`Chart.clear(...)` for a `Chart` component).
/// `#[module(flat)]` exports the functions one by one instead of as an
/// object. `#[module(flat, default)]` also exports that object as `default`.
/// `#[module(name = "test")]` names the object in JS (the type's name
/// otherwise); a module named like a function another flat module of the
/// set exports puts its functions on that function (`test.skip(...)`).
/// Visible associated constants of type `&'static str`, `bool`, or a primitive
/// numeric type are exported under their unchanged Rust names; their values
/// determine both the native representation and TypeScript primitive type.
#[proc_macro_attribute]
pub fn module(attr: TokenStream, item: TokenStream) -> TokenStream {
    let options = match module_options(attr.into()) {
        Ok(options) => options,
        Err(error) => return error.into_compile_error().into(),
    };
    let item = parse_macro_input!(item as syn::Item);
    match item {
        syn::Item::Struct(s) if options == ModuleOptions::default() => module_struct(s),
        syn::Item::Impl(i) => module_impl(i, options),
        syn::Item::Struct(s) => Err(syn::Error::new(
            s.ident.span(),
            "`flat`, `default` and `name` go on the `#[module(..)] impl` block; the struct takes `#[module]`",
        )),
        other => Err(syn::Error::new(
            other.span(),
            "`#[module]` goes on a unit struct and on its `impl` block",
        )),
    }
    .unwrap_or_else(syn::Error::into_compile_error)
    .into()
}

/// `#[module]` on the struct: its doc comment documents the module in TS.
fn module_struct(item: syn::ItemStruct) -> syn::Result<TokenStream2> {
    if !item.generics.params.is_empty() {
        return Err(syn::Error::new(
            item.generics.span(),
            "a module has no generic parameters",
        ));
    }
    let ui = quote!(::nsh_core::element);
    let name = &item.ident;
    let doc = decl(&docs(&item.attrs));
    Ok(quote! {
        #item

        impl #ui::__private::ModuleDoc for #name {
            const DOC: &'static str = #doc;
        }
    })
}

/// Refuses a doc comment on an export's `impl` block (`what`: `#[module]`):
/// TS shows the struct's, so one here would be lost.
fn no_block_doc(item: &ItemImpl, what: &str) -> syn::Result<()> {
    match item.attrs.iter().find(|a| a.path().is_ident("doc")) {
        Some(doc) => Err(syn::Error::new(
            doc.span(),
            format!(
                "document the export on its struct, not on the `{what} impl` block: the struct's \
                 doc comment is the one TS shows (a `//` comment here stays in Rust)"
            ),
        )),
        None => Ok(()),
    }
}

/// `#[class]` on a struct and on its `impl` block: a JS class (the
/// struct's name) whose objects hold the Rust value. The block's functions
/// with a visibility (`pub fn`, `pub(crate) fn`) are the class's members;
/// those without one are helpers, Rust's only. In the block, `new` is
/// the constructor (a class without one is made by its members only);
/// `&self` / `&mut self` functions are methods, `#[getter]` / `#[setter]`
/// ones (`count`, `set_count`) the property `count`; functions without a
/// receiver are statics. They run in the JS call: their parameters are
/// [`JsValue`] types (a trailing `Option` is optional), instances
/// (`&Other` / `&mut Other` borrowed for the call, `Instance<Other>` kept)
/// and JS functions (`Callback<A, R>`; `#[args(name, amount)]` on the
/// parameter names the function's arguments in TS);
/// they return nothing, a value, `Self` or another class's value (a new JS
/// object), an `Instance` (its JS object), or a `Result` of one (an `Err`
/// throws). An `async fn` (`this: Instance<Self>` first, for a method)
/// returns a promise and runs as a task of the core, with the free
/// functions (`dialog(..)`, `timer(..)`, ...); its parameters are owned
/// (`Instance<Other>`, not `&Other`). Doc comments document the class and
/// its members. On the struct, the fields whose types name `Callback` or
/// `Instance` report the callbacks they keep to JS's collector.
/// `#[class(interface)]` on the struct: its objects come from members
/// only, so the module exports no value of it and TypeScript declares an
/// `interface` (no constructor or statics).
#[proc_macro_attribute]
pub fn class(attr: TokenStream, item: TokenStream) -> TokenStream {
    let interface = match syn::parse::<Option<Ident>>(attr) {
        Ok(None) => false,
        Ok(Some(flag)) if flag == "interface" => true,
        _ => {
            return syn::Error::new(
                Span::call_site(),
                "`#[class]` takes nothing, or `interface` on the struct",
            )
            .into_compile_error()
            .into();
        }
    };
    let item = parse_macro_input!(item as syn::Item);
    class::class(item, interface)
        .unwrap_or_else(syn::Error::into_compile_error)
        .into()
}

/// `Result<T, E>` -> `T`.
/// Whether `ty` is `()`: a function written `-> ()` returns nothing, as
/// one without a return type does.
fn is_unit(ty: &Type) -> bool {
    matches!(ty, Type::Tuple(t) if t.elems.is_empty())
}

fn result_ok(ty: &Type) -> Option<&Type> {
    match last_segment(ty)? {
        (id, ok) if id == "Result" => ok,
        _ => None,
    }
}

/// What `#[module(..)]` says.
#[derive(Debug, Default, PartialEq)]
struct ModuleOptions {
    /// `flat`: the functions are exported one by one.
    flat: bool,
    /// `default`: the flat module's object is the default export too.
    default: bool,
    /// `name = "..."`: the object's JS name.
    name: Option<String>,
}

/// Parse flags without depending on attribute token spacing or ordering.
fn module_options(tokens: TokenStream2) -> syn::Result<ModuleOptions> {
    struct Options(ModuleOptions);
    impl Parse for Options {
        fn parse(input: syn::parse::ParseStream) -> syn::Result<Self> {
            use syn::ext::IdentExt;
            let mut options = ModuleOptions::default();
            while !input.is_empty() {
                let flag = input.call(Ident::parse_any)?;
                let duplicate = || syn::Error::new(flag.span(), "duplicate module flag");
                match flag.to_string().as_str() {
                    "flat" if options.flat => return Err(duplicate()),
                    "flat" => options.flat = true,
                    "default" if options.default => return Err(duplicate()),
                    "default" => options.default = true,
                    "name" if options.name.is_some() => return Err(duplicate()),
                    "name" => {
                        input.parse::<Token![=]>()?;
                        let name = input.parse::<LitStr>()?;
                        let value = name.value();
                        let mut chars = value.chars();
                        let identifier = chars
                            .next()
                            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$')
                            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$');
                        if !identifier {
                            return Err(syn::Error::new(
                                name.span(),
                                "a module's name is a JS identifier",
                            ));
                        }
                        options.name = Some(value);
                    }
                    _ => {
                        return Err(syn::Error::new(
                            flag.span(),
                            "`#[module]` accepts only `flat`, `default` and `name = \"...\"`",
                        ));
                    }
                }
                if !input.is_empty() {
                    input.parse::<Token![,]>()?;
                }
            }
            if options.default && !options.flat {
                return Err(syn::Error::new(
                    Span::call_site(),
                    "`default` requires `#[module(flat, default)]`",
                ));
            }
            if options.flat && options.name.is_some() {
                return Err(syn::Error::new(
                    Span::call_site(),
                    "a flat module exports no object to name",
                ));
            }
            Ok(Options(options))
        }
    }
    syn::parse2::<Options>(tokens).map(|options| options.0)
}

/// Primitive constants have a single runtime representation and TS type.
fn module_constant_variant(ty: &Type) -> syn::Result<&'static str> {
    if let Type::Reference(reference) = ty
        && reference.mutability.is_none()
        && matches!(&*reference.elem, Type::Path(path) if path.path.is_ident("str"))
        && reference
            .lifetime
            .as_ref()
            .is_none_or(|lifetime| lifetime.ident == "static")
    {
        return Ok("String");
    }
    if let Type::Path(path) = ty
        && path.qself.is_none()
        && let Some((name, _)) = last_segment(ty)
    {
        match name.to_string().as_str() {
            "bool" => return Ok("Bool"),
            "u8" | "u16" | "u32" | "u64" | "u128" | "usize" | "i8" | "i16" | "i32" | "i64"
            | "i128" | "isize" | "f32" | "f64" => return Ok("Number"),
            _ => {}
        }
    }
    Err(syn::Error::new(
        ty.span(),
        "module constants support only `&'static str`, `bool`, and primitive numeric types",
    ))
}

fn module_impl(mut item: ItemImpl, options: ModuleOptions) -> syn::Result<TokenStream2> {
    let ModuleOptions {
        flat,
        default,
        name,
    } = options;
    let ui = quote!(::nsh_core::element);
    let private = quote!(#ui::__private);
    let self_ty = &item.self_ty.clone();
    let Some((type_name, _)) = last_segment(self_ty) else {
        return Err(syn::Error::new(
            self_ty.span(),
            "`#[module]` is for a named type",
        ));
    };
    let module_name = name.unwrap_or_else(|| type_name.to_string());
    no_block_doc(&item, "#[module]")?;
    let mut entries = Vec::new();
    let mut constants = Vec::new();
    for member in &item.items {
        if let ImplItem::Const(constant) = member {
            if matches!(constant.vis, syn::Visibility::Inherited) {
                continue;
            }
            let ident = &constant.ident;
            let name = ident.to_string();
            let doc = decl(&docs(&constant.attrs));
            let variant = module_constant_variant(&constant.ty)?;
            let value = if variant == "Number" {
                quote!(#ui::ConstantValue::Number(#self_ty::#ident as f64))
            } else {
                let variant = Ident::new(variant, constant.ty.span());
                quote!(#ui::ConstantValue::#variant(#self_ty::#ident))
            };
            let cfgs = constant
                .attrs
                .iter()
                .filter(|attr| attr.path().is_ident("cfg"));
            constants.push(quote!(#(#cfgs)* #ui::Constant::new(#name, #doc, #value)));
            continue;
        }
        let ImplItem::Fn(f) = member else { continue };
        if !exported(&f.vis) {
            continue;
        }
        let ident = &f.sig.ident;
        let js = camel(&ident.to_string());
        let getter = f.attrs.iter().any(|a| a.path().is_ident("getter"));
        let what = if flat {
            js.clone()
        } else {
            format!("{module_name}.{js}")
        };
        let doc = decl(&docs(&f.attrs));
        let is_async = f.sig.asyncness.is_some();
        let typed: Vec<_> = f
            .sig
            .inputs
            .iter()
            .map(|arg| match arg {
                FnArg::Typed(t) => Ok(t),
                FnArg::Receiver(r) => Err(syn::Error::new(
                    r.span(),
                    "a module function has no receiver (its state is a global)",
                )),
            })
            .collect::<syn::Result<_>>()?;
        let takes_cx = typed.last().is_some_and(|t| module_cx(&t.ty));
        let mut params = Vec::new();
        let mut params_ts = Vec::new();
        let mut names = Vec::new();
        // Where each argument of the Rust call comes from: JS's argument
        // `Js(i)`, the call's `System` or its `CallCx`.
        enum Source {
            Js(usize),
            System,
            Cx,
        }
        let mut sources = Vec::new();
        for (i, arg) in typed.iter().enumerate() {
            let ty = &arg.ty;
            if system_param(ty) {
                sources.push(Source::System);
                continue;
            }
            if call_cx_param(ty) {
                if is_async || takes_cx {
                    return Err(syn::Error::new(
                        arg.span(),
                        "`CallCx` is a synchronous call's (it borrows the call); an `async` \
                         function starts no other task",
                    ));
                }
                sources.push(Source::Cx);
                continue;
            }
            if module_cx(ty) {
                if i + 1 != typed.len() || is_async {
                    return Err(syn::Error::new(
                        arg.span(),
                        "the last parameter of a function that is not `async`: `cx: &mut ModuleCx` \
                         (an `async fn` uses the free functions: `dialog(..)`, ...)",
                    ));
                }
                continue;
            }
            if let Type::Reference(_) = &**ty {
                return Err(syn::Error::new(
                    ty.span(),
                    "a module function takes values: an instance as `Instance<T>`",
                ));
            }
            let Pat::Ident(name) = &*arg.pat else {
                return Err(syn::Error::new(
                    arg.pat.span(),
                    "a module function's parameters are named",
                ));
            };
            names.push(camel(&name.ident.to_string()));
            sources.push(Source::Js(params.len()));
            params_ts.push(param_ts(ty, &arg.attrs)?);
            params.push(ty);
        }
        if getter
            && (is_async
                || takes_cx
                || !params.is_empty()
                || matches!(f.sig.output, ReturnType::Default))
        {
            return Err(syn::Error::new(
                f.sig.span(),
                "a module's getter takes no JS parameters, is not `async` and returns its value",
            ));
        }
        let (sync_ret, _, starts) = sync_returns(&f.sig.output);
        let starts = starts && !is_async && !takes_cx;
        // An `Option` parameter is optional when the ones after it are too.
        let mut optional = vec![false; params.len()];
        for i in (0..params.len()).rev() {
            if !matches!(last_segment(params[i]), Some((id, _)) if id == "Option") {
                break;
            }
            optional[i] = true;
        }
        let param_specs = params_ts
            .iter()
            .zip(&names)
            .zip(&optional)
            .map(|((ts, name), optional)| quote!((#name, #ts, #optional)));
        let (returns, fallible) = match &f.sig.output {
            ReturnType::Default => (quote!(::core::option::Option::None), false),
            ReturnType::Type(_, ty) if is_unit(ty) => (quote!(::core::option::Option::None), false),
            ReturnType::Type(_, ty) => match result_ok(ty) {
                Some(ok) => (
                    quote!(::core::option::Option::Some(#private::ret_ts::<#ok>())),
                    true,
                ),
                None => (
                    quote!(::core::option::Option::Some(#private::ret_ts::<#ty>())),
                    false,
                ),
            },
        };
        // A task's start resolves with the task's value.
        let returns = match (starts, sync_ret) {
            (true, Some(t)) => quote!(::core::option::Option::Some(#private::ret_ts::<#t>())),
            _ => returns,
        };
        // The classes the signature names, registered with the module.
        let ret_refs = match &f.sig.output {
            ReturnType::Default => None,
            ReturnType::Type(_, ty) => {
                let ty = match (starts, sync_ret) {
                    (true, Some(t)) => t,
                    _ => result_ok(ty).unwrap_or(&**ty),
                };
                Some(quote!(#private::ret_classes::<#ty>(__out);))
            }
        };
        let refs = params
            .iter()
            .map(|ty| quote!(#private::arg_classes::<#ty>(__out);))
            .chain(ret_refs);
        let locals: Vec<_> = (0..sources.len())
            .map(|i| format_ident!("__arg{}", i))
            .collect();
        // Every argument of the Rust call: JS's converted, the `System`
        // filled in.
        let decoded: Vec<_> = sources
            .iter()
            .zip(&locals)
            .map(|(source, local)| match source {
                Source::Js(i) => {
                    let (ty, name) = (params[*i], &names[*i]);
                    quote!(let #local: #ty = #private::arg::<#ty>(host, #i, #what, #name)?;)
                }
                Source::System => quote!(let #local = #private::system(host);),
                Source::Cx => quote!(let #local = #private::call_cx(host);),
            })
            .collect();
        let call = if starts {
            // In the JS call; the task it returns runs in the core.
            let finish = if fallible {
                quote!(#private::start_result(__result))
            } else {
                quote!(#private::start(__result))
            };
            quote! {
                #ui::FunctionCall::Start(|host| {
                    #(#decoded)*
                    let __result = #self_ty::#ident(#(#locals),*);
                    #finish
                })
            }
        } else if !is_async && !takes_cx {
            // In the JS call, converting the values directly.
            let decode = decoded.iter();
            let finish = if fallible {
                quote!(#private::ret_result(host, __result))
            } else {
                quote!(#private::ret(host, __result))
            };
            quote! {
                #ui::FunctionCall::Sync(|host| {
                    #(#decode)*
                    let __result = #self_ty::#ident(#(#locals),*);
                    #finish
                })
            }
        } else {
            // Converted in the JS call; the op carries them.
            let decode = decoded.iter();
            let finish = if fallible {
                quote!(#private::boxed_result(__result))
            } else {
                quote!(#private::boxed(__result))
            };
            if is_async {
                quote! {
                    #ui::FunctionCall::Async(|host| {
                        let _ = host;
                        #(#decode)*
                        ::core::result::Result::Ok(::std::boxed::Box::new(move || {
                            ::std::boxed::Box::pin(async move {
                                let __result = #self_ty::#ident(#(#locals),*).await;
                                #finish
                            })
                        }))
                    })
                }
            } else {
                quote! {
                    #ui::FunctionCall::Op(|host| {
                        let _ = host;
                        #(#decode)*
                        ::core::result::Result::Ok(::std::boxed::Box::new(move |cx| {
                            let __result = #self_ty::#ident(#(#locals,)* cx);
                            #finish
                        }))
                    })
                }
            }
        };
        let (overloads, overload_refs) = overloads(f)?;
        // `#[cfg]` of the function applies to its entry too.
        let cfgs = f.attrs.iter().filter(|a| a.path().is_ident("cfg"));
        entries.push(quote! {
            #(#cfgs)*
            #ui::Function {
                name: #js,
                doc: #doc,
                params: &[#(#param_specs),*],
                returns: #returns,
                refs: |__out| {
                    let _ = &__out;
                    #(#refs)*
                    #(#overload_refs)*
                },
                call: #call,
                getter: #getter,
                overloads: &[#(#overloads),*],
            }
        });
    }
    // `#[getter]`, `#[args]` and the overloads' attributes are the macro's.
    for member in &mut item.items {
        if let ImplItem::Fn(f) = member {
            strip_args(&mut f.sig);
            f.attrs
                .retain(|a| !a.path().is_ident("getter") && !a.path().is_ident("overload"));
        }
    }
    Ok(quote! {
        #item

        impl #ui::Module for #self_ty {
            const NAME: &'static str = #module_name;
            const DOC: &'static str = <Self as #ui::__private::ModuleDoc>::DOC;
            const FUNCTIONS: &'static [#ui::Function] = &[#(#entries),*];
            const FLAT: bool = #flat;
            const DEFAULT: bool = #default;
            const CONSTANTS: &'static [#ui::Constant] = &[#(#constants),*];
        }
    })
}

/// The `#[overload(fn(path: String, encoding: Encoding) -> String)]`
/// signatures of module function `f`, and the classes they name: Rust
/// types whose TypeScript types make the declaration (a trailing `Option`
/// is optional; the result is a promise when the function's is).
fn overloads(f: &ImplItemFn) -> syn::Result<(Vec<TokenStream2>, Vec<TokenStream2>)> {
    let private = quote!(::nsh_core::element::__private);
    let mut overloads = Vec::new();
    let mut refs = Vec::new();
    for attr in f.attrs.iter().filter(|a| a.path().is_ident("overload")) {
        let sig: syn::TypeBareFn = attr.parse_args()?;
        let mut params = Vec::new();
        for arg in &sig.inputs {
            let Some((name, _)) = &arg.name else {
                return Err(syn::Error::new(
                    arg.span(),
                    "an overload's parameters are named: `fn(path: String)`",
                ));
            };
            params.push((
                camel(&name.to_string()),
                &arg.ty,
                param_ts(&arg.ty, &arg.attrs)?,
            ));
        }
        let mut optional = vec![false; params.len()];
        for i in (0..params.len()).rev() {
            if !matches!(last_segment(params[i].1), Some((id, _)) if id == "Option") {
                break;
            }
            optional[i] = true;
        }
        let specs = params
            .iter()
            .zip(&optional)
            .map(|((name, _, ts), optional)| quote!((#name, #ts, #optional)));
        refs.extend(
            params
                .iter()
                .map(|(_, ty, _)| quote!(#private::arg_classes::<#ty>(__out);)),
        );
        let returns = match &sig.output {
            ReturnType::Default => quote!(::core::option::Option::None),
            ReturnType::Type(_, ty) => {
                refs.push(quote!(#private::ret_classes::<#ty>(__out);));
                quote!(::core::option::Option::Some(#private::ret_ts::<#ty>()))
            }
        };
        overloads.push(quote! {
            ::nsh_core::element::Overload { params: &[#(#specs),*], returns: #returns }
        });
    }
    Ok((overloads, refs))
}

#[cfg(test)]
mod module_tests {
    use super::*;

    #[test]
    fn module_flags_accept_order_whitespace_and_trailing_comma() {
        let options = |flat, default, name: Option<&str>| ModuleOptions {
            flat,
            default,
            name: name.map(str::to_owned),
        };
        assert_eq!(
            module_options(quote!()).unwrap(),
            options(false, false, None)
        );
        assert_eq!(
            module_options(quote!(flat)).unwrap(),
            options(true, false, None)
        );
        assert_eq!(
            module_options(quote!(flat, default,)).unwrap(),
            options(true, true, None)
        );
        assert_eq!(
            module_options(quote!(default, flat)).unwrap(),
            options(true, true, None)
        );
        assert_eq!(
            module_options(quote!(name = "test")).unwrap(),
            options(false, false, Some("test"))
        );
        for flags in [
            quote!(default),
            quote!(flat, flat),
            quote!(flat, unknown),
            quote!(flat default),
            quote!(name = "a-b"),
            quote!(name = ""),
            quote!(flat, name = "test"),
            quote!(name = "a", name = "b"),
        ] {
            assert!(module_options(flags.clone()).is_err(), "{flags}");
        }
    }

    #[test]
    fn primitive_constant_types_have_explicit_unsupported_type_diagnostics() {
        for (ty, expected) in [
            (quote!(&'static str), "String"),
            (quote!(&str), "String"),
            (quote!(bool), "Bool"),
            (quote!(i32), "Number"),
            (quote!(f64), "Number"),
        ] {
            assert_eq!(
                module_constant_variant(&syn::parse2(ty).unwrap()).unwrap(),
                expected
            );
        }
        for ty in [
            quote!(String),
            quote!([u8; 2]),
            quote!(Option<bool>),
            quote!(&mut str),
        ] {
            let error = module_constant_variant(&syn::parse2(ty).unwrap()).unwrap_err();
            assert!(error.to_string().contains("module constants support only"));
        }
    }

    #[test]
    fn constants_keep_associated_expressions_names_and_cfgs() {
        let item = syn::parse_quote! {
            impl Metadata {
                /// Native line ending.
                pub const EOL: &'static str = if cfg!(windows) { "\r\n" } else { "\n" };
                pub const LIMIT: usize = 3;
                #[cfg(any())]
                pub const DISABLED: bool = false;
                const PRIVATE: [u8; 2] = [1, 2];
            }
        };
        let expanded = module_impl(
            item,
            ModuleOptions {
                flat: true,
                default: true,
                name: None,
            },
        )
        .unwrap()
        .to_string();
        assert!(expanded.contains("ConstantValue :: String (Metadata :: EOL)"));
        assert!(expanded.contains("ConstantValue :: Number (Metadata :: LIMIT as f64)"));
        assert!(expanded.contains("ConstantValue :: Bool (Metadata :: DISABLED)"));
        assert!(expanded.contains("const DEFAULT : bool = true"));
        assert!(!expanded.contains("Constant :: new (\"PRIVATE\""));
        let unsupported =
            syn::parse_quote! { impl Metadata { pub const BYTES: [u8; 2] = [1, 2]; } };
        assert!(
            module_impl(
                unsupported,
                ModuleOptions {
                    flat: true,
                    ..ModuleOptions::default()
                },
            )
            .unwrap_err()
            .to_string()
            .contains("module constants support only")
        );
    }
}

#[cfg(test)]
mod tests {
    /// The TS doc of a doc comment of `lines`.
    fn ts(lines: &[&str]) -> String {
        let attrs: Vec<syn::Attribute> = lines
            .iter()
            .map(|l| syn::parse_quote!(#[doc = #l]))
            .collect();
        super::docs(&attrs)
    }

    #[test]
    fn sections_under_a_heading_stay_rusts() {
        assert_eq!(
            ts(&[
                " Copies `text`; resolves with its length.",
                "",
                " # Rust",
                "",
                " Taking `cx` makes it an op.",
            ]),
            "Copies `text`; resolves with its length."
        );
        assert_eq!(
            ts(&[" Sorts [`Item`]s.", " ## Panics", " Never."]),
            "Sorts `Item`s."
        );
        // Not headings: a `#` in a code block, an attribute, a `#` word.
        assert_eq!(
            ts(&[
                " A list:",
                " ```",
                " # use x;",
                " ```",
                " #[ignore] and #1."
            ]),
            "A list: ``` # use x; ``` #[ignore] and #1."
        );
    }
}
