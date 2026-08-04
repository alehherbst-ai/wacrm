---
name: log-changes
description: Registra em docs/system-changes.md as alterações feitas no sistema neste projeto, sempre no formato antes/depois/resolvido. Use ao final de uma tarefa de desenvolvimento, correção de bug ou mudança de arquitetura para deixar um rastro técnico do que mudou e por quê.
---

# Registrar alterações do sistema

Esta skill documenta, em linguagem técnica e direta, o que foi alterado no
projeto — não é um changelog de usuário final (isso já existe em
`CHANGELOG.md`, no formato Keep a Changelog). É um registro interno,
pensado pra quem vai mexer no código depois e precisa entender rápido o que
mudou, por que mudou, e como era antes.

## Onde escrever

Arquivo único: `docs/system-changes.md`, na raiz do projeto.

Se o arquivo não existir, crie com este cabeçalho antes da primeira entrada:

```markdown
# Registro de alterações do sistema

Registro técnico interno das mudanças feitas no projeto — não é o
changelog de release (`CHANGELOG.md`). Cada entrada mostra o estado
anterior, o que foi alterado, e qual problema isso resolveu.

Entradas mais recentes primeiro.
```

## Como decidir o que documentar

1. **Prioridade 1 — contexto da conversa atual.** Se você acabou de
   implementar algo, corrigir um bug ou tomar uma decisão de arquitetura
   nesta mesma sessão, use esse contexto diretamente — você já sabe o
   antes, o depois e o porquê, não precisa re-derivar isso do zero.
2. **Prioridade 2 — estado do git.** Quando o contexto da conversa não for
   suficiente (ex: a skill foi chamada depois de uma pausa, ou pra
   documentar mudanças que você não fez nesta sessão), rode:
   - `git status` e `git diff` (staged + unstaged) para mudanças ainda não
     commitadas;
   - `git log --oneline -20` e `git show <hash>` para commits recentes
     ainda não documentados.
   Agrupe por **mudança lógica** (uma feature, um bug, uma decisão), não
   por arquivo — um PR que mexeu em 10 arquivos pra resolver um problema é
   **uma** entrada, não dez.

## Antes de escrever, confira duplicidade

Leia o `docs/system-changes.md` existente (se houver) e veja se a mudança
que você vai registrar já tem uma entrada equivalente. Não duplique — se a
mudança já foi documentada, não escreva de novo.

## Formato da entrada (obrigatório)

Toda entrada segue exatamente esta estrutura — as três seções
(Antes/Depois/Resolvido) são obrigatórias, não pule nenhuma:

```markdown
## [AAAA-MM-DD] Título curto e específico da mudança

**Antes:** como o sistema se comportava, ou o que estava quebrado/faltando.
Seja concreto — não "estava com bug", e sim o sintoma exato e por que
acontecia.

**Depois:** o que foi alterado, em termos do comportamento novo — não uma
lista de nomes de função, mas o que o sistema faz agora que não fazia (ou
o que parou de fazer).

**Resolvido:** qual problema isso resolveu / qual necessidade atendeu.
Se veio de um pedido do usuário, do que o usuário pediu; se foi um bug
achado durante o desenvolvimento, o sintoma que o expôs.

Arquivos: `caminho/arquivo1.ts`, `caminho/arquivo2.tsx`
```

Regras de estilo:
- Direto ao ponto — sem enrolação, sem "melhorias gerais", sem elogiar o
  próprio trabalho.
- Escreva em português, igual ao resto da comunicação deste projeto.
- Datas no formato `AAAA-MM-DD`.
- Se uma mudança **não tem** um "antes" real (ex: uma feature totalmente
  nova, não uma correção), escreva no "Antes" o que não existia antes
  ("Não havia forma de X") — a seção continua obrigatória.
- Novas entradas sempre no **topo** da lista (mais recente primeiro),
  logo abaixo do cabeçalho do arquivo.
- Não edite entradas antigas para "corrigir" o passado — se algo mudou de
  novo depois, isso vira uma entrada nova que referencia a anterior.

## Depois de escrever

Diga ao usuário, em uma frase, quantas entradas foram adicionadas e onde
(`docs/system-changes.md`) — não é necessário mostrar o conteúdo inteiro
no chat a menos que o usuário peça.
