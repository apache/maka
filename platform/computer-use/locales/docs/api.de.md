Computer Use ist ein eigenständiges, persistentes JavaScript-REPL. Verwenden Sie `cua_repl` direkt; Code Mode ist nicht erforderlich. Variablen und gebundene Objekte bleiben über Aufrufe und Turns hinweg innerhalb des aktuellen Host-Prozesses erhalten. Ein neues REPL nach einem Neustart enthält keine Variablen aus der Historie; orientieren Sie sich am aktuellen Computer-Use-Zustand, der mit der Modellanfrage mitgeliefert wird.
Beginnen Sie bei Websites mit `await cua.listBrowsers()` und nutzen Sie einen Browser-Tab, bevor Sie Eingaben über ein natives Browserfenster ausführen. Installierte ChatGPT-Verbindungen können bei Bedarf übernommen werden, ohne Shell-Einrichtung oder das Starten der ChatGPT-Desktop-App.
Verwenden Sie Top-Level-`await`, kein Top-Level-`return`. Dieses REPL behält Deklarationen bei; verwenden Sie vorhandene Bindungen weiter oder wählen Sie neue Namen. Es stehen weder Node-APIs noch `setTimeout` zur Verfügung.

`cua.computer.target` identifiziert die ausgewählte Desktop-Plattform (`mac`, `linux`, `windows`).
Unter WSL ist standardmäßig der Windows-Host ausgewählt; Shell-Befehle laufen dennoch möglicherweise unter Linux.

`cua.computer` stellt außerdem plattformspezifische native Methoden in snake_case bereit. Diese erwarten ein Optionsobjekt statt der unten beschriebenen positionalen App/Tab-Argumente; `list_apps()`, `list_windows()` und unter Linux `get_screenshot()` nehmen keine Optionen entgegen. Ermitteln Sie zuerst die ausgewählte Oberfläche und lesen Sie deren Inventar:
```js
const native = cua.computer;
nodeRepl.write({target: native.target, methods: Object.keys(native).filter(k => typeof native[k] === 'function')});
nodeRepl.write(await (native.list_windows ? native.list_windows() : native.list_apps()));
```
| target | Native Methoden (Audio ist separat dokumentiert) |
| --- | --- |
| `linux` | `perform_secondary_action`, `click`, `drag`, `drag_handle`, `activate_window`, `get_screenshot`, `list_apps`, `list_windows`, `move`, `move_relative`, `press_key`, `scroll`, `type_text`, `launch_app`, `get_window_state` |
| `mac` | `list_apps`, `get_app_state`, `click`, `drag`, `paste`, `perform_secondary_action`, `press_key`, `scroll`, `select_text`, `set_value`, `type_text` |
| `windows` | `activate_window`, `get_window_state`, `click`, `scroll`, `drag`, `press_key`, `type_text`, `launch_app`, `list_apps`, `list_windows`, `get_window`, `perform_secondary_action`, `set_value` |

- Linux X11: Verwenden Sie ein zurückgegebenes `window`-Objekt für `get_window_state({window, query?, include_screenshot?})`. Übergeben Sie eine beobachtete `element_id` **oder** ganzzahlige `x,y` an `click({window, element_id})` / `click({window, x, y, mouse_button?, click_count?, duration?, key?})`; Fensterkoordinaten sind fensterlokal, und das Weglassen von `window` adressiert den Desktop. Weitere Eingaben sind `type_text({window?, text, element_id?})`, `press_key({window?, key, duration?})`, `scroll({window?, direction, pixels?, x?, y?, element_id?, key?})`, `drag({window?, path:[{x,y},…], key?})`, `move({window?, x,y,key?})`, `move_relative({dx,dy,key?})`, `activate_window({window})`, `perform_secondary_action({window,element_id,action})` und `launch_app({app})`. `duration` wird in Millisekunden angegeben. `drag_handle()` erzeugt ein Desktop-Handle mit `start({x,y})`, `move_to({x,y})`, `end()`; beenden Sie es explizit innerhalb des Turns.
- Windows: Verwenden Sie den zurückgegebenen Fensterdeskriptor `{app,id,...}`. Lesen Sie `get_window_state({window, include_text?, include_screenshot?})` vor indexierten oder Screenshot-basierten Eingaben; Screenshots sind standardmäßig aktiviert, Text ist deaktiviert. Verwenden Sie `click({window,element_index})` oder `click({window,x,y,screenshotId?})`, `scroll({window,x,y,scrollX,scrollY,screenshotId?})`, `drag({window,from_x,from_y,to_x,to_y,screenshotId?})`, `press_key({window,key})`, `type_text({window,text})`, `set_value({window,element_index,value})`, `perform_secondary_action({window,element_index,action})`, `activate_window({window})`, `get_window({id})` und `launch_app({app})`. Setzen Sie `screenshotId` auf die `id` des zurückgegebenen Screenshots, um Bildkoordinaten zu verwenden. Ohne diesen Parameter werden ganzzahlige fensterlokale Koordinaten in den Abmessungen des zuletzt beobachteten Screenshots verwendet, oder vor einer Screenshot-Beobachtung die Fensterabmessungen. Scrollen akzeptiert sowohl `scrollX` als auch `scrollY` im selben Aufruf. Sekundäre Aktionen unterstützen derzeit Expand/Collapse; andere Bezeichnungen werden abgelehnt.
- macOS: Verwenden Sie eine zurückgegebene App-`id` als `app`. Lesen Sie `get_app_state({app})` und rufen Sie anschließend `click({app,element_index,mouse_button?,click_count?})` oder `click({app,x,y,mouse_button?,click_count?})`, `drag({app,from_x,from_y,to_x,to_y})`, `scroll({app,element_index,direction,pages?})` (oder `x,y`), `press_key({app,key})`, `type_text({app,text})`, `paste({app,text,format:'text'})`, `set_value({app,element_index,value})`, `select_text({app,element_index,text,prefix?,suffix?,selection_type?})` oder `perform_secondary_action({app,element_index,action})` auf.

Native Inventare und Zustandsstrukturen unterscheiden sich je nach Plattform; verwenden Sie zurückgegebene IDs und Selektoren wieder, nicht App-Wrapper-Handles. Der Linux-Zustand liefert `ax_tree` und `screenshots`; Screenshot-Einträge enthalten `filepath`, `bytes`, `data_url`. Der Windows-Zustand gibt seine Screenshot-Bilder automatisch aus. Andere native Ergebnisse werden für `nodeRepl.write`/`emitImage` zurückgegeben; Mutatoren geben `undefined` zurück. Aktuelle Host- und App-Berechtigungen gelten weiterhin, und eine vorhandene Methode kann ein nicht verfügbares Backend oder eine nicht unterstützte Operation ablehnen. Aktualisieren Sie den Zustand nach einem Stale-Target-Fehler; wiederholen Sie keine Eingabe mit unbekanntem Ergebnis. Ziehen Sie einen aktiven Drag-Vorgang nicht über Turns hinweg mit; aktualisieren Sie Beobachtungen nach einem Reset.


Ein neues REPL hat keine gebundenen Ziele. Die folgenden Einstiegspunkte geben die API-Dokumentation sowie das Inventar oder den Anfangszustand des Ziels aus. Browser-IDs stammen von konfigurierten CDP-Anbietern und verbundenen Extension-Browser-Anbietern. Exakte IDs haben Vorrang; nur ohne exakten Treffer wählen `maka` und `chatgpt` einen eindeutigen aktuellen Extension-Endpunkt aus. Ist keines von beiden verfügbar, verwenden Sie native Browserfenster über `getApp`. Die API stellt keine Treiberadministration wie `start_session` bereit.

Eine installierte ChatGPT-Erweiterung mit ihrem ursprünglichen nativen Host wird in Chrome oder Chromium automatisch erkannt. `listBrowsers()` meldet sie als `on_demand`; durch Auswahl wird die Steuerung übernommen, bis `browser.release()` oder die Turn-Bereinigung den ursprünglichen Host wiederherstellt. Es sind weder ein Einrichtungsbefehl noch ein Debug-Port oder das Starten der ChatGPT-Desktop-App erforderlich. Bevorzugen Sie für Websites diese Browser-Verbindung gegenüber nativen Browserfenster-Eingaben.

Die ChatGPT-Kompatibilität erfolgt nach Best-Effort-Prinzip. Exakte IDs und bestehende Handles wechseln niemals den Anbieter.

Einstiegspunkte (Auswahl gibt den Anfangszustand aus):
- `await cua.getState({emit?})`: Inventar der Anwendungen und verfügbaren Browser einschließlich Inventarfehlern.
- `await cua.listApps({emit?})`, `await cua.listWindows({pid?, emit?})`.
  Übergeben Sie eine beobachtete App-PID, um unter macOS deren schwebende Panels einzubeziehen.
  Fenstereinträge enthalten `pid` und `bindable`. Wählen Sie ein Fenster mit `bindable: true`.
  Eine nicht verfügbare Bindung enthält `bindingError`. Bindbare macOS-Einträge enthalten zusätzlich `applicationId` und `appPath`. App-Einwilligung und Live-Identität werden beim Binden geprüft.
- `const app = await cua.getApp("Name / bundle ID / app path")` oder `getApp({windowId})`.
  macOS startet eine fehlende App. Unter Windows wählt `getApp` ein bereits geöffnetes Fenster aus; verwenden Sie `await cua.computer.launch_app({app: appId})` mit einer ID aus `cua.listApps()`, aktualisieren Sie dann das Inventar und wählen Sie das exakte Fenster.
  Wählen Sie bei mehrdeutigen Namen ein exaktes Fenster. Linux setzt voraus, dass die Anwendung bereits geöffnet ist.
- `await cua.listBrowsers({emit?})`, `await cua.listTabs({browser?, emit?})`.
- `const browser = await cua.getBrowser({id? , url?})`: Auswahl ohne einen Tab zu öffnen.
  Eine vorgesehene URL muss noch nicht geöffnet sein. Wählen Sie eine ID aus, wenn mehrere Anbieter verfügbar sind.
- `const tab = await cua.getTab("tab ID", {browser?})` oder `getTab({url}, {browser?})`.
- `await cua.createBrowserTab(browserId, url?)`: Öffnet im Profil des ausgewählten Anbieters.
  Hier wie in `getBrowser` verwenden URLs ohne Schema HTTPS.
  Die Erstellung beginnt mit einem eigenen leeren Tab; eine explizite URL fordert anschließend eine Navigation an.
  Eine abgelehnte Navigation hinterlässt diesen leeren Tab für die Turn-Bereinigung.
  Nicht verfügbare Anbieter, Tab-Erwähnungen und nicht unterstützte Erstellungsoptionen werfen Fehler.
- `await browser.tabs.list()`, `await browser.tabs.get(id)`, `await browser.tabs.new()`:
  Listet Tabs auf, bindet einen exakten Tab oder erstellt einen leeren temporären Tab in diesem Browser. Diese Methoden geben Daten zurück, ohne sie auszugeben; `get`/`new` geben Tab-Objekte ohne initiale AX-Beobachtung zurück.
  Rufen Sie `getAXState` auf, bevor Sie beobachtete Ziele verwenden. `await tab.title()` und `await tab.url()` liefern aktuelle Metadaten, ohne die Barrierefreiheitsbeobachtung zu verändern.

- Verbundene Browser-Adapter stellen außerdem `await browser.user.openTabs()` und `await browser.user.claimTab(tabOrId)` bereit. Die Auflistung liefert aktuelle Metadaten der Benutzer-Tabs; das Übernehmen liefert den regulären Tab nach Prüfung der aktuellen Berechtigungen und Vorbereitung der Anbindung.
  Verwenden Sie eine aufgelistete String-ID oder ein aufgelistetes Objekt. Die Turn-Bereinigung gibt Benutzer-Tabs frei, ohne sie zu schließen; von dieser Sitzung erstellte Tabs bleiben temporär. `browser.tabs.get(id)` bleibt eine verzögerte Bindung (lazy binding) und führt weder eine initiale Übernahme noch eine AX-Beobachtung durch. Diese Methoden speichern keine Berechtigungen. Bei Extension-Anbietern listet `browser.tabs.list()` die von dieser Sitzung verwalteten Tabs auf. Konfigurierte CDP-Anbieter stellen kein `browser.user` bereit; verwenden Sie dort stattdessen deren `browser.tabs`-Methoden.

Maka bietet ein AX-Browserprofil: `tab.ax` enthält `get`, `write`, `click`, `drag`, `paste`, `performSecondaryAction`, `pressKey`, `scroll`, `selectText`, `setValue` und `typeText`. Die Aktionssignaturen entsprechen den unten stehenden Tab-Methoden.
`await tab.ax.get(mode = 'state', {disableDiffing?})` gibt Text, Bildbytes oder `{state, screenshot?}` für `state`, `screenshot` oder `both` zurück, ohne auszugeben.
`await tab.ax.write(mode = 'state', options?)` gibt die verfügbaren Ergebnisse aus und liefert `undefined`. Die bestehenden flachen Tab-Methoden bleiben weiterhin verfügbar.
Die AX-Fassade und die flachen Methoden wirken auf denselben gebundenen Tab.

App- und Tab-Beobachtungen:
- `getAXState({emit?, disableDiffing?})` gibt Text zurück. Tabs und macOS-Apps verwenden standardmäßig einen Diff; Windows- und Linux-Apps liefern den vollständigen Zustand.
- `getScreenshot({emit?})` gibt ein `Uint8Array` zurück und gibt das Bild aus.
- `getAXStateAndScreenshot(options?)` gibt `{state, screenshot?}` zurück und gibt die verfügbaren Ergebnisse aus.
Erkennung, Auswahl und Beobachtungen geben Ergebnisse automatisch aus. Rufen Sie sie direkt auf; das Einbetten von `getScreenshot()` in `nodeRepl.emitImage()` oder von `getAXState()` in `nodeRepl.write()` ist redundant. Verwenden Sie `{emit:false}`, wenn Sie das Ergebnis selbst weiterverarbeiten; Inventarfehler erscheinen dennoch. Native Windows-Screenshot-Methoden lehnen `{emit:false}` vor der Aufnahme ab. Identische Bilder, die innerhalb eines einzigen Aufrufs ausgegeben werden, werden nur einmal geliefert. Ein späterer Aufruf kann dasselbe Bild erneut ausgeben.
Beobachtungen beinhalten ein begrenztes Beruhigungsfenster für kurze UI-Aktualisierungen (200 ms für Tabs, 400 ms für Apps). Es wartet nicht auf beliebige asynchrone Vorgänge; laufende Animationen verlängern das Fenster nicht. Aktualisieren Sie die Beobachtung, um spätere Änderungen zu erfassen.
Ein erfolgreicher Screenshot desselben unveränderten Browser-Dokuments erhält bestehende AX-Referenzen. Aktualisieren Sie nach einer Navigation, einem Dokumentaustausch oder einer Zielinvalidierung `getAXState()`, bevor Sie Indizes wiederverwenden; aktualisieren Sie auch für neu beobachtete Elemente. Natives Linux/Windows behält zuvor beobachtete Elementidentitäten bei, solange genau diese Elemente gültig bleiben.
Schlägt eine native AX-Beobachtung fehl, während eine App beschäftigt ist, aktualisieren Sie dasselbe gebundene Objekt, sobald die App wieder reagiert. Fehlgeschlagene Beobachtungen machen alte Indizes und Koordinaten ungültig.

App- und Tab-Aktionen:
- `await app.bringToFront()` aktiviert das exakt gebundene native Fenster dauerhaft. Es sendet weder Tastatur- noch Zeigereingaben und meldet ein unbekanntes Ergebnis, falls der Desktop die Aktivierung nicht bestätigen kann.
- `click(index | [x,y], {mouseButton?, clickCount?})`, `drag([x,y], [x,y])`.
- `scroll(index | [x,y], "up" | "down" | "left" | "right", distance?)`.
- Native Apps akzeptieren außerdem die Maustasten `l/r/m` und die Richtungen `u/d/l/r`.
  macOS entfernt Leerzeichen am Rand, ignoriert Groß-/Kleinschreibung für diese Namen und akzeptiert zusätzlich die Tasten `0/1/2` für links/rechts/mitte.
- `setValue(index, string)`; für native Linux-Apps nicht verfügbar.
- `selectText(index, text, {prefix?, suffix?, selectionType?})`, wobei `selectionType` `text`, `cursor_before` oder `cursor_after` ist. Native Textauswahl ist nur unter macOS verfügbar.
  `text_not_found` bedeutet, dass der Text oder der angegebene Kontext fehlt; lesen Sie den aktuellen Zustand erneut. `ambiguous_text` erfordert ein genaueres Präfix/Suffix.
- `performSecondaryAction(index, action)`: Verwenden Sie eine exakte Aktion aus der nativen AX-Beobachtung. CDP stellt keine sekundären Aktionen bereit und lehnt diese Methode ab.

App-Eingaben: `typeText(text)`, `paste(text, {format?})`, `pressKey(key)`.
Tab-Eingaben: `typeText(index|null, text)`, `paste(index|null, text, {format?})`, `pressKey(index|null, key)`. Ein angegebener Index fokussiert zuerst das beobachtete Feld.
Verwenden Sie `null` für den aktuellen Fokus. Tastenbeispiele: `Return`, `Tab`, `super+a`, `shift+Left`.
Einfügeformate: `text` (Standard), `md` (Markdown-Quelltext als Klartext) und `html`.
Native Linux- und Windows-Apps unterstützen nur `text`.
Natives HTML-Einfügen ist nur unter macOS verfügbar und erfordert einen lesbaren, bearbeitbaren Wert sowie eine Auswahl. Es aktiviert vorübergehend das exakte Fenster, erhält dessen Auswahl und stellt die vorherige Zwischenablage wieder her, sofern der Benutzer zwischenzeitlich nichts Neueres kopiert hat. Ein unveränderter Wert wird als unsicher gemeldet.
HTML-Einfügen im Browser erfordert ein beobachtetes contenteditable-Element.

Tab-Navigation: `goto(url)`, `back()`, `forward()`, `reload()`, `close()`.
`await tab.screenshot({ fullPage: false, clip: { x, y, width, height } })` gibt JPEG-Bytes zurück, ohne ein Bild auszugeben. Lassen Sie `clip` für den Viewport weg; `fullPage: true` erfasst das gesamte Dokument. Breite und Höhe von `clip` müssen positiv sein. Koordinaten und Abmessungen verwenden CSS-Pixel. Die Viewport-Aufnahme versucht zuerst ein frisches Screencast-Frame und anschließend nach bestätigter Bereinigung den Screenshot-Befehl desselben Tabs; unsichere Operationen werden nicht wiederholt.

Bei Extension-Anbietern hält `await tab.markDeliverable()` den Tab am normalen Turn-Ende geöffnet und gibt ihn für den Benutzer frei. `await tab.markHandoff()` behält den Tab für dieselbe Sitzung; der nächste reguläre Turn setzt ihn ohne Markierung fort. Die ursprüngliche Agenten-/Benutzer-Herkunft bleibt erhalten, sodass ein vom Agenten erstellter Tab am Ende eines späteren unmarkierten Turns geschlossen wird. Eine spätere explizite Markierung ersetzt die vorherige. Beide Methoden geben nach dem passenden Intent-ACK `undefined` zurück, was weder eine physische Übergabe noch eine Bereinigung beweist. Markierungen bewahren keine Seitenberechtigungen; ein unsicherer Aufruf wird nicht wiederholt. Direktes CDP unterstützt diese Markierungen nicht.

`tab.clipboard` stellt `read()`, `readText()`, `write(items)` und `writeText(text)` bereit.
Diese Methoden geben Werte zurück, ohne sie auszugeben. Ein Rich-Item hat ein nicht leeres Feld `entries`; jeder Eintrag besitzt `mimeType` und genau ein String-Feld, `text` oder `base64`. Das optionale `presentationStyle` ist `unspecified`, `inline` oder `attachment`. Beispiel: `await tab.clipboard.write([{entries:[{mimeType:'text/plain',text:'Hello'}]}])`.
Die virtuellen Daten werden von Tabs geteilt, die denselben konfigurierten Backend-Kontext nutzen; die Betriebssystem-Zwischenablage wird dabei weder gelesen noch verändert. Berechtigte Seiten nutzen dieselben Daten nach der Einrichtung über ihre Clipboard API. `readText()` des Agenten liefert den Text des ersten exakten `text/plain`-Eintrags oder einen leeren String bei einem reinen `base64`-Eintrag; `readText()` der Seite dekodiert diesen Eintrag über einen `Blob`. Die Turn-Bereinigung entfernt Seiten-Bridges und behält gespeicherte Daten bei. Ein Reset erstellt einen neuen, leeren Kontext.

Wartemethoden geben `undefined` zurück. `locator.waitFor({state, timeoutMs?})` erfordert `state: 'attached'|'detached'|'visible'|'hidden'` und prüft den ersten Treffer; kein Treffer erfüllt `detached` und `hidden`.
`tab.playwright.waitForURL(pattern, {waitUntil?, timeoutMs?})` prüft die vollständige URL: `*` bleibt innerhalb eines durch Schrägstriche begrenzten Segments, `**` darf Schrägstriche überschreiten, und alle anderen Zeichen gelten wörtlich. Der Standardwert für `waitUntil` ist `commit`; `load`, `domcontentloaded` und `networkidle` warten nach einem Treffer auf diesen Zustand.
`tab.playwright.waitForLoadState({state?, timeoutMs?})` hat standardmäßig `load` und akzeptiert außerdem `domcontentloaded` und `networkidle`. Diese Bedingungswartezeiten betragen standardmäßig 3000 ms und respektieren längere explizite Timeouts. Null lässt kein Budget für Ereignis-Wartezeiten: Ein Locator erhält dennoch seine erste Prüfung, die aktuelle URL bzw. der Ladezustand kann bereits passen, und `networkidle` läuft ab. `tab.playwright.waitForTimeout(ms)` akzeptiert eine nichtnegative Ganzzahl und wartet eine feste Dauer. Starten Sie bei einem durch eine Aktion ausgelösten Warten zuerst das Warten vor der Aktion und erwarten Sie dann beide Promises. Ein Stopp bricht das ursprüngliche Warten ab.

`tab.playwright` löst DOM-Locators ohne vorherige AX-Beobachtung auf.
Verwenden Sie `locator(selector)`, `getByRole`, `getByText`, `getByLabel`, `getByPlaceholder` oder `getByTestId`; `frameLocator(selector)` wechselt in einen Frame. Locators unterstützen `first/last/nth`, `filter`, `and/or`, `count`, `all`, `allTextContents`, `textContent`, `innerText`, `getAttribute`, `isEnabled` und `isVisible`.
`domSnapshot()` gibt den DOM-Barrierefreiheitstext der Seite zurück.

Locator-Eingabemethoden geben `undefined` zurück: `click(options?)`, `dblclick(options?)`, `fill(text, options?)`, `type(text, options?)`, `press(key, options?)`, `pressSequentially(text, options?)`, `selectOption(valueOrValues, options?)`, `setChecked(boolean, options?)`, `check(options?)` und `uncheck(options?)`.
Klick-Optionen akzeptieren `button: 'left'|'right'|'middle'`, `modifiers`, `force` und `timeoutMs`; Check-Optionen akzeptieren `force` und `timeoutMs`. Modifikatoren sind `Alt`, `Control`, `ControlOrMeta`, `Meta` und `Shift`; `ControlOrMeta` verwendet die Plattform des ausgewählten Browsers. Andere Eingabeoptionen akzeptieren `timeoutMs`. Timeouts sind positive Ganzzahlen; die Vorbereitung dauert standardmäßig 3000 ms und respektiert längere explizite Timeouts. Eine Optionsauswahl akzeptiert einen Wert-String oder einen Deskriptor mit `value`, `label` oder einer nichtnegativen Ganzzahl `index`; Arrays wählen mehrere Optionen aus.

Locator-Mutationen verwenden einen eindeutigen Treffer oder den einzigen sichtbaren Treffer. Mehrdeutige Treffer werfen einen Fehler. Reguläres Text-Ausfüllen und -Tippen nutzen ein virtuelles Paste-Ereignis, respektieren das Abbrechen durch einen Seiten-Handler und bewahren die gespeicherte Zwischenablage. Ein leeres Einfügen löscht einen Wert standardmäßig nicht. Tastenkombinationen für die Zwischenablage verwenden dieselbe virtuelle Zwischenablage; nicht unterstützte Kombinationen werfen einen Fehler, bevor native Tasten gesendet werden. Erfolgreiche Schreibvorgänge löschen nur zwischengespeicherte Lesevorgänge der aufrufenden Locator-Sammlung. Eingabeergebnisse müssen dennoch auf der Seite überprüft werden; ein unsicheres Ergebnis wird nicht automatisch wiederholt.

Downloads verwenden einen verbundenen Extension-Anbieter mit Download-Benachrichtigungen und aktueller Host-Download-Berechtigung. Aktivieren Sie das Warten, bevor Sie die Aktion im selben Tab auslösen:
`const pending = tab.playwright.waitForEvent('download', {timeoutMs:3000});`
führen Sie anschließend den Klick oder die Navigation aus und rufen Sie `const download = await pending` auf.
`await download.path({timeoutMs?})` gibt den vom Browser gemeldeten Dateinamen oder `null` zurück.
Es überträgt weder eine Datei noch beweist es, dass ein Pfad zu dieser Aufgabe gehört; der Pfad kann sich auf einem anderen Host befinden, leer oder nicht verfügbar sein. Eine `saveAs`-Operation existiert nicht.
`await tab.playwright.locator(selector).downloadMedia({timeoutMs?})` fordert Medien für einen eindeutig passenden Locator an. Download-Warteaufrufe geben Daten zurück, ohne sie auszugeben; Medienauslöser geben `undefined` zurück. Die native Startfrist endet mit dem ersten passenden `Started`-Ereignis; Abbruch und Host-Bereinigung gelten danach weiterhin.
Leseberechtigung und Download-Berechtigung sind getrennt, auch für eine abweichende Quell- oder Ziel-Origin. Eine konfigurierte CDP-Verbindung allein bietet keine nativen Download-Benachrichtigungen.
Maka stellt außerdem `tab.cua.downloadMedia({x,y,timeoutMs?})` und `tab.dom_cua.downloadMedia({node_id,timeoutMs?})` als eng gefasste Erweiterungen bereit. Die ausgewählten Extension-Anbieter lehnen diese Koordinaten-/Knoten-Medienbefehle derzeit ab; verwenden Sie den implementierten Locator-Weg. Ein unsicheres Download-Ergebnis wird niemals automatisch erneut versucht.
Das zurückgegebene Handle behält seine ursprüngliche Tab-Bindung bei, keine Berechtigung. Halten Sie diesen Tab verfügbar: `path()` prüft aktuelle Tab-Metadaten und Host-Berechtigungen vor der Cache-Abfrage erneut. Ein veraltetes Handle kann einen geschlossenen Tab nicht offen halten. Spätere Turns erfordern weiterhin aktuellen Tab-Zugriff; ein erneutes Übernehmen des Tabs kann nötig sein.

`await tab.getJsDialog()` gibt `undefined` oder das aktuelle Dialogobjekt mit `type` und `dismiss()` zurück. Bestätigungsdialoge (confirm) verfügen zusätzlich über `accept()`; Eingabedialoge (prompt) über `accept(text)`, einschließlich eines leeren Strings. Alte Dialogobjekte können nicht auf einen Nachfolgedialog einwirken. Behandeln Sie einen aktiven Dialog vor gewöhnlichen Seitenlese- oder Eingabevorgängen.
`getAXState()` zeigt dessen Meldung und indexierte Steuerelemente; Prompt-Steuerelemente unterstützen `setValue`, `typeText` und `Return`/`Escape`. Dialog-Steuerelemente haben keine Seitenkoordinaten.
Screenshots sind nicht verfügbar, solange ein Dialog geöffnet ist: Reine Screenshot-Aufrufe werfen einen Fehler, und kombinierte Beobachtungen geben den Dialogzustand ohne `screenshot`-Eigenschaft zurück.
Ein angebundener Browser-Host akzeptiert `beforeunload`-Dialoge automatisch, solange er die aktuelle Steuerung hält. Die Turn-Bereinigung löst die Steuerung, ohne Benutzer-Tabs zu schließen.

Navigation unterstützt HTTP(S) und `about:blank` und wartet auf ein beobachtbares Dokument.
Das Haupt-CDP-Ziel ist abgedeckt; die Barrierefreiheit von prozessübergreifenden Iframes ist nicht vollständig.
CDP-Seitendistanzen akzeptieren endliche Zahlen, einschließlich Bruchzahlen, Null und negativer Werte. Eine Seite entspricht der Inhaltsbreite oder -höhe des Ziels, mindestens jedoch 100 CSS-Pixel; Koordinatenziele verwenden den Viewport. Die CDP-Erweiterung `{pixels:n}` akzeptiert positive endliche Pixel-Deltas.
Linux lehnt numerische Seitenanzahlen ab. Linux X11 verwendet standardmäßig `{pixels:800}` und akzeptiert ganzzahlige Pixeldistanzen von 1 bis 65535. Es sendet `max(round(pixels/100),1)` Mausrad-Schritte; die Anwendung bestimmt die resultierende Inhaltsbewegung. Linux Wayland lehnt Pixeleingaben derzeit ab.
Scrollen unter macOS erwartet positive endliche numerische Seiten (Standardwert 1) und lehnt `{pixels}` ab. Gebrochene Seitenanzahlen werden unterstützt.
Windows erfordert einen Koordinatenpunkt und eine positive endliche Distanz `{pixels:500}`; fehlende Distanzen und numerische Seitenanzahlen werden abgelehnt. Koordinaten und richtungsbehaftete Distanzen nutzen JavaScript-`Math.round`; gerundete Eingaben müssen in vorzeichenbehaftete 32-Bit-Ganzzahlen passen. Native Mausrad-Deltas sind pro Achse auf `[-32768,32767]` begrenzt, und der Zeiger bleibt am Ziel.
Die Anwendung bestimmt die Inhaltsbewegung. Natives indexiertes Scrollen behält das ausgewählte Barrierefreiheitsziel bei. Native indexierte Klicks über den App-Wrapper unterstützen einen einzelnen semantischen Klick; verwenden Sie Screenshot-Koordinaten für Mehrfachklicks. Das direkte macOS-`cua.computer.click` unterstützt auch mehrfache indexierte Klicks über simulierte Mausereignisse.

Eine erfolgreiche Eingabeübermittlung garantiert noch nicht den resultierenden Anwendungszustand.
Browser-Koordinatenaktionen nutzen CSS-Viewport-Koordinaten und erfordern keinen Screenshot.
Screenshots skalieren diese Koordinaten nicht.
Fensterlokale Koordinaten unter Linux können ohne Screenshot verwendet werden. Native Linux-/Windows-Screenshot-Zuordnungen bleiben über Eingabeaktionen hinweg bestehen, bis eine andere Beobachtung sie ersetzt; eine reine AX-Beobachtung löscht die Bildzuordnung. Koordinateneingaben unter Windows erfordern dann einen neuen Screenshot. Eine Änderung der Fenstergeometrie macht eine gespeicherte Zuordnung ungültig. Koordinateneingaben unter macOS erfordern derzeit nach jeder Aktion einen neuen Screenshot.
Native semantische Aktionen nutzen beibehaltene Barrierefreiheitselemente. Anwendungsmenüs sind auf ihren zugehörigen Prozess und das exakt gebundene Fenster beschränkt; Inhalte geschlossener Menüs werden ausgelassen, bis das Menü geöffnet wird. Die Interaktion mit einem Menü kann das gebundene Fenster aktivieren und aktiv halten, solange das Menü geöffnet ist.
Native Koordinaten- und Tastatureingaben werden standardmäßig im Hintergrund an das exakt gebundene Fenster zugestellt. Nicht unterstützte Hintergrundzustellung wird gemeldet; Eingaben werden nicht automatisch im Vordergrund wiederholt. Nicht verifizierte Wirkungen wurden möglicherweise bereits ausgelöst.
Bevorzugen Sie Browser-Tab-Operationen für Websites: Sie vermeiden Desktop-Fokus und Zeigereingaben. Bevorzugen Sie für native Texteingabe `typeText` oder `setValue`; macOS-`paste` nutzt die System-Zwischenablage und Tastatureingaben im Vordergrund. Native Menüs können ihr Fenster aktivieren. Einige Koordinatenwege können den Systemzeiger bewegen; Zustellungsmetadaten melden den tatsächlich genutzten Weg. Natives `app.pressKey(key, {deliveryMode:"foreground"})` und `app.typeText(text, {deliveryMode:"foreground"})` fordern bei Bedarf explizit eine Vordergrundzustellung an; der Standard ist `"background"`. Wiederholen Sie eine nicht verifizierte Eingabe nicht automatisch und wechseln Sie den Modus nicht stillschweigend.

`nodeRepl.write(value)` gibt Text/JSON aus. `await nodeRepl.emitImage(bytes | dataUrl | {bytes, mimeType})` gibt ein Bild aus. Datei-/HTTP-Bild-URLs, Node sowie beliebige Dateisystem- und Netzwerk-APIs sind nicht verfügbar. `cua.rewriteDocumentation()` gibt diese Referenz erneut aus.

Wenn der Host Ausgabe-Audio aktiviert, startet `await cua.computer.start_audio_recording({max_duration_ms?})` die Aufnahme und gibt `undefined` zurück, während weitere Aufrufe fortgesetzt werden können. Die Standarddauer beträgt 60000 ms und akzeptiert Ganzzahlen von 100 bis 300000. `await cua.computer.stop_audio_recording()` gibt `{filepath, bytes, data_url}` für die finalisierte Stereo-WAV-Datei mit 24 kHz PCM16 zurück. Das Erreichen der Dauer beendet die Aufnahme; rufen Sie zum Abrufen `stop` auf. `await nodeRepl.emitAudio(bytes | dataUrl | {bytes, mimeType})` gibt Audio explizit aus. Diese Methoden fehlen, wenn Audio deaktiviert ist.
Reset und Sitzungsbereinigung verwerfen Aufnahmen und deren lokale Pfade.

Jede Operation nutzt aktuelle Host-Berechtigungen; JS-Objekte speichern keine Berechtigungen.
Bei deaktivierter Sitzungs-Sandbox erfordern Computer Use, Anwendungen, Browser-Websites, Verlauf, Dateiübertragungen und Audio keine zusätzliche Maka-Genehmigung. Berechtigungsänderungen oder das Stoppen der laufenden Operation bleiben weiterhin wirksam.
Im Ask-Modus erfolgt die Computer-Use-Genehmigung, bevor das Ausführungstimeout des REPL beginnt.
Wartezeiten für Einwilligungen bei Apps, Browser-Websites und Audio pausieren das verbleibende Budget. Native macOS-/Windows-Wartezeiten pausieren es ebenfalls; gewöhnliche asynchrone Wartezeiten und native Linux-Operationen verbrauchen es. Ein Pausieren füllt das Budget niemals wieder auf und deaktiviert nicht den Abbruch.
Native macOS-Operationen melden `desktop_locked`, solange der Bildschirm gesperrt ist; verbundene CDP-Anbieter und reine REPL-Berechnungen bleiben unabhängig davon verfügbar.
Jede Sitzung hat ihren eigenen Maka-Cursor. Eingabeaktionen zeigen ihn automatisch an.
`cua.cursor.configure({label?, color?, enabled?, reducedMotion?})` ändert die Darstellung für diese Sitzung. Farben sind `blue`, `mint`, `violet`, `amber`, `rose`, `cyan`; Labels dürfen bis zu 48 Zeichen lang sein. `cua.cursor.getState()` meldet Einstellungen sowie native/Browser-Sichtbarkeit. Ein nativer Renderer im Zustand `idle` startet bei der ersten nativen Anzeige; `unavailable` meldet einen fehlenden oder ausgefallenen Anzeige-Host.
Konfigurieren Sie erneut, um einen fehlgeschlagenen Renderer noch einmal zu starten. Der Cursor gehört zur Sitzung, bleibt aber nach einem Turn nicht auf dem Bildschirm: Er wird während des Turns angezeigt, am Turn-Ende ausgeblendet und erscheint bei der nächsten Eingabeaktion erneut.
Cursor teilen keine Eingabeautorität und bewegen nicht den Systemzeiger. Mehrere Cursor isolieren weder die physische Tastatur noch den Anwendungsfokus oder die Eingabemethode.
Abgebrochene, abgelaufene oder durch Heap-Erschöpfung beendete REPLs erfordern `cua_reset` und anschließendes erneutes Binden der Ziele. Zugelassene native Arbeit wird vor der Rückkehr abgeschlossen; ein Reset macht gesendete Eingaben nicht rückgängig.
Am normalen Turn-Ende schließt diese Sitzung unmarkierte temporäre Tabs, die sie erstellt hat, und gibt ihre Seitenbeobachtungen frei.
Bereits vorhandene Benutzer-Tabs und zur Aufbewahrung markierte Tabs bleiben gemäß den obigen Regeln geöffnet. Ein Reset leert das REPL und die Bindungen dieser Sitzung; er gewährt keinen neuen Zugriff und hebt bestehende Aufbewahrungs- und Bereinigungspflichten dieser Sitzung nicht auf.
Eine unbestätigte Markierung oder Schließung behält die Zuständigkeit und wird nicht wiederholt.

Dieselbe Browser-Sammlung ist als `agent.browsers` und `cua.browsers` verfügbar.
Ihre Methoden `list`, `get(id)`, `getDefault` und `getForUrl(url)` geben Metadaten oder verzögerte Browser-Objekte zurück, ohne eine Beobachtung auszugeben. `cua.getBrowser` ist der Komfort-Einstiegspunkt, der die Dokumentation ausgibt. Ein Browser stellt `tabs.selected()` für den aktiven Tab seiner logischen Sitzung bereit; dies wählt nicht den im Betriebssystem fokussierten Tab aus.
Der aktuelle direkte CDP-Anbieter besitzt keinen Dienst für den aktiven Tab einer logischen Sitzung und gibt für `selected()` `undefined` zurück.

`await browser.release()` gibt die On-Demand-ChatGPT-Browser-Nutzung (Lease) dieser Sitzung zurück. Es bereinigt die temporären Tabs dieses Turns und physische Steuerungsressourcen, bevor der Host freigegeben wird; beibehaltene Seiten bleiben geöffnet. Andere Sitzungen behalten ihre eigenen Leases. Die letzte Freigabe stellt den ursprünglichen nativen Host wieder her. Erwerben Sie die Verbindung vor weiterer Nutzung erneut mit `cua.getBrowser({id: "chatgpt"})`; Handles aus einer abgelösten Host-Generation erfordern eine frische Anbindung. Die normale Turn-Bereinigung gibt das Lease ebenfalls frei. Langlebige Agenten sollten es vor Ruhepausen freigeben. Andere Browser-Anbieter unterstützen diese Operation nicht.

`await browser.nameSession(name)` trimmt und speichert den Titel der verwalteten Gruppe der Sitzung. Eine bestehende verwaltete Darstellung wird über ihre eigenen Belege aktualisiert; künftig erstellte Tabs verwenden den gespeicherten Titel. `cua.createBrowserTab(id, url, {sessionName})` löst den Browser auf und wartet die Benennung ab, bevor der Tab erstellt wird.
Das aktuelle Browserprofil bietet keine Sichtbarkeitsfunktion (visibility capability).

`await browser.history({queries, limit, from, to})` liest den profilweiten Verlauf über eine Erweiterung, die den separaten Verlaufstransport ankündigt. Bei aktivierter Sandbox ist eine eigenständige `browser_history`-Einwilligung für die konkrete Browser-ID und Generation innerhalb der aktuellen Sitzungsberechtigungsgrenze erforderlich. Seiten- und Download-Berechtigungen autorisieren dies nicht. Keine Verlaufsabfrage wird automatisch durch eine Seiten-Origin-Richtlinie gewährt.
Standardmäßig wird der gesamte Verlauf mit einem Limit von 100 Einträgen abgefragt; Ergebnisse angegebener Suchanfragen werden nach absteigender Besuchszeit zusammengeführt, nach URL dedupliziert und anschließend begrenzt.
Die mitgelieferte Maka-Erweiterung deklariert Chromes Verlaufsberechtigung; eine ältere installierte Erweiterung ohne diese Berechtigung meldet keine Verlaufsunterstützung.
ChatGPT und andere Drittanbieter-Adapter bleiben Best-Effort.

- `await browser.user.getTabContext(tabOrId)` liest den Kontext eines aktuell sichtbaren Benutzer-Tabs, ohne ihn zu übernehmen oder zu fokussieren. Die aktuelle Tab-URL wird vom Host autorisiert; Aufrufer können keine Ersatz-URL angeben. Private Tabs und eine URL, die sich während eines einzelnen Lesevorgangs ändert, werden abgelehnt. Das Ergebnis ist entweder `{kind:'text',text,title,url,truncated}` oder `{kind:'document',data,fileName,mimeType,title,url}`, wobei `data` ein `Uint8Array` mit der tatsächlich exportierten Datei ist. Wenn der Host Dateiveröffentlichung unterstützt, enthalten Dokumente außerdem einen realen, zur Sitzung gehörenden `path`. Google-Workspace-Dokumente können Markdown-, PDF- oder XLSX-Kontext liefern; gewöhnliche Seiten können die aktuelle Auswahl enthalten, und YouTube-Wiedergabeseiten können ein Transkript enthalten. Der Anbieter `maka` implementiert die festen Lesevorgänge; `chatgpt` nutzt sein Standard-Leseprotokoll, sofern unterstützt. Drittanbieter-Unterstützung bleibt Best-Effort.

- `await tab.playwright.evaluate(pageFunction, arg?, {timeoutMs}?)` wertet eine eigenständige Funktion im Kontext der aktuellen Seite aus. Ein String wird als Ausdruck behandelt. Locator-Varianten übergeben `(element, arg)` an `locator.evaluate` oder `(elements, arg)` an `locator.evaluateAll`; die Einzel-Element-Variante verlangt ein eindeutiges Ziel, während die Alle-Elemente-Variante auch eine leere Treffermenge akzeptiert.
  Argumente müssen JSON-serialisierbar sein. Ergebnisse sind einfache Daten; Funktionen und Symbole werden ausgelassen, BigInts werden zu Strings und nicht-endliche Zahlen werden zu `null`. Diese API begrenzt die Ergebnistiefe auf 8, Arrays auf 2000 Einträge, Objekte auf 200 Schlüssel und Strings auf 200000 UTF-16-Einheiten, gegebenenfalls mit den Markierungen `[MaxDepth]`, `[Circular]` und `[Truncated]`.
- Die Auswertung bietet schreibgeschützte Ansichten auf DOM, CSS, Geometrie, Range und Auswahl.
  Sie bietet keinen Zugriff auf Netzwerk, Cookies, Modulladen oder DOM-Änderungen. Scrollen, lokale Range-Grenzen und reine Funktions-Timer bleiben unterstützte Operationen.
  Das Standard-Timeout beträgt 3000 ms; explizite Werte setzen die gewünschte Dauer.
  Ein gestopptes oder unterbrochenes Skript wurde möglicherweise bereits ausgeführt; es wird nicht automatisch erneut ausgeführt. Bestehende Seitenberechtigungen und Tab-Eigentümerschaft gelten weiterhin.

Browser-Zeigereingaben sind über `tab.cua.move({x,y,keys?})`, `click({x,y,button?,keypress?})`, `double_click({x,y,keypress?})`, `drag({path:[{x,y},...],keys?})` und `scroll({x,y,scrollX,scrollY,keypress?})` verfügbar. Koordinaten und Distanzen sind CSS-Viewport-Zahlen und behalten Bruch- und Negativwerte bei; Tasten sind 1 (links), 2 (mitte) oder 3 (rechts). Namen der Zeigermodifikatoren sind Alt, Control, Meta, Shift und ControlOrMeta. `tab.cua.keypress({keys:[...]})` sendet eine Tastenkombination an den aktuellen Fokus; `tab.cua.type({text})` fügt Text am aktuellen Fokus über die virtuelle Zwischenablage des Browsers ein und erhält gespeicherte Zwischenablagedaten. Text darf Markdown enthalten; Google Sheets erhält Klartext. Diese Eingabemethoden geben `undefined` zurück und wiederholen keine unsichere Eingabe.

`await tab.dom_cua.get_visible_dom()` gibt sichtbares interaktives HTML mit String-Werten für `node_id` zurück. Verwenden Sie genau diese Strings bei `click({node_id})` oder `double_click({node_id})`; `scroll({node_id?,x,y})` nimmt Scrolldistanzen entgegen und verwendet die Viewport-Mitte, wenn `node_id` weggelassen wird. `keypress({keys:[...]})` und `type({text})` nutzen den aktuellen Fokus, keine Knoten-ID. DOM-Methoden geben außer dem Snapshot `undefined` zurück. Ein neuer Snapshot zieht fehlende DOM-Knoten zurück; Navigation oder Frame-Austausch können einen Knoten veralten lassen. Beobachten Sie erneut, statt eine ID zu raten oder eine Eingabe mit unbekanntem Ergebnis zu wiederholen.

<!-- named-browser-documents -->
<!-- browser-document: bootstrap-troubleshooting chrome-troubleshooting browser-troubleshooting -->
# Browser-Fehlerbehebung
Lesen Sie `cua.getState()` und `agent.browsers.list()`, um den verfügbaren Browser und seine exakte ID zu ermitteln. Eine konfigurierte Verbindung ist kein Beweis dafür, dass eine bestimmte Aktion erfolgreich war. Wenn eine Bindung veraltet oder ihr Ergebnis unbekannt ist, prüfen Sie den aktuellen Zustand, bevor Sie die nächste Operation wählen; eine unsichere Änderung darf nicht automatisch wiederholt werden.
<!-- /browser-document -->
<!-- browser-document: browser-safety confirmations -->
# Browser-Berechtigungen
Eine Browser-Bindung bewahrt keine Berechtigung. Operationen nutzen die aktuelle Sitzung, den aktuellen Turn, die Workspace-Richtlinie und die Seiten-Origin. Die Einwilligung zum Lesen einer Seite autorisiert weder Dateiübertragungen noch den profilweiten Verlauf. Eine abgelehnte Genehmigung, eine geschlossene Sitzung oder eine geänderte Berechtigungsgrenze muss vor weiteren Aktionen behandelt werden.
<!-- /browser-document -->
<!-- browser-document: visibility capabilities/browser/visibility -->
# Browser-Sichtbarkeit
Lesen Sie `browser.capabilities.list()`, um festzustellen, ob dieser Browser eine Sichtbarkeitsfunktion (visibility capability) veröffentlicht. Ein Dokumentationsname ist kein Nachweis dafür, dass die Funktion aktiviert ist. Fehlt die Sichtbarkeitsfunktion, schlägt die Übergabe einer `visible`-Option beim Erstellen eines Tabs fehl, bevor der Tab angelegt wird.
<!-- /browser-document -->
<!-- browser-document: session-naming -->
# Sitzungsbenennung
`await browser.nameSession(name)` weist der verwalteten Tab-Gruppe dieser Browser-Sitzung und künftig erstellten Tabs einen nicht leeren, getrimmten Titel zu. `cua.createBrowserTab(id, url, {sessionName})` wartet diesen Benennungsschritt vor dem Erstellen des Tabs ab; ein Benennungsfehler erstellt keinen Tab.
<!-- /browser-document -->
<!-- browser-document: tab-claiming-chrome -->
# Benutzer-Tabs
`browser.user.openTabs()` gibt Metadaten von Benutzer-Tabs zurück, ohne diese zu übernehmen. `browser.user.claimTab(listedTabOrId)` übernimmt explizit genau den gewählten Tab. `browser.tabs.get(id)` gibt eine verzögerte Bindung zurück und stellt keine implizite Übernahme eines beliebigen Benutzer-Tabs dar. Benutzer-Tabs werden bei der Turn-Bereinigung freigegeben statt geschlossen.
<!-- /browser-document -->
<!-- browser-document: tab-cleanup-chrome -->
# Lebensdauer verwalteter Tabs
Erstellte Tabs sind temporär, sofern ihr aktueller Lebenszyklus sie nicht explizit beibehält. `markDeliverable()` bewahrt ein fertiges Ergebnis für den Benutzer auf; `markHandoff()` behält einen Tab zur Fortsetzung innerhalb derselben Sitzung. Diese Markierungen bewahren keine alten Seitenberechtigungen und autorisieren keine andere Sitzung. Schließen, Stoppen und unsichere Effekte behalten ihre eigenen Bereinigungsanforderungen.
<!-- /browser-document -->
<!-- browser-document: tab-mentions-iab tab-cleanup-iab capabilities/browser/management -->
# Verfügbarkeit von Browser-Backends
Die aktuelle Maka-Anbietermenge umfasst Browser-Erweiterungen und konfigurierte CDP-Verbindungen; ein eingebettetes Browser-Backend wird nicht hinzugefügt. Binden Sie Browser und Tabs über IDs aus dem aktuellen Inventar. Das Lesen einer Referenz für ein eingebettetes Backend oder eine Verwaltungsfunktion erstellt weder dieses Backend noch gewährt es Browser-Verwaltungsrechte.
<!-- /browser-document -->
<!-- browser-document: browser-control-interruption -->
# Unterbrochene Operationen
Ein Abbruch ist kein Beweis dafür, dass eine gesendete Operation rückgängig gemacht wurde. Behalten Sie die ursprüngliche Bindung und das Operationsergebnis bei, bis sie abgeschlossen sind; wiederholen Sie eine Änderung nicht über einen anderen Anbieter. Ein Reset löscht die Bindungen des REPL, und nachfolgende Arbeiten müssen Ziele unter den aktuellen Berechtigungen erneut binden.
<!-- /browser-document -->
<!-- browser-document: api-use-behavior -->
# Verwendung der Browser-API
`agent.browsers` und `cua.browsers` teilen sich dieselbe Sammlung. Sammlungsaufrufe liefern Daten oder verzögerte Bindungen, ohne eine Beobachtung auszugeben. `agent.documentation.get(name)` liest ein exakt benanntes Dokument und gibt ein Promise für dessen Text zurück, ohne es auszugeben. `tabs.selected()` folgt der logischen Sitzungsaktivität. Exakte Browser-IDs und bestehende Tab-Bindungen wechseln nicht den Anbieter.
<!-- /browser-document -->
<!-- browser-document: accessibility -->
# Barrierefreiheitsbeobachtungen
Lesen Sie einen frischen Barrierefreiheitszustand, bevor Sie dessen Elementreferenzen verwenden. `tab.ax` stellt die dokumentierten Barrierefreiheitsoperationen bereit, und `get(mode, options)` gibt Zustand, Screenshot-Bytes oder beides ohne automatische Ausgabe zurück. Eine Navigation oder ein geändertes Dokument kann zuvor beobachtete Referenzen ungültig machen; aktualisieren Sie die Beobachtung, statt einen Index zu raten.
<!-- /browser-document -->
<!-- browser-document: webmcp capabilities/tab/cdp capabilities/tab/botDetection capabilities/tab/browserAuth -->
# Optionale Browser-Funktionen
Lesen Sie die Funktionssammlung (capabilities) des ausgewählten Objekts, bevor Sie eine optionale Funktion nutzen. Ein Dokumentationsverweis aktiviert weder rohes CDP noch WebMCP, Authentifizierung oder Challenge-Verarbeitungs-APIs. Fehlt die entsprechende ID in dieser Sammlung, ist die Funktion nicht verfügbar; bestehende Seitenoperationen behalten ihre normalen Berechtigungs- und Lebensdauerprüfungen.
<!-- /browser-document -->
<!-- browser-document: local-web-development -->
# Lokale Entwicklungsseiten
Wählen Sie einen Browser, der die gewünschte Entwicklungs-URL erreichen kann, und navigieren Sie zu dieser expliziten URL. Ein lokaler Hostname unterliegt weiterhin der aktuellen Workspace-Netzwerkrichtlinie und der Seiten-Origin-Autorisierung. Behalten Sie die Bindung des ausgewählten Browsers beim Prüfen der Seite bei; der `localhost` eines anderen Rechners ist ein anderes Ziel.
<!-- /browser-document -->
<!-- browser-document: file-uploads chrome-file-upload-troubleshooting -->
# Datei-Uploads
Verwenden Sie Upload-Operationen nur, wenn die Dokumentation des ausgewählten Browsers diese bereitstellt. Ein Upload erfordert eine eigene aktuelle Berechtigung für die Seite und die ausgewählten Dateien; eine Seitenlese- oder Download-Berechtigung ist keine Upload-Einwilligung. Ein Dateiauswahldialog gehört genau zu der Seiteninteraktion, die ihn geöffnet hat. Wenn diese Seite oder dieser Dialog nicht mehr aktuell ist, beginnen Sie mit einer neuen Beobachtung, statt einen alten Dialog wiederzuverwenden.
<!-- /browser-document -->
<!-- browser-document: screenshots -->
# Screenshots
`tab.getScreenshot()` gibt Screenshot-Bytes zurück; Beobachtungshilfen können das Bild ausgeben. Verwenden Sie nach Navigation, Größenänderung oder Scrollen eine frische Aufnahme, bevor Sie Koordinaten bestimmen. Ein Screenshot ist eine Beobachtung, kein Beweis dafür, dass frühere Eingaben das vorgesehene Steuerelement erreicht haben.
<!-- /browser-document -->
<!-- browser-document: capabilities/browser/viewport -->
# Viewport-Funktion
Lesen Sie `browser.capabilities.list()` und rufen Sie die veröffentlichte Viewport-Funktion ab, bevor Sie die Größe ändern. Viewport-Einstellungen folgen dem logisch aktiven Tab der Browser-Sitzung und dessen aktuellem Lebenszyklus. Das Ändern der Viewport-Größe wählt keinen fremden, im Betriebssystem fokussierten Tab aus und gewährt keinen Seitenzugriff.
<!-- /browser-document -->
<!-- browser-document: capabilities/tab/pageAssets -->
# Seitenressourcen-Funktion
Verwenden Sie Seitenressourcen (page assets) nur, wenn der ausgewählte Tab diese Funktion veröffentlicht. Das Ressourceninventar gehört zur beobachteten Seite und zum beobachteten Dokument. Holen Sie nach einer Navigation oder einem Dokumentaustausch ein neues Inventar ein; alte Ressourcen-IDs können keine Dateien einer anderen Seite autorisieren. Das Speichern von Dateien erfordert die aktuelle Dateiübertragungsberechtigung der Operation.
<!-- /browser-document -->

### Dateiauswahldialoge und Uploads

```js
const pending = tab.playwright.waitForEvent('filechooser', { timeoutMs: 3000 });
await tab.playwright.getByRole('button', { name: 'Upload' }).click();
const chooser = await pending;
chooser.isMultiple();
await chooser.setFiles(['workspace-file.bin']);
```

Starten Sie das Warten vor der Aktion, die den Dateiauswahldialog öffnet. Die Standard-Wartezeit für das Chooser-Ereignis beträgt 3000 ms; ein explizites Timeout muss eine positive Ganzzahl sein. `isMultiple()` arbeitet synchron. `setFiles(pathOrPaths, {timeoutMs})` akzeptiert einen Pfad oder ein nicht leeres Array; ein Einzeldatei-Dialog lehnt mehrere Pfade ab. Das optionale Timeout wird validiert, ohne eine laufende Auswahl zu verwerfen.

Pfade beziehen sich auf das Dateisystem des Agent-Hosts und unterliegen weiterhin der Workspace-Dateirichtlinie des Aufrufers. Seitenzugriff, Upload-Einwilligung für die aktuelle HTTP(S)-Origin und Dateileseberechtigung sind getrennt. Der unterstützte Eingabe-Snapshot ist eine reguläre Datei. Dateien werden als unveränderliche Bytes übertragen und vom ausgewählten Maka-Browser-Host materialisiert; übersetzen Sie Pfade nicht selbst zwischen Betriebssystemen.

Chooser-Handles gehören zu dem Tab, dem Dokument und dem Turn, in dem sie ausgestellt wurden. Chooser von Kind-Zielen werden nicht unterstützt. Extension-Chooser erfordern eine vollständige Herkunft des Quellereignisses; Uploads erfordern zusätzlich eine verifizierte Dateiablage auf dem Browser-Host. Chatgpt ist Best-Effort, und konfiguriertes CDP ohne eine solche Ablage lehnt den Upload vor dem Senden von Dateien ab. Ein bestehender gebundener Tab wird niemals durch einen anderen Browser ersetzt, um die Operation zu erfüllen. Eine erfolgreiche Auswahl verbraucht den Chooser. Ein unbekanntes Ergebnis muss abgeglichen statt wiederholt werden.

Wenn die Bereinigung ein unbestätigtes Ergebnis meldet, gehen Sie nicht davon aus, dass kopierte Upload-Daten gelöscht wurden. Eine automatische Rückgewinnung nach dem Beenden des Browser-Hosts, während Dateien noch ausgewählt sind, ist derzeit noch nicht verfügbar.
