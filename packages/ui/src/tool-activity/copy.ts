import type { ToolActivityKind, UiCatalog, UiLocale } from '@maka/core';

type BackgroundTerminalStatus = 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled' | 'orphaned';
type OfficeDocumentReason =
  | 'invalid_operation'
  | 'invalid_path'
  | 'unsupported_extension'
  | 'missing_file'
  | 'not_file'
  | 'symlink_escape'
  | 'invalid_selector'
  | 'invalid_query'
  | 'invalid_props'
  | 'file_exists'
  | 'officecli_missing'
  | 'officecli_timeout'
  | 'officecli_failed';
type WebCredentialCopyKey = 'env' | 'settings' | 'missing' | 'unknown';
type WebGuidanceKey = 'env' | 'settings' | 'rate_limited' | 'not_configured' | 'timed_out' | 'privacy_mode' | 'unknown';

export interface ToolActivityCopy {
  status: {
    pending: string;
    running: string;
    waitingPermission: string;
    completed: string;
    failed: string;
    interrupted: string;
    cancelled: string;
    timedOut: string;
  };
  group: {
    ariaLabel: string;
    title: string;
    callCount: (count: number) => string;
    failedSuffix: string;
  };
  output: {
    redacted: string;
    redactedAriaLabel: string;
    truncated: string;
    close: string;
    closeAriaLabel: string;
    showRaw: string;
    hideRaw: string;
  };
  copy: { idle: string; pending: string; copied: string; failed: string };
  error: { title: string; copyAriaLabel: (label: string) => string };
  summary: {
    kind: Record<ToolActivityKind, (count: number) => string>;
    failed: (count: number) => string;
    join: (clauses: readonly string[]) => string;
    live: (summary: string) => string;
    /** Live current-activity label when a processing group's tools are done
     *  and only reasoning is still streaming. */
    thinkingActivity: string;
  };
  automation: {
    created: (name: string) => string;
    nextFire: (value: string) => string;
    deleted: string;
    notFound: string;
    list: (count: number) => string;
    empty: string;
  };
  loadTools: {
    displayName: string;
    loaded: (namespace?: string) => string;
    count: (count: number) => string;
    footer: string;
  };
  permissionDenied: string;
  result: {
    hiddenLines: (count: number) => string;
    ptyFailed: string;
    queued: string;
    notQueued: string;
    queuedPreview: (action: string, preview: string, bytes?: number) => string;
    byteCount: (action: string, bytes: number) => string;
    resizeNotApplied: (size: string) => string;
    resized: (size: string) => string;
    sizeUnchanged: (size: string) => string;
    ptyCompleted: string;
    terminalUnavailable: string;
    noTerminalFrame: string;
    noOutputYet: string;
    noOutput: string;
    exitCode: (code: number) => string;
    managedBySource: string;
    sourceUnavailable: string;
    running: string;
    success: string;
    failed: string;
    timedOut: string;
    cancelled: string;
    disconnected: string;
    terminalTruncated: string;
    terminalRedacted: string;
    streamHidden: (stream: 'stdout' | 'stderr', count: number) => string;
    streamsTruncated: (limit: number) => string;
    outputTruncated: string;
    outputRedacted: string;
    backgroundStatus: Record<BackgroundTerminalStatus, string>;
    backgroundUnknown: (status: string) => string;
    officeDocument: string;
    notExecuted: string;
    completedSuffix: string;
    incompleteSuffix: string;
    truncatedSuffix: string;
    officeIncomplete: string;
    diagnostic: (reason: string) => string;
    officeReason: Record<OfficeDocumentReason, string>;
    unknownDiagnostic: string;
    workflow: { action: string; status: string; error: string; nodes: string; diagnostics: string };
    webNoResults: string;
    webResults: (count: number) => string;
    credentialSource: Record<WebCredentialCopyKey, string>;
    webFailure: string;
    webSearch: string;
    webGuidance: Record<WebGuidanceKey, string>;
  };
  agent: {
    subagentStatus: Record<
      'completed' | 'failed' | 'cancelled' | 'running' | 'waiting_for_user',
      string
    >;
    swarm: {
      status: Record<'completed' | 'partial' | 'failed' | 'cancelled', string>;
      taskCount: (count: number) => string;
      completedCount: (count: number) => string;
      failedCount: (count: number) => string;
      cancelledCount: (count: number) => string;
      artifactCount: (count: number) => string;
      resultsAriaLabel: string;
      hiddenTaskCount: (count: number) => string;
    };
    duration: (value: string) => string;
    resultSummaryAriaLabel: string;
    resultSummary: string;
    artifactsAriaLabel: string;
    artifacts: string;
    artifactCount: (count: number) => string;
    readOnly: string;
    copyState: { pending: string; copied: string; failed: string; pendingAria: (label: string) => string; failedAria: (label: string) => string };
    copyButtons: Record<'summary' | 'continuation' | 'process' | 'evidence' | 'report' | 'candidate' | 'matches', { idle: string; copied: string }>;
    objectiveFallback: string;
    foundRead: (found: number, read: number) => string;
    skipped: (count: number, sensitive?: number) => string;
    budgetLimited: string;
    continuationSuggested: (reason: string) => string;
    followupActionsAriaLabel: string;
    continuationTitle: string;
    incompleteFallback: string;
    detail: { terminal: string; foundRead: string; scope: string; queries: string; ignored: string; stopping: string; boundary: string; next: string };
    files: (count: number) => string;
    section: Record<'process' | 'evidence' | 'report' | 'candidates' | 'matches' | 'notes', { ariaLabel: string; title: string }>;
    score: (score: number) => string;
    complete: string;
    cancelledPartial: string;
    incomplete: string;
    notSpecified: string;
    field: Record<'status' | 'terminal' | 'objective' | 'summary' | 'scope' | 'queries' | 'foundRead' | 'duration' | 'ignored' | 'stopping' | 'boundary' | 'events' | 'evidence' | 'candidates' | 'matches' | 'continuationReason' | 'previousStatus' | 'previousTerminal' | 'previousDuration' | 'previousBoundary' | 'previousSummary', string>;
    terminalStatus: Record<'completed' | 'completed_empty' | 'failed' | 'canceled' | 'canceled_partial' | 'unknown', string>;
    reason: Record<'invalid_objective' | 'invalid_root' | 'no_readable_roots' | 'aborted' | 'unknown', string>;
    limitReason: Record<'candidate_budget' | 'file_budget' | 'match_budget' | 'byte_budget', string>;
    continuationReason: Record<'partial' | 'failed' | 'budget' | 'empty' | 'missing', string>;
    continuationIntro: string;
    continuationCandidates: string;
    continuationMatches: string;
    continuationOutro: string;
    eventType: Record<'started' | 'scope_resolved' | 'scan' | 'read' | 'checkpoint' | 'completed' | 'failed' | 'aborted', string>;
    candidateReason: Record<'content match' | 'project manifest' | 'project documentation' | 'project entrypoint' | 'project test surface' | 'project source surface' | 'fallback', string>;
    pathMatch: (path: string) => string;
  };
}

const TOOL_ACTIVITY_COPY = {
  zh: {
    status: { pending: '排队中', running: '运行中', waitingPermission: '等待权限', completed: '已完成', failed: '失败', interrupted: '已中断', cancelled: '已取消', timedOut: '已超时' },
    group: { ariaLabel: '工具调用记录', title: '工具调用', callCount: (count) => `${count} 次调用`, failedSuffix: '失败' },
    output: { redacted: '[已脱敏]', redactedAriaLabel: '已脱敏', truncated: '输出已截断', close: '关闭', closeAriaLabel: '关闭预览', showRaw: '显示原始诊断', hideRaw: '隐藏原始诊断' },
    copy: { idle: '复制', pending: '复制中…', copied: '已复制', failed: '复制失败' },
    error: { title: '工具调用失败', copyAriaLabel: (label) => `${label}错误信息` },
    summary: {
      kind: { read: (n) => `读取 ${n} 个文件`, search: (n) => `搜索 ${n} 次`, websearch: (n) => `联网搜索 ${n} 次`, webfetch: (n) => `抓取 ${n} 个网页`, edit: (n) => `编辑 ${n} 个文件`, command: (n) => `运行 ${n} 条命令`, explore: (n) => `探索 ${n} 次`, browser: (n) => `浏览器操作 ${n} 次`, tool: (n) => `调用 ${n} 个工具` },
      failed: (n) => `${n} 个失败`, join: (clauses) => clauses.join('，'), live: (summary) => `正在${summary}`,
      thinkingActivity: '深度思考',
    },
    automation: { created: (name) => `自动化任务已创建：${name}`, nextFire: (value) => `下次触发：${value}`, deleted: '自动化任务已删除', notFound: '未找到该任务（可能已完成或已删除）', list: (count) => `自动化任务列表 (${count})`, empty: '当前会话暂无自动化任务' },
    loadTools: { displayName: '加载工具组', loaded: (namespace) => namespace ? `已加载 ${namespace} 工具组` : '已加载工具组', count: (n) => `新增 ${n} 个可用工具：`, footer: '下一步即可调用' },
    permissionDenied: '用户已拒绝权限请求',
    result: {
      hiddenLines: (n) => `… 已隐藏 ${n} 行`, ptyFailed: '后台终端交互失败', queued: '已排队', notQueued: '未排队', queuedPreview: (action, preview, bytes) => bytes === undefined ? `${action}：${preview}` : `${action}：${preview}… · 共 ${bytes} 字节`, byteCount: (action, bytes) => `${action} ${bytes} 字节`, resizeNotApplied: (size) => `未调整为 ${size}`, resized: (size) => `已调整为 ${size}`, sizeUnchanged: (size) => `尺寸已是 ${size}`, ptyCompleted: '后台终端交互已完成', terminalUnavailable: '终端输出不可用', noTerminalFrame: '（无可用终端画面）', noOutputYet: '（尚无输出）', noOutput: '（无输出）', exitCode: (code) => `退出码 ${code}`, managedBySource: '由源会话管理', sourceUnavailable: '源会话不可用', running: '运行中', success: '成功', failed: '失败', timedOut: '已超时', cancelled: '已取消', disconnected: '已断开', terminalTruncated: '终端输出已截断', terminalRedacted: '终端输出已脱敏', streamHidden: (stream, n) => `… ${stream} 已隐藏 ${n} 行`, streamsTruncated: (limit) => `输出已截断 · 每路仅展示前 ${limit} 行`, outputTruncated: '输出已截断', outputRedacted: '输出已脱敏',
      backgroundStatus: { running: '后台运行中', completed: '后台已完成', failed: '后台失败', timed_out: '后台超时', cancelled: '后台已取消', orphaned: '后台任务已断开' }, backgroundUnknown: (status) => `后台 · ${status}`,
      officeDocument: 'Office 文档', notExecuted: '未执行', completedSuffix: ' · 已完成', incompleteSuffix: ' · 未完成', truncatedSuffix: ' · 输出已截断', officeIncomplete: 'Office 文档操作未完成。', diagnostic: (reason) => `诊断：${reason}`,
      officeReason: { invalid_operation: '操作不支持', invalid_path: '路径无效', unsupported_extension: '文件类型不支持', missing_file: '文件不存在', not_file: '不是文件', symlink_escape: '符号链接被拒绝', invalid_selector: '选择器无效', invalid_query: '查询表达式无效', invalid_props: '属性无效', file_exists: '文件已存在', officecli_missing: 'officecli 未安装', officecli_timeout: '操作超时', officecli_failed: '操作失败' }, unknownDiagnostic: '未知诊断',
      workflow: { action: '动作', status: '状态', error: '错误', nodes: '节点摘要', diagnostics: '诊断片段' }, webNoResults: '没有结果', webResults: (n) => `${n} 条结果`, credentialSource: { env: '环境变量', settings: '本机已保存 key', missing: '未配置', unknown: '来源未知' }, webFailure: '搜索失败', webSearch: '联网搜索', webGuidance: { env: '请检查 TAVILY_API_KEY / MAKA_TAVILY_API_KEY 后重启。', settings: '请在 设置 · 联网搜索 中更新 Tavily key。', rate_limited: 'Tavily 当前限流，请稍后重试或更换可用凭据。', not_configured: '请先完成联网搜索配置后再重试。', timed_out: '请求超时，请稍后重试。', privacy_mode: '隐私模式下不会发起联网搜索。', unknown: '请检查网络或稍后重试。' },
    },
    agent: {
      subagentStatus: { completed: '已完成', failed: '失败', cancelled: '已取消', running: '运行中', waiting_for_user: '等待用户输入' }, duration: (value) => `耗时 ${value}`, resultSummaryAriaLabel: '子代理结果摘要', resultSummary: '结果摘要', artifactsAriaLabel: '子代理产物', artifacts: '产物', artifactCount: (n) => `${n} 个`, readOnly: '只读',
      swarm: { status: { completed: '已完成', partial: '部分完成', failed: '失败', cancelled: '已取消' }, taskCount: (n) => `${n} 个任务`, completedCount: (n) => `${n} 完成`, failedCount: (n) => `${n} 失败`, cancelledCount: (n) => `${n} 取消`, artifactCount: (n) => `${n} 个产物`, resultsAriaLabel: 'Agent Swarm 结果', hiddenTaskCount: (n) => `另有 ${n} 个任务未显示` },
      copyState: { pending: '复制中…', copied: '已复制', failed: '复制失败', pendingAria: (label) => `${label}中`, failedAria: (label) => `${label}失败` },
      copyButtons: { summary: { idle: '复制摘要', copied: '已复制探索摘要' }, continuation: { idle: '复制续研提示', copied: '已复制续研提示' }, process: { idle: '复制过程', copied: '已复制探索过程' }, evidence: { idle: '复制证据', copied: '已复制证据锚点' }, report: { idle: '复制报告', copied: '已复制研究报告' }, candidate: { idle: '复制候选', copied: '已复制候选文件' }, matches: { idle: '复制片段', copied: '已复制命中片段' } },
      objectiveFallback: '只读探索', foundRead: (found, read) => `发现/读 ${found} / ${read} 个文件`, skipped: (count, sensitive) => sensitive ? `跳过 ${count} 个（含敏感 ${sensitive} 个）` : `跳过 ${count} 个`, budgetLimited: '受预算限制', continuationSuggested: (reason) => `建议续研：${reason}`, followupActionsAriaLabel: '只读探索后续操作', continuationTitle: '复制一段可继续只读探索的提示', incompleteFallback: '只读探索未完成。', detail: { terminal: '终态', foundRead: '发现/读', scope: '范围', queries: '查询', ignored: '忽略', stopping: '停止', boundary: '边界', next: '后续' }, files: (n) => `${n} 个文件`,
      section: { process: { ariaLabel: '探索过程', title: '过程' }, evidence: { ariaLabel: '证据锚点', title: '证据锚点' }, report: { ariaLabel: '研究报告', title: '研究报告' }, candidates: { ariaLabel: '候选文件', title: '候选文件' }, matches: { ariaLabel: '命中片段', title: '命中片段' }, notes: { ariaLabel: '探索说明', title: '说明' } }, score: (score) => `分数 ${score}`, complete: '已完成', cancelledPartial: '已取消 · 保留部分结果', incomplete: '未完成', notSpecified: '未指定',
      field: { status: '状态', terminal: '终态', objective: '目标', summary: '摘要', scope: '范围', queries: '查询', foundRead: '发现/读取', duration: '耗时', ignored: '忽略', stopping: '停止条件', boundary: '预算边界', events: '事件', evidence: '证据', candidates: '候选', matches: '命中片段', continuationReason: '续研原因', previousStatus: '上一轮状态', previousTerminal: '上一轮终态', previousDuration: '上一轮耗时', previousBoundary: '上一轮预算边界', previousSummary: '上一轮摘要' },
      terminalStatus: { completed: '完成，有证据', completed_empty: '完成，无证据', failed: '失败', canceled: '已取消', canceled_partial: '已取消，有部分结果', unknown: '未知终态' }, reason: { invalid_objective: '目标无效', invalid_root: '范围无效', no_readable_roots: '没有可读取范围', aborted: '已取消', unknown: '未知诊断' }, limitReason: { candidate_budget: '候选文件预算已满', file_budget: '读取文件预算已满', match_budget: '命中预算已满', byte_budget: '读取字节预算已满' }, continuationReason: { partial: '已有部分结果，仍需补证据', failed: '上一轮未完成', budget: '达到预算边界', empty: '没有找到证据', missing: '仍缺证据' },
      continuationIntro: '继续这次只读探索，不要修改文件。', continuationCandidates: '优先补读候选：', continuationMatches: '已有命中片段：', continuationOutro: '请只读检查仍缺证据的部分，输出新的证据锚点、候选文件、结论和下一步 gate。', eventType: { started: '开始', scope_resolved: '范围', scan: '扫描', read: '读取', checkpoint: '进度', completed: '完成', failed: '失败', aborted: '取消' }, candidateReason: { 'content match': '内容命中', 'project manifest': '项目配置', 'project documentation': '项目文档', 'project entrypoint': '入口文件', 'project test surface': '测试线索', 'project source surface': '源码线索', fallback: '探索线索' }, pathMatch: (path) => `路径命中 ${path}`,
    },
  },
  en: {
    status: { pending: 'Pending', running: 'Running', waitingPermission: 'Waiting for permission', completed: 'Completed', failed: 'Failed', interrupted: 'Interrupted', cancelled: 'Cancelled', timedOut: 'Timed out' },
    group: { ariaLabel: 'Tool call history', title: 'Tool calls', callCount: (count) => `${count} ${count === 1 ? 'call' : 'calls'}`, failedSuffix: 'Failed' },
    output: { redacted: '[Redacted]', redactedAriaLabel: 'Redacted', truncated: 'Output truncated', close: 'Close', closeAriaLabel: 'Close preview', showRaw: 'Show raw diagnostics', hideRaw: 'Hide raw diagnostics' },
    copy: { idle: 'Copy', pending: 'Copying…', copied: 'Copied', failed: 'Copy failed' },
    error: { title: 'Tool call failed', copyAriaLabel: (label) => `${label} error details` },
    summary: {
      kind: { read: (n) => `Read ${n} ${n === 1 ? 'file' : 'files'}`, search: (n) => `Searched ${n} ${n === 1 ? 'time' : 'times'}`, websearch: (n) => `Ran ${n} web ${n === 1 ? 'search' : 'searches'}`, webfetch: (n) => `Fetched ${n} web ${n === 1 ? 'page' : 'pages'}`, edit: (n) => `Edited ${n} ${n === 1 ? 'file' : 'files'}`, command: (n) => `Ran ${n} ${n === 1 ? 'command' : 'commands'}`, explore: (n) => `Explored ${n} ${n === 1 ? 'time' : 'times'}`, browser: (n) => `Performed ${n} browser ${n === 1 ? 'action' : 'actions'}`, tool: (n) => `Called ${n} ${n === 1 ? 'tool' : 'tools'}` },
      failed: (n) => `${n} failed`, join: (clauses) => clauses.join(', '), live: (summary) => `Working: ${summary}`,
      thinkingActivity: 'Thinking',
    },
    automation: { created: (name) => `Automation created: ${name}`, nextFire: (value) => `Next run: ${value}`, deleted: 'Automation deleted', notFound: 'Automation not found (it may have completed or been deleted)', list: (count) => `Automations (${count})`, empty: 'No automations in this conversation' },
    loadTools: { displayName: 'Load tools', loaded: (namespace) => namespace ? `Loaded ${namespace} tools` : 'Loaded tools', count: (n) => `Added ${n} available ${n === 1 ? 'tool' : 'tools'}:`, footer: 'Ready to use' },
    permissionDenied: 'User denied the permission request',
    result: {
      hiddenLines: (n) => `… ${n} ${n === 1 ? 'line' : 'lines'} hidden`, ptyFailed: 'Background terminal interaction failed', queued: 'Queued', notQueued: 'Not queued', queuedPreview: (action, preview, bytes) => bytes === undefined ? `${action}: ${preview}` : `${action}: ${preview}… · ${bytes} bytes total`, byteCount: (action, bytes) => `${action} ${bytes} bytes`, resizeNotApplied: (size) => `Not resized to ${size}`, resized: (size) => `Resized to ${size}`, sizeUnchanged: (size) => `Size already ${size}`, ptyCompleted: 'Background terminal interaction completed', terminalUnavailable: 'Terminal output unavailable', noTerminalFrame: '(No terminal frame available)', noOutputYet: '(No output yet)', noOutput: '(No output)', exitCode: (code) => `exit code ${code}`, managedBySource: 'Managed by source conversation', sourceUnavailable: 'Source conversation unavailable', running: 'Running', success: 'Succeeded', failed: 'Failed', timedOut: 'Timed out', cancelled: 'Cancelled', disconnected: 'Disconnected', terminalTruncated: 'Terminal output truncated', terminalRedacted: 'Terminal output redacted', streamHidden: (stream, n) => `… ${n} ${stream} ${n === 1 ? 'line' : 'lines'} hidden`, streamsTruncated: (limit) => `Output truncated · showing the first ${limit} lines of each stream`, outputTruncated: 'Output truncated', outputRedacted: 'Output redacted',
      backgroundStatus: { running: 'Running in background', completed: 'Background task completed', failed: 'Background task failed', timed_out: 'Background task timed out', cancelled: 'Background task cancelled', orphaned: 'Background task disconnected' }, backgroundUnknown: (status) => `Background · ${status}`,
      officeDocument: 'Office document', notExecuted: 'Not run', completedSuffix: ' · Completed', incompleteSuffix: ' · Incomplete', truncatedSuffix: ' · Output truncated', officeIncomplete: 'Office document operation did not complete.', diagnostic: (reason) => `Diagnostic: ${reason}`,
      officeReason: { invalid_operation: 'Unsupported operation', invalid_path: 'Invalid path', unsupported_extension: 'Unsupported file type', missing_file: 'File not found', not_file: 'Not a file', symlink_escape: 'Symbolic link rejected', invalid_selector: 'Invalid selector', invalid_query: 'Invalid query expression', invalid_props: 'Invalid property', file_exists: 'File already exists', officecli_missing: 'officecli is not installed', officecli_timeout: 'Operation timed out', officecli_failed: 'Operation failed' }, unknownDiagnostic: 'Unknown diagnostic',
      workflow: { action: 'Action', status: 'Status', error: 'Error', nodes: 'Node summary', diagnostics: 'Diagnostic excerpts' }, webNoResults: 'No results', webResults: (n) => `${n} ${n === 1 ? 'result' : 'results'}`, credentialSource: { env: 'Environment variable', settings: 'Locally saved key', missing: 'Not configured', unknown: 'Unknown source' }, webFailure: 'Search failed', webSearch: 'Web search', webGuidance: { env: 'Check TAVILY_API_KEY / MAKA_TAVILY_API_KEY and restart.', settings: 'Update the Tavily key in Settings · Web search.', rate_limited: 'Tavily is rate-limiting requests. Try again later or use another credential.', not_configured: 'Configure web search before retrying.', timed_out: 'The request timed out. Try again later.', privacy_mode: 'Web search is disabled in privacy mode.', unknown: 'Check the network connection or try again later.' },
    },
    agent: {
      subagentStatus: { completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', running: 'Running', waiting_for_user: 'Waiting for user input' }, duration: (value) => `Duration ${value}`, resultSummaryAriaLabel: 'Subagent result summary', resultSummary: 'Result summary', artifactsAriaLabel: 'Subagent artifacts', artifacts: 'Artifacts', artifactCount: (n) => `${n}`, readOnly: 'Read only',
      swarm: { status: { completed: 'Completed', partial: 'Partially completed', failed: 'Failed', cancelled: 'Cancelled' }, taskCount: (n) => `${n} ${n === 1 ? 'task' : 'tasks'}`, completedCount: (n) => `${n} completed`, failedCount: (n) => `${n} failed`, cancelledCount: (n) => `${n} cancelled`, artifactCount: (n) => `${n} ${n === 1 ? 'artifact' : 'artifacts'}`, resultsAriaLabel: 'Agent Swarm results', hiddenTaskCount: (n) => `${n} more ${n === 1 ? 'task is' : 'tasks are'} not shown` },
      copyState: { pending: 'Copying…', copied: 'Copied', failed: 'Copy failed', pendingAria: (label) => `Copying ${label}`, failedAria: (label) => `Failed to copy ${label}` },
      copyButtons: { summary: { idle: 'Copy summary', copied: 'Exploration summary copied' }, continuation: { idle: 'Copy continuation prompt', copied: 'Continuation prompt copied' }, process: { idle: 'Copy process', copied: 'Exploration process copied' }, evidence: { idle: 'Copy evidence', copied: 'Evidence anchors copied' }, report: { idle: 'Copy report', copied: 'Research report copied' }, candidate: { idle: 'Copy candidates', copied: 'Candidate files copied' }, matches: { idle: 'Copy matches', copied: 'Matching excerpts copied' } },
      objectiveFallback: 'Read-only exploration', foundRead: (found, read) => `Discovered/read ${found} / ${read} files`, skipped: (count, sensitive) => sensitive ? `Skipped ${count} (${sensitive} sensitive)` : `Skipped ${count}`, budgetLimited: 'Budget limited', continuationSuggested: (reason) => `Continue: ${reason}`, followupActionsAriaLabel: 'Read-only exploration follow-up actions', continuationTitle: 'Copy a prompt that continues the read-only exploration', incompleteFallback: 'Read-only exploration did not complete.', detail: { terminal: 'Terminal state', foundRead: 'Discovered/read', scope: 'Scope', queries: 'Queries', ignored: 'Ignored', stopping: 'Stopped by', boundary: 'Limits', next: 'Next' }, files: (n) => `${n} ${n === 1 ? 'file' : 'files'}`,
      section: { process: { ariaLabel: 'Exploration process', title: 'Process' }, evidence: { ariaLabel: 'Evidence anchors', title: 'Evidence anchors' }, report: { ariaLabel: 'Research report', title: 'Research report' }, candidates: { ariaLabel: 'Candidate files', title: 'Candidate files' }, matches: { ariaLabel: 'Matching excerpts', title: 'Matching excerpts' }, notes: { ariaLabel: 'Exploration notes', title: 'Notes' } }, score: (score) => `Score ${score}`, complete: 'Completed', cancelledPartial: 'Cancelled · Partial results retained', incomplete: 'Incomplete', notSpecified: 'Not specified',
      field: { status: 'Status', terminal: 'Terminal state', objective: 'Objective', summary: 'Summary', scope: 'Scope', queries: 'Queries', foundRead: 'Discovered/read', duration: 'Duration', ignored: 'Ignored', stopping: 'Stopping condition', boundary: 'Budget limits', events: 'Events', evidence: 'Evidence', candidates: 'Candidates', matches: 'Matching excerpts', continuationReason: 'Continuation reason', previousStatus: 'Previous status', previousTerminal: 'Previous terminal state', previousDuration: 'Previous duration', previousBoundary: 'Previous budget limits', previousSummary: 'Previous summary' },
      terminalStatus: { completed: 'Completed with evidence', completed_empty: 'Completed without evidence', failed: 'Failed', canceled: 'Cancelled', canceled_partial: 'Cancelled with partial results', unknown: 'Unknown terminal state' }, reason: { invalid_objective: 'Invalid objective', invalid_root: 'Invalid scope', no_readable_roots: 'No readable scope', aborted: 'Cancelled', unknown: 'Unknown diagnostic' }, limitReason: { candidate_budget: 'Candidate-file budget reached', file_budget: 'File-read budget reached', match_budget: 'Match budget reached', byte_budget: 'Byte-read budget reached' }, continuationReason: { partial: 'Partial results need more evidence', failed: 'The previous run did not complete', budget: 'A budget limit was reached', empty: 'No evidence was found', missing: 'More evidence is needed' },
      continuationIntro: 'Continue this read-only exploration without changing files.', continuationCandidates: 'Prioritize these candidates:', continuationMatches: 'Existing matching excerpts:', continuationOutro: 'Inspect only the areas that still lack evidence, then return new evidence anchors, candidate files, conclusions, and the next gate.', eventType: { started: 'Started', scope_resolved: 'Scope', scan: 'Scan', read: 'Read', checkpoint: 'Progress', completed: 'Completed', failed: 'Failed', aborted: 'Cancelled' }, candidateReason: { 'content match': 'Content match', 'project manifest': 'Project manifest', 'project documentation': 'Project documentation', 'project entrypoint': 'Entry point', 'project test surface': 'Test signal', 'project source surface': 'Source signal', fallback: 'Exploration signal' }, pathMatch: (path) => `Path match ${path}`,
    },
  },
} satisfies UiCatalog<ToolActivityCopy>;

export function getToolActivityCopy(locale: UiLocale): ToolActivityCopy {
  return TOOL_ACTIVITY_COPY[locale];
}
