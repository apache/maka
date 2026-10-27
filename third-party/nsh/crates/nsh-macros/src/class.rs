//! `#[class]`: a Rust type TypeScript uses as a class. On the struct it
//! reports the callbacks the fields keep (`Trace`) and makes the struct a
//! result (a new instance); on the `impl` block it makes the class's
//! members (`Class`).

use proc_macro2::TokenStream as TokenStream2;
use quote::{format_ident, quote};
use syn::{
    Attribute, FnArg, ImplItem, ImplItemFn, ItemImpl, ItemStruct, Pat, ReturnType, Type,
    spanned::Spanned,
};

use crate::{
    call_cx_param, camel, decl, docs, exported, last_segment, module_cx, param_ts, result_ok,
    strip_args, sync_returns, system_param,
};

pub(crate) fn class(item: syn::Item, interface: bool) -> syn::Result<TokenStream2> {
    match item {
        syn::Item::Struct(s) => class_struct(s, interface),
        syn::Item::Impl(i) if interface => Err(syn::Error::new(
            i.span(),
            "`interface` goes on the class's struct",
        )),
        syn::Item::Impl(i) => class_impl(i),
        other => Err(syn::Error::new(
            other.span(),
            "`#[class]` goes on a struct and on its `impl` block",
        )),
    }
}

fn class_struct(item: ItemStruct, interface: bool) -> syn::Result<TokenStream2> {
    if !item.generics.params.is_empty() {
        return Err(syn::Error::new(
            item.generics.span(),
            "a class has no generic parameters",
        ));
    }
    let ui = quote!(::nsh_core::element);
    let name = &item.ident;
    let doc = decl(&docs(&item.attrs));
    // Every field, traced when its type implements `Trace` (by its type,
    // not its name: aliases and wrappers that implement it are traced,
    // other types skipped), under the field's own `#[cfg]`.
    let fields: Vec<&syn::Field> = item.fields.iter().collect();
    let traced: Vec<TokenStream2> = fields
        .iter()
        .enumerate()
        .map(|(i, f)| {
            let member = match &f.ident {
                Some(ident) => quote!(#ident),
                None => {
                    let index = syn::Index::from(i);
                    quote!(#index)
                }
            };
            let cfgs = f.attrs.iter().filter(|a| a.path().is_ident("cfg"));
            quote!(#(#cfgs)* (&&#ui::__private::Field(&self.#member)).trace_field(tracer);)
        })
        .collect();
    // A field may be configured out: the tracer is used either way.
    let tracer = if traced.is_empty() {
        quote!(_tracer)
    } else {
        quote!(tracer)
    };
    Ok(quote! {
        #item

        // SAFETY: each field is reported through its own type's `Trace`,
        // once.
        unsafe impl #ui::Trace for #name {
            // Unused when every traced field is configured out.
            #[allow(unused_variables)]
            fn trace(&self, #tracer: &mut #ui::Tracer<'_>) {
                #[allow(unused_imports)]
                use #ui::__private::{SkipField as _, TraceField as _};
                #(#traced)*
            }
        }

        impl #ui::__private::ClassDoc for #name {
            const DOC: &'static str = #doc;
            const INTERFACE: bool = #interface;
        }

        /// A new instance (a new JS object).
        impl #ui::Ret for #name {
            fn ts_type(types: &mut #ui::TsTypes) -> ::std::string::String {
                #ui::__private::class_ts::<Self>(types)
            }

            fn into_js<'a>(
                self,
                host: &'a dyn #ui::JsHost,
            ) -> ::core::result::Result<#ui::JsOwned<'a>, #ui::PropError> {
                #ui::__private::class_into_js(self, host)
            }

            fn classes(out: &mut ::std::vec::Vec<&'static #ui::ClassDef>) {
                #ui::__private::class_refs::<Self>(out);
            }
        }
    })
}

/// Whether `attrs` has `#[name]`.
fn has_attr(attrs: &[Attribute], name: &str) -> bool {
    attrs.iter().any(|a| a.path().is_ident(name))
}

/// What a function of the block is.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Constructor,
    Method {
        mutable: bool,
    },
    Getter,
    Setter {
        mutable: bool,
    },
    Static,
    AsyncMethod,
    AsyncStatic,
    /// Not `async`, taking `this: Instance<Self>`: the handle, not a
    /// borrow (a method returning its own object, `child.on(..)`).
    ThisMethod,
}

/// The `&self` / `&mut self` receiver of `f`: `Some(mutable)`.
fn receiver(f: &ImplItemFn) -> syn::Result<Option<bool>> {
    match f.sig.inputs.first() {
        Some(FnArg::Receiver(r)) => {
            if r.reference.is_none() {
                return Err(syn::Error::new(
                    r.span(),
                    "a class's method takes `&self` or `&mut self` (the JS object owns the value)",
                ));
            }
            Ok(Some(r.mutability.is_some()))
        }
        _ => Ok(None),
    }
}

/// Whether `pat: ty` is `this: Instance<..>` (an `async` method's).
fn is_this(arg: &FnArg) -> bool {
    let FnArg::Typed(t) = arg else { return false };
    let named_this = matches!(&*t.pat, Pat::Ident(p) if p.ident == "this");
    named_this && matches!(last_segment(&t.ty), Some((id, _)) if id == "Instance")
}

fn kind_of(f: &ImplItemFn) -> syn::Result<Kind> {
    let getter = has_attr(&f.attrs, "getter");
    let setter = has_attr(&f.attrs, "setter");
    let receiver = receiver(f)?;
    if f.sig.asyncness.is_some() {
        if receiver.is_some() {
            return Err(syn::Error::new(
                f.sig.span(),
                "an `async` method takes `this: Instance<Self>` (a handle: borrow the value \
                 between awaits with `this.with(..)` / `this.with_mut(..)`)",
            ));
        }
        if getter || setter {
            return Err(syn::Error::new(
                f.sig.span(),
                "getters and setters are not `async`",
            ));
        }
        return Ok(match f.sig.inputs.first() {
            Some(arg) if is_this(arg) => Kind::AsyncMethod,
            _ => Kind::AsyncStatic,
        });
    }
    if getter || setter {
        let Some(mutable) = receiver else {
            return Err(syn::Error::new(
                f.sig.span(),
                "a getter or setter takes `&self` (a setter may take `&mut self`)",
            ));
        };
        let params = f.sig.inputs.len() - 1;
        return if getter {
            if params != 0 || matches!(f.sig.output, ReturnType::Default) {
                Err(syn::Error::new(
                    f.sig.span(),
                    "a getter takes only `&self` and returns its value",
                ))
            } else {
                Ok(Kind::Getter)
            }
        } else if params != 1 || !f.sig.ident.to_string().starts_with("set_") {
            Err(syn::Error::new(
                f.sig.span(),
                "a setter is `set_<name>(&mut self, value: T)` (the property `<name>`)",
            ))
        } else {
            Ok(Kind::Setter { mutable })
        };
    }
    Ok(match receiver {
        Some(mutable) => Kind::Method { mutable },
        None if f.sig.ident == "new" => Kind::Constructor,
        None if f.sig.inputs.first().is_some_and(is_this) => Kind::ThisMethod,
        None => Kind::Static,
    })
}

/// A parameter: how the generated code gets it.
enum Param<'a> {
    /// An `Arg`.
    Value(&'a Type),
    /// `&Other` / `&mut Other`: an instance borrowed for the call.
    Borrowed { elem: &'a Type, mutable: bool },
    /// `System`: the VM the call comes from, not one JS passes.
    System,
    /// `CallCx`: what a synchronous call can do beyond computing.
    Cx,
}

fn class_impl(mut item: ItemImpl) -> syn::Result<TokenStream2> {
    let ui = quote!(::nsh_core::element);
    if !item.generics.params.is_empty() || item.trait_.is_some() {
        return Err(syn::Error::new(
            item.span(),
            "`#[class]` goes on the class's own `impl` block, without generics",
        ));
    }
    let self_ty = item.self_ty.clone();
    let Some((type_name, _)) = last_segment(&self_ty) else {
        return Err(syn::Error::new(
            self_ty.span(),
            "`#[class]` is for a named type",
        ));
    };
    let class_name = type_name.to_string();
    crate::no_block_doc(&item, "#[class]")?;
    let mut members = Vec::new();
    // Whether JS would need the class's value: an interface has none.
    let mut needs_value = false;
    for member in &item.items {
        let ImplItem::Fn(f) = member else { continue };
        if !exported(&f.vis) {
            // A helper: Rust's only. A getter or setter is TS's, so one
            // without a visibility is a mistake, not a helper.
            if let Some(attr) = f
                .attrs
                .iter()
                .find(|a| a.path().is_ident("getter") || a.path().is_ident("setter"))
            {
                return Err(syn::Error::new(
                    attr.span(),
                    "a getter or setter is exported: make it `pub fn` (functions without a \
                     visibility are the block's helpers, Rust's only)",
                ));
            }
            continue;
        }
        needs_value |= matches!(
            kind_of(f)?,
            Kind::Constructor | Kind::Static | Kind::AsyncStatic
        );
        members.push(member_def(f, &class_name)?);
    }
    // The getters', setters' and callbacks' attributes are the macro's.
    for member in &mut item.items {
        if let ImplItem::Fn(f) = member {
            f.attrs.retain(|a| {
                !a.path().is_ident("getter")
                    && !a.path().is_ident("setter")
                    && !a.path().is_ident("overload")
            });
            strip_args(&mut f.sig);
        }
    }
    Ok(quote! {
        #item

        impl #ui::Class for #self_ty {
            const DEF: &'static #ui::ClassDef = &#ui::ClassDef {
                name: #class_name,
                doc: <Self as #ui::__private::ClassDoc>::DOC,
                type_id: #ui::__private::type_id::<Self>,
                type_name: #ui::__private::type_name::<Self>,
                members: &[#(#members),*],
                interface: <Self as #ui::__private::ClassDoc>::INTERFACE,
            };
        }

        const _: () = ::core::assert!(
            !(<#self_ty as #ui::__private::ClassDoc>::INTERFACE && #needs_value),
            "a `#[class(interface)]` has no constructor or statics: JS has no value of it",
        );
    })
}

fn member_def(f: &ImplItemFn, class: &str) -> syn::Result<TokenStream2> {
    let ui = quote!(::nsh_core::element);
    let private = quote!(#ui::__private);
    let kind = kind_of(f)?;
    let ident = &f.sig.ident;
    let rust_name = ident.to_string();
    let js = match kind {
        Kind::Setter { .. } => camel(rust_name.trim_start_matches("set_")),
        _ => camel(&rust_name),
    };
    let what = match kind {
        Kind::Constructor => format!("new {class}"),
        _ => format!("{class}.{js}"),
    };
    // Names the class's object has already, or must keep.
    let reserved = match kind {
        Kind::Constructor => None,
        Kind::Static | Kind::AsyncStatic
            if matches!(js.as_str(), "prototype" | "name" | "length") =>
        {
            Some(
                "a static named `prototype`, `name` or `length` would replace the constructor's own property",
            )
        }
        _ if js == "dispose" => Some("`dispose` is every class's own (it frees the Rust value)"),
        _ if js == "constructor" => Some("`constructor` is the prototype's own (the class)"),
        _ => None,
    };
    if let Some(why) = reserved {
        return Err(syn::Error::new(
            ident.span(),
            format!("rename `{rust_name}`: {why}"),
        ));
    }
    let doc = decl(&docs(&f.attrs));
    // `#[overload(fn(event: Exit, handler: Callback<ExitResult>) -> Instance<Self>)]`:
    // signatures declared instead, as a module function's.
    let (overloads, overload_refs) = crate::overloads(f)?;
    // `#[cfg]` of the function applies to its entry too.
    let cfgs: Vec<_> = f
        .attrs
        .iter()
        .filter(|a| a.path().is_ident("cfg"))
        .collect();
    // The parameters JS passes (not the receiver nor `this`).
    let skip = match kind {
        Kind::Method { .. }
        | Kind::Getter
        | Kind::Setter { .. }
        | Kind::AsyncMethod
        | Kind::ThisMethod => 1,
        _ => 0,
    };
    let is_async = matches!(kind, Kind::AsyncMethod | Kind::AsyncStatic);
    let mut params = Vec::new();
    let mut names = Vec::new();
    // Each parameter's attributes (`#[args(..)]`).
    let mut attrs = Vec::new();
    for arg in f.sig.inputs.iter().skip(skip) {
        let FnArg::Typed(t) = arg else {
            return Err(syn::Error::new(arg.span(), "one receiver"));
        };
        if module_cx(&t.ty) {
            return Err(syn::Error::new(
                t.span(),
                "a class's member takes no `ModuleCx` (a synchronous member computes; an `async` \
                 one uses the free functions: `dialog(..)`, ...)",
            ));
        }
        let Pat::Ident(name) = &*t.pat else {
            return Err(syn::Error::new(
                t.pat.span(),
                "a class member's parameters are named",
            ));
        };
        names.push(camel(&name.ident.to_string()));
        if system_param(&t.ty) {
            attrs.push(&t.attrs);
            params.push(Param::System);
            continue;
        }
        if call_cx_param(&t.ty) {
            if is_async {
                return Err(syn::Error::new(
                    t.span(),
                    "`CallCx` is a synchronous call's (it borrows the call)",
                ));
            }
            attrs.push(&t.attrs);
            params.push(Param::Cx);
            continue;
        }
        attrs.push(&t.attrs);
        params.push(match &*t.ty {
            Type::Reference(_) if is_async => {
                return Err(syn::Error::new(
                    t.ty.span(),
                    "an `async` member keeps its arguments: take `Instance<T>`, not a reference",
                ));
            }
            Type::Reference(r) => Param::Borrowed {
                elem: &r.elem,
                mutable: r.mutability.is_some(),
            },
            ty => Param::Value(ty),
        });
    }
    // An `Option` parameter is optional when the ones after it are too (a
    // setter's value never is: TypeScript requires it).
    let mut optional = vec![false; params.len()];
    for i in (0..params.len()).rev() {
        if matches!(kind, Kind::Setter { .. }) {
            break;
        }
        if matches!(params[i], Param::System | Param::Cx) {
            continue;
        }
        let is_option = matches!(&params[i], Param::Value(ty) if matches!(last_segment(ty), Some((id, _)) if id == "Option"));
        if !is_option {
            break;
        }
        optional[i] = true;
    }
    let param_specs: Vec<TokenStream2> = params
        .iter()
        .zip(&names)
        .zip(&optional)
        .zip(&attrs)
        .filter_map(|(((p, name), optional), attrs)| {
            let ts = match p {
                Param::Value(ty) => param_ts(ty, attrs),
                Param::Borrowed { elem, .. } => {
                    param_ts(&syn::parse_quote!(#ui::Instance<#elem>), attrs)
                }
                Param::System | Param::Cx => return None,
            };
            Some(ts.map(|ts| quote!((#name, #ts, #optional))))
        })
        .collect::<syn::Result<_>>()?;
    // The classes the signature names, registered with this one.
    let mut refs: Vec<TokenStream2> = params
        .iter()
        .filter_map(|p| match p {
            Param::Value(ty) => Some(quote!(#private::arg_classes::<#ty>(__out);)),
            Param::Borrowed { elem, .. } => {
                Some(quote!(#private::arg_classes::<#ui::Instance<#elem>>(__out);))
            }
            Param::System | Param::Cx => None,
        })
        .collect();
    // A method or static returning `Later<T>` starts a task in the call.
    let starts = matches!(kind, Kind::Method { .. } | Kind::Static | Kind::ThisMethod)
        && sync_returns(&f.sig.output).2;
    let (returns, ok_ty, fallible) = match &f.sig.output {
        ReturnType::Type(_, _) if starts => {
            let (task, fallible, _) = sync_returns(&f.sig.output);
            let task = task.expect("a type");
            (
                quote!(::core::option::Option::Some(#private::ret_ts::<#task>())),
                Some(task.clone()),
                fallible,
            )
        }
        ReturnType::Default => (quote!(::core::option::Option::None), None, false),
        ReturnType::Type(_, ty) => match result_ok(ty) {
            Some(ok) => (
                quote!(::core::option::Option::Some(#private::ret_ts::<#ok>())),
                Some(ok.clone()),
                true,
            ),
            None => (
                quote!(::core::option::Option::Some(#private::ret_ts::<#ty>())),
                Some((**ty).clone()),
                false,
            ),
        },
    };
    let member_kind = match kind {
        Kind::Constructor => quote!(Constructor),
        Kind::Method { .. } | Kind::AsyncMethod | Kind::ThisMethod => quote!(Method),
        Kind::Getter => quote!(Getter),
        Kind::Setter { .. } => quote!(Setter),
        Kind::Static | Kind::AsyncStatic => quote!(Static),
    };
    if let Some(ty) = &ok_ty {
        refs.push(quote!(#private::ret_classes::<#ty>(__out);));
    }
    if kind == Kind::Constructor {
        let ok_is_self = matches!(&ok_ty, Some(ty) if matches!(last_segment(ty), Some((id, _)) if id == "Self" || id == class));
        if !ok_is_self {
            return Err(syn::Error::new(
                f.sig.span(),
                "the constructor `new` returns `Self` (or `Result<Self, E>`)",
            ));
        }
    }
    let call = if is_async {
        async_call(f, kind, &params, &names, &what, fallible)
    } else {
        sync_call(f, kind, &params, &names, &what, fallible, starts)
    };
    Ok(quote! {
        #(#cfgs)*
        #ui::Member {
            name: #js,
            doc: #doc,
            kind: #ui::MemberKind::#member_kind,
            params: &[#(#param_specs),*],
            returns: #returns,
            refs: |__out| {
                let _ = &__out;
                #(#refs)*
                #(#overload_refs)*
            },
            call: #call,
            overloads: &[#(#overloads),*],
        }
    })
}

fn sync_call(
    f: &ImplItemFn,
    kind: Kind,
    params: &[Param<'_>],
    names: &[String],
    what: &str,
    fallible: bool,
    starts: bool,
) -> TokenStream2 {
    let ui = quote!(::nsh_core::element);
    let private = quote!(#ui::__private);
    let ident = &f.sig.ident;
    let mut decode = Vec::new();
    let mut borrow = Vec::new();
    let mut release = Vec::new();
    let mut args = Vec::new();
    // JS's arguments, counted without the `System`.
    let mut js = 0usize;
    for (p, name) in params.iter().zip(names) {
        let local = format_ident!("__arg{}", args.len());
        let i = js;
        if !matches!(p, Param::System | Param::Cx) {
            js += 1;
        }
        match p {
            Param::System => {
                decode.push(quote!(let #local = #private::system(host);));
                args.push(quote!(#local));
            }
            Param::Cx => {
                decode.push(quote!(let #local = #private::call_cx(host);));
                args.push(quote!(#local));
            }
            Param::Value(ty) => {
                decode.push(quote! {
                    let #local: #ty = #private::arg::<#ty>(host, #i, #what, #name)?;
                });
                args.push(quote!(#local));
            }
            Param::Borrowed { elem, mutable } => {
                let held = format_ident!("__held{}", i);
                decode.push(quote! {
                    let #held: #ui::Instance<#elem> =
                        #private::arg::<#ui::Instance<#elem>>(host, #i, #what, #name)?;
                });
                // A disposed or busy instance's error names the argument.
                if *mutable {
                    borrow.push(quote!(
                        let mut #local = #private::borrow_arg_mut::<#elem>(&#held, #what, #name)?;
                    ));
                    args.push(quote!(&mut *#local));
                } else {
                    borrow.push(quote!(
                        let #local = #private::borrow_arg::<#elem>(&#held, #what, #name)?;
                    ));
                    args.push(quote!(&*#local));
                }
                release.push(quote!(::core::mem::drop(#local);));
            }
        }
    }
    let (this, receiver) = match kind {
        Kind::Method { mutable } | Kind::Setter { mutable } => {
            let borrow_fn = if mutable {
                quote!(borrow_mut)
            } else {
                quote!(borrow)
            };
            let by = if mutable {
                quote!(&mut *__value)
            } else {
                quote!(&*__value)
            };
            (
                quote! {
                    let __this = #private::this::<Self>(host, #what)?;
                    #[allow(unused_mut)]
                    let mut __value = #private::#borrow_fn::<Self>(&__this)?;
                },
                Some(by),
            )
        }
        Kind::Getter => (
            quote! {
                let __this = #private::this::<Self>(host, #what)?;
                let __value = #private::borrow::<Self>(&__this)?;
            },
            Some(quote!(&*__value)),
        ),
        Kind::ThisMethod => (
            quote!(let __this = #private::this::<Self>(host, #what)?;),
            Some(quote!(__this)),
        ),
        _ => (quote!(), None),
    };
    let call_args = receiver.into_iter().chain(args);
    let finish = match (kind, fallible) {
        _ if starts && fallible => quote!(#private::start_result(__result)),
        _ if starts => quote!(#private::start(__result)),
        (Kind::Constructor, false) => quote!(#private::construct(host, __result)),
        (Kind::Constructor, true) => quote!(#private::construct_result(host, __result)),
        (_, false) => quote!(#private::ret(host, __result)),
        (_, true) => quote!(#private::ret_result(host, __result)),
    };
    // The borrows end before the result reaches JS (making its object may
    // run the collector, which reads the instance).
    if matches!(
        kind,
        Kind::Method { .. } | Kind::Setter { .. } | Kind::Getter
    ) {
        release.push(quote!(::core::mem::drop(__value);));
    }
    let variant = if starts { quote!(Start) } else { quote!(Sync) };
    quote! {
        #ui::MemberCall::#variant(|host| {
            #(#decode)*
            #this
            #(#borrow)*
            let __result = Self::#ident(#(#call_args),*);
            #(#release)*
            #finish
        })
    }
}

fn async_call(
    f: &ImplItemFn,
    kind: Kind,
    params: &[Param<'_>],
    names: &[String],
    what: &str,
    fallible: bool,
) -> TokenStream2 {
    let ui = quote!(::nsh_core::element);
    let private = quote!(#ui::__private);
    let ident = &f.sig.ident;
    let mut decode = Vec::new();
    let mut args = Vec::new();
    let mut js = 0usize;
    for (p, name) in params.iter().zip(names) {
        let local = format_ident!("__arg{}", args.len());
        match p {
            Param::Value(ty) => {
                let i = js;
                js += 1;
                decode.push(quote! {
                    let #local: #ty = #private::arg::<#ty>(host, #i, #what, #name)?;
                });
                args.push(quote!(#local));
            }
            Param::System => {
                decode.push(quote!(let #local = #private::system(host);));
                args.push(quote!(#local));
            }
            Param::Cx => {}
            Param::Borrowed { .. } => js += 1,
        }
    }
    // The instance and the arguments are taken in the JS call; the task
    // keeps them.
    let this = if kind == Kind::AsyncMethod {
        args.insert(0, quote!(__this));
        quote!(let __this = #private::this::<Self>(host, #what)?;)
    } else {
        quote!(let _ = host;)
    };
    let finish = if fallible {
        quote!(#private::boxed_result(__result))
    } else {
        quote!(#private::boxed(__result))
    };
    quote! {
        #ui::MemberCall::Async(|host| {
            #this
            #(#decode)*
            ::core::result::Result::Ok(::std::boxed::Box::new(move || {
                ::std::boxed::Box::pin(async move {
                    let __result = Self::#ident(#(#args),*).await;
                    #finish
                })
            }))
        })
    }
}

#[cfg(test)]
mod tests {
    use quote::quote;

    /// The error `#[class]` gives `item`.
    fn error(item: proc_macro2::TokenStream) -> String {
        match super::class(syn::parse2(item).unwrap(), false) {
            Ok(_) => "no error".to_owned(),
            Err(e) => e.to_string(),
        }
    }

    #[test]
    fn interface_goes_on_the_struct() {
        let item = syn::parse2(quote!(impl T { fn get(&self) -> u32 { 0 } })).unwrap();
        let error = super::class(item, true).err().unwrap().to_string();
        assert!(
            error.contains("`interface` goes on the class's struct"),
            "{error}"
        );
        let item = syn::parse2(quote!(
            struct T;
        ))
        .unwrap();
        let made = super::class(item, true).unwrap().to_string();
        assert!(made.contains("const INTERFACE : bool = true"), "{made}");
    }

    #[test]
    fn names_the_object_has_are_refused() {
        assert!(
            error(quote!(impl T { pub fn dispose(&self) {} }))
                .contains("`dispose` is every class's own")
        );
        assert!(error(quote!(impl T { pub fn constructor(&self) {} })).contains("`constructor`"));
        for name in ["prototype", "name", "length"] {
            let ident = quote::format_ident!("{name}");
            assert!(
                error(quote!(impl T { pub fn #ident() -> u32 { 0 } })).contains("a static named"),
                "{name}"
            );
            assert!(
                error(quote!(impl T { pub async fn #ident() -> u32 { 0 } }))
                    .contains("a static named"),
                "async {name}"
            );
        }
        // A method may be called `name` (it is on the prototype).
        assert_eq!(
            error(quote!(impl T { pub fn name(&self) -> u32 { 0 } })),
            "no error"
        );
    }

    #[test]
    fn a_doc_comment_on_the_block_is_refused() {
        // TS shows the struct's: one here would be lost.
        assert!(
            error(quote!(
                #[doc = " A tally."]
                impl T {
                    pub fn new() -> Self {
                        T
                    }
                }
            ))
            .contains("document the export on its struct")
        );
    }

    #[test]
    fn functions_without_a_visibility_are_helpers() {
        // Not exported, so not checked against the object's names.
        assert_eq!(
            error(quote!(impl T { fn dispose(&self) {} fn constructor() {} })),
            "no error"
        );
        assert_eq!(
            error(quote!(impl T { pub(self) fn dispose(&self) {} })),
            "no error"
        );
        // A getter or setter is TS's: one without `pub` is refused.
        assert!(
            error(quote!(impl T { #[getter] fn count(&self) -> u32 { 0 } }))
                .contains("make it `pub fn`")
        );
    }
}
