// The displays the app sees, for `Resize.test.tsx` to place the window
// against.
import { mount, Text } from "nsh";
import { displays } from "nsh/desktop";

mount(() => <Text>{JSON.stringify(displays())}</Text>);
