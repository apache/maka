export function isInferenceAdmissionEvent(
  event: Record<string, unknown>,
  anthropic: boolean,
): boolean {
  if (anthropic && event.type === 'message_start' && isRecord(event.message)) return true;
  if (
    typeof event.type === 'string' &&
    (event.type === 'response.created' ||
      event.type === 'response.in_progress' ||
      event.type === 'response.output_item.added' ||
      event.type === 'response.completed')
  ) {
    return true;
  }
  if (Array.isArray(event.choices)) return true;
  for (const candidate of [event, event.response, event.message]) {
    if (isRecord(candidate) && isRecord(candidate.usage)) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
