export interface NumstatEntry {
  additions: number;
  deletions: number;
  path: string;
  oldPath?: string;
  binary: boolean;
}

/**
 * 解析 `git diff --numstat -z` 输出（记录以 NUL 结尾、字段以 TAB 分隔）。
 * git 2.55 实测格式：
 *   普通:    增\\t删\\t路径\\0
 *   rename:  增\\t删\\t\\0旧路径\\0新路径\\0   （第三个字段为空，后跟两条裸路径记录）
 *   二进制:  增删两位是 '-'
 * 另兼容 增\\t删\\t旧\\t新 的 4 字段排版。
 */
export function parseNumstat(raw: string): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  const records = raw.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const fields = record.split('\t');
    const adds = fields[0];
    const dels = fields[1];
    if (adds === undefined || dels === undefined) continue;
    const binary = adds === '-' && dels === '-';
    const additions = binary ? 0 : Number(adds);
    const deletions = binary ? 0 : Number(dels);

    if (fields.length >= 4) {
      entries.push({ additions, deletions, oldPath: fields[2]!, path: fields[3]!, binary });
      continue;
    }

    const pathField = fields[2] ?? '';
    if (pathField === '') {
      // rename：紧跟两条裸路径记录（旧、新）
      const oldPath = records[++i];
      const newPath = records[++i];
      if (oldPath && newPath) entries.push({ additions, deletions, oldPath, path: newPath, binary });
    } else {
      entries.push({ additions, deletions, path: pathField, oldPath: undefined, binary });
    }
  }
  return entries;
}
