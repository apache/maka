/* Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements. See NOTICE. Licensed under the Apache
 * License, Version 2.0: https://www.apache.org/licenses/LICENSE-2.0 */
import { qt } from '../../shared/i18n.js';
import { resolveLink, linkTarget } from '../../shared/search.js';

function parameterName(token: string) {
  return /^argument\s+name="([^"]+)"$/.exec(token)?.[1] ?? (token === 'argument' ? 'query' : token);
}

/** Parameters are URL components; file paths stay literal, including braces. */
export function parameters(target: string): string[] {
  target = linkTarget(target);
  if (target.startsWith('/') || target.startsWith('~/') || /^file:/i.test(target)) return [];
  const names = [...target.matchAll(/\{([^{}]+)\}/g)].map((match) => parameterName(match[1]));
  if (names.some((name) => !/^[\p{L}\p{N}_ -]{1,40}$/u.test(name))) {
    throw Error(qt('参数名称请使用 1–40 个文字、数字、空格、下划线或连字符'));
  }
  if (/[{}]/.test(target.replace(/\{[^{}]+\}/g, '')))
    throw Error(qt('参数格式应为 {query} 或 {参数名}'));
  const unique = [...new Set(names)];
  if (unique.length > 12) throw Error(qt('最多使用 12 个参数'));
  return unique;
}

export function validateTemplate(target: string): void {
  target = linkTarget(target);
  const names = parameters(target);
  const sample = target.replace(/\{([^{}]+)\}/g, (match, name) =>
    names.includes(parameterName(name)) ? 'example' : match,
  );
  resolveLink(sample);
  if (names.length) {
    if (!/^[a-z][a-z0-9+.-]*:/i.test(target) || target.includes('\\'))
      throw Error(qt('参数只能放在网址路径、查询或片段中'));
    const authority = target.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i)?.[1] ?? '';
    if (/[{}]/.test(authority)) throw Error(qt('参数只能放在网址路径、查询或片段中'));
  }
}

export function expandTemplate(target: string, values: Record<string, string | boolean>): string {
  target = linkTarget(target);
  validateTemplate(target);
  const names = parameters(target);
  for (const name of names) {
    const value = Object.hasOwn(values, name) ? values[name] : undefined;
    if (typeof value !== 'string' || !value.trim())
      throw Error(qt('请先填写${0}', name === 'query' ? qt('搜索词') : name));
    if (value.length > 4096) throw Error(qt('参数不能超过 4096 个字符'));
  }
  // Do not pass literal file paths through the legacy {query} replacement.
  if (!names.length) return resolveLink(target);
  return resolveLink(
    target.replace(/\{([^{}]+)\}/g, (_, name) =>
      encodeURIComponent(values[parameterName(name)] as string),
    ),
  );
}
