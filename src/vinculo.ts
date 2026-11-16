import { readFile, writeFile } from 'node:fs/promises';

/**
 * Vínculo código ↔ Octane: a tag `@octane:<id>` no próprio `test(...)`.
 *
 *   test('CT-W001 — …', { tag: '@octane:1234' }, async ({ … }) => { … });
 *
 * O ID fica VERSIONADO junto do teste: renomear o título não cria teste novo no
 * Octane, e quem lê o spec sabe para onde ele publica. A tag é escrita pelo
 * reporter na primeira publicação e deve ser commitada.
 */

export const PREFIXO_TAG = '@octane:';

export function idDaTag(tags: readonly string[]): string | undefined {
  for (const tag of tags) {
    if (tag.startsWith(PREFIXO_TAG)) return tag.slice(PREFIXO_TAG.length);
  }
  return undefined;
}

export type Gravacao = {
  arquivo: string;
  /** 1-based, como em `TestCase.location`. */
  linha: number;
  coluna: number;
  novoId: string;
  /** ID antigo a substituir (teste apagado no Octane e recriado). */
  idAnterior?: string;
};

/**
 * Grava as tags no código-fonte. Agrupa por arquivo e aplica de baixo para cima,
 * para que uma inserção não desloque a posição das seguintes. Devolve as
 * gravações que NÃO puderam ser feitas automaticamente.
 */
export async function gravarTags(gravacoes: Gravacao[]): Promise<Gravacao[]> {
  const falhas: Gravacao[] = [];
  const porArquivo = new Map<string, Gravacao[]>();
  for (const g of gravacoes) {
    porArquivo.set(g.arquivo, [...(porArquivo.get(g.arquivo) ?? []), g]);
  }

  for (const [arquivo, lista] of porArquivo) {
    let fonte = await readFile(arquivo, 'utf8');
    const ordenada = lista
      .map((g) => ({ g, offset: offsetDe(fonte, g.linha, g.coluna) }))
      .sort((a, b) => b.offset - a.offset);

    for (const { g, offset } of ordenada) {
      const novo = aplicar(fonte, offset, g);
      if (novo === null) falhas.push(g);
      else fonte = novo;
    }
    await writeFile(arquivo, await formatar(arquivo, fonte), 'utf8');
  }
  return falhas;
}

function aplicar(fonte: string, offset: number, g: Gravacao): string | null {
  const tag = `${PREFIXO_TAG}${g.novoId}`;

  // Tag antiga presente: troca só o ID, no mesmo lugar.
  if (g.idAnterior) {
    const antiga = `${PREFIXO_TAG}${g.idAnterior}`;
    const i = fonte.indexOf(antiga, offset);
    if (i >= 0) return fonte.slice(0, i) + tag + fonte.slice(i + antiga.length);
  }

  // test( 'título' , ← aqui entra `{ tag: … },` ou dentro do `{ … }` existente.
  const abre = fonte.indexOf('(', offset);
  if (abre < 0) return null;
  let i = pularEspacos(fonte, abre + 1);
  const fimTitulo = fimDeLiteral(fonte, i);
  if (fimTitulo < 0) return null;
  i = pularEspacos(fonte, fimTitulo);
  if (fonte[i] !== ',') return null;
  i = pularEspacos(fonte, i + 1);

  if (fonte[i] === '{') {
    // Objeto de detalhes já existe. Com `tag:` dentro, a edição deixa de ser
    // mecânica (string → array, posição) — melhor pedir ao humano.
    const fecha = fonte.indexOf('}', i);
    if (fecha < 0 || /\btag\s*:/.test(fonte.slice(i, fecha))) return null;
    return `${fonte.slice(0, i + 1)} tag: '${tag}',${fonte.slice(i + 1)}`;
  }
  return `${fonte.slice(0, i)}{ tag: '${tag}' }, ${fonte.slice(i)}`;
}

function offsetDe(fonte: string, linha: number, coluna: number): number {
  let offset = 0;
  for (let l = 1; l < linha; l++) offset = fonte.indexOf('\n', offset) + 1;
  return offset + coluna - 1;
}

function pularEspacos(fonte: string, i: number): number {
  while (i < fonte.length && /\s/.test(fonte[i] ?? '')) i++;
  return i;
}

/** Índice logo após o literal de string que começa em `i`; -1 se não houver. */
function fimDeLiteral(fonte: string, i: number): number {
  const aspa = fonte[i];
  if (aspa !== "'" && aspa !== '"' && aspa !== '`') return -1;
  for (let j = i + 1; j < fonte.length; j++) {
    if (fonte[j] === '\\') j++;
    else if (fonte[j] === aspa) return j + 1;
  }
  return -1;
}

/** Prettier é devDependency do projeto; sem ele, grava sem formatar. */
async function formatar(arquivo: string, fonte: string): Promise<string> {
  try {
    const prettier = await import('prettier');
    const opcoes = (await prettier.resolveConfig(arquivo)) ?? {};
    return await prettier.format(fonte, { ...opcoes, filepath: arquivo });
  } catch {
    return fonte;
  }
}
