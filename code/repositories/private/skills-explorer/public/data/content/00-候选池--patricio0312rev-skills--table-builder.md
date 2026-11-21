---
name: table-builder
description: Creates data table patterns with filtering, sorting, pagination, row actions, column configuration, server/client rendering modes, and empty/loading states. Use when building "data tables", "list views", "admin tables", or "data grids".
---

# Table Builder

Generate production-ready data tables with sorting, filtering, and pagination.

## Core Workflow

1. **Define columns**: Column configuration with types
2. **Choose mode**: Server-side or client-side rendering
3. **Add features**: Sorting, filtering, pagination, search
4. **Row actions**: Edit, delete, view actions
5. **Empty states**: No data and error views
6. **Loading states**: Skeletons and suspense
7. **Mobile responsive**: Stack columns or horizontal scroll

## Column Configuration

```typescript
import { ColumnDef } from "@tanstack/react-table";

export const columns: ColumnDef<User>[] = [
  {
    accessorKey: "id",
    header: "ID",
    cell: ({ row }) => (
      <span className="font-mono text-sm">{row.original.id}</span>
    ),
  },
  {
    accessorKey: "name",
    header: ({ column }) => (
      <Button
        variant="ghost"
        onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
      >
        Name
        <ArrowUpDown className="ml-2 h-4 w-4" />
      </Button>
    ),
    cell: ({ row }) => (
      <div className="font-medium">{row.getValue("name")}</div>
    ),
  },
  {
    accessorKey: "email",
    header: "Email",
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => {
      const status = row.getValue("status") as string;
      return (
        <Badge variant={status === "active" ? "success" : "secondary"}>
          {status}
        </Badge>
      );
    },
  },
  {
    id: "actions",
    cell: ({ row }) => <RowActions row={row} />,
  },
];
```

## React Table Implementation

```typescript
"use client";

import {
  useReactTable,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
} from "@tanstack/react-table";

export function DataTable<TData, TValue>({
  columns,
  data,
}: {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 10 });

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onPaginationChange: setPagination,
    state: { sorting, columnFilters, pagination },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Input
          placeholder="Search..."
          value={(table.getColumn("name")?.getFilterValue() as string) ?? ""}
          onChange={(e) =>
            table.getColumn("name")?.setFilterValue(e.target.value)
          }
          className="max-w-sm"
        />
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id}>
                    {flexRender(
                      header.column.columnDef.header,
                      header.getContext()
                    )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext()
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center"
                >
                  No results.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <DataTablePagination table={table} />
    </div>
  );
}
```

## Server-Side Pattern

```typescript
// app/users/page.tsx
import { DataTable } from "@/components/ui/data-table";

async function getUsers(params: {
  page: number;
  pageSize: number;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  search?: string;
}) {
  const response = await fetch(`/api/users?${new URLSearchParams(params)}`);
  return response.json();
}

export default async function UsersPage({
  searchParams,
}: {
  searchParams: { page?: string; search?: string };
}) {
  const page = Number(searchParams.page) || 1;
  const search = searchParams.search || "";

  const { data, totalPages } = await getUsers({ page, pageSize: 10, search });

  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-bold">Users</h1>
      <DataTable columns={columns} data={data} totalPages={totalPages} />
    </div>
  );
}
```

## Pagination Component

```typescript
export function DataTablePagination({ table }: { table: Table<any> }) {
  return (
    <div className="flex items-center justify-between px-2">
      <div className="text-sm text-gray-700">
        {table.getFilteredSelectedRowModel().rows.length} of{" "}
        {table.getFilteredRowModel().rows.length} row(s) selected
      </div>
      <div className="flex items-center space-x-6">
        <div className="flex items-center space-x-2">
          <p className="text-sm font-medium">Rows per page</p>
          <Select
            value={`${table.getState().pagination.pageSize}`}
            onValueChange={(value) => table.setPageSize(Number(value))}
          >
            <option value="10">10</option>
            <option value="20">20</option>
            <option value="50">50</option>
          </Select>
        </div>
        <div className="flex items-center space-x-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
```

## Row Actions

```typescript
function RowActions({ row }: { row: Row<User> }) {
  const user = row.original;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon">
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={() => navigator.clipboard.writeText(user.id)}
        >
          Copy ID
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => router.push(`/users/${user.id}`)}>
          View Details
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => handleEdit(user)}>
          Edit
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-red-600"
          onClick={() => handleDelete(user)}
        >
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

## Empty State

```typescript
export function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-12">
      <div className="rounded-full bg-gray-100 p-6">
        <InboxIcon className="h-12 w-12 text-gray-400" />
      </div>
      <h3 className="mt-4 text-lg font-semibold">No data found</h3>
      <p className="mt-2 text-sm text-gray-600">
        Get started by creating a new record.
      </p>
      <Button className="mt-4">Create New</Button>
    </div>
  );
}
```

## Loading Skeleton

```typescript
export function TableSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-10 w-64" />
      <div className="rounded-md border">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="flex gap-4 border-b p-4">
            <Skeleton className="h-6 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
```

## Best Practices

- Use TanStack Table for complex features
- Server-side pagination for large datasets
- Debounce search inputs
- Persist sorting/filtering in URL params
- Mobile: Horizontal scroll or card view
- Accessibility: Keyboard navigation, ARIA

## Output Checklist

- [ ] Column definitions with types
- [ ] Sorting functionality
- [ ] Filtering/search
- [ ] Pagination controls
- [ ] Row actions menu
- [ ] Empty state component
- [ ] Loading skeleton
- [ ] Mobile responsive
- [ ] URL state persistence
- [ ] Accessibility attributes
