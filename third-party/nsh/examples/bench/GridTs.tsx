// `nsh test examples/bench/GridTs.tsx --trace`: the Grid screen with the Ts Button.
import { mount } from "nsh";
import { Button } from "./TsButton";
import { Grid } from "./buttons";

mount(() => <Grid Button={Button} />);
