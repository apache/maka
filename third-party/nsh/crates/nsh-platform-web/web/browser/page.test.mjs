// `nsh/web`'s `Head` without a browser:
// `node --test crates/nsh-platform-web/web/browser/page.test.mjs`. A
// stand-in document records what the heads write, and a stand-in reactive
// graph runs effects at once and keeps each head's cleanups.
import test from "node:test";
import assert from "node:assert/strict";
import { createWebPage } from "./page.js";

/** A document with a `<head>` of elements that keep their attributes. */
function fakeDocument() {
  const head = {
    children: [],
    append(el) { this.children.push(el); el.parent = this; },
    querySelectorAll(selector) {
      const name = selector.slice(1, -1);
      return this.children.filter(el => el.attributes.has(name));
    },
  };
  return {
    title: "Site",
    baseURI: "https://notes.example.com/app/",
    documentElement: { lang: "" },
    head,
    createElement(tag) {
      return {
        tag, attributes: new Map(), textContent: "",
        setAttribute(name, value) { this.attributes.set(name, String(value)); },
        remove() { head.children.splice(head.children.indexOf(this), 1); },
      };
    },
  };
}

/** Owners whose cleanups run when they are disposed. */
function fakeReactive() {
  let current = null;
  return {
    effect: fn => fn(),
    untracked: fn => fn(),
    cleanup: fn => current.push(fn),
    /** Runs `fn` under a new owner; returns what disposes it. */
    own(fn) {
      const owner = [];
      current = owner;
      fn();
      current = null;
      return () => owner.forEach(f => f());
    },
  };
}

const settle = () => new Promise(resolve => queueMicrotask(resolve));
const metas = document => Object.fromEntries(document.head.children.filter(el => el.tag === "meta")
  .map(el => [el.attributes.get("name") ?? el.attributes.get("property"), el.attributes.get("content")]));

test("a later head wins for what it sets, the ones before it for the rest", async () => {
  globalThis.document = fakeDocument();
  const reactive = fakeReactive();
  const { exports } = createWebPage(reactive, {});
  reactive.own(() => exports.Head({ title: "Notes", description: "All notes", lang: "en", canonical: "/" }));
  const page = reactive.own(() => exports.Head({
    title: "Q3 earnings", canonical: "/notes/q3", meta: [{ property: "og:type", content: "article" }],
    jsonLd: { "@type": "Article" },
  }));
  await settle();
  assert.equal(document.title, "Q3 earnings");
  assert.equal(document.documentElement.lang, "en");
  assert.deepEqual(metas(document), {
    description: "All notes", "og:title": "Q3 earnings", "og:description": "All notes", "og:type": "article",
  });
  const canonical = document.head.children.find(el => el.tag === "link");
  // A path starts at the site's base.
  assert.equal(canonical.attributes.get("href"), "https://notes.example.com/app/notes/q3");
  const script = document.head.children.find(el => el.tag === "script");
  assert.equal(script.attributes.get("type"), "application/ld+json");
  assert.deepEqual(JSON.parse(script.textContent), { "@type": "Article" });

  // The page's head gone, the one before it titles the document again.
  page();
  await settle();
  assert.equal(document.title, "Notes");
  assert.deepEqual(metas(document), { description: "All notes", "og:title": "Notes", "og:description": "All notes" });
  assert.equal(document.head.children.some(el => el.tag === "script"), false);
});

test("the app's own Open Graph title wins over the head's title", async () => {
  globalThis.document = fakeDocument();
  const reactive = fakeReactive();
  const { exports } = createWebPage(reactive, {});
  const head = reactive.own(() => exports.Head({ title: "Notes", meta: [{ property: "og:title", content: "Market Notes" }] }));
  await settle();
  assert.deepEqual(metas(document), { "og:title": "Market Notes" });
  // With no head left, the document's own title and language come back.
  head();
  await settle();
  assert.equal(document.title, "Site");
  assert.equal(document.documentElement.lang, "");
  assert.deepEqual(document.head.children, []);
});
