Computer Use es un REPL de JavaScript independiente y persistente. Usa `cua_repl` directamente; no se requiere Code Mode. Las variables y los objetos vinculados persisten entre llamadas y turnos dentro del proceso actual del Host. Un REPL nuevo tras un reinicio no conserva variables del historial; sigue el estado actual de Computer Use proporcionado con la solicitud del modelo.
Para sitios web, empieza con `await cua.listBrowsers()` y usa una pestaña del navegador (`Tab`) antes de recurrir a la entrada nativa sobre ventanas del navegador. Las conexiones de ChatGPT instaladas pueden tomarse bajo demanda sin configuración de shell ni iniciar ChatGPT de escritorio.
Usa `await` de nivel superior, no `return` de nivel superior. Este REPL conserva las declaraciones; reutiliza los enlaces existentes o elige nombres nuevos. No dispone de API de Node ni de `setTimeout`.

`cua.computer.target` identifica la plataforma de escritorio seleccionada (`mac`, `linux`, `windows`). En WSL usa por defecto el host de Windows; los comandos de shell pueden seguir ejecutándose en Linux.

`cua.computer` también expone métodos nativos de plataforma en snake_case. Estos reciben un objeto de opciones en lugar de los argumentos posicionales de App/Tab descritos más abajo; `list_apps()`, `list_windows()` y `get_screenshot()` en Linux no aceptan opciones. Descubre primero la superficie seleccionada y lee su inventario:
```js
const native = cua.computer;
nodeRepl.write({target: native.target, methods: Object.keys(native).filter(k => typeof native[k] === 'function')});
nodeRepl.write(await (native.list_windows ? native.list_windows() : native.list_apps()));
```
| target | Métodos nativos (el audio se documenta por separado) |
| --- | --- |
| `linux` | `perform_secondary_action`, `click`, `drag`, `drag_handle`, `activate_window`, `get_screenshot`, `list_apps`, `list_windows`, `move`, `move_relative`, `press_key`, `scroll`, `type_text`, `launch_app`, `get_window_state` |
| `mac` | `list_apps`, `get_app_state`, `click`, `drag`, `paste`, `perform_secondary_action`, `press_key`, `scroll`, `select_text`, `set_value`, `type_text` |
| `windows` | `activate_window`, `get_window_state`, `click`, `scroll`, `drag`, `press_key`, `type_text`, `launch_app`, `list_apps`, `list_windows`, `get_window`, `perform_secondary_action`, `set_value` |

- Linux X11: usa un objeto `window` devuelto para `get_window_state({window, query?, include_screenshot?})`. Pasa un `element_id` observado **o** enteros `x,y` a `click({window, element_id})` / `click({window, x, y, mouse_button?, click_count?, duration?, key?})`; las coordenadas de ventana son locales y omitir `window` usa el escritorio. Otras entradas incluyen `type_text({window?, text, element_id?})`, `press_key({window?, key, duration?})`, `scroll({window?, direction, pixels?, x?, y?, element_id?, key?})`, `drag({window?, path:[{x,y},…], key?})`, `move({window?, x,y,key?})`, `move_relative({dx,dy,key?})`, `activate_window({window})`, `perform_secondary_action({window,element_id,action})` y `launch_app({app})`. `duration` se expresa en milisegundos. `drag_handle()` crea un handle de escritorio con `start({x,y})`, `move_to({x,y})`, `end()`; finalízalo explícitamente dentro del mismo turno.
- Windows: usa el descriptor de ventana `{app,id,...}` devuelto. Lee `get_window_state({window, include_text?, include_screenshot?})` antes de la entrada indexada o basada en capturas; las capturas vienen activadas por defecto y el texto desactivado. Usa `click({window,element_index})` o `click({window,x,y,screenshotId?})`, `scroll({window,x,y,scrollX,scrollY,screenshotId?})`, `drag({window,from_x,from_y,to_x,to_y,screenshotId?})`, `press_key({window,key})`, `type_text({window,text})`, `set_value({window,element_index,value})`, `perform_secondary_action({window,element_index,action})`, `activate_window({window})`, `get_window({id})` y `launch_app({app})`. Establece `screenshotId` con el `id` de la captura devuelta para usar coordenadas de imagen. Sin él, usa coordenadas enteras locales a la ventana en las dimensiones de la última captura observada, o en las dimensiones de la ventana antes de realizar una observación con captura. El desplazamiento acepta tanto `scrollX` como `scrollY` en la misma llamada. Las acciones secundarias admiten actualmente Expand/Collapse; otras etiquetas se rechazan.
- macOS: usa el `id` de aplicación devuelto como `app`. Lee `get_app_state({app})` y luego llama a `click({app,element_index,mouse_button?,click_count?})` o `click({app,x,y,mouse_button?,click_count?})`, `drag({app,from_x,from_y,to_x,to_y})`, `scroll({app,element_index,direction,pages?})` (o `x,y`), `press_key({app,key})`, `type_text({app,text})`, `paste({app,text,format:'text'})`, `set_value({app,element_index,value})`, `select_text({app,element_index,text,prefix?,suffix?,selection_type?})` o `perform_secondary_action({app,element_index,action})`.

Los inventarios nativos y las formas de estado difieren según la plataforma; reutiliza los ID y selectores devueltos, no handles del envoltorio App. El estado de Linux devuelve `ax_tree` y `screenshots`; las entradas de captura incluyen `filepath`, `bytes`, `data_url`. El estado de Windows emite automáticamente sus imágenes de captura. Los demás resultados nativos se devuelven para usarlos con `nodeRepl.write`/`emitImage`; los métodos mutadores devuelven undefined. Siguen aplicándose los permisos actuales del Host y de la aplicación, y un método presente puede rechazar un backend no disponible o una operación no admitida. Actualiza el estado tras un error stale-target; no repitas una entrada cuyo resultado sea desconocido. No arrastres una operación de drag activa entre turnos; actualiza las observaciones después de restablecer.


Un REPL nuevo no tiene objetivos vinculados. Los puntos de entrada siguientes emiten documentación de la API e inventario o estado inicial del objetivo. Los ID de navegador provienen de proveedores CDP configurados y de proveedores de navegador de extensión (Extension) conectados. Los ID exactos tienen prioridad; solo cuando no hay coincidencia exacta, `maka` y `chatgpt` seleccionan un único punto de conexión de extensión actual. Si ninguno está disponible, usa ventanas nativas del navegador mediante `getApp`. La API no expone administración del controlador como `start_session`.

Una extensión de ChatGPT instalada con su host nativo original se descubre automáticamente en Chrome o Chromium. `listBrowsers()` la informa como `on_demand`; seleccionarla toma el control hasta que `browser.release()` o la limpieza del turno restauren el host original. No se requiere comando de configuración, puerto de depuración ni abrir ChatGPT de escritorio. Prefiere esta conexión de navegador para sitios web antes que la entrada nativa en ventanas del navegador.

La compatibilidad con ChatGPT es de mejor esfuerzo (best effort). Los ID exactos y los handles existentes nunca cambian de proveedor.

Puntos de entrada (la selección emite el estado inicial):
- `await cua.getState({emit?})`: inventario de aplicaciones y navegadores disponibles, incluidos los errores de inventario.
- `await cua.listApps({emit?})`, `await cua.listWindows({pid?, emit?})`.
  Pasa el PID de una aplicación observada para incluir sus paneles flotantes en macOS.
  Las entradas de ventana incluyen `pid` y `bindable`. Selecciona una ventana con `bindable: true`.
  Una vinculación no disponible incluye `bindingError`. Las entradas vinculables de macOS también incluyen `applicationId` y `appPath`. Al vincular se verifican el consentimiento de la aplicación y su identidad activa.
- `const app = await cua.getApp("Name / bundle ID / app path")` o `getApp({windowId})`.
  macOS inicia una aplicación que no esté abierta. En Windows, `getApp` selecciona una ventana ya abierta; usa `await cua.computer.launch_app({app: appId})` con un ID de `cua.listApps()`, luego actualiza el inventario y selecciona su ventana exacta. Selecciona una ventana exacta cuando los nombres sean ambiguos. Linux requiere que la aplicación ya esté abierta.
- `await cua.listBrowsers({emit?})`, `await cua.listTabs({browser?, emit?})`.
- `const browser = await cua.getBrowser({id? , url?})`: selecciona sin abrir una pestaña. La URL prevista no necesita estar abierta todavía. Selecciona un ID cuando haya varios proveedores disponibles.
- `const tab = await cua.getTab("tab ID", {browser?})` o `getTab({url}, {browser?})`.
- `await cua.createBrowserTab(browserId, url?)`: abre en el perfil del proveedor seleccionado. Aquí y en `getBrowser`, las URL sin esquema usan HTTPS. La creación empieza con una pestaña en blanco propia; una URL explícita solicita luego la navegación. Una navegación rechazada deja esa pestaña en blanco para la limpieza del turno. Los proveedores no disponibles, las menciones de pestaña y las opciones de creación no admitidas lanzan un error.
- `await browser.tabs.list()`, `await browser.tabs.get(id)`, `await browser.tabs.new()`: lista pestañas, vincula una pestaña exacta o crea una pestaña temporal en blanco en ese navegador. Estos métodos devuelven datos sin emitirlos; `get`/`new` devuelven objetos Tab sin una observación AX inicial. Llama a `getAXState` antes de usar objetivos observados. `await tab.title()` y `await tab.url()` devuelven metadatos actuales sin cambiar la observación de accesibilidad.

- Los adaptadores de navegador conectados también exponen `await browser.user.openTabs()` y `await browser.user.claimTab(tabOrId)`. El listado devuelve los metadatos actuales de las pestañas del usuario; reclamarla (claim) devuelve el Tab habitual tras comprobar los permisos actuales y preparar la conexión. Usa un ID de cadena listado o un objeto listado. La limpieza del turno libera las pestañas del usuario sin cerrarlas; las pestañas creadas por esta sesión siguen siendo temporales. `browser.tabs.get(id)` sigue siendo una vinculación diferida y no realiza reclamación inicial ni observación AX. Estos métodos no retienen permisos. Para los proveedores de extensión, `browser.tabs.list()` lista las pestañas administradas por esta sesión. Los proveedores CDP configurados omiten `browser.user`; usa en su lugar sus métodos `browser.tabs`.

Maka expone un perfil AX de navegador: `tab.ax` contiene `get`, `write`, `click`, `drag`, `paste`, `performSecondaryAction`, `pressKey`, `scroll`, `selectText`, `setValue` y `typeText`. Las firmas de las acciones coinciden con los métodos de Tab descritos abajo.
`await tab.ax.get(mode = 'state', {disableDiffing?})` devuelve texto, bytes de imagen o `{state, screenshot?}` para `state`, `screenshot` o `both`, sin emitir.
`await tab.ax.write(mode = 'state', options?)` emite los resultados disponibles y devuelve undefined. Los métodos planos existentes en Tab siguen disponibles.
La fachada AX y los métodos planos actúan sobre el mismo Tab vinculado.

Observaciones de App y Tab:
- `getAXState({emit?, disableDiffing?})` devuelve texto. Las pestañas y las aplicaciones de macOS usan un diff por defecto; las aplicaciones de Windows y Linux devuelven el estado completo.
- `getScreenshot({emit?})` devuelve Uint8Array y emite la imagen.
- `getAXStateAndScreenshot(options?)` devuelve `{state, screenshot?}` y emite los resultados disponibles.
El descubrimiento, la selección y las observaciones emiten automáticamente. Llámalos directamente; envolver `getScreenshot()` en `nodeRepl.emitImage()` o `getAXState()` en `nodeRepl.write()` es redundante. Usa `{emit:false}` cuando proceses el resultado por tu cuenta; los errores de inventario seguirán apareciendo. Los métodos nativos de captura de pantalla en Windows rechazan `{emit:false}` antes de capturar. Las imágenes idénticas emitidas dentro de una misma llamada se entregan una sola vez; una llamada posterior puede volver a emitir la misma imagen.
Las observaciones incluyen una ventana acotada de estabilización para breves actualizaciones de la interfaz (200 ms para pestañas, 400 ms para aplicaciones). Esto no espera trabajo asíncrono arbitrario; la animación continua no amplía la ventana. Actualiza para observar cambios posteriores.
Una captura de pantalla exitosa del mismo documento de navegador sin cambios conserva las referencias AX existentes. Tras una navegación, reemplazo de documento o invalidación del objetivo, actualiza `getAXState()` antes de reutilizar índices; actualízalo también para elementos recién observados. Linux y Windows nativos conservan las identidades de elementos observados previamente mientras esos mismos elementos sigan siendo válidos.
Si una observación AX nativa falla mientras una aplicación está ocupada, vuelve a actualizar el mismo objeto vinculado cuando la aplicación responda de nuevo. Las observaciones fallidas invalidan los índices y coordenadas anteriores.

Acciones de App y Tab:
- `await app.bringToFront()` activa de forma persistente la ventana nativa exacta vinculada. No envía entrada de teclado ni de puntero e informa un resultado desconocido si el escritorio no puede confirmar la activación.
- `click(index | [x,y], {mouseButton?, clickCount?})`, `drag([x,y], [x,y])`.
- `scroll(index | [x,y], "up" | "down" | "left" | "right", distance?)`.
- Las aplicaciones nativas también aceptan los botones del mouse `l/r/m` y las direcciones `u/d/l/r`. macOS recorta espacios e ignora mayúsculas/minúsculas en estos nombres, y también acepta los botones `0/1/2` para izquierdo/derecho/central.
- `setValue(index, string)`; no disponible para aplicaciones nativas de Linux.
- `selectText(index, text, {prefix?, suffix?, selectionType?})`, donde `selectionType` es `text`, `cursor_before` o `cursor_after`. La selección nativa solo existe en macOS. `text_not_found` indica que el texto o el contexto proporcionado no están presentes; vuelve a leer el estado actual. `ambiguous_text` requiere un prefijo/sufijo más específico.
- `performSecondaryAction(index, action)`: usa una acción exacta listada en la observación AX nativa. CDP no expone acciones secundarias y rechaza este método.

Entrada en App: `typeText(text)`, `paste(text, {format?})`, `pressKey(key)`.
Entrada en Tab: `typeText(index|null, text)`, `paste(index|null, text, {format?})`, `pressKey(index|null, key)`. Si se proporciona un índice, primero enfoca el campo observado. Usa `null` para el foco actual. Ejemplos de teclas: `Return`, `Tab`, `super+a`, `shift+Left`.
Formatos de pegado: `text` (por defecto), `md` (fuente Markdown como texto sin formato) y `html`.
Las aplicaciones nativas de Linux y Windows solo admiten `text`.
El pegado HTML nativo es exclusivo de macOS y requiere un valor editable legible y una selección. Activa temporalmente la ventana exacta, conserva su selección y restaura el portapapeles anterior salvo que el usuario haya copiado algo más reciente. Un valor sin cambios se informa como incierto.
El pegado HTML en navegador requiere un elemento contenteditable observado.

Navegación en Tab: `goto(url)`, `back()`, `forward()`, `reload()`, `close()`.
`await tab.screenshot({ fullPage: false, clip: { x, y, width, height } })` devuelve bytes JPEG sin emitir una imagen. Omite `clip` para el viewport; `fullPage: true` captura el documento completo. El ancho y el alto de `clip` deben ser positivos. Las coordenadas y dimensiones usan píxeles CSS. La captura de viewport intenta primero un fotograma reciente de screencast y luego el comando de captura de la misma pestaña tras una limpieza confirmada; las operaciones inciertas no se repiten.

En proveedores de extensión, `await tab.markDeliverable()` mantiene abierta la pestaña al finalizar un turno normal y la libera al usuario. `await tab.markHandoff()` retiene la pestaña para esta misma sesión; el siguiente turno real la retoma sin marca. Se preserva el origen original de agente/usuario, de modo que una pestaña creada por el agente se cierra al final de un turno posterior sin marca. Una marca explícita posterior reemplaza la anterior. Ambos métodos devuelven undefined tras recibir el ACK de intención correspondiente, lo cual no demuestra entrega física ni limpieza. Las marcas no retienen permisos de sitio; una llamada incierta no se repite. CDP directo no admite estas marcas.

`tab.clipboard` proporciona `read()`, `readText()`, `write(items)` y `writeText(text)`. Estos métodos devuelven valores sin emitirlos. Un elemento enriquecido tiene un arreglo `entries` no vacío; cada entrada tiene `mimeType` y exactamente un campo de cadena, `text` o `base64`. El campo opcional `presentationStyle` es `unspecified`, `inline` o `attachment`. Por ejemplo: `await tab.clipboard.write([{entries:[{mimeType:'text/plain',text:'Hello'}]}])`.
Estos datos virtuales se comparten entre pestañas que usan el mismo contexto de backend configurado; no leen ni modifican el portapapeles del sistema operativo. Las páginas autorizadas usan los mismos datos a través de su Clipboard API una vez instalada. `readText()` del agente devuelve el texto de la primera entrada exacta `text/plain`, o una cadena vacía para una entrada solo `base64`; el `readText()` de la página decodifica esa entrada mediante un Blob. La limpieza del turno elimina los puentes de página y conserva los datos almacenados. Restablecer crea un nuevo contexto vacío.

Los métodos de espera devuelven undefined. `locator.waitFor({state, timeoutMs?})` requiere `state: 'attached'|'detached'|'visible'|'hidden'` y evalúa la primera coincidencia; ninguna coincidencia satisface `detached` y `hidden`.
`tab.playwright.waitForURL(pattern, {waitUntil?, timeoutMs?})` coincide con la URL completa: `*` permanece dentro de un segmento delimitado por barras, `**` puede cruzar barras y los demás caracteres son literales. El `waitUntil` por defecto es `commit`; `load`, `domcontentloaded` y `networkidle` esperan ese estado tras la coincidencia.
`tab.playwright.waitForLoadState({state?, timeoutMs?})` usa `load` por defecto y también acepta `domcontentloaded` y `networkidle`. Estas esperas condicionales usan 3000 ms por defecto y respetan tiempos límite explícitos mayores. Cero no deja presupuesto de espera de eventos: un localizador aún realiza su primera comprobación, la URL o estado de carga actual ya puede coincidir y `networkidle` agota el tiempo. `tab.playwright.waitForTimeout(ms)` acepta un entero no negativo y espera una duración fija. Para una espera activada por una acción, inicia la espera antes de la acción y luego espera ambas promesas con `await`. Detener (Stop) cancela la espera original.

`tab.playwright` resuelve localizadores DOM sin requerir una observación AX previa. Usa `locator(selector)`, `getByRole`, `getByText`, `getByLabel`, `getByPlaceholder` o `getByTestId`; `frameLocator(selector)` entra en un frame. Los localizadores admiten `first/last/nth`, `filter`, `and/or`, `count`, `all`, `allTextContents`, `textContent`, `innerText`, `getAttribute`, `isEnabled` e `isVisible`.
`domSnapshot()` devuelve el texto de accesibilidad DOM de la página.

Los métodos de entrada de localizador devuelven undefined: `click(options?)`, `dblclick(options?)`, `fill(text, options?)`, `type(text, options?)`, `press(key, options?)`, `pressSequentially(text, options?)`, `selectOption(valueOrValues, options?)`, `setChecked(boolean, options?)`, `check(options?)` y `uncheck(options?)`.
Las opciones de clic aceptan `button: 'left'|'right'|'middle'`, `modifiers`, `force` y `timeoutMs`; las opciones de marcado aceptan `force` y `timeoutMs`. Los modificadores son `Alt`, `Control`, `ControlOrMeta`, `Meta` y `Shift`; `ControlOrMeta` usa la plataforma del navegador seleccionado. Otras opciones de entrada aceptan `timeoutMs`. Los tiempos límite son enteros positivos; la preparación usa 3000 ms por defecto y respeta tiempos límite explícitos mayores. La selección de opciones acepta una cadena de valor o un descriptor con `value`, `label` o un `index` entero no negativo; los arreglos seleccionan varias opciones.

Las mutaciones de localizador usan una coincidencia única o la única coincidencia visible. Las coincidencias ambiguas lanzan error. El relleno o escritura de texto común (`fill`/`type`) usa un evento de pegado virtual, respeta la cancelación de un manejador de la página y preserva el portapapeles almacenado. Un pegado vacío no borra un valor por defecto. Los atajos de teclado del portapapeles usan el mismo portapapeles virtual; las combinaciones no admitidas lanzan error antes de enviar teclas nativas. Las escrituras exitosas limpian únicamente las lecturas en caché de la colección de localizadores que realizó la llamada. Los resultados de entrada deben seguir verificándose en la página; un resultado incierto no se repite automáticamente.

Las descargas usan un proveedor de extensión conectado con notificaciones de descarga y permiso de descarga actual del Host. Prepara la espera antes de disparar la acción en la misma pestaña:
`const pending = tab.playwright.waitForEvent('download', {timeoutMs:3000});`
luego realiza el clic o la navegación y ejecuta `const download = await pending`.
`await download.path({timeoutMs?})` devuelve el nombre de archivo informado por el navegador o null. No transfiere un archivo ni demuestra que una ruta pertenezca a esta tarea; puede ser una ruta en otro host, estar vacía o no estar disponible. No tiene operación `saveAs`.
`await tab.playwright.locator(selector).downloadMedia({timeoutMs?})` solicita contenido multimedia para un localizador con coincidencia única. Las esperas de descarga devuelven datos sin emitirlos; los disparadores de multimedia devuelven undefined. El plazo nativo de inicio termina en el primer evento Started coincidente; la cancelación y la limpieza del Host siguen aplicándose después.
El permiso de lectura y el permiso de descarga son independientes, incluso para un origen de fuente o destino diferente. Una conexión CDP configurada por sí sola no proporciona notificaciones nativas de descarga.
Maka también expone `tab.cua.downloadMedia({x,y,timeoutMs?})` y `tab.dom_cua.downloadMedia({node_id,timeoutMs?})` como extensiones acotadas. Los proveedores de extensión seleccionados rechazan actualmente estos comandos multimedia por coordenadas o nodo; usa la ruta de localizador implementada. Un resultado de descarga incierto nunca se reintenta automáticamente.
El handle devuelto conserva su vinculación original de Tab, no una concesión de permiso. Mantén disponible esa pestaña: `path()` vuelve a comprobar los metadatos actuales de la pestaña y los permisos del Host antes de consultar la caché. Un handle obsoleto no puede mantener viva una pestaña cerrada. Los turnos posteriores siguen requiriendo acceso actual a la pestaña; puede ser necesario volver a reclamarla.

`await tab.getJsDialog()` devuelve undefined o el objeto de diálogo actual con `type` y `dismiss()`. Los diálogos de confirmación también tienen `accept()`; los diálogos de entrada (prompt) tienen `accept(text)`, incluida una cadena vacía. Los objetos de diálogo anteriores no pueden actuar sobre un diálogo nuevo que los haya reemplazado. Atiende cualquier diálogo activo antes de realizar lecturas o entradas normales de página.
`getAXState()` muestra su mensaje y controles indexados; los controles de prompt admiten `setValue`, `typeText` y Return/Escape. Los controles de diálogo no tienen coordenadas de página.
Las capturas de pantalla no están disponibles mientras un diálogo está abierto: las llamadas solo de captura lanzan error y las observaciones combinadas devuelven el estado del diálogo sin la propiedad `screenshot`.
Un Host de navegador adjunto acepta automáticamente los diálogos `beforeunload` mientras posee el control actual. La limpieza del turno desvincula el control sin cerrar las pestañas del usuario.

La navegación admite HTTP(S) y `about:blank` y espera hasta obtener un documento observable.
El objetivo CDP principal está cubierto; la accesibilidad de iframes entre procesos no es completa.
Las distancias de página en CDP aceptan números finitos, incluidos decimales, cero y valores negativos. Una página usa el ancho o alto del contenido del objetivo, con un mínimo de 100 píxeles CSS; los objetivos por coordenadas usan el viewport. La extensión `{pixels:n}` de CDP acepta incrementos de píxeles finitos positivos.
Linux rechaza cantidades numéricas de páginas. Linux X11 usa por defecto `{pixels:800}` y acepta distancias enteras en píxeles de 1 a 65535. Envía `max(round(pixels/100),1)` pasos de rueda; la aplicación determina el desplazamiento real del contenido. Linux Wayland rechaza actualmente la entrada en píxeles.
El desplazamiento en macOS acepta cantidades numéricas finitas positivas de páginas, con valor por defecto 1, y rechaza `{pixels}`. Se admiten cantidades fraccionarias de páginas.
Windows requiere un punto de coordenadas y una distancia finita positiva `{pixels:500}`; se rechazan las distancias omitidas y las cantidades numéricas de páginas. Las coordenadas y las distancias con signo de dirección usan `Math.round` de JavaScript; las entradas redondeadas deben caber en enteros con signo de 32 bits. Los incrementos nativos de rueda están acotados por eje a [-32768,32767] y el puntero permanece en el objetivo. La aplicación determina el movimiento del contenido. El desplazamiento nativo indexado conserva el objetivo de accesibilidad seleccionado. Los clics nativos indexados del envoltorio App admiten un solo clic semántico; usa coordenadas de captura de pantalla para clics múltiples. El `cua.computer.click` nativo directo de macOS también admite clics indexados múltiples mediante eventos de mouse simulados.

Un envío de entrada exitoso no demuestra el estado resultante de la aplicación.
Las acciones por coordenadas en navegador usan coordenadas de viewport CSS y no requieren captura de pantalla. Las capturas no escalan estas coordenadas.
Las coordenadas locales de ventana en Linux pueden usarse sin tomar una captura. Los mapeos nativos de captura en Linux y Windows sobreviven a las acciones de entrada hasta que otra observación los reemplaza; una observación solo AX borra el mapeo de imagen. En Windows, la entrada por coordenadas requerirá entonces otra captura. Un cambio en la geometría de la ventana invalida el mapeo almacenado. La entrada por coordenadas en macOS requiere actualmente una nueva captura después de cada acción.
Las acciones semánticas nativas usan elementos de accesibilidad retenidos. Los menús de aplicación están acotados a su proceso propietario y a la ventana exacta vinculada; el contenido de los menús cerrados se omite hasta abrir el menú. Interactuar con un menú puede activar la ventana vinculada y la mantiene activa mientras el menú esté abierto.
La entrada nativa por coordenadas y teclado se entrega por defecto en segundo plano a la ventana exacta vinculada. La entrega en segundo plano no admitida se informa como error; la entrada no se repite automáticamente en primer plano. Es posible que efectos no verificados ya se hayan entregado.
Prefiere las operaciones de Tab del navegador para sitios web: evitan el foco del escritorio y la entrada del puntero. Para entrada de texto nativa prefiere `typeText` o `setValue`; `paste` en macOS usa el portapapeles del sistema y entrada de teclado en primer plano. Los menús nativos pueden activar su ventana. Algunas rutas por coordenadas pueden mover el puntero del sistema; los metadatos de entrega informan la ruta real. Los métodos nativos `app.pressKey(key, {deliveryMode:"foreground"})` y `app.typeText(text, {deliveryMode:"foreground"})` solicitan explícitamente una ruta en primer plano cuando sea necesario; el valor por defecto es `"background"`. No reintentes automáticamente una entrada no verificada ni cambies de modo silenciosamente.

`nodeRepl.write(value)` emite texto/JSON. `await nodeRepl.emitImage(bytes | dataUrl | {bytes, mimeType})` emite una imagen. Las URL de imagen de archivo/HTTP, Node y las API arbitrarias del sistema de archivos y red no están disponibles. `cua.rewriteDocumentation()` vuelve a imprimir esta referencia.

Cuando el Host habilita el audio de salida, `await cua.computer.start_audio_recording({max_duration_ms?})` inicia la grabación y devuelve undefined mientras otras llamadas pueden continuar. La duración por defecto es 60000 ms y acepta enteros de 100 a 300000. `await cua.computer.stop_audio_recording()` devuelve `{filepath, bytes, data_url}` para el WAV PCM16 estéreo a 24 kHz finalizado. Alcanzar la duración finaliza la captura; llama a stop para recuperarla. `await nodeRepl.emitAudio(bytes | dataUrl | {bytes, mimeType})` emite audio explícitamente. Estos métodos no existen cuando el audio está deshabilitado. El restablecimiento y la limpieza de sesión descartan las grabaciones y sus rutas locales.

Cada operación usa los permisos actuales del Host; los objetos JS no conservan autorizaciones.
Con el sandbox de sesión desactivado, Computer Use, las aplicaciones, los sitios del navegador, el historial, las transferencias de archivos y el audio no requieren aprobación adicional de Maka. Cambiar los permisos o detener la operación actual sigue surtiendo efecto.
En modo Ask, la aprobación de Computer Use ocurre antes de que empiece el tiempo límite de ejecución del REPL.
Las esperas de consentimiento para aplicaciones, sitios del navegador y audio pausan el presupuesto restante. Las esperas nativas de macOS/Windows también lo pausan; las esperas asíncronas normales y las operaciones nativas de Linux lo consumen. Pausar nunca rellena el presupuesto ni deshabilita la cancelación.
Las operaciones nativas de macOS informan `desktop_locked` mientras la pantalla está bloqueada; los proveedores CDP conectados y los cálculos puros del REPL siguen disponibles de forma independiente.
Cada sesión tiene su propio cursor de Maka. Las acciones de entrada lo muestran automáticamente.
`cua.cursor.configure({label?, color?, enabled?, reducedMotion?})` cambia la visualización de esta sesión. Los colores son `blue`, `mint`, `violet`, `amber`, `rose`, `cyan`; las etiquetas permiten hasta 48 caracteres. `cua.cursor.getState()` informa la configuración y la visibilidad nativa/del navegador. Un renderizador nativo en estado `idle` se inicia en la primera indicación nativa; `unavailable` informa un host de pantalla ausente o con fallo. Vuelve a configurar para reintentar un renderizador fallido. El cursor pertenece a la sesión pero no permanece en pantalla después de un turno: se muestra durante el turno, se oculta cuando el turno termina y reaparece en la siguiente acción de entrada.
Los cursores no comparten autoridad de entrada ni mueven el puntero del sistema. Varios cursores no aíslan el teclado físico, el foco de la aplicación ni el método de entrada.
Los REPL cancelados, con tiempo agotado o con memoria heap agotada requieren `cua_reset` y luego volver a vincular los objetivos. El trabajo nativo admitido se completa antes de regresar; restablecer no deshace entradas ya enviadas.
Al finalizar un turno normal, esta sesión cierra las pestañas temporales sin marca que creó y libera sus observaciones de página. Las pestañas de usuario preexistentes y las pestañas marcadas para retención permanecen abiertas según las reglas anteriores. Restablecer limpia el REPL y las vinculaciones de esta sesión; no otorga nuevos accesos ni borra los recursos retenidos ni las obligaciones de limpieza de esta sesión. Una marca o cierre sin confirmar conserva la custodia y no se repite.

La misma colección de navegadores está disponible como `agent.browsers` y `cua.browsers`.
Sus métodos `list`, `get(id)`, `getDefault` y `getForUrl(url)` devuelven metadatos u objetos Browser diferidos sin emitir una observación. `cua.getBrowser` es el punto de entrada conveniente que emite documentación. Un objeto Browser expone `tabs.selected()` para la pestaña activa de su sesión lógica; esto no selecciona la pestaña con foco del sistema operativo.
El proveedor CDP directo actual no dispone de servicio de pestaña activa de sesión lógica y devuelve `undefined` desde `selected()`.

`await browser.release()` devuelve la concesión bajo demanda del navegador ChatGPT de esta sesión. Liquida las pestañas temporales de este turno y los recursos de control físico antes de liberar el host; las páginas retenidas permanecen abiertas. Otras sesiones conservan sus propias concesiones. La última liberación restaura el host nativo original. Vuelve a adquirirlo con `cua.getBrowser({id: "chatgpt"})` antes de seguir usándolo; los handles de una generación de host retirada requieren una nueva conexión. La limpieza normal de turno también libera la concesión. Los agentes de larga ejecución deben liberarlo antes de suspenderse. Otros proveedores de navegador no admiten esta operación.

`await browser.nameSession(name)` recorta espacios y guarda el título del grupo administrado de la sesión. La presentación administrada existente se actualiza mediante sus recibos propios; las pestañas creadas en el futuro usan el título almacenado. `cua.createBrowserTab(id, url, {sessionName})` resuelve el navegador y espera el nombrado antes de crear la pestaña. El perfil actual del navegador no ofrece la capacidad de visibilidad (`visibility`).

`await browser.history({queries, limit, from, to})` lee el historial de todo el perfil mediante una extensión que anuncia el transporte de historial separado. Con el sandbox habilitado, requiere un consentimiento independiente de `browser_history` para el ID real del navegador y su generación bajo el límite de permisos actual de la sesión. Los permisos de página y descarga no lo autorizan. Ninguna solicitud de historial se concede automáticamente por política de origen de página.
El valor por defecto es una consulta de todo el historial limitada a 100 entradas; los resultados de consultas proporcionadas se combinan por fecha de visita descendente, se deduplican por URL y luego se limitan.
La extensión Maka incluida declara el permiso history de Chrome; una extensión instalada más antigua sin ese permiso no anuncia compatibilidad con historial. ChatGPT y otros adaptadores de terceros siguen siendo de mejor esfuerzo.

- `await browser.user.getTabContext(tabOrId)` lee el contexto de una pestaña de usuario actualmente visible sin reclamarla ni enfocarla. El Host autoriza la URL actual de la pestaña; el llamador no puede proporcionar una URL de reemplazo. Las pestañas privadas y una URL que cambie durante una lectura individual se rechazan. El resultado es `{kind:'text',text,title,url,truncated}` o `{kind:'document',data,fileName,mimeType,title,url}`, donde `data` es un `Uint8Array` que contiene el archivo exportado real. Cuando el Host proporciona publicación de archivos, los documentos también incluyen una `path` real propiedad de la sesión. Los documentos de Google Workspace pueden proporcionar contexto en Markdown, PDF o XLSX; las páginas normales pueden incluir la selección actual y las páginas de visualización de YouTube pueden incluir una transcripción. El proveedor `maka` implementa las lecturas fijas; `chatgpt` reutiliza su protocolo de lectura estándar cuando es compatible. El soporte de terceros sigue siendo de mejor esfuerzo.

- `await tab.playwright.evaluate(pageFunction, arg?, {timeoutMs}?)` evalúa una función autocontenida en la página actual. Una cadena se trata como expresión. Las variantes de localizador pasan `(element, arg)` a `locator.evaluate` o `(elements, arg)` a `locator.evaluateAll`; la forma de elemento único requiere un objetivo inequívoco y la forma de todos los elementos acepta una coincidencia vacía.
  Los argumentos deben ser serializables a JSON. Los resultados son datos planos; las funciones y símbolos se omiten, los enteros grandes (BigInt) se convierten en cadenas y los números no finitos se convierten en `null`. Esta API limita la profundidad del resultado a 8, los arreglos a 2000 entradas, los objetos a 200 claves y las cadenas a 200000 unidades UTF-16, con los marcadores `[MaxDepth]`, `[Circular]` y `[Truncated]` cuando corresponda.
- La evaluación expone vistas de solo lectura de DOM, CSS, geometría, rangos y selección. No expone red, cookies, carga de módulos ni edición del DOM. El desplazamiento, los límites de rango locales y los temporizadores solo con funciones siguen siendo operaciones admitidas.
  El tiempo límite por defecto es 3000 ms; los valores explícitos fijan la duración solicitada. Un script detenido o interrumpido puede haberse ejecutado ya; no se vuelve a ejecutar automáticamente. Siguen aplicándose los permisos de sitio existentes y la propiedad de la pestaña.

La entrada de puntero en el navegador está disponible mediante `tab.cua.move({x,y,keys?})`, `click({x,y,button?,keypress?})`, `double_click({x,y,keypress?})`, `drag({path:[{x,y},...],keys?})` y `scroll({x,y,scrollX,scrollY,keypress?})`. Las coordenadas y distancias son números de viewport CSS y conservan valores fraccionarios y negativos; los botones son 1 (izquierdo), 2 (central) o 3 (derecho). Los nombres de modificadores de puntero son Alt, Control, Meta, Shift y ControlOrMeta. `tab.cua.keypress({keys:[...]})` envía una combinación de teclas al foco actual; `tab.cua.type({text})` pega texto en el foco actual mediante el portapapeles virtual del navegador, conservando los datos almacenados en el portapapeles. El texto puede incluir Markdown; Google Sheets recibe texto sin formato. Estos métodos de entrada devuelven undefined y no reintentan una entrada incierta.

`await tab.dom_cua.get_visible_dom()` devuelve HTML interactivo visible con valores de cadena `node_id`. Usa esas cadenas exactas con `click({node_id})` o `double_click({node_id})`; `scroll({node_id?,x,y})` recibe distancias de desplazamiento y usa el centro del viewport cuando se omite `node_id`. `keypress({keys:[...]})` y `type({text})` usan el foco actual, no un ID de nodo. Los métodos DOM devuelven undefined excepto la instantánea. Una nueva instantánea retira los nodos DOM ausentes; la navegación o el reemplazo de frames puede volver obsoleto un nodo. Vuelve a observar en lugar de adivinar un ID o repetir una entrada cuyo resultado sea desconocido.

<!-- named-browser-documents -->
<!-- browser-document: bootstrap-troubleshooting chrome-troubleshooting browser-troubleshooting -->
# Solución de problemas del navegador
Lee `cua.getState()` y `agent.browsers.list()` para identificar el navegador disponible y su ID exacto. Una conexión configurada no prueba que una acción específica haya tenido éxito. Cuando una vinculación esté obsoleta o su resultado sea desconocido, inspecciona el estado actual antes de elegir la siguiente operación; una mutación incierta no debe repetirse automáticamente.
<!-- /browser-document -->
<!-- browser-document: browser-safety confirmations -->
# Autoridad del navegador
Una vinculación de navegador no conserva permisos. Las operaciones usan la sesión actual, el turno, la política del espacio de trabajo y el origen de la página. El consentimiento para leer una página no autoriza transferencias de archivos ni el historial de todo el perfil. Una aprobación rechazada, una sesión cerrada o un límite de permisos modificado deben atenderse antes de continuar.
<!-- /browser-document -->
<!-- browser-document: visibility capabilities/browser/visibility -->
# Visibilidad del navegador
Lee `browser.capabilities.list()` para determinar si este navegador publica la capacidad de visibilidad. Un nombre de documentación no es prueba de que la capacidad esté habilitada. Cuando la visibilidad no está presente, pasar una opción `visible` al crear una pestaña se rechaza antes de crearla.
<!-- /browser-document -->
<!-- browser-document: session-naming -->
# Nombrado de sesión
`await browser.nameSession(name)` asigna un título recortado y no vacío al grupo de pestañas administrado de esta sesión de navegador y a las pestañas que se creen en el futuro. `cua.createBrowserTab(id, url, {sessionName})` espera ese paso de nombrado antes de crear una pestaña; un error al nombrar no crea la pestaña.
<!-- /browser-document -->
<!-- browser-document: tab-claiming-chrome -->
# Pestañas del usuario
`browser.user.openTabs()` devuelve metadatos de las pestañas del usuario sin reclamarlas. `browser.user.claimTab(listedTabOrId)` adquiere explícitamente la pestaña exacta elegida. `browser.tabs.get(id)` devuelve una vinculación diferida y no constituye una reclamación implícita de una pestaña arbitraria del usuario. Las pestañas del usuario se liberan en lugar de cerrarse durante la limpieza del turno.
<!-- /browser-document -->
<!-- browser-document: tab-cleanup-chrome -->
# Ciclo de vida de pestañas administradas
Las pestañas creadas son temporales salvo que su ciclo de vida actual las retenga explícitamente. `markDeliverable()` conserva un resultado terminado para el usuario; `markHandoff()` retiene una pestaña para continuar dentro de la misma sesión. Estas marcas no conservan permisos de página antiguos ni autorizan a otra sesión. El cierre, la detención y los efectos inciertos conservan sus propios requisitos de limpieza.
<!-- /browser-document -->
<!-- browser-document: tab-mentions-iab tab-cleanup-iab capabilities/browser/management -->
# Disponibilidad de backends de navegador
El conjunto actual de proveedores de Maka contiene extensiones de navegador y conexiones CDP configuradas; no añade un backend de navegador integrado. Vincula navegadores y pestañas usando los ID del inventario actual. Leer una referencia sobre un backend integrado o una capacidad de administración no crea ese backend ni otorga autoridad de administración del navegador.
<!-- /browser-document -->
<!-- browser-document: browser-control-interruption -->
# Operaciones interrumpidas
La cancelación no es prueba de que una operación enviada se haya revertido. Conserva la vinculación original y el resultado de la operación hasta que se estabilicen; no repitas una mutación mediante otro proveedor. Un restablecimiento limpia las vinculaciones del REPL y el trabajo posterior debe volver a vincular los objetivos bajo los permisos actuales.
<!-- /browser-document -->
<!-- browser-document: api-use-behavior -->
# Uso de la API del navegador
`agent.browsers` y `cua.browsers` comparten la misma colección. Las llamadas de colección devuelven datos o vinculaciones diferidas sin emitir una observación. `agent.documentation.get(name)` lee un documento exacto por nombre y devuelve una Promise con su texto sin emitirlo. `tabs.selected()` sigue la actividad lógica de la sesión. Los ID exactos de navegador y las vinculaciones de pestañas existentes no cambian de proveedor.
<!-- /browser-document -->
<!-- browser-document: accessibility -->
# Observaciones de accesibilidad
Lee un estado de accesibilidad actualizado antes de usar sus referencias de elementos. `tab.ax` expone las operaciones de accesibilidad documentadas y `get(mode, options)` devuelve el estado, bytes de captura de pantalla o ambos sin emisión automática. La navegación o un cambio de documento puede invalidar referencias observadas previamente; actualiza la observación en lugar de adivinar un índice.
<!-- /browser-document -->
<!-- browser-document: webmcp capabilities/tab/cdp capabilities/tab/botDetection capabilities/tab/browserAuth -->
# Capacidades opcionales del navegador
Lee la colección de capacidades del objeto seleccionado antes de usar una capacidad opcional. Una referencia documental no habilita API de CDP sin procesar, WebMCP, autenticación ni manejo de desafíos. Si su ID no aparece en esa colección, la capacidad no está disponible; las operaciones de página existentes mantienen sus comprobaciones normales de permisos y ciclo de vida.
<!-- /browser-document -->
<!-- browser-document: local-web-development -->
# Páginas de desarrollo local
Elige un navegador que pueda alcanzar la URL de desarrollo prevista y navega a esa URL explícita. Un nombre de host local sigue sujeto a la política de red actual del espacio de trabajo y a la autorización de origen de página. Conserva la vinculación del navegador seleccionado mientras revisas la página; el localhost de otra máquina es un destino diferente.
<!-- /browser-document -->
<!-- browser-document: file-uploads chrome-file-upload-troubleshooting -->
# Subida de archivos
Usa operaciones de subida solo cuando la documentación del navegador seleccionado las exponga. Una subida necesita su propio permiso actual para la página y los archivos elegidos; una concesión de lectura de página o de descarga no es consentimiento de subida. Un selector de archivos pertenece a la interacción exacta de página que lo abrió. Si esa página o selector ya no es actual, comienza con una nueva observación en lugar de reutilizar un selector antiguo.
<!-- /browser-document -->
<!-- browser-document: screenshots -->
# Capturas de pantalla
`tab.getScreenshot()` devuelve los bytes de la captura; los ayudantes de observación pueden emitir la imagen. Usa una captura reciente tras navegar, redimensionar o desplazar antes de decidir coordenadas. Una captura de pantalla es una observación, no una prueba de que la entrada anterior haya llegado al control deseado.
<!-- /browser-document -->
<!-- browser-document: capabilities/browser/viewport -->
# Capacidad de viewport
Lee `browser.capabilities.list()` y obtén la capacidad de viewport publicada antes de cambiar el tamaño. Los ajustes de viewport siguen a la pestaña activa lógica de la sesión del navegador y a su ciclo de vida actual. Cambiar el tamaño del viewport no selecciona una pestaña no relacionada con foco del sistema operativo ni otorga acceso a la página.
<!-- /browser-document -->
<!-- browser-document: capabilities/tab/pageAssets -->
# Capacidad de recursos de página
Usa recursos de página solo cuando la pestaña seleccionada publique esa capacidad. El inventario de recursos pertenece a la página y al documento observados. Tras navegar o reemplazar el documento, obtén un nuevo inventario; los identificadores de recursos antiguos no pueden autorizar archivos de otra página. Guardar archivos requiere el permiso actual de transferencia de archivos de la operación.
<!-- /browser-document -->

### Selectores de archivos y subidas

```js
const pending = tab.playwright.waitForEvent('filechooser', { timeoutMs: 3000 });
await tab.playwright.getByRole('button', { name: 'Upload' }).click();
const chooser = await pending;
chooser.isMultiple();
await chooser.setFiles(['workspace-file.bin']);
```

Inicia la espera antes de la acción que abre el selector. La espera por defecto del evento de selector es de 3000 ms; un tiempo límite explícito debe ser un entero positivo. `isMultiple()` es síncrono. `setFiles(pathOrPaths, {timeoutMs})` acepta una ruta o un arreglo no vacío; un selector de archivo único rechaza múltiples rutas. Su tiempo límite opcional se valida sin descartar una selección en curso.

Las rutas se refieren al sistema de archivos del Agent Host y siguen sujetas a la política de archivos del espacio de trabajo del llamador. El acceso a la página, el consentimiento de subida para el origen HTTP(S) actual y el permiso de lectura de archivos son independientes. La instantánea de entrada admitida es un archivo regular. Los archivos se transportan como bytes inmutables y los materializa el host de navegador de Maka seleccionado; no traduzcas rutas entre sistemas operativos por tu cuenta.

Los handles de selector pertenecen a la pestaña, documento y turno que los emitieron. No se admiten selectores de objetivos secundarios (child-target). Los selectores de extensión requieren procedencia completa del evento de origen; las subidas requieren además colocación verificada de archivos en el host del navegador. Chatgpt es de mejor esfuerzo, y el CDP configurado sin esa colocación rechaza la subida antes de enviar archivos. Una pestaña vinculada existente nunca se reemplaza por otro navegador para satisfacer la operación. Una selección exitosa consume el selector. Un resultado desconocido debe conciliarse en lugar de repetirse.

Si la limpieza informa un resultado no confirmado, no asumas que los datos copiados de subida se hayan eliminado. Aún no está disponible la recuperación automática después de que el host del navegador salga mientras los archivos siguen seleccionados.
