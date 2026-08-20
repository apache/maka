/**
 * Desktop compatibility facade for the shared local transcript search.
 * Runtime Host Agent tools and the Desktop search modal intentionally use the
 * same bounded, redacted implementation.
 */
export {
  MAX_SESSIONS_SCANNED,
  SNIPPET_CONTEXT_HALF,
  SNIPPET_MAX_CODE_POINTS,
  THREAD_SOURCE,
  TOOL_RESULT_SCAN_CAP_BYTES,
  TOTAL_PAYLOAD_CAP_BYTES,
  buildSnippet,
  capCodePoints,
  collectSearchableText,
  findMatch,
  foldForMatch,
  formatSearchResultSummary,
  runThreadSearch,
  threadSearchMatchKind,
  type ThreadSearchDeps,
  type ThreadSearchSuccess,
} from '@maka/core/thread-search';
