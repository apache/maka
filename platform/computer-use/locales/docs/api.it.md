Computer Use è un REPL JavaScript indipendente e persistente. Usa cua_repl direttamente;
Code Mode non è necessario. Variabili e oggetti associati sopravvivono tra chiamate e Turni all'interno
del processo Host corrente. Un nuovo REPL dopo un riavvio non dispone di variabili dalla cronologia;
segui lo stato corrente di Computer Use fornito con la richiesta del modello.
Per i siti web, inizia con `await cua.listBrowsers()` e usa una scheda del browser prima
dell'input nativo sulla finestra del browser. Le connessioni ChatGPT installate possono essere rilevate su
richiesta senza configurazione shell né avvio dell'app desktop ChatGPT.
Usa `await` di primo livello, non `return` di primo livello. Questo REPL mantiene le dichiarazioni;
riutilizza le associazioni o scegli nuovi nomi. Non dispone di API Node né di `setTimeout`.

`cua.computer.target` identifica la piattaforma desktop selezionata (`mac`, `linux`, `windows`).
In WSL il valore predefinito è l'host Windows; i comandi shell possono comunque essere eseguiti in Linux.

`cua.computer` espone anche metodi snake_case nativi della piattaforma. Questi accettano un oggetto di opzioni anziché gli argomenti posizionali di App/Tab descritti di seguito; `list_apps()`, `list_windows()` e `get_screenshot()` su Linux non accettano opzioni. Scopri prima la superficie selezionata e leggine l'inventario:
```js
const native = cua.computer;
nodeRepl.write({target: native.target, methods: Object.keys(native).filter(k => typeof native[k] === 'function')});
nodeRepl.write(await (native.list_windows ? native.list_windows() : native.list_apps()));
```
| target | Metodi nativi (l'audio è documentato separatamente) |
| --- | --- |
| `linux` | `perform_secondary_action`, `click`, `drag`, `drag_handle`, `activate_window`, `get_screenshot`, `list_apps`, `list_windows`, `move`, `move_relative`, `press_key`, `scroll`, `type_text`, `launch_app`, `get_window_state` |
| `mac` | `list_apps`, `get_app_state`, `click`, `drag`, `paste`, `perform_secondary_action`, `press_key`, `scroll`, `select_text`, `set_value`, `type_text` |
| `windows` | `activate_window`, `get_window_state`, `click`, `scroll`, `drag`, `press_key`, `type_text`, `launch_app`, `list_apps`, `list_windows`, `get_window`, `perform_secondary_action`, `set_value` |

- Linux X11: usa un oggetto `window` restituito per `get_window_state({window, query?, include_screenshot?})`. Passa un `element_id` osservato **oppure** coordinate intere `x,y` a `click({window, element_id})` / `click({window, x, y, mouse_button?, click_count?, duration?, key?})`; le coordinate della finestra sono locali e omettere `window` usa il desktop. Altri input includono `type_text({window?, text, element_id?})`, `press_key({window?, key, duration?})`, `scroll({window?, direction, pixels?, x?, y?, element_id?, key?})`, `drag({window?, path:[{x,y},…], key?})`, `move({window?, x,y,key?})`, `move_relative({dx,dy,key?})`, `activate_window({window})`, `perform_secondary_action({window,element_id,action})` e `launch_app({app})`. `duration` è in millisecondi. `drag_handle()` crea un handle desktop con `start({x,y})`, `move_to({x,y})`, `end()`; terminalo esplicitamente all'interno del turno.
- Windows: usa il descrittore di finestra restituito `{app,id,...}`. Leggi `get_window_state({window, include_text?, include_screenshot?})` prima di input indicizzati o basati su screenshot; gli screenshot sono attivi per impostazione predefinita, il testo è disattivo. Usa `click({window,element_index})` o `click({window,x,y,screenshotId?})`, `scroll({window,x,y,scrollX,scrollY,screenshotId?})`, `drag({window,from_x,from_y,to_x,to_y,screenshotId?})`, `press_key({window,key})`, `type_text({window,text})`, `set_value({window,element_index,value})`, `perform_secondary_action({window,element_index,action})`, `activate_window({window})`, `get_window({id})` e `launch_app({app})`. Imposta `screenshotId` sull'`id` dello screenshot restituito per usare le coordinate dell'immagine. Senza di esso, usa coordinate intere locali della finestra nelle dimensioni dell'ultimo screenshot osservato, oppure nelle dimensioni della finestra prima di un'osservazione tramite screenshot. Lo scorrimento accetta sia `scrollX` sia `scrollY` nella stessa chiamata. Le azioni secondarie attualmente supportano Expand/Collapse; altre etichette vengono rifiutate.
- macOS: usa un `id` di app restituito come `app`. Leggi `get_app_state({app})`, poi chiama `click({app,element_index,mouse_button?,click_count?})` o `click({app,x,y,mouse_button?,click_count?})`, `drag({app,from_x,from_y,to_x,to_y})`, `scroll({app,element_index,direction,pages?})` (oppure `x,y`), `press_key({app,key})`, `type_text({app,text})`, `paste({app,text,format:'text'})`, `set_value({app,element_index,value})`, `select_text({app,element_index,text,prefix?,suffix?,selection_type?})`, oppure `perform_secondary_action({app,element_index,action})`.

Gli inventari nativi e le forme dello stato differiscono per piattaforma; riutilizza gli ID e i selettori restituiti, non gli handle wrapper App. Lo stato Linux restituisce `ax_tree` e `screenshots`; le voci screenshot includono `filepath`, `bytes`, `data_url`. Lo stato Windows emette le proprie immagini screenshot. Gli altri risultati nativi vengono restituiti per `nodeRepl.write`/`emitImage`; i metodi mutatori restituiscono undefined. Le autorizzazioni correnti dell'Host e delle app continuano ad applicarsi e un metodo presente può rifiutare un backend non disponibile o un'operazione non supportata. Aggiorna lo stato dopo un errore stale-target; non ripetere un input il cui esito è sconosciuto. Non mantenere un trascinamento attivo tra turni diversi; aggiorna le osservazioni dopo un reset.


Un nuovo REPL non ha target associati. I punti di ingresso seguenti emettono la documentazione dell'API
e l'inventario o lo stato iniziale del target. Gli ID dei browser provengono dai provider CDP configurati e dai provider browser tramite estensione
connessi. Gli ID esatti hanno la precedenza; solo in assenza di corrispondenza esatta `maka` e `chatgpt` selezionano un singolo endpoint estensione corrente. Se nessuno dei due è disponibile, usa le finestre native del browser tramite getApp. L'API non espone l'amministrazione dei driver come start_session.

Un'estensione ChatGPT installata con il suo host nativo originale viene rilevata automaticamente in Chrome o Chromium. `listBrowsers()` la segnala come `on_demand`; selezionarla assume il controllo finché `browser.release()` o la pulizia del turno non ripristina l'host originale. Non sono necessari comandi di configurazione, porte di debug né l'avvio dell'app desktop ChatGPT. Preferisci questa connessione browser per i siti web prima di ricorrere all'input nativo sulla finestra del browser.

La compatibilità con ChatGPT è di tipo best effort. Gli ID esatti e gli handle esistenti non cambiano mai provider.

Punti di ingresso (la selezione emette lo stato iniziale):
- `await cua.getState({emit?})`: inventario di app e browser disponibili, inclusi eventuali errori di inventario.
- `await cua.listApps({emit?})`, `await cua.listWindows({pid?, emit?})`.
  Passa il PID di un'app osservata per includere i suoi pannelli mobili su macOS.
  Le voci delle finestre includono `pid` e `bindable`. Seleziona una finestra con `bindable: true`.
  Un'associazione non disponibile include `bindingError`. Le voci associabili su macOS includono anche
  `applicationId` e `appPath`. Il consenso dell'app e l'identità attiva vengono verificati al momento dell'associazione.
- `const app = await cua.getApp("Name / bundle ID / app path")` o `getApp({windowId})`.
  macOS avvia un'app non ancora aperta. Su Windows getApp seleziona una finestra già aperta;
  usa `await cua.computer.launch_app({app: appId})` con un ID da cua.listApps(),
  poi aggiorna l'inventario e seleziona la sua finestra esatta.
  Seleziona una finestra esatta quando i nomi sono ambigui. Linux richiede che l'app sia già aperta.
- `await cua.listBrowsers({emit?})`, `await cua.listTabs({browser?, emit?})`.
- `const browser = await cua.getBrowser({id? , url?})`: seleziona senza aprire una scheda.
  Un URL previsto non deve essere necessariamente già aperto. Seleziona un ID quando sono disponibili più provider.
- `const tab = await cua.getTab("tab ID", {browser?})` o `getTab({url}, {browser?})`.
- `await cua.createBrowserTab(browserId, url?)`: apre nel profilo del provider selezionato.
  Qui e in getBrowser, gli URL privi di schema usano HTTPS.
  La creazione inizia con una scheda vuota di proprietà della sessione; un URL esplicito richiede quindi la navigazione.
  Una navigazione rifiutata lascia quella scheda vuota per la pulizia del turno.
  Provider non disponibili, menzioni di schede e opzioni di creazione non supportate generano un'eccezione.
- `await browser.tabs.list()`, `await browser.tabs.get(id)`, `await browser.tabs.new()`:
  elenca, associa una scheda esatta o crea una scheda temporanea vuota in quel browser. Questi metodi
  restituiscono dati senza emetterli; get/new restituiscono oggetti Tab senza un'osservazione AX iniziale.
  Chiama getAXState prima di usare target osservati. `await tab.title()` e `await tab.url()`
  restituiscono i metadati correnti senza modificare l'osservazione di accessibilità.

- Gli adattatori browser connessi espongono anche `await browser.user.openTabs()` e
  `await browser.user.claimTab(tabOrId)`. L'elenco restituisce i metadati correnti delle schede utente;
  l'acquisizione restituisce la normale Tab dopo le verifiche delle autorizzazioni correnti e la preparazione del collegamento.
  Usa un ID stringa elencato o un oggetto elencato. La pulizia del turno rilascia le schede utente senza chiuderle;
  le schede create da questa Sessione rimangono temporanee. `browser.tabs.get(id)` rimane un'associazione
  lazy e non esegue alcuna acquisizione iniziale né osservazione AX. Questi metodi non
  mantengono autorizzazioni. Per i provider estensione, `browser.tabs.list()` elenca le schede gestite
  di questa Sessione. I provider CDP configurati omettono `browser.user`; usa invece i loro
  metodi `browser.tabs`.

Maka espone un profilo browser AX: `tab.ax` contiene `get`, `write`, `click`,
`drag`, `paste`, `performSecondaryAction`, `pressKey`, `scroll`, `selectText`,
`setValue` e `typeText`. Le firme delle azioni corrispondono ai metodi Tab riportati di seguito.
`await tab.ax.get(mode = 'state', {disableDiffing?})` restituisce testo, byte dell'immagine o
`{state, screenshot?}` per `state`, `screenshot` o `both`, senza emettere.
`await tab.ax.write(mode = 'state', options?)` emette i risultati disponibili e
restituisce undefined. Gli attuali metodi piatti di Tab rimangono disponibili.
La facciata AX e i metodi piatti agiscono sulla stessa Tab associata.

Osservazioni di App e Tab:
- `getAXState({emit?, disableDiffing?})` restituisce testo. Le schede e le app macOS usano un diff per impostazione predefinita;
  le app Windows e Linux restituiscono lo stato completo.
- `getScreenshot({emit?})` restituisce Uint8Array ed emette l'immagine.
- `getAXStateAndScreenshot(options?)` restituisce `{state, screenshot?}` ed emette i risultati disponibili.
Scoperta, selezione e osservazioni emettono automaticamente. Chiamale direttamente;
racchiudere `getScreenshot()` in `nodeRepl.emitImage()` o `getAXState()` in
`nodeRepl.write()` è ridondante. Usa `{emit:false}` quando elabori il risultato
personalmente; gli errori di inventario compaiono comunque. I metodi screenshot nativi di Windows rifiutano
`{emit:false}` prima dell'acquisizione. Immagini identiche emesse all'interno di una stessa chiamata
vengono recapitate una sola volta. Una chiamata successiva può emettere di nuovo la stessa immagine.
Le osservazioni includono una finestra di assestamento limitata per brevi aggiornamenti della UI (200 ms per
le schede, 400 ms per le app). Ciò non attende attività asincrone arbitrarie;
le animazioni continue non estendono la finestra. Aggiorna per osservare modifiche successive.
Uno screenshot riuscito dello stesso documento del browser invariato preserva i riferimenti
AX esistenti. Dopo una navigazione, la sostituzione del documento o l'invalidazione del target,
aggiorna `getAXState()` prima di riutilizzare gli indici; aggiorna anche per elementi osservati di recente. Linux/Windows nativi mantengono le identità degli elementi osservati in precedenza
finché quegli stessi elementi rimangono validi.
Se un'osservazione AX nativa fallisce mentre un'app è occupata, aggiorna lo stesso oggetto associato
quando l'app risponde di nuovo. Le osservazioni fallite invalidano vecchi indici e coordinate.

Azioni di App e Tab:
- `await app.bringToFront()` attiva in modo persistente l'esatta finestra nativa associata. Non invia input di tastiera o puntatore e segnala un esito sconosciuto se il desktop non riesce a confermare l'attivazione.
- `click(index | [x,y], {mouseButton?, clickCount?})`, `drag([x,y], [x,y])`.
- `scroll(index | [x,y], "up" | "down" | "left" | "right", distance?)`.
- Le app native accettano anche i pulsanti del mouse `l/r/m` e le direzioni `u/d/l/r`.
  macOS rimuove gli spazi superflui e ignora maiuscole/minuscole per questi nomi, accettando anche i pulsanti `0/1/2`
  per sinistro/destro/centrale.
- `setValue(index, string)`; non disponibile per le app native Linux.
- `selectText(index, text, {prefix?, suffix?, selectionType?})`, dove selectionType è
  `text`, `cursor_before` o `cursor_after`. La selezione nativa è disponibile solo su macOS.
  `text_not_found` indica che il testo o il contesto fornito è assente; leggi nuovamente lo stato
  corrente. `ambiguous_text` richiede un prefix/suffix più specifico.
- `performSecondaryAction(index, action)`: usa un'azione esatta elencata nell'osservazione AX
  nativa. CDP non espone azioni secondarie e rifiuta questo metodo.

Input App: `typeText(text)`, `paste(text, {format?})`, `pressKey(key)`.
Input Tab: `typeText(index|null, text)`, `paste(index|null, text, {format?})`,
`pressKey(index|null, key)`. Un indice fornito imposta prima il focus sul campo osservato.
Usa `null` per il focus corrente. Esempi di tasti: `Return`, `Tab`, `super+a`, `shift+Left`.
Formati di incolla: `text` (predefinito), `md` (sorgente Markdown come testo semplice) e `html`.
Le app native Linux e Windows supportano solo `text`.
L'incolla HTML nativo è solo su macOS e richiede un valore modificabile leggibile e una selezione. Attiva
temporaneamente la finestra esatta, preserva la sua selezione e ripristina gli appunti precedenti,
a meno che l'utente non abbia copiato qualcosa di più recente. Un valore invariato viene segnalato come incerto.
L'incolla HTML nel browser richiede un elemento contenteditable osservato.

Navigazione Tab: `goto(url)`, `back()`, `forward()`, `reload()`, `close()`.
`await tab.screenshot({ fullPage: false, clip: { x, y, width, height } })` restituisce byte JPEG senza emettere un'immagine. Ometti `clip` per la viewport; `fullPage: true` acquisisce l'intero documento. Larghezza e altezza di `clip` devono essere positive. Coordinate e dimensioni usano pixel CSS. L'acquisizione della viewport tenta prima un fotogramma screencast recente e poi il comando screenshot della stessa scheda dopo una pulizia confermata; le operazioni incerte non vengono ripetute.

Sui provider estensione, `await tab.markDeliverable()` mantiene la scheda aperta al termine normale del turno e la rilascia all'utente. `await tab.markHandoff()` conserva la scheda per questa stessa Sessione; il turno effettivo successivo la riprende senza contrassegno. L'origine iniziale (agente/utente) viene preservata, quindi una scheda creata dall'agente si chiude al termine di un turno successivo non contrassegnato. Un contrassegno esplicito successivo sostituisce quello precedente. Entrambi i metodi restituiscono undefined dopo il relativo ACK di intenzione, il che non dimostra la consegna fisica né la pulizia. I contrassegni non conservano permessi di sito; una chiamata incerta non viene ripetuta. CDP diretto non supporta questi contrassegni.

`tab.clipboard` fornisce `read()`, `readText()`, `write(items)` e `writeText(text)`.
Questi metodi restituiscono valori senza emetterli. Un elemento ricco ha `entries` non vuoto;
ogni voce ha `mimeType` ed esattamente un campo stringa, `text` o `base64`. Il campo opzionale
`presentationStyle` è `unspecified`, `inline` o `attachment`. Ad esempio,
`await tab.clipboard.write([{entries:[{mimeType:'text/plain',text:'Hello'}]}])`.
I dati virtuali sono condivisi dalle schede che utilizzano lo stesso contesto backend configurato;
non leggono né modificano gli appunti del sistema operativo. Le pagine autorizzate usano gli stessi dati
tramite la loro Clipboard API dopo l'installazione. `readText()` dell'agente restituisce il testo
della prima voce esatta `text/plain`, oppure una stringa vuota per una voce solo base64;
`readText()` della pagina decodifica tale voce tramite un Blob. La pulizia del turno rimuove
i bridge di pagina e preserva i dati memorizzati. Il reset crea un nuovo contesto vuoto.

I metodi di attesa restituiscono undefined. `locator.waitFor({state, timeoutMs?})` richiede
`state: 'attached'|'detached'|'visible'|'hidden'` e verifica la prima corrispondenza;
nessuna corrispondenza soddisfa `detached` e `hidden`.
`tab.playwright.waitForURL(pattern, {waitUntil?, timeoutMs?})` confronta l'intero URL:
`*` rimane all'interno di un segmento delimitato da barre, `**` può attraversare le barre e gli altri
caratteri sono letterali. Il valore predefinito di `waitUntil` è `commit`; `load`,
`domcontentloaded` e `networkidle` attendono quello stato dopo una corrispondenza.
`tab.playwright.waitForLoadState({state?, timeoutMs?})` ha come valore predefinito `load` e accetta anche
`domcontentloaded` e `networkidle`. Queste attese condizionali hanno un valore predefinito di
3000 ms e rispettano timeout espliciti più lunghi. Zero non lascia alcun budget di attesa eventi:
un locator esegue comunque la sua prima verifica, l'URL o lo stato di caricamento corrente può già corrispondere
e networkidle scade per timeout. `tab.playwright.waitForTimeout(ms)` accetta un intero non negativo
e attende per una durata fissa. Per un'attesa attivata da un'azione, avvia
l'attesa prima dell'azione, poi attendi entrambe le promise. L'interruzione annulla l'attesa originale.

`tab.playwright` risolve locator DOM senza richiedere un'osservazione AX precedente.
Usa `locator(selector)`, `getByRole`, `getByText`, `getByLabel`, `getByPlaceholder`
o `getByTestId`; `frameLocator(selector)` entra in un frame. I locator supportano
`first/last/nth`, `filter`, `and/or`, `count`, `all`, `allTextContents`,
`textContent`, `innerText`, `getAttribute`, `isEnabled` e `isVisible`.
`domSnapshot()` restituisce il testo di accessibilità DOM della pagina.

I metodi di input dei locator restituiscono undefined: `click(options?)`, `dblclick(options?)`,
`fill(text, options?)`, `type(text, options?)`, `press(key, options?)`,
`pressSequentially(text, options?)`, `selectOption(valueOrValues, options?)`,
`setChecked(boolean, options?)`, `check(options?)` e `uncheck(options?)`.
Le opzioni di clic accettano `button: 'left'|'right'|'middle'`, `modifiers`, `force` e
`timeoutMs`; le opzioni di selezione casella accettano `force` e `timeoutMs`. I modificatori sono `Alt`,
`Control`, `ControlOrMeta`, `Meta` e `Shift`; `ControlOrMeta` usa la piattaforma del browser
selezionato. Le altre opzioni di input accettano `timeoutMs`. I timeout sono interi positivi;
la preparazione ha un valore predefinito di 3000 ms e rispetta timeout espliciti più lunghi. Una selezione di opzione accetta una stringa di valore o un descrittore con
`value`, `label` o un intero non negativo `index`; gli array selezionano più opzioni.

Le mutazioni dei locator usano una corrispondenza univoca o l'unica corrispondenza visibile. Corrispondenze ambigue
generano un'eccezione. Le normali operazioni fill/type di testo usano un evento di incolla virtuale, rispettano l'annullamento
da parte di un handler della pagina e preservano gli appunti memorizzati. Un'operazione di incolla vuota non cancella un
valore per impostazione predefinita. Le scorciatoie da tastiera degli appunti usano gli stessi appunti virtuali;
le combinazioni non supportate generano un'eccezione prima di inviare tasti nativi. Le scritture riuscite svuotano
solo le letture in cache della raccolta di locator chiamante. I risultati dell'input vanno comunque
verificati nella pagina; un esito incerto non viene ripetuto automaticamente.

I download usano un provider estensione connesso con notifiche di download e l'autorizzazione
corrente di download dell'Host. Predisponi l'attesa prima di attivare l'azione sulla stessa Tab:
`const pending = tab.playwright.waitForEvent('download', {timeoutMs:3000});`
quindi esegui il clic o la navigazione e `const download = await pending`.
`await download.path({timeoutMs?})` restituisce il nome del file segnalato dal browser o null.
Non trasferisce alcun file né dimostra che un percorso appartenga a questa attività; può essere
un percorso su un altro host, vuoto o non disponibile. Non dispone di un'operazione saveAs.
`await tab.playwright.locator(selector).downloadMedia({timeoutMs?})` richiede i contenuti multimediali
per un locator con corrispondenza univoca. Le attese di download restituiscono dati senza emetterli;
i trigger multimediali restituiscono undefined. La scadenza nativa di avvio termina al primo
evento Started corrispondente; annullamento e pulizia dell'Host continuano ad applicarsi in seguito.
L'autorizzazione di lettura e l'autorizzazione di download sono separate, anche per un'origine
sorgente o di destinazione diversa. Una connessione CDP configurata da sola non fornisce
notifiche native di download.
Maka espone inoltre `tab.cua.downloadMedia({x,y,timeoutMs?})` e
`tab.dom_cua.downloadMedia({node_id,timeoutMs?})` come estensioni mirate. I provider
estensione selezionati attualmente rifiutano questi comandi multimediali per coordinate/nodo; usa il
percorso implementato tramite locator. Un risultato di download incerto non viene mai ritentato automaticamente.
L'handle restituito conserva la sua associazione Tab originale, non un'autorizzazione. Mantieni disponibile quella scheda:
`path()` ricontrolla i metadati correnti della scheda e le autorizzazioni dell'Host prima della
ricerca in cache. Un handle obsoleto non può mantenere attiva una scheda chiusa. I Turni successivi richiedono comunque
l'accesso corrente alla scheda; potrebbe essere necessario acquisire nuovamente la scheda.

`await tab.getJsDialog()` restituisce undefined o l'oggetto della finestra di dialogo corrente con
`type` e `dismiss()`. Le finestre di conferma hanno anche `accept()`; le finestre prompt hanno
`accept(text)`, inclusa una stringa vuota. I vecchi oggetti di dialogo non possono agire su una
finestra sostitutiva. Gestisci una finestra di dialogo attiva prima delle normali letture o degli input sulla pagina.
`getAXState()` mostra il suo messaggio e i controlli indicizzati; i controlli prompt supportano
`setValue`, `typeText` e Return/Escape. I controlli delle finestre di dialogo non hanno coordinate di pagina.
Gli screenshot non sono disponibili mentre una finestra di dialogo è aperta: le chiamate di solo screenshot generano un'eccezione,
mentre le osservazioni combinate restituiscono lo stato della finestra di dialogo senza la proprietà screenshot.
Un Host browser collegato accetta automaticamente le finestre beforeunload finché detiene il
controllo corrente. La pulizia del turno scollega il controllo senza chiudere le schede utente.

La navigazione supporta HTTP(S) e about:blank e attende un documento osservabile.
Il target CDP principale è coperto; l'accessibilità degli iframe cross-process non è completa.
Le distanze in pagine per CDP accettano numeri finiti, inclusi valori frazionari, zero e valori
negativi. Una pagina usa la larghezza o l'altezza del contenuto del target, con un minimo di
100 pixel CSS; i target per coordinate usano la viewport. L'estensione `{pixels:n}` di CDP
accetta delta positivi finiti in pixel.
Linux rifiuta i conteggi numerici di pagine. Linux X11 ha come valore predefinito `{pixels:800}` e accetta distanze intere in pixel da 1 a
65535. Invia `max(round(pixels/100),1)` scatti di rotella; l'applicazione determina
lo spostamento risultante del contenuto. Linux Wayland attualmente rifiuta l'input in pixel.
Lo scorrimento su macOS accetta numeri finiti positivi di pagine, con valore predefinito 1, e rifiuta
`{pixels}`. I conteggi frazionari di pagine sono supportati.
Windows richiede un punto di coordinate e una distanza positiva finita `{pixels:500}`;
distanze omesse e conteggi numerici di pagine vengono rifiutati. Coordinate e distanze con segno di direzione usano
`Math.round` di JavaScript; gli input arrotondati devono rientrare in interi con segno a 32 bit. I delta nativi della rotella
sono limitati per asse a [-32768,32767] e il puntatore rimane sul target.
L'applicazione determina lo spostamento del contenuto. Lo scorrimento nativo indicizzato preserva il target di accessibilità
selezionato. I clic nativi indicizzati tramite wrapper App supportano un solo clic semantico; usa le
coordinate dello screenshot per clic multipli. Anche il comando grezzo macOS `cua.computer.click`
supporta clic multipli indicizzati mediante eventi mouse simulati.

Un invio di input riuscito non dimostra lo stato risultante dell'applicazione.
Le azioni tramite coordinate nel browser usano coordinate CSS della viewport e non richiedono screenshot.
Gli screenshot non scalano queste coordinate.
Le coordinate locali della finestra su Linux possono essere usate senza acquisire uno screenshot. Le mappature
native degli screenshot su Linux/Windows sopravvivono alle azioni di input finché un'altra osservazione
non le sostituisce; un'osservazione solo AX cancella la mappatura dell'immagine. L'input tramite coordinate su Windows
richiede quindi un altro screenshot. Una modifica della geometria della finestra invalida una
mappatura memorizzata. L'input tramite coordinate su macOS richiede attualmente un nuovo screenshot dopo
un'azione.
Le azioni semantiche native usano elementi di accessibilità conservati. I menu dell'applicazione
hanno ambito limitato al proprio processo proprietario e all'esatta finestra associata; i contenuti dei menu chiusi
vengono omessi finché il menu non viene aperto. L'interazione con il menu può attivare la
finestra associata e la mantiene attiva mentre il menu è aperto.
L'input nativo tramite coordinate e tastiera utilizza per impostazione predefinita la consegna in background verso l'esatta
finestra associata. La consegna in background non supportata viene segnalata; l'input non viene ripetuto
automaticamente in primo piano. Effetti non verificati potrebbero essere già stati recapitati.
Preferisci le operazioni su Tab del browser per i siti web: evitano il focus desktop e l'input
del puntatore. Per l'inserimento nativo di testo preferisci `typeText` o `setValue`; `paste` su macOS usa gli
appunti di sistema e l'input da tastiera in primo piano. I menu nativi possono attivare la propria
finestra. Alcuni percorsi a coordinate possono spostare il puntatore di sistema; i metadati di consegna
riportano il percorso effettivo. I metodi nativi `app.pressKey(key, {deliveryMode:"foreground"})`
e `app.typeText(text, {deliveryMode:"foreground"})` richiedono esplicitamente un percorso in primo piano
quando necessario; il valore predefinito è `"background"`. Non ritentare un input non verificato
automaticamente e non cambiare modalità silenziosamente.

`nodeRepl.write(value)` emette testo/JSON. `await nodeRepl.emitImage(bytes | dataUrl |
{bytes, mimeType})` emette un'immagine. URL di immagini File/HTTP, Node, accesso arbitrario al filesystem
e API di rete non sono disponibili. `cua.rewriteDocumentation()` ristampa questo riferimento.

Quando l'Host abilita l'audio in uscita, `await cua.computer.start_audio_recording({max_duration_ms?})`
avvia la registrazione e restituisce undefined mentre altre chiamate possono proseguire. La durata predefinita
è 60000 ms e accetta interi da 100 a 300000. `await cua.computer.stop_audio_recording()`
restituisce `{filepath, bytes, data_url}` per il file WAV PCM16 stereo a 24 kHz finalizzato. Raggiungere la
durata termina la registrazione; chiama stop per recuperarla. `await nodeRepl.emitAudio(bytes | dataUrl |
{bytes, mimeType})` emette audio esplicitamente. Questi metodi sono assenti quando l'audio è disabilitato.
Reset e pulizia della Sessione eliminano le registrazioni e i relativi percorsi locali.

Ogni operazione usa le autorizzazioni correnti dell'Host; gli oggetti JS non conservano concessioni.
Con la sandbox della Sessione disattivata, Computer Use, applicazioni, siti del browser, cronologia,
trasferimenti di file e audio non richiedono ulteriori approvazioni di Maka. La modifica delle autorizzazioni
o l'arresto dell'operazione corrente ha comunque effetto.
In modalità Ask, l'approvazione di Computer Use avviene prima che inizi il timeout di esecuzione del REPL.
Le attese di consenso per app, siti del browser e audio mettono in pausa il budget rimanente. Anche le attese
native macOS/Windows lo mettono in pausa; le normali attese asincrone e le operazioni native Linux
lo consumano. La pausa non ricarica mai il budget e non disabilita l'annullamento.
Le operazioni native macOS segnalano `desktop_locked` mentre lo schermo è bloccato; i provider
CDP connessi e i calcoli puri nel REPL rimangono disponibili indipendentemente.
Ogni Sessione ha il proprio cursore Maka. Le azioni di input lo mostrano automaticamente.
`cua.cursor.configure({label?, color?,
enabled?, reducedMotion?})` modifica la visualizzazione di questa Sessione. I colori sono `blue`, `mint`,
`violet`, `amber`, `rose`, `cyan`; le etichette consentono fino a 48 caratteri. `cua.cursor.getState()`
riporta le impostazioni e la visibilità nativa/del browser. Un renderer nativo in stato `idle` si avvia
alla prima indicazione nativa; `unavailable` segnala un host di visualizzazione mancante o in errore.
Configura nuovamente per ritentare un renderer fallito. Il cursore appartiene alla Sessione ma non resta sullo schermo dopo un Turno: viene mostrato durante il Turno, nascosto al termine del Turno e riappare alla successiva azione di input.
I cursori non condividono alcuna autorità di input e non spostano il puntatore di sistema. Più cursori
non isolano la tastiera fisica, il focus delle applicazioni o il metodo di input.
I REPL annullati, scaduti per timeout o con heap esaurito richiedono `cua_reset` e poi una nuova associazione dei target. Il lavoro
nativo già ammesso si stabilizza prima del ritorno; il reset non annulla l'input già inviato.
Al termine normale del turno, questa Sessione chiude le schede temporanee non contrassegnate che ha creato e rilascia le sue osservazioni di pagina.
Le schede utente preesistenti e le schede contrassegnate come conservate rimangono aperte secondo le regole sopra descritte. Il reset cancella il REPL
e le associazioni di questa Sessione; non concede nuovi accessi né cancella gli obblighi relativi alle risorse conservate e alla pulizia di questa Sessione.
Un contrassegno o una chiusura non confermati mantengono la custodia e non vengono ripetuti.

La stessa raccolta di browser è disponibile come `agent.browsers` e `cua.browsers`.
I suoi metodi `list`, `get(id)`, `getDefault` e `getForUrl(url)` restituiscono metadati
o oggetti Browser lazy senza emettere un'osservazione. `cua.getBrowser` è il
punto di ingresso di comodità che emette la documentazione. Un Browser espone `tabs.selected()`
per la scheda attiva della sua sessione logica; questo non seleziona la scheda con focus del sistema operativo.
L'attuale provider CDP diretto non dispone di un servizio di scheda attiva per sessione logica e
restituisce `undefined` da `selected()`.

`await browser.release()` restituisce il lease su richiesta del browser ChatGPT di questa Sessione. Stabilizza le schede temporanee di questo turno e le risorse fisiche di controllo prima di rilasciare l'host; le pagine conservate rimangono aperte. Altre Sessioni mantengono i propri lease. L'ultimo rilascio ripristina l'host nativo originale. Riacquisisci con `cua.getBrowser({id: "chatgpt"})` prima di un ulteriore utilizzo; gli handle di una generazione host ritirata richiedono un nuovo collegamento. Anche la normale pulizia del turno rilascia il lease. Gli Agenti a lunga durata dovrebbero rilasciarlo prima di entrare in pausa. Gli altri provider browser non supportano questa operazione.

`await browser.nameSession(name)` rimuove gli spazi alle estremità e memorizza il titolo del gruppo
gestito della sessione. La presentazione gestita esistente viene aggiornata tramite le proprie ricevute;
le schede create in futuro usano il titolo memorizzato. `cua.createBrowserTab(id, url,
{sessionName})` risolve il browser e attende l'assegnazione del nome prima di creare la scheda.
L'attuale profilo browser non offre la capacità di visibilità.

`await browser.history({queries, limit, from, to})` legge la cronologia dell'intero profilo
tramite un'estensione che annuncia il trasporto separato della cronologia. Con la sandbox abilitata, richiede
un consenso `browser_history` indipendente per l'ID e la generazione effettivi del browser
entro il confine corrente delle autorizzazioni della Sessione. Le autorizzazioni di pagina e download non lo autorizzano.
Nessuna richiesta di cronologia viene concessa automaticamente dalla politica dell'origine di pagina.
Il comportamento predefinito è una query sull'intera cronologia limitata a 100 voci; i risultati delle query fornite
vengono combinati in ordine decrescente di orario di visita, deduplicati per URL e poi limitati.
L'estensione Maka integrata dichiara il permesso history di Chrome; un'estensione installata più vecchia
senza tale permesso non annuncia il supporto per la cronologia.
ChatGPT e altri adattatori di terze parti rimangono best effort.

- `await browser.user.getTabContext(tabOrId)` legge il contesto da una scheda utente attualmente visibile
  senza acquisirla né portarla in focus. L'URL corrente della scheda viene autorizzato dall'Host;
  i chiamanti non possono fornire un URL sostitutivo. Le schede private e un URL che
  cambia durante una singola lettura vengono rifiutati. Il risultato è
  `{kind:'text',text,title,url,truncated}` oppure
  `{kind:'document',data,fileName,mimeType,title,url}`, dove `data` è un
  `Uint8Array` contenente il file effettivamente esportato. Quando l'Host fornisce la pubblicazione di
  file, i documenti includono anche un `path` reale di proprietà della Sessione. I documenti di Google
  Workspace possono fornire contesto in Markdown, PDF o XLSX; le pagine normali
  possono includere la selezione corrente e le pagine video di YouTube possono includere una
  trascrizione. Il provider `maka` implementa le letture fisse; `chatgpt` riutilizza il proprio
  protocollo di lettura standard quando supportato. Il supporto di terze parti rimane best effort.

- `await tab.playwright.evaluate(pageFunction, arg?, {timeoutMs}?)` valuta una
  funzione autonoma rispetto alla pagina corrente. Una stringa viene trattata come un'espressione.
  Le varianti dei locator passano `(element, arg)` a `locator.evaluate` o
  `(elements, arg)` a `locator.evaluateAll`; la forma per singolo elemento richiede
  un target univoco e la forma per tutti gli elementi accetta una corrispondenza vuota.
  Gli argomenti devono essere serializzabili in JSON. I risultati sono dati semplici; funzioni e
  simboli vengono omessi, i grandi interi diventano stringhe e i numeri non finiti
  diventano `null`. Questa API limita la profondità del risultato a 8, gli array a 2000 voci,
  gli oggetti a 200 chiavi e le stringhe a 200000 unità UTF-16, con i marcatori `[MaxDepth]`,
  `[Circular]` e `[Truncated]` ove applicabile.
- La valutazione espone viste di sola lettura di DOM, CSS, geometria, range e selezione.
  Non espone rete, cookie, caricamento di moduli o modifiche del DOM. Scorrimento,
  limiti locali dei range e timer basati solo su funzioni rimangono operazioni supportate.
  Il timeout predefinito è 3000 ms; valori espliciti impostano la durata richiesta.
  Uno script arrestato o interrotto potrebbe essere già stato eseguito; non viene eseguito di nuovo
  automaticamente. Le autorizzazioni del sito e la proprietà della scheda esistenti continuano ad applicarsi.

L'input del puntatore nel browser è disponibile tramite `tab.cua.move({x,y,keys?})`,
`click({x,y,button?,keypress?})`, `double_click({x,y,keypress?})`,
`drag({path:[{x,y},...],keys?})` e
`scroll({x,y,scrollX,scrollY,keypress?})`. Coordinate e distanze sono numeri CSS
della viewport e preservano valori frazionari e negativi; i pulsanti sono 1 (sinistro),
2 (centrale) o 3 (destro). I nomi dei modificatori del puntatore sono Alt, Control, Meta, Shift e
ControlOrMeta. `tab.cua.keypress({keys:[...]})` invia una combinazione di tasti al focus corrente;
`tab.cua.type({text})` incolla testo nel focus corrente tramite gli appunti virtuali del browser,
preservando i dati memorizzati negli appunti. Il testo può includere Markdown;
Google Sheets riceve testo semplice. Questi metodi di input restituiscono undefined e non
ripetono un input incerto.

`await tab.dom_cua.get_visible_dom()` restituisce HTML interattivo visibile con
valori stringa `node_id`. Usa esattamente quelle stringhe con `click({node_id})` o
`double_click({node_id})`; `scroll({node_id?,x,y})` accetta distanze di scorrimento e
usa il centro della viewport quando node_id viene omesso. `keypress({keys:[...]})` e
`type({text})` usano il focus corrente, non un ID di nodo. I metodi DOM restituiscono undefined,
tranne lo snapshot. Un nuovo snapshot ritira i nodi DOM mancanti; la navigazione o la
sostituzione di frame possono rendere obsoleto un nodo. Osserva nuovamente invece di indovinare un
ID o ripetere un input il cui risultato è sconosciuto.

<!-- named-browser-documents -->
<!-- browser-document: bootstrap-troubleshooting chrome-troubleshooting browser-troubleshooting -->
# Risoluzione dei problemi del browser
Leggi `cua.getState()` e `agent.browsers.list()` per identificare il browser disponibile e il suo ID esatto. Una connessione configurata non è prova del fatto che una determinata azione sia riuscita. Quando un'associazione è obsoleta o il suo esito è sconosciuto, ispeziona lo stato corrente prima di scegliere l'operazione successiva; una mutazione incerta non deve essere ripetuta automaticamente.
<!-- /browser-document -->
<!-- browser-document: browser-safety confirmations -->
# Autorità del browser
Un'associazione del browser non preserva le autorizzazioni. Le operazioni usano la Sessione corrente, il turno, la politica del workspace e l'origine della pagina. Il consenso alla lettura di una pagina non autorizza trasferimenti di file né la cronologia dell'intero profilo. Un'approvazione rifiutata, una Sessione chiusa o un confine di autorizzazione modificato devono essere gestiti prima di ulteriori azioni.
<!-- /browser-document -->
<!-- browser-document: visibility capabilities/browser/visibility -->
# Visibilità del browser
Leggi `browser.capabilities.list()` per determinare se questo browser pubblica una capacità di visibilità. Un nome di documentazione non è prova che la capacità sia abilitata. Quando la visibilità è assente, passare l'opzione `visible` alla creazione della scheda rifiuta l'operazione prima di creare la scheda.
<!-- /browser-document -->
<!-- browser-document: session-naming -->
# Denominazione della sessione
`await browser.nameSession(name)` assegna un titolo non vuoto e privo di spazi alle estremità al gruppo di schede gestito di questa Sessione browser e alle future schede create. `cua.createBrowserTab(id, url, {sessionName})` attende quel passaggio di denominazione prima di creare una scheda; un errore di denominazione impedisce la creazione della scheda.
<!-- /browser-document -->
<!-- browser-document: tab-claiming-chrome -->
# Schede utente
`browser.user.openTabs()` restituisce i metadati delle schede utente senza acquisirle. `browser.user.claimTab(listedTabOrId)` acquisisce esplicitamente l'esatta scheda scelta. `browser.tabs.get(id)` restituisce un'associazione lazy e non rappresenta l'acquisizione implicita di una scheda utente arbitraria. Le schede utente vengono rilasciate anziché chiuse durante la pulizia del turno.
<!-- /browser-document -->
<!-- browser-document: tab-cleanup-chrome -->
# Ciclo di vita delle schede gestite
Le schede create sono temporanee a meno che il loro ciclo di vita corrente non le conservi esplicitamente. `markDeliverable()` preserva un risultato completato per l'utente; `markHandoff()` conserva una scheda per continuare all'interno della stessa Sessione. Questi contrassegni non preservano vecchie autorizzazioni di pagina né autorizzano un'altra Sessione. Chiusure, interruzioni ed effetti incerti mantengono i propri requisiti di pulizia.
<!-- /browser-document -->
<!-- browser-document: tab-mentions-iab tab-cleanup-iab capabilities/browser/management -->
# Disponibilità dei backend del browser
L'attuale insieme di provider Maka comprende estensioni browser e connessioni CDP configurate; non aggiunge un backend browser integrato. Associa browser e schede usando gli ID dell'inventario corrente. Leggere un riferimento a un backend integrato o a una capacità di gestione non crea quel backend né concede autorità di gestione del browser.
<!-- /browser-document -->
<!-- browser-document: browser-control-interruption -->
# Operazioni interrotte
L'annullamento non è prova che un'operazione inviata sia stata annullata. Mantieni l'associazione originale e l'esito dell'operazione finché non si sono stabilizzati; non ripetere una mutazione tramite un altro provider. Un reset cancella le associazioni del REPL e il lavoro successivo dovrà riassociare i target secondo le autorizzazioni correnti.
<!-- /browser-document -->
<!-- browser-document: api-use-behavior -->
# Uso dell'API del browser
`agent.browsers` e `cua.browsers` condividono la stessa raccolta. Le chiamate sulla raccolta restituiscono dati o associazioni lazy senza emettere un'osservazione. `agent.documentation.get(name)` legge un documento nominato esatto e restituisce una Promise per il suo testo senza emetterlo. `tabs.selected()` segue l'attività logica della Sessione. Gli ID esatti del browser e le associazioni di schede esistenti non cambiano provider.
<!-- /browser-document -->
<!-- browser-document: accessibility -->
# Osservazioni di accessibilità
Leggi uno stato di accessibilità aggiornato prima di usare i suoi riferimenti agli elementi. `tab.ax` espone le operazioni di accessibilità documentate e `get(mode, options)` restituisce stato, byte dello screenshot o entrambi senza emissione automatica. Una navigazione o un documento modificato possono invalidare i riferimenti osservati in precedenza; aggiorna l'osservazione anziché indovinare un indice.
<!-- /browser-document -->
<!-- browser-document: webmcp capabilities/tab/cdp capabilities/tab/botDetection capabilities/tab/browserAuth -->
# Capacità opzionali del browser
Leggi la raccolta delle capacità dell'oggetto selezionato prima di usare una capacità opzionale. Un riferimento nella documentazione non abilita API CDP grezze, WebMCP, autenticazione o gestione dei challenge. Se il suo ID è assente da quella raccolta, la capacità non è disponibile; le operazioni esistenti sulla pagina mantengono i normali controlli su autorizzazioni e ciclo di vita.
<!-- /browser-document -->
<!-- browser-document: local-web-development -->
# Pagine di sviluppo locale
Scegli un browser in grado di raggiungere l'URL di sviluppo previsto e naviga verso quell'URL esplicito. Un hostname locale resta comunque soggetto alla politica di rete corrente del workspace e all'autorizzazione dell'origine della pagina. Mantieni l'associazione del browser selezionato mentre verifichi la pagina; il localhost di un'altra macchina è una destinazione diversa.
<!-- /browser-document -->
<!-- browser-document: file-uploads chrome-file-upload-troubleshooting -->
# Caricamento di file
Usa le operazioni di caricamento solo quando la documentazione del browser selezionato le espone. Un caricamento richiede la propria autorizzazione corrente per la pagina e i file scelti; un'autorizzazione di lettura della pagina o di download non equivale al consenso al caricamento. Un selettore di file appartiene all'esatta interazione di pagina che lo ha aperto. Se quella pagina o quel selettore non è più attuale, riparti da una nuova osservazione anziché riutilizzare un vecchio selettore.
<!-- /browser-document -->
<!-- browser-document: screenshots -->
# Screenshot
`tab.getScreenshot()` restituisce i byte dello screenshot; gli helper di osservazione possono emettere l'immagine. Usa una nuova acquisizione dopo navigazione, ridimensionamento o scorrimento prima di decidere le coordinate. Uno screenshot è un'osservazione, non una prova che l'input precedente abbia raggiunto il controllo previsto.
<!-- /browser-document -->
<!-- browser-document: capabilities/browser/viewport -->
# Capacità viewport
Leggi `browser.capabilities.list()` e ottieni la capacità viewport pubblicata prima di cambiare le dimensioni. Le impostazioni della viewport seguono la scheda attiva logica della Sessione browser e il suo ciclo di vita corrente. Modificare le dimensioni della viewport non seleziona una scheda non correlata con focus del sistema operativo né concede l'accesso alla pagina.
<!-- /browser-document -->
<!-- browser-document: capabilities/tab/pageAssets -->
# Capacità risorse della pagina
Usa le risorse della pagina solo quando la scheda selezionata pubblica tale capacità. L'inventario delle risorse appartiene alla pagina e al documento osservati. Dopo navigazione o sostituzione del documento, ottieni un nuovo inventario; vecchi identificatori di risorse non possono autorizzare i file di un'altra pagina. Il salvataggio dei file richiede l'autorizzazione corrente di trasferimento file dell'operazione.
<!-- /browser-document -->

### Selettori di file e caricamenti

```js
const pending = tab.playwright.waitForEvent('filechooser', { timeoutMs: 3000 });
await tab.playwright.getByRole('button', { name: 'Upload' }).click();
const chooser = await pending;
chooser.isMultiple();
await chooser.setFiles(['workspace-file.bin']);
```

Avvia l'attesa prima dell'azione che apre il selettore. L'attesa predefinita per l'evento del selettore è 3000 ms; un timeout esplicito deve essere un intero positivo. `isMultiple()` è sincrono. `setFiles(pathOrPaths, {timeoutMs})` accetta un singolo percorso o un array non vuoto; un selettore a file singolo rifiuta percorsi multipli. Il suo timeout opzionale viene convalidato senza scartare una selezione in corso.

I percorsi si riferiscono al filesystem dell'Agent Host e restano soggetti alla politica dei file del workspace del chiamante. L'accesso alla pagina, il consenso al caricamento per l'origine HTTP(S) corrente e l'autorizzazione di lettura dei file sono separati. Lo snapshot di input supportato è un file regolare. I file vengono trasportati come byte immutabili e materializzati dall'host browser Maka selezionato; non tradurre manualmente i percorsi tra sistemi operativi.

Gli handle del selettore appartengono alla scheda, al documento e al turno in cui sono stati emessi. I selettori su target figlio non sono supportati. I selettori delle estensioni richiedono la provenienza completa dell'evento di origine; i caricamenti richiedono inoltre il posizionamento verificato dei file sull'host del browser. Chatgpt è best effort e un CDP configurato privo di tale posizionamento rifiuta il caricamento prima di inviare i file. Una scheda già associata non viene mai sostituita con un altro browser per soddisfare l'operazione. Una selezione riuscita consuma il selettore. Un esito sconosciuto deve essere riconciliato anziché ripetuto.

Se la pulizia segnala un risultato non confermato, non presumere che i dati caricati e copiati siano stati eliminati. Il recupero automatico dopo l'uscita dell'host del browser mentre i file rimangono selezionati non è ancora disponibile.
