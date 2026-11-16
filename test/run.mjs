/**
 * Teste de ponta a ponta do pacote: um projeto Playwright de API publica num
 * Octane SIMULADO (`octane-mock.mjs`), duas vezes, e o estado do Octane é
 * conferido. Requer `npm run build` antes (usa `dist/`).
 *
 *   npm test
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { iniciarMock } from './octane-mock.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = join(RAIZ, 'test', '.tmp');
const PORTA_API = 4711;
const PORTA_OCTANE = 4712;

// ── Projeto Playwright de exemplo ─────────────────────────────────────────
rmSync(TMP, { recursive: true, force: true });
mkdirSync(join(TMP, 'tests'), { recursive: true });
writeFileSync(
  join(TMP, 'playwright.config.ts'),
  `import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  reporter: [['list'], ['../../dist/index.js']],
  use: { baseURL: 'http://127.0.0.1:${PORTA_API}' },
});
`,
);
const SPEC = join(TMP, 'tests', 'contatos.spec.ts');
writeFileSync(
  SPEC,
  `import { test as base, expect } from '@playwright/test';
import { comEvidencia } from '../../../dist/index.js';

const test = base.extend({
  request: async ({ request }, use, testInfo) => {
    await use(comEvidencia(request, testInfo));
  },
});

test.describe('Contatos', () => {
  test('CT-001 — recusa contato sem celular', async ({ request }) => {
    const r = await test.step('Quando eu envio POST /contatos sem celular', async () =>
      request.post('/contatos', {
        headers: { Authorization: 'Bearer SEGREDO-HEADER' },
        data: { nome: 'Ana', password: 'SEGREDO-CORPO' },
      }),
    );
    await test.step('Então a resposta deve ter status 400', async () => {
      expect(r.status()).toBe(400);
    });
  });

  test('CT-002 — falha de propósito', async ({ request }) => {
    const r = await test.step('Quando eu envio POST /contatos com celular', async () =>
      request.post('/contatos', { data: { nome: 'Ana', celular: '11999999999' } }),
    );
    await test.step('Então a resposta deve ter status 400', async () => {
      expect(r.status()).toBe(400);
    });
  });

  // Objeto de detalhes SEM tag: o reporter insere a tag dentro dele.
  test('CT-003 — com anotação', { annotation: { type: 'issue', description: 'X-1' } }, async ({ request }) => {
    await test.step('Quando eu envio POST /contatos sem celular', async () => {
      await request.post('/contatos', { data: { nome: 'Bia' } });
    });
  });

  // Objeto de detalhes COM tag: o reporter não mexe e avisa para juntar à mão.
  test('CT-004 — com tag própria', { tag: '@smoke' }, async ({ request }) => {
    await test.step('Quando eu envio POST /contatos sem celular', async () => {
      await request.post('/contatos', { data: { nome: 'Caio' } });
    });
  });
});
`,
);

// ── API sob teste ─────────────────────────────────────────────────────────
const api = createServer((req, res) => {
  let corpo = '';
  req.on('data', (c) => (corpo += c));
  req.on('end', () => {
    const ok = JSON.parse(corpo || '{}').celular;
    res.writeHead(ok ? 201 : 400, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? { id: 1 } : { erro: 'celular obrigatório' }));
  });
});
await new Promise((ok) => api.listen(PORTA_API, ok));
const octane = await iniciarMock(PORTA_OCTANE);

const ENV_BASE = {
  ...process.env,
  OCTANE_ENABLED: 'true',
  OCTANE_URL: `http://127.0.0.1:${PORTA_OCTANE}`,
  OCTANE_SHARED_SPACE_ID: '1001',
  OCTANE_WORKSPACE: '2002',
  OCTANE_SUITE: 'Suíte Teste',
  OCTANE_RELEASE_ID: '5',
  OCTANE_APPLICATION_MODULE_ID: '9',
  OCTANE_PROGRAM: 'X',
  OCTANE_MILESTONE: 'X',
  OCTANE_FIELD_regressivo_udf: 'Sim',
  OCTANE_FIELD_projeto_udf: 'PRJ2400',
  OCTANE_FAILURE_REASON_FIELD: 'motivo_udf',
  OCTANE_FAILURE_REASON: 'Bug',
};

/**
 * Roda o Playwright num processo filho, de forma ASSÍNCRONA: o Octane simulado e a
 * API vivem NESTE processo, e um `spawnSync` bloquearia o event loop — o filho
 * ficaria esperando respostas que nunca chegam.
 */
function executar(args, env) {
  return new Promise((ok) => {
    const filho = spawn(
      'npx',
      ['playwright', ...args, '--config', join(TMP, 'playwright.config.ts')],
      {
        cwd: RAIZ,
        env,
        shell: true,
      },
    );
    let saida = '';
    filho.stdout.on('data', (d) => (saida += d));
    filho.stderr.on('data', (d) => (saida += d));
    filho.on('close', () => ok(saida));
  });
}
const rodar = (credenciais) => executar(['test'], { ...ENV_BASE, ...credenciais });
const estado = async () => (await fetch(`http://127.0.0.1:${PORTA_OCTANE}/__db`)).json();

// ── Verificações ──────────────────────────────────────────────────────────
const falhas = [];
const verificar = (ok, descricao) => {
  console.log(`${ok ? '✓' : '✗'} ${descricao}`);
  if (!ok) falhas.push(descricao);
};

try {
  const saida1 = await rodar({ OCTANE_USER: 'u', OCTANE_PASSWORD: 'p' });
  const { db, scripts } = await estado();
  const testes = db.tests.filter((t) => t.subtype === 'gherkin_test');
  console.log('\n— 1ª execução (usuário e senha) —');
  verificar(!/PUBLICAÇÃO NO OCTANE FALHOU/.test(saida1), 'publicação sem erro');
  verificar(testes.length === 4, '4 testes gherkin criados');
  verificar(
    testes.every((t) => t.regressivo_udf?.id === 'list_node.regressivo.Sim'),
    'OCTANE_FIELD_regressivo_udf aplicado aos testes',
  );
  verificar(
    testes.every((t) => /^list_node\.projeto\.PRJ2400 /.test(t.projeto_udf?.id ?? '')),
    'valor além da 1ª página (PRJ2400 de 2.500) resolvido — paginação',
  );
  verificar(
    testes.every((t) => t.program?.id === '77' && t.product_areas?.data?.[0]?.id === '9'),
    'program e application module nos testes',
  );
  const script1 = scripts[testes[0]?.id] ?? '';
  verificar(
    /Feature: Contatos/.test(script1) &&
      /When eu envio POST/.test(script1) &&
      /Then a resposta/.test(script1),
    'script gherkin com Feature/When/Then',
  );
  const tags = readFileSync(SPEC, 'utf8').match(/@octane:\d+/g) ?? [];
  const fonte = readFileSync(SPEC, 'utf8');
  verificar(tags.length === 3, 'tags @octane gravadas no spec (3 automáticas)');
  verificar(
    /\{\s*tag: '@octane:\d+',\s*annotation:/.test(fonte),
    'tag inserida em objeto de detalhes que não tinha tag (CT-003)',
  );
  verificar(
    /{ tag: '@smoke' }/.test(fonte) &&
      /não consegui gravar a tag em .*Adicione manualmente/.test(saida1),
    'objeto com tag própria intocado + aviso para juntar à mão (CT-004)',
  );
  const suites = db.runs.filter((r) => r.subtype === 'run_suite');
  const filhos = db.runs.filter((r) => r.subtype === 'run_manual');
  verificar(
    suites.length === 1 && filhos.length === 4,
    'um run de suíte com 4 filhos (sem duplicar os gerados)',
  );
  verificar(
    suites[0]?.native_status?.id === 'list_node.run_native_status.failed',
    'run da suíte Failed',
  );
  const runDe = (titulo) =>
    filhos.find((r) => ref(r.test) === testes.find((t) => t.name.startsWith(titulo))?.id);
  const ref = (v) => v?.id;
  const r1 = runDe('CT-001');
  const r2 = runDe('CT-002');
  verificar(
    r1?.native_status?.id === 'list_node.run_native_status.passed',
    'CT-001 Passed',
  );
  verificar(
    r2?.native_status?.id === 'list_node.run_native_status.failed',
    'CT-002 Failed',
  );
  verificar(
    r2?.motivo_udf?.id === 'list_node.motivo.Bug' && !r1?.motivo_udf,
    'motivo de falha só no run que falhou',
  );
  verificar(
    r1?.milestone?.id === '77' && r1?.regressivo_udf,
    'milestone e OCTANE_FIELD nos runs',
  );
  const passos = (run) =>
    db.run_steps.filter(
      (s) => ref(s.run) === run?.id && !('name' in JSON.parse(s.description)),
    );
  const p2 = passos(r2);
  verificar(
    p2.map((s) => s.result?.id?.split('.').pop()).join(',') === 'passed,failed',
    'status por step do CT-002: passed,failed',
  );
  verificar(
    /toBe|Expected/.test(p2[1]?.actual ?? ''),
    'log de erro do Playwright no Actual do step que falhou',
  );
  const anexo1 = db.attachments.find((a) => a.donoId === passos(r1).at(-1)?.id);
  const anexo2 = db.attachments.find((a) => a.donoId === p2[1]?.id);
  verificar(
    anexo1?.dono === 'run_step' && /<<< 400/.test(anexo1.conteudo),
    'CT-001: troca HTTP no último step',
  );
  verificar(
    anexo2?.dono === 'run_step' && /<<< 201/.test(anexo2.conteudo),
    'CT-002: troca HTTP no step que falhou',
  );
  verificar(
    db.attachments.every((a) => !/SEGREDO-/.test(a.conteudo)),
    'nenhum segredo (header ou corpo) nos anexos',
  );

  const saida2 = await rodar({ OCTANE_USER: 'u', OCTANE_PASSWORD: 'p' });
  const depois = (await estado()).db;
  console.log('\n— 2ª execução —');
  verificar(!/PUBLICAÇÃO NO OCTANE FALHOU/.test(saida2), 'publicação sem erro');
  verificar(
    depois.tests.filter((t) => t.subtype === 'gherkin_test').length === 4,
    'nenhum teste recriado',
  );
  verificar(
    depois.runs.filter((r) => r.subtype === 'run_suite').length === 2,
    'novo run de suíte',
  );
  verificar(
    (readFileSync(SPEC, 'utf8').match(/@octane:\d+/g) ?? []).join() === tags.join(),
    'tags inalteradas',
  );

  const saida3 = await executar(['test', '--list'], {
    ...ENV_BASE,
    OCTANE_ENABLED: 'ture',
  });
  console.log('\n— configuração inválida —');
  verificar(/OCTANE_ENABLED inválida/.test(saida3), 'OCTANE_ENABLED=ture falha alto');

  // CLI `campos`: só leitura, e funciona com a integração DESLIGADA.
  const rodarCli = (...args) =>
    new Promise((ok) => {
      const filho = spawn('node', [join(RAIZ, 'dist', 'cli.js'), 'campos', ...args], {
        env: {
          ...ENV_BASE,
          OCTANE_ENABLED: 'false',
          OCTANE_USER: 'u',
          OCTANE_PASSWORD: 'p',
        },
      });
      let saida = '';
      filho.stdout.on('data', (d) => (saida += d));
      filho.stderr.on('data', (d) => (saida += d));
      filho.on('close', (codigo) => ok({ saida, codigo }));
    });
  const cli = await rodarCli();
  console.log('\n— CLI campos —');
  verificar(cli.codigo === 0, 'CLI termina com sucesso (integração desligada)');
  verificar(
    /OCTANE_FIELD_regressivo_udf/.test(cli.saida) &&
      /existe em: teste, run da suíte, run/.test(cli.saida) &&
      /valores:\s+Sim \| Não/.test(cli.saida),
    'CLI lista campo, onde existe e valores',
  );
  verificar(
    /OCTANE_FIELD_motivo_udf/.test(cli.saida) &&
      !/OCTANE_FIELD_native_status/.test(cli.saida),
    'CLI mostra só customizados editáveis',
  );
  verificar(
    /valores:\s+2\.500 — ex\.:/.test(cli.saida) &&
      /buscar:\s+npx playwright-octane-reporter campos projeto_udf <texto>/.test(
        cli.saida,
      ) &&
      cli.saida.length < 3000,
    'CLI resume campo com 2.500 valores (saída curta)',
  );
  const busca = await rodarCli('projeto', 'PRJ2400');
  verificar(
    /valores com "PRJ2400": 1 de 2\.500/.test(busca.saida) &&
      /PRJ2400 - Projeto número 2400 com descrição longa/.test(busca.saida),
    'CLI busca valor além da 1ª página, completo',
  );

  if (falhas.length > 0) {
    console.log(
      `\n${falhas.length} verificação(ões) falharam. Saída da 1ª execução:\n${saida1}`,
    );
  }
} finally {
  api.close();
  octane.close();
}
console.log(falhas.length === 0 ? '\nTUDO OK' : '\nFALHOU');
process.exit(falhas.length === 0 ? 0 : 1);
