import * as React from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "./cn";

// Tree：嵌套数据静态树（展开/受控状态为最小实现）

export interface TreeNodeData {
  id: string;
  label: string;
  children?: TreeNodeData[];
}

export function Tree({
  data,
  defaultExpandedIds = [],
  onSelect,
  className,
}: {
  data: TreeNodeData[];
  defaultExpandedIds?: string[];
  onSelect?: (id: string) => void;
  className?: string;
}) {
  return (
    <ul className={cn("space-y-0.5 text-sm", className)}>
      {data.map((node) => (
        <TreeItem key={node.id} node={node} expandedIds={defaultExpandedIds} onSelect={onSelect} depth={0} />
      ))}
    </ul>
  );
}

function TreeItem({
  node,
  expandedIds,
  onSelect,
  depth,
}: {
  node: TreeNodeData;
  expandedIds: string[];
  onSelect?: (id: string) => void;
  depth: number;
}) {
  const [open, setOpen] = React.useState(expandedIds.includes(node.id));
  const hasChildren = !!node.children?.length;

  return (
    <li>
      <div className="flex items-center gap-1 rounded-md px-2 py-1 hover:bg-accent" style={{ paddingLeft: depth * 16 + 8 }}>
        {hasChildren ? (
          <button type="button" onClick={() => setOpen(!open)} className="rounded p-0.5 hover:bg-muted" aria-label={open ? "收起" : "展开"}>
            <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
          </button>
        ) : (
          <span className="w-[18px]" />
        )}
        <button type="button" onClick={() => onSelect?.(node.id)} className="text-left">
          {node.label}
        </button>
      </div>
      {hasChildren && open ? (
        <ul className="space-y-0.5">
          {node.children!.map((child) => (
            <TreeItem key={child.id} node={child} expandedIds={expandedIds} onSelect={onSelect} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
