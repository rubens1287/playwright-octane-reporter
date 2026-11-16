# playwright-octane-reporter

Reporter do [Playwright](https://playwright.dev) que publica cada execução no
**ALM Octane** (OpenText, antigo Micro Focus) — para testes **web** e de **API**.

A cada `npx playwright test`, para cada teste executado:

| No Octane                | O que o reporter faz                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Teste gherkin**        | cria (se não existir) com Feature = `test.describe`, Scenario = o teste, um step por `test.step(...)`                                              |
| **Vínculo com o código** | grava `{ tag: '@octane:<id>' }` no `test(...)`; nas próximas execuções o teste é **reaproveitado** (só é recriado se tiver sido apagado no Octane) |
| **Test suite**           | cria `OCTANE_SUITE` (se não existir) e liga os testes a ela                                                                                        |
| **Run**                  | um run da suíte por execução, com um run por teste: Passed / Failed / Blocked / Skipped                                                            |
| **Status por step**      | Passed, Failed no step que falhou, Skipped nos que não chegaram a rodar                                                                            |
| **Log de falha**         | a mensagem de erro do Playwright (sem cores ANSI) no campo **Actual** do step que falhou                                                           |
| **Evidência**            | no **step que falhou** — ou, se passou, no **último step**: o screenshot (web) ou a troca HTTP request/response (API)                              |

Nada é chamado no Octane enquanto os testes rodam: a publicação acontece no fim
(`onEnd`). Falha na publicação **não** muda o resultado dos testes, mas é impressa
em destaque (`[octane] ✖ PUBLICAÇÃO NO OCTANE FALHOU`), com o que já tinha sido
criado.

## Instalação

```bash
npm install --save-dev playwright-octane-reporter
```

Requer Node >= 20.12 e `@playwright/test` >= 1.50. O `prettier`, se instalado no
projeto, é usado para formatar o spec ao gravar a tag.

## Configuração

### 1. `playwright.config.ts`

```ts
export default defineConfig({
  reporter: [['list'], ['html', { open: 'never' }], ['playwright-octane-reporter']],
  use: {
    // Web: screenshot do fim de TODO teste — é a evidência enviada ao Octane.
    screenshot: 'on',
  },
});
```

### 2. Variáveis de ambiente (`.env`)

O `.env` da raiz do projeto é carregado automaticamente. Variável definida no shell
ou no CI **vence** o arquivo.

| Variável                                                | Obrigatória | Conteúdo                                                            |
| ------------------------------------------------------- | ----------- | ------------------------------------------------------------------- |
| `OCTANE_ENABLED`                                        | —           | `true` liga. `false` ou ausente desliga. Outro valor **falha alto** |
| `OCTANE_URL`                                            | sim         | ex.: `https://octane.empresa.com:8443`                              |
| `OCTANE_SHARED_SPACE_ID`                                | sim         | ID do shared space                                                  |
| `OCTANE_WORKSPACE`                                      | sim         | ID numérico ou nome do workspace                                    |
| `OCTANE_USER`                                           | sim         | usuário do Octane                                                   |
| `OCTANE_PASSWORD`                                       | sim         | senha do Octane                                                     |
| `OCTANE_SUITE`                                          | sim         | nome da test suite (criada se não existir)                          |
| `OCTANE_RELEASE_ID`                                     | sim         | release dos runs                                                    |
| `OCTANE_APPLICATION_MODULE_ID`                          | não         | application module (`product_area`) dos testes e da suíte           |
| `OCTANE_PROGRAM`                                        | não         | program (nome ou ID) — alguns workspaces o exigem para editar       |
| `OCTANE_MILESTONE`                                      | não         | milestone (nome ou ID) dos runs                                     |
| `OCTANE_FIELD_<campo>`                                  | não         | qualquer campo de lista: `OCTANE_FIELD_severity_udf=Medium`         |
| `OCTANE_FAILURE_REASON_FIELD` + `OCTANE_FAILURE_REASON` | não         | campo e valor de motivo gravados **só** nos runs que não passaram   |

Com `OCTANE_ENABLED=true`, a falta de uma obrigatória falha a execução **antes** dos
testes rodarem. Para desligar uma execução avulsa: `OCTANE_ENABLED=false npx playwright test`.

**`OCTANE_FIELD_<campo>`** — o nome após o prefixo é o nome do campo no Octane
(muitas vezes um UDF, como `regressivo_udf`); o valor é o **nome exibido** na tela,
e um prefixo único basta (`PRJ0001` casa com `PRJ0001 - Projeto X`). Campos
de múltipla escolha aceitam vários valores separados por vírgula. Cada campo é
aplicado a toda entidade que o tem: teste, run da suíte, run manual. Nome
inexistente ou ambíguo falha **antes** de criar qualquer coisa, listando as opções.

```env
OCTANE_FIELD_regressivo_udf=Sim
OCTANE_FIELD_tipo_teste_udf=Funcional
OCTANE_FIELD_fase_teste_udf=Sistema E2E
```

### Como descobrir os campos: `npx playwright-octane-reporter campos`

O nome após `OCTANE_FIELD_` é o **nome interno** do campo (`ambiente_udf`), não o
rótulo da tela. O CLI lista, com as variáveis de conexão do `.env`, os campos de
lista que `OCTANE_FIELD_*` aceita — **só leitura**, funciona com `OCTANE_ENABLED=false`:

```bash
npx playwright-octane-reporter campos                  # campos customizados
npx playwright-octane-reporter campos ambiente         # filtra campos por nome ou rótulo
npx playwright-octane-reporter campos projeto PRJ0001  # busca valores do campo (completos)
npx playwright-octane-reporter campos --todos          # inclui os campos padrão do Octane
npx playwright-octane-reporter campos projeto --valores # todos os valores, um por linha
```

Campo com mais de 15 valores aparece **resumido** (contagem + amostra + o comando
de busca), para que listas de milhares de projetos não inundem o terminal:

```
OCTANE_FIELD_projeto_udf
  rótulo:    Projeto  (múltipla escolha)
  existe em: teste, run da suíte, run
  valores:   4.723 — ex.: PRJ0001 - Portal do cliente | PRJ0002 - App móvel | …
  buscar:    npx playwright-octane-reporter campos projeto_udf <texto>
```

Regras de negócio do workspace (campo exigido só ao gravar) não aparecem como
obrigatórias nos metadados. Elas aparecem como erro na publicação, com o nome
interno entre parênteses — `Missing required field 'Severity' ('severity_udf')` —,
e se resolvem com `OCTANE_FIELD_severity_udf=<valor>`.

### 3. Steps em Gherkin

Escreva cada passo num `test.step`, com o título começando pela palavra-chave:

```ts
test('CT-001 — realiza login com credenciais válidas', async ({ loginPage }) => {
  await test.step('Dado que estou na tela de login', async () => { … });
  await test.step('Quando eu preencho usuário e senha válidos', async () => { … });
  await test.step('E eu clico em "Login"', async () => { … });
  await test.step('Então devo acessar a aplicação autenticada', async () => { … });
});
```

`Dado`/`Quando`/`E`/`Então`/`Mas` (ou `Given`/`When`/`And`/`Then`/`But`) viram
`Given`/`When`/`And`/`Then`/`But` no script do Octane. Step sem palavra-chave é
publicado com uma atribuída, e um aviso.

### 4. Evidência de API

Não há tela para fotografar: a evidência é o **request e o response** de cada
chamada. Sobrescreva a fixture `request` com `comEvidencia`:

```ts
import { test as base } from '@playwright/test';
import { comEvidencia } from 'playwright-octane-reporter';

export const test = base.extend({
  request: async ({ request }, use, testInfo) => {
    await use(comEvidencia(request, testInfo));
  },
});
```

Toda chamada (`get`, `post`, `put`, `patch`, `delete`, `head`, `fetch`) vira um
anexo `evidencia-api` **no `test.step` em que aconteceu** (visível também no
relatório HTML). Se o step-alvo só assera (`Então a resposta deve ter status 400`),
vão todas as trocas do teste.

> **Segredo não sai do teste.** Headers e campos de corpo com nome de credencial
> (`authorization`, `cookie`, `token`, `password`, `api-key`…) viram `***` antes de
> gravar o anexo. Os headers padrão do config (`extraHTTPHeaders`) nem chegam ao
> captador.

## O vínculo `@octane:<id>`

Na primeira publicação, o reporter cria o teste no Octane e **grava a tag no seu
spec**:

```
[octane] tag @octane:1234 gravada em tests/login.spec.ts:8 — COMMITE o arquivo.
```

**Commite-a.** Sem tag, o reporter procura um teste gherkin de mesmo nome (na
application module configurada) antes de criar — por isso execuções no CI, onde a
tag gravada não é commitada, não duplicam testes. Mas renomear o teste sem a tag
cria um novo.

Se o `test(...)` já tiver `{ tag: … }`, a tag não é gravada automaticamente: o
reporter avisa e você junta à mão (`{ tag: ['@smoke', '@octane:<id>'] }`).

## Comportamentos do Octane que o reporter trata

Observados num Octane real; documentados para que ninguém precise redescobri-los:

- **"Automated" não é gravável.** O fluxo do Octane recusa `Not automated → Automated`
  e `Ready for automation → Automated`. O teste fica em **Ready for automation**.
- **Steps do run não nascem com o run criado por API.** O reporter chama
  `PUT /runs/{id}/steps` — o mesmo que o Manual Runner — para materializá-los.
- **Runs filhos são gerados pelo Octane** ~1 s depois de criar o run da suíte. O
  reporter espera e os atualiza, em vez de criar duplicatas.
- **`runs` e `run_steps` não aceitam POST**: runs são criados em `suite_run` e
  `manual_runs`.
- **Anexo é melhor esforço.** Erro de armazenamento do servidor vira aviso; status,
  steps e log continuam sendo publicados.

## Limitações

- O motivo de falha (`OCTANE_FAILURE_REASON`) é o mesmo para todas as falhas da execução.
- O script do teste só é atualizado a partir de execução que **passou** (numa falha,
  os steps finais não rodaram).
- Processo encerrado à força (SIGKILL) não chega ao `onEnd`: nada é publicado.

## Desenvolvimento

```bash
npm install
npm test     # build + publicação de ponta a ponta contra um Octane simulado
```

## Licença

MIT
