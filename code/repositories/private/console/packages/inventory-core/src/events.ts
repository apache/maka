import { DatabaseSync } from "node:sqlite";

export type ToolkitEvent = {
  id: number;
  type: string;
  payload: unknown;
};

export type EventLog = {
  append: (event: { type: string; payload: unknown }) => ToolkitEvent;
  list: () => ToolkitEvent[];
};

export function createEventLog(dbPath: string): EventLog {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      payload TEXT NOT NULL
    )
  `);

  const insert = db.prepare("INSERT INTO events (type, payload) VALUES (?, ?)");
  const selectAll = db.prepare("SELECT id, type, payload FROM events ORDER BY id ASC");

  return {
    append(event) {
      const result = insert.run(event.type, JSON.stringify(event.payload));
      return {
        id: Number(result.lastInsertRowid),
        type: event.type,
        payload: event.payload,
      };
    },
    list() {
      return selectAll.all().map((row) => {
        const record = row as { id: number; type: string; payload: string };
        return {
          id: Number(record.id),
          type: record.type,
          payload: JSON.parse(record.payload) as unknown,
        };
      });
    },
  };
}
