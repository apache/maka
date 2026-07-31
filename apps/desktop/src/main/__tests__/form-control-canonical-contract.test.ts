import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CheckboxInput,
  NumberInput,
  RadioList,
  RadioListItem,
  Switch,
  TextArea,
  TextInput,
} from "@maka/ui";

test("the public form controls are the Astryx field family", () => {
  const input = renderToStaticMarkup(
    createElement(TextInput, {
      label: "Name",
      value: "",
    }),
  );
  const area = renderToStaticMarkup(
    createElement(TextArea, {
      label: "Notes",
      value: "",
    }),
  );
  assert.match(input, /<label[^>]*for="([^"]+)"/);
  assert.match(input, /<input[^>]*id="([^"]+)"/);
  assert.match(area, /<label[^>]*for="([^"]+)"/);
  assert.match(area, /<textarea[^>]*id="([^"]+)"/);
});

test("the public selection and number controls are callable", () => {
  assert.equal(typeof NumberInput, "function");
  assert.equal(typeof Switch, "function");
  assert.equal(typeof CheckboxInput, "function");
  assert.equal(typeof RadioList, "function");
  assert.equal(typeof RadioListItem, "function");
});
