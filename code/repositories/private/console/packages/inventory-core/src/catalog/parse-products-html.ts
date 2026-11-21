import { productSchema, shopOptionSchema } from "./schemas";
import type { Product, ShopOption } from "./types";

export type ParsedProductsHtml = {
  totalProducts: number;
  shops: ShopOption[];
  products: Product[];
};

const decodeHtml = (value: string): string =>
  value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

const attr = (html: string, name: string): string => {
  const match = html.match(new RegExp(`${name}="([^"]*)"`, "i"));
  return match ? decodeHtml(match[1]) : "";
};

const textByPattern = (html: string, pattern: RegExp): string => {
  const match = html.match(pattern);
  return match ? decodeHtml(match[1].replace(/<[^>]*>/g, "")) : "";
};

const extractRows = (tbody: string): string[] => {
  const rows: string[] = [];
  const rowPattern = /<tr\b[\s\S]*?<\/tr>/gi;
  let match: RegExpExecArray | null;

  while ((match = rowPattern.exec(tbody)) !== null) {
    if (match[0].includes("data-duplicate-group=")) {
      rows.push(match[0]);
    }
  }

  return rows;
};

const parseShops = (html: string): ShopOption[] => {
  const selectMatch = html.match(
    /<select\b[^>]*name="shop_id"[^>]*>([\s\S]*?)<\/select>/i,
  );

  if (!selectMatch) {
    return [];
  }

  const options: ShopOption[] = [];
  const optionPattern = /<option\b[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/gi;
  let match: RegExpExecArray | null;

  while ((match = optionPattern.exec(selectMatch[1])) !== null) {
    const shop_id = decodeHtml(match[1]);
    const name = decodeHtml(match[2].replace(/<[^>]*>/g, ""));

    if (shop_id) {
      options.push(shopOptionSchema.parse({ shop_id, name }));
    }
  }

  return options;
};

const parseProductRow = (row: string): Product => {
  const group = attr(row, "data-duplicate-group");
  const rowClass = attr(row, "class");
  const titleLink = row.match(/<a\b[^>]*class="product-title"[^>]*>[\s\S]*?<\/a>/i)?.[0] ?? "";
  const shopLink = row.match(/<a\b[^>]*class="shop-tag"[^>]*>[\s\S]*?<\/a>/i)?.[0] ?? "";
  const imageMatch = row.match(/<img\b[^>]*src="([^"]*)"/i);
  const updatedAtMatch = row.match(
    /<td\b[^>]*class="([^"]*update-time[^"]*)"[^>]*data-label="更新时间"[^>]*>([\s\S]*?)<\/td>/i,
  );

  const product = {
    duplicate_hidden: rowClass.split(/\s+/).includes("duplicate-row") || /\shidden\b/i.test(row),
    duplicate_group: group,
    status: textByPattern(row, /<span\b[^>]*class="status[^"]*"[^>]*>([\s\S]*?)<\/span>/i),
    title: decodeHtml(titleLink.replace(/<[^>]*>/g, "")),
    item_url: attr(titleLink, "href"),
    source: textByPattern(row, /<span\b[^>]*class="source-tag"[^>]*>([\s\S]*?)<\/span>/i),
    shop_name: decodeHtml(shopLink.replace(/<[^>]*>/g, "")),
    shop_url: attr(shopLink, "href"),
    category: textByPattern(row, /<td\b[^>]*data-label="分类"[^>]*>([\s\S]*?)<\/td>/i),
    price_text: textByPattern(row, /<td\b[^>]*data-label="价格"[^>]*>([\s\S]*?)<\/td>/i),
    stock_text: textByPattern(row, /<td\b[^>]*data-label="库存"[^>]*>([\s\S]*?)<\/td>/i),
    updated_at: updatedAtMatch ? decodeHtml(updatedAtMatch[2]) : "",
    freshness_class: updatedAtMatch ? decodeHtml(updatedAtMatch[1]) : "",
    history_url: textByPattern(
      row,
      /<a\b[^>]*class="history-link"[^>]*href="([^"]*)"[^>]*>/i,
    ),
    image_url: imageMatch ? decodeHtml(imageMatch[1]) : "",
    duplicate_toggle_text: textByPattern(
      row,
      /<button\b[^>]*class="duplicate-toggle"[^>]*>([\s\S]*?)<\/button>/i,
    ),
  };

  return productSchema.parse(product);
};

export const parseProductsHtml = (html: string): ParsedProductsHtml => {
  const totalProductsMatch = html.match(/([\d,]+)\s*个商品/);
  const tbody = html.match(/<table\b[^>]*class="product-table"[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/i)?.[1] ?? "";

  return {
    totalProducts: totalProductsMatch
      ? Number(totalProductsMatch[1].replace(/,/g, ""))
      : 0,
    shops: parseShops(html),
    products: extractRows(tbody).map(parseProductRow),
  };
};
