import type { Toolkit } from "../index";
import { readFixtureProducts } from "./fixture-repository";

export const catalogPlugin = {
  id: "catalog",
  apply(toolkit: Toolkit) {
    toolkit.seams.define("catalog");
    toolkit.seams.provide("catalog", {
      source: "fixture" as const,
      listProducts: () => readFixtureProducts(),
    });
  },
};
