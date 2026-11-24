Computer Use est un REPL JavaScript indépendant et persistant. Utilisez `cua_repl` directement ; Code Mode n'est pas requis. Les variables et les objets liés persistent d'un appel et d'un tour à l'autre dans le processus Host en cours. Un nouveau REPL après redémarrage ne contient aucune variable issue de l'historique ; fiez-vous à l'état Computer Use actuel fourni avec la requête du modèle.
Pour les sites web, commencez par `await cua.listBrowsers()` et utilisez un onglet de navigateur (`Tab`) avant toute saisie sur une fenêtre de navigateur native. Les connexions ChatGPT installées peuvent être prises en charge à la demande sans configuration shell ni lancement de l'application de bureau ChatGPT.
Utilisez `await` au niveau supérieur, pas `return` au niveau supérieur. Ce REPL conserve les déclarations ; réutilisez les liaisons existantes ou choisissez de nouveaux noms. Il ne dispose ni des API Node ni de `setTimeout`.

`cua.computer.target` identifie la plateforme de bureau sélectionnée (`mac`, `linux`, `windows`).
Sous WSL, il utilise par défaut l'hôte Windows ; les commandes shell peuvent malgré tout s'exécuter sous Linux.

`cua.computer` expose également des méthodes natives de la plateforme en snake_case. Elles prennent un objet d'options plutôt que les arguments positionnels App/Tab ci-dessous ; `list_apps()`, `list_windows()` et `get_screenshot()` sous Linux ne prennent aucune option. Découvrez d'abord la surface sélectionnée et lisez son inventaire :
```js
const native = cua.computer;
nodeRepl.write({target: native.target, methods: Object.keys(native).filter(k => typeof native[k] === 'function')});
nodeRepl.write(await (native.list_windows ? native.list_windows() : native.list_apps()));
```
| target | Méthodes natives (l'audio est documenté séparément) |
| --- | --- |
| `linux` | `perform_secondary_action`, `click`, `drag`, `drag_handle`, `activate_window`, `get_screenshot`, `list_apps`, `list_windows`, `move`, `move_relative`, `press_key`, `scroll`, `type_text`, `launch_app`, `get_window_state` |
| `mac` | `list_apps`, `get_app_state`, `click`, `drag`, `paste`, `perform_secondary_action`, `press_key`, `scroll`, `select_text`, `set_value`, `type_text` |
| `windows` | `activate_window`, `get_window_state`, `click`, `scroll`, `drag`, `press_key`, `type_text`, `launch_app`, `list_apps`, `list_windows`, `get_window`, `perform_secondary_action`, `set_value` |

- Linux X11 : utilisez un objet `window` retourné pour `get_window_state({window, query?, include_screenshot?})`. Passez un `element_id` observé **ou** des entiers `x,y` à `click({window, element_id})` / `click({window, x, y, mouse_button?, click_count?, duration?, key?})` ; les coordonnées sont locales à la fenêtre, et omettre `window` cible le bureau. Les autres entrées incluent `type_text({window?, text, element_id?})`, `press_key({window?, key, duration?})`, `scroll({window?, direction, pixels?, x?, y?, element_id?, key?})`, `drag({window?, path:[{x,y},…], key?})`, `move({window?, x,y,key?})`, `move_relative({dx,dy,key?})`, `activate_window({window})`, `perform_secondary_action({window,element_id,action})` et `launch_app({app})`. `duration` est en millisecondes. `drag_handle()` crée un handle de bureau avec `start({x,y})`, `move_to({x,y})`, `end()` ; terminez-le explicitement au cours du tour.
- Windows : utilisez le descripteur de fenêtre `{app,id,...}` retourné. Lisez `get_window_state({window, include_text?, include_screenshot?})` avant toute saisie indexée ou par capture d'écran ; les captures d'écran sont activées par défaut, le texte désactivé. Utilisez `click({window,element_index})` ou `click({window,x,y,screenshotId?})`, `scroll({window,x,y,scrollX,scrollY,screenshotId?})`, `drag({window,from_x,from_y,to_x,to_y,screenshotId?})`, `press_key({window,key})`, `type_text({window,text})`, `set_value({window,element_index,value})`, `perform_secondary_action({window,element_index,action})`, `activate_window({window})`, `get_window({id})` et `launch_app({app})`. Définissez `screenshotId` sur l'`id` de la capture d'écran retournée pour utiliser des coordonnées d'image. Sans ce paramètre, utilisez des coordonnées entières locales à la fenêtre dans les dimensions de la dernière capture d'écran observée, ou les dimensions de la fenêtre avant toute observation par capture d'écran. Le défilement accepte `scrollX` et `scrollY` dans un même appel. Les actions secondaires prennent actuellement en charge Expand/Collapse ; les autres libellés sont refusés.
- macOS : utilisez un `id` d'application retourné en tant que `app`. Lisez `get_app_state({app})`, puis appelez `click({app,element_index,mouse_button?,click_count?})` ou `click({app,x,y,mouse_button?,click_count?})`, `drag({app,from_x,from_y,to_x,to_y})`, `scroll({app,element_index,direction,pages?})` (ou `x,y`), `press_key({app,key})`, `type_text({app,text})`, `paste({app,text,format:'text'})`, `set_value({app,element_index,value})`, `select_text({app,element_index,text,prefix?,suffix?,selection_type?})`, ou `perform_secondary_action({app,element_index,action})`.

Les inventaires natifs et les structures d'état diffèrent selon la plateforme ; réutilisez les ID et sélecteurs retournés, et non les handles de wrapper App. L'état Linux retourne `ax_tree` et `screenshots` ; les entrées de capture d'écran incluent `filepath`, `bytes`, `data_url`. L'état Windows émet ses images de capture d'écran. Les autres résultats natifs sont retournés pour `nodeRepl.write`/`emitImage` ; les mutateurs retournent `undefined`. Les permissions actuelles du Host et de l'application s'appliquent toujours, et une méthode présente peut refuser un backend indisponible ou une opération non prise en charge. Actualisez l'état après une erreur de cible obsolète ; ne rejouez pas une saisie dont le résultat est inconnu. Ne prolongez pas un glisser-déposer actif d'un tour à l'autre ; actualisez les observations après une réinitialisation.


Un REPL neuf n'a aucune cible liée. Les points d'entrée ci-dessous émettent la documentation API ainsi que l'inventaire ou l'état initial de la cible. Les ID de navigateur proviennent des fournisseurs CDP configurés et des fournisseurs de navigateur Extension connectés. Les ID exacts ont la priorité ; ce n'est qu'en l'absence de correspondance exacte que `maka` et `chatgpt` sélectionnent un point de terminaison Extension actuel unique. Si aucun n'est disponible, utilisez les fenêtres de navigateur natives via `getApp`. L'API n'expose pas l'administration du pilote telle que `start_session`.

Une extension ChatGPT installée avec son hôte natif d'origine est détectée automatiquement dans Chrome ou Chromium. `listBrowsers()` la signale comme `on_demand` ; la sélectionner en prend le contrôle jusqu'à ce que `browser.release()` ou le nettoyage de fin de tour restaure l'hôte d'origine. Aucune commande de configuration, aucun port de débogage ni aucun lancement de l'application de bureau ChatGPT n'est nécessaire. Privilégiez cette connexion de navigateur pour les sites web avant toute saisie sur une fenêtre de navigateur native.

La compatibilité ChatGPT est fournie au mieux (best effort). Les ID exacts et les handles existants ne changent jamais de fournisseur.

Points d'entrée (la sélection émet l'état initial) :
- `await cua.getState({emit?})` : inventaire des applications et des navigateurs disponibles, y compris les erreurs d'inventaire.
- `await cua.listApps({emit?})`, `await cua.listWindows({pid?, emit?})`.
  Passez le PID d'une application observée pour inclure ses panneaux flottants sur macOS.
  Les entrées de fenêtre incluent `pid` et `bindable`. Sélectionnez une fenêtre avec `bindable: true`.
  Une liaison indisponible inclut `bindingError`. Les entrées macOS pouvant être liées incluent également `applicationId` et `appPath`. Le consentement de l'application et son identité en direct sont vérifiés lors de la liaison.
- `const app = await cua.getApp("Name / bundle ID / app path")` ou `getApp({windowId})`.
  macOS lance une application absente. Sous Windows, `getApp` sélectionne une fenêtre déjà ouverte ; utilisez `await cua.computer.launch_app({app: appId})` avec un ID issu de `cua.listApps()`, puis actualisez l'inventaire et sélectionnez sa fenêtre exacte.
  Sélectionnez une fenêtre exacte lorsque les noms sont ambigus. Linux exige que l'application soit déjà ouverte.
- `await cua.listBrowsers({emit?})`, `await cua.listTabs({browser?, emit?})`.
- `const browser = await cua.getBrowser({id? , url?})` : sélectionne sans ouvrir d'onglet.
  Une URL envisagée n'a pas besoin d'être déjà ouverte. Sélectionnez un ID lorsque plusieurs fournisseurs sont disponibles.
- `const tab = await cua.getTab("tab ID", {browser?})` ou `getTab({url}, {browser?})`.
- `await cua.createBrowserTab(browserId, url?)` : ouvre dans le profil du fournisseur sélectionné.
  Ici comme dans `getBrowser`, les URL sans schéma utilisent HTTPS.
  La création commence par un onglet vierge géré ; une URL explicite demande ensuite une navigation.
  Une navigation refusée laisse cet onglet vierge pour le nettoyage de fin de tour.
  Les fournisseurs indisponibles, les mentions d'onglet et les options de création non prises en charge lèvent une exception.
- `await browser.tabs.list()`, `await browser.tabs.get(id)`, `await browser.tabs.new()` :
  liste, lie un onglet exact ou crée un onglet temporaire vierge dans ce navigateur. Ces méthodes retournent des données sans les émettre ; `get`/`new` retournent des objets Tab sans observation AX initiale.
  Appelez `getAXState` avant d'utiliser des cibles observées. `await tab.title()` et `await tab.url()` retournent les métadonnées actuelles sans modifier l'observation d'accessibilité.

- Les adaptateurs de navigateur connectés exposent également `await browser.user.openTabs()` et `await browser.user.claimTab(tabOrId)`. Le listage retourne les métadonnées des onglets utilisateur actuels ; la prise en charge retourne l'objet Tab ordinaire après vérification des permissions actuelles et préparation du rattachement.
  Utilisez un ID sous forme de chaîne issu de la liste ou un objet listé. Le nettoyage de fin de tour libère les onglets utilisateur sans les fermer ; les onglets créés par cette Session restent temporaires. `browser.tabs.get(id)` reste une liaison paresseuse et n'effectue ni prise en charge initiale ni observation AX. Ces méthodes ne conservent aucune autorisation. Pour les fournisseurs Extension, `browser.tabs.list()` liste les onglets gérés par cette Session. Les fournisseurs CDP configurés omettent `browser.user` ; utilisez leurs méthodes `browser.tabs` à la place.

Maka expose un profil navigateur AX : `tab.ax` contient `get`, `write`, `click`, `drag`, `paste`, `performSecondaryAction`, `pressKey`, `scroll`, `selectText`, `setValue` et `typeText`. Les signatures des actions correspondent aux méthodes Tab ci-dessous.
`await tab.ax.get(mode = 'state', {disableDiffing?})` retourne du texte, des octets d'image ou `{state, screenshot?}` pour `state`, `screenshot` ou `both`, sans émettre.
`await tab.ax.write(mode = 'state', options?)` émet les résultats disponibles et retourne `undefined`. Les méthodes Tab plates existantes restent disponibles.
La façade AX et les méthodes plates agissent sur le même objet Tab lié.

Observations App et Tab :
- `getAXState({emit?, disableDiffing?})` retourne du texte. Les onglets et les applications macOS utilisent un diff par défaut ; les applications Windows et Linux retournent l'état complet.
- `getScreenshot({emit?})` retourne un `Uint8Array` et émet l'image.
- `getAXStateAndScreenshot(options?)` retourne `{state, screenshot?}` et émet les résultats disponibles.
La découverte, la sélection et les observations émettent automatiquement. Appelez-les directement ; envelopper `getScreenshot()` dans `nodeRepl.emitImage()` ou `getAXState()` dans `nodeRepl.write()` est redondant. Utilisez `{emit:false}` lorsque vous traitez le résultat vous-même ; les erreurs d'inventaire apparaissent tout de même. Les méthodes natives de capture d'écran sous Windows rejettent `{emit:false}` avant la capture. Les images identiques émises au sein d'un même appel ne sont livrées qu'une seule fois. Un appel ultérieur peut émettre la même image à nouveau.
Les observations incluent une fenêtre de stabilisation bornée pour les brèves mises à jour de l'interface (200 ms pour les onglets, 400 ms pour les applications). Cela n'attend pas les tâches asynchrones arbitraires ; une animation continue ne prolonge pas cette fenêtre. Actualisez pour observer les mises à jour ultérieures.
Une capture d'écran réussie du même document de navigateur inchangé préserve les références AX existantes. Après une navigation, un remplacement de document ou une invalidation de cible, actualisez `getAXState()` avant de réutiliser des index ; actualisez également pour les éléments nouvellement observés. Linux et Windows natifs conservent les identités d'éléments précédemment observées tant que ces éléments exacts restent valides.
Si une observation AX native échoue alors qu'une application est occupée, actualisez le même objet lié dès que l'application répond à nouveau. Les observations échouées invalident les anciens index et coordonnées.

Actions App et Tab :
- `await app.bringToFront()` active de manière persistante la fenêtre native exactement liée. Elle n'envoie aucune saisie clavier ou pointeur et signale un résultat inconnu si le bureau ne peut pas confirmer l'activation.
- `click(index | [x,y], {mouseButton?, clickCount?})`, `drag([x,y], [x,y])`.
- `scroll(index | [x,y], "up" | "down" | "left" | "right", distance?)`.
- Les applications natives acceptent également les boutons de souris `l/r/m` et les directions `u/d/l/r`.
  macOS supprime les espaces superflus, ignore la casse pour ces noms et accepte aussi les boutons `0/1/2` pour gauche/droite/milieu.
- `setValue(index, string)` ; indisponible pour les applications Linux natives.
- `selectText(index, text, {prefix?, suffix?, selectionType?})` où `selectionType` vaut `text`, `cursor_before` ou `cursor_after`. La sélection native est réservée à macOS.
  `text_not_found` signifie que le texte ou le contexte fourni est absent ; relisez l'état actuel. `ambiguous_text` nécessite un préfixe/suffixe plus spécifique.
- `performSecondaryAction(index, action)` : utilisez une action exacte listée dans l'observation AX native. CDP n'expose pas d'actions secondaires et rejette cette méthode.

Saisie App : `typeText(text)`, `paste(text, {format?})`, `pressKey(key)`.
Saisie Tab : `typeText(index|null, text)`, `paste(index|null, text, {format?})`, `pressKey(index|null, key)`. Un index fourni donne d'abord le focus au champ observé.
Utilisez `null` pour le focus actuel. Exemples de touches : `Return`, `Tab`, `super+a`, `shift+Left`.
Formats de collage : `text` (par défaut), `md` (source Markdown en texte brut) et `html`.
Les applications natives Linux et Windows ne prennent en charge que `text`.
Le collage HTML natif est réservé à macOS et requiert une valeur modifiable lisible ainsi qu'une sélection. Il active temporairement la fenêtre exacte, préserve sa sélection et restaure le presse-papiers précédent, sauf si l'utilisateur a copié un contenu plus récent. Une valeur inchangée est signalée comme incertaine.
Le collage HTML dans le navigateur requiert un élément contenteditable observé.

Navigation Tab : `goto(url)`, `back()`, `forward()`, `reload()`, `close()`.
`await tab.screenshot({ fullPage: false, clip: { x, y, width, height } })` retourne des octets JPEG sans émettre d'image. Omettez `clip` pour le viewport ; `fullPage: true` capture tout le document. La largeur et la hauteur de `clip` doivent être positives. Les coordonnées et dimensions utilisent des pixels CSS. La capture du viewport tente d'abord une image fraîche de diffusion d'écran (screencast), puis la commande de capture d'écran du même onglet après un nettoyage acquitté ; les opérations incertaines ne sont pas rejouées.

Sur les fournisseurs Extension, `await tab.markDeliverable()` garde l'onglet ouvert à la fin normale du tour et le libère pour l'utilisateur. `await tab.markHandoff()` conserve l'onglet pour cette même Session ; le tour suivant le reprend sans marquage. L'origine agent/utilisateur initiale est préservée, de sorte qu'un onglet créé par l'agent se ferme à la fin d'un tour ultérieur non marqué. Un marquage explicite ultérieur remplace le précédent. Les deux méthodes retournent `undefined` après l'accusé de réception d'intention correspondant, ce qui ne prouve ni la remise physique ni le nettoyage. Les marquages ne conservent aucune permission de site ; un appel incertain n'est pas rejoué. Le CDP direct ne prend pas en charge ces marquages.

`tab.clipboard` fournit `read()`, `readText()`, `write(items)` et `writeText(text)`.
Ces méthodes retournent des valeurs sans les émettre. Un élément riche possède un champ `entries` non vide ; chaque entrée possède `mimeType` et exactement un champ chaîne, `text` ou `base64`. Le champ optionnel `presentationStyle` vaut `unspecified`, `inline` ou `attachment`. Par exemple : `await tab.clipboard.write([{entries:[{mimeType:'text/plain',text:'Hello'}]}])`.
Les données virtuelles sont partagées entre les onglets utilisant le même contexte backend configuré ; cela ne lit ni ne modifie le presse-papiers du système d'exploitation. Les pages autorisées utilisent ces mêmes données via leur Clipboard API après installation. `readText()` côté agent retourne le texte de la première entrée exactement `text/plain`, ou une chaîne vide pour une entrée uniquement `base64` ; `readText()` côté page décode cette entrée via un `Blob`. Le nettoyage de fin de tour supprime les passerelles de page et conserve les données stockées. Une réinitialisation crée un nouveau contexte vide.

Les méthodes d'attente retournent `undefined`. `locator.waitFor({state, timeoutMs?})` requiert `state: 'attached'|'detached'|'visible'|'hidden'` et teste la première correspondance ; aucune correspondance satisfait `detached` et `hidden`.
`tab.playwright.waitForURL(pattern, {waitUntil?, timeoutMs?})` correspond à l'URL complète : `*` reste dans un segment délimité par des barres obliques, `**` peut traverser les barres obliques, et les autres caractères sont littéraux. La valeur par défaut de `waitUntil` est `commit` ; `load`, `domcontentloaded` et `networkidle` attendent cet état après une correspondance.
`tab.playwright.waitForLoadState({state?, timeoutMs?})` vaut `load` par défaut et accepte aussi `domcontentloaded` et `networkidle`. Ces attentes conditionnelles ont un délai par défaut de 3000 ms et respectent des délais explicites plus longs. Zéro ne laisse aucun budget d'attente d'événement : un localisateur effectue quand même sa première sonde, l'URL ou l'état de chargement actuel peut déjà correspondre, et `networkidle` expire. `tab.playwright.waitForTimeout(ms)` accepte un entier non négatif et attend pendant une durée fixe. Pour une attente déclenchée par une action, démarrez l'attente avant l'action, puis attendez les deux promesses. Un arrêt annule l'attente initiale.

`tab.playwright` résout des localisateurs DOM sans nécessiter d'observation AX préalable.
Utilisez `locator(selector)`, `getByRole`, `getByText`, `getByLabel`, `getByPlaceholder` ou `getByTestId` ; `frameLocator(selector)` entre dans un cadre. Les localisateurs prennent en charge `first/last/nth`, `filter`, `and/or`, `count`, `all`, `allTextContents`, `textContent`, `innerText`, `getAttribute`, `isEnabled` et `isVisible`.
`domSnapshot()` retourne le texte d'accessibilité DOM de la page.

Les méthodes de saisie de localisateur retournent `undefined` : `click(options?)`, `dblclick(options?)`, `fill(text, options?)`, `type(text, options?)`, `press(key, options?)`, `pressSequentially(text, options?)`, `selectOption(valueOrValues, options?)`, `setChecked(boolean, options?)`, `check(options?)` et `uncheck(options?)`.
Les options de clic acceptent `button: 'left'|'right'|'middle'`, `modifiers`, `force` et `timeoutMs` ; les options de case à cocher acceptent `force` et `timeoutMs`. Les modificateurs sont `Alt`, `Control`, `ControlOrMeta`, `Meta` et `Shift` ; `ControlOrMeta` utilise la plateforme du navigateur sélectionné. Les autres options de saisie acceptent `timeoutMs`. Les délais d'expiration sont des entiers positifs ; la préparation est par défaut de 3000 ms et respecte des délais explicites plus longs. Une sélection d'option accepte une chaîne de valeur ou un descripteur avec `value`, `label` ou un entier non négatif `index` ; les tableaux sélectionnent plusieurs options.

Les mutations de localisateur utilisent une correspondance unique ou la seule correspondance visible. Les correspondances ambiguës lèvent une exception. Le remplissage et la saisie de texte ordinaires utilisent un événement de collage virtuel, respectent l'annulation par un gestionnaire de page et préservent le presse-papiers stocké. Un collage vide n'efface pas une valeur par défaut. Les raccourcis clavier du presse-papiers utilisent ce même presse-papiers virtuel ; les combinaisons non prises en charge lèvent une exception avant d'envoyer des touches natives. Les écritures réussies effacent uniquement les lectures mises en cache de la collection de localisateurs appelante. Les résultats de saisie doivent toujours être vérifiés dans la page ; un résultat incertain n'est pas rejoué automatiquement.

Les téléchargements utilisent un fournisseur Extension connecté doté de notifications de téléchargement et de la permission de téléchargement actuelle du Host. Armez l'attente avant de déclencher l'action sur le même Tab :
`const pending = tab.playwright.waitForEvent('download', {timeoutMs:3000});`
puis effectuez le clic ou la navigation et `const download = await pending`.
`await download.path({timeoutMs?})` retourne le nom de fichier signalé par le navigateur ou `null`.
Cela ne transfère aucun fichier et ne prouve pas qu'un chemin appartient à cette tâche ; il peut s'agir d'un chemin sur un autre hôte, vide ou indisponible. Il n'existe pas d'opération `saveAs`.
`await tab.playwright.locator(selector).downloadMedia({timeoutMs?})` demande le média pour un localisateur correspondant unique. Les attentes de téléchargement retournent des données sans les émettre ; les déclencheurs de média retournent `undefined`. L'échéance de démarrage native se termine au premier événement `Started` correspondant ; l'annulation et le nettoyage du Host s'appliquent toujours ensuite.
La permission de lecture et la permission de téléchargement sont distinctes, y compris pour une origine source ou destination différente. Une connexion CDP configurée seule ne fournit pas de notifications de téléchargement natives.
Maka expose également `tab.cua.downloadMedia({x,y,timeoutMs?})` et `tab.dom_cua.downloadMedia({node_id,timeoutMs?})` en tant qu'extensions restreintes. Les fournisseurs Extension sélectionnés rejettent actuellement ces commandes média par coordonnées ou nœud ; utilisez la voie par localisateur implémentée. Un résultat de téléchargement incertain n'est jamais réessayé automatiquement.
Le handle retourné conserve sa liaison Tab d'origine, et non une autorisation. Gardez cet onglet disponible : `path()` revérifie les métadonnées actuelles de l'onglet et les permissions du Host avant sa recherche en cache. Un handle obsolète ne peut pas maintenir un onglet fermé en vie. Les tours ultérieurs requièrent toujours l'accès actuel à l'onglet ; il peut être nécessaire de reprendre en charge l'onglet.

`await tab.getJsDialog()` retourne `undefined` ou l'objet de boîte de dialogue actuel avec `type` et `dismiss()`. Les boîtes de confirmation disposent aussi de `accept()` ; les boîtes d'invite disposent de `accept(text)`, y compris avec une chaîne vide. Les anciens objets de boîte de dialogue ne peuvent pas agir sur une boîte de dialogue de remplacement. Traitez une boîte de dialogue active avant toute lecture ou saisie ordinaire sur la page.
`getAXState()` affiche son message et ses contrôles indexés ; les contrôles d'invite prennent en charge `setValue`, `typeText` et `Return`/`Escape`. Les contrôles de boîte de dialogue n'ont pas de coordonnées de page.
Les captures d'écran sont indisponibles lorsqu'une boîte de dialogue est ouverte : les appels de capture d'écran seuls lèvent une exception, et les observations combinées retournent l'état de la boîte de dialogue sans propriété `screenshot`.
Un Host de navigateur attaché accepte automatiquement les boîtes de dialogue `beforeunload` tant qu'il détient le contrôle en cours. Le nettoyage de fin de tour détache le contrôle sans fermer les onglets utilisateur.

La navigation prend en charge HTTP(S) et `about:blank` et attend un document observable.
La cible CDP principale est couverte ; l'accessibilité des iframes inter-processus n'est pas complète.
Les distances de page CDP acceptent des nombres finis, y compris des fractions, zéro et des valeurs négatives. Une page utilise la largeur ou la hauteur du contenu de la cible, avec un minimum de 100 pixels CSS ; les cibles par coordonnées utilisent le viewport. L'extension `{pixels:n}` de CDP accepte des deltas de pixels finis positifs.
Linux rejette les nombres de pages numériques. Linux X11 utilise `{pixels:800}` par défaut et accepte des distances entières en pixels de 1 à 65535. Il envoie `max(round(pixels/100),1)` crans de molette ; l'application détermine le déplacement effectif du contenu. Linux Wayland refuse actuellement la saisie en pixels.
Le défilement sous macOS prend des nombres de pages finis positifs (1 par défaut) et rejette `{pixels}`. Les nombres fractionnaires de pages sont pris en charge.
Windows requiert un point de coordonnées et une distance finie positive `{pixels:500}` ; les distances omises et les nombres de pages numériques sont rejetés. Les coordonnées et les distances signées selon la direction utilisent `Math.round` de JavaScript ; les valeurs arrondies doivent tenir dans des entiers signés 32 bits. Les deltas de molette natifs sont bornés par axe à `[-32768,32767]`, et le pointeur reste sur la cible.
L'application détermine le déplacement du contenu. Le défilement natif indexé préserve la cible d'accessibilité sélectionnée. Les clics natifs indexés du wrapper App prennent en charge un seul clic sémantique ; utilisez des coordonnées de capture d'écran pour plusieurs clics. La méthode macOS brute `cua.computer.click` prend également en charge plusieurs clics indexés via des événements de souris simulés.

Un envoi de saisie réussi n'établit pas l'état résultant de l'application.
Les actions par coordonnées dans le navigateur utilisent des coordonnées CSS du viewport et ne nécessitent aucune capture d'écran.
Les captures d'écran ne mettent pas à l'échelle ces coordonnées.
Les coordonnées locales à une fenêtre sous Linux peuvent être utilisées sans prendre de capture d'écran. Les correspondances de capture d'écran natives sous Linux et Windows survivent aux actions de saisie jusqu'à ce qu'une autre observation les remplace ; une observation AX seule efface la correspondance d'image. La saisie par coordonnées sous Windows nécessite alors une nouvelle capture d'écran. Un changement de géométrie de fenêtre invalide une correspondance stockée. La saisie par coordonnées sous macOS nécessite actuellement une nouvelle capture d'écran après chaque action.
Les actions sémantiques natives utilisent les éléments d'accessibilité conservés. Les menus d'application sont limités à leur processus propriétaire et à la fenêtre exactement liée ; le contenu des menus fermés est omis tant que le menu n'est pas ouvert. L'interaction avec un menu peut activer la fenêtre liée et la maintenir active tant que le menu est ouvert.
La saisie native par coordonnées et clavier utilise par défaut l'envoi en arrière-plan vers la fenêtre exactement liée. Un envoi en arrière-plan non pris en charge est signalé ; la saisie n'est pas rejouée automatiquement au premier plan. Des effets non vérifiés peuvent déjà avoir été livrés.
Privilégiez les opérations d'onglet de navigateur (`Tab`) pour les sites web : elles évitent le focus du bureau et les entrées du pointeur. Pour la saisie de texte native, préférez `typeText` ou `setValue` ; `paste` sur macOS utilise le presse-papiers système et une saisie clavier au premier plan. Les menus natifs peuvent activer leur fenêtre. Certaines voies par coordonnées peuvent déplacer le pointeur système ; les métadonnées de livraison indiquent la voie réellement utilisée. Les appels natifs `app.pressKey(key, {deliveryMode:"foreground"})` et `app.typeText(text, {deliveryMode:"foreground"})` demandent explicitement une voie au premier plan lorsque nécessaire ; la valeur par défaut est `"background"`. Ne réessayez pas automatiquement une saisie non vérifiée et ne basculez pas silencieusement de mode.

`nodeRepl.write(value)` émet du texte/JSON. `await nodeRepl.emitImage(bytes | dataUrl | {bytes, mimeType})` émet une image. Les URL d'image fichier/HTTP, Node, l'accès arbitraire au système de fichiers et les API réseau sont indisponibles. `cua.rewriteDocumentation()` réaffiche cette référence.

Lorsque le Host active l'audio de sortie, `await cua.computer.start_audio_recording({max_duration_ms?})` démarre l'enregistrement et retourne `undefined` tandis que d'autres appels peuvent continuer. La durée par défaut est de 60000 ms et accepte des entiers de 100 à 300000. `await cua.computer.stop_audio_recording()` retourne `{filepath, bytes, data_url}` pour le fichier WAV stéréo 24 kHz PCM16 finalisé. Atteindre la durée met fin à la capture ; appelez `stop` pour la récupérer. `await nodeRepl.emitAudio(bytes | dataUrl | {bytes, mimeType})` émet explicitement de l'audio. Ces méthodes sont absentes lorsque l'audio est désactivé.
La réinitialisation et le nettoyage de Session suppriment les enregistrements et leurs chemins locaux.

Chaque opération utilise les permissions actuelles du Host ; les objets JS ne conservent aucune autorisation.
Lorsque le bac à sable (sandbox) de la Session est désactivé, Computer Use, les applications, les sites de navigateur, l'historique, les transferts de fichiers et l'audio ne nécessitent aucune approbation Maka supplémentaire. La modification des permissions ou l'arrêt de l'opération en cours reste effective.
En mode Ask, l'approbation Computer Use intervient avant le démarrage du délai d'exécution du REPL.
Les attentes de consentement pour les applications, les sites de navigateur et l'audio mettent en pause le budget restant. Les attentes natives macOS/Windows le mettent également en pause ; les attentes asynchrones ordinaires et les opérations natives Linux le consomment. La mise en pause ne recharge jamais le budget et ne désactive pas l'annulation.
Les opérations natives macOS signalent `desktop_locked` lorsque l'écran est verrouillé ; les fournisseurs CDP connectés et les calculs purs dans le REPL restent disponibles indépendamment.
Chaque Session dispose de son propre curseur Maka. Les actions de saisie l'affichent automatiquement.
`cua.cursor.configure({label?, color?, enabled?, reducedMotion?})` modifie l'affichage de cette Session. Les couleurs sont `blue`, `mint`, `violet`, `amber`, `rose`, `cyan` ; les libellés acceptent jusqu'à 48 caractères. `cua.cursor.getState()` indique les paramètres et la visibilité native/navigateur. Un moteur de rendu natif à l'état `idle` démarre lors de la première indication native ; `unavailable` signale un hôte d'affichage manquant ou défaillant.
Configurez à nouveau pour réessayer un moteur de rendu défaillant. Le curseur appartient à la Session mais ne reste pas affiché à l'écran après un tour : il s'affiche pendant le tour, se masque à la fin du tour et réapparaît lors de la prochaine action de saisie.
Les curseurs ne partagent aucune autorité de saisie et ne déplacent pas le pointeur système. Plusieurs curseurs n'isolent ni le clavier physique, ni le focus d'application, ni la méthode de saisie.
Un REPL annulé, arrivé à expiration ou dont le tas est épuisé requiert `cua_reset`, suivi d'une nouvelle liaison des cibles. Le travail natif déjà admis se stabilise avant de retourner ; la réinitialisation n'annule pas une saisie déjà envoyée.
À la fin normale d'un tour, cette Session ferme les onglets temporaires non marqués qu'elle a créés et libère ses observations de page.
Les onglets utilisateur préexistants et les onglets marqués pour conservation restent ouverts selon les règles ci-dessus. La réinitialisation efface le REPL et les liaisons de cette Session ; elle n'accorde aucun nouvel accès et n'efface pas les obligations de ressources conservées et de nettoyage de cette Session.
Un marquage ou une fermeture non confirmés conservent la garde et ne sont pas rejoués.

La même collection de navigateurs est disponible sous `agent.browsers` et `cua.browsers`.
Ses méthodes `list`, `get(id)`, `getDefault` et `getForUrl(url)` retournent des métadonnées ou des objets Browser paresseux sans émettre d'observation. `cua.getBrowser` est le point d'entrée pratique qui émet la documentation. Un objet Browser expose `tabs.selected()` pour l'onglet actif de sa session logique ; cela ne sélectionne pas l'onglet ayant le focus système.
Le fournisseur CDP direct actuel ne dispose pas de service d'onglet actif de session logique et retourne `undefined` depuis `selected()`.

`await browser.release()` restitue le bail de navigateur ChatGPT à la demande de cette Session. Il règle les onglets temporaires de ce tour et les ressources de contrôle physique avant de libérer l'hôte ; les pages conservées restent ouvertes. Les autres Sessions conservent leurs propres baux. La dernière libération restaure l'hôte natif d'origine. Réacquérez-le avec `cua.getBrowser({id: "chatgpt"})` avant toute nouvelle utilisation ; les handles issus d'une génération d'hôte retirée nécessitent un nouveau rattachement. Le nettoyage normal de fin de tour libère également le bail. Les agents de longue durée devraient le libérer avant de se mettre en veille. Les autres fournisseurs de navigateur ne prennent pas en charge cette opération.

`await browser.nameSession(name)` supprime les espaces superflus et enregistre le titre du groupe géré de la session. La présentation gérée existante est mise à jour via ses reçus détenus ; les futurs onglets créés utilisent le titre enregistré. `cua.createBrowserTab(id, url, {sessionName})` résout le navigateur et attend le nommage avant de créer l'onglet.
Le profil de navigateur actuel ne propose pas la capacité de visibilité.

`await browser.history({queries, limit, from, to})` lit l'historique de tout le profil via une extension qui annonce le transport d'historique distinct. Avec le bac à sable activé, cela requiert un consentement indépendant `browser_history` pour l'ID et la génération réels du navigateur dans les limites de permission actuelles de la Session. Les autorisations de page et de téléchargement ne l'autorisent pas. Aucune requête d'historique n'est accordée automatiquement par la politique d'origine de page.
Par défaut, la requête porte sur tout l'historique limité à 100 entrées ; les résultats des requêtes fournies sont combinés par heure de visite décroissante, dédupliqués par URL, puis limités.
L'extension Maka fournie déclare la permission d'historique de Chrome ; une extension installée plus ancienne sans cette permission n'annonce aucune prise en charge de l'historique.
ChatGPT et les autres adaptateurs tiers restent fournis au mieux (best effort).

- `await browser.user.getTabContext(tabOrId)` lit le contexte d'un onglet utilisateur actuellement visible sans le prendre en charge ni lui donner le focus. L'URL actuelle de l'onglet est autorisée par le Host ; les appelants ne peuvent pas fournir d'URL de remplacement. Les onglets privés et toute URL changeant pendant une lecture individuelle sont refusés. Le résultat est soit `{kind:'text',text,title,url,truncated}`, soit `{kind:'document',data,fileName,mimeType,title,url}`, où `data` est un `Uint8Array` contenant le fichier effectivement exporté. Lorsque le Host fournit la publication de fichiers, les documents incluent également un véritable `path` appartenant à la Session. Les documents Google Workspace peuvent fournir un contexte Markdown, PDF ou XLSX ; les pages ordinaires peuvent inclure la sélection actuelle, et les pages de visionnage YouTube peuvent inclure une transcription. Le fournisseur `maka` implémente les lectures fixes ; `chatgpt` réutilise son protocole de lecture standard lorsqu'il est pris en charge. La prise en charge tierce reste fournie au mieux (best effort).

- `await tab.playwright.evaluate(pageFunction, arg?, {timeoutMs}?)` évalue une fonction autonome sur la page actuelle. Une chaîne de caractères est traitée comme une expression. Les variantes de localisateur passent `(element, arg)` à `locator.evaluate` ou `(elements, arg)` à `locator.evaluateAll` ; la forme à élément unique exige une cible non ambiguë et la forme pour tous les éléments accepte une correspondance vide.
  Les arguments doivent être sérialisables en JSON. Les résultats sont des données simples ; les fonctions et symboles sont omis, les grands entiers deviennent des chaînes et les nombres non finis deviennent `null`. Cette API limite la profondeur des résultats à 8, les tableaux à 2000 entrées, les objets à 200 clés et les chaînes à 200000 unités UTF-16, avec les marqueurs `[MaxDepth]`, `[Circular]` et `[Truncated]` le cas échéant.
- L'évaluation expose des vues DOM, CSS, géométrie, plage et sélection en lecture seule.
  Elle n'expose ni le réseau, ni les cookies, ni le chargement de modules, ni la modification du DOM. Le défilement, les limites de plage locales et les minuteurs à fonction uniquement restent pris en charge.
  Le délai d'expiration par défaut est de 3000 ms ; des valeurs explicites définissent la durée demandée.
  Un script arrêté ou interrompu s'est peut-être déjà exécuté ; il n'est pas réexécuté automatiquement. Les permissions de site et la propriété de l'onglet existantes restent applicables.

La saisie par pointeur dans le navigateur est disponible via `tab.cua.move({x,y,keys?})`, `click({x,y,button?,keypress?})`, `double_click({x,y,keypress?})`, `drag({path:[{x,y},...],keys?})` et `scroll({x,y,scrollX,scrollY,keypress?})`. Les coordonnées et distances sont des nombres du viewport CSS et conservent les valeurs fractionnaires et négatives ; les boutons sont 1 (gauche), 2 (milieu) ou 3 (droite). Les noms de modificateurs de pointeur sont Alt, Control, Meta, Shift et ControlOrMeta. `tab.cua.keypress({keys:[...]})` envoie une combinaison de touches au focus actuel ; `tab.cua.type({text})` colle du texte au focus actuel via le presse-papiers virtuel du navigateur, en préservant les données stockées dans le presse-papiers. Le texte peut contenir du Markdown ; Google Sheets reçoit du texte brut. Ces méthodes de saisie retournent `undefined` et ne réessaient pas une saisie incertaine.

`await tab.dom_cua.get_visible_dom()` retourne le HTML interactif visible avec des valeurs de chaîne `node_id`. Utilisez ces chaînes exactes avec `click({node_id})` ou `double_click({node_id})` ; `scroll({node_id?,x,y})` prend des distances de défilement et utilise le centre du viewport lorsque `node_id` est omis. `keypress({keys:[...]})` et `type({text})` utilisent le focus actuel, et non un ID de nœud. Les méthodes DOM retournent `undefined` à l'exception de l'instantané. Un nouvel instantané retire les nœuds DOM manquants ; une navigation ou un remplacement de cadre peut rendre un nœud obsolète. Observez à nouveau plutôt que de deviner un ID ou de rejouer une saisie dont le résultat est inconnu.

<!-- named-browser-documents -->
<!-- browser-document: bootstrap-troubleshooting chrome-troubleshooting browser-troubleshooting -->
# Dépannage du navigateur
Lisez `cua.getState()` et `agent.browsers.list()` pour identifier le navigateur disponible et son ID exact. Une connexion configurée ne prouve pas qu'une action donnée a réussi. Lorsqu'une liaison est obsolète ou que son résultat est inconnu, inspectez l'état actuel avant de choisir l'opération suivante ; une mutation incertaine ne doit pas être répétée automatiquement.
<!-- /browser-document -->
<!-- browser-document: browser-safety confirmations -->
# Autorité du navigateur
Une liaison de navigateur ne conserve pas de permission. Les opérations utilisent la Session, le tour, la politique d'espace de travail et l'origine de page actuels. Le consentement pour lire une page n'autorise pas les transferts de fichiers ni l'historique de tout le profil. Une approbation refusée, une Session fermée ou une limite de permission modifiée doit être traitée avant toute nouvelle action.
<!-- /browser-document -->
<!-- browser-document: visibility capabilities/browser/visibility -->
# Visibilité du navigateur
Lisez `browser.capabilities.list()` pour déterminer si ce navigateur publie une capacité de visibilité. Un nom de documentation ne prouve pas que la capacité est activée. Lorsque la visibilité est absente, passer une option `visible` à la création d'un onglet échoue avant la création de l'onglet.
<!-- /browser-document -->
<!-- browser-document: session-naming -->
# Nommage de session
`await browser.nameSession(name)` attribue un titre non vide (sans espaces superflus) au groupe d'onglets géré de cette Session de navigateur et aux futurs onglets créés. `cua.createBrowserTab(id, url, {sessionName})` attend cette étape de nommage avant de créer un onglet ; une erreur de nommage ne crée pas l'onglet.
<!-- /browser-document -->
<!-- browser-document: tab-claiming-chrome -->
# Onglets utilisateur
`browser.user.openTabs()` retourne les métadonnées des onglets utilisateur sans les prendre en charge. `browser.user.claimTab(listedTabOrId)` acquiert explicitement l'onglet exact choisi. `browser.tabs.get(id)` retourne une liaison paresseuse et ne constitue pas une prise en charge implicite d'un onglet utilisateur arbitraire. Les onglets utilisateur sont libérés plutôt que fermés lors du nettoyage de fin de tour.
<!-- /browser-document -->
<!-- browser-document: tab-cleanup-chrome -->
# Cycle de vie des onglets gérés
Les onglets créés sont temporaires à moins que leur cycle de vie actuel ne les conserve explicitement. `markDeliverable()` préserve un résultat terminé pour l'utilisateur ; `markHandoff()` conserve un onglet pour poursuivre le travail dans la même Session. Ces marquages ne préservent pas les anciennes permissions de page et n'autorisent pas une autre Session. La fermeture, l'arrêt et les effets incertains conservent leurs propres exigences de nettoyage.
<!-- /browser-document -->
<!-- browser-document: tab-mentions-iab tab-cleanup-iab capabilities/browser/management -->
# Disponibilité des backends de navigateur
L'ensemble actuel de fournisseurs Maka comprend les extensions de navigateur et les connexions CDP configurées ; il n'ajoute pas de backend de navigateur intégré. Liez les navigateurs et les onglets à l'aide des ID issus de l'inventaire actuel. Lire une référence concernant un backend intégré ou une capacité de gestion ne crée pas ce backend et n'accorde aucune autorité de gestion du navigateur.
<!-- /browser-document -->
<!-- browser-document: browser-control-interruption -->
# Opérations interrompues
L'annulation ne prouve pas qu'une opération envoyée a été annulée côté cible. Conservez la liaison et le résultat d'opération initiaux jusqu'à ce qu'ils se stabilisent ; ne répétez pas une mutation via un autre fournisseur. Une réinitialisation efface les liaisons du REPL, et le travail ultérieur doit lier à nouveau les cibles selon les permissions actuelles.
<!-- /browser-document -->
<!-- browser-document: api-use-behavior -->
# Utilisation de l'API navigateur
`agent.browsers` et `cua.browsers` partagent la même collection. Les appels de collection retournent des données ou des liaisons paresseuses sans émettre d'observation. `agent.documentation.get(name)` lit un document nommé exact et retourne une Promise de son texte sans l'émettre. `tabs.selected()` suit l'activité logique de la Session. Les ID de navigateur exacts et les liaisons d'onglet existantes ne changent pas de fournisseur.
<!-- /browser-document -->
<!-- browser-document: accessibility -->
# Observations d'accessibilité
Lisez un nouvel état d'accessibilité avant d'utiliser ses références d'éléments. `tab.ax` expose les opérations d'accessibilité documentées et `get(mode, options)` retourne l'état, les octets de capture d'écran ou les deux sans émission automatique. Une navigation ou un document modifié peut invalider les références précédemment observées ; actualisez l'observation plutôt que de deviner un index.
<!-- /browser-document -->
<!-- browser-document: webmcp capabilities/tab/cdp capabilities/tab/botDetection capabilities/tab/browserAuth -->
# Capacités de navigateur optionnelles
Lisez la collection de capacités de l'objet sélectionné avant d'utiliser une capacité optionnelle. Une référence de documentation n'active pas les API brutes CDP, WebMCP, d'authentification ou de traitement de défis (challenges). Si son ID est absent de cette collection, la capacité est indisponible ; les opérations de page existantes conservent leurs vérifications normales de permissions et de cycle de vie.
<!-- /browser-document -->
<!-- browser-document: local-web-development -->
# Pages de développement local
Choisissez un navigateur capable d'atteindre l'URL de développement visée et naviguez vers cette URL explicite. Un nom d'hôte local reste soumis à la politique réseau actuelle de l'espace de travail et à l'autorisation d'origine de page. Conservez la liaison du navigateur sélectionné pendant la vérification de la page ; le `localhost` d'une autre machine est une destination différente.
<!-- /browser-document -->
<!-- browser-document: file-uploads chrome-file-upload-troubleshooting -->
# Téléversements de fichiers
N'utilisez les opérations de téléversement que lorsque la documentation du navigateur sélectionné les expose. Un téléversement requiert sa propre permission actuelle pour la page et les fichiers choisis ; une autorisation de lecture de page ou de téléchargement ne vaut pas consentement de téléversement. Un sélecteur de fichiers appartient à l'interaction exacte sur la page qui l'a ouvert. Si cette page ou ce sélecteur n'est plus actuel, repartez d'une nouvelle observation au lieu de réutiliser un ancien sélecteur.
<!-- /browser-document -->
<!-- browser-document: screenshots -->
# Captures d'écran
`tab.getScreenshot()` retourne les octets de la capture d'écran ; les assistants d'observation peuvent émettre l'image. Utilisez une nouvelle capture après une navigation, un redimensionnement ou un défilement avant de décider des coordonnées. Une capture d'écran est une observation, pas une preuve qu'une saisie antérieure a atteint le contrôle prévu.
<!-- /browser-document -->
<!-- browser-document: capabilities/browser/viewport -->
# Capacité de viewport
Lisez `browser.capabilities.list()` et obtenez la capacité de viewport publiée avant de modifier la taille. Les paramètres de viewport suivent l'onglet actif logique de la Session de navigateur et son cycle de vie actuel. Modifier la taille du viewport ne sélectionne pas un onglet sans rapport ayant le focus système et n'accorde aucun accès à la page.
<!-- /browser-document -->
<!-- browser-document: capabilities/tab/pageAssets -->
# Capacité de ressources de page
N'utilisez les ressources de page que lorsque l'onglet sélectionné publie cette capacité. L'inventaire des ressources appartient à la page et au document observés. Après une navigation ou un remplacement de document, obtenez un nouvel inventaire ; d'anciens identifiants de ressources ne peuvent pas autoriser les fichiers d'une autre page. Enregistrer des fichiers requiert la permission actuelle de transfert de fichiers de l'opération.
<!-- /browser-document -->

### Sélecteurs de fichiers et téléversements

```js
const pending = tab.playwright.waitForEvent('filechooser', { timeoutMs: 3000 });
await tab.playwright.getByRole('button', { name: 'Upload' }).click();
const chooser = await pending;
chooser.isMultiple();
await chooser.setFiles(['workspace-file.bin']);
```

Démarrez l'attente avant l'action qui ouvre le sélecteur. L'attente par défaut de l'événement de sélecteur est de 3000 ms ; un délai d'expiration explicite doit être un entier positif. `isMultiple()` est synchrone. `setFiles(pathOrPaths, {timeoutMs})` accepte un chemin ou un tableau non vide ; un sélecteur à fichier unique rejette plusieurs chemins. Son délai d'expiration optionnel est validé sans abandonner une sélection en cours.

Les chemins font référence au système de fichiers de l'Agent Host et restent soumis à la politique de fichiers de l'espace de travail de l'appelant. L'accès à la page, le consentement de téléversement pour l'origine HTTP(S) actuelle et la permission de lecture de fichiers sont distincts. L'instantané d'entrée pris en charge est un fichier ordinaire. Les fichiers sont transportés sous forme d'octets immuables et matérialisés par l'hôte de navigateur Maka sélectionné ; ne traduisez pas vous-même les chemins entre systèmes d'exploitation.

Les handles de sélecteur appartiennent à leur onglet, leur document et leur tour d'émission. Les sélecteurs de cibles enfants ne sont pas pris en charge. Les sélecteurs d'extension requièrent une provenance complète de l'événement source ; les téléversements requièrent en outre un placement vérifié des fichiers sur l'hôte de navigateur. Chatgpt est fourni au mieux (best effort), et un CDP configuré sans un tel placement refuse le téléversement avant d'envoyer les fichiers. Un onglet déjà lié n'est jamais remplacé par un autre navigateur pour satisfaire l'opération. Une sélection réussie consomme le sélecteur. Un résultat inconnu doit être réconcilié plutôt que rejoué.

Si le nettoyage signale un résultat non confirmé, ne supposez pas que les données de téléversement copiées ont été supprimées. La récupération automatique après la fermeture de l'hôte de navigateur alors que des fichiers restent sélectionnés n'est pas encore disponible.
