// A case of the API's test suite (docs/dev/compatibility.md): this domain
// declares capabilities without `homeDir`, so `homedir()` throws an
// `ERR_ACCESS_DENIED` naming the capability (`permission`), with no
// resource. Its script checks the error's name, code and fields.
import { Text } from "nsh";
import { homedir } from "os";

export default function HomeDirAccess() {
  let home: string;
  try {
    home = `told ${typeof homedir()}`;
  } catch (e: any) {
    home = [e.name, e.code, e.permission, JSON.stringify(e.resource)].join(" ");
  }
  return <Text>{`Home: ${home}`}</Text>;
}
