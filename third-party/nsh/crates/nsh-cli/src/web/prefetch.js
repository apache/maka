// The page's first script, written by `nsh package --target web` as a file
// of its own (not inline), so a site served with a strict `script-src`
// ('self') starts. It requests the files of `#nsh-fetch` (JSON) while the
// page is parsed, before the runtime has loaded, and once: the page's
// script (`start.js`) takes these responses (`fetches`) and reports their
// errors (the empty `catch` only keeps a failure that happens before then
// from being logged as unhandled). Not `<link rel=preload>`: WebKit does
// not hand a preload still in flight to the `fetch` of the same URL, which
// downloads the file again.
const fetches = new Map(JSON.parse(document.getElementById("nsh-fetch").textContent).map((path) => {
  const url = new URL(path, document.baseURI).href;
  const response = fetch(url);
  response.catch(() => {});
  return [url, response];
}));
