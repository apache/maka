import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as MakaUi from "@maka/ui";
import {
  CheckboxInput,
  CheckboxList,
  CheckboxListItem,
  FormLayout,
  NumberInput,
  RadioList,
  RadioListItem,
  Selector,
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
  assert.equal(typeof CheckboxList, "function");
  assert.equal(typeof CheckboxListItem, "function");
  assert.equal(typeof RadioList, "function");
  assert.equal(typeof RadioListItem, "function");
  assert.equal(typeof Selector, "function");
  assert.equal(typeof FormLayout, "function");
});

test("the public form surface does not preserve Maka compatibility adapters", () => {
  for (const retired of [
    "SettingsSelect",
    "PlanReminderSelect",
    "TimePicker",
    "SelectRoot",
    "SelectTrigger",
    "SelectValue",
    "SelectPortal",
    "SelectPositioner",
    "SelectPopup",
    "SelectGroup",
    "SelectGroupLabel",
    "SelectSeparator",
    "SelectItem",
    "inputClasses",
    "MultiSelector",
    "TimeInput",
    "DateTimeInput",
    "SelectableCard",
  ]) {
    assert.equal(retired in MakaUi, false, `${retired} must not remain public`);
  }
});
