/* Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE. */
import { host } from 'nsh';
import { createHash, randomUUID } from 'crypto';
import { z } from 'zod';
import * as storage from './storage';
import { manifestSchema } from './schema';
import { qt } from '../shared/i18n';
import type { PackagePreview, Manifest } from '../shared/plugin';
const bundleSchema = z
  .object({
    format: z.literal(1),
    manifest: manifestSchema,
    code: z
      .string()
      .min(1)
      .max(8 * 1024 * 1024),
  })
  .strict();
export type Bundle = z.infer<typeof bundleSchema>;
const artifact = z.object({ bundle: bundleSchema, digest: z.string().regex(/^[a-f0-9]{64}$/) });
const record = artifact.extend({ previous: artifact.optional() });
const registry = z.object({ version: z.literal(1), records: z.array(record).max(64) });
type Record = z.infer<typeof record>;
const digest = (bundle: Bundle) =>
  createHash('sha256').update(JSON.stringify(bundle)).digest('hex');
export class Packages {
  records: Record[] = [];
  private writes: Promise<unknown> = Promise.resolve();
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const task = this.writes.catch(() => {}).then(run);
    this.writes = task;
    return task;
  }
  private pending = new Map<string, { bundle: Bundle; expected?: string; expires: number }>();
  async start() {
    this.records = registry.parse(
      await storage.read('extensions', { version: 1, records: [] }),
    ).records;
    if (new Set(this.records.map((r) => r.bundle.manifest.id)).size !== this.records.length)
      throw Error(qt('插件安装记录含重复 ID'));
    for (const record of this.records)
      if (
        digest(record.bundle) !== record.digest ||
        (record.previous &&
          (record.previous.bundle.manifest.id !== record.bundle.manifest.id ||
            digest(record.previous.bundle) !== record.previous.digest))
      )
        throw Error(qt('插件文件校验失败'));
  }
  async preview(value: unknown): Promise<PackagePreview> {
    const bundle = bundleSchema.parse(value);
    if (new TextEncoder().encode(bundle.code).byteLength > 8 * 1024 * 1024)
      throw Error(qt('插件代码包超过 8 MiB'));
    await host.call('quickTools.plugin.validate', { code: bundle.code });
    const current = this.records.find((r) => r.bundle.manifest.id === bundle.manifest.id);
    const token = randomUUID();
    if (this.pending.size >= 4) this.pending.delete(this.pending.keys().next().value!);
    this.pending.set(token, { bundle, expected: current?.digest, expires: Date.now() + 300000 });
    return {
      token,
      manifest: bundle.manifest as Manifest,
      currentVersion: current?.bundle.manifest.version,
      digest: digest(bundle),
    };
  }
  commit(token: string) {
    return this.serial(async () => {
      const pending = this.pending.get(token);
      this.pending.delete(token);
      if (!pending || pending.expires < Date.now())
        throw Error(qt('安装预览已过期，请重新选择插件包'));
      const current = this.records.find((r) => r.bundle.manifest.id === pending.bundle.manifest.id);
      if (current?.digest !== pending.expected) throw Error(qt('插件版本已变化，请重新预览后安装'));
      const next = {
        bundle: pending.bundle,
        digest: digest(pending.bundle),
        previous: current ? { bundle: current.bundle, digest: current.digest } : undefined,
      };
      await this.save([...this.records.filter((r) => r !== current), next]);
      return next.bundle;
    });
  }
  rollback(id: string) {
    return this.serial(async () => {
      const current = this.records.find((r) => r.bundle.manifest.id === id);
      if (!current?.previous) throw Error(qt('没有可回退的版本'));
      if (digest(current.previous.bundle) !== current.previous.digest)
        throw Error(qt('旧版本校验失败'));
      const next = {
        ...current.previous,
        previous: { bundle: current.bundle, digest: current.digest },
      };
      await this.save(this.records.map((r) => (r === current ? next : r)));
      return next.bundle;
    });
  }
  remove(id: string) {
    return this.serial(() => this.save(this.records.filter((r) => r.bundle.manifest.id !== id)));
  }
  cancel(token: string) {
    this.pending.delete(token);
  }
  private async save(records: Record[]) {
    await storage.write('extensions', { version: 1, records });
    this.records = records;
  }
}
