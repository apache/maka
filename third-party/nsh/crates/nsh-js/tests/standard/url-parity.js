// Shared unchanged by gpui-shell check and the native NSH Host test.
globalThis.urlParityFixture = function (url) {
  const sources = [
    'https://user:pass@example.com:8443/p?q=1#x',
    'https://a%20b:p%40ss@example.com/p',
    'https://example.com/',
    'https://example.com/p?#',
    'mailto:user@example.com',
    'file:///a%20b.txt',
    'https://[::1]:8443/p?q=1#x',
    'https://xn--fiq228c.com:8443/p?q=1#x',
  ];
  const formats = sources.map(source => {
    const value = new url.URL(source);
    return [url.format(value), url.format(value, { auth: false, fragment: false, search: false }),
      url.format(value, { unicode: true })];
  });
  const options = sources.map(source => url.urlToHttpOptions(new url.URL(source)));
  const paths = ['file:///a%20b.txt', 'file:///a%2Fb', 'file://server/share/a',
    'file:///C:/hello%20world', 'https://example.com/not-file'].map(source =>
      [url.fileURLToPath(source), url.fileURLToPath(new url.URL(source))]);
  const files = ['/a b#%.txt', '/你好/file.txt'].map(path => {
    const file = url.pathToFileURL(path);
    return [file.href, file instanceof url.URL, url.fileURLToPath(file)];
  });
  return { formats, options, paths, files,
    domain: [url.domainToASCII('中文.com'), url.domainToUnicode('xn--fiq228c.com')],
    brands: [url.URL === URL, url.URLSearchParams === URLSearchParams,
      new url.URL('https://example.com/?a=1').searchParams instanceof url.URLSearchParams] };
};
