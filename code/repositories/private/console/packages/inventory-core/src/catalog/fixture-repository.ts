import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dbMetaSchema, productSchema, shopOptionSchema } from "./schemas";
import { parseHistoryHtml } from "./parse-history-html";
import { parseProductsHtml } from "./parse-products-html";
import type { DbMeta, HistoryPayload, Product, ShopOption } from "./types";

const defaultFixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/shop");

const fixtureRoot = (...segments: string[]) =>
  join(process.env.TOKENS_FIXTURES ?? defaultFixtureRoot, ...segments);

const readTextFixture = (fileName: string): string => readFileSync(fixtureRoot(fileName), "utf8");

const readJsonFixture = <T>(fileName: string): T => JSON.parse(readTextFixture(fileName)) as T;

export const readFixtureProducts = (): Product[] =>
  productSchema.array().parse(readJsonFixture("shop.products.sample.json"));

export const readFixtureShops = (): ShopOption[] =>
  shopOptionSchema.array().parse(readJsonFixture("shop.shops.json"));

export const readFixtureDbMeta = (): DbMeta => dbMetaSchema.parse(readJsonFixture("shop.db-meta.json"));

export const KNOWN_HISTORY_PRODUCT_ID = "8732468";

export const readFixtureHistory = (): HistoryPayload =>
  parseHistoryHtml(readTextFixture("shop.history.8732468.html"));

export const readFixtureHistoryById = (id: string): HistoryPayload | null =>
  id === KNOWN_HISTORY_PRODUCT_ID ? readFixtureHistory() : null;

export const readFixtureSearchPage = () => parseProductsHtml(readTextFixture("shop.search.gpt.html"));
