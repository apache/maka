// A case of the API's test suite (docs/dev/compatibility.md): the rich text
// editor's tables in `nsh/base` without a view: the extensions (`TableKit`,
// `RichTable`, `RichTableRow`, `RichTableHeader`, `RichTableCell`), the
// table commands (`insertTable`, `addRowAfter`, `mergeCells`, ...), cell
// selections (`{ type: "cell" }`) and GFM tables in Markdown. Each line
// shows one result; its script checks each.
import { Text, View, signal } from "nsh";
import {
  RichTable,
  RichTableCell,
  RichTableHeader,
  RichTableRow,
  StarterKit,
  TableKit,
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  createRichEditor,
  deleteColumn,
  deleteRow,
  deleteTable,
  fixTables,
  goToNextCell,
  goToPreviousCell,
  insertTable,
  mergeCells,
  mergeOrSplit,
  moveTableColumn,
  moveTableRow,
  setCellAttribute,
  setCellSelection,
  setColumnWidth,
  setRowHeight,
  splitCell,
  toggleHeaderCell,
  toggleHeaderColumn,
  toggleHeaderRow,
} from "nsh/base";

type NodeJSON = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: NodeJSON[];
  text?: string;
};

const textOf = (node: NodeJSON): string =>
  node.text ?? (node.content ?? []).map(textOf).join("");

// The first table's cells, row by row: `|` between cells, `/` between rows,
// `*` before header cells, `(colspan,rowspan)` after merged ones.
const shapeOf = (doc: NodeJSON): string => {
  const table = (doc.content ?? []).find((node) => node.type === "table");
  if (!table) return "none";
  return (table.content ?? [])
    .map((row) =>
      (row.content ?? [])
        .map((cell) => {
          const span = `${cell.attrs?.colspan ?? 1},${cell.attrs?.rowspan ?? 1}`;
          const head = cell.type === "tableHeader" ? "*" : "";
          return `${head}${textOf(cell)}${span === "1,1" ? "" : `(${span})`}`;
        })
        .join("|"),
    )
    .join("/");
};

function App() {
  const lines = signal<string[]>([]);

  const run = () => {
    const out: string[] = [];
    const step = (name: string, f: () => string) => {
      try {
        out.push(`${name}: ${f()}`);
      } catch (e) {
        out.push(`${name}: threw ${(e as Error).message}`);
      }
    };

    const editor = createRichEditor({ extensions: [StarterKit, TableKit], content: "" });
    const shape = () => shapeOf(editor.getJSON() as NodeJSON);
    let start = 0;
    step("Insert", () => {
      const ok = editor.run(insertTable({ rows: 2, cols: 2, withHeaderRow: true }));
      // The cursor is in the first cell's paragraph: 4 past the table's start.
      start = (editor.selection.anchor ?? 0) - 4;
      return `${ok} ${shape()}`;
    });
    step("AddRow", () => `${editor.run(addRowAfter())} ${shape()}`);
    step("AddColumn", () => `${editor.run(addColumnAfter())} ${shape()}`);
    step("Select", () => {
      // The header row's first two cells (each empty cell is 4 long).
      const ok = editor.run(setCellSelection({ anchorCell: start + 2, headCell: start + 6 }));
      return `${ok} ${editor.selection.type}`;
    });
    step("Merge", () => `${editor.run(mergeCells())} ${shape()}`);
    step("Split", () => `${editor.run(splitCell())} ${shape()}`);
    step("MergeOrSplit", () => {
      editor.run(setCellSelection({ anchorCell: start + 2, headCell: start + 6 }));
      const merged = editor.run(mergeOrSplit());
      const split = editor.run(mergeOrSplit());
      return `${merged} ${split} ${shape()}`;
    });
    step("DeleteRow", () => `${editor.run(deleteRow())} ${shape()}`);
    step("Headers", () => {
      const row = editor.run(toggleHeaderRow());
      const after = shape();
      const column = editor.run(toggleHeaderColumn());
      const cell = editor.run(toggleHeaderCell());
      return `${row} ${after} ${column} ${cell}`;
    });
    step("Cells", () => {
      const before = editor.run(addColumnBefore());
      const deleted = editor.run(deleteColumn());
      const row = editor.run(addRowBefore());
      return `${before} ${deleted} ${row}`;
    });
    step("Move", () => {
      const rows = editor.run(moveTableRow({ from: 0, to: 1, table: start }));
      const columns = editor.run(moveTableColumn({ from: 0, to: 2, select: false, table: start }));
      const inside = editor.run(moveTableRow({ from: 0, to: 0, table: start }));
      return `${rows} ${columns} ${inside}`;
    });
    step("Sizes", () => {
      const width = editor.run(setColumnWidth({ col: 0, width: 120, table: start }));
      const height = editor.run(setRowHeight({ row: 0, height: 40, table: start }));
      const doc = editor.getJSON() as NodeJSON;
      const table = (doc.content ?? []).find((node) => node.type === "table")!;
      const row = table.content![0];
      return `${width} ${height} ${JSON.stringify(row.content![0].attrs?.colwidth)} ${row.attrs?.height}`;
    });
    step("Attribute", () => {
      // Back into the table: its first cell.
      editor.run(setCellSelection({ anchorCell: start + 2 }));
      return `${editor.run(setCellAttribute("colwidth", [80]))}`;
    });
    step("Navigate", () => `${editor.run(goToNextCell())} ${editor.run(goToPreviousCell())}`);
    step("Fix", () => `${editor.run(fixTables())}`);
    step("DeleteTable", () => `${editor.run(deleteTable())} ${shape()}`);

    const md = createRichEditor({
      extensions: [StarterKit, RichTable, RichTableRow, RichTableHeader, RichTableCell],
      content: "| a | b |\n| --- | --- |\n| c | d |\n",
      format: "markdown",
    });
    step("Markdown", () => `${shapeOf(md.getJSON() as NodeJSON)} ${md.getMarkdown().trim().split("\n").length}`);
    step("Text", () => JSON.stringify(md.getText()));
    step("Configure", () => {
      const without = createRichEditor({
        extensions: [StarterKit, TableKit.configure({ table: { resizable: false } })],
      });
      return `${without.run(insertTable({ rows: 1, cols: 1, withHeaderRow: false }))}`;
    });
    lines.set(out);
  };

  return (
    <View style={{ flex: 1, paddingTop: 60, paddingLeft: 20, gap: 4 }}>
      <View onPress={run}><Text>RunTables</Text></View>
      {() => lines().map((line) => <Text>{line}</Text>)}
    </View>
  );
}

export default App;
