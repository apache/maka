//! What the app's crates and its Android libraries (AARs) add to the
//! manifest NSH writes: permissions, features, `<queries>` and the
//! components of `<application>`.
//!
//! A bounded merge, not Gradle's manifest merger. A library's manifest is
//! read with an XML parser; its relative class names are its package's,
//! placeholders (`${applicationId}`, the app's `manifestPlaceholders`) are
//! filled in, and an element several of them declare (a provider each adds
//! meta-data to) becomes one. Whatever this does not merge (a merge rule of
//! `tools:`, a library's own `Application`, an API level above NSH's) is an
//! error naming the library, never a guess.

use std::{collections::BTreeMap, fmt::Write as _};

use anyhow::{Context as _, bail};
use quick_xml::{
    NsReader, XmlVersion,
    events::{BytesStart, Event},
    name::ResolveResult,
};

use super::{Apk, MIN_SDK, xml_attribute};

const ANDROID: &str = "http://schemas.android.com/apk/res/android";
const TOOLS: &str = "http://schemas.android.com/tools";

/// Who lists the app's and the crates' manifest entries, as errors name
/// them.
const CRATES: &str = "nsh.json's and the crates' `android.queries` and `android.application`";

/// An element of a manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Element {
    pub(super) name: String,
    /// As the manifest NSH writes spells them: `android:<name>` for
    /// Android's attributes, `tools:<name>` for the merge tools' (which
    /// [`resolve`] takes out), a bare name otherwise.
    pub(super) attributes: Vec<(String, String)>,
    pub(super) children: Vec<Element>,
}

impl Element {
    pub(super) fn attribute(&self, name: &str) -> Option<&str> {
        self.attributes
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    /// What tells it apart from the elements of its kind beside it: its
    /// name (`android:name`, a query's provider its authorities, a GL
    /// feature its version). An element without (an intent filter) is
    /// told apart by all it is.
    fn key(&self) -> Option<&str> {
        ["android:name", "android:authorities", "android:glEsVersion"]
            .iter()
            .find_map(|name| self.attribute(name))
    }

    /// `<provider android:name="...">`, for errors.
    fn describe(&self) -> String {
        match self.key() {
            Some(key) => format!("`<{} {}>`", self.name, key_attribute(self, key)),
            None => format!("`<{}>`", self.name),
        }
    }

    /// The same element, attributes in any order.
    fn same(&self, other: &Element) -> bool {
        let sorted = |element: &Element| {
            let mut attributes = element.attributes.clone();
            attributes.sort();
            attributes
        };
        self.name == other.name
            && sorted(self) == sorted(other)
            && self.children.len() == other.children.len()
            && self
                .children
                .iter()
                .zip(&other.children)
                .all(|(a, b)| a.same(b))
    }

    /// Writes the element on a line of its own, `indent` spaces in.
    fn write(&self, out: &mut String, indent: usize) {
        let pad = " ".repeat(indent);
        let _ = write!(out, "\n{pad}<{}", self.name);
        for (key, value) in &self.attributes {
            let _ = write!(out, " {key}=\"{}\"", xml_attribute(value));
        }
        if self.children.is_empty() {
            out.push_str(" />");
            return;
        }
        out.push('>');
        for child in &self.children {
            child.write(out, indent + 4);
        }
        let _ = write!(out, "\n{pad}</{}>", self.name);
    }
}

fn key_attribute(element: &Element, key: &str) -> String {
    let name = element
        .attributes
        .iter()
        .find(|(_, value)| value == key)
        .map(|(name, _)| name.as_str())
        .unwrap_or("android:name");
    format!("{name}=\"{key}\"")
}

/// Reads a manifest (or a fragment of one) into its root element. Elements
/// and attributes in namespaces other than Android's and the merge tools'
/// are errors, as is text: a manifest has neither.
pub(super) fn parse(xml: &str) -> anyhow::Result<Element> {
    let mut reader = NsReader::from_str(xml);
    let mut open: Vec<Element> = Vec::new();
    let mut root = None;
    loop {
        let event = match reader.read_event() {
            Ok(event) => event,
            Err(error) => bail!("{error} (at byte {})", reader.error_position()),
        };
        match event {
            Event::Start(start) => open.push(element(&reader, &start)?),
            Event::Empty(start) => {
                let element = element(&reader, &start)?;
                close(element, &mut open, &mut root)?;
            }
            Event::End(_) => {
                let element = open.pop().context("an end tag without its start")?;
                close(element, &mut open, &mut root)?;
            }
            Event::Text(text) if text.trim().is_empty() => {}
            Event::Text(_) | Event::CData(_) | Event::GeneralRef(_) => {
                bail!("text in an element, which a manifest has none of")
            }
            Event::Comment(_) | Event::Decl(_) | Event::PI(_) | Event::DocType(_) => {}
            Event::Eof => break,
        }
    }
    if let Some(element) = open.last() {
        bail!("`<{}>` is not closed", element.name);
    }
    root.context("no element")
}

fn close(element: Element, open: &mut [Element], root: &mut Option<Element>) -> anyhow::Result<()> {
    match open.last_mut() {
        Some(parent) => parent.children.push(element),
        None if root.is_none() => *root = Some(element),
        None => bail!("more than one root element"),
    }
    Ok(())
}

fn element(reader: &NsReader<&[u8]>, start: &BytesStart<'_>) -> anyhow::Result<Element> {
    let name = start.name().as_ref().to_owned();
    if !matches!(
        reader.resolver().resolve_element(start.name()).0,
        ResolveResult::Unbound
    ) {
        bail!("`<{name}>` is in a namespace nsh does not merge");
    }
    let mut attributes = Vec::new();
    for attribute in start.attributes() {
        let attribute = attribute?;
        if attribute.key.as_namespace_binding().is_some() {
            continue;
        }
        let (namespace, local) = reader.resolver().resolve_attribute(attribute.key);
        let local = local.as_ref();
        let key = match namespace {
            ResolveResult::Unbound => local.to_owned(),
            ResolveResult::Bound(ns) if ns.as_ref() == ANDROID => format!("android:{local}"),
            ResolveResult::Bound(ns) if ns.as_ref() == TOOLS => format!("tools:{local}"),
            _ => bail!(
                "`<{name}>`'s attribute `{}` is in a namespace nsh does not merge",
                attribute.key.as_ref()
            ),
        };
        let value = attribute
            .normalized_value(XmlVersion::Implicit1_0)?
            .into_owned();
        attributes.push((key, value));
    }
    Ok(Element {
        name,
        attributes,
        children: Vec::new(),
    })
}

/// What fills a manifest's placeholders: `${applicationId}` is the app's
/// package, the others are `nsh.json` `android.manifestPlaceholders`.
pub(super) struct Placeholders<'a> {
    pub(super) package: &'a str,
    /// `None`: the shared test host's, which reads no app's `nsh.json`: a
    /// placeholder is left empty, and named in [`Placeholders::missing`].
    pub(super) values: Option<&'a BTreeMap<String, String>>,
    /// The placeholders left empty.
    pub(super) missing: std::cell::RefCell<std::collections::BTreeSet<String>>,
}

impl<'a> Placeholders<'a> {
    pub(super) fn new(package: &'a str, values: Option<&'a BTreeMap<String, String>>) -> Self {
        Placeholders {
            package,
            values,
            missing: Default::default(),
        }
    }

    /// `text` with its placeholders filled in, escaped for an attribute
    /// when `text` is XML (a crate's entry) rather than an attribute's value
    /// already read; the name of one without a value is the error.
    fn fill(&self, text: &str, xml: bool) -> Result<String, String> {
        let mut out = String::with_capacity(text.len());
        let mut rest = text;
        while let Some(at) = rest.find("${") {
            let Some(end) = rest[at + 2..].find('}') else {
                break;
            };
            let name = &rest[at + 2..at + 2 + end];
            out.push_str(&rest[..at]);
            let value = match (name, self.values) {
                ("applicationId", _) => self.package,
                (_, Some(values)) => values.get(name).ok_or_else(|| name.to_owned())?,
                (_, None) => {
                    self.missing.borrow_mut().insert(name.to_owned());
                    ""
                }
            };
            if xml {
                out.push_str(&xml_attribute(value));
            } else {
                out.push_str(value);
            }
            rest = &rest[at + 2 + end + 1..];
        }
        out.push_str(rest);
        Ok(out)
    }
}

/// The error of a placeholder without a value, in `from`'s manifest.
fn missing(from: &str, name: &str) -> anyhow::Error {
    anyhow::anyhow!(
        "{from}: its manifest uses the placeholder `${{{name}}}`, which nsh.json `android.manifestPlaceholders` does not set"
    )
}

/// What a library's manifest adds to each part of the app's.
#[derive(Debug, Default)]
pub(super) struct Parts {
    /// `<uses-permission>`, `<uses-permission-sdk-23>`, `<permission>`,
    /// `<permission-group>` and `<uses-feature>`.
    pub(super) top: Vec<Element>,
    /// The children of `<queries>`.
    pub(super) queries: Vec<Element>,
    /// The children of `<application>`.
    pub(super) application: Vec<Element>,
}

/// The elements a library's manifest may have at its top, which the
/// app's gets.
const TOP: &[&str] = &[
    "uses-permission",
    "uses-permission-sdk-23",
    "permission",
    "permission-group",
    "uses-feature",
];
/// The children of `<queries>`.
const QUERIES: &[&str] = &["intent", "package", "provider"];
/// The children of `<application>` a library may declare.
const COMPONENTS: &[&str] = &[
    "activity",
    "activity-alias",
    "service",
    "receiver",
    "provider",
    "meta-data",
    "uses-library",
    "uses-native-library",
    "property",
];
/// The elements whose `android:name` is a class, which may be relative to
/// the manifest's package.
const CLASSES: &[&str] = &[
    "activity",
    "activity-alias",
    "service",
    "receiver",
    "provider",
];

/// The manifest `root` of the library `from`, checked and resolved: what
/// it adds to the app's. Attributes of its `<application>` other than a
/// class of its own are left out, with a warning.
pub(super) fn resolve(
    root: &Element,
    from: &str,
    placeholders: &Placeholders<'_>,
    warnings: &mut Vec<String>,
) -> anyhow::Result<Parts> {
    if root.name != "manifest" {
        bail!("{from}: its AndroidManifest.xml is no manifest");
    }
    let package = root
        .attribute("package")
        .filter(|package| !package.is_empty())
        .with_context(|| format!("{from}: its manifest names no package"))?;
    let resolved = |element: &Element| resolved(element, package, from, placeholders);
    let mut parts = Parts::default();
    for child in &root.children {
        match child.name.as_str() {
            "uses-sdk" => {
                let Some(min) = child.attribute("android:minSdkVersion") else {
                    continue;
                };
                let level: u32 = min.parse().map_err(|_| {
                    anyhow::anyhow!("{from}: its minSdkVersion `{min}` is no API level")
                })?;
                if level > MIN_SDK {
                    bail!(
                        "{from} runs on Android API level {level} and later (its minSdkVersion), \
                         NSH apps on {MIN_SDK}: list a version of it for API level {MIN_SDK}"
                    );
                }
            }
            name if TOP.contains(&name) => parts.top.push(resolved(child)?),
            "queries" => {
                for query in &child.children {
                    if !QUERIES.contains(&query.name.as_str()) {
                        bail!(
                            "{from}: its manifest's `<queries>` has `<{}>`, which nsh does not merge",
                            query.name
                        );
                    }
                    parts.queries.push(resolved(query)?);
                }
            }
            "application" => {
                for (key, value) in &child.attributes {
                    if key == "android:name" {
                        bail!(
                            "{from} needs its own Application class `{value}`, which NSH apps do not run: \
                             a library starts itself with a ContentProvider"
                        );
                    }
                    if let Some(tool) = key.strip_prefix("tools:") {
                        check_tool(tool, value, child, from)?;
                    } else {
                        warnings.push(format!(
                            "{from}: its manifest's `<application {key}=\"{value}\">` is left out: the application is the app's"
                        ));
                    }
                }
                for component in &child.children {
                    if !COMPONENTS.contains(&component.name.as_str()) {
                        bail!(
                            "{from}: its manifest's `<application>` has `<{}>`, which nsh does not merge",
                            component.name
                        );
                    }
                    parts.application.push(resolved(component)?);
                }
            }
            other => bail!("{from}: its manifest has `<{other}>`, which nsh does not merge"),
        }
    }
    Ok(parts)
}

/// `element` of `from`'s manifest with its placeholders filled in, its
/// classes in full and the merge tools' attributes out.
fn resolved(
    element: &Element,
    package: &str,
    from: &str,
    placeholders: &Placeholders<'_>,
) -> anyhow::Result<Element> {
    let mut attributes = Vec::new();
    for (key, value) in &element.attributes {
        if let Some(tool) = key.strip_prefix("tools:") {
            check_tool(tool, value, element, from)?;
            continue;
        }
        let mut value = placeholders
            .fill(value, false)
            .map_err(|name| missing(from, &name))?;
        let class = matches!(
            key.as_str(),
            "android:name" | "android:targetActivity" | "android:parentActivityName"
        );
        if class && CLASSES.contains(&element.name.as_str()) {
            value = full_class(package, &value);
        }
        attributes.push((key.clone(), value));
    }
    let children = element
        .children
        .iter()
        .map(|child| resolved(child, package, from, placeholders))
        .collect::<anyhow::Result<_>>()?;
    Ok(Element {
        name: element.name.clone(),
        attributes,
        children,
    })
}

/// A crate's `element` without the merge tools' attributes, checked as a
/// library's are.
fn without_tools(element: Element) -> anyhow::Result<Element> {
    let mut attributes = Vec::new();
    for (key, value) in element.attributes {
        match key.strip_prefix("tools:") {
            Some(tool) => check_tool(tool, &value, &element_named(&element.name), CRATES)?,
            None => attributes.push((key, value)),
        }
    }
    Ok(Element {
        name: element.name,
        attributes,
        children: element
            .children
            .into_iter()
            .map(without_tools)
            .collect::<anyhow::Result<_>>()?,
    })
}

/// An element of `name` alone, which errors name.
fn element_named(name: &str) -> Element {
    Element {
        name: name.to_owned(),
        attributes: Vec::new(),
        children: Vec::new(),
    }
}

/// A class name of a manifest whose package is `package`, in full: `.Foo`
/// and `Foo` are the package's, as Android reads them.
fn full_class(package: &str, name: &str) -> String {
    if name.starts_with('.') {
        format!("{package}{name}")
    } else if !name.contains('.') && !name.is_empty() {
        format!("{package}.{name}")
    } else {
        name.to_owned()
    }
}

/// A `tools:` attribute: what only lint reads is left out; a merge rule
/// other than the default (`tools:node="merge"`) is an error.
fn check_tool(tool: &str, value: &str, element: &Element, from: &str) -> anyhow::Result<()> {
    let rule = matches!(
        tool,
        "node" | "replace" | "remove" | "strict" | "selector" | "overrideLibrary"
    );
    if rule && !(tool == "node" && value == "merge") {
        bail!(
            "{from}: its manifest's {} has `tools:{tool}=\"{value}\"`, a merge rule nsh does not apply",
            element.describe()
        );
    }
    Ok(())
}

/// One element of the merged manifest, and who declared it first.
#[derive(Debug)]
struct Merging {
    element: Element,
    from: String,
}

/// Adds `element` of `from` to `list`: an element of the same kind and
/// name there takes its attributes and children, an element without a
/// name that is there already is left out.
fn add(list: &mut Vec<Merging>, element: Element, from: &str) -> anyhow::Result<()> {
    let have = list.iter_mut().find(|m| match element.key() {
        Some(key) => m.element.name == element.name && m.element.key() == Some(key),
        None => m.element.same(&element),
    });
    match have {
        Some(have) => join(&mut have.element, element, &have.from, from),
        None => {
            list.push(Merging {
                element,
                from: from.to_owned(),
            });
            Ok(())
        }
    }
}

/// Joins `more` (of `more_from`) into `have` (of `have_from`), the same
/// element: an attribute both give differently is an error naming both,
/// but for a permission's `maxSdkVersion` and a feature's `required`, of
/// which the wider wins (as Gradle has it), whichever comes first.
fn join(have: &mut Element, more: Element, have_from: &str, more_from: &str) -> anyhow::Result<()> {
    let permission = matches!(
        have.name.as_str(),
        "uses-permission" | "uses-permission-sdk-23"
    );
    let feature = have.name == "uses-feature";
    // The attribute of these two whose wider value `wider` gives: `None`
    // is the attribute left out, the widest of all.
    type Wider = fn(Option<&str>, Option<&str>) -> Option<Option<String>>;
    let widest: Option<(&str, Wider)> = if permission {
        // Declared for every API level by one of them: for every one.
        Some(("android:maxSdkVersion", |a, b| match (a, b) {
            (Some(a), Some(b)) => Some(Some(
                a.parse::<u32>().ok()?.max(b.parse().ok()?).to_string(),
            )),
            _ => Some(None),
        }))
    } else if feature {
        // Needed by one of them (`required` left out is `true`): needed.
        Some(("android:required", |a, b| match (a, b) {
            (Some("false"), Some("false")) => Some(Some("false".to_owned())),
            _ => Some(None),
        }))
    } else {
        None
    };
    if let Some((key, wider)) = widest {
        let (a, b) = (have.attribute(key), more.attribute(key));
        if a != b {
            match wider(a, b) {
                Some(Some(value)) => set(have, key, value),
                Some(None) => have.attributes.retain(|(k, _)| k != key),
                None => bail!(
                    "{have_from} and {more_from} both declare {} with different `{key}`",
                    have.describe()
                ),
            }
        }
    }
    for (key, value) in &more.attributes {
        if widest.is_some_and(|(wide, _)| wide == key) {
            continue;
        }
        match have.attribute(key) {
            None => have.attributes.push((key.clone(), value.clone())),
            Some(same) if same == value => {}
            Some(other) => bail!(
                "{have_from} and {more_from} both declare {} with different `{key}`: `{other}` and `{value}`",
                have.describe()
            ),
        }
    }
    let mut children: Vec<Merging> = std::mem::take(&mut have.children)
        .into_iter()
        .map(|element| Merging {
            element,
            from: have_from.to_owned(),
        })
        .collect();
    for child in more.children {
        add(&mut children, child, more_from)?;
    }
    have.children = children.into_iter().map(|m| m.element).collect();
    Ok(())
}

fn set(element: &mut Element, key: &str, value: String) {
    if let Some(slot) = element.attributes.iter_mut().find(|(k, _)| k == key) {
        slot.1 = value;
    }
}

/// What [`super::manifest_xml`] adds to the manifest, as text.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct Additions {
    /// After NSH's permissions: the libraries' permissions and features.
    pub(super) top: String,
    /// In `<queries>`, after NSH's text actions.
    pub(super) queries: String,
    /// In `<application>`, after NSH's activity.
    pub(super) application: String,
}

/// What the app's and the crates' entries (`apk.queries`,
/// `apk.application`) and the
/// libraries' manifests (`libraries`: what each adds, and who lists it)
/// add to `apk`'s manifest. Without libraries the entries go in as the
/// crates write them, placeholders filled in; with libraries they are
/// merged with the libraries' elements. A permission NSH declares itself
/// is declared once, as NSH has it.
pub(super) fn additions(
    apk: &Apk<'_>,
    placeholders: &Placeholders<'_>,
    libraries: Vec<(Parts, String)>,
) -> anyhow::Result<Additions> {
    let fill = |entry: &str| {
        placeholders.fill(entry.trim(), true).map_err(|name| {
            anyhow::anyhow!(
                "{CRATES} use the placeholder `${{{name}}}`, which nsh.json `android.manifestPlaceholders` does not set"
            )
        })
    };
    if libraries.is_empty() {
        let mut additions = Additions::default();
        for (entries, out) in [
            (apk.queries, &mut additions.queries),
            (apk.application, &mut additions.application),
        ] {
            for entry in entries {
                let _ = write!(out, "\n        {}", fill(entry)?);
            }
        }
        return Ok(additions);
    }
    // The crates' entries take part in the merge: a crate may add meta-data
    // to a provider a library declares.
    let crates = |entries: &[String]| -> anyhow::Result<Vec<Element>> {
        let mut out = Vec::new();
        for entry in entries {
            let fragment = parse(&format!(
                "<entries xmlns:android=\"{ANDROID}\">{}</entries>",
                fill(entry)?
            ))
            .with_context(|| format!("{CRATES}: read `{}`", entry.trim()))?;
            for element in fragment.children {
                // The merged manifest declares no namespace an entry may
                // declare for itself: the merge tools' attributes go, as
                // the libraries' do.
                out.push(without_tools(element)?);
            }
        }
        Ok(out)
    };
    let mut top = Vec::new();
    let mut queries = Vec::new();
    let mut application = Vec::new();
    for element in crates(apk.queries)? {
        add(&mut queries, element, CRATES)?;
    }
    for element in crates(apk.application)? {
        add(&mut application, element, CRATES)?;
    }
    for (parts, from) in libraries {
        for element in parts.top {
            add(&mut top, element, &from)?;
        }
        for element in parts.queries {
            add(&mut queries, element, &from)?;
        }
        for element in parts.application {
            add(&mut application, element, &from)?;
        }
    }
    let declared = super::declared_permissions(apk);
    let mut additions = Additions::default();
    for merging in &top {
        let element = &merging.element;
        let nsh_declares = element.name == "uses-permission"
            && element
                .attribute("android:name")
                .is_some_and(|name| declared.iter().any(|d| d == name));
        if !nsh_declares {
            element.write(&mut additions.top, 4);
        }
    }
    for merging in &queries {
        merging.element.write(&mut additions.queries, 8);
    }
    for merging in &application {
        merging.element.write(&mut additions.application, 8);
    }
    Ok(additions)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FROM: &str = "push.aar (nsh.json `android.libraries`)";

    fn manifest(body: &str) -> String {
        format!(
            r#"<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:tools="http://schemas.android.com/tools"
    package="com.example.push">
    <uses-sdk android:minSdkVersion="21" android:targetSdkVersion="34" />
{body}
</manifest>"#
        )
    }

    fn placeholders() -> BTreeMap<String, String> {
        BTreeMap::from([("PUSH_KEY".to_owned(), "k-123".to_owned())])
    }

    /// The parts of a library manifest with `body`, written as the app's
    /// manifest has them, or the error.
    fn parts(body: &str) -> Result<(String, String, String, Vec<String>), String> {
        let values = placeholders();
        let placeholders = Placeholders::new("com.example.app", Some(&values));
        let root = parse(&manifest(body)).map_err(|e| e.to_string())?;
        let mut warnings = Vec::new();
        let parts =
            resolve(&root, FROM, &placeholders, &mut warnings).map_err(|e| e.to_string())?;
        let write = |elements: &[Element], indent: usize| {
            let mut out = String::new();
            for element in elements {
                element.write(&mut out, indent);
            }
            out.trim_start().to_owned()
        };
        Ok((
            write(&parts.top, 0),
            write(&parts.queries, 0),
            write(&parts.application, 0),
            warnings,
        ))
    }

    #[test]
    fn a_library_manifest_resolves_as_the_app_has_it() {
        // (what the library's manifest has, what the app's gets: top,
        // queries, application)
        let cases: &[(&str, [&str; 3])] = &[
            // Relative classes are the library's package's.
            (
                r#"<application><service android:name=".PushService" android:exported="false" />
                   <receiver android:name="Receiver" /><activity android:name="com.other.Screen" /></application>"#,
                [
                    "",
                    "",
                    "<service android:name=\"com.example.push.PushService\" android:exported=\"false\" />\n\
                     <receiver android:name=\"com.example.push.Receiver\" />\n\
                     <activity android:name=\"com.other.Screen\" />",
                ],
            ),
            // A meta-data's name is no class.
            (
                r#"<application><meta-data android:name="Key" android:value=".x" /></application>"#,
                [
                    "",
                    "",
                    "<meta-data android:name=\"Key\" android:value=\".x\" />",
                ],
            ),
            // Placeholders: the app's package and nsh.json's values.
            (
                r#"<application><provider android:name=".Init" android:authorities="${applicationId}.push-init"
                       android:exported="false" /><meta-data android:name="push.key" android:value="${PUSH_KEY}" />
                   </application>"#,
                [
                    "",
                    "",
                    "<provider android:name=\"com.example.push.Init\" android:authorities=\"com.example.app.push-init\" android:exported=\"false\" />\n\
                     <meta-data android:name=\"push.key\" android:value=\"k-123\" />",
                ],
            ),
            // Permissions, features, queries; lint's and the default merge
            // rule's attributes left out.
            (
                r#"<uses-permission android:name="android.permission.WAKE_LOCK" />
                   <uses-permission-sdk-23 android:name="android.permission.ACCESS_WIFI_STATE" />
                   <permission android:name="${applicationId}.permission.PUSH" android:protectionLevel="signature" />
                   <uses-feature android:name="android.hardware.camera" android:required="false" />
                   <queries><package android:name="com.example.store" /><intent><action android:name="x.SEND" /></intent></queries>
                   <application><provider android:name="androidx.startup.InitializationProvider"
                       android:authorities="${applicationId}.androidx-startup" tools:node="merge"
                       tools:targetApi="31"><meta-data android:name="a.Init" android:value="androidx.startup" /></provider>
                   </application>"#,
                [
                    "<uses-permission android:name=\"android.permission.WAKE_LOCK\" />\n\
                     <uses-permission-sdk-23 android:name=\"android.permission.ACCESS_WIFI_STATE\" />\n\
                     <permission android:name=\"com.example.app.permission.PUSH\" android:protectionLevel=\"signature\" />\n\
                     <uses-feature android:name=\"android.hardware.camera\" android:required=\"false\" />",
                    "<package android:name=\"com.example.store\" />\n\
                     <intent>\n    <action android:name=\"x.SEND\" />\n</intent>",
                    "<provider android:name=\"androidx.startup.InitializationProvider\" android:authorities=\"com.example.app.androidx-startup\">\n    \
                     <meta-data android:name=\"a.Init\" android:value=\"androidx.startup\" />\n\
                     </provider>",
                ],
            ),
            // Escaped values stay escaped.
            (
                r#"<application><meta-data android:name="m" android:value="a &amp; &quot;b&quot; &apos;c&apos;&#10;d&#9;e" /></application>"#,
                [
                    "",
                    "",
                    "<meta-data android:name=\"m\" android:value=\"a &amp; &quot;b&quot; &apos;c&apos;&#10;d&#9;e\" />",
                ],
            ),
        ];
        for (body, [top, queries, application]) in cases {
            let (t, q, a, warnings) = parts(body).unwrap();
            assert_eq!(
                (t.as_str(), q.as_str(), a.as_str()),
                (*top, *queries, *application),
                "{body}"
            );
            assert!(warnings.is_empty(), "{warnings:?}");
        }
    }

    #[test]
    fn what_this_does_not_merge_is_an_error_naming_the_library() {
        // (what the library's manifest has, what the error says)
        let cases: &[(&str, &str)] = &[
            (
                r#"<application><meta-data android:name="k" android:value="${MAPS_KEY}" /></application>"#,
                "uses the placeholder `${MAPS_KEY}`, which nsh.json `android.manifestPlaceholders` does not set",
            ),
            (
                r#"<application><activity android:name=".A" tools:node="remove" /></application>"#,
                "`<activity android:name=\".A\">` has `tools:node=\"remove\"`, a merge rule nsh does not apply",
            ),
            (
                r#"<application><activity android:name=".A" android:theme="@style/x" tools:replace="android:theme" /></application>"#,
                "has `tools:replace=\"android:theme\"`, a merge rule",
            ),
            (
                r#"<application android:name=".PushApplication" />"#,
                "needs its own Application class `.PushApplication`, which NSH apps do not run",
            ),
            (
                r#"<uses-sdk android:minSdkVersion="28" />"#,
                "runs on Android API level 28 and later (its minSdkVersion), NSH apps on 26",
            ),
            (
                r#"<instrumentation android:name="x.Runner" android:targetPackage="x" />"#,
                "its manifest has `<instrumentation>`, which nsh does not merge",
            ),
            (
                r#"<application><x:thing xmlns:x="urn:x" /></application>"#,
                "`<x:thing>` is in a namespace nsh does not merge",
            ),
        ];
        for (body, expected) in cases {
            let error = parts(body).unwrap_err();
            assert!(error.contains(expected), "{body}: {error}");
            // What the library has wrong names it; what is no manifest at
            // all, its reader does.
            assert!(
                error.starts_with(FROM) || body.contains("xmlns:x"),
                "{body}: {error}"
            );
        }
        // Not a manifest at all.
        let root = parse("<resources />").unwrap();
        let error = resolve(
            &root,
            FROM,
            &Placeholders::new("a", Some(&BTreeMap::new())),
            &mut Vec::new(),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("is no manifest"), "{error}");
        assert!(parse("<manifest><application></manifest>").is_err());
        assert!(parse("<manifest>text</manifest>").is_err());
    }

    #[test]
    fn the_applications_own_attributes_are_left_out_with_a_warning() {
        let (_, _, application, warnings) = parts(
            r#"<application android:appComponentFactory="androidx.core.app.CoreComponentFactory"
                   tools:ignore="x"><service android:name=".S" /></application>"#,
        )
        .unwrap();
        assert_eq!(
            application,
            "<service android:name=\"com.example.push.S\" />"
        );
        assert_eq!(
            warnings,
            [format!(
                "{FROM}: its manifest's `<application android:appComponentFactory=\"androidx.core.app.CoreComponentFactory\">` is left out: the application is the app's"
            )]
        );
    }

    fn element(xml: &str) -> Element {
        parse(&format!("<x xmlns:android=\"{ANDROID}\">{xml}</x>"))
            .unwrap()
            .children
            .remove(0)
    }

    #[test]
    fn elements_of_one_name_become_one() {
        // (the elements of two libraries, what the app's manifest gets or
        // the error)
        let cases: &[(&str, &str, Result<&str, &str>)] = &[
            // Each library adds an initializer to one provider.
            (
                r#"<provider android:name="androidx.startup.InitializationProvider" android:authorities="a.androidx-startup" android:exported="false"><meta-data android:name="lifecycle.Init" android:value="androidx.startup" /></provider>"#,
                r#"<provider android:name="androidx.startup.InitializationProvider" android:authorities="a.androidx-startup" android:exported="false"><meta-data android:name="emoji.Init" android:value="androidx.startup" /><meta-data android:name="lifecycle.Init" android:value="androidx.startup" /></provider>"#,
                Ok(
                    "<provider android:name=\"androidx.startup.InitializationProvider\" android:authorities=\"a.androidx-startup\" android:exported=\"false\">\n    \
                     <meta-data android:name=\"lifecycle.Init\" android:value=\"androidx.startup\" />\n    \
                     <meta-data android:name=\"emoji.Init\" android:value=\"androidx.startup\" />\n\
                     </provider>",
                ),
            ),
            // One adds an attribute the other does not give.
            (
                r#"<activity android:name="x.A" />"#,
                r#"<activity android:name="x.A" android:theme="@style/T"><intent-filter><action android:name="x.OPEN" /></intent-filter></activity>"#,
                Ok(
                    "<activity android:name=\"x.A\" android:theme=\"@style/T\">\n    <intent-filter>\n        <action android:name=\"x.OPEN\" />\n    </intent-filter>\n</activity>",
                ),
            ),
            // The wider permission and the needed feature win, in either
            // order; one that leaves the attribute out is the widest.
            (
                r#"<uses-permission android:name="p.X" android:maxSdkVersion="28" />"#,
                r#"<uses-permission android:name="p.X" android:maxSdkVersion="32" />"#,
                Ok("<uses-permission android:name=\"p.X\" android:maxSdkVersion=\"32\" />"),
            ),
            (
                r#"<uses-permission android:name="p.X" android:maxSdkVersion="32" />"#,
                r#"<uses-permission android:name="p.X" android:maxSdkVersion="28" />"#,
                Ok("<uses-permission android:name=\"p.X\" android:maxSdkVersion=\"32\" />"),
            ),
            (
                r#"<uses-permission android:name="p.X" android:maxSdkVersion="28" />"#,
                r#"<uses-permission android:name="p.X" />"#,
                Ok("<uses-permission android:name=\"p.X\" />"),
            ),
            (
                r#"<uses-permission android:name="p.X" />"#,
                r#"<uses-permission android:name="p.X" android:maxSdkVersion="28" />"#,
                Ok("<uses-permission android:name=\"p.X\" />"),
            ),
            (
                r#"<uses-feature android:name="f.X" android:required="false" />"#,
                r#"<uses-feature android:name="f.X" android:required="true" />"#,
                Ok("<uses-feature android:name=\"f.X\" />"),
            ),
            (
                r#"<uses-feature android:name="f.X" />"#,
                r#"<uses-feature android:name="f.X" android:required="false" />"#,
                Ok("<uses-feature android:name=\"f.X\" />"),
            ),
            (
                r#"<uses-feature android:name="f.X" android:required="false" />"#,
                r#"<uses-feature android:name="f.X" />"#,
                Ok("<uses-feature android:name=\"f.X\" />"),
            ),
            (
                r#"<uses-feature android:name="f.X" android:required="false" />"#,
                r#"<uses-feature android:name="f.X" android:required="false" />"#,
                Ok("<uses-feature android:name=\"f.X\" android:required=\"false\" />"),
            ),
            // The same intent filter, once.
            (
                r#"<intent><action android:name="x.SEND" /></intent>"#,
                r#"<intent><action android:name="x.SEND" /></intent>"#,
                Ok("<intent>\n    <action android:name=\"x.SEND\" />\n</intent>"),
            ),
            // Different values of an attribute.
            (
                r#"<provider android:name="p.P" android:authorities="a.one" />"#,
                r#"<provider android:name="p.P" android:authorities="a.two" />"#,
                Err(
                    "one.aar and two.aar both declare `<provider android:name=\"p.P\">` with different `android:authorities`: `a.one` and `a.two`",
                ),
            ),
            // Different values of a meta-data both add to one provider.
            (
                r#"<provider android:name="p.P"><meta-data android:name="m" android:value="1" /></provider>"#,
                r#"<provider android:name="p.P"><meta-data android:name="m" android:value="2" /></provider>"#,
                Err(
                    "both declare `<meta-data android:name=\"m\">` with different `android:value`: `1` and `2`",
                ),
            ),
        ];
        for (a, b, expected) in cases {
            let mut list = Vec::new();
            let result = add(&mut list, element(a), "one.aar")
                .and_then(|()| add(&mut list, element(b), "two.aar"))
                .map(|()| {
                    let mut out = String::new();
                    for merging in &list {
                        merging.element.write(&mut out, 0);
                    }
                    out.trim_start().to_owned()
                })
                .map_err(|e| e.to_string());
            match (result, expected) {
                (Ok(out), Ok(expected)) => assert_eq!(out, *expected, "{a} + {b}"),
                (Err(error), Err(expected)) => {
                    assert!(error.contains(expected), "{a} + {b}: {error}")
                }
                (result, _) => panic!("{a} + {b}: {result:?}"),
            }
        }
    }

    #[test]
    fn placeholders_fill_in_or_name_what_is_missing() {
        let mut values = placeholders();
        values.insert("QUOTED".to_owned(), "a&\"b\"'c'".to_owned());
        let placeholders = Placeholders::new("com.example.app", Some(&values));
        assert_eq!(
            placeholders.fill("${applicationId}.push/${PUSH_KEY}", false),
            Ok("com.example.app.push/k-123".to_owned())
        );
        assert_eq!(
            placeholders.fill("no ${ end", false),
            Ok("no ${ end".to_owned())
        );
        assert_eq!(
            placeholders.fill("${OTHER}", false),
            Err("OTHER".to_owned())
        );
        // A read value takes it as it is; a crate's XML, escaped.
        assert_eq!(
            placeholders.fill("${QUOTED}", false),
            Ok("a&\"b\"'c'".to_owned())
        );
        assert_eq!(
            placeholders.fill(r#"<meta-data android:value='${QUOTED}'/>"#, true),
            Ok(r#"<meta-data android:value='a&amp;&quot;b&quot;&apos;c&apos;'/>"#.to_owned())
        );
        assert!(placeholders.missing.borrow().is_empty());
        // The shared test host reads no app's values: empty, and named.
        let test_host = Placeholders::new("com.example.app", None);
        assert_eq!(
            test_host.fill("${applicationId}/${PUSH_KEY}", false),
            Ok("com.example.app/".to_owned())
        );
        assert_eq!(
            test_host.missing.borrow().iter().collect::<Vec<_>>(),
            ["PUSH_KEY"]
        );
    }

    #[test]
    fn a_crates_entry_loses_the_merge_tools_attributes_it_declares() {
        let values = placeholders();
        let placeholders = Placeholders::new("com.example.app", Some(&values));
        let entry = r#"<activity xmlns:tools="http://schemas.android.com/tools" android:name="x.A" tools:ignore="Lint"><meta-data android:name="m" android:value="v" tools:node="merge"/></activity>"#;
        let application = [entry.to_owned()];
        let apk = super::super::Apk {
            application: &application,
            ..test_apk()
        };
        let library = Parts {
            application: vec![
                parse(&format!(
                    r#"<provider xmlns:android="{ANDROID}" android:name="p.P" />"#
                ))
                .unwrap(),
            ],
            ..Default::default()
        };
        let added = additions(&apk, &placeholders, vec![(library, FROM.to_owned())]).unwrap();
        assert_eq!(
            added.application,
            "\n        <activity android:name=\"x.A\">\n            \
             <meta-data android:name=\"m\" android:value=\"v\" />\n        </activity>\n        \
             <provider android:name=\"p.P\" />"
        );
        // A merge rule is an error, as in a library.
        let application = [entry.replace("tools:ignore=\"Lint\"", "tools:node=\"remove\"")];
        let apk = super::super::Apk {
            application: &application,
            ..test_apk()
        };
        let error = additions(
            &apk,
            &placeholders,
            vec![(Parts::default(), FROM.to_owned())],
        )
        .unwrap_err()
        .to_string();
        assert!(
            error.starts_with(CRATES) && error.contains("`tools:node=\"remove\"`"),
            "{error}"
        );
    }

    /// An app's package without anything else.
    fn test_apk() -> super::super::Apk<'static> {
        super::super::Apk {
            package: "com.example.app",
            label: "App",
            version_name: "1.0",
            version_code: 1,
            target_sdk: super::super::DEFAULT_TARGET_SDK,
            activity: "com.example.Main",
            dev: false,
            cleartext: false,
            notifications: false,
            microphone: false,
            camera: false,
            libraries: &[],
            library_cache: std::path::Path::new("."),
            manifest_placeholders: None,
            permissions: &[],
            queries: &[],
            application: &[],
            schemes: &[],
            share_mime_types: &[],
            links: &[],
            rust: false,
            dark: false,
            fixed_appearance: false,
            runtime: std::path::Path::new("."),
            abis: &[],
            icon: None,
            launch_screen: None,
            assets: Vec::new(),
            sounds: Vec::new(),
            res: None,
            signing: super::super::Signing::Debug,
        }
    }
}
