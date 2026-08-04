# Registro de alterações do sistema

Registro técnico interno das mudanças feitas no projeto — não é o
changelog de release (`CHANGELOG.md`). Cada entrada mostra o estado
anterior, o que foi alterado, e qual problema isso resolveu.

Entradas mais recentes primeiro.

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
