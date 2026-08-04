export interface SessionModelSelection {
  llmConnectionSlug: string;
  model: string;
}

export function normalizeSessionModelSelection(input: unknown): SessionModelSelection {
  if (!input || typeof input !== 'object') {
    throw new Error('Invalid model selection');
  }
  const record = input as Record<string, unknown>;
  const llmConnectionSlug = normalizeRequiredString(record.llmConnectionSlug, 'model connection');
  const model = normalizeRequiredString(record.model, 'model');
  return { llmConnectionSlug, model };
}

function normalizeRequiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid ${label}`);
  }
  return value.trim();
}
