import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Configuração do reporter, lida de variáveis de ambiente `OCTANE_*`.
 *
 * O `.env` da raiz do projeto (diretório de trabalho) é carregado se existir, via
 * `process.loadEnvFile` (Node >= 20.12). Variável já definida no shell/CI VENCE o
 * arquivo — então `OCTANE_ENABLED=false npm test` desliga uma execução avulsa.
 */

/** Configuração resolvida. `null` quando a integração está desligada. */
export type OctaneConfig = {
  url: string;
  sharedSpaceId: string;
  /** ID numérico ou NOME do workspace — o nome é resolvido para ID na publicação. */
  workspace: string;
  /** Usuário e senha do Octane. */
  credenciais: { user: string; password: string };
  suiteName: string;
  releaseId: string;
  /** Application module (`product_area`) dos testes e da suíte. */
  applicationModuleId: string | undefined;
  /** Program (nome ou ID) do teste, da suíte e dos runs. */
  program: string | undefined;
  /** Milestone (nome ou ID) dos runs. */
  milestone: string | undefined;
  /**
   * Campo de lista que recebe o motivo de falha nos runs que NÃO passaram, e o
   * valor (nome exibido). Ex.: `motivo_udf` + `Bug`. Opcional — só para
   * workspaces que exigem motivo em run Failed.
   */
  motivoFalha: { campo: string; valor: string } | undefined;
  /**
   * Campos de lista a preencher, de `OCTANE_FIELD_<campo>=<nome>[,<nome>…]`. Cada
   * um vale para toda entidade (teste, run da suíte, run manual) que tem o campo.
   */
  campos: Record<string, string[]>;
};

const PREFIXO_CAMPO = 'OCTANE_FIELD_';

function carregarEnv(): void {
  const arquivo = resolve(process.cwd(), '.env');
  if (existsSync(arquivo)) process.loadEnvFile(arquivo);
}

function ler(nome: string): string | undefined {
  const valor = process.env[nome]?.trim();
  return valor ? valor : undefined;
}

function obrigatoria(nome: string): string {
  const valor = ler(nome);
  if (!valor) {
    throw new Error(
      `[octane] variável obrigatória ausente: ${nome}. ` +
        'Defina-a ou desligue a integração com OCTANE_ENABLED=false.',
    );
  }
  return valor;
}

/**
 * `OCTANE_ENABLED`: `true` liga; `false` ou ausente desliga; outro valor FALHA
 * ALTO — um `ture` não pode desligar a publicação em silêncio.
 */
function ligada(): boolean {
  const valor = (process.env.OCTANE_ENABLED ?? '').trim().toLowerCase();
  if (valor === 'true') return true;
  if (valor === '' || valor === 'false') return false;
  throw new Error(
    `[octane] OCTANE_ENABLED inválida: "${process.env.OCTANE_ENABLED}". Use true ou false.`,
  );
}

function lerCredenciais(): OctaneConfig['credenciais'] {
  return { user: obrigatoria('OCTANE_USER'), password: obrigatoria('OCTANE_PASSWORD') };
}

function lerCampos(): Record<string, string[]> {
  const campos: Record<string, string[]> = {};
  for (const [variavel, valor] of Object.entries(process.env)) {
    if (!variavel.startsWith(PREFIXO_CAMPO) || !valor) continue;
    const campo = variavel.slice(PREFIXO_CAMPO.length);
    const nomes = valor
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    if (campo && nomes.length > 0) campos[campo] = nomes;
  }
  return campos;
}

function lerMotivoFalha(): OctaneConfig['motivoFalha'] {
  const campo = ler('OCTANE_FAILURE_REASON_FIELD');
  const valor = ler('OCTANE_FAILURE_REASON');
  if (!campo && !valor) return undefined;
  if (!campo || !valor) {
    throw new Error(
      '[octane] OCTANE_FAILURE_REASON_FIELD e OCTANE_FAILURE_REASON andam juntas: defina as duas ou nenhuma.',
    );
  }
  return { campo, valor };
}

/** O suficiente para falar com o Octane — usado também pelo CLI, que só lê. */
export type Conexao = Pick<
  OctaneConfig,
  'url' | 'sharedSpaceId' | 'workspace' | 'credenciais'
>;

/**
 * Só a conexão, sem exigir `OCTANE_ENABLED` nem suíte/release: o CLI de consulta
 * (`npx playwright-octane-reporter campos`) não publica nada.
 */
export function lerConexao(): Conexao {
  carregarEnv();
  return {
    url: obrigatoria('OCTANE_URL').replace(/\/+$/, ''),
    sharedSpaceId: obrigatoria('OCTANE_SHARED_SPACE_ID'),
    workspace: obrigatoria('OCTANE_WORKSPACE'),
    credenciais: lerCredenciais(),
  };
}

/** Lê e valida a configuração. Chamado uma vez, ao carregar o reporter. */
export function lerConfig(): OctaneConfig | null {
  carregarEnv();
  if (!ligada()) return null;
  return {
    ...lerConexao(),
    suiteName: obrigatoria('OCTANE_SUITE'),
    releaseId: obrigatoria('OCTANE_RELEASE_ID'),
    applicationModuleId: ler('OCTANE_APPLICATION_MODULE_ID'),
    program: ler('OCTANE_PROGRAM'),
    milestone: ler('OCTANE_MILESTONE'),
    motivoFalha: lerMotivoFalha(),
    campos: lerCampos(),
  };
}
