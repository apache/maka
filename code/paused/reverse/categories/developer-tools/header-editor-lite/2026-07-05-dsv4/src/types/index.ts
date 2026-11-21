// ============================================================
// Header Editor Lite - TypeScript Type Definitions
// Generated from reverse engineering v5.2.12 (MV3)
// ============================================================

// ---- Rule Table Names (IndexedDB object stores) ----

export type RuleTableName = 'request' | 'sendHeader' | 'receiveHeader' | 'receiveBody';

export const RULE_TABLES: readonly RuleTableName[] = [
  'request',
  'sendHeader',
  'receiveHeader',
  'receiveBody',
] as const;

// ---- Rule Types (determines which IndexedDB store to use) ----

export enum RuleType {
  CANCEL = 'cancel',
  REDIRECT = 'redirect',
  MODIFY_SEND_HEADER = 'modifySendHeader',
  MODIFY_RECV_HEADER = 'modifyReceiveHeader',
  MODIFY_RECV_BODY = 'modifyReceiveBody',
}

// ---- Stage (which phase of the request lifecycle) ----

export enum Stage {
  REQUEST = 'request',
  SEND_HEADER = 'sendHeader',
  RECEIVE_HEADER = 'receiveHeader',
  RECEIVE_BODY = 'receiveBody',
}

// ---- Match Types ----

export enum MatchType {
  ALL = 'all',
  REGEXP = 'regexp',
  PREFIX = 'prefix',
  DOMAIN = 'domain',
  URL = 'url',
  METHOD = 'method',
  RESOURCE_TYPE = 'resourceType',
}

// ---- Match Result ----

export enum MatchResult {
  MATCH = 0,
  MATCH_BUT_EXCLUDE = 1,
  NOT_MATCH = 2,
}

// ---- Run Mode (how the rule is executed) ----

export type RunMode = 'dnr' | 'web_request';

// ---- HTTP Methods ----

export const HTTP_METHODS = [
  'get', 'post', 'put', 'delete', 'patch',
  'options', 'head', 'trace', 'connect',
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

// ---- Resource Types (declarativeNetRequest compatible) ----

export const RESOURCE_TYPES = [
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'other',
] as const;

export type ResourceType = (typeof RESOURCE_TYPES)[number];

// ---- Response Body Stage ----

export type BodyStage = 'Request' | 'Response';

// ---- Rule Condition ----

export interface RuleCondition {
  /** All URLs match */
  all?: boolean;
  /** Exact URL match */
  url?: string;
  /** URL prefix match */
  urlPrefix?: string;
  /** Regex match (stored as string, compiled to RegExp at runtime) */
  regex?: string;
  /** Domain array match */
  domain?: string[];
  /** HTTP methods to match */
  method?: HttpMethod[];
  /** Resource types to match */
  resourceTypes?: ResourceType[];
  /** Excluded domains */
  excludeDomain?: string[];
  /** Excluded regex pattern */
  excludeRegex?: string;
  /** Excluded HTTP methods */
  excludeMethod?: HttpMethod[];
  /** Excluded resource types */
  excludeResourceTypes?: ResourceType[];
}

// ---- Headers Dictionary ----

export interface HeadersDict {
  [headerName: string]: string;
}

// ---- Response Body Config ----

export interface BodyConfig {
  /** The replacement body content (or code if isFunction) */
  value?: string;
  /** Which stage to apply (Request or Response) */
  stage?: BodyStage;
}

// ---- Edit Header Entry (for the form UI) ----

export interface EditHeaderEntry {
  name: string;
  value: string;
}

// ---- Core Rule Object (as stored in IndexedDB) ----

export interface Rule {
  /** Auto-increment ID from IndexedDB */
  id?: number;
  /** Human-readable name */
  name: string;
  /** Rule type */
  ruleType: RuleType;
  /** Whether the rule is enabled */
  enable: boolean;
  /** Group name (defaults to "ungrouped") */
  group: string;
  /** Whether this is a custom-function rule (lite version: always false) */
  isFunction: boolean;
  /** Custom function code (lite version: not supported) */
  code?: string;
  /** Match condition */
  condition?: RuleCondition;
  /** Header modifications (key = header name, value = header value) */
  headers?: HeadersDict;
  /** Redirect target URL */
  to?: string;
  /** Response body modification config */
  body?: BodyConfig;
  /** Character encoding for body decode */
  encoding?: string;
  /** Force a specific runner (auto, dnr, web_request) */
  forceRunner?: string;

  // Legacy compat fields (normalized on import)
  matchType?: MatchType;
  pattern?: string;
  exclude?: string;
  action?: {
    name: string;
    value: string;
  };

  // Runtime-only fields (not persisted)
  /** Computed runner mode */
  _runner?: RunMode;
  /** Compiled regex from condition.regex */
  _reg?: RegExp;
  /** Compiled exclude regex from condition.excludeRegex */
  _exclude?: RegExp;
  /** Compiled re2 regex for DNR mode */
  _re2?: unknown;
  /** Cached function reference */
  _func?: (...args: unknown[]) => unknown;
  /** Virtual key for React rendering */
  _v_key?: string;
}

// ---- Rule with required virtual key (for UI rendering) ----

export type RuleWithKey = Rule & { _v_key: string };

// ---- Export Format (rules grouped by table) ----

export interface ExportData {
  request: Rule[];
  sendHeader: Rule[];
  receiveHeader: Rule[];
  receiveBody: Rule[];
}

// ---- Cloud Backup Data ----

export interface CloudBackupEntry {
  time: number;
  index: number;
}

export interface CloudBackupData {
  backup: CloudBackupEntry | null;
  [key: `backup_${number}`]: ExportData;
}

// ---- User Preferences / Settings ----

export interface Preferences {
  /** Master disable-all switch */
  'disable-all': boolean;
  /** Collapse groups by default in manage view */
  'manage-collapse-group': boolean;
  /** Exclude Header Editor URLs from matching */
  'exclude-he': boolean;
  /** Display common header name suggestions */
  'show-common-header': boolean;
  /** Include request headers in custom function (performance cost) */
  'include-headers': boolean;
  /** Enable response body modification (performance cost) */
  'modify-body': boolean;
  /** Enable debug logging */
  'is-debug': boolean;
  /** Dark mode setting */
  'dark-mode': 'auto' | 'on' | 'off';
  /** Enable rule quick switching */
  'rule-switch': boolean;
  /** Auto-record rule history for quick switch */
  'rule-history': boolean;
  /** Show quick edit button on popup */
  'quick-edit': boolean;
  /** Which rules to show on popup (common = starred only, all = everything) */
  'popup-show-rules': 'common' | 'all';
  /** Where to show quick rule preview tooltips */
  'show-quick-preview': ('popup' | 'manage')[];
}

export const DEFAULT_PREFERENCES: Preferences = {
  'disable-all': false,
  'manage-collapse-group': true,
  'exclude-he': true,
  'show-common-header': true,
  'include-headers': false,
  'modify-body': false,
  'is-debug': false,
  'dark-mode': 'auto',
  'rule-switch': true,
  'rule-history': true,
  'quick-edit': true,
  'popup-show-rules': 'common',
  'show-quick-preview': ['popup', 'manage'],
};

// ---- Message API (runtime.sendMessage protocol) ----

export enum MessageMethod {
  HEALTH_CHECK = 'check',
  OPEN_URL = 'open_url',
  GET_RULES = 'get_rules',
  SAVE_RULE = 'save_rule',
  DELETE_RULE = 'del_rule',
  UPDATE_CACHE = 'update_cache',
  SET_PREFS = 'set_pref',
  ON_EVENT = 'event',
}

export enum EventType {
  RULE_UPDATE = 'rule_update',
  RULE_DELETE = 'rule_delete',
}

export interface MessageRequest {
  method: MessageMethod | string;
  /** When method is 'notifyBackground', the actual method name */
  reason?: string;
}

export interface HealthCheckRequest extends MessageRequest {
  method: MessageMethod.HEALTH_CHECK;
}

export interface OpenUrlRequest {
  method: MessageMethod.OPEN_URL;
  url: string;
  active?: boolean;
}

export interface GetRulesRequest extends MessageRequest {
  method: MessageMethod.GET_RULES;
  type: RuleTableName;
  options?: {
    id?: number | number[];
    group?: string;
    enable?: boolean;
    type?: RuleType;
    name?: string;
    method?: HttpMethod;
    url?: string;
    resourceType?: ResourceType;
    runner?: RunMode;
  };
}

export interface SaveRuleRequest extends MessageRequest {
  method: MessageMethod.SAVE_RULE;
  rule: Rule;
}

export interface DeleteRuleRequest extends MessageRequest {
  method: MessageMethod.DELETE_RULE;
  type: RuleTableName;
  id: number;
}

export interface SetPrefsRequest extends MessageRequest {
  method: MessageMethod.SET_PREFS;
  key: keyof Preferences;
  value: Preferences[keyof Preferences];
}

export interface UpdateCacheRequest extends MessageRequest {
  method: MessageMethod.UPDATE_CACHE;
  type: RuleTableName | 'all';
}

export interface OnEventRequest extends MessageRequest {
  method: MessageMethod.ON_EVENT;
  event: EventType;
  [key: string]: unknown;
}

export interface BatchExecuteRequest {
  method: 'batchExecute';
  batch: MessageRequest[];
}

// ---- Grouped Rules (for UI display) ----

export interface GroupedRules {
  [groupName: string]: RuleWithKey[];
}

// ---- Notification Message ----

export interface NotificationMessage {
  id: string;
  type: 'warning' | 'success' | 'info' | 'error';
  title: string;
  content: string;
  more?: string;
  time: number;
}

// ---- Quick Switch History Entry ----

export interface SwitchHistoryEntry {
  [headerName: string]: string;
}

// ---- Common Rule Entry (starred rules) ----

export type CommonRuleKey = string; // format: "{tableName}-{ruleId}"

// ---- i18n Message Function ----

export type I18nFunction = (
  key: string,
  substitutions?: Record<string, string>,
  fallback?: string
) => string;
