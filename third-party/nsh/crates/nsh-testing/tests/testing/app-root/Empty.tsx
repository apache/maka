// A released desktop app's root that declares no window at all: `mount`
// opens the implicit first window (`main`), empty, as the main window was.
import { mount } from "nsh";

mount(() => <></>);
