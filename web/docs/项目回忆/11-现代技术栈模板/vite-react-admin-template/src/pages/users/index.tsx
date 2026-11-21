import { useEffect } from 'react';
import { toast } from 'sonner';
import { ChevronLeft, ChevronRight, Plus, Search } from 'lucide-react';
import { useUsersStore } from './store';
import { checkBtnPermission } from '@/helpers/permission';
import type { UserStatus } from '@/api/schemas';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';

const STATUS_META: Record<UserStatus, { label: string; variant: 'success' | 'secondary' }> = {
  active: { label: '启用', variant: 'success' },
  disabled: { label: '停用', variant: 'secondary' },
};

export default function UsersPage() {
  const params = useUsersStore((s) => s.params);
  const list = useUsersStore((s) => s.list);
  const total = useUsersStore((s) => s.total);
  const loading = useUsersStore((s) => s.loading);
  const submitToken = useUsersStore((s) => s.submitToken);
  const setKeyword = useUsersStore((s) => s.setKeyword);
  const setPageNum = useUsersStore((s) => s.setPageNum);
  const resetParams = useUsersStore((s) => s.resetParams);
  const submit = useUsersStore((s) => s.submit);
  const fetchUsers = useUsersStore((s) => s.fetchUsers);

  useEffect(() => {
    fetchUsers().catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : '加载用户列表失败');
    });
  }, [fetchUsers, params.pageNum, submitToken]);

  const totalPages = Math.max(1, Math.ceil(total / params.pageSize));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">用户管理</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            页面级 Zustand store + 分页表格 + 按钮权限示例
          </p>
        </div>
        {checkBtnPermission('btn:user:create') && (
          <Button
            onClick={() => toast.success('这里是新增用户入口（按钮权限 btn:user:create 已通过）')}
          >
            <Plus />
            新增用户
          </Button>
        )}
      </div>

      {/* 搜索区 */}
      <div className="flex items-center gap-2">
        <Input
          className="max-w-64"
          placeholder="搜索用户名 / 邮箱"
          value={params.keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <Button variant="outline" onClick={submit}>
          <Search />
          查询
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            resetParams();
            submit();
          }}
        >
          重置
        </Button>
      </div>

      {/* 列表 */}
      <div className="rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">ID</TableHead>
              <TableHead>用户名</TableHead>
              <TableHead>邮箱</TableHead>
              <TableHead className="w-24">状态</TableHead>
              <TableHead>创建时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading
              ? Array.from({ length: 5 }, (_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={5}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              : list.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell className="tabular-nums">{user.id}</TableCell>
                    <TableCell className="font-medium">{user.userName}</TableCell>
                    <TableCell className="text-muted-foreground">{user.email}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_META[user.status].variant}>
                        {STATUS_META[user.status].label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {user.createdAt}
                    </TableCell>
                  </TableRow>
                ))}
            {!loading && list.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground h-24 text-center">
                  暂无数据
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* 分页 */}
      <div className="flex items-center justify-end gap-3 text-sm">
        <span className="text-muted-foreground tabular-nums">
          共 {total} 条 · 第 {params.pageNum}/{totalPages} 页
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={params.pageNum <= 1 || loading}
          onClick={() => setPageNum(params.pageNum - 1)}
        >
          <ChevronLeft />
          上一页
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={params.pageNum >= totalPages || loading}
          onClick={() => setPageNum(params.pageNum + 1)}
        >
          下一页
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
