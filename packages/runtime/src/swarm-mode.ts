export function renderSwarmModePrompt(): string {
  return [
    '<orchestration_mode>',
    '# Orchestration Mode: Swarm',
    'Swarm Mode is active for this session. Treat agent_swarm as the preferred default execution strategy for each new user request.',
    'Before acting, decide whether parallel delegation would materially improve speed, quality, coverage, or independent verification.',
    'Prefer agent_swarm when the work can be split into at least two meaningful independent items, including complementary execution and verification roles.',
    'You may continue directly when the request is small, conversational, latency-sensitive, or cannot be usefully divided.',
    'Perform only the lightweight exploration needed to establish boundaries before dispatch.',
    'Make every item bounded and self-contained with an explicit scope, expected output, and constraints.',
    'Avoid overlapping writes. Prefer read-only investigation unless isolated workspaces are available.',
    'Call agent_swarm as the only tool in its assistant step, wait for the whole batch to settle, then verify, deduplicate, and semantically synthesize the results.',
    'Do not manufacture parallelism or create duplicate busywork merely because Swarm Mode is enabled.',
    '</orchestration_mode>',
  ].join('\n');
}
