# Registro de alterações do sistema

Registro técnico interno das mudanças feitas no projeto — não é o
changelog de release (`CHANGELOG.md`). Cada entrada mostra o estado
anterior, o que foi alterado, e qual problema isso resolveu.

Entradas mais recentes primeiro.

## [2026-08-07] A tela de WhatsApp passa a dizer QUAL número está conectado

**Antes:** o card de conexão mostrava "Conectado" e nada mais. Isso bastava
quando a conta tinha um número só; com uma linha por operador, "conectado"
deixa a pergunta mais importante sem resposta — conectado a qual telefone?
Não havia como saber pela interface, e o campo que o card tentava usar
(`uazapi_instance_name`) está vazio em todas as conexões desta conta.

**Depois:** o card mostra o número. Quando a instância não responde, ele diz
isso em vez de simplesmente não mostrar nada.

**Decisões que vale registrar:**
1. **Nada no nosso schema sabe o número, e não é descuido.** O telefone é
   escolhido no aparelho, na hora em que alguém escaneia o QR Code —
   `whatsapp_config` guarda o id e o token da instância, não a linha atrás
   deles. Só a UAZAPI pode responder.
2. **O payload foi verificado contra uma instância real, não deduzido.** O
   `/instance/status` devolve o número duas vezes: `instance.owner`
   (`"554896274914"`, já limpo) e dentro de `status.jid`
   (`"554896274914:14@s.whatsapp.net"`). O `owner` ganha; o jid é o plano B
   e precisa perder o índice de dispositivo (`:14`, que muda quando um
   segundo aparelho é vinculado) e o domínio de roteamento.
3. **"Não consegui confirmar" é um estado próprio, não a ausência do
   número.** Sem essa distinção o card mostraria "Conectado" e nada ao lado,
   que é a coisa mais enganosa possível quando a conexão está morta — e é
   exatamente o caso de duas das três conexões desta conta.

**Encontrado no caminho, e não é código:** duas das três conexões respondem
`401 Invalid token` na UAZAPI enquanto o banco ainda as registra como
`connected`. Os dados de mensagens confirmam o efeito — o número da casa
(token válido) recebeu mensagem às 20:21, os dois com token morto pararam às
14:31 e às 12:58. O `UAZAPI_BASE_URL` aponta para `free.uazapi.com`, um
servidor público de demonstração cujas instâncias expiram; isso já estava
documentado neste arquivo como algo que voltaria a acontecer até migrar para
um servidor próprio ou pago.

**Resolvido:** pedido do usuário — "nesta tela, apareça qual é o número da
conta do WhatsApp que está conectada".

Arquivos: `src/lib/whatsapp/connected-number.ts` (novo),
`src/lib/whatsapp/connected-number.test.ts` (novo),
`src/lib/whatsapp/uazapi-api.ts`,
`src/app/api/whatsapp/uazapi/status/route.ts`,
`src/components/settings/uazapi-connect.tsx`, `messages/{pt-BR,en,ko}.json`

## [2026-08-07] Duas correções achadas ao abrir a tela pela primeira vez

> Contexto: até aqui, toda entrega de interface tinha sido verificada só por
> `typecheck`, `build`, lint e testes — nenhuma delas alcança um erro que só
> existe quando a tela renderiza. O usuário forneceu acesso ao navegador e as
> duas correções abaixo apareceram em minutos.

**Antes (1) — o selo se contradizia com o resto da tela.** Uma conversa que
chegou no número da casa e depois foi puxada por um operador mostrava
"Número da casa" no selo de titularidade, enquanto o rodapé logo abaixo
dizia que ela tinha sido passada adiante e o campo de digitação não estava
lá. O selo não nomeava ninguém — exatamente a falha que ele existe para
evitar. Causa: `ownerView` resolvia *de quem é o número* antes de olhar
`handed_over_at`, então o ramo do número da casa retornava primeiro e a
entrega ficava invisível.

**Antes (2) — quatro chaves de tradução chamadas e inexistentes.**
`Inbox.messageThread.sendTemplateHint` lançava `MISSING_MESSAGE` no console
em toda conversa vazia. A chave havia sido removida no commit `9e69010`,
quando a integração com a Meta saiu e "modelos" deixaram de existir, mas a
chamada ficou. Uma varredura pelo mesmo formato achou outras três, todas
anteriores a este trabalho: `Inbox.bubble.template`,
`Inbox.replyQuote.template` e `Automations.builder.delete`.

**Depois:**
- **Estar entregue passa a valer mais do que de quem é o número**, em todos
  os casos. Enquanto a entrega está de pé, quem responde está do outro lado
  dela; nomear o dono do número nomearia alguém que só observa.
- **`handedOverToName`** segue `transferred_to_conversation_id` até o elo
  que hoje segura a conversa e lê de quem é aquele número. Recebe o conjunto
  de conversas que o chamador já tem em mãos — a cadeia na thread, as linhas
  carregadas na lista — então não custa consulta nenhuma.
- **O rodapé parou de afirmar autoria que não pode conhecer.** Dizia "Você
  transferiu esta conversa" para qualquer observador, inclusive um gestor
  olhando uma entrega feita por outra pessoa. Agora só diz isso quando
  `transferred_by_user_id` é você; senão, nomeia quem está com ela.
- **As quatro chaves foram restauradas** — mas não com o texto antigo: o
  original mandava "enviar um modelo para iniciar a conversa", conceito que
  não existe mais. O estado vazio agora pede a primeira mensagem.

**Decisões que vale registrar:**
1. **`t("delete", { defaultValue: "Delete" })` foi corrigido, não mantido.**
   `defaultValue` é idioma do i18next; o next-intl não tem esse fallback e
   lança do mesmo jeito. O argumento não fazia nada além de esconder o bug.
2. **O texto do passo `close_conversation` das automações foi corrigido.**
   Ele ainda prometia "define o status da conversa como fechada" como se
   isso fosse visível. Não é mais — o texto agora diz isso e aponta para
   "Encerrar atendimento".
3. **Um caso que parece bug e não é:** uma conversa entregue a um destino
   que hoje vive no número da casa mostra "Transferida", sem nome. É o
   resultado honesto — o número da casa não tem operador para nomear. Isso
   aparece nos dados desta conta porque números foram atribuídos e
   reatribuídos durante os testes.

**Resolvido:** as duas falhas passaram por `typecheck`, `build`, lint e 615
testes sem serem notadas, porque nenhuma dessas verificações abre a tela.
Foram encontradas na primeira sessão com navegador autenticado.

Arquivos: `src/lib/inbox/conversation-owner.ts`,
`src/lib/inbox/conversation-owner.test.ts`,
`src/components/inbox/message-thread.tsx`,
`src/components/inbox/conversation-list.tsx`,
`src/components/automations/automation-builder.tsx`,
`messages/{pt-BR,en,ko}.json`

## [2026-08-07] Fim do status Aberta/Pendente/Fechada na caixa de entrada

**Antes:** cada conversa carregava um status de fluxo — aberta, pendente
ou fechada — que o operador escolhia num dropdown no cabeçalho. Ele nasceu
quando a caixa era compartilhada e o status era a única forma de dizer "já
cuidei disto". Com o modelo de operadores, as duas perguntas que ele
respondia passaram a ter respostas melhores em outro lugar: **quem cuida**
é o dono do número em que a conversa vive, e **já acabou** é o "Encerrar
atendimento", que tira a conversa da caixa. O status virou um terceiro
eixo que ninguém precisava manter, e que podia contradizer os outros dois.

**Depois:**
- O dropdown de status **saiu** do cabeçalho da conversa.
- Os filtros **Abertas / Pendentes / Fechadas** saíram da lista. Sobraram
  os que ainda respondem alguma coisa: Todas, Não lidas e Arquivadas.
- A **bolinha colorida** de status saiu das linhas da lista.
- **"Conversas ativas" no dashboard passou a contar "não arquivadas"** em
  vez de `status = 'open'`.

**Decisões que vale registrar:**
1. **A coluna `status` continua no banco, e de propósito.** Ela não é só
   da caixa de entrada: a API pública documenta o filtro `?status=`
   (contrato externo, quebrar seria mexer em integrações de terceiros),
   as automações têm um passo `close_conversation` que o usuário pode
   arrastar para um fluxo, e o nó de handoff dos fluxos marca `pending`.
   Derrubar a coluna quebraria os quatro de uma vez.
2. **Mas o dashboard não podia ficar como estava.** "Conversas ativas"
   contava `status = 'open'`, e sem nenhum controle humano que mude esse
   valor a métrica iria virando, em silêncio, "todas as conversas de
   todos os tempos". Passou a contar `archived_at IS NULL`, que é
   literalmente "ainda está na caixa" — o que o rótulo sempre prometeu.
3. **Consequência que fica em aberto:** o passo `close_conversation` das
   automações continua funcionando e gravando `status='closed'`, só que
   agora **sem efeito visível** na caixa de entrada. Não foi removido
   porque automações já existentes podem referenciá-lo, e isso é decisão
   do usuário, não limpeza de rotina.

**Resolvido:** pedido do usuário — "com as novas funcionalidades de
transferência não precisamos mais desse feature de Aberta/Fechada/
Pendente".

Arquivos: `src/components/inbox/message-thread.tsx`,
`src/components/inbox/conversation-list.tsx`,
`src/app/(dashboard)/inbox/page.tsx`, `src/lib/dashboard/queries.ts`,
`messages/{pt-BR,en,ko}.json`

## [2026-08-07] Puxar uma conversa para si, e a conversa sempre com um nome

> **Requer migration.** `supabase/migrations/047_pull_conversation.sql`,
> já aplicada em produção antes do deploy do código.

**Antes:** o modelo de operadores só sabia **empurrar**.
`transfer_conversation` entrega a conversa a outra pessoa, e quem entrega
precisa ser quem atende. Faltava o movimento contrário — eu vejo uma
conversa que está com outro operador, ou no número da casa (que não é de
ninguém), e quero trazê-la para mim. Não havia como: o RPC de
transferência **recusa explicitamente** ter o próprio autor como destino
("That conversation is already yours"), então nem chamando com o próprio
id dava para reaproveitá-lo.

Havia também um ponto em que a tela deixava de nomear alguém: depois de
transferir, o selo dizia "Você transferiu — acompanhando". Isso descreve
um **estado**, não uma **pessoa**, e deixava a conversa aparentemente sem
dono justamente no momento em que ela tinha acabado de ganhar um.

**Depois:**
- **Botão "Puxar conversa"** no cabeçalho da conversa, o primeiro da
  linha. Aparece só quando há o que assumir: a conversa não está no seu
  número, você tem um número para ela ir, e não é grupo. Ao puxar, a
  conversa passa a viver no seu número com o histórico inteiro visível, e
  quem atendia antes passa a acompanhar — exatamente a mesma mecânica da
  transferência, no sentido inverso.
- **O selo nomeia quem está com a conversa** depois de uma transferência:
  "Agora com Bruno" no lugar de "Você transferiu — acompanhando".
- **`pull_conversation()`** e o extrato da mecânica comum em
  `handover_conversation_core()`, usada pelas duas operações.

**Decisões que vale registrar:**
1. **Empurrar exige ESCRITA; puxar exige LEITURA.** É a diferença que
   define as duas operações, e o motivo de serem RPCs separados em vez de
   um parâmetro novo. Você só passa adiante o que atende — um observador
   não distribui trabalho alheio. Mas você assume o que já enxerga. A
   consequência importante: puxar **não é uma porta lateral para fora do
   escopo** — um operador de escopo 'own' não enxerga a conversa de um
   colega e portanto não consegue puxá-la. Quem puxa livremente é o
   gestor de escopo 'all', que já via tudo de qualquer forma.
2. **Uma implementação da mecânica, não duas.** Criar/reaproveitar o
   destino, fundir a cadeia, marcar a origem como entregue e pausar o
   fluxo agora vivem em `handover_conversation_core`. Duas cópias
   divergiriam no primeiro ajuste. O refactor foi validado com os **14
   testes de comportamento da transferência rodados de novo** contra a
   versão refatorada, antes de aplicar — nenhum mudou de resultado.
3. **Puxar do número da casa é o caso de uso principal**, não um efeito
   colateral. Uma conversa que chega no número que ninguém possui não tem
   dono padrão — a regra "dono = operador do número que o cliente chamou"
   não produz resposta quando o número não tem operador. Puxar é como ela
   ganha um.

**Resolvido:** pedido do usuário — um botão para assumir uma conversa que
está sob domínio de outro operador, e a exigência de que a conversa sempre
mostre um responsável com nome. A regra "dono = operador do número que o
cliente chamou primeiro" já era o comportamento; o que faltava era a tela
dizer isso em todos os estados, e uma saída para o caso em que o número não
tem dono.

Arquivos: `supabase/migrations/047_pull_conversation.sql` (novo),
`src/components/inbox/message-thread.tsx`, `messages/{pt-BR,en,ko}.json`

## [2026-08-07] Caixa de entrada: encerrar um atendimento por vez, filtrar por operador, e menos controles

**Antes:** quatro incômodos de uso na caixa de entrada, todos herdados de
quando a conta tinha um número só e uma caixa compartilhada:

1. **"Limpar caixa" era tudo ou nada.** O botão arquivava *todas* as
   conversas visíveis de uma vez — inclusive, de propósito, as que
   estavam fora do filtro ativo no momento. Funcionava como anunciado,
   mas a unidade útil de trabalho é **um** atendimento terminado, não a
   caixa inteira; na prática ninguém queria zerar tudo.
2. **A aba "Todos"** misturava contatos e grupos, o que torna as outras
   duas abas decorativas: se o padrão mostra tudo, a escolha não é uma
   escolha.
3. **Não dava para filtrar por operador.** Com mais de um número na
   conta, "me mostre só as minhas" e "o que está com o Bruno" viraram
   perguntas diárias sem resposta na interface.
4. **"Atribuir" duplicava a transferência.** Marcava um responsável numa
   coluna (`assigned_agent_id`) que não governa nada: quem pode
   responder é o dono do número em que a conversa vive, e isso quem
   define é a transferência. Dois controles para a mesma pergunta,
   podendo discordar entre si.

**Depois:**
- **"Encerrar atendimento"** no cabeçalho da conversa, uma de cada vez.
  Usa `archived_at` (migration 040), não `status='closed'`: a conversa
  sai da caixa e **nada é apagado**. Ela volta sozinha quando o cliente
  escreve de novo (o pipeline de entrada limpa o carimbo) ou quando o
  próprio operador responde a partir do filtro "Arquivadas" (o
  `sendMessage` limpa também). Só aparece para quem de fato atende
  aquela conversa — um observador não esconde da própria lista uma
  conversa que não é dele.
- **Abas Contatos / Grupos**, sem "Todos". O padrão passa a ser
  Contatos.
- **Um painel único de filtros** com "Quem atende" (todos, você, cada
  operador com número, número da casa) e as tags, que antes tinham um
  dropdown só delas. O contador no gatilho soma os dois, e o filtro de
  operador ganha chip removível na linha de filtros ativos.
- **"Atribuir" removido** da interface. A coluna continua existindo e
  sendo escrita pelo banner de IA, que atribui a conversa a quem assume
  o atendimento do robô — remover isso quebraria o handoff.

**Decisões que vale registrar:**
1. **Encerrar é `archived_at`, não `status='closed'`.** São coisas
   diferentes e a 040 já explicava o porquê: "fechada" é um veredito de
   fluxo que o operador registra e filtra; "encerrada/arquivada" é um
   estado de visualização que a próxima mensagem desfaz sozinha.
   Sobrepor as duas transformaria o filtro "Fechadas" num depósito de
   entulho.
2. **O botão diz "Encerrar atendimento", o filtro continua
   "Arquivadas".** Chamar o filtro de "Encerradas" o deixaria colado em
   "Fechadas", que já existe e significa outra coisa. O texto de ajuda
   do botão cita o nome real do filtro, para que os dois se encontrem.
3. **O filtro de operador lê o mesmo mapa conexão→operador do
   selo de titularidade.** Escolher "Bruno" seleciona exatamente as
   linhas que dizem "Atende: Bruno" — não há uma segunda definição de
   dono capaz de divergir da primeira.
4. **As opções do filtro vêm das conexões, não da lista de equipe.** Um
   colega sem número não atende conversa nenhuma; oferecê-lo seria uma
   opção que só devolve lista vazia.

**Resolvido:** pedido do usuário, com as quatro mudanças de usabilidade
listadas acima. O pano de fundo é o mesmo das etapas de operadores: uma
caixa desenhada para um número só ganha perguntas novas assim que passa
a ter vários.

Arquivos: `src/components/inbox/message-thread.tsx`,
`src/components/inbox/conversation-list.tsx`,
`src/app/(dashboard)/inbox/page.tsx`, `messages/{pt-BR,en,ko}.json`

## [2026-08-07] Quem atende a conversa passa a ser dito, não deduzido

**Antes:** com o modelo de operadores no ar, cada conversa tem exatamente
um operador que pode responder — é o dono do número em que ela vive. Mas a
interface nunca dizia quem era. Dava para **deduzir por ausência**: se o
campo de digitação não estava lá, a conversa era de outra pessoa. Isso tem
dois defeitos. Um campo de digitação que some parece tela quebrada, não
regra de negócio. E não dizia nada a quem *era* dono: justamente a pessoa
que pode responder não recebia confirmação nenhuma de que responder era
com ela. A única frase sobre o assunto era um texto cinza no rodapé da
thread, mostrado **só para quem observava**. Na lista de conversas não
havia sinal algum — só abrindo a conversa dava para descobrir de quem era.

O botão de transferir tinha o mesmo problema de visibilidade: um ícone de
14px, cinza, numa fileira de outros ícones cinzas do mesmo tamanho.

**Depois:**
- **Faixa de titularidade na thread**, logo abaixo do cabeçalho, sempre
  visível e para todo mundo — dono ou observador. Diz "Quem atende" e o
  nome, com cor e ícone por estado: sua (verde), de um colega nomeado
  (âmbar), transferida por você (âmbar), número da casa, ou não definido.
  Cada estado tem tooltip explicando a consequência, não só o rótulo —
  "Só {operador} pode responder — você acompanha".
- **Chip por linha na lista de conversas**, com a mesma resposta, para que
  "essa é minha?" se resolva enquanto se rola a lista, sem abrir nada.
- **Botão de transferir maior e destacado**: 36px em vez de 28, ícone de
  18px em vez de 14, com fundo e borda na cor primária e o rótulo
  "Transferir" ao lado do ícone a partir de `sm`.

**Decisões que vale registrar:**
1. **Um helper puro (`ownerView`) é a fonte única da regra**, usado pela
   thread e pela lista. Sem isso as duas telas responderiam a mesma
   pergunta por caminhos diferentes e acabariam divergindo.
2. **O número da casa entra no mapa de conexões com valor vazio**, em vez
   de ficar de fora. "É o número da casa" e "é uma conexão que ainda não
   carreguei" são respostas diferentes, e um `Map` que omite a primeira
   não consegue distingui-las.
3. **A lista não desenha chip no estado indefinido.** Enquanto a consulta
   de titularidade não volta, toda linha é indefinida; um chip dizendo
   "não definido" em todas e trocando logo depois pisca feio. Na thread,
   que é uma faixa só, ele aparece normalmente.
4. **"Quem atende" em vez de "dono/dona da conversa"** — mesma ideia, sem
   forçar concordância de gênero com uma pessoa cujo nome só se conhece em
   tempo de execução. Trocar é uma linha em `messages/pt-BR.json`
   (`Inbox.messageThread.ownerLabel`).

**Resolvido:** pedido do usuário de deixar "extremamente explícito quem é
a pessoa dona da conversa" e de tornar o ícone de transferência maior e
mais aparente. O pano de fundo é a Etapa 1 dos operadores: assim que a
conta passa a ter mais de um número, "de quem é esta conversa" vira a
pergunta que se faz o dia inteiro, e ela não tinha resposta na tela.

Arquivos: `src/lib/inbox/conversation-owner.ts` (novo),
`src/lib/inbox/conversation-owner.test.ts` (novo),
`src/components/inbox/message-thread.tsx`,
`src/components/inbox/conversation-list.tsx`,
`messages/{pt-BR,en,ko}.json`

## [2026-08-06] Operadores — migrations aplicadas em produção e dois defeitos corrigidos

> **Requer migration.** `supabase/migrations/046_operators_fix_unique_and_chain.sql`,
> aplicada **depois** da 045. O cabeçalho traz o SQL de reversão.
> As 044, 045 e 046 já estão aplicadas no projeto de produção
> (`qinerutevsfzyhdmqpbm`). O deploy do código saiu automaticamente com o
> push na `main` (o Hostinger constrói a cada push): os arquivos estáticos
> em `vbase.com.br` datam de 2026-08-06 23:41 UTC, ~2 min após o push.
> A ordem obrigatória — migrations antes do código — foi respeitada: as
> migrations entraram às 23:30 UTC, o build às 23:41 UTC.

**Antes:** as etapas 1 e 2 tinham sido escritas e revisadas, mas nunca
executadas contra um banco — a máquina de desenvolvimento não tinha
Postgres, CLI do Supabase nem Docker. Ao conferir o estado real do banco,
descobriu-se que a **044 já estava aplicada** em produção (todos os
índices, policies, funções e o gatilho conferiam com o arquivo), ao
contrário do que se supunha. Rodar as duas contra dados reais expôs dois
defeitos que não davam erro nenhum ao aplicar — os dois só apareceriam no
dia em que alguém tentasse *usar* o modelo de operadores:

1. **A constraint que a 044 não derrubou.** A 044 derruba
   `whatsapp_config_account_id_key`, a `UNIQUE(account_id)` criada pela
   migration 017. Só que a **migration 037 já tinha trocado essa
   constraint** por `whatsapp_config_account_id_provider_key`, uma
   `UNIQUE(account_id, provider)`. O `DROP ... IF EXISTS` da 044 não achou
   nada para derrubar e passou calado, e a constraint que de fato bloqueia
   o modelo continuou de pé. Resultado: conectar um **segundo número
   uazapi** na mesma conta falhava com 23505 — ou seja, o propósito
   inteiro da Etapa 1 era impossível. Como a conta só tinha um número
   conectado, nada disso aparecia na interface, e a 044 parecia aplicada e
   correta.
2. **`transfer_chain_id` sem default.** A 045 afirma que "toda conversa é
   uma cadeia de um elo só", mas garante isso com um `UPDATE` único,
   executado no instante em que a migration roda. A coluna ficou sem
   DEFAULT e sem gatilho, então **toda conversa criada depois nascia com a
   cadeia NULL**, e o invariante se quebrava sozinho já na primeira
   mensagem nova. Com a cadeia NULL, o bloco de histórico herdado desiste
   (`message-thread.tsx` verifica `!chainId`) e o ramo de cadeia de
   `can_read_conversation` é pulado.

**Depois:**
- A `UNIQUE(account_id, provider)` foi derrubada. A unicidade continua
  garantida — e de forma mais estrita — pelos dois índices parciais da
  044: um número por operador, no máximo um número da casa por conta.
- Um gatilho `BEFORE INSERT` em `conversations` preenche
  `transfer_chain_id` com o próprio `id` quando ele vem vazio. É gatilho e
  não DEFAULT porque uma expressão de DEFAULT não enxerga as outras
  colunas da linha — não há como escrever "o meu próprio id" ali. O
  `COALESCE` preserva a cadeia que `transfer_conversation` já grava na
  conversa de destino. Por ser no banco, vale também para o webhook de
  entrada, que escreve com a service role.
- **40 testes de comportamento** rodados contra o schema real, dentro de
  transações revertidas ao final (nenhum resíduo em produção): escopo de
  leitura `own`/`all`, a equivalência de `all` com `is_account_member`,
  bloqueio de auto-promoção de `inbox_scope` e `account_role` (42501), os
  três índices únicos incluindo o caso do `COALESCE` com número NULL,
  `transfer_conversation` ponta a ponta com as quatro recusas (grupo,
  destinatário sem número, para si mesmo, observador), a devolução
  reaproveitando a conversa de origem, o pause do fluxo ativo, e a
  assimetria central: quem recebeu **lê** as mensagens da origem e **não
  escreve** nelas (0 linhas no UPDATE, 42501 no INSERT).

**Resolvido:** o modelo de operadores agora funciona de fato. Sem a
correção 1, o primeiro operador a tentar parear o próprio celular
receberia um erro de chave duplicada e a Etapa 1 nunca sairia do papel —
era um defeito invisível, que só se revelaria em produção, no pior
momento. Sem a correção 2, a herança de histórico degradaria em silêncio
para toda conversa criada depois da migration.

**Nota de segurança (verificada, não é vulnerabilidade):** o
`REVOKE ALL ... FROM PUBLIC` das 044/045 não tira o `anon` das RPCs — o
Supabase re-concede EXECUTE ao `anon` por default privileges. Testado na
prática: o `anon` recebe 42501 em `transfer_conversation` e em
`set_member_inbox_scope` (as duas exigem `auth.uid()` não nulo) e lê zero
linhas de `conversations` e `messages`. O alerta do advisor do Supabase
sobre isso vale para 22 funções `SECURITY DEFINER` do projeto inteiro, não
é novidade destas migrations.

Arquivos: `supabase/migrations/046_operators_fix_unique_and_chain.sql` (novo)

## [2026-08-06] Operadores, Etapa 2 — transferir conversa com histórico herdado

> **Requer migration.** `supabase/migrations/045_conversation_transfer.sql`,
> aplicada **depois** da 044. O cabeçalho traz o SQL de reversão.
> **Branch `feat/operadores-multi-numero`.**

**Antes:** com a Etapa 1, cada operador tinha o próprio número e a própria caixa — mas não havia como passar uma conversa adiante. Quem precisasse repassar um atendimento só podia contar o caso por fora; o outro operador começava do zero, sem nada do que já tinha sido dito.

**Depois:**
- **Transferir não copia nada.** A conversa de destino (no número de quem recebe) guarda uma referência à de origem, e as duas passam a compartilhar um `transfer_chain_id`. A tela desenha o histórico anterior acima de uma divisória, somente leitura, e o atendimento novo abaixo.
- **Cadeia inteira.** Se o Bruno passar para o Carlos, o Carlos herda desde a Ana, com uma divisória por passagem.
- **Leitura alcança a cadeia; escrita não.** `can_read_conversation` aceita "algum elo desta cadeia é do meu número"; a escrita continua em `can_access_conversation`, sem cadeia. É isso que implementa "um dono ativo por vez, os demais observam" — e é o banco que impõe, não a tela.
- **Reabertura automática.** O cliente continua com o número antigo e pode escrever nele. Quando escreve, o pipeline de entrada limpa `handed_over_at` e a conversa volta a ser da Ana; o Bruno segue vendo tudo, porque está na mesma cadeia.
- **Mensagem de abertura sugerida, não obrigatória** — vem pronta e marcada. Sem ela o cliente não fica sabendo de nada e continua escrevendo para o número antigo; a caixinha explica isso na própria tela.
- **Grupos não são transferíveis** e o botão não aparece neles.

**Decisões que vale registrar:**
1. **Referência em vez de cópia** foi escolha de projeto, discutida antes de codar. Copiar quebraria a resposta a mensagens antigas (a cópia não carrega o id que o WhatsApp deu à mensagem), dobraria contagens em não lidas e relatórios, e envelheceria na hora que o cliente escrevesse no número antigo. O ganho colateral: o Bruno ver as mensagens novas da Ana sai de graça — elas estão na cadeia.
2. **`transfer_chain_id` em vez de recursão.** A pergunta "esta conversa é parente de alguma minha?" roda em toda linha avaliada pela RLS. Uma coluna indexável responde em uma comparação; um CTE recursivo por linha não é algo que uma policy possa se dar ao luxo de fazer.
3. **A mensagem de abertura usa o cliente de serviço**, não o do usuário. A conversa de destino é do número do outro operador, e escrever ali é justamente o que a RLS recusa. A autorização já tinha sido estabelecida pelo RPC uma instrução antes — a mensagem é o rabo daquela operação aprovada, não um ato novo.
4. **Falha na mensagem de abertura não desfaz a transferência.** Uma transferência pela metade seria pior que uma sem saudação: a saudação se redigita, uma transferência rasgada não se enxerga.
5. **O estado "entregue" é regra de fluxo, não fronteira de segurança**, e por isso vive na tela e não na RLS. A Ana responder a própria conversa transferida não é violação — é bagunça. A separação está documentada no código.

**Verificação:** typecheck limpo, build limpo, lint 0 erros, 146 testes nas áreas tocadas. 15 testes novos em `transfer-chain.test.ts` cobrem a ordenação por ponteiros (inclusive com timestamps idênticos), a fusão de cadeias, ciclos de ponteiro, e as três formas de ser observador.

**Não verificado:** o SQL não foi executado — não há Postgres nesta máquina.

Arquivos: `supabase/migrations/045_conversation_transfer.sql` (novo),
`src/lib/inbox/transfer-chain.ts` (novo), `src/lib/inbox/transfer-chain.test.ts` (novo),
`src/components/inbox/transfer-dialog.tsx` (novo),
`src/app/api/whatsapp/conversations/transfer/route.ts` (novo),
`src/components/inbox/message-thread.tsx`, `src/app/(dashboard)/inbox/page.tsx`,
`src/lib/whatsapp/inbound-pipeline.ts`, `src/hooks/use-auth.tsx`,
`src/types/index.ts`, `messages/*.json`

## [2026-08-06] Tela de payload cru: era cache de CDN, não erro de código

> Retoma a entrada de 2026-08-06 "Erro no app virava tela de payload cru", que
> tratou o **sintoma** (adicionou error boundaries) sem achar a causa. Esta é a causa.

**Antes:** ao entrar no CRM, às vezes a tela mostrava o payload cru do React Server Components como texto puro — `0:{"tree":...,"buildId":"..."}` — sem nenhum HTML. Relatado desta vez por um usuário recém-convidado, logo após aceitar o convite.

**Investigação.** A entrada anterior procurou o `throw` e não achou. **Não havia `throw` nenhum** — e é por isso que os error boundaries nunca capturaram nada: o aplicativo não chegou a rodar.

A causa está em `next.config.ts`. A regra de cache aplicava

    public, max-age=0, s-maxage=300, stale-while-revalidate=86400

a todo caminho que não fosse `/api` nem `/_next/static` — **incluindo `/dashboard`, `/inbox` e todas as telas autenticadas**. O comentário que estava lá afirmava que essas rotas eram "server-rendered per request" e portanto seguras. Não são: são componentes de cliente, então o Next pré-renderiza o esqueleto como **estático** (`○` na saída do build, verificado).

E aí entra o detalhe que fecha o caso: **uma URL, duas respostas.** Uma navegação do navegador em `/dashboard` recebe HTML; as buscas do próprio roteador do Next (prefetch, navegação client-side) recebem o payload RSC **do mesmo caminho**, distinguidas só pelo cabeçalho de requisição `RSC`. O Next avisa disso com `Vary: RSC, Next-Router-State-Tree, …` — mas um CDN que ignora `Vary` (o da Hostinger, o mesmo que causou o incidente de chunks obsoletos documentado no próprio comentário) indexa as duas pelo caminho apenas. A que chegar primeiro no cache é servida para todo mundo por 5 minutos — e por até 24 h a mais enquanto revalida.

Quando o payload RSC ganha essa corrida, quem abre `/dashboard` recebe **o payload como documento**. Explica tudo: intermitente, imune a janela anônima (o cache é do servidor), e atinge quem acabou de ser convidado — essa pessoa chega via `window.location.href = '/dashboard'` logo depois de outra sessão ter feito prefetch da mesma rota.

**Depois:**
- Rotas autenticadas, mais `/join/<token>`, `/login` e `/signup`, respondem `private, no-store, must-revalidate`. A regra pública passou a **excluir** esses caminhos em vez de só sobrepô-los — o Next mescla os cabeçalhos de todas as regras que casam, e dois `Cache-Control` conflitantes deixariam a escolha para o CDN.
- A lista de caminhos vem de `PROTECTED_PREFIXES` (`src/lib/auth/session-gate.ts`), importada pelo `next.config.ts`. Uma seção nova adicionada lá não volta a ser cacheada por esquecimento — que é exatamente o tipo de deriva que criou o buraco de rotas desprotegidas na entrada de 2026-08-06.
- O `proxy.ts` carimba o mesmo cabeçalho em tudo que passa por `needsSession`, inclusive nos redirecionamentos. Um redirect cacheado seria sua própria pane: prenderia todo visitante no `/login` até a entrada expirar.

**Verificação — servindo por HTTP, não só compilando.** Subi o build de produção e conferi os cabeçalhos:

| Rota | Cache-Control |
|---|---|
| `/dashboard`, `/inbox`, `/settings`, `/activities` | `private, no-store, must-revalidate` |
| `/join/abc`, `/login`, `/signup` | `private, no-store, must-revalidate` |
| `/dashboard` **com cabeçalho `RSC: 1`** | `private, no-store, must-revalidate` |
| `/` (pública) | `public, s-maxage=300, …` — inalterada |

A última linha é a prova do "antes": é exatamente a regra que se aplicava ao `/dashboard`. Três testes novos no `proxy.test.ts` travam o comportamento.

**Resolvido:** relato do usuário com print da tela crua em `vbase.com.br/dashboard`, após um convidado aceitar o convite e entrar.

**Em aberto:** não tenho acesso ao painel da Hostinger para confirmar que o CDN de fato ignora `Vary` — a hipótese é sustentada pelo incidente anterior de chunks obsoletos, documentado no mesmo arquivo, que só se explica por cache de borda ignorando variação. De todo modo, `no-store` fecha a porta independentemente de qual CDN está na frente. **Se a tela voltar a aparecer depois deste deploy, me avise imediatamente** — significaria que a causa é outra e o diagnóstico precisa recomeçar.

Arquivos: `next.config.ts`, `src/proxy.ts`, `src/proxy.test.ts`

## [2026-08-06] Operadores, Etapa 1 — um número por pessoa e caixa separada

> **Requer migration.** `supabase/migrations/044_operators_multi_number.sql`.
> O cabeçalho dela traz o SQL de reversão completo e diz em que ponto a
> reversão deixa de ser possível (quando o segundo número for conectado).
> **Branch `feat/operadores-multi-numero`, não está na `main`.**
> Ponto de retorno: tag `marco/numero-unico-caixa-compartilhada`.

**Antes:** uma conta tinha exatamente um número de WhatsApp (`whatsapp_config` com `UNIQUE(account_id)`) e todos os membros dividiam uma caixa de entrada. A conversa era identificada por (conta, contato), então o mesmo cliente sempre caía na mesma thread, viesse de qual número viesse — e como só havia um, isso nunca apareceu.

**Depois:**
- **Um número por operador.** `whatsapp_config.operator_user_id` diz de quem é a linha; NULL é o "número da casa", que é o que a conexão existente vira ao aplicar a migration. Dois índices parciais garantem um número por operador e no máximo um da casa.
- **Escopo de caixa.** `profiles.inbox_scope` ('all' | 'own'), ortogonal ao cargo: cargo é o que a pessoa *pode fazer*, escopo é o que ela *pode ver*. Um gerente que atende é admin + own.
- **A chave da conversa** passou de (conta, contato) para (conta, contato, número), com backfill antes da troca do índice. É o que permite duas conversas com o mesmo cliente.
- **`can_access_conversation()`** substitui `is_account_member()` nas policies de conversas, mensagens e reações. Com escopo 'all' ela devolve exatamente o que devolvia antes — por isso aplicar a migration não muda nada até alguém ser colocado em 'own'.
- **O envio pergunta pela conversa, não pela conta.** `resolveConnectionForConversation` substitui `resolveConnection` no composer, nas reações, nos fluxos, nas automações e na IA (que passa pelo motor de fluxos). Uma resposta que saísse pelo número errado chegaria ao cliente como mensagem de um desconhecido, num chat que ele nunca abriu.
- **Operador conecta o próprio número.** As rotas connect/status/disconnect aceitam `scope: 'account' | 'mine'`; o default continua sendo o número da casa, admin-only, porque criar conexão gasta cota de instância na UAZAPI e ninguém deve descobrir uma segunda instância por um botão ter mudado de sentido.
- **Tela de Membros** ganhou o seletor de escopo, alimentado pelo RPC `set_member_inbox_scope`.

**Três coisas que quase passaram batido e estão corrigidas:**
1. **`inbox_scope` é coluna de privilégio.** Sem entrar no gatilho da migration 034, qualquer operador faria `UPDATE profiles SET inbox_scope='all'` direto do navegador e voltaria a ver tudo. A migration estende o gatilho.
2. **Seis consultas usavam `.maybeSingle()` em `whatsapp_config` filtrando só por conta** — e `.maybeSingle()` *erra* com mais de uma linha. Todas quebrariam no dia do segundo número: connect, status, disconnect, o banner da caixa de entrada, a visão geral de Configurações, o resolvedor de conversa da API pública e o resolvedor de autor de contatos.
3. **"Limpar caixa"** faz um UPDATE em massa sem filtro de dono, apoiado só na RLS. Com a policy de UPDATE escopada, um operador passa a arquivar apenas as próprias conversas — sem isso ele limparia a caixa dos colegas.

**Bug pré-existente corrigido de passagem:** `uazapi-connect.tsx` pedia o namespace de tradução `Settings.whatsapp.uazapi`, que não existe — as chaves vivem em `Settings.whatsapp`. Todos os rótulos daquele cartão resolviam para mensagem ausente.

**Resolvido:** primeira etapa do modelo de operadores desenhado com o usuário. Ainda **não** inclui transferência de conversa, histórico herdado nem o estado de observador — isso é a Etapa 2.

**Não verificado:** o SQL não foi executado (não há Postgres, CLI do Supabase nem Docker nesta máquina). Typecheck limpo, build limpo, 577 testes passando — as 5 falhas de fuso/ICU seguem pré-existentes.

Arquivos: `supabase/migrations/044_operators_multi_number.sql` (novo),
`src/lib/whatsapp/uazapi-client.ts`, `src/lib/whatsapp/uazapi-client.test.ts` (novo),
`src/lib/whatsapp/connection-target.ts` (novo), `src/lib/whatsapp/send-message.ts`,
`src/lib/whatsapp/resolve-conversation.ts`, `src/lib/flows/whatsapp-send.ts`,
`src/lib/automations/whatsapp-send.ts`, `src/lib/api/v1/contacts.ts`,
`src/app/api/whatsapp/uazapi/{connect,status,disconnect}/route.ts`,
`src/app/api/whatsapp/react/route.ts`, `src/app/api/account/members/route.ts`,
`src/app/api/account/members/[userId]/route.ts`, `src/app/(dashboard)/inbox/page.tsx`,
`src/app/(dashboard)/settings/page.tsx`, `src/components/settings/whatsapp-panel.tsx` (novo),
`src/components/settings/uazapi-connect.tsx`, `src/components/settings/members-tab.tsx`,
`src/components/settings/settings-overview.tsx`, `src/types/index.ts`, `messages/*.json`

## [2026-08-06] Convite recusado porque o convidado abriu a tela de Funis

> **Requer migration.** `supabase/migrations/043_invite_ignores_empty_pipeline.sql`.
> Ela substitui `redeem_invitation()` via `CREATE OR REPLACE` — mesma assinatura,
> mesmos SQLSTATEs. Enquanto não for aplicada, o convite continua sendo recusado
> no cenário abaixo.

**Antes:** `redeem_invitation()` (migration 019) recusava a entrada quando a conta pessoal do convidado tivesse qualquer linha de domínio — e `pipelines` estava nessa lista. Só que funil é a única coisa do app que aparece **sem ninguém criar**: a tela de Funis semeia um "Sales Pipeline" padrão na primeira visita (`seedDefaultPipeline`). Então a sequência

    cadastra → entra → clica em "Funis" → aceita o convite

terminava em *"Your account already contains data; sign up with a different email to join this one"*. O convidado era obrigado a criar um segundo e-mail por ter aberto um menu. Nada na conta dele merecia proteção: o funil estava vazio e ele nunca tinha tocado nele.

**Depois:** um funil conta como dado quando **tem negócios**, não quando apenas existe. A sonda de `pipelines` virou uma sonda de `deals` com `JOIN pipelines` — o join é o que garante que um negócio conte mesmo se o `deals.account_id` (nullable desde a 017) não tiver sido preenchido. Todos os outros itens da lista continuam iguais: contatos, conversas, disparos, automações, fluxos, modelos, tags, campos personalizados, notas e conexão de WhatsApp seguem bloqueando a entrada.

O funil vazio some junto com a conta pessoal no fim da função — `pipelines.account_id` é `ON DELETE CASCADE` (017) e `pipeline_stages.pipeline_id` cascateia do funil (001). Não precisou de limpeza explícita.

**Trade-off, dito abertamente:** quem montar um funil à mão, com etapas customizadas e nenhum negócio, e depois entrar em outra conta, perde esse funil. Ele estava abandonando a conta onde o funil vivia de qualquer forma, e não havia trabalho ali dentro. É um preço muito menor do que bloquear todo convidado que clicou no menu errado antes.

**Resolvido:** pedido do usuário depois de eu mapear a estrutura do projeto e encontrar essa armadilha. Ela atingia qualquer pessoa convidada que desse uma olhada no CRM antes de aceitar — ou seja, o comportamento mais natural do mundo.

**Não verificado localmente:** não há Postgres, `psql`, CLI do Supabase nem Docker nesta máquina, então o SQL não foi executado. A função foi copiada da 019 com uma única ramificação trocada. Aplicar pelo editor SQL do Supabase: `CREATE OR REPLACE` é atômico, então ou passa ou falha sem deixar estado quebrado.

Arquivos: `supabase/migrations/043_invite_ignores_empty_pipeline.sql` (novo)

## [2026-08-06] Login que só recarregava a tela e limpava os campos

**Antes:** às vezes, com e-mail e senha corretos, o login não entrava — a página recarregava, os campos limpavam e nenhuma mensagem aparecia. Intermitente, sem padrão aparente.

**Causa.** O middleware chamava `supabase.auth.getUser()`, que é uma ida à rede até o servidor de Auth, e lia as duas respostas possíveis como se fossem a mesma: *"esse token não vale"* e *"não consegui perguntar"* chegam ambas como `user: null`. Uma queda de rede, um 429 do limitador de requisições ou um 5xx do Supabase na primeira navegação depois do login mandava o usuário de volta para `/login`. A sessão estava perfeita.

Agravante: o `getUser()` rodava em **toda** requisição que casasse o matcher — payloads RSC, prefetches, `/api/v1/*` (que autentica por chave de API) e até os webhooks do provedor. Cada uma consumia cota de rate limit do Auth. O excesso de chamadas estava *fabricando* os 429 que causavam as falhas.

**Depois:**
- Só um veredito de verdade redireciona: 4xx do servidor de Auth, ou ausência de cookie de sessão. Resposta inconclusiva (rede, 429, 5xx) **com cookie presente** deixa a requisição passar — as páginas são protegidas por RLS e o shell do dashboard reverifica no cliente, então uma sessão realmente morta ainda chega ao login, por evidência.
- A verificação foi reduzida às rotas que precisam dela. Webhooks e API pública não tocam mais no servidor de Auth.
- `getUser()` embrulhado em try/catch — ele relança erros que não são de auth, e isso derrubava a página com 500.
- Quem é desviado leva `?redirectedFrom=` na URL: a tela explica ("sua sessão expirou ou não pôde ser verificada") e o login devolve a pessoa à página onde ela estava, aceitando só caminhos do próprio site.
- O login confere se a sessão foi mesmo gravada antes de navegar (cookies bloqueados viram mensagem, não loop) e trata falha de rede — antes o botão ficava em "Entrando..." para sempre.
- `middleware.ts` → `proxy.ts`, seguindo a depreciação do Next 16 que o build já avisava. Rename de arquivo e de função, conforme o codemod oficial.

**Resolvido:** relato do usuário de que o CRM "não entra, só recarrega e limpa os campos". 20 testes novos cobrem os três cenários que causavam o bug (rede fora, 429, e o 401 legítimo que *deve* redirecionar) e o open-redirect no `redirectedFrom`.

Arquivos: `src/middleware.ts` → `src/proxy.ts`, `src/proxy.test.ts`,
`src/lib/auth/session-gate.ts` (novo), `src/lib/auth/session-gate.test.ts` (novo),
`src/app/(auth)/login/page.tsx`, `messages/*.json`

## [2026-08-06] Metade do histórico sumia quando a resposta era pelo celular

**Antes:** conversa continuada no aplicativo do WhatsApp Business aparecia no CRM só com a parte do cliente. As respostas digitadas no celular não entravam no histórico.

**Causa.** O webhook descartava toda mensagem marcada como `fromMe`, com a intenção de evitar o eco dos envios do próprio CRM. Só que o provedor marca duas coisas diferentes com essa flag: `wasSentByApi` é o nosso envio voltando (esse já está gravado), e um `fromMe` puro é alguém digitando em outro aparelho do mesmo número. A segunda era jogada fora.

**Depois:** a regra virou `classifyDelivery` (pura, testada) e mensagens de outro aparelho são gravadas como `sender_type='agent'` — idênticas às enviadas pelo composer. Junto:
- fluxos, automações e resposta automática por IA **não** disparam nesse caminho — existem para responder ao cliente, e disparar ali faria o CRM responder a si mesmo;
- o nome do remetente é ignorado nessas mensagens: uma mensagem nossa carrega o *nosso* push name e renomearia o contato;
- checagem por id do provedor antes de inserir, cobrindo reentrega do webhook e conexões antigas que ecoam os envios da API;
- contador de não lidas zera em vez de subir (responder pelo celular é ter lido a conversa);
- flow ativo é pausado, mesmo sinal de "humano assumiu" que o envio pelo CRM já dava;
- reações feitas por nós no celular também entram, como `actor_type='agent'`.

Na mesma leva, dois pedidos do usuário na Caixa de Entrada: o diálogo de **Nova conversa** agora abre nos contatos salvos (busca por nome, empresa ou número, com dígitos normalizados), com a digitação manual atrás de uma aba; e a **busca de conversas** sugere contatos a partir da primeira letra em vez da segunda — antes a primeira tecla mostrava "nenhuma conversa encontrada" e mais nada, o que parecia um CRM vazio.

**Resolvido:** relato do usuário com print do CRM ao lado do WhatsApp Business mostrando as mensagens ausentes. Vale só daqui pra frente — o que foi descartado antes do deploy não ficou gravado em lugar nenhum.

Arquivos: `src/lib/whatsapp/delivery-direction.ts` (novo),
`src/lib/whatsapp/delivery-direction.test.ts` (novo),
`src/lib/whatsapp/inbound-pipeline.ts`,
`src/app/api/whatsapp/uazapi/webhook/[connectionId]/[secret]/route.ts`,
`src/components/inbox/new-conversation-dialog.tsx`,
`src/components/inbox/conversation-list.tsx`, `messages/*.json`

## [2026-08-06] Criar atividade direto da Caixa de Entrada

**Antes:** não havia como agendar um follow-up sem sair da conversa. O atendente precisava abrir Atividades e procurar o contato de novo numa lista.

**Depois:** o painel de contato ganhou uma seção **Atividades**, entre Negócios e Notas, reaproveitando o `ContactActivitiesPanel` que a gaveta de contatos já usa — criar, concluir e excluir se comportam igual nos dois lugares. O painel recebe o contato da conversa aberta, então o `contact_id` é gravado no insert e a atividade aparece no quadro, no calendário e na aba do contato. Visível só para quem tem permissão de escrita, como tags e negócios.

**Resolvido:** pedido do usuário. Continua indisponível no celular, onde o painel de contato inteiro é oculto (`hidden lg:block`) — vale para tags, negócios e notas também.

Arquivos: `src/components/inbox/contact-sidebar.tsx`, `messages/*.json`

## [2026-08-06] Erro no app virava tela de payload cru; rotas novas sem proteção

**Antes:** ao entrar com uma conta de agente recém-criada, a tela mostrou o payload bruto do React Server Components como texto puro (`:HL[...]`, `0:{"tree":...}`) — ilegível, sem mensagem e sem saída além da barra de endereço.

**Investigação.** Comecei pelos dados: o agente tinha perfil, `account_id` e `account_role` corretos, e a conta existia — nenhum órfão. O middleware não ramifica por papel. O `useAuth` já é bem defensivo (try/catch/finally e timer de segurança) e o carregador de i18n já tem fallback. **Não consegui reproduzir nem apontar o `throw` exato** por leitura estática, e digo isso abertamente.

O que ficou inequívoco foi outra coisa: **o projeto não tinha nenhum error boundary.** Nem `error.tsx`, nem `global-error.tsx`, nem `not-found.tsx`. Sem eles, qualquer exceção derruba a árvore inteira e o navegador fica exibindo o que sobrou do stream — exatamente a tela do print. A causa raiz do *sintoma* é essa ausência, independente de qual erro disparou.

**Depois:**
- **`global-error.tsx`** — captura falha do layout raiz, o único lugar que um `error.tsx` comum não alcança (ele vive dentro do layout que quebrou). Renderiza o próprio `<html>`/`<body>`, sem i18n, sem design system e com estilos inline: o layout raiz é onde moram o provedor de locale e o script de tema, então qualquer import de lá pode ser justamente o que falhou.
- **`error.tsx`** na raiz e **`(dashboard)/error.tsx`** por segmento. O do dashboard mantém menu e cabeçalho de pé, então uma tela quebrada vira "o Painel falhou", não "o CRM caiu".
- Os três mostram o **`digest`** do erro. Em build de produção a mensagem real é removida, e o digest é o único elo com o log do servidor.
- **`not-found.tsx`** — sem ele, uma URL errada servia o 404 cru do Next, indistinguível de app quebrado.
- **Middleware: rotas novas estavam desprotegidas.** `protectedPaths` não incluía `/activities`, `/flows`, `/agents` nem `/notifications` — visitá-las sem sessão pulava o redirecionamento e caía no shell, que só então mandava para o login pelo cliente. Um piscar do CRM vazio e um render inútil de páginas cujas consultas o RLS ia recusar de qualquer forma.

**Verificação — em execução, não só compilando.** Subi o build de produção e testei via HTTP:

| Teste | Resultado |
|---|---|
| URL inexistente | 404, `text/html`, página traduzida |
| `/dashboard` sem sessão | 307 → `/login` |
| `/activities` sem sessão (o buraco) | 307 → `/login` |
| Rota que lança no servidor | 500, `text/html`, **nenhum payload cru no corpo** |

Duas tentativas de teste foram inválidas antes de acertar, e vale registrar: uma pasta iniciada com `_` é privada no Next e não vira rota (caiu no 404), e sob `(dashboard)` o shell cobre tudo com o spinner de sessão antes de a página renderizar. A rota de teste foi removida e o build refeito limpo.

Build limpo, typecheck limpo, lint 0 erros, 549 testes passando (as 5 falhas de fuso/ICU são pré-existentes).

**Em aberto:** se a tela voltar a aparecer, agora ela mostra um código de erro. Me passe esse código que eu localizo a origem — era exatamente o que faltava para diagnosticar.

Arquivos: `src/app/global-error.tsx` (novo), `src/app/error.tsx` (novo),
`src/app/(dashboard)/error.tsx` (novo), `src/app/not-found.tsx` (novo), `src/middleware.ts`

## [2026-08-05] Sino de notificações no topo, com alertas de atividades

> **Requer migration.** `supabase/migrations/042_activity_notifications.sql`.
> Ela renomeia uma coluna, adiciona outra, estende os tipos de notificação, cria o
> gatilho de atribuição e **substitui a assinatura** de `notify_due_activities()`.
> Enquanto não for aplicada, a varredura falha com aviso no console (sem quebrar nada).

**Antes:** o sino ficava no menu lateral esquerdo com um contador numérico, e a única notificação que existia era "conversa atribuída".

**Depois:**

**Sino no canto superior direito**, junto dos outros controles de conta, reduzido a um ícone. Quando há algo não lido aparece uma **bolinha vermelha** sobre ele. Troquei o contador numérico pela bolinha de propósito: o número exato nunca foi o ponto — o que importa é "tem algo esperando por mim" contra "não tem", e a bolinha diz isso mais rápido. A bolinha tem um anel na cor do fundo do cabeçalho para continuar legível onde encosta no contorno do sino.

**Três momentos de notificação para atividades**, em vez do alerta único da 041:

| Tipo | Quando dispara |
|---|---|
| Atividade atribuída | Alguém te atribui uma atividade (gatilho, imediato) |
| Atividade para hoje | A atividade cai no dia de hoje |
| Atividade vencida | O prazo passou e ela continua em aberto |

- **Por que três marcações em vez de uma flag:** cada uma dispara em momento diferente e cada uma deve disparar no máximo uma vez. Um único `notified_at` não consegue expressar "já avisei que é para hoje, ainda não avisei que atrasou".
- **Vencida é avaliada primeiro e consome a marcação de "hoje".** Uma tarefa das 9h que ninguém viu até as 14h deve tocar **uma vez, como atrasada** — não duas, como "é hoje" seguido de "venceu".
- **A atribuição pula auto-atribuição**, igual ao gatilho de conversas: "lembrar a mim mesmo" é o caso comum, e ser avisado de um trabalho que você acabou de se dar é ruído.
- **Só o vencido ganha cor.** É a única coisa ali que já está custando algo. E ele mantém o vermelho mesmo depois de lido — o prazo continua perdido, e apagá-lo junto com o resto enterraria justamente a linha que precisa de ação.

**Fuso horário.** "Hoje" é uma propriedade de quem lê, não do servidor. O aviso precisa chegar quando o dia do atendente começa, e a meia-noite de um atendente brasileiro é 03:00 UTC. Por isso a varredura passou a **receber os limites do dia do próprio navegador** em vez de derivá-los do `NOW()`, que mandaria o aviso três horas fora.

**A página de notificações foi traduzida.** Ela estava inteiramente em inglês fixo, sem namespace de i18n nenhum — o que passava batido enquanto era um recurso secundário, mas não agora que ela é o centro do fluxo de atividades. O rótulo do tipo é renderizado traduzido na hora, não congelado em inglês no banco como faz o gatilho da migration 027.

**Verificação:** build limpo, typecheck limpo, lint 0 erros, paridade de i18n nos três idiomas, 549 testes passando (as 5 falhas de fuso/ICU são pré-existentes).

Ao investigar, confirmei que a varredura da 041 **não** tinha defeito: das 3 atividades existentes, duas estavam concluídas e a terceira vencia 6 segundos depois da consulta. Não havia o que disparar.

**Não verificado ao vivo:** a 042 ainda não foi aplicada, então o gatilho e a nova varredura não foram exercitados contra o banco.

Arquivos: `supabase/migrations/042_activity_notifications.sql` (novo),
`src/components/layout/{header,sidebar}.tsx`, `src/app/(dashboard)/notifications/page.tsx`,
`src/hooks/use-due-activity-sweep.ts`, `src/types/index.ts`, `messages/{pt-BR,en,ko}.json`

## [2026-08-05] Cursor de mão em tudo que é clicável

**Antes:** botões mostravam a seta comum em vez da mãozinha, então nada parecia clicável. Alguns pontos funcionavam e a maioria não — sem padrão aparente.

**Causa:** o Preflight do Tailwind v4 define `cursor: default` em `<button>`. É uma mudança deliberada em relação à v3, alinhando com o padrão cru do navegador. O sintoma da inconsistência estava no próprio código: `cursor-pointer` remendado à mão em **10 arquivos** — os que alguém percebeu e corrigiu pontualmente.

**Depois:** uma regra base única em `globals.css` restaura o cursor em tudo que é acionável.
- Baseada em **semântica**, não numa classe utilitária: componentes novos herdam de graça, sem ninguém precisar lembrar.
- Cobre também os papéis ARIA (`menuitem`, `option`, `tab`, `checkbox`, `switch`…), porque o Base UI renderiza vários controles como `div` com papel em vez de elemento nativo.
- `<a href>` ficou de fora — o navegador já acerta isso, e âncora sem `href` não é link.
- **Rótulos ficaram de fora de propósito:** a maioria deles fica na frente de campos de texto, onde a mãozinha prometeria um clique que só move o foco.
- Controles desabilitados recebem `not-allowed`, não a mão. Uma mão sobre um botão desativado promete algo que não vai acontecer; `not-allowed` diz "isto é um controle, e está desligado" — coisa que a seta comum (que faz o elemento parecer texto inerte) não diz. A regra de desabilitado tem especificidade maior, então vence a de ponteiro.

Antes de generalizar, conferi se havia clicáveis sem elemento semântico: só 3 casos no projeto, e nenhum é uma opção de verdade (dois são invólucros de `stopPropagation` em volta de botões reais, um é um backdrop invisível). Os `cursor-pointer` manuais que já existiam foram mantidos — concordam com a regra global e removê-los seria mexer em 10 arquivos sem mudar comportamento.

**Verificação:** build limpo, typecheck limpo, lint 0 erros, 549 testes passando (as 5 falhas de fuso/ICU são pré-existentes). Confirmei as duas regras no CSS compilado — uma utilidade do Tailwind v4 que não é gerada falha em silêncio.

Arquivos: `src/app/globals.css`

## [2026-08-05] Resposta a mensagem interativa chegava vazia; negócios editáveis no painel

### 1. Resposta de botão vinha sem texto

**Antes:** quando o cliente tocava um botão de uma mensagem interativa, a mensagem aparecia como um balão vazio no chat.

**Causa:** o normalizador do webhook lia só `msg.text`. Numa resposta de botão o `text` vem **vazio** — o rótulo tocado viaja em **`vote`**. Comprovado contra a mensagem real no histórico do provedor: `messageType: TemplateButtonReplyMessage`, `buttonOrListid: btn_1`, `vote: abc`, sem `text`. A especificação descreve o campo como "Dados de votação de enquete e listas", ou seja, ele serve enquete, lista e botão.

O roteamento nunca quebrou — o `buttonOrListid` sempre chegou, então os Fluxos avançavam corretamente. O que faltava era só o texto visível, o que fazia parecer que a resposta tinha sumido.

**Depois:** `contentText` passa a cair em `vote` quando `text` está vazio. O `text` continua tendo precedência — uma mensagem comum nunca é um voto. Como efeito colateral, o título da resposta que vai para o motor de Fluxos também deixa de ser string vazia.

Reparei em produção a 1 mensagem que já tinha ficado em branco, recuperando o rótulo (`btn_1` → "abc") do histórico do provedor.

### 2. Negócios não eram editáveis pelo painel do contato, e o valor mostrava "BRL"

**Antes:** o cartão do negócio no painel lateral era só leitura — para mudar etapa, valor ou nome era preciso ir até o funil. E o valor era montado concatenando o código ISO cru com o número, produzindo `BRL15.000`.

**Depois:**
- Clicar no negócio abre o **mesmo formulário** que o quadro de funis usa, em modo de edição. Etapa, valor, moeda e nome se comportam igual em qualquer lugar de onde o negócio seja editado, porque é literalmente o mesmo componente.
- O seletor de etapas é limitado ao funil **do próprio negócio**. Oferecer as etapas de outro funil deixaria salvar o negócio numa etapa que não pertence a ele.
- Estado de edição separado do de criação: um negócio existente já sabe seu funil, então perguntar qual usar seria absurdo — essa pergunta só faz sentido ao criar.
- O valor passa a usar o `formatCurrency` compartilhado do app, que rende o símbolo e o agrupamento certos: **R$ 15.000**.
- Só quem tem permissão de escrita (agente ou acima) consegue abrir a edição.

**Verificação:** build limpo, typecheck limpo, lint 0 erros, paridade de i18n passando, 549 testes passando (as 5 falhas de fuso/ICU são pré-existentes). A causa do balão vazio foi confirmada contra a mensagem real na instância, não inferida.

Arquivos: `src/app/api/whatsapp/uazapi/webhook/[connectionId]/[secret]/route.ts`,
`src/components/inbox/contact-sidebar.tsx`, `messages/{pt-BR,en,ko}.json`

## [2026-08-05] Cabeçalho do chat: foto, tags e botão de recolher reposicionado

**Antes:** o cabeçalho da conversa mostrava só a inicial do contato num círculo cinza, não mostrava tags, e o botão de recolher o painel de informações ficava no meio dos controles da conversa (antes do atualizar, do status e do atribuir).

**Depois (na ordem dos números do print):**

1. **Botão de recolher foi para a extremidade direita**, encostado no painel que ele controla. Ele comanda a coluna imediatamente à direita — colado nela, o botão aponta para o que ele faz; no meio da fileira lia-se como só mais um controle da conversa.
2. **Foto do contato no cabeçalho**, com o mesmo tratamento da lista de conversas: foto quando existe, ícone de grupo para grupos, inicial como último recurso. O mesmo contato passa a ter a mesma cara nos dois lugares.
3. **Tags ao lado do número**, com o mesmo estilo de chip do painel e da lista. Limitadas a duas, com `+N` para o excedente — o cabeçalho ainda carrega status e atribuição, e a partir da terceira chip o telefone começa a perder dígitos. As chips encolhem antes do número.

**Correção que veio junto:** `activeContact` era congelado no momento da seleção e nunca mais atualizado. Com tags e foto agora no cabeçalho, isso apareceria como dado velho — marcar uma tag no painel não mudaria nada no topo até clicar em outra conversa e voltar. A lista de conversas passa a re-hidratar o contato aberto a cada recarga. Como o `rowsEqual` já filtra recargas sem mudança, isso não custa nada quando nada mudou.

Detalhe de implementação: a re-hidratação lê o id da conversa aberta por um `ref`, não chamando `setActiveContact` de dentro de um atualizador de `setActiveConversation` — atualizadores precisam ser puros, e o StrictMode os invoca duas vezes.

**Verificação:** build limpo, typecheck limpo, lint 0 erros, 549 testes passando (as 5 falhas de fuso/ICU são pré-existentes). O único aviso novo é o de `<img>` do Next, o mesmo que a lista de conversas e o painel do contato já carregam para avatares.

Arquivos: `src/components/inbox/message-thread.tsx`, `src/app/(dashboard)/inbox/page.tsx`

## [2026-08-05] Painel do contato não rolava

**Antes:** o painel lateral do contato (tags, negócios, notas) cortava no meio e não dava para rolar até o fim. Quanto mais notas, mais conteúdo ficava inalcançável.

**Causa:** o painel usava `flex-1` **sem `min-h-0`**. Um filho de flex tem `min-height: auto` por padrão, então em vez de encolher para o espaço que sobrou, ele crescia para caber todo o conteúdo — e o excesso era cortado pelo `overflow-hidden` do inbox, sem nada para rolar. É exatamente a mesma armadilha já documentada na lista de conversas (issue #229); o painel do contato tinha ficado de fora.

**Depois:**
- `min-h-0` no contêiner de rolagem, que é o que faz ele encolher e passar a rolar de verdade.
- Nova utilidade `no-scrollbar` no `globals.css` esconde a barra sem desligar a rolagem: roda, trackpad, toque e teclado continuam funcionando normalmente — só a barra some. Deliberado nesta largura: uma calha permanente ao lado de uma coluna de 280px é boa parte do que deixa o painel apertado.
- O `ScrollArea` do Base UI saiu deste painel. Ele existe para desenhar uma barra estilizada; sem barra alguma, é maquinário sem função — a rolagem nativa faz o mesmo com menos camada.

Deixei um comentário na utilidade avisando para não usá-la onde a barra é a única pista de que existe mais conteúdo abaixo. Aqui não é o caso: o conteúdo do painel é claramente contínuo.

Conferi se o mesmo defeito existia em outros painéis — a lista de conversas já tinha `min-h-0`, e não há outro caso.

**Verificação:** build limpo, typecheck limpo, lint 0 erros, e confirmei que a regra foi gerada no CSS compilado (`no-scrollbar{scrollbar-width:none;...}`).

Arquivos: `src/components/inbox/contact-sidebar.tsx`, `src/app/globals.css`

## [2026-08-05] Atividades com prazo, calendário e quadro; busca sugere contatos salvos

> **Requer migration.** `supabase/migrations/041_activities.sql` precisa ser aplicada
> no Supabase. Ela cria a tabela `activities`, estende o tipo das notificações e
> registra a função `notify_due_activities()`.

### 1. Busca do inbox sugere contatos salvos

**Antes:** buscar por alguém que ainda não tinha conversa não retornava nada — o que se lê como "essa pessoa não está no CRM", quando na verdade ela está, só não tem thread.

**Depois:** abaixo das conversas aparece uma seção "Contatos salvos" com até 5 contatos que batem com a busca e **não têm conversa ainda**. Um clique abre a conversa, passando pela mesma rota validada de "nova conversa".
- Contatos que já têm conversa são excluídos da sugestão: a lista acima já é a resposta melhor para eles.
- Grupos não aparecem — não dá para iniciar um grupo do WhatsApp em que você nunca foi incluído.
- A seção fica **fora** do estado vazio, então também aparece quando a busca encontrou threads: a pessoa que você quer pode ser as duas coisas.

### 2. Atividades

Nova seção **Atividades** no menu lateral, e uma aba **Atividades** dentro de cada contato.

**Modelo (migration 041).** Uma atividade tem título, observações, prazo, responsável e (opcionalmente) um contato.
- O prazo é `TIMESTAMPTZ`, não uma data. "Ligar terça às 15h" é o caso normal; uma coluna só-data empilharia tudo no mesmo ponto do dia e tornaria as visões de dia e semana inúteis.
- **As colunas do quadro não são armazenadas.** São derivadas do prazo contra o relógio de quem está lendo, porque "hoje" depende do fuso do leitor — e uma coluna gravada estaria errada na virada da meia-noite seguinte.
- `assigned_to` (quem deve fazer, e quem é notificado) é separado de `user_id` (quem criou). Eles divergem assim que a conta tem mais de um agente.

**Quadro (Kanban).** Cinco colunas na ordem de urgência: **Tarefas vencidas → hoje → amanhã → próximos 3 dias → futuras**. A ordem cronológica inversa enterraria as vencidas na borda direita, que é o oposto do que o quadro serve para fazer.
- **Vencidas gritam:** a coluna inteira ganha borda e fundo avermelhados, o contador fica sólido em vermelho, e cada card tem borda esquerda grossa, fundo tingido e o texto do prazo em destaque. Cor sozinha num texto pequeno não seria lida de relance.
- "Vencida" vence qualquer outra classificação: uma tarefa para as 9h quando já são 15h **do mesmo dia** está atrasada, e chamá-la de "hoje" esconderia justamente o estado que o quadro existe para mostrar.
- "Próximos 3 dias" começa depois de amanhã, senão a mesma tarefa apareceria em duas colunas.
- Tarefas concluídas saem do quadro. Nenhuma das cinco colunas é "concluído", e deixá-las entrar estacionaria um item finalizado em vermelho sob "Vencidas" para sempre.

**Calendário.** Dia, semana e mês, com navegação de período e botão "Hoje".
- A semana começa na segunda, como o resto do app já rotula os dias.
- O mês mostra semanas inteiras (transborda para o mês vizinho) em vez de deixar bordas irregulares, e limita a 3 chips por dia com "+N".
- Dias com algo vencido ficam avermelhados na grade.
- Clicar num dia vazio abre o formulário já com aquela data.
- As atividades são indexadas por dia numa passada só; filtrar a lista inteira dentro de cada uma das 42 células do mês seria quadrático à toa.

**Notificações de vencimento.** O app não tem agendador de tarefas, então a varredura é uma RPC idempotente chamada pelo cliente enquanto o CRM está aberto — o que é menos concessão do que parece: uma notificação existe para ser vista, e os momentos em que alguém está com o CRM aberto são exatamente os momentos em que ela pode ser. Qualquer coisa já vencida é pega na primeira vez que alguém da conta olha.
- Idempotente via `notified_at`, então várias abas não duplicam o aviso.
- A RPC é `SECURITY DEFINER` (precisa escrever em `notifications`, que por design não tem policy de INSERT para o cliente), mas **checa a associação à conta explicitamente**, já que direitos de definidor ignoram RLS.
- Reabrir uma atividade limpa o `notified_at`: sem isso, uma tarefa concluída e reaberta depois do prazo nunca mais avisaria.

**Verificação:** build limpo, typecheck limpo, lint 0 erros, paridade de i18n passando nos três idiomas, 549 testes passando (as 5 falhas de fuso/ICU são pré-existentes). 13 testes novos cobrindo as regras de agrupamento — incluindo o vencido-no-mesmo-dia, a fronteira da meia-noite local e a exclusão de concluídas.

**Não verificado ao vivo:** a migration ainda não foi aplicada e a instância UAZAPI continua expirada, então nada disto foi exercitado contra o banco real.

Arquivos: `supabase/migrations/041_activities.sql` (novo),
`src/lib/activities/{buckets,queries}.ts` (novos), `src/lib/activities/buckets.test.ts` (novo),
`src/components/activities/*` (novos), `src/app/(dashboard)/activities/page.tsx` (novo),
`src/hooks/use-due-activity-sweep.ts` (novo), `src/components/inbox/conversation-list.tsx`,
`src/components/contacts/contact-detail-view.tsx`, `src/components/layout/{sidebar,header}.tsx`,
`src/app/(dashboard)/dashboard-shell.tsx`, `src/app/(dashboard)/notifications/page.tsx`,
`src/types/index.ts`, `messages/{pt-BR,en,ko}.json`

## [2026-08-05] Molde do número no diálogo de nova conversa

**Antes:** o diálogo pedia o número com um exemplo solto no placeholder (`5548912345678`) e a dica "Com código do país e DDD, apenas números". Na prática não deu para entender o formato: uma sequência de 13 dígitos corridos não mostra onde termina o país, onde termina o DDD e onde começa o número.

**Depois:**
- **Molde visual acima do campo**, com cada parte separada e rotulada: `55` (país) · `48` (DDD) · `91234-5678` (número). Fica acima e sempre visível, não escondido atrás de um erro — o formato é justamente o que se erra, então precisa ser legível *antes* de digitar, não depois de falhar.
- Deixei explícito que **pode colar com espaços, parênteses e traços** — a limpeza é automática. O campo aceitar só dígitos puniria a forma mais comum de conseguir um número, que é copiar de outro lugar.
- **Eco ao vivo abaixo do campo**, confirmando como o que foi digitado foi lido: "Entendemos: país 55 · DDD 48 · número 912345678". Isso pega o erro mais comum — digitar como se fosse discar localmente, sem o código do país — na hora, em vez de deixar virar um confuso "esse número não tem WhatsApp" depois da ida ao servidor.
- Quando a contagem de dígitos ainda não fecha, o eco mostra quantos foram digitados e quantos costumam ser necessários, em âmbar. **Não bloqueia o botão**: é um empurrão enquanto se digita, não um veredito — quem decide é o servidor, e ele dá um motivo mais preciso.
- A separação em partes só é afirmada para números brasileiros (código 55 com 12 ou 13 dígitos). Para outros países o eco mostra só a contagem: adivinhar onde termina o DDD de um país arbitrário erraria com frequência suficiente para ser pior do que não dizer nada. Um número de 11 dígitos sem código do país **não** é rotulado como brasileiro válido — é exatamente o caso que o eco existe para pegar.

**Resolvido:** a dificuldade de entender o formato. Verificação: build limpo, typecheck limpo, lint 0 erros, paridade de i18n passando, 536 testes passando (as 5 falhas de fuso/ICU são pré-existentes). 8 testes novos no parser do eco, incluindo o número sem código do país e o número colado com formatação.

Arquivos: `src/components/inbox/new-conversation-dialog.tsx`,
`src/components/inbox/new-conversation-dialog.test.ts` (novo), `messages/{pt-BR,en,ko}.json`

## [2026-08-04] "Limpar caixa" arquiva de verdade; iniciar conversa por número

> **Requer migration.** `supabase/migrations/040_conversation_archive.sql` precisa ser
> aplicada no Supabase. Sem ela a coluna `archived_at` não existe e tanto o "Limpar
> caixa" quanto o filtro "Arquivadas" falham.

### 1. Limpar caixa passa a esvaziar a caixa

**Antes:** o botão só zerava `unread_count`. As conversas continuavam todas ali, então "limpar" não limpava nada visualmente — só apagava os contadores.

**Depois:** as conversas saem da lista. Nada é apagado: a conversa e todas as mensagens ficam onde estavam, e **a próxima mensagem do contato traz a conversa de volta com o histórico inteiro**, automaticamente.

- Implementado como uma coluna `archived_at`, **não** reaproveitando o `status`. O status (aberta/pendente/fechada) é um estado de trabalho que o atendente escolhe de propósito, e a caixa tem um filtro para ele. Arquivar é um estado de *visualização* que a próxima mensagem desfaz sozinha. Sobrecarregar "fechada" para também significar "escondida" deixaria uma conversa reaberta indistinguível de uma que o atendente fechou de propósito, e transformaria o filtro "Fechadas" numa gaveta de entulho.
- Novo filtro **"Arquivadas"**, porque sem ele o botão viraria um caminho sem volta: a conversa some de todas as visões e só reaparece se o contato escrever. Com o filtro, o atendente sempre consegue voltar.
- Enviar uma mensagem para uma conversa arquivada também a desarquiva — o atendente acabou de torná-la ativa, não faz sentido ela continuar escondida.
- O contador do aviso mudou de "conversas não lidas" para "conversas visíveis": o botão agora esvazia a caixa, então tem trabalho a fazer sempre que houver algo listado, não só quando houver não lidas.

### 2. Iniciar conversa com quem nunca escreveu

**Antes:** só era possível responder quem já tinha mandado mensagem. Não havia como abordar alguém ativamente.

**Depois:** botão "+" ao lado da busca abre um diálogo para digitar o número. O sistema **valida no WhatsApp antes de gravar qualquer coisa** e, se for válido, abre a conversa já selecionada.

- Validar antes de escrever é o ponto: sem a checagem, um erro de digitação deixaria um contato permanente e uma conversa vazia no banco, e o problema só apareceria depois como falha de envio.
- A identidade do contato vem do **JID que o WhatsApp devolve**, não dos dígitos digitados. O WhatsApp canoniza números (celulares brasileiros ganharam o 9º dígito e as pessoas ainda digitam as duas formas) e as mensagens roteiam para a forma canônica — gravar o que foi digitado criaria um contato para o qual não conseguimos entregar de forma confiável, e uma duplicata de um que talvez já exista.
- Se já existe conversa com aquele contato, ela é **reaproveitada e desarquivada** em vez de abrir uma segunda. É o caso comum de "essa pessoa já falou comigo e eu arquivei".
- Erros distintos ganham mensagens distintas: número malformado, número real sem WhatsApp, e WhatsApp não conectado pedem correções diferentes.
- Limite de 20/min por usuário. Cada chamada é uma consulta ao WhatsApp sobre um número arbitrário, então o limite também serve de freio contra usar a caixa de entrada como oráculo de "esse número tem WhatsApp?".
- Gate de papel `agent`, o mesmo do envio — é para isso que a conversa existe.

**Verificação:** build limpo, typecheck limpo, lint 0 erros, paridade de i18n passando, 528 testes passando (as 5 falhas de fuso/ICU são pré-existentes). 7 testes novos cobrindo o parsing do `/chat/check`, incluindo os casos em que ele responde 200 com corpo inútil.

**Não verificado ao vivo:** o token da instância UAZAPI expirou de novo durante o trabalho (`401 Invalid token` — é o servidor público de demonstração, instâncias expiram). O `/chat/check` foi implementado conforme a especificação e testado com respostas simuladas, mas **não foi exercitado contra o provedor real**. Testar assim que reconectar o QR Code.

Arquivos: `supabase/migrations/040_conversation_archive.sql` (novo),
`src/app/api/whatsapp/conversations/start/route.ts` (novo),
`src/components/inbox/new-conversation-dialog.tsx` (novo),
`src/lib/whatsapp/check-number.test.ts` (novo), `src/lib/whatsapp/uazapi-api.ts`,
`src/lib/whatsapp/inbound-pipeline.ts`, `src/lib/whatsapp/send-message.ts`,
`src/lib/rate-limit.ts`, `src/components/inbox/conversation-list.tsx`,
`src/app/(dashboard)/inbox/page.tsx`, `src/types/index.ts`, `messages/{pt-BR,en,ko}.json`

## [2026-08-04] Abas de Contatos/Grupos e tags visíveis na caixa de entrada

**Antes:** a caixa de entrada misturava conversas individuais e grupos numa lista só, sem como separar. E as tags de um contato só existiam no painel lateral — para saber se uma conversa estava marcada era preciso abri-la.

**Depois:**
- **Abas Todas / Contatos / Grupos** no topo da lista. Escolhi um controle segmentado, não mais um menu suspenso: é uma divisão de duas vias que o atendente alterna o tempo todo, então ganha espaço permanente de um toque — ao contrário do filtro de status, que tem cinco opções e uso ocasional.
- A aba é **ortogonal ao filtro de status** e às tags, não substitui. "Grupos não lidos" e "conversas individuais abertas" são fluxos reais, então os filtros se compõem.
- Grupos são identificados por `contact.is_group`, tratando ausente como pessoa — é o que todo contato anterior à migration 038 de fato é, e evita que linhas antigas sumam das duas abas.
- **Tags aparecem ao lado do nome** em cada linha, com o mesmo tratamento visual do painel do contato (fundo lavado na cor da tag + texto na cor), para que uma tag seja reconhecível igual nos dois lugares.
- Limite de **duas tags inline**, com o excedente virando `+N` (lista completa no `title` e no painel). A linha tem ~320px compartilhados com o horário; além disso o nome truncava até virar inútil. As chips encolhem antes do nome, e o `+N` nunca encolhe.
- **Marcar uma tag reflete na lista na hora.** O realtime só carrega `messages` e `conversations` — uma escrita em `contact_tags` não chega a assinante nenhum, então a chip ficaria invisível até o resync de 30s cair. O painel agora avisa o inbox, reaproveitando o mesmo resync que já existia em vez de criar um segundo caminho.

**Resolvido:** os dois pedidos. Conferido contra os dados reais: 8 grupos + 31 contatos = 39 conversas (a soma fecha, nenhuma linha cai fora das abas), e o contato com duas tags renderiza as duas inline.

**Verificação:** build limpo, typecheck limpo, lint 0 erros, teste de paridade de i18n passando, 521 testes passando (as 5 falhas de fuso/ICU são pré-existentes).

Arquivos: `src/components/inbox/conversation-list.tsx`,
`src/components/inbox/contact-sidebar.tsx`, `src/app/(dashboard)/inbox/page.tsx`,
`messages/{pt-BR,en,ko}.json`

## [2026-08-04] Hífen dos IDs de grupo legados destruído; repique da tela do inbox a cada 30s

Dois problemas independentes.

### 1. Grupos antigos com ID corrompido (foto faltando — e envio quebrado)

**Antes:** o grupo "AZALEIA RESIDENCIAL" não importava a foto. A causa não era a foto: o **ID do grupo estava corrompido no banco**.

Grupos criados antes dos IDs numéricos do WhatsApp têm o formato `<criador>-<criado_em>` — `554899681001-1474926097@g.us`. O webhook passava a parte local do JID pelo normalizador de telefone, que remove tudo que não é dígito, soldando o ID em `5548996810011474926097` — um ID que **nenhum grupo tem**.

Comprovado contra a instância real: `/chat/details` com a forma sem hífen devolve 200 mas um chat vazio e sem nome; com o hífen devolve "AZALEIA RESIDENCIAL" e a foto. E o histórico do provedor confirma que o `chatid` que ele envia é a forma com hífen. Dos 50 grupos da conta, **29 usam esse formato legado**.

Não era só cosmético: `resolveSendTarget` remontava o JID a partir desse valor, então **responder a qualquer grupo legado iria para um chat inexistente**. O nome do grupo funcionava por acidente — aquele caminho usa o `chatid` cru do webhook, não o valor armazenado.

**Depois:**
- A extração da parte local do JID passa a distinguir pessoa de grupo: telefone continua sendo reduzido a dígitos, ID de grupo é preservado inteiro (só dígitos e hífen).
- `resolveSendTarget` deixa de normalizar IDs de grupo.
- A busca do contato de grupo compara contra `phone_normalized` (coluna gerada, só dígitos) enquanto grava o ID inteiro em `phone` — a chave de deduplicação sai idêntica dos dois jeitos, então nada duplica.
- Contatos gravados antes disso se **auto-corrigem** na próxima mensagem do grupo: a chave só-dígitos ainda casa, então o ID é restaurado no lugar.
- A busca da foto de grupo passa o `chatid` do provedor direto, em vez de remontar o JID — um lugar a menos onde a remontagem pode errar.
- Testes de regressão cobrindo ID moderno, ID legado com hífen e entradas inválidas.

**Resolvido:** o grupo foi corrigido em produção (`5548996810011474926097` → `554899681001-1474926097`) e as fotos que faltavam foram importadas. **Os 8 grupos passaram a ter foto (antes 3).** Das 11 pessoas com telefone real, 3 têm foto — as demais não têm ou escondem por privacidade. Os 20 contatos com LID herdado continuam sem resolver, como esperado.

### 2. A tela do inbox se apagava e redesenhava a cada 30 segundos

**Antes:** a cada atualização vinda do WhatsApp a tela inteira piscava. A causa era a rede de segurança contra websocket silenciosamente travado: um `resyncToken` que dispara a cada 30s (mais a cada reconexão e cada volta de foco na aba). A cada disparo:

1. a thread chamava `setLoading(true)`, **substituindo a conversa inteira por um spinner**;
2. o resultado voltava e era gravado no estado como um array novo, **mesmo quando idêntico ao que já estava na tela**;
3. isso reacendia o efeito que observa `messages` e **jogava a rolagem para o fim** — tirando o atendente de onde estava lendo.

**Depois:**
- O spinner só aparece quando o atendente realmente **troca de conversa**. Recarga em segundo plano é silenciosa.
- Novo `rowsEqual` compara o resultado com o que já está renderizado e **não toca no estado quando nada mudou**. Aplicado à thread, às reações e à lista de conversas. A comparação normaliza a ordem das chaves de propósito: os dois lados vêm de origens diferentes (um `select()` REST e um `payload.new` do realtime), que trazem as mesmas colunas em ordens não necessariamente iguais — um `JSON.stringify` cru chamaria isso de diferente e a otimização não valeria nada.

**Resolvido:** o inbox continua se recuperando de eventos perdidos, mas sem repintar nem perder a rolagem. A rede de segurança dos 30s foi mantida — removê-la traria de volta o "inbox não atualiza".

**Verificação:** build limpo, typecheck limpo, lint 0 erros, 521 testes passando (as 5 falhas de fuso/ICU são pré-existentes).

Arquivos: `src/app/api/whatsapp/uazapi/webhook/[connectionId]/[secret]/route.ts`,
`src/lib/whatsapp/phone-utils.ts`, `src/lib/whatsapp/phone-utils.test.ts`,
`src/lib/whatsapp/inbound-pipeline.ts`, `src/lib/inbox/rows-equal.ts` (novo),
`src/lib/inbox/rows-equal.test.ts` (novo), `src/components/inbox/message-thread.tsx`,
`src/components/inbox/conversation-list.tsx`

## [2026-08-04] Menu lateral recolhido por padrão, expandindo ao passar o mouse

**Antes:** o menu lateral vinha aberto por padrão e recolher era uma escolha manual — quem quisesse o espaço extra precisava recolher e depois expandir toda vez que quisesse navegar.

**Depois:** o menu já começa recolhido (faixa de ícones de 64px) e se abre por inteiro assim que o mouse passa por cima, voltando a recolher quando o mouse sai. O botão do cabeçalho continua existindo, mas agora significa **fixar aberto**: quem prefere o menu sempre visível fixa uma vez e a preferência é lembrada.

- **A expansão sobrepõe a página, não a empurra.** Um espaçador invisível segura os 64px na linha do layout e o menu passou a ser posicionado por cima dele. Se a expansão redimensionasse o conteúdo, cada passada de mouse rearranjaria a tela inteira — no inbox isso significaria as três colunas pulando de lugar toda vez que o ponteiro cruzasse a lateral. Uma sombra aparece só enquanto ele está flutuando, para ficar claro que está por cima; fixado aberto, ele fica rente ao layout e a sombra some.
- Só a aparência responde ao hover; o espaço reservado continua respondendo à preferência fixada. É essa separação que faz a sobreposição funcionar.
- **Também abre ao receber foco por teclado.** Sem isso, navegar por Tab entraria em links cujos rótulos estão escondidos.
- **Fica aberto enquanto o menu do usuário está aberto.** O menu suspenso é renderizado fora da barra, então abri-lo conta como "o mouse saiu" — sem esse cuidado a barra fechava no instante em que a pessoa fosse clicar em "Sair".
- Como o padrão passou a ser recolhido, a preferência salva agora só é consultada para o caso contrário: apenas um "fixar aberto" explícito abre a barra no carregamento.

**Resolvido:** o pedido de recolher por padrão e mostrar por completo no hover. Verificação: build limpo, typecheck limpo, lint 0 erros, teste de paridade de i18n passando.

Arquivos: `src/components/layout/sidebar.tsx`, `src/app/(dashboard)/dashboard-shell.tsx`,
`messages/{pt-BR,en,ko}.json`

## [2026-08-04] Fotos de perfil de contatos e grupos importadas automaticamente

> **Requer migration.** `supabase/migrations/039_contact_avatars.sql` precisa ser
> aplicada no Supabase. Sem ela a coluna `avatar_synced_at` não existe e a
> importação falha (com log, sem derrubar a mensagem) a cada mensagem recebida.

**Antes:** contatos e grupos apareciam no inbox só com a inicial do nome ou um ícone genérico. A coluna `contacts.avatar_url` já existia e já era renderizada nos dois lugares (lista de conversas e painel do contato), mas **nada nunca a preenchia** — todos os 36 contatos estavam com ela vazia.

**Depois:** na primeira mensagem que um contato ou grupo envia, a foto de perfil do WhatsApp é importada.

- Novo `getProfilePictureUrl` (`uazapi-api.ts`) consulta `POST /chat/details`, que atende os dois casos — telefone puro para pessoa, JID completo (`…@g.us`) para grupo. Não são intercambiáveis, e é por isso que o webhook monta o número conforme o tipo.
- **A foto é copiada para o Supabase Storage, não linkada.** A UAZAPI devolve uma URL assinada em `pps.whatsapp.net` com parâmetro `oe=` de expiração: no teste real veio `oe=6A7F52A1`, que decodifica para 2026-08-14 — **dez dias**. Guardar esse link exibiria tudo certo hoje e quebraria todos os avatares na semana seguinte. Novo bucket `contact-avatars` (migration 039), separado do `chat-media` porque o ciclo de vida é outro: um objeto atual por contato, sobrescrito quando a foto muda, contra anexos imutáveis que ficam enquanto a conversa existir.
- O caminho no bucket é determinístico (`account-<id>/contact-<id>.<ext>`) com `upsert`. Um nome com timestamp deixaria a foto antiga órfã a cada atualização, sem nada apontando para ela para limpar depois. Como a URL então nunca muda, ela leva `?v=<timestamp>` para o navegador não continuar servindo a foto velha.
- **Nova coluna `contacts.avatar_synced_at`**, que registra a *tentativa* — algo que `avatar_url` sozinha não consegue expressar. Um contato que esconde a foto por privacidade legitimamente nunca terá URL, e checar pela URL faria o sistema reperguntar ao provedor em **toda** mensagem que ele mandasse, para sempre. É carimbada mesmo em falha.
- A foto é reconsultada quando passa de 7 dias. Sem isso a primeira foto ficaria congelada para sempre e quem trocasse de foto continuaria com a antiga pelo resto da vida do CRM.
- A importação roda **antes** de a mensagem ser gravada, porque o inbox relê a conversa (com o contato embutido) quando o realtime anuncia a mensagem nova — sincronizar antes é o que faz a foto aparecer junto com a primeira mensagem, e não só no próximo carregamento. Para isso não atrasar nada, as duas chamadas de rede têm timeout explícito (10s e 15s) e a função engole os próprios erros: avatar é enfeite, não pode derrubar mensagem.

**Resolvido:** contatos e grupos passam a exibir a foto real do WhatsApp.

**Verificação:** `/chat/details` testado contra a instância real — retornou foto para um grupo (60 KB) e para uma pessoa (6 KB), ambas baixáveis. A parte de armazenamento foi validada separadamente: upsert no caminho determinístico mantém exatamente 1 objeto na pasta (sem órfãos), leitura pública anônima responde 200, e o bucket rejeita tipo fora da lista (`text/plain` recusado). Build limpo, typecheck limpo, lint 0 erros, 507 testes passando (as 5 falhas de fuso/ICU são pré-existentes).

**Observações operacionais:**
- O bucket `contact-avatars` foi criado via API durante a verificação, com as mesmas configurações da migration. A migration é idempotente (`ON CONFLICT DO UPDATE`) e ao rodar apenas reconcilia o bucket e adiciona as políticas de RLS.
- Durante os testes o token da instância UAZAPI **expirou** (401 em `/instance/status`). O `UAZAPI_BASE_URL` aponta para um **servidor público de demonstração** — `/instance/all` responde "This is a public demo server. This endpoint has been disabled." Instâncias de demo expiram; enquanto isso a conexão fica fora e nenhuma mensagem chega. Reconectar pelo QR Code resolve na hora, mas vai voltar a acontecer até migrar para um servidor UAZAPI próprio ou pago.

Arquivos: `supabase/migrations/039_contact_avatars.sql` (novo),
`src/lib/whatsapp/contact-avatar.ts` (novo), `src/lib/whatsapp/contact-avatar.test.ts` (novo),
`src/lib/whatsapp/uazapi-api.ts`, `src/lib/whatsapp/inbound-pipeline.ts`,
`src/app/api/whatsapp/uazapi/webhook/[connectionId]/[secret]/route.ts`, `src/types/index.ts`

## [2026-08-04] Menu lateral recolhível

**Antes:** o menu lateral ocupava 240px fixos em qualquer tela, sem como recolher. No inbox, que já divide o que sobra em três colunas (lista de conversas, thread, painel do contato), isso apertava especialmente a leitura das mensagens.

**Depois:**
- Botão no cabeçalho (ao lado do título da página) alterna entre menu completo e uma faixa de ícones de 64px. A largura é animada, e o conteúdo da página se expande junto porque ocupa o espaço restante do flex.
- A preferência é gravada em `localStorage` e lida no inicializador do estado — não num efeito. Isso é seguro apesar do SSR porque o primeiro render (servidor e cliente) é o spinner da verificação de sessão: o valor não alcança nenhuma marcação antes da hidratação. Consequência prática: a faixa nunca pinta expandida para depois fechar de repente.
- **Recolher é exclusivo do desktop.** Todo estilo que o estado dirige tem prefixo `lg:`, então o drawer no celular sempre abre completo — mesmo que a preferência tenha sido marcada antes numa tela larga. O botão também só aparece a partir de `lg`, já que abaixo disso o hambúrguer existente cobre a mesma necessidade.
- Recolhido, cada linha vira só o ícone, com o rótulo exposto no `title` e no `aria-label` (sem eles a linha ficaria sem nome acessível). Os contadores de não lidos, que não cabem em 64px, condensam num ponto no canto do ícone.
- A coluna de conteúdo ganhou `min-w-0`. Sem isso um filho flex trava na largura intrínseca do conteúdo, e o espaço devolvido pela faixa alargaria a página em vez do conteúdo.

**Resolvido:** o pedido de recolher o menu e redimensionar o restante. Verificação: build limpo, typecheck limpo, lint 0 erros, teste de paridade de i18n passando, 502 testes passando (as 5 falhas de fuso/ICU são pré-existentes e não têm relação).

Arquivos: `src/app/(dashboard)/dashboard-shell.tsx`, `src/components/layout/sidebar.tsx`,
`src/components/layout/header.tsx`, `messages/{pt-BR,en,ko}.json`

## [2026-08-04] Imagens e áudios recebidos não apareciam no inbox

**Antes:** toda mídia recebida pelo WhatsApp sumia — nem imagem, nem áudio, nem figurinha apareciam na conversa. Duas causas empilhadas:

1. **Tipo nunca reconhecido.** A UAZAPI reporta os nomes crus do protocolo do WhatsApp, em PascalCase com sufixo: `ImageMessage`, `AudioMessage`, `StickerMessage`, `Conversation`, `ExtendedTextMessage`. O normalizador do webhook comparava com palavras minúsculas (`image`, `audio`) — **nunca casava**. Toda mídia era arquivada como texto simples, sem URL.
2. **O arquivo nem estava disponível.** Mesmo com o tipo certo, o campo `fileURL` vem **vazio** nas mensagens recebidas: os bytes continuam criptografados no CDN do WhatsApp. Só o endpoint `POST /message/download` descriptografa e republica o arquivo. Nada no código chamava isso.

**Depois:**
- `mapContentType` normaliza o tipo (minúsculas + remove o sufixo `message`), então aceita tanto `ImageMessage` quanto um eventual `image` — resiste a mudança do provedor nos dois sentidos. Figurinha vira imagem; `ptt` (áudio de voz) vira áudio; `ptv` (vídeo redondo) vira vídeo.
- Novo `downloadMessageMedia` (`uazapi-api.ts`) resolve o arquivo pelo `/message/download`, pedindo `generate_mp3: false` para manter o áudio de voz em OGG/Opus — formato que o WhatsApp mandou e que o bucket aceita, evitando um reencode com perda.
- Novo `inbound-media.ts` copia os bytes para o bucket `chat-media` do Supabase (o mesmo que o envio já usa) e grava a **URL do Supabase** na mensagem, não a da UAZAPI. Guardar o link do provedor funcionaria hoje e apodreceria amanhã: é disco deles, fora do nosso controle de retenção, e sumir levaria junto as imagens do histórico. Se qualquer etapa falhar (MIME recusado, arquivo grande, Storage fora), cai de volta no link do provedor em vez de perder o anexo — nunca lança.
- O `content-type` real da resposta tem precedência sobre o MIME que a UAZAPI reporta: numa figurinha o provedor dizia `image/webp` mas o arquivo era `image/jpeg`, e é contra o valor real que o bucket valida.

**Resolvido:** mídia recebida agora aparece e é baixável. Verificado ponta a ponta contra a instância real (download → bytes → upload → URL pública 200) e **11 mídias que já haviam chegado foram recuperadas** em produção, cruzando o histórico da UAZAPI com as mensagens já gravadas.

Arquivos: `src/app/api/whatsapp/uazapi/webhook/[connectionId]/[secret]/route.ts`,
`src/lib/whatsapp/uazapi-api.ts`, `src/lib/whatsapp/inbound-media.ts` (novo)

## [2026-08-04] Envio quebrado por LID gravado como telefone; Tags e Negócios não editáveis na conversa

**Antes:**
- **Envio quebrado.** Responder qualquer conversa falhava com `UAZAPI error: no LID found for <número>@s.whatsapp.net from server`. A causa: o normalizador do webhook usava `msg.sender` como identidade do contato em conversas 1:1. O WhatsApp hoje reporta o remetente como um **LID** (`135622383648774@lid`) — um identificador opaco por contato, **não** um telefone. Ou seja, o CRM gravava LIDs em `contacts.phone` e depois pedia à UAZAPI para entregar num id que ela só aceita no domínio `@lid`. Diagnóstico no banco: **nenhum** dos contatos individuais tinha telefone real (todos com 14–17 dígitos; brasileiros têm 12–13).
- **Tags e Negócios só de leitura.** O painel lateral da conversa listava tags e negócios mas não deixava criar nem selecionar nada — para marcar uma tag era preciso sair para a tela de Contatos.

**Depois:**
- A identidade agora vem **sempre do `chatid`**, nunca do `sender`. Confirmado contra o histórico real da UAZAPI: numa mensagem recebida, `chatid = 554896274914@s.whatsapp.net` (o telefone de verdade) enquanto `sender = 135622383648774@lid`. Mensagens cujo `chatid` seja um LID passam a ser descartadas com log, em vez de virarem um contato com telefone inválido.
- Contato afetado no print foi reparado em produção (`135622383648774` → `554896274914`), mapeando LID→telefone pelo histórico da própria UAZAPI.
- **Tags editáveis na conversa:** botão "+" abre um seletor com as tags da conta; clicar alterna (marca/desmarca) e o menu fica aberto para aplicar várias de uma vez. Cada tag ganhou um "x" para remoção direta. Passa pela rota `/api/contacts/[id]/tags` — e não por escrita direta na tabela — porque é ela que dispara o gatilho de automação `tag_added`; marcar pela conversa precisa se comportar igual a marcar pela tela de Contatos.
- **Negócios criáveis na conversa:** botão "+" abre a escolha do **funil** e então o formulário de negócio já existente (`DealForm`), com o contato pré-selecionado (nova prop `defaultContactId`). Um contato pode ter vários negócios, em funis diferentes — por isso o funil é uma escolha explícita, e cada negócio na lista agora mostra a qual funil pertence.
- Ambos os controles só aparecem para quem tem permissão de escrita (agente ou acima).

**Resolvido:** os dois problemas reportados nos prints. Verificação: typecheck limpo, lint 0 erros, 502 testes passando.

**Pendência conhecida:** 27 contatos individuais antigos ainda têm LID no lugar do telefone. São resíduo do período anterior ao suporte a grupos, quando cada participante de grupo virava um falso contato 1:1 — e o telefone real deles não é recuperável pelo histórico (o `chatid` daquelas mensagens era o grupo). Enviar para eles vai continuar falhando. Decidir com o usuário se apaga ou deixa.

Arquivos: `src/app/api/whatsapp/uazapi/webhook/[connectionId]/[secret]/route.ts`,
`src/components/inbox/contact-sidebar.tsx`, `src/components/pipelines/deal-form.tsx`,
`src/types/index.ts`, `messages/{pt-BR,en,ko}.json`

## [2026-08-04] Sistema reestruturado para 100% UAZAPI — API Oficial da Meta removida

> **MARCO.** Para resgatar a arquitetura anterior (dois provedores convivendo):
> `git switch -c restaura-meta marco/arquitetura-multi-provedor-meta-uazapi`
> Branch espelho: `legacy/meta-multiprovedor`. Ambos publicados no GitHub, apontando para `98aaf27`.

**Antes:** o projeto nasceu para a API Oficial da Meta e ganhou a UAZAPI depois, como segundo provedor. O código pagava o custo permanente dos dois mundos: uma camada de abstração de provedores com flags de capacidade, um cliente completo da Graph API (1044 linhas), todo o aparato de aprovação de modelos pela Meta, registro de número com PIN de duas etapas, verificação de assinatura HMAC no webhook, proxy autenticado de mídia e a janela de 24 horas — nada disso existe ou faz sentido numa operação via UAZAPI. Todo envio passava por uma indireção que perguntava "Meta ou UAZAPI?" antes de qualquer coisa.

**Depois:** a UAZAPI é o único provedor.
- **Camada de provedores eliminada.** `src/lib/whatsapp/providers/` (4 arquivos) deu lugar a um único `uazapi-client.ts`: resolve a conexão da conta e devolve um remetente já com o token da instância. Sem interface de provedor, sem `capabilities`, sem `ProviderNotSupportedError`.
- **Funcionalidade preservada, não degradada.** Descobri durante o planejamento que a UAZAPI suporta botões e listas nativamente (`POST /send/menu`) e que o toque do cliente já voltava mapeado no webhook (`buttonOrListid`). Em vez de remover os nós interativos, implementei `sendMenu` traduzindo o modelo interno para o formato de `choices` da UAZAPI — **Flows, Automações, respostas rápidas e o compositor continuam funcionando por inteiro**.
- **Removidos:** núcleo da Meta (cliente da Graph API, webhook, rotas de config/registro, proxy de mídia, tela de credenciais), a feature de **Modelos** completa (incluindo o passo `send_template` das Automações) e a feature de **Transmissões** completa, com todas as referências cruzadas (navegação, painel, papéis, escopos de chave de API, rate-limit, middleware, API pública v1).
- **Janela de 24 horas removida** — é regra da Meta, não do WhatsApp. O compositor agora está sempre habilitado.
- Env: `META_APP_SECRET` e `META_APP_ID` saíram; `UAZAPI_BASE_URL` e `UAZAPI_ADMIN_TOKEN` passaram de opcionais a **obrigatórios**.

**Sem migration.** Decisão deliberada: as tabelas `message_templates`, `broadcasts` e `broadcast_recipients` **não foram dropadas** — deletar tabela é perda de dado irreversível que a tag do Git não recupera. Ficam órfãs, sem código apontando para elas, e podem ser removidas depois com calma. `whatsapp_config` também fica como está; o código só para de ramificar na coluna `provider`.

**Resolvido:** atende ao pedido do usuário de otimizar o sistema inteiro em torno da UAZAPI. Verificação: `typecheck` limpo, `lint` com 0 erros (warnings caíram de 40 → 37), 502 testes passando (as 5 falhas restantes são as pré-existentes de fuso/ICU, sem relação).

Arquivos: `src/lib/whatsapp/{uazapi-client,uazapi-api,send-message,interactive}.ts`,
`src/lib/{automations,flows}/whatsapp-send.ts` (renomeados de `meta-send.ts`),
`src/components/settings/settings-sections.ts`, `src/components/inbox/{message-thread,message-composer}.tsx`,
`src/types/index.ts`, `messages/{pt-BR,en,ko}.json`, `.env.local.example`, `docs/public-api.md`

## [2026-08-04] Inbox parecia não atualizar em tempo real; sem forma de limpar não lidas; nome do CRM

**Antes:**
- **Tempo real:** a lista de conversas era ordenada apenas no `SELECT` inicial (`.order("last_message_at")`). Quando uma mensagem nova chegava, o evento de realtime atualizava `last_message_at`, a prévia e o badge **no lugar** (via `.map()`), mas nunca mexia na posição do item no array. Numa conta com mais de uma tela de conversas (o caso do usuário, com 8+), a conversa que recebeu a mensagem continuava enterrada na mesma posição — o que na prática se lê como "a caixa de entrada não é ao vivo". Além disso, o cliente só ressincronizava em eventos observáveis (reconexão do WebSocket, aba voltando ao foco); um WebSocket que morre em silêncio (proxy corporativo derrubando frames, NAT expirando, worker do Realtime reiniciando) deixava o inbox parado até um reload manual.
- **Não lidas:** não existia nenhuma forma de zerar as não lidas em massa — só abrindo conversa por conversa.
- **Nome:** o app se chamava "Modelo de CRM para WhatsApp" (`Sidebar.title`) e "wacrm" (título da aba/metadata).

**Depois:**
- A ordenação passou a acontecer na renderização (memo `filtered` em `conversation-list.tsx`), então toda atualização de realtime reordena a lista como o usuário espera. Foi adicionado também um resync periódico de 30s, pausado quando a aba está em segundo plano, como rede de segurança para o caso do WebSocket ficar mudo sem emitir evento de desconexão.
- Novo botão **"Limpar caixa"** na barra de filtros do inbox: zera `unread_count` de todas as conversas não lidas numa única query. O escopo por conta é garantido pelo próprio RLS (`conversations_update` → `is_account_member(account_id, 'agent')`), e o botão só aparece para quem tem permissão de escrita (agente ou acima) e quando existe algo para limpar. Limpa **todas** as não lidas de propósito, ignorando os filtros de busca/tag ativos — um "limpar caixa" que deixasse conversas não lidas escondidas atrás de um filtro esquecido seria pior que não ter o botão.
- Renomeado para **"Uniko CRM"** nos três dicionários (`pt-BR`, `en`, `ko`), no `metadata` do `layout.tsx` (título da aba) e na tela de cadastro.

**Resolvido:** atende aos três pedidos do usuário na mesma leva. Diagnóstico registrado: o backend de realtime foi verificado e **estava correto** — testes diretos com service role e com um token de usuário autenticado real receberam eventos de `messages` e `conversations` normalmente, então publicação, WAL e RLS não eram o problema; a falha era puramente de apresentação no cliente.

Arquivos: `src/components/inbox/conversation-list.tsx`, `src/app/(dashboard)/inbox/page.tsx`,
`src/app/layout.tsx`, `src/app/(auth)/signup/page.tsx`, `messages/{pt-BR,en,ko}.json`

## [2026-08-04] Aplicação estava apenas em inglês (e coreano) — sem português

**Antes:** o app só tinha dois dicionários de idioma (`messages/en.json` e `messages/ko.json`); não existia nenhuma tradução em português. `NEXT_PUBLIC_APP_LOCALE` (que define qual dicionário carrega — não é um seletor de idioma por usuário, é uma configuração única de toda a aplicação, ver `src/i18n/request.ts`) estava em `en`.

**Depois:** novo `messages/pt-BR.json` com tradução completa de toda chave existente em `en.json` (paridade 100%, verificada automaticamente por `src/i18n/messages.test.ts`, que agora cobre `ko` e `pt-BR`). `en.json` e `ko.json` não foram tocados — a mudança é só aditiva. `NEXT_PUBLIC_APP_LOCALE=pt-BR` virou o padrão documentado em `.env.local.example` e já setado no `.env.local` local.

**Resolvido:** atende ao pedido do usuário de ter o projeto inteiro em português. Importante: isso muda o `.env.local` **local**; o ambiente de produção (hPanel da Hostinger ou equivalente) precisa da mesma variável setada separadamente — não é algo que o deploy do código sozinho resolve.

Arquivos: `messages/pt-BR.json`, `src/i18n/messages.test.ts`, `.env.local.example`

## [2026-08-04] Mensagens de grupo do WhatsApp apareciam como chats individuais separados

**Antes:** o sistema não tinha nenhum conceito de "grupo do WhatsApp" — em nenhuma tabela (`contacts`, `conversations`, `messages`) nem no código. Toda mensagem recebida era atribuída a quem apareceu como "remetente" no payload da UAZAPI (`sender`), que numa mensagem de grupo é a pessoa que escreveu, não o grupo (`chatid`). Resultado: cada pessoa que escrevia num grupo virava um contato e uma conversa separados no Inbox — reportado pelo usuário com um caso real (mensagens do "Leo" e do "Gustavo Menezes", que na verdade estavam no mesmo grupo, aparecendo como dois chats individuais).

**Depois:**
- `contacts.is_group` e `messages.sender_display_name` (migration `038_group_chats.sql`) — um grupo agora é um contato como outro qualquer (o dígito do JID do grupo vai no campo `phone`, reaproveitando o índice único já existente), e cada mensagem guarda quem, dentro do grupo, mandou aquele texto especificamente.
- Contato de grupo usa busca **exata** por `phone_normalized` (não o matching difuso dos últimos 8 dígitos usado pra número de telefone real — arriscado demais pra um ID de grupo de 18-20 dígitos).
- Nome do grupo é buscado de verdade na UAZAPI (`POST /group/info`) na primeira mensagem, com fallback `Group <dígitos>` se a busca falhar.
- Inbox mostra ícone de grupo na lista de conversas, nome de quem escreveu acima de cada balão, e a prévia da conversa fica `"Nome: mensagem"` (igual ao próprio WhatsApp).
- Responder dentro de uma conversa de grupo agora funciona de verdade (antes seria rejeitado com "Invalid phone number format" — um ID de grupo tem mais dígitos do que o formato E.164 aceita) — novo helper `resolveSendTarget` em `phone-utils.ts`, usado nos 4 pontos de envio.
- A Meta Cloud API não tem conceito de grupo — nada mudou nesse caminho (`isGroup` sempre `false`).

**Resolvido:** atende ao bug reportado pelo usuário — mensagens de um mesmo grupo do WhatsApp (conectado via UAZAPI) agora aparecem agrupadas numa única conversa, com o autor de cada mensagem identificado, em vez de fragmentadas em um chat por pessoa.

Arquivos: `supabase/migrations/038_group_chats.sql`, `src/lib/whatsapp/uazapi-api.ts`,
`src/app/api/whatsapp/uazapi/webhook/[connectionId]/[secret]/route.ts`,
`src/lib/whatsapp/inbound-pipeline.ts`, `src/app/api/whatsapp/webhook/route.ts`,
`src/lib/whatsapp/phone-utils.ts`, `src/lib/whatsapp/send-message.ts`,
`src/lib/automations/meta-send.ts`, `src/lib/flows/meta-send.ts`,
`src/app/api/whatsapp/react/route.ts`,
`src/components/inbox/{conversation-list,message-bubble,message-thread}.tsx`,
`src/types/index.ts`

## [2026-08-03] Webhook da UAZAPI era registrado desabilitado (`enabled: false`)

**Antes:** o número conectava normalmente pela UAZAPI (QR code, sessão
ativa, `status: connected`), a URL do webhook e o secret de autenticação
estavam corretos, mas nenhuma mensagem chegava no inbox. A UAZAPI
confirmava `POST /webhook` com `200 OK`, então não havia erro visível em
lugar nenhum — parecia tudo certo, mas nada chegava.

**Depois:** `configureWebhook` (`src/lib/whatsapp/uazapi-api.ts`) agora
envia explicitamente `enabled: true` no corpo da requisição. A causa foi
confirmada consultando direto o banco (linha `whatsapp_config`, provider
`uazapi`) e a própria API da UAZAPI (`GET /webhook`), que mostrou a
configuração salva com `"enabled": false` — o schema da UAZAPI usa
`false` como padrão quando o campo não é enviado, e o código nunca
mandava esse campo. A conexão já ativa do usuário foi reativada na hora
(sem precisar reconectar), chamando `POST /webhook` de novo com
`enabled: true`.

**Resolvido:** mensagens recebidas pelo número conectado via UAZAPI agora
chegam no inbox. Reportado pelo usuário depois de conectar de verdade em
produção (`vbase.com.br`) e mandar uma mensagem de teste.

Arquivos: `src/lib/whatsapp/uazapi-api.ts`

## [2026-08-03] Lockfile com entrada de dependência opcional não usada

**Antes:** `package-lock.json` tinha uma entrada órfã
(`next-intl/node_modules/@swc/helpers`) sobrando de uma instalação
anterior, sem relação com nenhuma dependência declarada no
`package.json`.

**Depois:** entrada removida do lockfile via `npm install` local do
usuário; commit isolado, sem nenhuma outra mudança junto.

**Resolvido:** lockfile limpo, sem relação com o trabalho da UAZAPI —
mudança do próprio usuário, só formalizada em commit a pedido dele.

Arquivos: `package-lock.json`

## [2026-08-03] UAZAPI como segundo provedor de WhatsApp (conexão via QR Code)

**Antes:** o sistema só falava com o WhatsApp pela API oficial da Meta
(Cloud API) — token manual, aprovação de número pela Meta, sem opção de
conectar um número comum via QR Code. `whatsapp_config` tinha no máximo
uma linha por conta (`UNIQUE(account_id)`), e cinco pontos do código
(`send-message.ts`, `automations/meta-send.ts`, `flows/meta-send.ts` × 4
funções, `broadcast/route.ts`, `react/route.ts`) buscavam essa linha
direto e chamavam a Meta sem nenhuma camada intermediária.

**Depois:** a conta pode ter uma conexão Meta **e** uma conexão UAZAPI
simultaneamente. Adicionado:
- migration `037_uazapi_provider.sql` — coluna `provider` em
  `whatsapp_config` (`UNIQUE(account_id, provider)` no lugar de
  `UNIQUE(account_id)`), campos `uazapi_*`, e `conversations.whatsapp_config_id`
  (qual conexão está respondendo por cada conversa — atualizado a cada
  mensagem recebida, "a resposta sai pelo canal que o cliente usou por
  último");
- camada de provider (`src/lib/whatsapp/providers/`) — interface comum
  pra Meta e UAZAPI, e um resolvedor único (`resolve.ts`) que decide qual
  conexão usar, substituindo os cinco lookups duplicados;
- fluxo de conexão por QR Code (`/api/whatsapp/uazapi/{connect,status,disconnect}`)
  e webhook próprio (`/api/whatsapp/uazapi/webhook/[connectionId]/[secret]`),
  autenticado por secret no path (a UAZAPI não assina o payload como a
  Meta faz);
- pipeline de mensagens recebidas (`src/lib/whatsapp/inbound-pipeline.ts`)
  compartilhado entre os dois webhooks, extraído do que antes só existia
  dentro do webhook da Meta;
- novo card "UAZAPI (QR Code)" na tela Settings → WhatsApp, ao lado do
  card da Meta (que ficou inalterado);
- templates aprovados e mensagens interativas (botões/listas) continuam
  exclusivos da Meta — a UAZAPI não tem esse conceito, e agora falha com
  mensagem clara em vez de tentar mandar algo que ela não entende;
- corrigido de saída: o webhook só era registrado na criação da instância
  (nunca de novo numa reconexão), e a URL do webhook vinha da origem da
  própria requisição — inalcançável pela UAZAPI quando rodando em
  `localhost`. Agora `POST /connect` sempre re-registra o webhook, prioriza
  `NEXT_PUBLIC_SITE_URL` como origem, e avisa (toast + log) quando a URL
  resolvida parece `localhost` ou o placeholder de exemplo do
  `.env.local.example`.

**Resolvido:** atende ao pedido do usuário de oferecer uma segunda forma
de conectar o WhatsApp, sem depender do processo de aprovação da Meta —
usuário escolhe, na tela de Settings, qual provedor(es) usar, podendo
manter os dois ativos ao mesmo tempo.

Arquivos: `supabase/migrations/037_uazapi_provider.sql`,
`src/lib/whatsapp/providers/*`, `src/lib/whatsapp/uazapi-api.ts`,
`src/lib/whatsapp/inbound-pipeline.ts`,
`src/app/api/whatsapp/uazapi/**`, `src/app/api/whatsapp/webhook/route.ts`,
`src/lib/whatsapp/send-message.ts`, `src/lib/automations/meta-send.ts`,
`src/lib/flows/meta-send.ts`, `src/app/api/whatsapp/broadcast/route.ts`,
`src/app/api/whatsapp/react/route.ts`,
`src/components/settings/{whatsapp-config,uazapi-connect}.tsx`,
`src/types/index.ts`, `messages/{en,ko}.json`, `.env.local.example`
