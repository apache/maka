// A case of the API's test suite (docs/dev/compatibility.md): CSS grid
// layout: templates of fixed, `fr`, percent, `auto` and `minmax()` tracks,
// `repeat()` and `auto-fill`, implicit tracks, auto-placement by rows, columns and
// densely, items placed by line numbers and spans, the
// alignment of items in their areas, gaps and right to left grids. Every
// test lays its boxes out in a frame of its own, and the script checks each
// box's frame relative to it.
import { Text, View } from "nsh";

type Style = Record<string, unknown>;

// A box filling its area (or as `style` says), named by its testID.
function Cell(props: { id: string; style?: Style }) {
  return <View testID={props.id} style={props.style} />;
}

// The grid of one test, 300 × 100 unless `style` says otherwise.
function Grid(props: { id: string; style?: Style; children?: JSX.Element | JSX.Element[] }) {
  return (
    <View testID={props.id} style={{ display: "grid", width: 300, height: 100, ...props.style }}>
      {props.children}
    </View>
  );
}

function App() {
  return (
    <View>
      <Text>Grid layout</Text>
      {/* fixed, fr and percent columns; fixed rows */}
      <Grid id="tracks" style={{ gridTemplateColumns: "100px 1fr 50px", gridTemplateRows: "20px 30px" }}>
        <Cell id="tracks-a" />
        <Cell id="tracks-b" />
        <Cell id="tracks-c" />
        <Cell id="tracks-d" />
      </Grid>
      <Grid id="fr" style={{ gridTemplateColumns: "1fr 2fr", gridTemplateRows: "1fr 3fr" }}>
        <Cell id="fr-a" />
        <Cell id="fr-b" />
        <Cell id="fr-c" />
      </Grid>
      <Grid id="percent" style={{ gridTemplateColumns: "25% 75%", gridTemplateRows: "50%" }}>
        <Cell id="percent-a" />
        <Cell id="percent-b" />
      </Grid>
      {/* repeat(), and the rows it leaves implicit sized by gridAutoRows */}
      <Grid id="repeat" style={{ gridTemplateColumns: "repeat(3, 1fr)", gridAutoRows: "40px" }}>
        <Cell id="repeat-a" />
        <Cell id="repeat-b" />
        <Cell id="repeat-c" />
        <Cell id="repeat-d" />
      </Grid>
      {/* as many 100-point columns as fit */}
      <Grid id="fill" style={{ gridTemplateColumns: "repeat(auto-fill, 100px)", gridAutoRows: "20px" }}>
        <Cell id="fill-a" />
        <Cell id="fill-b" />
        <Cell id="fill-c" />
        <Cell id="fill-d" />
      </Grid>
      {/* auto and minmax() tracks */}
      <Grid id="auto" style={{ gridTemplateColumns: "auto 1fr", gridTemplateRows: "30px" }}>
        <Cell id="auto-a" style={{ width: 80 }} />
        <Cell id="auto-b" />
      </Grid>
      <Grid id="minmax" style={{ gridTemplateColumns: "minmax(120px, 1fr) minmax(0, 100px)", gridTemplateRows: "30px" }}>
        <Cell id="minmax-a" />
        <Cell id="minmax-b" />
      </Grid>
      {/* gridAutoFlow: by columns, with implicit columns sized by gridAutoColumns */}
      <Grid id="flow-column" style={{ gridAutoFlow: "column", gridTemplateRows: "20px 20px", gridAutoColumns: "60px" }}>
        <Cell id="flow-column-a" />
        <Cell id="flow-column-b" />
        <Cell id="flow-column-c" />
      </Grid>
      <Grid id="flow-row" style={{ gridAutoFlow: "row", gridTemplateColumns: "100px 100px", gridAutoRows: "25px" }}>
        <Cell id="flow-row-a" />
        <Cell id="flow-row-b" />
        <Cell id="flow-row-c" />
      </Grid>
      {/* sparse and dense packing of a 1-column item after two 2-column ones */}
      <Grid id="sparse" style={{ gridTemplateColumns: "repeat(3, 100px)", gridAutoRows: "20px" }}>
        <Cell id="sparse-a" style={{ gridColumn: "span 2" }} />
        <Cell id="sparse-b" style={{ gridColumn: "span 2" }} />
        <Cell id="sparse-c" />
      </Grid>
      <Grid id="dense" style={{ gridAutoFlow: "row dense", gridTemplateColumns: "repeat(3, 100px)", gridAutoRows: "20px" }}>
        <Cell id="dense-a" style={{ gridColumn: "span 2" }} />
        <Cell id="dense-b" style={{ gridColumn: "span 2" }} />
        <Cell id="dense-c" />
      </Grid>
      <Grid id="dense-only" style={{ gridAutoFlow: "dense", gridTemplateColumns: "repeat(3, 100px)", gridAutoRows: "20px" }}>
        <Cell id="dense-only-a" style={{ gridColumn: "span 2" }} />
        <Cell id="dense-only-b" style={{ gridColumn: "span 2" }} />
        <Cell id="dense-only-c" />
      </Grid>
      <Grid id="column-dense" style={{ gridAutoFlow: "column dense", gridTemplateRows: "repeat(3, 20px)", gridAutoColumns: "50px" }}>
        <Cell id="column-dense-a" style={{ gridRow: "span 2" }} />
        <Cell id="column-dense-b" style={{ gridRow: "span 2" }} />
        <Cell id="column-dense-c" />
      </Grid>
      {/* placement by lines: shorthands, start and end, spans, and negative lines */}
      <Grid id="place" style={{ gridTemplateColumns: "repeat(3, 100px)", gridTemplateRows: "repeat(4, 25px)" }}>
        <Cell id="place-column" style={{ gridColumn: "2 / 4", gridRow: 1 }} />
        <Cell id="place-row" style={{ gridRow: "2 / span 2", gridColumn: 1 }} />
        <Cell id="place-start" style={{ gridColumnStart: 2, gridRowStart: 3 }} />
        <Cell id="place-end" style={{ gridColumnEnd: -1, gridRowEnd: 5, gridColumnStart: 3, gridRowStart: 4 }} />
        <Cell id="place-span" style={{ gridColumnEnd: "span 2", gridRowEnd: "span 2", gridColumnStart: 2, gridRowStart: 2 }} />
      </Grid>
      {/* the alignment of items in 100 × 50 areas */}
      <Grid id="items" style={{ gridTemplateColumns: "100px 100px 100px", gridTemplateRows: "50px 50px", justifyItems: "center", alignItems: "flex-end" }}>
        <Cell id="items-a" style={{ width: 40, height: 20 }} />
        <Cell id="items-b" style={{ width: 40, height: 20, justifySelf: "flex-start", alignSelf: "flex-start" }} />
        <Cell id="items-c" style={{ width: 40, height: 20, justifySelf: "flex-end", alignSelf: "center" }} />
        <Cell id="items-d" style={{ height: 20, justifySelf: "stretch" }} />
        <Cell id="items-e" style={{ width: 40, justifySelf: "auto", alignSelf: "stretch" }} />
      </Grid>
      <Grid id="items-start" style={{ gridTemplateColumns: "100px 100px", gridTemplateRows: "50px", justifyItems: "flex-start", alignItems: "flex-start" }}>
        <Cell id="items-start-a" style={{ width: 40, height: 20 }} />
        <Cell id="items-start-b" style={{ height: 20, justifySelf: "center" }} />
      </Grid>
      <Grid id="items-end" style={{ gridTemplateColumns: "100px", gridTemplateRows: "50px", justifyItems: "flex-end", alignItems: "center" }}>
        <Cell id="items-end-a" style={{ width: 40, height: 20 }} />
      </Grid>
      <Grid id="items-stretch" style={{ gridTemplateColumns: "100px", gridTemplateRows: "50px", justifyItems: "stretch" }}>
        <Cell id="items-stretch-a" />
      </Grid>
      {/* the tracks' alignment in the grid */}
      <Grid id="content" style={{ gridTemplateColumns: "100px 100px", gridTemplateRows: "20px 20px", justifyContent: "space-between", alignContent: "flex-end" }}>
        <Cell id="content-a" />
        <Cell id="content-b" />
        <Cell id="content-c" />
      </Grid>
      {/* gaps */}
      <Grid id="gap" style={{ gridTemplateColumns: "repeat(2, 1fr)", gridTemplateRows: "repeat(2, 1fr)", gap: 10 }}>
        <Cell id="gap-a" />
        <Cell id="gap-b" />
        <Cell id="gap-c" />
      </Grid>
      <Grid id="gaps" style={{ gridTemplateColumns: "repeat(2, 1fr)", gridTemplateRows: "repeat(2, 1fr)", rowGap: 20, columnGap: 6 }}>
        <Cell id="gaps-a" />
        <Cell id="gaps-b" />
        <Cell id="gaps-c" />
      </Grid>
      {/* right to left: the first column on the right */}
      <Grid id="rtl" style={{ direction: "rtl", gridTemplateColumns: "100px 1fr", gridTemplateRows: "40px" }}>
        <Cell id="rtl-a" />
        <Cell id="rtl-b" />
      </Grid>
    </View>
  );
}

export default App;
