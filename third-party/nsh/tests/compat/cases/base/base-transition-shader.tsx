// A case of the API's test suite (docs/dev/compatibility.md): a
// `transitionShader` on a `NavPage` and a `Dialog` of `nsh/base`, a WGSL
// shader they come and go through (the lower side `sample_from`, the upper
// `sample_to`) instead of their `animation`. A headless run presents
// nothing and renders no pixels, so the script checks that the pages and
// the dialog with one show, go and come back as without it, and sees each
// prop reach the core through the warning it logs for a uniform the
// program does not declare (`pageTint`, `dialogTint`).
import { Text, View, signal } from "nsh";
import { Button, Dialog, NavPage, NavStack, createNavStack } from "nsh/base";

const WIPE = {
  source: `fn shade(uv: vec2f) -> vec4f {
  return select(sample_from(uv), sample_to(uv), uv.x < nsh.progress);
}`,
  duration: 400,
};

const IRIS = {
  source: `struct Uniforms { softness: f32 }
fn shade(uv: vec2f) -> vec4f {
  let d = distance(uv, vec2f(0.5));
  return mix(sample_to(uv), sample_from(uv), smoothstep(nsh.progress - uniforms.softness, nsh.progress, d));
}`,
  uniforms: { softness: 0.05, pageTint: 1 },
};

const DIALOG = { ...WIPE, uniforms: { dialogTint: 1 } };

const nav = createNavStack<string>(["home"]);

function App() {
  const open = signal(false);
  return (
    <View style={{ flex: 1, paddingTop: 20 }}>
      <NavStack state={nav} style={{ flex: 1 }}>
        {(route: string) => (
          <NavPage title={route} transitionShader={route === "home" ? WIPE : IRIS}>
            <Text>{`Page ${route}`}</Text>
            <Button onPress={() => nav.push("details")}>
              <Text>Push details</Text>
            </Button>
            <Button onPress={() => nav.pop()}>
              <Text>Pop</Text>
            </Button>
            <Button onPress={() => open.set(true)}>
              <Text>Open dialog</Text>
            </Button>
          </NavPage>
        )}
      </NavStack>
      <Dialog open={open()} onOpenChange={e => open.set(e.open)} transitionShader={DIALOG}>
        <Text>Shader dialog</Text>
        <Button onPress={() => open.set(false)}>
          <Text>Close dialog</Text>
        </Button>
      </Dialog>
    </View>
  );
}

export default App;
