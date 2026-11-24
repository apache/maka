// The Photos list on its own: the entry of the scroll benchmarks (`nsh
// test examples/gallery/Bench.tsx --trace` with the step
// `await app.scroll("id:photos", 3000)` on stdin, the `list_bench` test).
import { mount } from "nsh";
import { Window } from "nsh/desktop";
import { Photos } from "./demos/Photos";

mount(() => <Window id="main">{Photos}</Window>);
