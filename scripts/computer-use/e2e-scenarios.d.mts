export interface CuE2eScenario {
  id: string;
  level: 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5';
  prompt: string;
  fixtureSetup: {
    layout: string;
    windows: Array<Record<string, unknown>>;
    transitions?: Array<Record<string, unknown>>;
    zOrder?: string[];
  };
  expectedState: Array<Record<string, unknown>>;
  forbiddenEffects: Array<Record<string, unknown>>;
  allowedActions: string[];
  contractChecks: string[];
  realRunEnabled: boolean;
  requiresExecutionCapabilities: string[];
  runner?: string;
  maxTotalActions?: number;
  minimumActionCounts?: Record<string, number>;
  maxActionCounts?: Record<string, number>;
  expectedActionSequence?: string[];
  expectedFailures?: Array<{
    action: string;
    error: string;
  }>;
}

export const CU_E2E_ACTIONS: readonly string[];
export const CU_E2E_SCENARIOS: readonly CuE2eScenario[];
export function getCuE2eScenario(id: string): CuE2eScenario;
export function validateCuE2eScenario(scenario: unknown): CuE2eScenario;
export function validateCuE2eScenarioLibrary(
  scenarios?: readonly CuE2eScenario[],
): readonly CuE2eScenario[];
export function evaluateCuE2eScenarioState(
  scenario: CuE2eScenario,
  stateByWindow: Record<string, unknown>,
): {
  pass: boolean;
  expected: Array<Record<string, unknown> & { actual: unknown; pass: boolean }>;
  forbidden: Array<Record<string, unknown> & { actual: unknown; pass: boolean }>;
};
