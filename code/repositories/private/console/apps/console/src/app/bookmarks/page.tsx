'use client';

// 书签台：浏览器书签 HTML 导入（预览确认）+ 搜索/分类过滤/回收站/批量/近似去重。

import { BookmarksPanel } from '@/components/bookmarks/BookmarksPanel';

export default function BookmarksPage() {
  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <main className="mx-auto flex min-h-[calc(100dvh-3rem)] max-w-4xl flex-col rounded-xl border border-border bg-card p-6 lg:p-7">
        <BookmarksPanel />
      </main>
    </div>
  );
}
