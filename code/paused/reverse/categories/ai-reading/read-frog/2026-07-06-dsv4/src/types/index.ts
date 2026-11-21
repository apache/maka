/**
 * Type definitions for "陪读蛙 (Read Frog - Translate & Learn)" v1.37.2
 *
 * A WXT + React Manifest V3 Chrome extension for web page translation
 * and language learning, powered by 20+ LLM and translation providers.
 *
 * Inferred from the bundled source code via systematic reverse engineering.
 * Schema version: 83 (current as of v1.37.2).
 */

// ============================================================================
// 1. Provider System
// ============================================================================

/**
 * All supported LLM provider identifiers (Vercel AI SDK backend).
 * These providers accept a `model` string and an optional API key.
 */
export type LlmProviderId =
  | 'openai'
  | 'deepseek'
  | 'google'
  | 'anthropic'
  | 'xai'
  | 'openai-compatible'
  | 'siliconflow'
  | 'tensdaq'
  | 'ai302'
  | 'bedrock'
  | 'groq'
  | 'deepinfra'
  | 'mistral'
  | 'togetherai'
  | 'cohere'
  | 'fireworks'
  | 'cerebras'
  | 'replicate'
  | 'perplexity'
  | 'vercel'
  | 'openrouter'
  | 'ollama'
  | 'volcengine'
  | 'minimax';

/**
 * Pure translation provider identifiers (non-LLM, direct translation APIs).
 */
export type PureTranslationProviderId =
  | 'google-translate'
  | 'microsoft-translate'
  | 'deeplx';

/**
 * All provider identifiers union.
 */
export type ProviderId = LlmProviderId | PureTranslationProviderId;

/**
 * High-level provider classification.
 * - `llm`: Providers that accept a model name and generate text via LLM APIs.
 * - `pure-translation`: Providers that offer direct translation endpoints
 *   (no model selection, no LLM).
 */
export type ProviderType = 'llm' | 'pure-translation';

/**
 * Reasoning effort levels for providers that support it
 * (OpenAI, Anthropic, xAI Grok, Google Gemini, DeepSeek, Fireworks, Bedrock).
 */
export type ReasoningEffort =
  | 'provider-default'
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh';

/**
 * Per-provider model configuration.
 */
export interface ModelConfig {
  /** The selected model name (e.g. "gpt-4o", "gemini-2.5-pro"). */
  model: string;
  /** Whether the user entered a custom model string. */
  isCustomModel: boolean;
  /** Custom model string (only meaningful when isCustomModel is true). */
  customModel: string;
}

/**
 * Provider configuration stored in the extension's config.
 * Contains everything the user can configure for a single API provider.
 */
export interface ProviderConfig {
  /** Unique provider instance id (e.g. "openai-default", "google-default"). */
  id: string;
  /** User-visible display name. */
  name: string;
  /** Optional user-supplied description. */
  description?: string;
  /** Backend provider identifier (e.g. "openai", "google", "deeplx"). */
  provider: ProviderId;
  /** API key (can be empty for free/ollama providers). */
  apiKey: string;
  /** Base URL override (empty means use provider default). */
  baseURL: string;
  /** Whether this provider is enabled. */
  enabled: boolean;
  /** Optional custom HTTP headers as JSON object (header-name → header-value). */
  headers?: Record<string, string>;
  /**
   * Optional provider-specific options forwarded to the Vercel AI SDK.
   * JSON object with provider-dependent fields.
   */
  providerOptions?: Record<string, unknown>;
  /**
   * Provider-specific settings (e.g. AWS region for Bedrock).
   * JSON object with structured fields per provider.
   */
  providerSpecificSettings?: Record<string, unknown>;
  /**
   * Reasoning effort level. Only meaningful for LLM providers that
   * support reasoning/thinking (Anthropic, DeepSeek, etc.).
   */
  reasoning?: ReasoningEffort;
  /** Temperature (0-2, LLM-only). */
  temperature?: number;
}

/**
 * Light-weight provider reference used in feature configs.
 * Points to a ProviderConfig by id.
 */
export interface ProviderReference {
  /** The provider instance id used for this feature. */
  providerId: ProviderId | string;
  /** Optional model override for this specific feature. */
  model?: string;
}

// ============================================================================
// 2. Translation System
// ============================================================================

/** Translation display mode for page translation. */
export type TranslationMode = 'bilingual' | 'translationOnly';

/** Translation scope/range selector. */
export type TranslationRange = 'mainContent' | 'all';

/**
 * Token bucket rate limiter configuration for translation requests.
 */
export interface RequestQueueConfig {
  /** Maximum burst size (token bucket capacity). */
  capacity: number;
  /** Refill rate in tokens per second. */
  rate: number;
}

/**
 * Batching configuration controlling how many text nodes
 * are grouped into a single API request.
 */
export interface BatchQueueConfig {
  /** Maximum total characters across all items in one batch. */
  maxCharactersPerBatch: number;
  /** Maximum number of text items in one batch. */
  maxItemsPerBatch: number;
}

/**
 * Preload / viewport intersection configuration for automatic translation.
 */
export interface PreloadConfig {
  /** Margin in pixels around the viewport to start pre-translating. */
  margin: number;
  /** Intersection observer threshold (0-1). Default 0 triggers on first pixel. */
  threshold: number;
}

/**
 * Small paragraph filter — skips very short text nodes.
 */
export interface SmallParagraphFilter {
  /** Minimum characters required per text node to qualify for translation. */
  minCharacters: number;
  /** Minimum words required per text node to qualify for translation. */
  minWords: number;
}

/**
 * Translation node (paragraph-level) hotkey shortcut configuration.
 */
export interface TranslateNodeHotkey {
  /** Modifier key: "Mod" (Ctrl/Cmd), "Alt", "Shift". */
  hotkey: string;
}

/**
 * Per-page translation settings.
 */
export interface PageTranslateConfig {
  /** Translation scope. */
  range: TranslationRange;
  /** URL patterns to auto-translate. */
  autoTranslatePatterns: string[];
  /** URL patterns to never auto-translate. */
  neverAutoTranslatePatterns: string[];
  /** Language codes that should trigger auto-translation. */
  autoTranslateLanguages: string[];
  /** Language codes to skip (keep original). */
  skipLanguages: string[];
  /** Whether to use LLM for skip-language detection. */
  enableSkipLanguagesLLMDetection: boolean;
  /** Whether to use LLM for page language detection. */
  enableLLMDetection: boolean;
  /** Whether to skip the target language (avoid translating to same language). */
  enableTargetLanguageSkip: boolean;
  /** Viewport preload config. */
  preload: PreloadConfig;
  /** Small paragraph filter thresholds. */
  minCharactersPerNode: number;
  /** Small paragraph filter — minimum words per node. */
  minWordsPerNode: number;
  /** Custom translation node hotkey shortcut. */
  shortcut: string;
}

/**
 * Prompt template pattern used for translation.
 */
export interface PromptPattern {
  /** Unique pattern id (e.g. "default"). */
  id: string;
  /** User-visible name. */
  name: string;
  /** System prompt (instructions for the LLM). */
  systemPrompt: string;
  /** User prompt template with `{{input}}`, `{{targetLang}}` tokens. */
  prompt: string;
}

/**
 * Custom prompts configuration (the prompt system detached from legacy promptConfig).
 * Each domain (translate, videoSubtitles) has its own instance.
 */
export interface CustomPromptsConfig {
  /** Active prompt pattern id (null = use built-in default). */
  promptId: string | null;
  /** Available prompt patterns. */
  patterns: PromptPattern[];
}

/**
 * Top-level translation config (page + node translation).
 */
export interface TranslateConfig {
  /** Active translation display mode. */
  mode: TranslationMode;
  /** Keyboard shortcut for toggling translation mode. */
  modeShortcut: string;
  /** The provider id used for translation. */
  providerId: string;
  /** Per-page translation settings. */
  page: PageTranslateConfig;
  /** Per-node translation hotkey. */
  node: TranslateNodeHotkey;
  /** Request rate limiter (token bucket). */
  requestQueueConfig: RequestQueueConfig;
  /** Batch grouping config. */
  batchQueueConfig: BatchQueueConfig;
  /** Translation node style wrapper. */
  translationNodeStyle: TranslationNodeStyle;
  /** Custom prompts for translation. */
  customPromptsConfig: CustomPromptsConfig;
  /** Whether AI content-aware translation (web summary) is enabled. */
  enableAIContentAware: boolean;
}

/**
 * Translation node CSS/visual style.
 */
export interface TranslationNodeStyle {
  /** Preset name (e.g. "default"). */
  preset: string;
  /** Whether user has entered custom CSS. */
  isCustom: boolean;
  /** User-supplied custom CSS string (null if using preset). */
  customCSS: string | null;
}

// ============================================================================
// 3. Read / TTS (Read Aloud) Config
// ============================================================================

/**
 * "Read" feature config — controls text-to-speech for reading web content.
 */
export interface ReadConfig {
  /** The provider id used for read/TTS. */
  providerId: string;
}

// ============================================================================
// 4. Selection Toolbar
// ============================================================================

/**
 * Feature toggle within the selection toolbar.
 */
export interface SelectionToolbarFeature {
  /** Whether this feature is enabled. */
  enabled: boolean;
  /** Provider id used for this feature. */
  providerId?: string;
  /** Optional model override. */
  model?: string;
}

/**
 * Output schema field for custom actions.
 */
export interface OutputSchemaField {
  /** Unique field id. */
  id: string;
  /** Display name. */
  name: string;
  /** Data type. */
  type: 'string' | 'number';
  /** Optional description. */
  description: string;
  /** Whether this field should be spoken aloud. */
  speaking?: boolean;
}

/**
 * Notebase connection configuration for a custom action.
 * Integrates with Read Frog's Notebase cloud service for persistent data storage.
 */
export interface NotebaseConnection {
  /** Notebase table id. */
  notebaseId: string;
  /** Cached table name snapshot. */
  notebaseNameSnapshot: string;
  /** Connected account info. */
  connectedAccount: NotebaseAccount;
  /** Column-level field mappings. */
  mappings: NotebaseMapping[];
}

/**
 * Account info for Notebase connection.
 */
export interface NotebaseAccount {
  /** Display name. */
  name: string;
  /** Email address. */
  email: string;
  /** Profile image URL. */
  image: string | null;
}

/**
 * A single field-to-column mapping for Notebase integration.
 */
export interface NotebaseMapping {
  /** Unique mapping id. */
  id: string;
  /** Local output schema field id. */
  localFieldId: string;
  /** Remote Notebase column id. */
  notebaseColumnId: string;
  /** Cached column name snapshot. */
  notebaseColumnNameSnapshot: string;
}

/**
 * Custom action within the selection toolbar.
 * Each action invokes an LLM with a custom prompt when the user selects text.
 */
export interface CustomAction {
  /** Unique action id. */
  id: string;
  /** Display name. */
  name: string;
  /** Whether this action is enabled. */
  enabled: boolean;
  /** Iconify icon string (e.g. "tabler:book-2"). */
  icon: string;
  /** Provider id used for this action. */
  providerId: string;
  /** System prompt instructions. */
  systemPrompt: string;
  /** User prompt template with `{{selection}}`, `{{context}}`, `{{targetLang}}` tokens. */
  prompt: string;
  /** Output schema defining the fields to extract from the LLM response. */
  outputSchema: OutputSchemaField[];
  /** Optional Notebase integration for persisting results. */
  notebaseConnection?: NotebaseConnection;
}

/**
 * Selection toolbar configuration.
 */
export interface SelectionToolbarConfig {
  /** Master enable/disable toggle. */
  enabled: boolean;
  /** URL patterns where the toolbar should NOT appear. */
  disabledSelectionToolbarPatterns: string[];
  /** Toolbar opacity (0-100). */
  opacity: number;
  /** Feature-level toggles and provider selections. */
  features: SelectionToolbarFeatures;
  /** User-defined custom actions. */
  customActions: CustomAction[];
}

/**
 * Built-in selection toolbar features.
 */
export interface SelectionToolbarFeatures {
  translate: SelectionToolbarTranslateFeature;
  speak: SelectionToolbarSpeakFeature;
  vocabularyInsight: SelectionToolbarFeature;
}

export interface SelectionToolbarTranslateFeature extends SelectionToolbarFeature {
  /** Keyboard shortcut for selection translation (e.g. "Alt+T"). */
  shortcut: string;
}

export interface SelectionToolbarSpeakFeature {
  enabled: boolean;
}

// ============================================================================
// 5. Floating Button
// ============================================================================

/**
 * Floating action button configuration (injected into web pages).
 */
export interface FloatingButtonConfig {
  /** Master enable/disable toggle. */
  enabled: boolean;
  /** URL patterns where the floating button should NOT appear. */
  disabledFloatingButtonPatterns: string[];
  /** Click behavior. */
  clickAction: FloatingButtonClickAction;
  /** Which side of the viewport the button appears on. */
  side: FloatingButtonSide;
  /** Whether the float position is locked (not draggable). */
  locked: boolean;
}

/** Click action for the floating button. */
export type FloatingButtonClickAction = 'panel' | 'translate';

/** Side of the viewport. */
export type FloatingButtonSide = 'left' | 'right';

// ============================================================================
// 6. Video Subtitles (YouTube)
// ============================================================================

/**
 * YouTube video subtitle translation configuration.
 */
export interface VideoSubtitlesConfig {
  /** Master enable/disable toggle. */
  enabled: boolean;
  /** Whether to auto-start subtitle translation when a video loads. */
  autoStart: boolean;
  /** Provider id used for subtitle translation. */
  providerId: string;
  /** Request rate limiter. */
  requestQueueConfig: RequestQueueConfig;
  /** Batch grouping config. */
  batchQueueConfig: BatchQueueConfig;
  /** Visual style of rendered subtitles. */
  style: VideoSubtitlesStyle;
  /** Whether AI-based subtitle segmentation is enabled. */
  aiSegmentation: boolean;
  /** Custom prompts for subtitle translation. */
  customPromptsConfig: CustomPromptsConfig;
  /** Floating position of subtitles on screen. */
  position: VideoSubtitlesPosition;
}

/**
 * Video subtitle visual style.
 */
export interface VideoSubtitlesStyle {
  /** How to display the subtitles. */
  displayMode: VideoSubtitlesDisplayMode;
  /** Where to place translated text relative to original. */
  translationPosition: 'above' | 'below';
  /** Style for the original-language subtitle. */
  main: VideoSubtitleTextStyle;
  /** Style for the translated subtitle. */
  translation: VideoSubtitleTextStyle;
  /** Style for the container element. */
  container: VideoSubtitleContainerStyle;
}

export type VideoSubtitlesDisplayMode = 'bilingual' | 'originalOnly' | 'translationOnly';

export interface VideoSubtitleTextStyle {
  /** CSS font-family value ("system" or a specific font). */
  fontFamily: string;
  /** Font size scale as percentage (100 = default). */
  fontScale: number;
  /** CSS color value (hex). */
  color: string;
  /** CSS font-weight (400, 700, etc.). */
  fontWeight: number;
}

export interface VideoSubtitleContainerStyle {
  /** Background opacity percentage (0-100). 75 = 75% opaque. */
  backgroundOpacity: number;
}

/**
 * Video subtitle position on the video viewport.
 */
export interface VideoSubtitlesPosition {
  /** Position from the bottom edge as percentage of viewport height. */
  percent: number;
  /** Anchor point for positioning. */
  anchor: 'bottom';
}

// ============================================================================
// 7. Text-to-Speech
// ============================================================================

/**
 * Text-to-speech configuration using Edge TTS (Microsoft Edge Read Aloud).
 */
export interface TtsConfig {
  /** Provider id used for TTS. */
  providerId: string | null;
  /** Default voice name (Edge TTS ShortName, e.g. "en-US-GuyNeural"). */
  defaultVoice: string;
  /** Language-to-voice mapping (language code → Edge TTS voice name). */
  languageVoices: Record<string, string>;
  /** Speech rate (-100 to 100, 0 = normal). */
  rate: number;
  /** Speech pitch (-100 to 100, 0 = normal). */
  pitch: number;
  /** Speech volume (-100 to 100, 0 = normal). */
  volume: number;
  /** Language detection mode for TTS. */
  detectLanguageMode: LanguageDetectionMode;
}

// ============================================================================
// 8. Site Control
// ============================================================================

/**
 * Site access control — determines which websites the extension operates on.
 */
export interface SiteControlConfig {
  /**
   * Access mode.
   * - `blacklist`: enabled on all sites except listed patterns.
   * - `whitelist`: enabled only on listed patterns.
   */
  mode: 'blacklist' | 'whitelist';
  /** URL patterns for the active mode. */
  patterns: string[];
}

// ============================================================================
// 9. Input Translation
// ============================================================================

/**
 * Input field translation configuration (in-place translation in text fields).
 */
export interface InputTranslationConfig {
  /** Master enable/disable toggle. */
  enabled: boolean;
  /** Provider id used for input translation. */
  providerId: string;
  /** Source language direction. */
  fromLang: InputTranslationLanguage;
  /** Target language direction. */
  toLang: InputTranslationLanguage;
  /** Whether to cycle source/target direction. */
  enableCycle: boolean;
  /** Idle time threshold in milliseconds before triggering translation (100-1000). */
  timeThreshold: number;
}

/**
 * Language direction for input translation.
 * "sourceCode" = use global source language.
 * "targetCode" = use global target language.
 * Otherwise, a specific ISO 639-3 language code.
 */
export type InputTranslationLanguage = 'sourceCode' | 'targetCode' | string;

// ============================================================================
// 10. Language
// ============================================================================

/**
 * Global language configuration.
 */
export interface LanguageConfig {
  /** Source language ISO 639-3 code (e.g. "eng", "cmn"). "auto" for auto-detect. */
  sourceCode: string;
  /** Target language ISO 639-3 code (e.g. "eng", "spa"). */
  targetCode: string;
  /** User's language proficiency level. */
  languageLevel: LanguageLevel;
}

/** Language proficiency levels for tailoring AI explanations. */
export type LanguageLevel = 'beginner' | 'intermediate' | 'advanced';

/** Language detection mode. */
export type LanguageDetectionMode = 'basic' | 'llm';

// ============================================================================
// 11. Language Detection (Global)
// ============================================================================

/**
 * Global language detection settings.
 */
export interface LanguageDetectionConfig {
  /** Detection mode. */
  mode: LanguageDetectionMode;
  /** Provider id used when mode is 'llm'. */
  providerId: string | null;
}

// ============================================================================
// 12. Context Menu
// ============================================================================

/**
 * Right-click context menu configuration.
 */
export interface ContextMenuConfig {
  /** Whether context menu items are enabled. */
  enabled: boolean;
}

// ============================================================================
// 13. Beta Experience
// ============================================================================

/**
 * Beta / experimental feature gate.
 */
export interface BetaExperienceConfig {
  /** Whether beta features are enabled. */
  enabled: boolean;
}

// ============================================================================
// 14. Analytics
// ============================================================================

/**
 * Privacy-preserving analytics configuration.
 */
export interface AnalyticsConfig {
  /** Whether analytics data collection is enabled. */
  enabled: boolean;
}

// ============================================================================
// 15. Complete Config Schema (Root)
// ============================================================================

/**
 * The full extension configuration object — the root of all settings.
 * Persisted to chrome.storage.local and synced to Google Drive.
 * Schema version: 83.
 */
export interface ReadFrogConfig {
  /** Array of configured API providers. */
  providersConfig: ProviderConfig[];
  /** Page and node translation settings. */
  translate: TranslateConfig;
  /** Read / text-to-speech provider assignment. */
  read: ReadConfig;
  /** Selection toolbar configuration. */
  selectionToolbar: SelectionToolbarConfig;
  /** Floating button configuration. */
  floatingButton: FloatingButtonConfig;
  /** YouTube video subtitle translation. */
  videoSubtitles: VideoSubtitlesConfig;
  /** Text-to-speech voice and rate settings. */
  tts: TtsConfig;
  /** Global language preferences. */
  language: LanguageConfig;
  /** Site access control (blacklist/whitelist). */
  siteControl: SiteControlConfig;
  /** Input field translation. */
  inputTranslation: InputTranslationConfig;
  /** Right-click context menu. */
  contextMenu: ContextMenuConfig;
  /** Beta experience opt-in. */
  betaExperience: BetaExperienceConfig;
  /** Global language detection settings. */
  languageDetection: LanguageDetectionConfig;
}

// ============================================================================
// 16. Config Sync (Google Drive)
// ============================================================================

/**
 * OAuth 2.0 token for Google Drive sync.
 */
export interface OAuthToken {
  /** Access token string. */
  access_token: string;
  /** Expiration timestamp in milliseconds since epoch. */
  expires_at: number;
  /** Token type (always "Bearer"). */
  token_type: string;
}

/**
 * User info returned from Google OAuth.
 */
export interface GoogleUserInfo {
  /** Google account unique id. */
  id: string;
  /** Email address. */
  email: string;
  /** Profile picture URL. */
  picture: string;
  /** Whether the email is verified. */
  verified_email: boolean;
}

/**
 * Sync metadata stored alongside the config.
 */
export interface SyncMetadata {
  /** ISO timestamp of the last successful sync. */
  lastSyncedAt: number;
  /** ISO timestamp of the last local or remote modification. */
  lastModifiedAt: number;
  /** Email of the Google account used for sync. */
  email: string;
  /** Config schema version at time of sync. */
  schemaVersion: number;
}

/**
 * Conflict resolution entry — maps a config path to the chosen resolution.
 */
export interface ConflictResolutions {
  /** Dot-separated config path → resolution direction. */
  [path: string]: 'local' | 'remote';
}

/**
 * A single conflict between local and remote config values.
 */
export interface SyncConflict {
  /** Dot-separated config path. */
  path: string[];
  /** The common ancestor value. */
  baseValue: unknown;
  /** Current local value. */
  localValue: unknown;
  /** Current remote value. */
  remoteValue: unknown;
}

/**
 * Result of a three-way merge attempt.
 */
export interface MergeResult {
  /** The merged draft config. */
  draft: ReadFrogConfig;
  /** Detected conflicts that need manual resolution. */
  conflicts: SyncConflict[];
}

/**
 * Possible outcomes of a Google Drive sync operation.
 */
export interface SyncResult {
  status: 'success' | 'unresolved' | 'error';
  /** For success, which direction won. */
  action?: 'uploaded' | 'downloaded' | 'same-changes' | 'no-change';
  /** For unresolved conflicts, the base/local/remote data. */
  data?: {
    base: ReadFrogConfig;
    local: ReadFrogConfig;
    remote: ReadFrogConfig;
  };
  /** For error outcomes. */
  error?: Error;
}

// ============================================================================
// 17. Config Backup
// ============================================================================

/**
 * A single config backup entry.
 */
export interface ConfigBackup {
  /** Unique backup id. */
  id: string;
  /** Config schema version at time of backup. */
  schemaVersion: number;
  /** The full config payload. */
  config: ReadFrogConfig;
  /** Backup metadata. */
  metadata: ConfigBackupMetadata;
}

/**
 * Metadata stored with each config backup.
 */
export interface ConfigBackupMetadata {
  /** Timestamp of backup creation. */
  createdAt: number;
  /** Extension version at time of backup. */
  extensionVersion: string;
}

// ============================================================================
// 18. Messages (Internal Extension Messaging)
// ============================================================================

/**
 * Message types used in the WXT-based extension messaging system.
 */
export type MessageType =
  | 'translate'
  | 'speak'
  | 'getSelection'
  | 'toggleTranslation'
  | 'openOptions'
  | 'openSidePanel'
  | 'backgroundFetch'
  | 'updateBadge'
  | 'trackAnalytics';

/**
 * Base structure for all extension messages.
 * Uses WXT's messaging infrastructure with type+timestamp envelope.
 */
export interface ExtensionMessage {
  /** Unique message id (auto-generated). */
  id: number;
  /** Message type discriminator. */
  type: MessageType | string;
  /** Message payload — varies by type. */
  data: unknown;
  /** Timestamp in milliseconds since epoch. */
  timestamp: number;
}

/**
 * Message handler registration return type.
 * Returns a cleanup function to remove the listener.
 */
export type MessageHandlerCleanup = () => void;

// ============================================================================
// 19. Runtime / Per-Tab State
// ============================================================================

/**
 * Per-tab runtime state tracked by the extension.
 */
export interface TabRuntimeState {
  /** Whether the extension is enabled for this tab. */
  enabled: boolean;
  /** Whether a translation is currently in progress. */
  isTranslating: boolean;
  /** Detected language of the page content. */
  detectedLanguage?: string;
  /** The tab's URL pattern match against site control rules. */
  siteControlMatch?: boolean;
}

// ============================================================================
// 20. Language Data
// ============================================================================

/**
 * ISO 639-3 language code with display name.
 */
export interface LanguageInfo {
  /** ISO 639-3 code (e.g. "eng", "cmn"). */
  code: string;
  /** Display name in the current locale. */
  name: string;
  /** Native script name. */
  nativeName: string;
}

/**
 * Edge TTS voice mapping.
 * Key is ISO 639-3 language code, value is Edge TTS ShortName.
 * Examples:
 * - "eng" → "en-US-GuyNeural"
 * - "cmn" → "zh-CN-YunxiNeural"
 * - "jpn" → "ja-JP-KeitaNeural"
 */
export type LanguageVoiceMap = Record<string, string>;

// ============================================================================
// 21. Schema Migration
// ============================================================================

/**
 * Config migration function signature.
 * Takes the config at schema version N and returns the config at version N+1.
 */
export type MigrationFn = (config: ReadFrogConfig) => ReadFrogConfig;

/**
 * Maps schema version (e.g. 1 → migrate v1→v2 function).
 */
export type MigrationMap = Map<number, MigrationFn>;

/** The current (latest) config schema version. */
export const CURRENT_SCHEMA_VERSION = 83;

// ============================================================================
// 22. Provider Metadata (Static Registry)
// ============================================================================

/**
 * Static provider metadata — UI display information for a provider type.
 * Not stored in config; determined at build time / bundled code.
 */
export interface ProviderMetadata {
  /** Backend provider identifier. */
  provider: ProviderId;
  /** User-facing display name. */
  name: string;
  /** Provider website URL. */
  website: string;
  /** Logo component (function of theme). */
  logo: string;
  /** Provider homepage URL for documentation. */
  homepage?: string;
  /** Whether this is an LLM-style provider (has model selection). */
  isLLM: boolean;
  /** Sponsorship info if applicable. */
  sponsor?: ProviderSponsorInfo;
}

/**
 * Sponsor information for a provider.
 */
export interface ProviderSponsorInfo {
  /** Whether this provider is currently sponsored. */
  sponsoring: boolean;
  /** Referral/CTA URL for the sponsor. */
  referUrl: string;
}

// ============================================================================
// 23. Provider Helper Types
// ============================================================================

/**
 * Identifies which features use a specific provider.
 * Used in the UI to prevent disabling a provider that is in use.
 */
export interface ProviderFeatureUsage {
  /** Translation feature uses this provider. */
  translate: boolean;
  /** Read (TTS) feature uses this provider. */
  read: boolean;
  /** Selection toolbar vocabulary insight uses this provider. */
  vocabularyInsight: boolean;
  /** Language detection uses this provider. */
  languageDetection: boolean;
  /** Custom actions using this provider (by action id). */
  customActions: string[];
}

// ============================================================================
// 24. API / Network Types
// ============================================================================

/**
 * Background fetch proxy request — sent from content scripts
 * to the background service worker to bypass CORS.
 */
export interface BackgroundFetchRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  credentials: RequestCredentials;
  redirect: RequestRedirect;
}

/**
 * Background fetch proxy response.
 */
export interface BackgroundFetchResponse {
  body: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
}

/**
 * API model list response from OpenAI-compatible /v1/models endpoint.
 */
export interface ApiModelsResponse {
  data: ApiModelInfo[];
}

export interface ApiModelInfo {
  id: string;
}

// ============================================================================
// 25. Shortcut / Hotkey Types
// ============================================================================

/**
 * Parsed keyboard shortcut representation.
 * Modifier keys use "Mod" (Ctrl on Windows/Linux, Cmd on macOS).
 */
export interface KeyboardShortcut {
  /** Mod/Ctrl/Cmd key present. */
  mod: boolean;
  /** Alt/Option key present. */
  alt: boolean;
  /** Shift key present. */
  shift: boolean;
  /** The primary key character or name (e.g. "T", "ArrowDown", "Escape"). */
  key: string;
}

/**
 * Custom auto-translate shortcut key configuration.
 * Stored as an array of modifier+key strings, e.g. ["alt", "q"].
 */
export type ShortcutKeyArray = string[];

// ============================================================================
// 26. Error Types
// ============================================================================

/**
 * Thrown when the config schema version from sync is newer than what
 * the current extension version supports.
 */
export class ConfigVersionTooNewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigVersionTooNewError';
  }
}

// ============================================================================
// 27. Storage Keys
// ============================================================================

/**
 * Well-known chrome.storage.local keys used by the extension.
 */
export const STORAGE_KEYS = {
  /** Primary config storage key. */
  CONFIG: 'local:config',
  /** Sync metadata key. */
  SYNC_META: 'local:syncMeta',
  /** OAuth token key. */
  OAUTH_TOKEN: 'local:oauthToken',
  /** Backup id list key. */
  BACKUP_IDS: 'local:backup_ids',
  /** Backup entry prefix (followed by backup id). */
  BACKUP_PREFIX: 'local:backup_',
  /** Google Drive config file name in appDataFolder. */
  DRIVE_CONFIG_FILE: 'read-frog-config.json',
} as const;

// ============================================================================
// 28. OAuth / Google Drive Constants
// ============================================================================

/**
 * Google Drive OAuth configuration.
 */
export const OAUTH_CONFIG = {
  /** OAuth 2.0 scopes for Google Drive appData access + user info. */
  SCOPES: [
    'https://www.googleapis.com/auth/drive.appdata',
    'https://www.googleapis.com/auth/userinfo.email',
  ],
  /** Google Drive API base URL. */
  DRIVE_API_BASE: 'https://www.googleapis.com/drive/v3',
  /** Google Drive upload API base URL. */
  DRIVE_UPLOAD_BASE: 'https://www.googleapis.com/upload/drive/v3',
  /** Token refresh buffer (60 seconds before expiry). */
  TOKEN_REFRESH_BUFFER_MS: 60_000,
} as const;

// ============================================================================
// 29. NoteBase API Types
// ============================================================================

/**
 * A NoteBase table as returned from the API.
 */
export interface NoteBaseTable {
  /** Table id. */
  id: string;
  /** Table name. */
  name: string;
  /** Column definitions. */
  notebaseColumns: NoteBaseColumn[];
}

/**
 * A NoteBase column definition.
 */
export interface NoteBaseColumn {
  /** Column id. */
  id: string;
  /** Column name. */
  name: string;
  /** Column configuration/type info. */
  config: NoteBaseColumnConfig;
}

/**
 * NoteBase column type configuration.
 */
export interface NoteBaseColumnConfig {
  /** The column data type. */
  type: string;
}

// ============================================================================
// 30. URL Pattern Utilities
// ============================================================================

/**
 * Validates whether a string is a valid HTTPS URL.
 */
export type UrlValidator = (url: string) => boolean;

/**
 * Extracts the hostname from a URL string.
 */
export type HostnameExtractor = (url: string) => string | null;

/**
 * Checks if a URL matches a hostname/domain pattern.
 */
export type HostnameMatcher = (url: string, pattern: string) => boolean;
