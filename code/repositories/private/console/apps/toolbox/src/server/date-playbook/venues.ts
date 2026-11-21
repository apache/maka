import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { venueSchema, type Venue, type VenueFilter } from "@/schemas/venue";
import { VENUE_SEED } from "./venues-seed";

// 约会攻略数据域唯一入口：node:sqlite，venues 单表，空库自动建表播种。
// db 参数注入是测试面（:memory: 内存库可全链路验证）。

interface VenueRow {
  id: string;
  name: string;
  category: string;
  sub_category: string | null;
  address: string;
  area: string;
  signature_items: string;
  highlights: string;
  suitable_scenes: string;
  review_summary: string | null;
  booking_note: string | null;
  ticket_price_text: string | null;
  booking_level: string;
  is_indoor: number;
  is_free: number;
  time_tags: string;
  weather_tags: string;
  verify_status: string;
  favorite: number;
  source_note: string;
}

function rowToVenue(row: VenueRow): Venue {
  return venueSchema.parse({
    id: row.id,
    name: row.name,
    category: row.category,
    subCategory: row.sub_category ?? undefined,
    address: row.address,
    area: row.area,
    signatureItems: JSON.parse(row.signature_items) as string[],
    highlights: JSON.parse(row.highlights) as string[],
    suitableScenes: JSON.parse(row.suitable_scenes) as string[],
    reviewSummary: row.review_summary ?? undefined,
    bookingNote: row.booking_note ?? undefined,
    ticketPriceText: row.ticket_price_text ?? undefined,
    bookingLevel: row.booking_level,
    isIndoor: row.is_indoor === 1,
    isFree: row.is_free === 1,
    timeTags: JSON.parse(row.time_tags) as string[],
    weatherTags: JSON.parse(row.weather_tags) as string[],
    verifyStatus: row.verify_status,
    favorite: row.favorite === 1,
    sourceNote: row.source_note,
  });
}

export function createVenueRepo(db: DatabaseSync) {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS venues (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      sub_category TEXT,
      address TEXT NOT NULL,
      area TEXT NOT NULL,
      signature_items TEXT NOT NULL,
      highlights TEXT NOT NULL,
      suitable_scenes TEXT NOT NULL,
      review_summary TEXT,
      booking_note TEXT,
      ticket_price_text TEXT,
      booking_level TEXT NOT NULL,
      is_indoor INTEGER NOT NULL,
      is_free INTEGER NOT NULL,
      time_tags TEXT NOT NULL,
      weather_tags TEXT NOT NULL,
      verify_status TEXT NOT NULL,
      favorite INTEGER NOT NULL DEFAULT 0,
      source_note TEXT NOT NULL
    );
  `);
  // 老库补列（幂等）：源 Venue 详情字段
  for (const ddl of ["booking_note TEXT", "ticket_price_text TEXT"]) {
    const col = ddl.split(" ")[0];
    const cols = db.prepare("PRAGMA table_info(venues)").all() as unknown as Array<{ name: string }>;
    if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE venues ADD COLUMN ${ddl};`);
  }

  const count = db.prepare("SELECT COUNT(*) AS n FROM venues").get() as { n: number };
  if (count.n === 0) {
    const insert = db.prepare(`
      INSERT INTO venues (id, name, category, sub_category, address, area, signature_items, highlights,
                          suitable_scenes, review_summary, booking_note, ticket_price_text,
                          booking_level, is_indoor, is_free,
                          time_tags, weather_tags, verify_status, source_note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const v of VENUE_SEED) {
      const venue = venueSchema.parse({ ...v, favorite: false });
      insert.run(
        venue.id,
        venue.name,
        venue.category,
        venue.subCategory ?? null,
        venue.address,
        venue.area,
        JSON.stringify(venue.signatureItems),
        JSON.stringify(venue.highlights),
        JSON.stringify(venue.suitableScenes),
        venue.reviewSummary ?? null,
        venue.bookingNote ?? null,
        venue.ticketPriceText ?? null,
        venue.bookingLevel,
        venue.isIndoor ? 1 : 0,
        venue.isFree ? 1 : 0,
        JSON.stringify(venue.timeTags),
        JSON.stringify(venue.weatherTags),
        venue.verifyStatus,
        venue.sourceNote,
      );
    }
  }

  return {
    /** 列表（含筛选），插入序稳定 */
    list(filter: VenueFilter = {}): { items: Venue[]; total: number } {
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (filter.category) {
        where.push("category = ?");
        params.push(filter.category);
      }
      if (filter.scene) {
        where.push("suitable_scenes LIKE ?");
        params.push(`%"${filter.scene}"%`);
      }
      if (filter.onlyFavorite) {
        where.push("favorite = 1");
      }
      const sql = `SELECT * FROM venues ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
      const rows = db.prepare(sql).all(...params) as unknown as VenueRow[];
      const items = rows.map(rowToVenue);
      return { items, total: items.length };
    },

    /** 单个地点（详情页用）；不存在返回 undefined */
    getVenue(id: string): Venue | undefined {
      const row = db.prepare("SELECT * FROM venues WHERE id = ?").get(id) as VenueRow | undefined;
      return row ? rowToVenue(row) : undefined;
    },

    /** 收藏切换，返回新状态；地点不存在抛错 */
    toggleFavorite(id: string): boolean {
      const row = db.prepare("SELECT favorite FROM venues WHERE id = ?").get(id) as
        | { favorite: number }
        | undefined;
      if (!row) throw new Error(`地点不存在：${id}`);
      const next = row.favorite === 1 ? 0 : 1;
      db.prepare("UPDATE venues SET favorite = ? WHERE id = ?").run(next, id);
      return next === 1;
    },
  };
}

/** 应用侧单例：与 couple 共用 blogDb 连接 */
import { blogDb } from "./db";
export const venueRepo = createVenueRepo(blogDb);
