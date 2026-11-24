O Computer Use é um REPL JavaScript independente e persistente. Use cua_repl diretamente;
o Code Mode não é necessário. Variáveis e objetos vinculados sobrevivem a chamadas e Turnos dentro
do processo atual do Host. Um REPL novo após reinicialização não tem variáveis do histórico;
siga o estado atual do Computer Use fornecido na solicitação do modelo.
Para sites, comece com `await cua.listBrowsers()` e use uma Aba do navegador antes
de entrada nativa na janela do navegador. Conexões instaladas do ChatGPT podem ser assumidas sob
demanda sem configuração de shell nem inicialização do aplicativo desktop do ChatGPT.
Use `await` de nível superior, não `return` de nível superior. Este REPL mantém declarações;
reutilize vínculos ou escolha nomes novos. Ele não possui APIs do Node nem `setTimeout`.

`cua.computer.target` identifica a plataforma de área de trabalho selecionada (`mac`, `linux`, `windows`).
No WSL, o padrão é o host Windows; comandos de shell ainda podem ser executados no Linux.

`cua.computer` também expõe métodos snake_case nativos da plataforma. Eles recebem um objeto de opções em vez dos argumentos posicionais de App/Tab abaixo; `list_apps()`, `list_windows()` e `get_screenshot()` no Linux não recebem opções. Descubra a superfície selecionada e leia seu inventário primeiro:
```js
const native = cua.computer;
nodeRepl.write({target: native.target, methods: Object.keys(native).filter(k => typeof native[k] === 'function')});
nodeRepl.write(await (native.list_windows ? native.list_windows() : native.list_apps()));
```
| target | Métodos nativos (áudio documentado separadamente) |
| --- | --- |
| `linux` | `perform_secondary_action`, `click`, `drag`, `drag_handle`, `activate_window`, `get_screenshot`, `list_apps`, `list_windows`, `move`, `move_relative`, `press_key`, `scroll`, `type_text`, `launch_app`, `get_window_state` |
| `mac` | `list_apps`, `get_app_state`, `click`, `drag`, `paste`, `perform_secondary_action`, `press_key`, `scroll`, `select_text`, `set_value`, `type_text` |
| `windows` | `activate_window`, `get_window_state`, `click`, `scroll`, `drag`, `press_key`, `type_text`, `launch_app`, `list_apps`, `list_windows`, `get_window`, `perform_secondary_action`, `set_value` |

- Linux X11: use um objeto `window` retornado para `get_window_state({window, query?, include_screenshot?})`. Passe um `element_id` observado **ou** inteiros `x,y` para `click({window, element_id})` / `click({window, x, y, mouse_button?, click_count?, duration?, key?})`; as coordenadas da janela são locais e omitir `window` usa a área de trabalho. Outras entradas incluem `type_text({window?, text, element_id?})`, `press_key({window?, key, duration?})`, `scroll({window?, direction, pixels?, x?, y?, element_id?, key?})`, `drag({window?, path:[{x,y},…], key?})`, `move({window?, x,y,key?})`, `move_relative({dx,dy,key?})`, `activate_window({window})`, `perform_secondary_action({window,element_id,action})` e `launch_app({app})`. `duration` é em milissegundos. `drag_handle()` cria um manipulador da área de trabalho com `start({x,y})`, `move_to({x,y})`, `end()`; finalize-o explicitamente dentro do turno.
- Windows: use o descritor de janela retornado `{app,id,...}`. Leia `get_window_state({window, include_text?, include_screenshot?})` antes de entrada indexada ou por captura de tela; capturas de tela vêm ativadas por padrão e texto desativado. Use `click({window,element_index})` ou `click({window,x,y,screenshotId?})`, `scroll({window,x,y,scrollX,scrollY,screenshotId?})`, `drag({window,from_x,from_y,to_x,to_y,screenshotId?})`, `press_key({window,key})`, `type_text({window,text})`, `set_value({window,element_index,value})`, `perform_secondary_action({window,element_index,action})`, `activate_window({window})`, `get_window({id})` e `launch_app({app})`. Defina `screenshotId` com o `id` da captura de tela retornada para usar coordenadas da imagem. Sem ele, use coordenadas inteiras locais da janela nas dimensões da última captura de tela observada, ou nas dimensões da janela antes de uma observação de captura de tela. A rolagem aceita tanto `scrollX` quanto `scrollY` na mesma chamada. Ações secundárias atualmente suportam Expand/Collapse; outros rótulos são recusados.
- macOS: use um `id` de aplicativo retornado como `app`. Leia `get_app_state({app})` e então chame `click({app,element_index,mouse_button?,click_count?})` ou `click({app,x,y,mouse_button?,click_count?})`, `drag({app,from_x,from_y,to_x,to_y})`, `scroll({app,element_index,direction,pages?})` (ou `x,y`), `press_key({app,key})`, `type_text({app,text})`, `paste({app,text,format:'text'})`, `set_value({app,element_index,value})`, `select_text({app,element_index,text,prefix?,suffix?,selection_type?})`, ou `perform_secondary_action({app,element_index,action})`.

Os inventários nativos e formatos de estado diferem por plataforma; reutilize os IDs e seletores retornados, não os handles wrapper de App. O estado do Linux retorna `ax_tree` e `screenshots`; entradas de captura de tela incluem `filepath`, `bytes`, `data_url`. O estado do Windows emite suas imagens de captura de tela. Outros resultados nativos são retornados para `nodeRepl.write`/`emitImage`; métodos mutadores retornam undefined. As permissões atuais do Host/aplicativo continuam valendo, e um método presente pode recusar um backend indisponível ou uma operação não suportada. Atualize o estado após um erro de alvo obsoleto (stale-target); não repita uma entrada cujo resultado seja desconhecido. Não mantenha um arraste ativo entre turnos; atualize as observações após uma redefinição.


Um REPL novo não possui alvos vinculados. Os pontos de entrada abaixo emitem a documentação da API
e o inventário ou estado inicial do alvo. Os IDs de navegador vêm de provedores CDP configurados e provedores de navegador por Extensão
conectados. IDs exatos têm precedência; somente sem correspondência exata `maka` e `chatgpt` selecionam um endpoint de Extensão atual exclusivo. Se nenhum estiver disponível, use janelas nativas do navegador via getApp. A API não expõe administração de driver, como start_session.

Uma extensão ChatGPT instalada com seu host nativo original é descoberta automaticamente no Chrome ou Chromium. `listBrowsers()` a reporta como `on_demand`; selecioná-la assume o controle até que `browser.release()` ou a limpeza do turno restaure o host original. Não é necessário comando de configuração, porta de depuração nem abrir o aplicativo desktop do ChatGPT. Prefira esta conexão de navegador para sites antes de usar entrada nativa na janela do navegador.

A compatibilidade com o ChatGPT é de melhor esforço. IDs exatos e handles existentes nunca alternam de provedor.

Pontos de entrada (a seleção emite o estado inicial):
- `await cua.getState({emit?})`: inventário de aplicativos e navegadores disponíveis, incluindo erros de inventário.
- `await cua.listApps({emit?})`, `await cua.listWindows({pid?, emit?})`.
  Passe o PID de um aplicativo observado para incluir seus painéis flutuantes no macOS.
  As entradas de janela incluem `pid` e `bindable`. Selecione uma janela com `bindable: true`.
  Um vínculo indisponível inclui `bindingError`. Entradas vinculáveis do macOS também incluem
  `applicationId` e `appPath`. O consentimento do aplicativo e a identidade ativa são verificados ao vincular.
- `const app = await cua.getApp("Name / bundle ID / app path")` ou `getApp({windowId})`.
  O macOS abre um aplicativo que não esteja em execução. No Windows, getApp seleciona uma janela já aberta;
  use `await cua.computer.launch_app({app: appId})` com um ID de cua.listApps(),
  depois atualize o inventário e selecione sua janela exata.
  Selecione uma janela exata quando os nomes forem ambíguos. O Linux exige que o aplicativo já esteja aberto.
- `await cua.listBrowsers({emit?})`, `await cua.listTabs({browser?, emit?})`.
- `const browser = await cua.getBrowser({id? , url?})`: seleciona sem abrir uma aba.
  Uma URL pretendida não precisa estar aberta ainda. Selecione um ID quando houver vários provedores disponíveis.
- `const tab = await cua.getTab("tab ID", {browser?})` ou `getTab({url}, {browser?})`.
- `await cua.createBrowserTab(browserId, url?)`: abre no perfil do provedor selecionado.
  Aqui e em getBrowser, URLs sem esquema usam HTTPS.
  A criação começa com uma aba em branco própria; uma URL explícita solicita então a navegação.
  Uma navegação recusada deixa essa aba em branco para a limpeza do turno.
  Provedores indisponíveis, menções a abas e opções de criação não suportadas lançam erro.
- `await browser.tabs.list()`, `await browser.tabs.get(id)`, `await browser.tabs.new()`:
  lista, vincula uma aba exata ou cria uma aba temporária em branco nesse navegador. Esses métodos
  retornam dados sem emiti-los; get/new retornam objetos Tab sem uma observação AX inicial.
  Chame getAXState antes de usar alvos observados. `await tab.title()` e `await tab.url()`
  retornam os metadados atuais sem alterar a observação de acessibilidade.

- Adaptadores de navegador conectados também expõem `await browser.user.openTabs()` e
  `await browser.user.claimTab(tabOrId)`. A listagem retorna metadados das abas atuais do usuário;
  assumir retorna a Tab comum após as permissões atuais e a preparação da conexão.
  Use um ID de string listado ou um objeto listado. A limpeza do turno libera abas do usuário sem fechá-las;
  abas criadas por esta Sessão permanecem temporárias. `browser.tabs.get(id)` continua sendo um vínculo
  preguiçoso (lazy) e não realiza tomada inicial nem observação AX. Esses métodos não
  retêm concessões. Para provedores de Extensão, `browser.tabs.list()` lista as abas gerenciadas desta Sessão.
  Provedores CDP configurados omitem `browser.user`; use os métodos `browser.tabs` correspondentes.

O Maka expõe um perfil AX de navegador: `tab.ax` contém `get`, `write`, `click`,
`drag`, `paste`, `performSecondaryAction`, `pressKey`, `scroll`, `selectText`,
`setValue` e `typeText`. As assinaturas de ação correspondem aos métodos de Tab abaixo.
`await tab.ax.get(mode = 'state', {disableDiffing?})` retorna texto, bytes de imagem ou
`{state, screenshot?}` para `state`, `screenshot` ou `both`, sem emitir.
`await tab.ax.write(mode = 'state', options?)` emite os resultados disponíveis e
retorna undefined. Os métodos planos existentes de Tab continuam disponíveis.
A fachada AX e os métodos planos atuam na mesma Tab vinculada.

Observações de App e Tab:
- `getAXState({emit?, disableDiffing?})` retorna texto. Abas e aplicativos macOS usam diff por padrão;
  aplicativos Windows e Linux retornam o estado completo.
- `getScreenshot({emit?})` retorna Uint8Array e emite a imagem.
- `getAXStateAndScreenshot(options?)` retorna `{state, screenshot?}` e emite os resultados disponíveis.
Descoberta, seleção e observações emitem automaticamente. Chame-as diretamente;
envolver `getScreenshot()` em `nodeRepl.emitImage()` ou `getAXState()` em
`nodeRepl.write()` é redundante. Use `{emit:false}` quando você mesmo for processar o resultado;
erros de inventário ainda aparecem. Métodos nativos de captura de tela no Windows rejeitam
`{emit:false}` antes da captura. Imagens idênticas emitidas dentro de uma mesma chamada
são entregues uma única vez. Uma chamada posterior pode emitir a mesma imagem novamente.
As observações incluem uma janela limitada de estabilização para breves atualizações de UI (200 ms para
abas, 400 ms para aplicativos). Isso não aguarda trabalho assíncrono arbitrário;
animações contínuas não estendem a janela. Atualize para observar mudanças posteriores.
Uma captura de tela bem-sucedida do mesmo documento de navegador inalterado preserva as referências
AX existentes. Após navegação, substituição de documento ou invalidação do alvo,
atualize `getAXState()` antes de reutilizar índices; atualize também para elementos recém-observados. Linux/Windows nativos retêm identidades de elementos observados anteriormente
enquanto esses elementos exatos permanecerem válidos.
Se uma observação AX nativa falhar enquanto um aplicativo estiver ocupado, atualize o mesmo objeto vinculado
quando o aplicativo voltar a responder. Observações com falha invalidam índices e coordenadas antigos.

Ações de App e Tab:
- `await app.bringToFront()` ativa persistentemente a janela nativa exata vinculada. Não envia entrada de teclado ou ponteiro e reporta resultado desconhecido se a área de trabalho não puder confirmar a ativação.
- `click(index | [x,y], {mouseButton?, clickCount?})`, `drag([x,y], [x,y])`.
- `scroll(index | [x,y], "up" | "down" | "left" | "right", distance?)`.
- Aplicativos nativos também aceitam botões do mouse `l/r/m` e direções `u/d/l/r`.
  O macOS remove espaços extras e ignora maiúsculas/minúsculas para esses nomes, e também aceita botões `0/1/2`
  para esquerdo/direito/meio.
- `setValue(index, string)`; indisponível para aplicativos nativos no Linux.
- `selectText(index, text, {prefix?, suffix?, selectionType?})`, onde selectionType é
  `text`, `cursor_before` ou `cursor_after`. A seleção nativa está disponível apenas no macOS.
  `text_not_found` significa que o texto ou o contexto fornecido está ausente; leia o estado atual
  novamente. `ambiguous_text` exige um prefix/suffix mais específico.
- `performSecondaryAction(index, action)`: use uma ação exata listada na observação AX nativa.
  O CDP não expõe ações secundárias e recusa este método.

Entrada de App: `typeText(text)`, `paste(text, {format?})`, `pressKey(key)`.
Entrada de Tab: `typeText(index|null, text)`, `paste(index|null, text, {format?})`,
`pressKey(index|null, key)`. Um índice fornecido foca primeiro o campo observado.
Use `null` para o foco atual. Exemplos de teclas: `Return`, `Tab`, `super+a`, `shift+Left`.
Formatos de colagem: `text` (padrão), `md` (código-fonte Markdown como texto simples) e `html`.
Aplicativos nativos no Linux e Windows suportam apenas `text`.
A colagem nativa de HTML existe apenas no macOS e exige um valor editável legível e seleção. Ela ativa
temporariamente a janela exata, preserva sua seleção e restaura a área de transferência anterior,
a menos que o usuário tenha copiado algo mais recente. Um valor inalterado é reportado como incerto.
A colagem de HTML no navegador requer um elemento contenteditable observado.

Navegação de Tab: `goto(url)`, `back()`, `forward()`, `reload()`, `close()`.
`await tab.screenshot({ fullPage: false, clip: { x, y, width, height } })` retorna bytes JPEG sem emitir uma imagem. Omita `clip` para a viewport; `fullPage: true` captura o documento inteiro. Largura e altura de `clip` devem ser positivas. Coordenadas e dimensões usam pixels CSS. A captura da viewport tenta primeiro um quadro recente de screencast e depois o comando de captura de tela da mesma aba após limpeza confirmada; operações incertas não são repetidas.

Em provedores de Extensão, `await tab.markDeliverable()` mantém a aba aberta ao término normal do turno e a libera para o usuário. `await tab.markHandoff()` retém a aba para esta mesma Sessão; o próximo turno efetivo a retoma sem marcação. A origem original (agente/usuário) é preservada, portanto uma aba criada pelo agente fecha ao término de um turno posterior sem marcação. Uma marcação explícita posterior substitui a anterior. Ambos os métodos retornam undefined após o ACK de intenção correspondente, o que não comprova entrega física nem limpeza. Marcações não retêm permissão de site; uma chamada incerta não é repetida. O CDP direto não suporta essas marcações.

`tab.clipboard` fornece `read()`, `readText()`, `write(items)` e `writeText(text)`.
Esses métodos retornam valores sem emiti-los. Um item rico tem `entries` não vazio;
cada entrada tem `mimeType` e exatamente um campo de string, `text` ou `base64`. O campo opcional
`presentationStyle` é `unspecified`, `inline` ou `attachment`. Por exemplo,
`await tab.clipboard.write([{entries:[{mimeType:'text/plain',text:'Hello'}]}])`.
Os dados virtuais são compartilhados por abas que usam o mesmo contexto de backend configurado;
eles não leem nem alteram a área de transferência do SO. Páginas autorizadas usam os mesmos dados
por meio da Clipboard API após a instalação. O `readText()` do agente retorna o texto da
primeira entrada exata `text/plain`, ou uma string vazia para uma entrada apenas em base64;
o `readText()` da página decodifica essa entrada por meio de um Blob. A limpeza do turno remove
pontes da página e preserva os dados armazenados. A redefinição cria um novo contexto vazio.

Métodos de espera retornam undefined. `locator.waitFor({state, timeoutMs?})` exige
`state: 'attached'|'detached'|'visible'|'hidden'` e testa a primeira correspondência;
nenhuma correspondência satisfaz `detached` e `hidden`.
`tab.playwright.waitForURL(pattern, {waitUntil?, timeoutMs?})` corresponde à URL completa:
`*` permanece dentro de um segmento delimitado por barras, `**` pode cruzar barras e outros
caracteres são literais. O `waitUntil` padrão é `commit`; `load`,
`domcontentloaded` e `networkidle` aguardam esse estado após a correspondência.
`tab.playwright.waitForLoadState({state?, timeoutMs?})` tem `load` como padrão e também
aceita `domcontentloaded` e `networkidle`. Essas esperas condicionais têm padrão de
3000 ms e respeitam timeouts explícitos maiores. Zero não deixa orçamento de espera por evento:
um locator ainda executa sua primeira sondagem, a URL/estado de carregamento atual já pode corresponder
e networkidle expira por timeout. `tab.playwright.waitForTimeout(ms)` aceita um inteiro não negativo
e aguarda uma duração fixa. Para uma espera disparada por ação, inicie a espera
antes da ação e então aguarde ambas as promises. Parar cancela a espera original.

`tab.playwright` resolve locators do DOM sem exigir uma observação AX prévia.
Use `locator(selector)`, `getByRole`, `getByText`, `getByLabel`, `getByPlaceholder`
ou `getByTestId`; `frameLocator(selector)` entra em um frame. Locators suportam
`first/last/nth`, `filter`, `and/or`, `count`, `all`, `allTextContents`,
`textContent`, `innerText`, `getAttribute`, `isEnabled` e `isVisible`.
`domSnapshot()` retorna o texto de acessibilidade DOM da página.

Métodos de entrada de locator retornam undefined: `click(options?)`, `dblclick(options?)`,
`fill(text, options?)`, `type(text, options?)`, `press(key, options?)`,
`pressSequentially(text, options?)`, `selectOption(valueOrValues, options?)`,
`setChecked(boolean, options?)`, `check(options?)` e `uncheck(options?)`.
As opções de clique aceitam `button: 'left'|'right'|'middle'`, `modifiers`, `force` e
`timeoutMs`; as opções de marcação aceitam `force` e `timeoutMs`. Os modificadores são `Alt`,
`Control`, `ControlOrMeta`, `Meta` e `Shift`; `ControlOrMeta` usa a plataforma do navegador
selecionado. Outras opções de entrada aceitam `timeoutMs`. Timeouts são inteiros positivos;
a preparação tem padrão de 3000 ms e respeita timeouts explícitos maiores. A seleção de opção aceita uma string de valor ou um descritor com
`value`, `label` ou um inteiro não negativo `index`; arrays selecionam múltiplas opções.

Mutações de locator usam uma correspondência única ou a única correspondência visível. Correspondências ambíguas
lançam erro. Operações comuns de fill/type de texto usam um evento de colagem virtual, respeitam o cancelamento
de um manipulador da página e preservam a área de transferência armazenada. Uma colagem vazia não apaga um
valor por padrão. Atalhos de teclado da área de transferência usam a mesma área de transferência virtual;
combinações não suportadas lançam erro antes de enviar teclas nativas. Gravações bem-sucedidas limpam
apenas as leituras em cache da coleção de locators chamadora. Os resultados da entrada ainda precisam ser
verificados na página; um resultado incerto não é repetido automaticamente.

Downloads usam um provedor de Extensão conectado com notificações de download e permissão atual
de download do Host. Arme antes de disparar a ação na mesma Tab:
`const pending = tab.playwright.waitForEvent('download', {timeoutMs:3000});`
então execute o clique ou a navegação e `const download = await pending`.
`await download.path({timeoutMs?})` retorna o nome de arquivo informado pelo navegador ou null.
Ele não transfere o arquivo nem prova que um caminho pertence a esta tarefa; pode ser
um caminho em outro host, vazio ou indisponível. Não possui operação saveAs.
`await tab.playwright.locator(selector).downloadMedia({timeoutMs?})` solicita mídia
para um locator com correspondência única. Esperas de download retornam dados sem emiti-los;
disparos de mídia retornam undefined. O prazo nativo de início termina no primeiro evento
Started correspondente; cancelamento e limpeza do Host continuam válidos depois disso.
Permissão de leitura e permissão de download são separadas, inclusive para uma origem
diferente de fonte ou destino. Uma conexão CDP configurada sozinha não fornece
notificações nativas de download.
O Maka também expõe `tab.cua.downloadMedia({x,y,timeoutMs?})` e
`tab.dom_cua.downloadMedia({node_id,timeoutMs?})` como extensões restritas. Os provedores de
Extensão selecionados atualmente rejeitam esses comandos de mídia por coordenada/nó; use a
rota de locator implementada. Um resultado de download incerto nunca é tentado novamente de forma automática.
O handle retornado mantém seu vínculo original de Tab, não uma concessão. Mantenha essa aba
disponível: `path()` reverifica os metadados atuais da aba e as permissões do Host antes da
consulta ao cache. Um handle obsoleto não consegue manter viva uma aba fechada. Turnos posteriores ainda
exigem acesso atual à aba; pode ser necessário assumir a aba novamente.

`await tab.getJsDialog()` retorna undefined ou o objeto de diálogo atual com
`type` e `dismiss()`. Diálogos de confirmação também têm `accept()`; diálogos de prompt têm
`accept(text)`, incluindo uma string vazia. Objetos de diálogo antigos não podem agir sobre um
diálogo substituto. Trate um diálogo ativo antes de leituras ou entradas comuns da página.
`getAXState()` mostra sua mensagem e controles indexados; controles de prompt suportam
`setValue`, `typeText` e Return/Escape. Controles de diálogo não têm coordenadas de página.
Capturas de tela ficam indisponíveis enquanto um diálogo está aberto: chamadas apenas de captura de tela lançam erro,
e observações combinadas retornam o estado do diálogo sem propriedade de captura de tela.
Um Host de navegador anexado aceita automaticamente diálogos beforeunload enquanto detém o
controle atual. A limpeza do turno libera o controle sem fechar abas do usuário.

A navegação suporta HTTP(S) e about:blank e aguarda um documento observável.
O alvo principal do CDP é coberto; a acessibilidade de iframes entre processos não é completa.
Distâncias de página no CDP aceitam números finitos, incluindo frações, zero e valores
negativos. Uma página usa a largura ou altura do conteúdo do alvo, com mínimo de
100 pixels CSS; alvos por coordenadas usam a viewport. A extensão `{pixels:n}` do CDP
aceita deltas positivos finitos em pixels.
O Linux rejeita contagens numéricas de páginas. O Linux X11 tem padrão `{pixels:800}` e aceita distâncias inteiras em pixels de 1 a
65535. Ele envia `max(round(pixels/100),1)` passos de roda; o aplicativo determina
o deslocamento resultante do conteúdo. O Linux Wayland atualmente recusa entrada em pixels.
A rolagem no macOS aceita números positivos finitos de páginas, com padrão 1, e rejeita
`{pixels}`. Contagens fracionárias de páginas são suportadas.
O Windows exige um ponto de coordenadas e uma distância positiva finita `{pixels:500}`;
distâncias omitidas e contagens numéricas de páginas são rejeitadas. Coordenadas e distâncias com sinal de direção usam
`Math.round` do JavaScript; entradas arredondadas devem caber em inteiros de 32 bits com sinal. Deltas nativos da roda
são limitados por eixo a [-32768,32767], e o ponteiro permanece no alvo.
O aplicativo determina o deslocamento do conteúdo. A rolagem nativa indexada preserva o alvo de acessibilidade
selecionado. Cliques nativos indexados via wrapper de App suportam um clique semântico; use
coordenadas da captura de tela para múltiplos cliques. O `cua.computer.click` bruto do macOS também
suporta múltiplos cliques indexados por meio de eventos de mouse simulados.

Um envio de entrada bem-sucedido não garante o estado resultante do aplicativo.
Ações por coordenadas no navegador usam coordenadas CSS da viewport e não exigem captura de tela.
Capturas de tela não escalam essas coordenadas.
Coordenadas locais da janela no Linux podem ser usadas sem tirar captura de tela. Os mapeamentos
nativos de captura de tela no Linux/Windows sobrevivem a ações de entrada até que outra observação
os substitua; uma observação apenas AX limpa o mapeamento de imagem. A entrada por coordenadas no Windows
passa então a exigir outra captura de tela. Uma mudança na geometria da janela invalida um
mapeamento armazenado. A entrada por coordenadas no macOS atualmente exige uma nova captura de tela após
uma ação.
Ações semânticas nativas usam elementos de acessibilidade retidos. Menus de aplicativos
têm escopo limitado ao seu processo proprietário e à janela exata vinculada; o conteúdo de menus fechados
é omitido até que o menu seja aberto. A interação com o menu pode ativar a
janela vinculada e a mantém ativa enquanto o menu estiver aberto.
A entrada nativa por coordenadas e teclado usa por padrão entrega em segundo plano para a janela
exata vinculada. A entrega em segundo plano não suportada é reportada; a entrada não é repetida
automaticamente em primeiro plano. Efeitos não verificados já podem ter sido entregues.
Prefira operações em Tab do navegador para sites: elas evitam foco na área de trabalho e entrada
do ponteiro. Para entrada nativa de texto, prefira `typeText` ou `setValue`; o `paste` no macOS usa a
área de transferência do sistema e entrada de teclado em primeiro plano. Menus nativos podem ativar sua
janela. Algumas rotas de coordenadas podem mover o ponteiro do sistema; os metadados de entrega
informam a rota real. Os métodos nativos `app.pressKey(key, {deliveryMode:"foreground"})`
e `app.typeText(text, {deliveryMode:"foreground"})` solicitam explicitamente uma rota em primeiro plano
quando necessário; o padrão é `"background"`. Não repita uma entrada não verificada
automaticamente nem troque de modo silenciosamente.

`nodeRepl.write(value)` emite texto/JSON. `await nodeRepl.emitImage(bytes | dataUrl |
{bytes, mimeType})` emite uma imagem. URLs de imagem File/HTTP, Node, acesso arbitrário ao sistema de arquivos
e APIs de rede estão indisponíveis. `cua.rewriteDocumentation()` reimprime esta referência.

Quando o Host habilita áudio de saída, `await cua.computer.start_audio_recording({max_duration_ms?})`
inicia a gravação e retorna undefined enquanto outras chamadas podem continuar. A duração padrão
é de 60000 ms e aceita inteiros de 100 a 300000. `await cua.computer.stop_audio_recording()`
retorna `{filepath, bytes, data_url}` para o WAV PCM16 estéreo a 24 kHz finalizado. Atingir a
duração encerra a captura; chame stop para recuperá-la. `await nodeRepl.emitAudio(bytes | dataUrl |
{bytes, mimeType})` emite áudio explicitamente. Esses métodos ficam ausentes quando o áudio está desabilitado.
A redefinição e a limpeza da Sessão descartam gravações e seus caminhos locais.

Cada operação usa as permissões atuais do Host; objetos JS não retêm concessões.
Com o sandbox da Sessão desativado, Computer Use, aplicativos, sites do navegador, histórico,
transferências de arquivos e áudio não precisam de aprovação adicional do Maka. Alterar permissões
ou parar a operação atual continua surtindo efeito.
No modo Ask, a aprovação do Computer Use acontece antes de o timeout de execução do REPL começar.
Esperas por consentimento de aplicativo, site do navegador e áudio pausam o orçamento restante. Esperas
nativas no macOS/Windows também o pausam; esperas assíncronas comuns e operações nativas no Linux
o consomem. Pausar nunca recarrega o orçamento nem desabilita o cancelamento.
Operações nativas no macOS reportam `desktop_locked` enquanto a tela está bloqueada; provedores
CDP conectados e cálculos puros no REPL continuam disponíveis de forma independente.
Cada Sessão tem seu próprio cursor Maka. Ações de entrada o exibem automaticamente.
`cua.cursor.configure({label?, color?,
enabled?, reducedMotion?})` altera a exibição desta Sessão. As cores são `blue`, `mint`,
`violet`, `amber`, `rose`, `cyan`; rótulos permitem até 48 caracteres. `cua.cursor.getState()`
informa configurações e visibilidade nativa/do navegador. Um renderizador nativo no estado `idle` inicia
na primeira indicação nativa; `unavailable` indica um host de exibição ausente ou com falha.
Configure novamente para tentar reiniciar um renderizador com falha. O cursor pertence à Sessão, mas não permanece na tela após um Turno: ele é exibido durante o Turno, ocultado quando o Turno termina e reaparece na próxima ação de entrada.
Cursores não compartilham autoridade de entrada e não movem o ponteiro do sistema. Múltiplos cursores
não isolam o teclado físico, o foco de aplicativos nem o método de entrada.
REPLs cancelados, expirados por timeout ou com heap esgotado exigem `cua_reset` e depois nova vinculação dos alvos. Trabalhos
nativos admitidos são concluídos antes do retorno; a redefinição não desfaz entradas já enviadas.
No término normal do turno, esta Sessão fecha abas temporárias sem marcação que ela criou e libera suas observações de página.
Abas preexistentes do usuário e abas retidas marcadas permanecem abertas conforme as regras acima. A redefinição limpa o REPL
e os vínculos desta Sessão; ela não concede novos acessos nem apaga as obrigações de recursos retidos e de limpeza desta Sessão.
Uma marcação ou fechamento não confirmado retém a custódia e não é repetido.

A mesma coleção de navegadores está disponível como `agent.browsers` e `cua.browsers`.
Seus métodos `list`, `get(id)`, `getDefault` e `getForUrl(url)` retornam metadados
ou objetos Browser preguiçosos (lazy) sem emitir uma observação. `cua.getBrowser` é o
ponto de entrada de conveniência que emite a documentação. Um Browser expõe `tabs.selected()`
para a aba ativa da sua sessão lógica; isso não seleciona a aba em foco no SO.
O provedor CDP direto atual não possui serviço de aba ativa de sessão lógica e
retorna `undefined` em `selected()`.

`await browser.release()` devolve a concessão sob demanda do navegador ChatGPT desta Sessão. Ela finaliza as abas temporárias deste turno e os recursos físicos de controle antes de liberar o host; páginas retidas permanecem abertas. Outras Sessões mantêm suas próprias concessões. A última liberação restaura o host nativo original. Readquira com `cua.getBrowser({id: "chatgpt"})` antes de continuar usando; handles de uma geração de host aposentada exigem uma nova conexão. A limpeza normal do turno também libera a concessão. Agentes de longa duração devem liberar antes de entrar em espera. Outros provedores de navegador não suportam esta operação.

`await browser.nameSession(name)` remove espaços nas extremidades e armazena o título do grupo
gerenciado da sessão. A apresentação gerenciada existente é atualizada por meio de seus recibos próprios;
abas criadas futuramente usam o título armazenado. `cua.createBrowserTab(id, url,
{sessionName})` resolve o navegador e aguarda a nomeação antes de criar a aba.
O perfil atual do navegador não oferece a capacidade de visibilidade.

`await browser.history({queries, limit, from, to})` lê o histórico de todo o perfil
por meio de uma extensão que anuncia o transporte separado de histórico. Com o sandbox habilitado, exige
consentimento independente de `browser_history` para o ID e a geração reais do navegador
sob a fronteira atual de permissão da Sessão. Concessões de página e download não o autorizam.
Nenhuma solicitação de histórico é concedida automaticamente pela política de origem de página.
O padrão é uma consulta de todo o histórico limitada a 100 entradas; resultados das consultas fornecidas
são combinados por horário de visita decrescente, deduplicados por URL e então limitados.
A extensão Maka empacotada declara a permissão de histórico do Chrome; uma extensão instalada mais antiga
sem essa permissão não anuncia suporte a histórico.
ChatGPT e outros adaptadores de terceiros permanecem em melhor esforço.

- `await browser.user.getTabContext(tabOrId)` lê o contexto de uma aba do usuário atualmente visível
  sem assumi-la nem focar nela. A URL atual da aba é autorizada pelo
  Host; chamadores não podem fornecer uma URL substituta. Abas privadas e uma URL que
  mude durante uma leitura individual são recusadas. O resultado é
  `{kind:'text',text,title,url,truncated}` ou
  `{kind:'document',data,fileName,mimeType,title,url}`, em que `data` é um
  `Uint8Array` contendo o arquivo exportado real. Quando o Host fornece publicação de
  arquivos, os documentos também incluem um `path` real pertencente à Sessão. Documentos do Google
  Workspace podem fornecer contexto em Markdown, PDF ou XLSX; páginas comuns
  podem incluir a seleção atual, e páginas de vídeo do YouTube podem incluir uma
  transcrição. O provedor `maka` implementa as leituras fixas; `chatgpt` reutiliza seu
  protocolo de leitura padrão quando suportado. O suporte de terceiros permanece em melhor esforço.

- `await tab.playwright.evaluate(pageFunction, arg?, {timeoutMs}?)` avalia uma
  função autocontida na página atual. Uma string é tratada como uma
  expressão. Variantes de locator passam `(element, arg)` para `locator.evaluate` ou
  `(elements, arg)` para `locator.evaluateAll`; a forma de elemento único exige
  um alvo inequívoco e a forma de todos os elementos aceita correspondência vazia.
  Os argumentos devem ser serializáveis em JSON. Os resultados são dados simples; funções e
  símbolos são omitidos, inteiros grandes tornam-se strings e números não finitos
  tornam-se `null`. Esta API limita a profundidade do resultado a 8, arrays a 2000 entradas,
  objetos a 200 chaves e strings a 200000 unidades UTF-16, com marcadores `[MaxDepth]`,
  `[Circular]` e `[Truncated]` quando aplicável.
- A avaliação expõe visualizações somente leitura de DOM, CSS, geometria, range e seleção.
  Não expõe rede, cookies, carregamento de módulos nem edições no DOM. Rolagem,
  limites locais de range e temporizadores apenas com função continuam sendo operações suportadas.
  O timeout padrão é 3000 ms; valores explícitos definem a duração solicitada.
  Um script parado ou interrompido já pode ter sido executado; ele não é executado novamente
  de forma automática. As permissões de site e a propriedade da aba existentes continuam valendo.

A entrada de ponteiro no navegador está disponível por meio de `tab.cua.move({x,y,keys?})`,
`click({x,y,button?,keypress?})`, `double_click({x,y,keypress?})`,
`drag({path:[{x,y},...],keys?})` e
`scroll({x,y,scrollX,scrollY,keypress?})`. Coordenadas e distâncias são números CSS
da viewport e preservam valores fracionários e negativos; os botões são 1 (esquerdo),
2 (meio) ou 3 (direito). Os nomes dos modificadores de ponteiro são Alt, Control, Meta, Shift e
ControlOrMeta. `tab.cua.keypress({keys:[...]})` envia uma combinação de teclas para o foco atual;
`tab.cua.type({text})` cola texto no foco atual por meio da área de transferência virtual do navegador,
preservando os dados armazenados na área de transferência. O texto pode incluir Markdown;
o Google Sheets recebe texto simples. Esses métodos de entrada retornam undefined e não
repetem uma entrada incerta.

`await tab.dom_cua.get_visible_dom()` retorna HTML interativo visível com
valores `node_id` em string. Use exatamente essas strings com `click({node_id})` ou
`double_click({node_id})`; `scroll({node_id?,x,y})` recebe distâncias de rolagem e
usa o centro da viewport quando node_id é omitido. `keypress({keys:[...]})` e
`type({text})` usam o foco atual, não um ID de nó. Métodos DOM retornam undefined,
exceto o snapshot. Um novo snapshot aposenta nós DOM ausentes; navegação ou
substituição de frame pode tornar um nó obsoleto. Observe novamente em vez de adivinhar um
ID ou repetir uma entrada cujo resultado seja desconhecido.

<!-- named-browser-documents -->
<!-- browser-document: bootstrap-troubleshooting chrome-troubleshooting browser-troubleshooting -->
# Solução de problemas do navegador
Leia `cua.getState()` e `agent.browsers.list()` para identificar o navegador disponível e seu ID exato. Uma conexão configurada não é prova de que uma ação específica foi bem-sucedida. Quando um vínculo estiver obsoleto ou seu resultado for desconhecido, inspecione o estado atual antes de escolher a próxima operação; uma mutação incerta não deve ser repetida automaticamente.
<!-- /browser-document -->
<!-- browser-document: browser-safety confirmations -->
# Autoridade do navegador
Um vínculo de navegador não preserva permissão. As operações usam a Sessão atual, o turno, a política do workspace e a origem da página. O consentimento para ler uma página não autoriza transferências de arquivos nem histórico de todo o perfil. Uma aprovação recusada, uma Sessão fechada ou uma fronteira de permissão alterada devem ser tratadas antes de qualquer outra ação.
<!-- /browser-document -->
<!-- browser-document: visibility capabilities/browser/visibility -->
# Visibilidade do navegador
Leia `browser.capabilities.list()` para determinar se este navegador publica uma capacidade de visibilidade. Um nome de documentação não é evidência de que a capacidade esteja habilitada. Quando a visibilidade estiver ausente, passar a opção `visible` na criação de aba é recusado antes de criar a aba.
<!-- /browser-document -->
<!-- browser-document: session-naming -->
# Nomeação de sessão
`await browser.nameSession(name)` atribui um título não vazio e sem espaços nas extremidades ao grupo de abas gerenciado desta Sessão do navegador e às futuras abas criadas. `cua.createBrowserTab(id, url, {sessionName})` aguarda essa etapa de nomeação antes de criar uma aba; um erro de nomeação não cria a aba.
<!-- /browser-document -->
<!-- browser-document: tab-claiming-chrome -->
# Abas do usuário
`browser.user.openTabs()` retorna metadados das abas do usuário sem assumi-las. `browser.user.claimTab(listedTabOrId)` adquire explicitamente a aba exata escolhida. `browser.tabs.get(id)` retorna um vínculo preguiçoso (lazy) e não representa tomada implícita de uma aba arbitrária do usuário. Abas do usuário são liberadas, e não fechadas, durante a limpeza do turno.
<!-- /browser-document -->
<!-- browser-document: tab-cleanup-chrome -->
# Ciclo de vida de abas gerenciadas
Abas criadas são temporárias, a menos que seu ciclo de vida atual as retenha explicitamente. `markDeliverable()` preserva um resultado finalizado para o usuário; `markHandoff()` retém uma aba para continuação dentro da mesma Sessão. Essas marcações não preservam permissões antigas de página nem autorizam outra Sessão. Fechamentos, interrupções e efeitos incertos mantêm seus próprios requisitos de limpeza.
<!-- /browser-document -->
<!-- browser-document: tab-mentions-iab tab-cleanup-iab capabilities/browser/management -->
# Disponibilidade de backend de navegador
O conjunto atual de provedores do Maka contém extensões de navegador e conexões CDP configuradas; ele não adiciona um backend de navegador integrado. Vincule navegadores e abas usando IDs do inventário atual. Ler uma referência sobre um backend integrado ou capacidade de gerenciamento não cria esse backend nem concede autoridade de gerenciamento de navegador.
<!-- /browser-document -->
<!-- browser-document: browser-control-interruption -->
# Operações interrompidas
O cancelamento não é evidência de que uma operação enviada tenha sido revertida. Mantenha o vínculo original e o resultado da operação até que sejam concluídos; não repita uma mutação por meio de outro provedor. Uma redefinição limpa os vínculos do REPL, e o trabalho subsequente deve vincular os alvos novamente sob a permissão atual.
<!-- /browser-document -->
<!-- browser-document: api-use-behavior -->
# Uso da API do navegador
`agent.browsers` e `cua.browsers` compartilham a mesma coleção. Chamadas da coleção retornam dados ou vínculos preguiçosos (lazy) sem emitir uma observação. `agent.documentation.get(name)` lê um documento nomeado exato e retorna uma Promise para seu texto sem emiti-lo. `tabs.selected()` acompanha a atividade lógica da Sessão. IDs exatos de navegador e vínculos de aba existentes não alternam provedores.
<!-- /browser-document -->
<!-- browser-document: accessibility -->
# Observações de acessibilidade
Leia um estado de acessibilidade atualizado antes de usar suas referências de elementos. `tab.ax` expõe as operações de acessibilidade documentadas e `get(mode, options)` retorna estado, bytes de captura de tela ou ambos sem emissão automática. Navegação ou alteração de documento pode invalidar referências observadas anteriormente; atualize a observação em vez de adivinhar um índice.
<!-- /browser-document -->
<!-- browser-document: webmcp capabilities/tab/cdp capabilities/tab/botDetection capabilities/tab/browserAuth -->
# Capacidades opcionais do navegador
Leia a coleção de capacidades do objeto selecionado antes de usar uma capacidade opcional. Uma referência na documentação não habilita APIs brutas de CDP, WebMCP, autenticação ou tratamento de desafios. Se o ID estiver ausente dessa coleção, a capacidade não está disponível; operações existentes de página mantêm suas verificações normais de permissão e ciclo de vida.
<!-- /browser-document -->
<!-- browser-document: local-web-development -->
# Páginas de desenvolvimento local
Escolha um navegador que consiga alcançar a URL de desenvolvimento pretendida e navegue para essa URL explícita. Um nome de host local continua sujeito à política de rede atual do workspace e à autorização de origem da página. Preserve o vínculo do navegador selecionado ao verificar a página; o localhost de outra máquina é um destino diferente.
<!-- /browser-document -->
<!-- browser-document: file-uploads chrome-file-upload-troubleshooting -->
# Uploads de arquivos
Use operações de upload somente quando a documentação do navegador selecionado as expuser. Um upload precisa de sua própria permissão atual para a página e os arquivos escolhidos; uma concessão de leitura de página ou de download não é consentimento para upload. Um seletor de arquivos pertence à interação exata da página que o abriu. Se essa página ou seletor não for mais atual, comece por uma nova observação em vez de reutilizar um seletor antigo.
<!-- /browser-document -->
<!-- browser-document: screenshots -->
# Capturas de tela
`tab.getScreenshot()` retorna bytes de captura de tela; auxiliares de observação podem emitir a imagem. Use uma nova captura após navegação, redimensionamento ou rolagem antes de decidir coordenadas. Uma captura de tela é uma observação, não prova de que uma entrada anterior chegou ao controle pretendido.
<!-- /browser-document -->
<!-- browser-document: capabilities/browser/viewport -->
# Capacidade de viewport
Leia `browser.capabilities.list()` e obtenha a capacidade de viewport publicada antes de alterar o tamanho. As configurações de viewport acompanham a aba ativa lógica da Sessão do navegador e seu ciclo de vida atual. Alterar o tamanho da viewport não seleciona uma aba não relacionada em foco no SO nem concede acesso à página.
<!-- /browser-document -->
<!-- browser-document: capabilities/tab/pageAssets -->
# Capacidade de recursos da página
Use recursos da página somente quando a aba selecionada publicar essa capacidade. O inventário de recursos pertence à página e ao documento observados. Após navegação ou substituição do documento, obtenha um novo inventário; identificadores antigos de recursos não podem autorizar arquivos de outra página. Salvar arquivos exige a permissão atual de transferência de arquivos da operação.
<!-- /browser-document -->

### Seletores de arquivos e uploads

```js
const pending = tab.playwright.waitForEvent('filechooser', { timeoutMs: 3000 });
await tab.playwright.getByRole('button', { name: 'Upload' }).click();
const chooser = await pending;
chooser.isMultiple();
await chooser.setFiles(['workspace-file.bin']);
```

Inicie a espera antes da ação que abre o seletor. A espera padrão do evento de seletor é de 3000 ms; um timeout explícito deve ser um inteiro positivo. `isMultiple()` é síncrono. `setFiles(pathOrPaths, {timeoutMs})` aceita um caminho ou um array não vazio; um seletor de arquivo único rejeita múltiplos caminhos. Seu timeout opcional é validado sem descartar uma seleção em andamento.

Os caminhos referem-se ao sistema de arquivos do Agent Host e continuam sujeitos à política de arquivos do workspace do chamador. O acesso à página, o consentimento de upload para a origem HTTP(S) atual e a permissão de leitura de arquivo são separados. O snapshot de entrada suportado é um arquivo regular. Os arquivos são transportados como bytes imutáveis e materializados pelo host de navegador Maka selecionado; não traduza caminhos entre sistemas operacionais por conta própria.

Handles de seletor pertencem à aba, ao documento e ao turno em que foram emitidos. Seletores de alvos filhos não são suportados. Seletores de extensão exigem proveniência completa do evento de origem; uploads exigem adicionalmente posicionamento verificado de arquivos no host do navegador. O Chatgpt é de melhor esforço, e CDP configurado sem esse posicionamento recusa o upload antes de enviar arquivos. Uma aba já vinculada nunca é substituída por outro navegador para satisfazer a operação. Uma seleção bem-sucedida consome o seletor. Um resultado desconhecido deve ser reconciliado em vez de repetido.

Se a limpeza reportar um resultado não confirmado, não presuma que os dados de upload copiados foram excluídos. A recuperação automática após o encerramento do host do navegador enquanto arquivos permanecem selecionados ainda não está disponível.
