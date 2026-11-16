import type { APIRequestContext, APIResponse, TestInfo } from '@playwright/test';

/**
 * Nome do anexo com a troca HTTP de um teste de API (request + response). O
 * reporter o envia ao Octane como evidência do step; sem ele, usa o screenshot.
 */
export const ANEXO_API = 'evidencia-api';

/**
 * Evidência de teste de API: cada chamada HTTP vira um anexo de texto com o
 * request e o response, gravado no `test.step` em que aconteceu.
 *
 * É o equivalente do screenshot de um teste web. O reporter envia ao step que FALHOU as trocas feitas nele — ou, se o teste
 * passou, as do último step. O anexo também aparece no relatório HTML.
 *
 * Funciona por EMBRULHO do `APIRequestContext`, numa fixture que sobrescreve
 * `request` (ver README): clients e testes não mudam, e nenhuma chamada escapa
 * por esquecimento.
 *
 * ┌─ SEGREDO NUNCA SAI DAQUI ──────────────────────────────────────────────────┐
 * │ Headers e campos de corpo com nome de credencial viram `***` ANTES de      │
 * │ gravar o anexo. Headers padrão do config (`extraHTTPHeaders`, onde       │
 * │ costuma ir o token) nem chegam ao captador.                               │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

const METODOS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'fetch']);

/** Nome de header ou campo que carrega credencial. */
const SENSIVEL =
  /authorization|cookie|token|secret|senha|password|passwd|api[-_]?key|credential/i;

/** Teto por corpo: o essencial cabe, e o anexo não estoura o limite do Octane. */
const MAX_CORPO = 3000;

type Opcoes = {
  method?: string;
  headers?: Record<string, string>;
  data?: unknown;
  form?: unknown;
  params?: unknown;
};

type Chamada = (url: string, opcoes?: Opcoes) => Promise<APIResponse>;

export function comEvidencia(
  request: APIRequestContext,
  testInfo: TestInfo,
): APIRequestContext {
  return new Proxy(request, {
    get(alvo, propriedade, receptor) {
      const original: unknown = Reflect.get(alvo, propriedade, receptor);
      if (
        typeof propriedade !== 'string' ||
        !METODOS.has(propriedade) ||
        typeof original !== 'function'
      ) {
        return original;
      }
      const chamar = original as Chamada;
      const embrulhada: Chamada = async (url, opcoes) => {
        const inicio = Date.now();
        const resposta = await chamar.call(alvo, url, opcoes);
        const metodo = (
          opcoes?.method ?? (propriedade === 'fetch' ? 'GET' : propriedade)
        ).toUpperCase();
        await testInfo.attach(ANEXO_API, {
          body: await descrever(metodo, opcoes, resposta, Date.now() - inicio),
          contentType: 'text/plain',
        });
        return resposta;
      };
      return embrulhada;
    },
  });
}

async function descrever(
  metodo: string,
  opcoes: Opcoes | undefined,
  resposta: APIResponse,
  duracaoMs: number,
): Promise<string> {
  const corpoEnviado = opcoes?.data ?? opcoes?.form;
  let corpoRecebido: string;
  try {
    // O corpo do APIResponse fica em buffer: ler aqui não o consome para o teste.
    corpoRecebido = mascararCorpo(await resposta.text());
  } catch {
    corpoRecebido = '(corpo indisponível)';
  }
  return [
    `>>> ${metodo} ${resposta.url()}`,
    ...linhasDeHeaders(opcoes?.headers ?? {}),
    ...(corpoEnviado === undefined ? [] : ['', limitar(mascararCorpo(corpoEnviado))]),
    '',
    `<<< ${resposta.status()} ${resposta.statusText()} (${duracaoMs} ms)`,
    ...linhasDeHeaders(resposta.headers()),
    '',
    limitar(corpoRecebido) || '(sem corpo)',
  ].join('\n');
}

function linhasDeHeaders(headers: Record<string, string>): string[] {
  return Object.entries(headers).map(
    ([nome, valor]) => `${nome}: ${SENSIVEL.test(nome) ? '***' : valor}`,
  );
}

/** JSON com campos sensíveis mascarados; texto não-JSON passa como está. */
function mascararCorpo(corpo: unknown): string {
  let valor = corpo;
  if (typeof corpo === 'string') {
    try {
      valor = JSON.parse(corpo);
    } catch {
      return corpo;
    }
  }
  return JSON.stringify(
    valor,
    (chave, v: unknown) => (chave && SENSIVEL.test(chave) ? '***' : v),
    2,
  );
}

function limitar(texto: string): string {
  return texto.length > MAX_CORPO
    ? `${texto.slice(0, MAX_CORPO)}\n… (truncado, ${texto.length} caracteres)`
    : texto;
}
