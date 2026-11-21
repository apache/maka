import { describe, expect, it } from "vitest";

import { createEventLog } from "./events";

describe("append-only event log", () => {
  it("appends events in order and does not expose mutation APIs", () => {
    const log = createEventLog(":memory:");
    log.append({ type: "inventory.imported", payload: { count: 2 } });
    log.append({ type: "order.created", payload: { id: "o-1" } });

    const events = log.list();
    expect(events.map((event) => event.type)).toEqual(["inventory.imported", "order.created"]);
    expect(events[0]?.payload).toEqual({ count: 2 });
    expect(events[1]?.id).toBe(events[0]!.id + 1);
    expect("update" in log).toBe(false);
    expect("remove" in log).toBe(false);
    expect("clear" in log).toBe(false);
  });
});
