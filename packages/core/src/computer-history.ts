export type ComputerHistoryRuntimeState =
  | 'unsupported'
  | 'stopped'
  | 'running'
  | 'paused'
  | 'needs_permission'
  | 'unavailable'
  | 'error';

export interface ComputerHistorySettings {
  readonly enabled: boolean;
  readonly captureText: boolean;
  readonly blockedApplications: readonly string[];
  readonly blockedDomains: readonly string[];
}

export interface ComputerHistoryStatus {
  readonly platformSupported: boolean;
  readonly helperAvailable: boolean;
  readonly state: ComputerHistoryRuntimeState;
  readonly accessibilityGranted: boolean;
  readonly inputMonitoringGranted: boolean;
  readonly eventCount: number;
  readonly suppressedEventCount: number;
  readonly segmentCount: number;
  readonly newestEventAt?: string;
  readonly settings: ComputerHistorySettings;
  readonly error?: string;
}

export interface ComputerHistoryTimelineEntry {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly applications: readonly string[];
  readonly start: string;
  readonly end: string;
  readonly eventCount: number;
  readonly suppressedEventCount: number;
  readonly contextMarkdown: string;
}

export interface ComputerHistoryTimeline {
  readonly status: ComputerHistoryStatus;
  readonly entries: readonly ComputerHistoryTimelineEntry[];
}

export type ComputerHistoryClearScope = 'last_10_minutes' | 'last_hour' | 'today' | 'all';
