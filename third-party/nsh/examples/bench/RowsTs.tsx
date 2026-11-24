// `nsh test examples/bench/RowsTs.tsx --trace`: the Rows screen with the Ts Button.
import { mount } from "nsh";
import { Window } from "nsh/desktop";
import { Button } from "./TsButton";
import { Rows } from "./buttons";

mount(() => <Window id="main">{() => <Rows Button={Button} />}</Window>);
