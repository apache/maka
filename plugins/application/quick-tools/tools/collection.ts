/* Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements. See NOTICE. Licensed under the Apache
 * License, Version 2.0: https://www.apache.org/licenses/LICENSE-2.0 */
import { qt } from '../shared/i18n.js';
import { FieldError } from '../shared/field-error.js';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { Context, Plugin, Row, Field, Action } from '../shared/plugin.js';
interface Item {
  id: string;
  name: string;
  target?: string;
  content?: string;
  keywords?: string;
}
interface Options {
  title: string;
  prefix: string;
  field: 'target' | 'content';
  label: string;
  createTitle?: string;
  validate(value: string): void;
  run(
    ctx: Context,
    item: Item,
    action: string,
    values: Record<string, string | boolean>,
  ): Promise<void>;
  actions(item: Item): Action[];
}
export async function collection(ctx: Context, options: Options): Promise<Plugin> {
  let items = await ctx.storage.read<Item[]>([]);
  const fields = (): Field[] => [
    { id: 'name', label: qt('名称'), required: true, maxLength: 160 },
    {
      id: options.field,
      label: options.label,
      type: options.field === 'content' ? 'textarea' : 'text',
      required: true,
      maxLength: options.field === 'content' ? 100000 : 4096,
    },
  ];
  const edit = (item?: Item): Action => ({
    id: 'save',
    title: item ? qt('编辑') : qt('新建'),
    data: item?.id,
    form: {
      title: item ? qt('编辑') : (options.createTitle ?? qt('新建')),
      fields: fields(),
      values: item ? { name: item.name, [options.field]: item[options.field] ?? '' } : {},
      draftKey: item?.id ?? 'new',
    },
  });
  const rows = (): Row[] =>
    items.map((item) => ({
      id: item.id,
      name: item.name,
      keywords: item.keywords,
      kind: options.title,
      detail: item[options.field],
      actions: [
        ...options.actions(item),
        edit(item),
        { id: 'delete', title: qt('删除'), data: item.id, confirm: qt('删除“${0}”？', item.name) },
      ],
    }));
  return {
    search: () => rows(),
    resolve: (id) => rows().find((row) => row.id === id),
    view: () => ({ title: options.title, rows: rows(), actions: [edit()] }),
    async run(action, data, values) {
      if (action === 'open') return { navigate: 'main' };
      if (action === 'save') {
        const name = z.string().trim().min(1).max(160).parse(values.name);
        const value = z
          .string()
          .min(1)
          .max(options.field === 'content' ? 100000 : 4096)
          .parse(values[options.field]);
        try {
          options.validate(value);
        } catch (error) {
          throw new FieldError(options.field, error instanceof Error ? error.message : String(error));
        }
        if (data !== undefined && !items.some((x) => x.id === data))
          throw Error(qt('此项目已不存在'));
        if (data === undefined && items.length >= 1000) throw Error(qt('最多保存 1000 项'));
        const item: Item = {
          id: typeof data === 'string' ? data : `${options.prefix}:${randomUUID()}`,
          name,
          [options.field]: value,
        };
        item.keywords = await ctx.call('text.transliterate', name).catch(() => '');
        const next = [...items.filter((x) => x.id !== item.id), item];
        await ctx.storage.write(next);
        items = next;
        ctx.changed();
        return;
      }
      const item = items.find((x) => x.id === data);
      if (!item) throw Error(qt('此项目已不存在'));
      if (action === 'delete') {
        const next = items.filter((x) => x.id !== data);
        await ctx.storage.write(next);
        items = next;
        ctx.changed();
        return { removed: [item.id] };
      }
      await options.run(ctx, item, action, values);
    },
  };
}
