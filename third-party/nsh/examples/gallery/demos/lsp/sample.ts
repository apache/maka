// The TypeScript sample of the Editor demo: a small module with what
// the simulated server finds in it: a TODO, a `var`, a loose `==`, an
// unused variable, a misspelled method and two color literals.
export const SAMPLE = `/** An order of the shop. */
interface Order {
  id: number;
  items: LineItem[];
  coupon?: string;
}

/** A product in an order, and how many of it. */
interface LineItem {
  name: string;
  price: number;
  quantity: number;
}

const BRAND = "#ff8800";
const MUTED = "#6b7280";

/** The lines of a receipt, printed to the console. */
class Receipt {
  lines: string[] = [];
  color: string = BRAND;

  /** Adds a line at the end. */
  add(text: string) {
    this.lines.push(text);
  }

  /** Prints every line, one under the other. */
  print() {
    console.log(this.lines.join("\\n"));
  }
}

/** The sum of the items' prices times their quantities. */
function subtotal(order: Order): number {
  return order.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

/** What the order's coupon takes off \`total\`. */
function discount(order: Order, total: number): number {
  // TODO: read the coupons from the server
  if (order.coupon == "SAVE10") return total * 0.1;
  return 0;
}

/** The order's number and what it costs, coupon taken off. */
function describe(order: Order): string {
  var total = subtotal(order);
  const unused = order.id * 2;
  return \`#\${order.id}: \${(total - discount(order, total)).toFixed(2)}\`;
}

const order: Order = { id: 7, items: [{ name: "Tea", price: 4.5, quantity: 2 }] };
const label = describe(order);
const receipt = new Receipt();
receipt.add(label);
receipt.prnt();
`;
