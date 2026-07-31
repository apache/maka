import { parse } from '@babel/parser';

const CJK_PATTERN = /[\u3400-\u9fff]/u;

export type LiteralExemption = {
  file: string;
  text: string;
  reason: 'test-fixture' | 'non-user-visible-protocol' | 'brand';
};

export type SourceViolation = {
  file: string;
  line: number;
  text: string;
};

type LiteralScanOptions = {
  allowCatalogCopy?: boolean;
  exemptions?: readonly LiteralExemption[];
};

function normalizedFile(file: string): string {
  return file.replaceAll('\\', '/');
}

export type AstNode = {
  type: string;
  loc?: { start: { line: number } } | null;
  [key: string]: unknown;
};

export function isAstNode(value: unknown): value is AstNode {
  return Boolean(value) && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string';
}

export function sourceFileFor(source: string): AstNode {
  return parse(source, {
    sourceType: 'module',
    plugins: ['typescript', 'jsx'],
  }) as unknown as AstNode;
}

function violation(file: string, node: AstNode, text: string): SourceViolation {
  return {
    file: normalizedFile(file),
    line: node.loc?.start.line ?? 1,
    text: text.trim().replace(/\s+/gu, ' '),
  };
}

export function visitAst(node: AstNode, visit: (node: AstNode) => void): void {
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue;
    if (Array.isArray(value)) {
      for (const child of value) {
        if (isAstNode(child)) visitAst(child, visit);
      }
    } else if (isAstNode(value)) {
      visitAst(value, visit);
    }
  }
}

function literalText(node: AstNode): string | null {
  if (node.type === 'StringLiteral' || node.type === 'JSXText') {
    return typeof node.value === 'string' ? node.value : null;
  }
  if (node.type === 'TemplateElement' && typeof (node.value as { cooked?: unknown } | undefined)?.cooked === 'string') {
    return (node.value as { cooked: string }).cooked;
  }
  if (
    node.type === 'TemplateLiteral' &&
    Array.isArray(node.expressions) &&
    node.expressions.length === 0 &&
    Array.isArray(node.quasis) &&
    node.quasis.length === 1
  ) {
    const value = (node.quasis[0] as { value?: { cooked?: unknown; raw?: unknown } } | undefined)?.value;
    if (typeof value?.cooked === 'string') return value.cooked;
    if (typeof value?.raw === 'string') return value.raw;
  }
  return null;
}

export function findInlineCjkLiterals(
  source: string,
  file: string,
  options: LiteralScanOptions = {},
): SourceViolation[] {
  if (options.allowCatalogCopy) return [];

  const normalized = normalizedFile(file);
  const exemptions = options.exemptions ?? [];
  const sourceFile = sourceFileFor(source);
  const violations: SourceViolation[] = [];

  visitAst(sourceFile, (node) => {
    const text = literalText(node);
    if (text && CJK_PATTERN.test(text)) {
      const exempt = exemptions.some((entry) => normalizedFile(entry.file) === normalized && entry.text === text);
      if (!exempt) violations.push(violation(normalized, node, text));
    }
  });
  return violations;
}

function isZhCatalogAccess(node: unknown): boolean {
  if (!isAstNode(node) || node.type !== 'MemberExpression') return false;
  const property = node.property;
  return (
    isAstNode(property) &&
    ((property.type === 'Identifier' && property.name === 'zh') ||
      (property.type === 'StringLiteral' && property.value === 'zh'))
  );
}

export function findSilentCatalogFallbacks(source: string, file: string): SourceViolation[] {
  const normalized = normalizedFile(file);
  const sourceFile = sourceFileFor(source);
  const violations: SourceViolation[] = [];

  visitAst(sourceFile, (node) => {
    if (
      (node.type === 'LogicalExpression' || node.type === 'BinaryExpression') &&
      (node.operator === '??' || node.operator === '||') &&
      isZhCatalogAccess(node.right)
    ) {
      const start = typeof node.start === 'number' ? node.start : 0;
      const end = typeof node.end === 'number' ? node.end : start;
      violations.push(violation(normalized, node, source.slice(start, end)));
    }
  });
  return violations;
}

export function formatSourceViolations(violations: readonly SourceViolation[]): string {
  return violations.map((entry) => `${entry.file}:${entry.line}: ${entry.text}`).join('\n');
}
