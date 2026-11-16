#!/usr/bin/env node
/**
 * CLI de consulta do playwright-octane-reporter. SÓ LÊ — nada é criado nem
 * alterado no Octane, e funciona com `OCTANE_ENABLED=false`.
 *
 *   npx playwright-octane-reporter campos [campo] [valor] [--todos] [--valores]
 *
 * Usa as variáveis de CONEXÃO do `.env` (URL, shared space, workspace,
 * credencial) e lista os campos de lista que `OCTANE_FIELD_<campo>` aceita.
 */
import { OctaneClient, type CampoDeLista } from './client';
import { lerConexao } from './config';

/** As entidades em que o reporter aplica `OCTANE_FIELD_*`. */
const ENTIDADES: [string, string][] = [
  ['gherkin_test', 'teste'],
  ['run_suite', 'run da suíte'],
  ['run_manual', 'run'],
];

/** Até quantos valores um campo mostra por extenso; acima disso, só amostra. */
const MAX_INLINE = 15;
/** Corte de cada valor na listagem resumida. */
const MAX_TEXTO = 60;
/** Máximo de valores listados numa busca por valor. */
const MAX_ACHADOS = 50;

const AJUDA = `playwright-octane-reporter — consulta ao Octane (só leitura)

Uso:
  npx playwright-octane-reporter campos [campo] [valor] [--todos] [--valores]

  campos      lista os campos de lista que OCTANE_FIELD_<campo> aceita, com o
              rótulo da tela, onde cada um existe e os valores possíveis
  campo       só campos cujo nome ou rótulo contém o texto   (ex.: ambiente)
  valor       só os valores que contêm o texto, completos     (ex.: projeto PRJ0001)
  --todos     inclui os campos padrão do Octane (padrão: só customizados)
  --valores   todos os valores, completos, um por linha

Campos com mais de ${MAX_INLINE} valores aparecem resumidos — busque o que precisa:
  npx playwright-octane-reporter campos projeto PRJ0001

Conexão: OCTANE_URL, OCTANE_SHARED_SPACE_ID, OCTANE_WORKSPACE e
OCTANE_USER e OCTANE_PASSWORD, lidas do
ambiente ou do .env do diretório atual.`;

type CampoAgrupado = CampoDeLista & { entidades: string[] };

type Opcoes = {
  campo: string | undefined;
  valor: string | undefined;
  todos: boolean;
  valores: boolean;
};

const cortar = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const milhar = (n: number) => n.toLocaleString('pt-BR');

async function campos(op: Opcoes): Promise<void> {
  const cliente = new OctaneClient(lerConexao());
  await cliente.autenticar();

  const porNome = new Map<string, CampoAgrupado>();
  for (const [entidade, rotulo] of ENTIDADES) {
    for (const campo of await cliente.camposDeLista(entidade)) {
      const existente = porNome.get(campo.nome);
      if (existente) existente.entidades.push(rotulo);
      else porNome.set(campo.nome, { ...campo, entidades: [rotulo] });
    }
  }

  const alvo = op.campo?.toLowerCase();
  const lista = [...porNome.values()]
    .filter((c) => op.todos || c.customizado)
    .filter(
      (c) =>
        !alvo ||
        c.nome.toLowerCase().includes(alvo) ||
        c.rotulo.toLowerCase().includes(alvo),
    )
    .sort((a, b) => a.nome.localeCompare(b.nome));

  if (lista.length === 0) {
    console.log(
      `Nenhum campo de lista${op.todos ? '' : ' customizado'}${op.campo ? ` com "${op.campo}"` : ''}.` +
        (op.todos ? '' : ' Use --todos para incluir os campos padrão do Octane.'),
    );
    return;
  }

  const busca = op.valor?.toLowerCase();
  for (const c of lista) {
    const marcas = [
      c.multiplo ? 'múltipla escolha' : '',
      c.obrigatorio ? 'obrigatório' : '',
    ]
      .filter(Boolean)
      .join(', ');
    console.log(`\nOCTANE_FIELD_${c.nome}`);
    console.log(`  rótulo:    ${c.rotulo}${marcas ? `  (${marcas})` : ''}`);
    console.log(`  existe em: ${c.entidades.join(', ')}`);

    if (busca) {
      const achados = c.valores.filter((v) => v.toLowerCase().includes(busca));
      console.log(
        `  valores com "${op.valor}": ${achados.length === 0 ? 'nenhum' : milhar(achados.length)} de ${milhar(c.valores.length)}`,
      );
      for (const v of achados.slice(0, MAX_ACHADOS)) console.log(`    ${v}`);
      if (achados.length > MAX_ACHADOS) {
        console.log(`    … +${milhar(achados.length - MAX_ACHADOS)} — refine a busca`);
      }
    } else if (op.valores) {
      console.log(`  valores (${milhar(c.valores.length)}):`);
      for (const v of c.valores) console.log(`    ${v}`);
    } else if (c.valores.length <= MAX_INLINE) {
      console.log(
        `  valores:   ${c.valores.map((v) => cortar(v, MAX_TEXTO)).join(' | ') || '(lista vazia)'}`,
      );
    } else {
      const amostra = c.valores.slice(0, 3).map((v) => cortar(v, 40));
      console.log(
        `  valores:   ${milhar(c.valores.length)} — ex.: ${amostra.join(' | ')} | …`,
      );
      console.log(`  buscar:    npx playwright-octane-reporter campos ${c.nome} <texto>`);
    }
  }
  console.log(
    `\n${lista.length} campo(s). O valor da variável é o NOME exibido; prefixo único basta.` +
      '\nRegras de negócio do workspace (campo exigido só ao gravar) não aparecem como "obrigatório" aqui.',
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const comando = args[0];
  if (comando !== 'campos') {
    console.log(AJUDA);
    process.exitCode = comando && !['-h', '--help', 'ajuda'].includes(comando) ? 1 : 0;
    return;
  }
  const [campo, valor] = args.slice(1).filter((a) => !a.startsWith('--'));
  await campos({
    campo,
    valor,
    todos: args.includes('--todos'),
    valores: args.includes('--valores'),
  });
}

main().catch((erro: unknown) => {
  console.error(erro instanceof Error ? erro.message : String(erro));
  process.exitCode = 1;
});
