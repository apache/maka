import { mount, Text, View } from "nsh";
import { Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "nsh/base";
import { size, Stage, ui } from "./palette";

// A few rows the app writes out: the parts give screen readers a table, the
// classes and the palette give it its look.
const invoices = [
  { id: "INV001", status: "Paid", method: "Card", amount: 250 },
  { id: "INV002", status: "Pending", method: "Transfer", amount: 150 },
  { id: "INV003", status: "Unpaid", method: "Card", amount: 350 },
  { id: "INV004", status: "Paid", method: "Cash", amount: 450 },
];
const widths = ["w-24", "flex-1", "w-24", "w-24"];

function Cell(props: { i: number; head?: boolean; end?: boolean; children: string }) {
  const style = { fontSize: size.label, color: props.head ? ui().muted : ui().text, fontWeight: props.head ? ("500" as const) : ("400" as const) };
  const Part = props.head ? TableHead : TableCell;
  return (
    <Part class={`${widths[props.i]} px-3 py-2.5`}>
      <Text style={{ ...style, textAlign: props.end ? "right" : "left" }}>{props.children}</Text>
    </Part>
  );
}

function App() {
  const line = { borderBottomWidth: 1, borderColor: ui().line };
  const total = invoices.reduce((sum, i) => sum + i.amount, 0);
  return (
    <Stage width={520}>
      <View style={{ ...ui().card, borderRadius: 12, overflow: "hidden" }}>
        <Table accessibilityLabel="Recent invoices">
          <TableHeader>
            <TableRow style={line}>
              {["Invoice", "Status", "Method", "Amount"].map((title, i) => (
                <Cell i={i} head end={i === 3}>
                  {title}
                </Cell>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {invoices.map((inv) => (
              <TableRow style={line}>
                <Cell i={0}>{inv.id}</Cell>
                <Cell i={1}>{inv.status}</Cell>
                <Cell i={2}>{inv.method}</Cell>
                <Cell i={3} end>{`$${inv.amount.toFixed(2)}`}</Cell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow>
              <Cell i={0} head>Total</Cell>
              <Cell i={1}>{""}</Cell>
              <Cell i={2}>{""}</Cell>
              <Cell i={3} end>{`$${total.toFixed(2)}`}</Cell>
            </TableRow>
          </TableFooter>
          <TableCaption class="px-3 py-2">
            <Text style={{ fontSize: size.detail, color: ui().muted }}>A list of your recent invoices.</Text>
          </TableCaption>
        </Table>
      </View>
    </Stage>
  );
}

mount(App);
