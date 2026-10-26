import type { DataTableClasses } from "nsh/base";

/** Extra room for this UI layer's cell padding and title/button gap. */
export const dataTableFitPadding = 16;

/** The shared table look. nsh/base owns its structure and interaction. */
export const dataTableClasses: DataTableClasses = {
  root: "rounded-lg border border-border bg-background text-foreground",
  header: "border-b border-border bg-muted/50 text-muted-foreground",
  headerCell: "pl-2 pr-1",
  headerContent: "gap-1",
  headerCellSelected: "bg-primary/10",
  headerCellDragging: "opacity-50",
  groupCell: "border-b border-r border-border px-2",
  sortIndicator: "rounded text-muted-foreground hover:bg-foreground/10 active:bg-foreground/15",
  sortAscending: "text-muted-foreground opacity-60 selected:text-foreground selected:opacity-100",
  sortDescending: "text-muted-foreground opacity-60 selected:text-foreground selected:opacity-100",
  resizeHandle: "bg-border group-hover:bg-primary group-active:bg-primary",
  moveIndicator: "bg-primary",
  row: "border-b border-border/60",
  rowOdd: "bg-muted/35",
  rowHover: "bg-muted/60",
  rowSelected: "bg-primary/12",
  rowActive: "bg-muted/60",
  cell: "px-2",
  cellSelected: "border border-primary",
  cellColumnSelected: "bg-primary/8",
  cellActive: "border border-primary/50",
  rowHeader: "text-muted-foreground",
  fixedEdge: "bg-border",
};
