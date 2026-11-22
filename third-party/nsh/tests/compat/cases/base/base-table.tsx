// A case of the API's test suite (docs/dev/compatibility.md): `Table` of
// `nsh/base` and its parts, a table of the app's rows with no look of its
// own: the roles screen readers get (table, row groups, rows, column
// headers, cells), the table's label (`accessibilityLabel`), a row's cells
// side by side, and the app's look of each part (`class`), which their
// frames show.
import { Text } from "nsh";
import { Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "nsh/base";

function App() {
  return (
    <Table testID="table" accessibilityLabel="Invoices" class="pt-[20px]">
      <TableHeader testID="head">
        <TableRow testID="head-row">
          <TableHead testID="title" class="w-[100px] h-[30px]">
            <Text>Invoice</Text>
          </TableHead>
          <TableHead class="w-[80px] h-[30px]">
            <Text>Amount</Text>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody testID="body">
        <TableRow testID="row">
          <TableCell testID="cell" class="w-[100px] h-[24px]">
            <Text>INV001</Text>
          </TableCell>
          <TableCell testID="amount" class="w-[80px] h-[24px]">
            <Text>$250.00</Text>
          </TableCell>
        </TableRow>
      </TableBody>
      <TableFooter testID="foot">
        <TableRow>
          <TableCell class="w-[100px] h-[24px]">
            <Text>Total</Text>
          </TableCell>
        </TableRow>
      </TableFooter>
      <TableCaption testID="caption" class="h-[16px]">
        <Text>Recent invoices</Text>
      </TableCaption>
    </Table>
  );
}

export default App;
