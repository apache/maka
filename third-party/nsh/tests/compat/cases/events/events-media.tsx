// A case of the API's test suite (docs/dev/compatibility.md): what images,
// videos and web views report as they load and play: an image starting,
// progressing, loading with its size and ending, another failing; a video
// loading with its duration and size, playing, buffering, ending and
// failing; a web page starting, loading, navigating, posting a message and
// failing. The platform raises them; each handler shows what it gets as
// text. Its
// script checks each.
import { Text, View, signal } from "nsh";
import { Image } from "nsh";
import { Video } from "nsh";
import { WebView } from "nsh";

type Navigation = { url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean };

function nav(e: Navigation): string {
  return `${e.url} "${e.title}" loading ${e.loading} back ${e.canGoBack} forward ${e.canGoForward}`;
}

function App() {
  const image = signal<string[]>([]);
  const broken = signal<string[]>([]);
  const video = signal<string[]>([]);
  const web = signal<string[]>([]);
  const add = (log: typeof image, line: string) => log.update((l) => [...l, line]);
  return (
    <View style={{ flex: 1, paddingTop: 64 }}>
      <Image
        testID="image"
        src="https://example.com/compat.png"
        style={{ width: 64, height: 48 }}
        onLoadStart={() => add(image, "start")}
        onProgress={(e) => add(image, `progress ${e.loaded}/${e.total}`)}
        onLoad={(e) => add(image, `load ${e.width}x${e.height}`)}
        onLoadEnd={() => add(image, "end")}
      />
      <Text>Image: {image().join(" | ")}</Text>
      <Image
        testID="broken"
        src="https://example.com/missing.png"
        style={{ width: 64, height: 48 }}
        onError={(e) => add(broken, `error ${e.message}`)}
      />
      <Text>Broken: {broken().join(" | ")}</Text>
      <Video
        testID="video"
        src="https://example.com/compat.mp4"
        paused
        style={{ width: 160, height: 90 }}
        onLoadStart={() => add(video, "start")}
        onLoad={(e) => add(video, `load ${e.duration}s ${e.size.width}x${e.size.height}`)}
        onProgress={(e) => add(video, `at ${e.currentTime}/${e.duration}`)}
        onBuffer={(e) => add(video, `buffering ${e.isBuffering}`)}
        onEnd={() => add(video, "end")}
        onError={(e) => add(video, `error ${e.message}`)}
      />
      <Text>Video: {video().join(" | ")}</Text>
      <WebView
        testID="web"
        src="https://example.com/"
        style={{ width: 180, height: 60 }}
        onLoadStart={(e) => add(web, `start ${nav(e)}`)}
        onLoad={(e) => add(web, `load ${nav(e)}`)}
        onNavigationStateChange={(e) => add(web, `nav ${nav(e)}`)}
        onMessage={(e) => add(web, `message ${e.data}`)}
        onError={(e) => add(web, `error ${e.message}`)}
      />
      <Text>Web: {web().join(" | ")}</Text>
    </View>
  );
}

export default App;
