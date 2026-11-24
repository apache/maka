// `nsh test examples/bench/GridTs.tsx --trace`: the Grid screen with the Ts Button.
import { mount } from "nsh";
import { Window } from "nsh/desktop";
import { Button } from "./TsButton";
import { Grid } from "./buttons";

mount(() => <Window id="main">{() => <Grid Button={Button} />}</Window>);
