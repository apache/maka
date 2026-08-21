import { normalizeUserSessionName } from '@maka/core/session-name';

const MAX_CHINESE_TITLE_CODE_POINTS = 24;
const MAX_OTHER_TITLE_CODE_POINTS = 60;

const ACTIONS: ReadonlyArray<{
  pattern: RegExp;
  label: string;
}> = [
  { pattern: /修(?:复|掉|一下)|解决/u, label: '修复' },
  { pattern: /补齐|完善/u, label: '完善' },
  { pattern: /优化/u, label: '优化' },
  { pattern: /实现|支持/u, label: '实现' },
  { pattern: /新增|添加|创建/u, label: '新增' },
  { pattern: /升级|更新/u, label: '更新' },
  { pattern: /删除|移除/u, label: '移除' },
  { pattern: /测试|验证/u, label: '验证' },
  { pattern: /排查|检查|调查|定位/u, label: '排查' },
];

/** Cleans a model-authored Work title and applies the WorkHub display budget. */
export function normalizeGeneratedWorkHubTitle(text: string): string | undefined {
  const firstLine = text
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/giu, '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^(?:title|标题)\s*[:：]\s*/iu, '')
    .replace(/[。！？!?；;，,：:、]+$/gu, '')
    .replace(/^["'`“「『]|["'`”」』]$/gu, '')
    .trim();
  if (!firstLine) return undefined;
  const limit = /\p{Script=Han}/u.test(firstLine)
    ? MAX_CHINESE_TITLE_CODE_POINTS
    : MAX_OTHER_TITLE_CODE_POINTS;
  const bounded = truncateTitle(firstLine, limit);
  const normalized = normalizeUserSessionName(bounded);
  return normalized.ok ? normalized.value : undefined;
}

/** Local fallback used when the hidden router/title model is unavailable. */
export function fallbackWorkHubTitle(sourceText: string): string {
  const source = sourceText
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/giu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  const action = ACTIONS.find(({ pattern }) => pattern.test(source));
  if (!action) return normalizeGeneratedWorkHubTitle(firstClause(source)) ?? '新工作';

  const match = action.pattern.exec(source);
  const actionIndex = match?.index ?? 0;
  const actionEnd = actionIndex + (match?.[0].length ?? 0);
  const before = cleanSubject(source.slice(0, actionIndex));
  const after = cleanSubject(firstClause(source.slice(actionEnd)));
  const subject = after || before || cleanSubject(firstClause(source));
  return normalizeGeneratedWorkHubTitle(`${action.label}${subject}`) ?? '新工作';
}

function cleanSubject(value: string): string {
  return value
    .replace(/^(?:(?:嗯+|好的?|然后|现在|这次|首先)[，,、\s]*)+/u, '')
    .replace(/^(?:(?:请(?:你)?|麻烦(?:你)?|帮我|我们(?:来)?|我想(?:要)?)[\s，,]*)+/u, '')
    .replace(/^(?:把|将|给|对|一个|一下|这个|这项)[\s]*/u, '')
    .replace(/^(?:检查并|排查并|检查|排查|处理|继续|接着)[\s]*/u, '')
    .replace(/(?:并|然后|接着|之后|同时|顺便|先|再|不要|保持).*/u, '')
    .replace(/(?:一下|这个问题|这项工作)$/u, '')
    .replace(/^[的\s]+|[的\s]+$/gu, '')
    .trim();
}

function firstClause(value: string): string {
  return value.split(/[。！？!?；;，,]|\b(?:then|after|and then)\b/iu)[0]?.trim() ?? '';
}

function truncateTitle(value: string, limit: number): string {
  const points = [...value];
  if (points.length <= limit) return value;
  const prefix = points.slice(0, limit).join('').trim();
  if (/\p{Script=Han}/u.test(value)) return prefix;
  const boundary = prefix.lastIndexOf(' ');
  return boundary >= Math.floor(limit * 0.6) ? prefix.slice(0, boundary).trim() : prefix;
}
