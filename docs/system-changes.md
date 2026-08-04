# Registro de alterações do sistema

Registro técnico interno das mudanças feitas no projeto — não é o
changelog de release (`CHANGELOG.md`). Cada entrada mostra o estado
anterior, o que foi alterado, e qual problema isso resolveu.

Entradas mais recentes primeiro.

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
