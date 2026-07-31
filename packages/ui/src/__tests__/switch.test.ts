import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RadioList, RadioListItem, Switch } from "@astryxdesign/core";

test("Astryx Switch exposes native switch semantics", () => {
  const markup = renderToStaticMarkup(
    createElement(Switch, {
      label: "Example switch",
      isLabelHidden: true,
      value: true,
    }),
  );
  assert.match(markup, /role="switch"/);
  assert.match(markup, /checked=""/);
});

test("Astryx RadioList keeps one native radio group", () => {
  const markup = renderToStaticMarkup(
    createElement(
      RadioList,
      {
        label: "Options",
        value: "one",
        onChange() {},
        children: [
          createElement(RadioListItem, { key: "one", value: "one", label: "One" }),
          createElement(RadioListItem, { key: "two", value: "two", label: "Two" }),
        ],
      },
    ),
  );
  assert.match(markup, /role="radiogroup"/);
  assert.equal((markup.match(/type="radio"/g) ?? []).length, 2);
  assert.equal((markup.match(/ checked=""/g) ?? []).length, 1);
});
