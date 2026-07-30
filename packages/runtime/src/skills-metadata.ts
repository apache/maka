import { parseDocument } from 'yaml';

/**
 * Skill metadata validation and front-matter parsing.
 *
 * This module owns the typed parsing of `SKILL.md` front-matter: extracting the
 * YAML document, validating required/optional fields, producing structured
 * {@link SkillValidationIssue}s, and exposing a backward-compatible
 * {@link parseSkillFrontMatter} shim. It has no dependencies on other skill
 * modules — only `yaml` and the shared {@link cleanPromptText} helper.
 */

// ── Limits ───────────────────────────────────────────────────────────────

export const MAX_SKILL_BODY_CHARS = 4000;
export const MAX_SKILL_TOOL_BODY_CHARS = 24_000;

// ── Types ─────────────────────────────────────────────────────────────────

/** Parsed, runtime-relevant metadata from one SKILL.md frontmatter block. */
export interface SkillManifest {
  name?: string;
  description?: string;
  allowedTools: string[];
  requiredTools: string[];
  requiredCapabilities: string[];
  license?: string;
  compatibility?: string;
  metadata: Record<string, string>;
  /** Maka's bundled-catalog extension. It is not model-facing runtime authority. */
  category?: string;
}

export type SkillValidationSeverity = 'warning' | 'error';

export type SkillValidationCode =
  | 'missing_frontmatter'
  | 'malformed_frontmatter'
  | 'missing_name'
  | 'invalid_name'
  | 'name_too_long'
  | 'missing_description'
  | 'invalid_description'
  | 'description_too_long'
  | 'invalid_allowed_tools'
  | 'invalid_required_tools'
  | 'invalid_required_capabilities'
  | 'invalid_license'
  | 'invalid_compatibility'
  | 'compatibility_too_long'
  | 'invalid_metadata'
  | 'invalid_category'
  | 'unsupported_field'
  | 'body_too_large'
  | 'duplicate_id'
  | 'duplicate_name';

/** One deterministic, user-inspectable metadata validation finding. */
export interface SkillValidationIssue {
  code: SkillValidationCode;
  severity: SkillValidationSeverity;
  message: string;
  field?: string;
}

export interface SkillMetadataValidationResult {
  manifest: SkillManifest;
  body: string;
  issues: SkillValidationIssue[];
  valid: boolean;
}

// ── Shared text helpers ──────────────────────────────────────────────────

/** Strip control characters that are unsafe in prompt text. */
export function cleanPromptText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

/** Truncate text to `max` Unicode codepoints, appending a notice. */
export function truncateCodepoints(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, Math.max(0, max - 25)).join('')}\n[skill truncated]`;
}

// ── Public API ────────────────────────────────────────────────────────────

const SUPPORTED_SKILL_FIELDS = new Set([
  'name',
  'description',
  'allowed-tools',
  'required-tools',
  'required-capabilities',
  'license',
  'compatibility',
  'metadata',
  // Maka's bundled catalog owns this display-only extension.
  'category',
]);

/**
 * Parse and validate one SKILL.md without trusting metadata as permission.
 *
 * Required discovery metadata and safety-relevant Maka extensions fail
 * closed. Cosmetic/spec-compatibility findings remain warnings so Maka can
 * load useful skills authored for other clients while exposing the drift.
 */
export function validateSkillMetadata(text: string): SkillMetadataValidationResult {
  const manifest = emptySkillManifest();
  const issues: SkillValidationIssue[] = [];
  const extracted = extractSkillDocument(text);
  if (!extracted.ok) {
    issues.push({
      code: extracted.reason,
      severity: 'error',
      field: 'frontmatter',
      message:
        extracted.reason === 'missing_frontmatter'
          ? 'SKILL.md must start with a YAML frontmatter block.'
          : 'SKILL.md frontmatter is missing its closing delimiter.',
    });
    return { manifest, body: extracted.body, issues, valid: false };
  }

  let rawManifest: unknown;
  try {
    rawManifest = parseStrictSkillManifest(extracted.frontmatter);
  } catch {
    const repaired = repairLegacySkillFrontmatter(extracted.frontmatter);
    if (repaired) {
      try {
        rawManifest = parseStrictSkillManifest(repaired);
        issues.push({
          code: 'malformed_frontmatter',
          severity: 'warning',
          field: 'frontmatter',
          message:
            'SKILL.md frontmatter used legacy syntax and was loaded after a compatibility repair.',
        });
      } catch {
        // The constrained compatibility repair was insufficient; fail closed.
      }
    }
    if (rawManifest === undefined) {
      issues.push({
        code: 'malformed_frontmatter',
        severity: 'error',
        field: 'frontmatter',
        message: 'SKILL.md frontmatter is not valid YAML.',
      });
      return { manifest, body: extracted.body, issues, valid: false };
    }
  }

  if (!isRecord(rawManifest)) {
    issues.push({
      code: 'malformed_frontmatter',
      severity: 'error',
      field: 'frontmatter',
      message: 'SKILL.md frontmatter must be a YAML mapping.',
    });
    return { manifest, body: extracted.body, issues, valid: false };
  }

  for (const field of Object.keys(rawManifest).sort()) {
    if (!SUPPORTED_SKILL_FIELDS.has(field)) {
      issues.push({
        code: 'unsupported_field',
        severity: 'warning',
        field,
        message: `Unsupported SKILL.md frontmatter field "${field}" is ignored.`,
      });
    }
  }

  manifest.name = readRequiredSkillString(
    rawManifest.name,
    'name',
    'missing_name',
    'invalid_name',
    issues,
  );
  if (manifest.name && Array.from(manifest.name).length > 64) {
    issues.push({
      code: 'name_too_long',
      severity: 'warning',
      field: 'name',
      message: 'Skill name exceeds the Agent Skills 64-character recommendation.',
    });
  }

  manifest.description = readRequiredSkillString(
    rawManifest.description,
    'description',
    'missing_description',
    'invalid_description',
    issues,
  );
  if (manifest.description && Array.from(manifest.description).length > 1_024) {
    issues.push({
      code: 'description_too_long',
      severity: 'warning',
      field: 'description',
      message: 'Skill description exceeds the Agent Skills 1024-character recommendation.',
    });
  }

  manifest.allowedTools = readSkillStringList(
    rawManifest['allowed-tools'],
    'allowed-tools',
    'invalid_allowed_tools',
    'warning',
    issues,
  );
  manifest.requiredTools = readSkillStringList(
    rawManifest['required-tools'],
    'required-tools',
    'invalid_required_tools',
    'error',
    issues,
  );
  manifest.requiredCapabilities = readSkillStringList(
    rawManifest['required-capabilities'],
    'required-capabilities',
    'invalid_required_capabilities',
    'error',
    issues,
  );

  manifest.license = readOptionalSkillString(
    rawManifest.license,
    'license',
    'invalid_license',
    issues,
  );
  manifest.compatibility = readOptionalSkillString(
    rawManifest.compatibility,
    'compatibility',
    'invalid_compatibility',
    issues,
  );
  if (manifest.compatibility && Array.from(manifest.compatibility).length > 500) {
    issues.push({
      code: 'compatibility_too_long',
      severity: 'warning',
      field: 'compatibility',
      message: 'Skill compatibility exceeds the Agent Skills 500-character recommendation.',
    });
  }

  manifest.metadata = readSkillMetadataMap(rawManifest.metadata, issues);
  manifest.category = readOptionalSkillString(
    rawManifest.category,
    'category',
    'invalid_category',
    issues,
  );

  if (Array.from(extracted.body).length > MAX_SKILL_TOOL_BODY_CHARS) {
    issues.push({
      code: 'body_too_large',
      severity: 'warning',
      field: 'body',
      message: `Skill instructions exceed ${MAX_SKILL_TOOL_BODY_CHARS} characters and will be truncated when loaded.`,
    });
  }

  return {
    manifest,
    body: extracted.body,
    issues,
    valid: !issues.some((issue) => issue.severity === 'error'),
  };
}

/** Compatibility parser retained for existing Desktop and Runtime callers. */
export function parseSkillFrontMatter(text: string): {
  name?: string;
  description?: string;
  allowedTools: string[];
  requiredTools: string[];
  requiredCapabilities: string[];
} {
  const { manifest } = validateSkillMetadata(text);
  return {
    ...(manifest.name ? { name: manifest.name } : {}),
    ...(manifest.description ? { description: manifest.description } : {}),
    allowedTools: manifest.allowedTools,
    requiredTools: manifest.requiredTools,
    requiredCapabilities: manifest.requiredCapabilities,
  };
}

// ── Internal helpers ─────────────────────────────────────────────────────

import { isRecord } from './path-containment.js';

function emptySkillManifest(): SkillManifest {
  return {
    allowedTools: [],
    requiredTools: [],
    requiredCapabilities: [],
    metadata: {},
  };
}

function extractSkillDocument(
  text: string,
):
  | { ok: true; frontmatter: string; body: string }
  | { ok: false; reason: 'missing_frontmatter' | 'malformed_frontmatter'; body: string } {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (!/^---[\t ]*$/.test(lines[0] ?? '')) {
    return { ok: false, reason: 'missing_frontmatter', body: text.trim() };
  }
  const close = lines.findIndex((line, index) => index > 0 && /^---[\t ]*$/.test(line));
  if (close < 0) {
    return { ok: false, reason: 'malformed_frontmatter', body: '' };
  }
  return {
    ok: true,
    frontmatter: lines.slice(1, close).join('\n'),
    body: lines
      .slice(close + 1)
      .join('\n')
      .trim(),
  };
}

function parseStrictSkillManifest(frontmatter: string): unknown {
  const document = parseDocument(frontmatter, {
    merge: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0 || document.warnings.length > 0) throw new Error('invalid yaml');
  return document.toJS({ maxAliasCount: 0 });
}

/**
 * Repair only the two legacy forms accepted by Maka's former line parser:
 * unquoted colons in required scalar fields and tab-indented list items.
 * The repaired document must still pass the strict YAML parser and the full
 * typed validator, so this cannot bypass required-tools/capability checks.
 */
function repairLegacySkillFrontmatter(frontmatter: string): string | undefined {
  let changed = false;
  const repaired = frontmatter.split(/\r?\n/).map((line) => {
    let next = line;
    const leading = next.match(/^[ \t]+/)?.[0];
    if (leading?.includes('\t')) {
      next = leading.replace(/\t/g, '  ') + next.slice(leading.length);
    }

    const scalar = next.match(/^(name|description):[ \t]*(.*)$/);
    if (scalar) {
      const value = scalar[2].trim();
      if (value.includes(': ') && !value.startsWith('"') && !value.startsWith("'")) {
        next = `${scalar[1]}: ${JSON.stringify(value)}`;
      }
    }

    if (next !== line) changed = true;
    return next;
  });
  return changed ? repaired.join('\n') : undefined;
}

function readRequiredSkillString(
  value: unknown,
  field: 'name' | 'description',
  missingCode: 'missing_name' | 'missing_description',
  invalidCode: 'invalid_name' | 'invalid_description',
  issues: SkillValidationIssue[],
): string | undefined {
  if (value === undefined || value === null || value === '') {
    issues.push({
      code: missingCode,
      severity: 'error',
      field,
      message: `Skill ${field} is required and must not be empty.`,
    });
    return undefined;
  }
  if (typeof value !== 'string') {
    issues.push({
      code: invalidCode,
      severity: 'error',
      field,
      message: `Skill ${field} must be a string.`,
    });
    return undefined;
  }
  const cleaned = cleanPromptText(value).trim();
  if (!cleaned) {
    issues.push({
      code: missingCode,
      severity: 'error',
      field,
      message: `Skill ${field} is required and must not be empty.`,
    });
    return undefined;
  }
  return cleaned;
}

function readOptionalSkillString(
  value: unknown,
  field: 'license' | 'compatibility' | 'category',
  code: 'invalid_license' | 'invalid_compatibility' | 'invalid_category',
  issues: SkillValidationIssue[],
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !cleanPromptText(value).trim()) {
    issues.push({
      code,
      severity: 'warning',
      field,
      message: `Optional skill field ${field} must be a non-empty string when provided.`,
    });
    return undefined;
  }
  return cleanPromptText(value).trim();
}

function readSkillStringList(
  value: unknown,
  field: 'allowed-tools' | 'required-tools' | 'required-capabilities',
  code: 'invalid_allowed_tools' | 'invalid_required_tools' | 'invalid_required_capabilities',
  severity: SkillValidationSeverity,
  issues: SkillValidationIssue[],
): string[] {
  if (value === undefined || value === null || value === '') return [];
  const candidates =
    typeof value === 'string' ? value.trim().split(/[\s,]+/) : Array.isArray(value) ? value : null;
  if (!candidates) {
    issues.push({
      code,
      severity,
      field,
      message: `Skill field ${field} must be a space- or comma-separated string or a string list.`,
    });
    return [];
  }

  const normalized: string[] = [];
  let invalid = false;
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      invalid = true;
      continue;
    }
    const token = cleanPromptText(candidate).trim();
    if (!token || /\s/.test(token)) {
      invalid = true;
      continue;
    }
    if (!normalized.includes(token)) normalized.push(token);
  }
  if (invalid) {
    issues.push({
      code,
      severity,
      field,
      message: `Skill field ${field} contains a non-string, empty, or whitespace-bearing entry.`,
    });
  }
  return normalized;
}

function readSkillMetadataMap(
  value: unknown,
  issues: SkillValidationIssue[],
): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    issues.push({
      code: 'invalid_metadata',
      severity: 'warning',
      field: 'metadata',
      message: 'Skill metadata must be a mapping of string keys to string values.',
    });
    return {};
  }
  const metadata: Record<string, string> = {};
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (typeof entry !== 'string') {
      issues.push({
        code: 'invalid_metadata',
        severity: 'warning',
        field: `metadata.${key}`,
        message: `Skill metadata value for "${key}" must be a string and was ignored.`,
      });
      continue;
    }
    metadata[key] = cleanPromptText(entry).trim();
  }
  return metadata;
}
