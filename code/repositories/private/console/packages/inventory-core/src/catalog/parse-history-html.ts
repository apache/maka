import { historyPayloadSchema } from "./schemas";
import type { HistoryPayload } from "./types";

export const parseHistoryHtml = (html: string): HistoryPayload => {
  const match = html.match(/var payload = (\{[\s\S]*?\});/);

  if (!match) {
    throw new Error("History payload was not found in fixture HTML.");
  }

  return historyPayloadSchema.parse(JSON.parse(match[1]));
};
