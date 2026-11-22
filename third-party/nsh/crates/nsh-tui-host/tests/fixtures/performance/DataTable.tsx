import { mount } from "nsh";
import { DataTable } from "nsh/base";

const columns = Array.from({ length: 24 }, (_, index) => ({
  key: `c${index}`, title: `Column ${index + 1}`, width: 128,
}));
const data = Array.from({ length: 10000 }, (_, row) => Object.fromEntries(
  columns.map((column, index) => [column.key, `R${row + 1} C${index + 1}`]),
));

mount(() => <DataTable columns={columns} data={data} rowHeight={16}
  rowHeader={false} fontSize={16} style={{ flex: 1 }} />);
