import { UrlScheme, openUrl, signal } from "nsh";
import { Button, Caption, Card, DemoPage, Row } from "../ui";

/**
 * `UrlScheme` of `nsh`: the URLs of the gallery's scheme (`nsh-gallery`, in
 * nsh.json `schemes`) that open the app, from the browser, another app or
 * the button here.
 */
export function UrlSchemeDemo() {
  const urls = signal<string[]>([]);
  UrlScheme.on("open", ({ url }) => urls.set([url, ...urls()].slice(0, 5)));
  return (
    <DemoPage
      cards={[
        () => (
          <Card title="Links" subtitle="nsh-gallery:// links open the gallery">
            <Row first>
              <Button label="Open a link" onPress={() => void openUrl(`nsh-gallery://demo/linking?at=${Date.now()}`)} />
            </Row>
            <Caption label={urls()[0] ?? "No link yet"} note={urls().length > 1 ? `${urls().length} links` : undefined} />
          </Card>
        ),
      ]}
    />
  );
}
