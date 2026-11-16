import type {
  FullConfig,
  Reporter,
  Suite,
  TestCase,
  TestError,
  TestResult,
  TestStep,
} from '@playwright/test/reporter';

import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { literal, OctaneClient, type Entidade, type Ref } from './client';
import { lerConfig, type OctaneConfig } from './config';
import { ANEXO_API } from './evidencia';
import { gravarTags, idDaTag, type Gravacao } from './vinculo';

/**
 * Publica a execução do Playwright no ALM Octane.
 *
 * Para cada teste executado (exceto arquivos de setup, `*.setup.ts`):
 *
 * 1. **Teste gherkin** (`Automation status = Ready for automation`) no Octane: Feature =
 *    `test.describe`, Scenario = o teste, um step por `test.step(...)`. O vínculo
 *    é a tag `@octane:<id>` no `test(...)` (ver `vinculo.ts`). Se o teste já
 *    existe, NÃO é recriado; sem tag, procura-se um teste gherkin de mesmo nome
 *    antes de criar — o que mantém a idempotência mesmo onde a tag ainda não foi
 *    commitada (ex.: CI).
 * 2. O teste é ligado à **test suite** `OCTANE_SUITE` (criada se não existir).
 * 3. Cada execução cria um **run da suíte**, com um run por teste, status por step
 *    log de erro no step que falhou e a evidência (troca HTTP de API ou screenshot
 *    web) no step que falhou — ou, se passou, no último step.
 *
 * Desligado salvo com `OCTANE_ENABLED=true`. Falha de publicação não muda o
 * resultado dos testes, mas é reportada em destaque — teste verde com publicação
 * perdida não pode passar despercebido.
 */
export default class OctaneReporter implements Reporter {
  private raiz: Suite | undefined;
  /**
   * Lida ao CARREGAR o reporter, antes de qualquer teste: configuração inválida
   * (variável faltando, `OCTANE_ENABLED=ture`) falha a execução de cara, em vez
   * de rodar a suíte inteira para só então descobrir que nada seria publicado.
   */
  private readonly config = lerConfig();

  onBegin(_config: FullConfig, suite: Suite): void {
    this.raiz = suite;
  }

  printsToStdio(): boolean {
    return false;
  }

  async onEnd(): Promise<void> {
    if (!this.config || !this.raiz) return;
    const publicacao = new Publicacao(this.config, this.raiz);
    try {
      await publicacao.executar();
    } catch (erro) {
      const criados = publicacao.criados;
      console.error('\n[octane] ✖ PUBLICAÇÃO NO OCTANE FALHOU — INCOMPLETA:');
      console.error(`[octane]   ${erro instanceof Error ? erro.message : String(erro)}`);
      console.error(
        criados.length
          ? `[octane]   Já criado no Octane antes da falha: ${criados.join(', ')}\n`
          : '[octane]   Nada foi criado no Octane.\n',
      );
    }
  }
}

type Caso = {
  teste: TestCase;
  resultado: TestResult;
  passos: TestStep[];
  octaneId?: string;
};

/**
 * Coleções REST de escrita, conforme `metadata/entities` › `rest` do Octane:
 * `runs` e `run_steps` NÃO aceitam POST (403 / sem o método). Cada
 * subtipo de run tem coleção própria — e nela o `subtype` é implícito (enviá-lo
 * dá `not_authorized`).
 */
const REST = { runSuite: 'suite_run', runManual: 'manual_runs' } as const;

/**
 * Tipo do teste criado no Octane. `gherkin_test`: o script é Feature/Scenario,
 * gerado dos `test.step` (ver `script`). Nos runs de suíte ele vira `run_manual`,
 * como no modelo do workspace.
 */
const TIPO_TESTE = 'gherkin_test';

/** "Automation status = Automated": o teste é executado pelo Playwright. */
const AUTOMATIZADO: Ref = {
  type: 'list_node',
  id: 'list_node.automation_status.automated',
};

const PRONTO_PARA_AUTOMACAO: Ref = {
  type: 'list_node',
  id: 'list_node.automation_status.ready_for_automation',
};

/** Entidades que recebem os `OCTANE_FIELD_*` (cada campo onde existir). */
const ENTIDADES_CLASSIFICADAS = [TIPO_TESTE, 'run_suite', 'run_manual'] as const;
type EntidadeClassificada = (typeof ENTIDADES_CLASSIFICADAS)[number];

/** Status do Playwright → sufixo do `logical_name` do status de run no Octane. */
const STATUS_RUN: Record<TestResult['status'], string> = {
  passed: 'passed',
  failed: 'failed',
  timedOut: 'failed',
  interrupted: 'blocked',
  skipped: 'skipped',
};

class Publicacao {
  private readonly cliente: OctaneClient;
  private readonly gravacoes: Gravacao[] = [];
  private statusRun = new Map<string, Ref>();
  private statusPasso = new Map<string, Ref>();
  /** Classificação resolvida POR ENTIDADE: cada campo só entra onde existe. */
  private readonly classificacao: Record<EntidadeClassificada, Record<string, unknown>> =
    { [TIPO_TESTE]: {}, run_suite: {}, run_manual: {} };
  private programa: Ref | undefined;
  private milestone: Ref | undefined;
  /** `{ <campo>: <valor> }` do motivo de falha (`OCTANE_FAILURE_REASON*`), já resolvido. */
  private motivoFalha: Record<string, unknown> | undefined;
  /** Testes da tag trocados por um de outro tipo — desligados da suíte. */
  private readonly substituidos = new Set<string>();
  /** Entidades criadas nesta publicação — reportadas se ela falhar no meio. */
  readonly criados: string[] = [];

  constructor(
    private readonly config: OctaneConfig,
    private readonly raiz: Suite,
  ) {
    this.cliente = new OctaneClient(config);
  }

  async executar(): Promise<void> {
    const casos = this.coletar();
    if (casos.length === 0) return;

    await this.cliente.autenticar();
    this.statusRun = await this.cliente.valoresDoCampo('run', 'native_status');
    // O status do step é `run_step.result`, que aponta para a MESMA lista do
    // `run.native_status`.
    this.statusPasso = await this.cliente.valoresDoCampo('run_step', 'result');
    // Resolvida ANTES de criar qualquer entidade: nome inválido falha sem deixar
    // teste, suíte ou run pela metade no Octane.
    for (const [campo, nomes] of Object.entries(this.config.campos)) {
      let usado = false;
      for (const entidade of ENTIDADES_CLASSIFICADAS) {
        const valor = await this.cliente.valorDeLista(entidade, campo, nomes);
        if (valor === undefined) continue;
        this.classificacao[entidade][campo] = valor;
        usado = true;
      }
      if (!usado) {
        throw new Error(
          `OCTANE_FIELD_${campo}: o campo ${campo} não existe em teste nem em run.`,
        );
      }
    }
    if (this.config.program) {
      this.programa = await this.cliente.resolverPorNome(
        'programs',
        'program',
        this.config.program,
      );
    }
    if (this.config.milestone) {
      this.milestone = await this.cliente.resolverPorNome(
        'milestones',
        'milestone',
        this.config.milestone,
      );
    }
    // Há workspaces que recusam run Failed sem motivo — e só depois de o run da
    // suíte já existir. Resolvido aqui, antes de criar qualquer coisa: nome
    // inválido em OCTANE_FAILURE_REASON falha sem deixar nada pela metade.
    const motivo = this.config.motivoFalha;
    if (motivo && casos.some((c) => STATUS_RUN[c.resultado.status] !== 'passed')) {
      const valor = await this.cliente.valorDeLista('run_manual', motivo.campo, [
        motivo.valor,
      ]);
      if (valor === undefined) {
        throw new Error(
          `OCTANE_FAILURE_REASON_FIELD: o run manual não tem o campo ${motivo.campo}.`,
        );
      }
      this.motivoFalha = { [motivo.campo]: valor };
    }

    try {
      for (const caso of casos) await this.garantirTeste(caso);

      const suiteId = await this.garantirSuite(casos);
      const { id: runSuiteId, falhou } = await this.executarSuite(suiteId, casos);
      await this.cliente.atualizar(REST.runSuite, runSuiteId, {
        native_status: this.status(falhou ? 'failed' : 'passed'),
      });
      log(`run da suíte ${runSuiteId} publicado (${casos.length} teste(s)).`);
    } finally {
      // Mesmo se a publicação falhar no meio, o teste que JÁ EXISTE no Octane
      // fica vinculado no código — a próxima execução o reaproveita.
      await this.gravarVinculos();
    }
  }

  private async criar(colecao: string, dados: Record<string, unknown>) {
    const criado = await this.cliente.criar(colecao, dados);
    this.criados.push(`${colecao}/${criado.id}`);
    return criado;
  }

  /** Program (`OCTANE_PROGRAM`) — há workspaces que o exigem para editar teste e run. */
  private comPrograma(): Record<string, unknown> {
    return this.programa ? { program: this.programa } : {};
  }

  /** Campos de um run: program, milestone e a classificação da entidade. */
  private camposDoRun(entidade: 'run_suite' | 'run_manual'): Record<string, unknown> {
    return {
      ...this.comPrograma(),
      ...(this.milestone ? { milestone: this.milestone } : {}),
      ...this.classificacao[entidade],
    };
  }

  /** Último resultado (após retries) de cada teste que rodou, fora os de setup. */
  private coletar(): Caso[] {
    return this.raiz
      .allTests()
      .filter((t) => !/.setup.[cm]?[jt]s$/.test(t.location.file))
      .flatMap((teste) => {
        const resultado = teste.results.at(-1);
        if (!resultado) return [];
        const passos = resultado.steps.filter((s) => s.category === 'test.step');
        return [{ teste, resultado, passos }];
      });
  }

  // ── 1. Teste gherkin ─────────────────────────────────────────────────────

  private async garantirTeste(caso: Caso): Promise<void> {
    const { teste } = caso;
    const idTag = idDaTag(teste.tags);
    const campos = [
      'id',
      'name',
      'subtype',
      'program',
      'automation_status',
      ...Object.keys(this.classificacao[TIPO_TESTE]),
    ];
    let existente: Entidade | null = null;

    if (idTag) {
      existente = await this.cliente.obter('tests', idTag, campos);
      if (!existente) {
        aviso(`teste ${idTag} da tag não existe mais no Octane — recriando.`);
      } else if (existente.subtype !== TIPO_TESTE) {
        // Tag de um teste de OUTRO tipo (ex.: o test_manual de antes da troca
        // para gherkin). Não é reaproveitável: cria o gherkin, regrava a tag e
        // desliga o antigo da suíte. O antigo NÃO é apagado.
        aviso(
          `teste ${idTag} da tag é ${String(existente.subtype)}, não ${TIPO_TESTE} — criando o ${TIPO_TESTE}.`,
        );
        this.substituidos.add(idTag);
        existente = null;
      }
    }
    if (!existente) {
      const mesmoNome = await this.cliente.buscar(
        'tests',
        `subtype EQ '${TIPO_TESTE}'; name EQ ${literal(teste.title)}${this.filtroModulo()}`,
        campos,
        'id',
      );
      existente = mesmoNome[0] ?? null;
      if (existente) log(`reutilizando teste ${existente.id} encontrado pelo nome.`);
    }

    const scriptDoCodigo = script(caso);
    if (existente) {
      caso.octaneId = existente.id;
      // O vínculo vale assim que o teste existe — registrado ANTES das edições,
      // para que uma falha adiante não impeça gravar a tag no código.
      this.vincular(caso, idTag);

      // O workspace recusa QUALQUER edição (inclusive a dos steps) de teste sem
      // program/classificação obrigatórios. Preenche só os campos VAZIOS — nunca
      // troca um valor ajustado no Octane.
      const faltando = Object.fromEntries(
        Object.entries({
          ...this.comPrograma(),
          ...this.classificacao[TIPO_TESTE],
        }).filter(([campo]) => vazio(existente[campo])),
      );
      if (Object.keys(faltando).length > 0) {
        await this.cliente.atualizar('tests', existente.id, faltando);
        log(`preenchido no teste ${existente.id}: ${Object.keys(faltando).join(', ')}.`);
      }
      // O código é a fonte dos steps. Só sincroniza a partir de execução que
      // passou: numa falha, os steps posteriores nem chegaram a rodar e o script
      // sairia truncado.
      if (caso.resultado.status === 'passed') {
        const atual = await this.cliente.lerScript(existente.id);
        if (normalizar(atual) !== normalizar(scriptDoCodigo)) {
          await this.cliente.gravarScript(existente.id, scriptDoCodigo);
          log(`steps do teste ${existente.id} atualizados a partir do código.`);
        }
      }
      await this.marcarAutomatizado(existente.id);
    } else {
      // SEM `automation_status`: o Octane recusa criar já como Automated
      // ("contradicts the flow logic"). O status vem depois do script.
      const criado = await this.criar('tests', {
        subtype: TIPO_TESTE,
        name: teste.title,
        description: descricao(teste),
        // `phase` é obrigatória (metadado do workspace).
        phase: { type: 'phase', id: `phase.${TIPO_TESTE}.new` },
        ...this.modulo(),
        ...this.comPrograma(),
        ...this.classificacao[TIPO_TESTE],
      });
      caso.octaneId = criado.id;
      this.vincular(caso, idTag);
      await this.cliente.gravarScript(criado.id, scriptDoCodigo);
      await this.marcarAutomatizado(criado.id);
      log(`teste ${criado.id} criado: ${teste.title}`);
    }
  }

  /**
   * "Automation status = Automated" — o teste É executado pelo Playwright. Por
   * último, porque o fluxo do Octane só aceita a transição com o teste já
   * existente, e alterar o script pode devolvê-lo a "Requires update". Lê o
   * status atual e só grava se diferente.
   */
  private async marcarAutomatizado(testeId: string): Promise<void> {
    const atual = await this.cliente.obter('tests', testeId, ['automation_status']);
    const de = (atual?.automation_status as Ref | null)?.id;
    if (de === AUTOMATIZADO.id) return;
    // O fluxo do workspace não permite pular etapa ("Not automated → Automated"
    // é recusado): passa por "Ready for automation" quando ainda não está nela.
    if (de !== PRONTO_PARA_AUTOMACAO.id) {
      await this.cliente.atualizar('tests', testeId, {
        automation_status: PRONTO_PARA_AUTOMACAO,
      });
      log(`teste ${testeId} marcado como Ready for automation.`);
    }
    // "Automated" NÃO é gravável: o Octane o atribui sozinho quando recebe
    // resultado de automação para o teste (`POST /test-results`, gherkin_test_run).
    // Gravar à mão dá "contradicts the flow logic" — observado aqui em
    // Not automated → Automated e em Ready for automation → Automated.
    try {
      await this.cliente.atualizar('tests', testeId, { automation_status: AUTOMATIZADO });
      log(`teste ${testeId} marcado como Automated.`);
    } catch {
      aviso(
        `teste ${testeId} fica em "Ready for automation": "Automated" só é atribuído pelo Octane via /test-results.`,
      );
    }
  }

  private vincular(caso: Caso, idTag: string | undefined): void {
    const { teste, octaneId } = caso;
    if (!octaneId || octaneId === idTag) return;
    this.gravacoes.push({
      arquivo: teste.location.file,
      linha: teste.location.line,
      coluna: teste.location.column,
      novoId: octaneId,
      ...(idTag ? { idAnterior: idTag } : {}),
    });
  }

  // ── 2. Test suite ────────────────────────────────────────────────────────

  private async garantirSuite(casos: Caso[]): Promise<string> {
    const nome = this.config.suiteName;
    const [suite] = await this.cliente.buscar(
      'tests',
      `subtype EQ 'test_suite'; name EQ ${literal(nome)}${this.filtroModulo()}`,
      ['id', 'name'],
      'id',
    );
    const suiteId =
      suite?.id ??
      (
        await this.criar('tests', {
          subtype: 'test_suite',
          name: nome,
          ...this.modulo(),
          ...this.comPrograma(),
        })
      ).id;
    if (!suite) log(`test suite ${suiteId} criada: ${nome}`);

    const links = await this.cliente.buscar(
      'test_suite_link_to_tests',
      `test_suite EQ {id EQ ${suiteId}}`,
      ['test'],
    );
    // Teste substituído (troca de tipo) sai da suíte: senão o Octane gera para ele
    // um run "Planned" a cada execução, e a suíte nunca fecha como Passed.
    for (const link of links) {
      const testeId = (link.test as Ref | null)?.id;
      if (testeId && this.substituidos.has(testeId)) {
        await this.cliente.remover('test_suite_link_to_tests', link.id);
        log(`teste ${testeId} desligado da suíte ${suiteId} (substituído).`);
      }
    }
    const ligados = new Set(links.map((l) => (l.test as Ref | null)?.id));
    for (const caso of casos) {
      if (!caso.octaneId || ligados.has(caso.octaneId)) continue;
      await this.criar('test_suite_link_to_tests', {
        test_suite: { type: 'test_suite', id: suiteId },
        test: { type: TIPO_TESTE, id: caso.octaneId },
      });
      ligados.add(caso.octaneId);
    }
    return suiteId;
  }

  // ── 3. Execução ──────────────────────────────────────────────────────────

  private async executarSuite(
    suiteId: string,
    casos: Caso[],
  ): Promise<{ id: string; falhou: boolean }> {
    // `release` é obrigatória em run_suite e run_manual (metadado do workspace).
    const release = { release: { type: 'release', id: this.config.releaseId } };
    const runSuite = await this.criar(REST.runSuite, {
      name: `${this.config.suiteName} — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
      test: { type: 'test_suite', id: suiteId },
      native_status: this.status('planned'),
      ...release,
      ...this.camposDoRun('run_suite'),
    });

    // O Octane gera SOZINHO, ~1 s DEPOIS de criar o run da suíte, um run manual
    // "Planned" por teste ligado à suíte. Criar o nosso sem esperar duplica o run,
    // e o "Planned" que sobra deixa a suíte eternamente "In Progress" (o status
    // dela é derivado dos filhos). Por isso: aguardar os filhos e ATUALIZÁ-LOS.
    const filhoPorTeste = await this.aguardarFilhos(
      runSuite.id,
      casos.flatMap((c) => (c.octaneId ? [c.octaneId] : [])),
    );

    let falhou = false;
    for (const caso of casos) {
      if (!caso.octaneId) continue;
      const statusPw = caso.resultado.status;
      falhou ||= STATUS_RUN[statusPw] !== 'passed';

      const nativeStatus = this.status(STATUS_RUN[statusPw]);
      // Motivo de falha (OCTANE_FAILURE_REASON*), só em run que não passou.
      const motivo =
        STATUS_RUN[statusPw] !== 'passed' && this.motivoFalha ? this.motivoFalha : {};
      let runId = filhoPorTeste.get(caso.octaneId);
      if (runId) {
        // O run gerado pelo Octane nasce sem a classificação exigida pelo
        // workspace — ela vai junto com o status.
        await this.cliente.atualizar(REST.runManual, runId, {
          native_status: nativeStatus,
          ...this.camposDoRun('run_manual'),
          ...motivo,
        });
      } else {
        aviso(`Octane não gerou run para o teste ${caso.octaneId} — criando.`);
        runId = (
          await this.criar(REST.runManual, {
            name: caso.teste.title,
            test: { type: TIPO_TESTE, id: caso.octaneId },
            parent_suite: { type: 'run_suite', id: runSuite.id },
            native_status: nativeStatus,
            ...release,
            ...this.camposDoRun('run_manual'),
            ...motivo,
          })
        ).id;
      }
      await this.registrarPassos(runId, caso);
    }
    return { id: runSuite.id, falhou };
  }

  /**
   * Espera o Octane gerar os runs filhos do run da suíte, até cobrirem os testes
   * `esperados` ou estourar o prazo. Devolve teste → run.
   */
  private async aguardarFilhos(
    runSuiteId: string,
    esperados: string[],
  ): Promise<Map<string | undefined, string>> {
    const prazo = Date.now() + 20_000;
    for (;;) {
      const filhos = await this.cliente.buscar(
        'runs',
        `parent_suite EQ {id EQ ${runSuiteId}}`,
        ['id', 'test'],
      );
      const mapa = new Map(filhos.map((r) => [(r.test as Ref | null)?.id, r.id]));
      if (esperados.every((id) => mapa.has(id)) || Date.now() > prazo) return mapa;
      await new Promise((ok) => setTimeout(ok, 1_000));
    }
  }

  private async registrarPassos(runId: string, caso: Caso): Promise<void> {
    // Os steps do run NÃO nascem com o run criado por API (o run tem `steps_num`,
    // mas nenhum `run_step`). `PUT /runs/{id}/steps` é a chamada que o Manual
    // Runner faz para materializá-los a partir do script. `run_steps` em si só
    // aceita GET/PUT.
    await this.cliente.materializarSteps(runId);
    const todos = await this.cliente.buscar(
      'run_steps',
      `run EQ {id EQ ${runId}}`,
      ['id', 'description'],
      'id',
    );
    // Do gherkin, o Octane gera uma linha de Feature, uma de Scenario e uma por
    // step. `description` é JSON: Feature/Scenario têm `name`; os steps têm
    // `description: ["Given …"]`.
    const cabecalhos = todos.filter((p) => !ehStepGherkin(p));
    const passosRun = todos.filter(ehStepGherkin);
    if (passosRun.length === 0) {
      aviso(`run ${runId} sem steps gherkin — evidência vai para o run.`);
    }

    // Pareamento por POSIÇÃO: o i-ésimo step gherkin é o i-ésimo `test.step`.
    // O que não rodou depois de uma falha fica Skipped.
    const indiceFalha = caso.passos.findIndex((p) => p.error);
    const statusDe = (i: number): string => {
      const pw = caso.passos[i];
      if (pw) return pw.error ? 'failed' : 'passed';
      if (caso.passos.length === 0 && i === 0) return STATUS_RUN[caso.resultado.status];
      return caso.resultado.status === 'passed' ? 'passed' : 'skipped';
    };
    for (const [i, passo] of passosRun.entries()) {
      // No step que falhou, o log de erro do Playwright vai para "Actual" — o
      // resultado obtido, onde a UI do Octane mostra o que deu errado.
      const erro = i === indiceFalha ? caso.passos[i]?.error : undefined;
      await this.marcarPasso(passo.id, statusDe(i), erro ? logDeErro(erro) : undefined);
    }
    // Falha FORA de `test.step` (hook, fixture, timeout do teste): sem step
    // culpado, o log vai para o último step executado.
    if (indiceFalha < 0 && caso.resultado.status !== 'passed') {
      const ultimoExecutado = passosRun[Math.max(caso.passos.length, 1) - 1];
      const erro = caso.resultado.errors[0] ?? caso.resultado.error;
      if (ultimoExecutado && erro) {
        await this.marcarPasso(ultimoExecutado.id, 'failed', logDeErro(erro));
      }
    }
    for (const cabecalho of cabecalhos) {
      await this.marcarPasso(cabecalho.id, STATUS_RUN[caso.resultado.status]);
    }

    // Evidência no step que FALHOU; se passou, no ÚLTIMO step. Falha fora de
    // `test.step` (ex.: em hook) cai no último step executado.
    const indiceAlvo =
      indiceFalha >= 0 ? indiceFalha : Math.max(caso.passos.length, 1) - 1;
    const evidencia = await escolherEvidencia(caso, indiceAlvo, runId);
    if (!evidencia) {
      aviso(
        `sem evidência para "${caso.teste.title}" — nem screenshot (\`use.screenshot\`) nem troca HTTP registrada.`,
      );
      return;
    }
    const alvo = passosRun[Math.min(indiceAlvo, passosRun.length - 1)];
    const qual = indiceFalha >= 0 ? 'ao step que falhou' : 'ao último step';
    if (alvo) {
      try {
        await this.cliente.anexar(evidencia.caminho, {
          owner_run_step: { type: 'run_step', id: alvo.id },
        });
        log(`${evidencia.tipo} anexado ${qual} do run ${runId}.`);
        return;
      } catch (erro) {
        aviso(`anexo no step recusado, indo para o run ${runId}: ${String(erro)}`);
      }
    }
    // Evidência é MELHOR ESFORÇO: status, steps e log já foram gravados, e um
    // erro de armazenamento do Octane (observado: HTTP 500 "Cannot write file")
    // não pode deixar os demais testes da execução sem publicar.
    try {
      await this.cliente.anexar(evidencia.caminho, {
        owner_run: { type: 'run_manual', id: runId },
      });
      log(`${evidencia.tipo} anexado ao run ${runId}.`);
    } catch (erro) {
      aviso(
        `${evidencia.tipo} NÃO anexado ao run ${runId} — publicação segue: ${String(erro)}`,
      );
    }
  }

  private async marcarPasso(stepId: string, status: string, log?: string): Promise<void> {
    const ref = this.statusPasso.get(status);
    const dados: Record<string, unknown> = {};
    if (ref) dados.result = ref;
    if (log) dados.actual = log;
    if (Object.keys(dados).length > 0) {
      await this.cliente.atualizar('run_steps', stepId, dados);
    }
  }

  /** Application module (`product_area`) a que testes e suíte pertencem. */
  private modulo(): Record<string, unknown> {
    const id = this.config.applicationModuleId;
    return id ? { product_areas: { data: [{ type: 'product_area', id }] } } : {};
  }

  private filtroModulo(): string {
    const id = this.config.applicationModuleId;
    return id ? `; product_areas EQ {id EQ ${id}}` : '';
  }

  private status(sufixo: string): Ref {
    const ref = this.statusRun.get(sufixo);
    if (!ref) {
      throw new Error(
        `status de run "${sufixo}" inexistente no Octane. Disponíveis: ${[...this.statusRun.keys()].join(', ')}`,
      );
    }
    return ref;
  }

  // ── Vínculo no código ────────────────────────────────────────────────────

  private async gravarVinculos(): Promise<void> {
    if (this.gravacoes.length === 0) return;
    const falhas = await gravarTags(this.gravacoes);
    for (const g of this.gravacoes.filter((x) => !falhas.includes(x))) {
      log(
        `tag @octane:${g.novoId} gravada em ${g.arquivo}:${g.linha} — COMMITE o arquivo.`,
      );
    }
    for (const g of falhas) {
      aviso(
        `não consegui gravar a tag em ${g.arquivo}:${g.linha}. Adicione manualmente: { tag: '@octane:${g.novoId}' }`,
      );
    }
  }
}

function nomesDosPassos(caso: Caso): string[] {
  const nomes = caso.passos.map((p) => p.title.replace(/\s+/g, ' ').trim());
  return nomes.length > 0 ? nomes : [caso.teste.title];
}

/**
 * Palavra-chave Gherkin em português no INÍCIO do título do `test.step` → a
 * equivalente em inglês usada no script do Octane. É o estilo do modelo do
 * workspace: palavra-chave em inglês, texto em português ("Given que o CPF…").
 */
const PALAVRAS_CHAVE: [RegExp, string][] = [
  [/^(dado|dada|dados|dadas|given)\s+/i, 'Given'],
  [/^(quando|when)\s+/i, 'When'],
  [/^(então|entao|then)\s+/i, 'Then'],
  [/^(e|and)\s+/i, 'And'],
  [/^(mas|but)\s+/i, 'But'],
];

/** Uma linha de step Gherkin a partir do título do `test.step`. */
function stepGherkin(titulo: string, i: number, total: number): string {
  for (const [padrao, chave] of PALAVRAS_CHAVE) {
    if (padrao.test(titulo)) return `${chave} ${titulo.replace(padrao, '')}`;
  }
  const chave = i === 0 ? 'Given' : i === total - 1 ? 'Then' : 'And';
  aviso(`step sem palavra-chave Gherkin ("${titulo}") — publicado como "${chave}".`);
  return `${chave} ${titulo}`;
}

/**
 * Script do `gherkin_test`: Feature = o `test.describe` (ou o arquivo), Scenario =
 * o título do teste, um step Gherkin por `test.step`.
 */
function script(caso: Caso): string {
  const { teste } = caso;
  const feature =
    teste.parent.title ||
    teste.location.file.replace(/^.*[\\/]/, '').replace(/\.spec\.ts$/, '');
  const passos = nomesDosPassos(caso);
  return [
    `Feature: ${feature}`,
    '',
    `  Scenario: ${teste.title}`,
    ...passos.map((p, i) => `    ${stepGherkin(p, i, passos.length)}`),
  ].join('\n');
}

type Anexo = TestResult['attachments'][number];

/** Anexos de troca HTTP de um step, incluindo os de sub-steps. */
function anexosApi(passo: TestStep): Anexo[] {
  return [
    ...passo.attachments.filter((a) => a.name === ANEXO_API && a.body),
    ...passo.steps.flatMap(anexosApi),
  ];
}

/**
 * Evidência a anexar, em ordem de preferência:
 *
 * 1. as trocas HTTP feitas NO step-alvo (API: o request que falhou);
 * 2. o screenshot do fim do teste (web);
 * 3. todas as trocas HTTP do teste (API cujo step-alvo só assera, ex.:
 *    "Então a resposta deve ter status 400" — o request foi no "Quando").
 *
 * As trocas viram UM `.txt` temporário: o Octane anexa arquivo, não texto.
 */
async function escolherEvidencia(
  caso: Caso,
  indiceAlvo: number,
  runId: string,
): Promise<{ caminho: string; tipo: string } | undefined> {
  const doAlvo = caso.passos[indiceAlvo];
  const doPasso = doAlvo ? anexosApi(doAlvo) : [];
  if (doPasso.length > 0) return gravarTrocas(doPasso, runId);

  const screenshot = caso.resultado.attachments
    .filter((a) => a.name === 'screenshot' && a.path)
    .at(-1);
  if (screenshot?.path) return { caminho: screenshot.path, tipo: 'screenshot' };

  const doTeste = caso.resultado.attachments.filter(
    (a) => a.name === ANEXO_API && a.body,
  );
  if (doTeste.length > 0) return gravarTrocas(doTeste, runId);
  return undefined;
}

async function gravarTrocas(
  anexos: Anexo[],
  runId: string,
): Promise<{ caminho: string; tipo: string }> {
  const caminho = join(tmpdir(), `evidencia-api-run-${runId}.txt`);
  const texto = anexos.map((a) => a.body?.toString('utf8') ?? '').join('\n\n');
  await writeFile(caminho, texto, 'utf8');
  return { caminho, tipo: `evidência HTTP (${anexos.length} troca(s))` };
}

/** Teto do log no "Actual" do step — o essencial do erro cabe com folga. */
const MAX_LOG = 4000;

/**
 * Log de erro do Playwright para o "Actual" do step: mensagem + o trecho da
 * pilha que aponta para o código do projeto, sem os códigos de cor ANSI do
 * terminal (que no Octane viram lixo como `\u001b[31m`).
 */
function logDeErro(erro: TestError): string {
  // eslint-disable-next-line no-control-regex -- remover sequências ANSI é o objetivo
  const semAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');
  const mensagem = semAnsi(erro.message ?? erro.value ?? 'erro sem mensagem').trim();
  const pilha = semAnsi(erro.stack ?? '')
    .split('\n')
    .filter((l) => /^\s*at /.test(l) && !/node_modules/.test(l))
    .slice(0, 5)
    .join('\n');
  const local = erro.location
    ? `\nEm: ${relative(process.cwd(), erro.location.file).replace(/\\/g, '/')}:${erro.location.line}`
    : '';
  const texto = `${mensagem}${local}${pilha && !local ? `\n${pilha}` : ''}`;
  return texto.length > MAX_LOG ? `${texto.slice(0, MAX_LOG)}\n… (truncado)` : texto;
}

/** Step gherkin do run (Given/When/…), e não a linha de Feature ou de Scenario. */
function ehStepGherkin(passo: Entidade): boolean {
  try {
    // Feature e Scenario também trazem `description` (lista, às vezes [""]), mas
    // só elas têm `name` — é isso que as separa dos steps (Given/When/Then).
    const d = JSON.parse(String(passo.description ?? '{}')) as {
      name?: unknown;
      description?: unknown;
    };
    return d.name === undefined && Array.isArray(d.description);
  } catch {
    return true;
  }
}

/** Campo vazio no formato da REST API: null, "" ou coleção `{ data: [] }`. */
function vazio(valor: unknown): boolean {
  if (valor === null || valor === undefined || valor === '') return true;
  const data = (valor as { data?: unknown[] }).data;
  return Array.isArray(data) && data.length === 0;
}

/**
 * Para comparar o script do Octane com o do código: o Octane acrescenta ao
 * script gherkin a tag de revisão (`#Auto generated Octane revision tag` +
 * `@TID<id>REV<x>`), que não vem do código. Sem removê-la, todo run reescreveria
 * o script.
 */
function normalizar(texto: string): string {
  return texto
    .replace(/\r/g, '')
    .split('\n')
    .filter(
      (l) => !/^\s*(#Auto generated Octane revision tag|@TID\d+REV[\d.]+)\s*$/.test(l),
    )
    .map((l) => l.trimEnd())
    .join('\n')
    .trim();
}

function descricao(teste: TestCase): string {
  const arquivo = teste.location.file
    .replace(/\\/g, '/')
    .replace(/^.*?\/tests\//, 'tests/');
  return [
    `Gerado a partir do código Playwright: ${arquivo}:${teste.location.line}`,
    `Caminho: ${teste.titlePath().filter(Boolean).join(' › ')}`,
    'Os steps são sincronizados a partir dos test.step do código — edite o código, não este teste.',
  ].join('<br>');
}

function log(msg: string): void {
  console.log(`[octane] ${msg}`);
}

function aviso(msg: string): void {
  console.warn(`[octane] ⚠ ${msg}`);
}
