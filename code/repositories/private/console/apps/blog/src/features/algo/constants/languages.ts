import type { ProblemSignature } from '@/features/algo/types/problem';

/** 当前支持的判题语言(字典驱动,新增语言在此扩展)。 */
export const SUPPORTED_LANGUAGES = ['javascript', 'python'] as const;

/** 支持语言类型。 */
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** 语言到展示名的映射。 */
export const LANGUAGE_LABELS: Record<string, string> = {
  javascript: 'JavaScript',
  python: 'Python',
};

/** 语言到 Monaco 编辑器语言标识的映射。 */
export const MONACO_LANGUAGE: Record<string, string> = {
  javascript: 'javascript',
  python: 'python',
};

/**
 * 根据函数签名生成代码模板。
 *
 * @param sig - 题目函数签名。
 * @param language - 目标语言;默认取签名自带语言。
 * @returns 默认代码模板字符串。
 */
export function buildCodeTemplate(sig: ProblemSignature, language: string = sig.language): string {
  if (language === 'python') return buildPythonTemplate(sig);
  return buildJavascriptTemplate(sig);
}

/** JavaScript 代码模板。 */
function buildJavascriptTemplate(sig: ProblemSignature): string {
  const params = sig.params.map((p) => p.name).join(', ');
  return [
    '/**',
    ` * ${sig.entry} — ${sig.params.map((p) => `${p.name}: ${p.type}`).join(', ')}`,
    ` * @returns ${sig.returns}`,
    ' */',
    `function ${sig.entry}(${params}) {`,
    '  // 在此编写你的解法',
    '}',
    '',
  ].join('\n');
}

/** Python 代码模板(入口函数名与签名保持一致,便于判题统一调用)。 */
function buildPythonTemplate(sig: ProblemSignature): string {
  const params = sig.params.map((p) => p.name).join(', ');
  return [`def ${sig.entry}(${params}):`, '    # 在此编写你的解法', '    pass', ''].join('\n');
}
