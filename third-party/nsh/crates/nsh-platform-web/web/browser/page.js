// `nsh/web`: the page around the app. `Head` sets the page's own `<head>`
// (this module runs in the page's realm, the app in its iframe's).

/** Elements the heads made, so that what no head sets any more is removed. */
const MARK = "data-nsh-head";

/** A URL the app gives: a path (`"/notes/q3"`) starts at the site's base, the
 * directory the site was published to, as a linked `NavStack`'s paths do. */
function siteURL(url) {
  const base = new URL(".", document.baseURI);
  return /^\/(?!\/)/.test(url) ? new URL(url.slice(1), base).href : new URL(url, base).href;
}

export function createWebPage(reactive, player) {
  const { effect, cleanup, untracked } = reactive;
  // The mounted heads, in the order they mounted: later ones win for what
  // they set (a page pushed over another titles the document).
  const heads = [];
  const initial = { title: document.title, lang: document.documentElement.lang };
  let scheduled = false;

  const apply = () => {
    scheduled = false;
    const head = {};
    const meta = new Map();
    for (const entry of heads) {
      const props = entry.props;
      for (const key of ["title", "description", "canonical", "lang", "jsonLd"]) if (props[key] != null) head[key] = props[key];
      for (const m of props.meta ?? []) {
        if (m && m.content != null) meta.set(m.property ? `property:${m.property}` : `name:${m.name}`, m);
      }
    }
    document.title = head.title ?? initial.title;
    document.documentElement.lang = head.lang ?? initial.lang;
    const d = document.head;
    d.querySelectorAll(`[${MARK}]`).forEach(el => el.remove());
    const add = (tag, attrs, text) => {
      const el = document.createElement(tag);
      for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
      if (text != null) el.textContent = text;
      el.setAttribute(MARK, "");
      d.append(el);
    };
    if (head.description != null) add("meta", { name: "description", content: head.description });
    if (head.canonical != null) add("link", { rel: "canonical", href: siteURL(head.canonical) });
    // Link previews read Open Graph: the title and description unless the
    // app's own meta say otherwise.
    if (head.title != null && !meta.has("property:og:title")) add("meta", { property: "og:title", content: head.title });
    if (head.description != null && !meta.has("property:og:description")) add("meta", { property: "og:description", content: head.description });
    for (const m of meta.values()) add("meta", m.property ? { property: m.property, content: m.content } : { name: m.name, content: m.content });
    if (head.jsonLd != null) add("script", { type: "application/ld+json" }, JSON.stringify(head.jsonLd));
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(apply);
  };

  function Head(props) {
    const entry = { props: {} };
    heads.push(entry);
    effect(() => {
      entry.props = {
        title: props.title, description: props.description, canonical: props.canonical, lang: props.lang,
        meta: props.meta, jsonLd: props.jsonLd,
      };
      untracked(schedule);
    });
    cleanup(() => {
      const index = heads.indexOf(entry);
      if (index >= 0) heads.splice(index, 1);
      schedule();
    });
    return null;
  }

  return { exports: { Head } };
}
