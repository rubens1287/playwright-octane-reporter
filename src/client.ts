import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import type { Conexao } from './config';

/** Referência a entidade no formato da REST API do Octane. */
export type Ref = { type: string; id: string };

export type Entidade = { id: string; type?: string; [campo: string]: unknown };

type Colecao = { data: Entidade[]; total_count?: number };

/** Itens por página nas buscas paginadas. */
const PAGINA = 1000;

/** Campo de lista de uma entidade, como o CLI `campos` o mostra. */
export type CampoDeLista = {
  /** Nome interno — o que vai depois de `OCTANE_FIELD_`. */
  nome: string;
  /** Rótulo exibido na tela. */
  rotulo: string;
  multiplo: boolean;
  /** Obrigatório no METADADO. Regras de negócio do workspace não aparecem aqui. */
  obrigatorio: boolean;
  customizado: boolean;
  valores: string[];
};

/**
 * Cliente mínimo da REST API do ALM Octane.
 *
 * Autenticação por usuário e senha (`POST /authentication/sign_in`). A sessão é
 * mantida pelos cookies devolvidos no sign-in; o cookie `HPSSO_COOKIE_CSRF`, quando
 * presente, é ecoado no header `HPSSO-HEADER-CSRF` — o Octane recusa escrita sem
 * ele.
 *
 * Nenhum valor de credencial é registrado em log.
 */
export class OctaneClient {
  private cookies = new Map<string, string>();
  private workspaceId: string | undefined;
  /**
   * Nomes por raiz de lista. O mesmo campo (e a mesma lista) aparece em várias
   * entidades — teste, run da suíte, run —, e há listas com milhares de valores
   * (observado: 4.723): sem cache, cada uma seria baixada uma vez por entidade.
   */
  private readonly listas = new Map<string, Promise<string[]>>();

  private nomesDaLista(raiz: string): Promise<string[]> {
    let nomes = this.listas.get(raiz);
    if (!nomes) {
      nomes = this.buscar(
        'list_nodes',
        `list_root EQ {logical_name EQ ${literal(raiz)}}`,
        ['name'],
      ).then((nos) => nos.map((n) => String(n.name)));
      this.listas.set(raiz, nomes);
    }
    return nomes;
  }

  constructor(private readonly config: Conexao) {}

  async autenticar(): Promise<void> {
    const resposta = await fetch(`${this.config.url}/authentication/sign_in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user: this.config.credenciais.user,
        password: this.config.credenciais.password,
      }),
    });
    if (!resposta.ok) {
      throw new Error(
        `Octane: falha no sign-in (HTTP ${resposta.status}): ${await resposta.text()}`,
      );
    }
    this.guardarCookies(resposta);
    this.workspaceId = await this.resolverWorkspace();
  }

  /** `OCTANE_WORKSPACE` aceita o ID numérico ou o nome (ex.: `MEU-WORKSPACE`). */
  private async resolverWorkspace(): Promise<string> {
    const alvo = this.config.workspace;
    if (/^\d+$/.test(alvo)) return alvo;
    const base = `/api/shared_spaces/${this.config.sharedSpaceId}/workspaces`;
    const lista = await this.requisitar<Colecao>(
      'GET',
      `${base}?query=${q(`name EQ ${literal(alvo)}`)}&fields=id,name`,
    );
    const encontrado = lista.data[0];
    if (!encontrado) {
      throw new Error(
        `Octane: workspace "${alvo}" não encontrado no shared space ${this.config.sharedSpaceId}.`,
      );
    }
    return encontrado.id;
  }

  private get base(): string {
    if (!this.workspaceId) throw new Error('Octane: cliente não autenticado.');
    return `/api/shared_spaces/${this.config.sharedSpaceId}/workspaces/${this.workspaceId}`;
  }

  // ── Operações genéricas ──────────────────────────────────────────────────

  /**
   * Busca TODOS os resultados, paginando por `offset` até `total_count`. Sem isso,
   * listas grandes saem cortadas na primeira página — observado: um campo de
   * lista com 4.723 valores, dos quais só 1.000 vinham, e um valor válido além
   * deles era recusado como "não existe".
   */
  async buscar(
    colecao: string,
    query: string,
    campos: string[],
    ordem?: string,
  ): Promise<Entidade[]> {
    const todos: Entidade[] = [];
    for (;;) {
      const partes = [
        `query=${q(query)}`,
        `fields=${campos.join(',')}`,
        `limit=${PAGINA}`,
        `offset=${todos.length}`,
      ];
      if (ordem) partes.push(`order_by=${ordem}`);
      const r = await this.requisitar<Colecao>(
        'GET',
        `${this.base}/${colecao}?${partes.join('&')}`,
      );
      todos.push(...r.data);
      const total = r.total_count ?? todos.length;
      if (r.data.length === 0 || todos.length >= total) return todos;
    }
  }

  /** Devolve `null` em 404 — usado para checar se o ID gravado no código ainda existe. */
  async obter(colecao: string, id: string, campos: string[]): Promise<Entidade | null> {
    try {
      return await this.requisitar<Entidade>(
        'GET',
        `${this.base}/${colecao}/${id}?fields=${campos.join(',')}`,
      );
    } catch (erro) {
      if (erro instanceof ErroOctane && erro.status === 404) return null;
      throw erro;
    }
  }

  async criar(colecao: string, dados: Record<string, unknown>): Promise<Entidade> {
    const r = await this.requisitar<Colecao>('POST', `${this.base}/${colecao}`, {
      data: [dados],
    });
    const criado = r.data[0];
    if (!criado) throw new Error(`Octane: POST /${colecao} não devolveu entidade.`);
    return criado;
  }

  async atualizar(colecao: string, id: string, dados: Record<string, unknown>) {
    await this.requisitar('PUT', `${this.base}/${colecao}/${id}`, dados);
  }

  /**
   * Cria os `run_step` de um run manual a partir do script do teste — a chamada
   * que o Manual Runner da UI faz ao abrir o run. Idempotente: com os steps já
   * criados, devolve os existentes.
   */
  async materializarSteps(runId: string): Promise<void> {
    await this.requisitar('PUT', `${this.base}/runs/${runId}/steps`, {});
  }

  async remover(colecao: string, id: string): Promise<void> {
    await this.requisitar('DELETE', `${this.base}/${colecao}/${id}`);
  }

  /**
   * Campos de LISTA editáveis de uma entidade — os que `OCTANE_FIELD_<campo>`
   * aceita —, com os valores possíveis (nomes exibidos). Usado pelo CLI.
   */
  async camposDeLista(entidade: string): Promise<CampoDeLista[]> {
    const meta = await this.requisitar<Colecao>(
      'GET',
      `${this.base}/metadata/fields?query=${q(`entity_name EQ ${literal(entidade)}`)}`,
    );
    const campos: CampoDeLista[] = [];
    for (const f of meta.data) {
      const tipo = f.field_type_data as
        | { multiple?: boolean; targets?: { type?: string; logical_name?: string }[] }
        | undefined;
      const raiz = tipo?.targets?.[0]?.logical_name;
      if (f.field_type !== 'reference' || !raiz || f.editable !== true) continue;
      campos.push({
        nome: String(f.name),
        rotulo: String(f.label ?? f.name),
        multiplo: tipo?.multiple === true,
        obrigatorio: f.required === true,
        customizado: f.is_user_defined === true || String(f.name).endsWith('_udf'),
        valores: await this.nomesDaLista(raiz),
      });
    }
    return campos;
  }

  // ── Operações específicas ───────────────────────────────────────────────

  async lerScript(testId: string): Promise<string> {
    const r = await this.requisitar<{ script?: string }>(
      'GET',
      `${this.base}/tests/${testId}/script`,
    );
    return r.script ?? '';
  }

  async gravarScript(testId: string, script: string): Promise<void> {
    await this.requisitar('PUT', `${this.base}/tests/${testId}/script`, {
      script,
      comment: 'Sincronizado a partir do código Playwright',
      revision_type: 'Minor',
    });
  }

  /**
   * IDs dos list_nodes que um campo de lista aceita, indexados pelo sufixo do
   * `logical_name` (ex.: `passed`, `failed`). Resolver pelo metadado, em vez de
   * fixar `list_node.run_native_status.passed` no código, evita depender de
   * logical names que variam entre versões e customizações do Octane.
   */
  async valoresDoCampo(entidade: string, campo: string): Promise<Map<string, Ref>> {
    const meta = await this.requisitar<Colecao>(
      'GET',
      `${this.base}/metadata/fields?query=${q(`entity_name EQ ${literal(entidade)}; name EQ ${literal(campo)}`)}`,
    );
    const tipo = meta.data[0]?.field_type_data as
      { targets?: { logical_name?: string }[] } | undefined;
    const raiz = tipo?.targets?.[0]?.logical_name;
    if (!raiz) {
      throw new Error(`Octane: lista do campo ${entidade}.${campo} não encontrada.`);
    }
    const nos = await this.buscar(
      'list_nodes',
      `list_root EQ {logical_name EQ ${literal(raiz)}}`,
      ['id', 'logical_name', 'name'],
    );
    const mapa = new Map<string, Ref>();
    for (const no of nos) {
      const logico = String(no.logical_name ?? '');
      mapa.set(logico.split('.').pop() ?? logico, { type: 'list_node', id: no.id });
    }
    return mapa;
  }

  /**
   * Valor de um campo de lista (ex.: UDF `regressivo_udf`) a partir dos NOMES
   * exibidos no Octane. Casa por nome exato (sem diferenciar maiúsculas) ou, se
   * não houver, por prefixo ÚNICO — o que permite `PRJ0001` no lugar do nome
   * longo do projeto. Nome inexistente ou ambíguo FALHA com as opções válidas.
   *
   * Devolve `undefined` se a ENTIDADE não tem o campo — o mesmo campo (ex.:
   * `empresa_udf`) existe no teste e nos runs, outros (`ciclo_udf`) só no run.
   */
  async valorDeLista(
    entidade: string,
    campo: string,
    nomes: string[],
  ): Promise<unknown | undefined> {
    const meta = await this.requisitar<Colecao>(
      'GET',
      `${this.base}/metadata/fields?query=${q(`entity_name EQ ${literal(entidade)}; name EQ ${literal(campo)}`)}`,
    );
    if (!meta.data[0]) return undefined;
    const tipo = meta.data[0].field_type_data as
      { multiple?: boolean; targets?: { logical_name?: string }[] } | undefined;
    const raiz = tipo?.targets?.[0]?.logical_name;
    if (!raiz) throw new Error(`Octane: ${entidade}.${campo} não é campo de lista.`);
    const nos = await this.buscar(
      'list_nodes',
      `list_root EQ {logical_name EQ ${literal(raiz)}}`,
      ['id', 'name'],
    );
    const refs = nomes.map((nome): Ref => {
      const alvo = nome.trim().toLowerCase();
      const nomeDe = (n: Entidade) =>
        String(n.name ?? '')
          .trim()
          .toLowerCase();
      const exato = nos.filter((n) => nomeDe(n) === alvo);
      const prefixo = nos.filter((n) => nomeDe(n).startsWith(alvo));
      const achado = exato.length === 1 ? exato : prefixo;
      if (achado.length !== 1 || !achado[0]) {
        throw new Error(
          `Octane: "${nome}" ${achado.length ? 'é ambíguo' : 'não existe'} em ${campo}. ` +
            `Opções: ${nos.map((n) => n.name).join(' | ')}`,
        );
      }
      return { type: 'list_node', id: achado[0].id };
    });
    return tipo?.multiple ? { data: refs } : refs[0];
  }

  /**
   * Entidade referenciada (program, milestone…) por ID numérico ou nome exato.
   * Inexistente ou ambígua FALHA.
   */
  async resolverPorNome(colecao: string, tipo: string, valor: string): Promise<Ref> {
    const query = /^\d+$/.test(valor) ? `id EQ ${valor}` : `name EQ ${literal(valor)}`;
    const achados = await this.buscar(colecao, query, ['id', 'name']);
    if (achados.length !== 1 || !achados[0]) {
      throw new Error(
        `Octane: ${tipo} "${valor}" ${achados.length ? 'é ambíguo' : 'não existe'} no workspace.`,
      );
    }
    return { type: tipo, id: achados[0].id };
  }

  /** `POST /attachments` multipart: parte `entity` (JSON) + parte `content` (arquivo). */
  async anexar(caminho: string, dono: Record<string, Ref>): Promise<Entidade> {
    const nome = basename(caminho);
    const form = new FormData();
    form.append(
      'entity',
      new Blob([JSON.stringify({ name: nome, ...dono })], { type: 'application/json' }),
    );
    form.append(
      'content',
      new Blob([await readFile(caminho)], { type: 'application/octet-stream' }),
      nome,
    );
    return this.requisitar<Entidade>('POST', `${this.base}/attachments`, form);
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────

  private async requisitar<T>(
    metodo: string,
    caminho: string,
    corpo?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.Cookie = cookie;
    const csrf = this.cookies.get('HPSSO_COOKIE_CSRF');
    if (csrf) headers['HPSSO-HEADER-CSRF'] = csrf;

    let body: FormData | string | undefined;
    if (corpo instanceof FormData) {
      body = corpo;
    } else if (corpo !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(corpo);
    }

    const resposta = await fetch(`${this.config.url}${caminho}`, {
      method: metodo,
      headers,
      body,
    });
    this.guardarCookies(resposta);
    const texto = await resposta.text();
    if (!resposta.ok) {
      throw new ErroOctane(resposta.status, `${metodo} ${caminho.split('?')[0]}`, texto);
    }
    return (texto ? JSON.parse(texto) : {}) as T;
  }

  private guardarCookies(resposta: Response): void {
    for (const linha of resposta.headers.getSetCookie()) {
      const [par] = linha.split(';');
      const i = par?.indexOf('=') ?? -1;
      if (par && i > 0) this.cookies.set(par.slice(0, i).trim(), par.slice(i + 1).trim());
    }
  }
}

export class ErroOctane extends Error {
  constructor(
    readonly status: number,
    operacao: string,
    resposta: string,
  ) {
    super(`Octane: ${operacao} → HTTP ${status}: ${resposta.slice(0, 500)}`);
  }
}

/** Literal de string na query language do Octane: `^valor^`, com escape de `^` e `\`. */
export function literal(valor: string): string {
  return `^${valor.replace(/\\/g, '\\\\').replace(/\^/g, '\\^')}^`;
}

function q(query: string): string {
  return encodeURIComponent(`"${query}"`);
}
