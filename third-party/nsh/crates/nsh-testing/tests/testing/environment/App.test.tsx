import { expect, open, test } from "nsh/test";

test("the environment is what open asks for", async () => {
  const app = await open("./App.tsx", {
    colorScheme: "dark",
    locale: "de_DE",
    localeSettings: {
      timeZone: "Europe/Berlin",
      languages: ["de-AT", "de_DE", "en"],
      hourCycle: "h12",
      temperatureUnit: "fahrenheit",
    },
    reducedMotion: true,
    platform: "android",
    width: 320,
    height: 640,
  });
  expect(app.shows("Scheme: dark")).toBe(true);
  expect(app.shows("Locale: de-DE")).toBe(true);
  expect(app.shows("Zone: Europe/Berlin")).toBe(true);
  expect(app.shows("Intl agrees: true")).toBe(true);
  expect(app.shows("Languages: de-AT,de-DE,en")).toBe(true);
  // What open does not set is the locale's region's.
  expect(app.shows("Regional: h12 1 metric fahrenheit")).toBe(true);
  expect(app.shows("Motion: reduced")).toBe(true);
  expect(app.shows("OS: android")).toBe(true);
  expect(app.shows("Size: 320x640")).toBe(true);
});

test("the defaults are a light iPhone in en-US", async () => {
  const app = await open("./App.tsx");
  expect(app.shows("Scheme: light")).toBe(true);
  expect(app.shows("Locale: en-US")).toBe(true);
  expect(app.shows("Motion: full")).toBe(true);
  expect(app.shows("OS: ios")).toBe(true);
  expect(app.shows("Size: 390x844")).toBe(true);
  expect(app.shows("App: active")).toBe(true);
  expect(app.shows("Zone: UTC")).toBe(true);
  expect(app.shows("Intl agrees: true")).toBe(true);
  expect(app.shows("Languages: en-US")).toBe(true);
  expect(app.shows("Regional: h12 7 us fahrenheit")).toBe(true);
});

test("the regional preferences follow the system's", async () => {
  const app = await open("./App.tsx", { locale: "en_GB", localeSettings: { firstDayOfWeek: 7 } });
  expect(app.shows("Regional: h23 7 uk celsius")).toBe(true);
  await app.setLocaleSettings({ hourCycle: "h12", measurementSystem: "metric" });
  expect(app.shows("Regional: h12 7 metric celsius")).toBe(true);
  // What it does not name stays.
  expect(app.shows("Languages: en-GB")).toBe(true);
  expect(app.shows("Zone: UTC")).toBe(true);
  await expect(() => app.setLocaleSettings({ firstDayOfWeek: 8 })).rejects.toThrow(
    "8 is not a day of the week",
  );
  await expect(() => open("./App.tsx", { localeSettings: { firstDayOfWeek: 0 } })).rejects.toThrow(
    "0 is not a day of the week",
  );
});

test("the languages are the locale's unless open lists others", async () => {
  const app = await open("./App.tsx", { locale: "fr_FR" });
  expect(app.shows("Languages: fr-FR")).toBe(true);
});

test("the languages follow the system's", async () => {
  const app = await open("./App.tsx");
  await app.setLocaleSettings({ languages: ["ja-JP", "en-US"] });
  expect(app.shows("Languages: ja-JP,en-US")).toBe(true);
  await expect(() => app.setLocaleSettings({ languages: ["!"] })).rejects.toThrow("names no language");
  await expect(() => open("./App.tsx", { localeSettings: { languages: [] } })).rejects.toThrow(
    "names no language",
  );
});

test("the appearance and the viewport change while the app runs", async () => {
  const app = await open("./App.tsx");
  await app.setColorScheme("dark");
  expect(app.shows("Scheme: dark")).toBe(true);
  await app.setViewport(844, 390);
  expect(app.shows("Size: 844x390")).toBe(true);
});

test("the lifecycle follows the system's", async () => {
  const app = await open("./App.tsx");
  await app.setLifecycle("inactive");
  expect(app.shows("App: inactive")).toBe(true);
  await app.setLifecycle("background");
  expect(app.shows("App: background")).toBe(true);
  await app.setLifecycle("active");
  expect(app.shows("App: active")).toBe(true);
});

test("the time zone follows the system's", async () => {
  const app = await open("./App.tsx");
  await app.setLocaleSettings({ timeZone: "Asia/Tokyo" });
  expect(app.shows("Zone: Asia/Tokyo")).toBe(true);
  expect(app.shows("Intl agrees: true")).toBe(true);
  await expect(() => app.setLocaleSettings({ timeZone: "Not a zone" })).rejects.toThrow(
    "is not a time zone",
  );
  expect(app.shows("Zone: Asia/Tokyo")).toBe(true);
});

test("an invalid time zone fails open", async () => {
  await expect(() => open("./App.tsx", { localeSettings: { timeZone: "../zone" } })).rejects.toThrow(
    "is not a time zone",
  );
});

test("an invalid locale fails open", async () => {
  await expect(() => open("./App.tsx", { locale: "!" })).rejects.toThrow("is not a locale");
});

test("a route's function answers from the request", async () => {
  const app = await open("./App.tsx", {
    network: {
      "POST https://api.test/echo": (request) => ({
        status: 201,
        body: `${request.method} ${request.headers["x-item"]} ${request.body}`,
      }),
      "POST https://api.test/items/*": async (request) => ({ body: request.url.split("/").pop() }),
    },
  });
  await app.press("Echo");
  await app.waitFor("Result: 201 POST 7 hello");
  await app.press("Item");
  await app.waitFor("Result: 200 7");
  const requests = app.requests();
  expect(requests).toHaveLength(2);
  expect(requests[0].url).toBe("https://api.test/echo");
  expect(requests[0].method).toBe("POST");
  expect(requests[0].body).toBe("hello");
  expect(requests[1].url).toBe("https://api.test/items/7");
});

test("a route fails or answers late as it says", async () => {
  const app = await open("./App.tsx", {
    network: {
      "POST https://api.test/down": { error: "offline" },
      "POST https://api.test/slow": { body: "at last", delay: 300 },
    },
  });
  await app.press("Down");
  await app.waitFor("Result: failed: Network request failed: offline");
  await app.press("Slow");
  expect(app.shows("Result: 200 at last")).toBe(false);
  await app.waitFor("Result: 200 at last");
});

test("a route's function that throws fails the step", async () => {
  const app = await open("./App.tsx", {
    network: {
      "POST https://api.test/broken": () => {
        throw new Error("no such item");
      },
    },
  });
  await expect(() => app.press("Broken")).rejects.toThrow("no such item");
});
