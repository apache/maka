// A link's optional title supplements its destination on pointer devices.
import { Text } from "nsh";
import { Link } from "nsh/base";

export default function LinkHover() {
  return (
    <Link testID="destination" href="https://example.com/docs" title="Documentation reference">
      <Text>Docs</Text>
    </Link>
  );
}
