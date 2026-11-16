/**
 * Octane SIMULADO para o teste do pacote. Reproduz o subconjunto da REST API que
 * o reporter usa, com os comportamentos observados num Octane real:
 *
 * - escrita exige o cookie de sessão do sign-in;
 * - `suite_run` gera os runs filhos (um por teste ligado) ~300 ms DEPOIS;
 * - `PUT /runs/{id}/steps` materializa os steps a partir do script gherkin;
 * - o script lido volta com a revision tag (`#Auto generated…` + `@TID…REV…`);
 * - `runs` e `run_steps` não aceitam POST.
 */
import { createServer } from 'node:http';

export function iniciarMock(porta) {
  let seq = 1000;
  const novoId = () => String(++seq);
  const db = {
    tests: [],
    test_suite_link_to_tests: [],
    runs: [],
    run_steps: [],
    attachments: [],
  };
  const scripts = {};
  const W = '/api/shared_spaces/1001/workspaces/2002/';
  const LISTAS = {
    'list_node.run_native_status': ['passed', 'failed', 'blocked', 'skipped', 'planned'],
    'list_node.regressivo': ['Sim', 'Não'],
    'list_node.motivo': ['Bug', 'Ambiente indisponível'],
    // Lista GRANDE (mais de uma página de 1.000), como os campos de projeto de um
    // Octane real: valores além da 1ª página só são achados com paginação.
    'list_node.projeto': Array.from(
      { length: 2500 },
      (_, i) =>
        `PRJ${String(i + 1).padStart(4, '0')} - Projeto número ${i + 1} com descrição longa`,
    ),
  };
  const CAMPOS = {
    run: { native_status: 'list_node.run_native_status' },
    run_step: { result: 'list_node.run_native_status' },
    gherkin_test: {
      regressivo_udf: 'list_node.regressivo',
      projeto_udf: 'list_node.projeto',
    },
    run_suite: { regressivo_udf: 'list_node.regressivo' },
    run_manual: {
      regressivo_udf: 'list_node.regressivo',
      motivo_udf: 'list_node.motivo',
    },
  };
  const ref = (v) => v?.id;
  const m = (q, re) => q.match(re)?.[1];

  function filtrar(lista, q) {
    if (!q) return lista;
    const nome = m(q, /name EQ \^(.*?)\^/);
    const sub = m(q, /subtype EQ '(\w+)'/);
    const pa = m(q, /product_areas EQ \{id EQ (\d+)\}/);
    const suite = m(q, /test_suite EQ \{id EQ (\d+)\}/);
    const pai = m(q, /parent_suite EQ \{id EQ (\d+)\}/);
    const run = m(q, /^run EQ \{id EQ (\d+)\}/);
    return lista.filter(
      (e) =>
        (!nome || e.name === nome) &&
        (!sub || e.subtype === sub) &&
        (!pa || e.product_areas?.data?.some((p) => p.id === pa)) &&
        (!suite || ref(e.test_suite) === suite) &&
        (!pai || ref(e.parent_suite) === pai) &&
        (!run || ref(e.run) === run),
    );
  }

  function materializar(runId) {
    if (db.run_steps.some((s) => ref(s.run) === runId)) return;
    const run = db.runs.find((r) => r.id === runId);
    const linhas = (scripts[ref(run.test)] ?? '').split('\n').map((l) => l.trim());
    for (const l of linhas) {
      let d;
      if (l.startsWith('Feature:'))
        d = { name: l.slice(8).trim(), description: [''], type: 'Feature' };
      else if (l.startsWith('Scenario:'))
        d = { name: l.slice(9).trim(), index: { major: 1 } };
      else if (/^(Given|When|Then|And|But) /.test(l))
        d = { description: [l], type: l.split(' ')[0] };
      if (d)
        db.run_steps.push({
          id: novoId(),
          description: JSON.stringify(d),
          run: { type: 'run_manual', id: runId },
        });
    }
  }

  const servidor = createServer((req, res) => {
    const partes = [];
    req.on('data', (c) => partes.push(c));
    req.on('end', () => {
      const corpo = Buffer.concat(partes).toString('utf8');
      const u = new URL(req.url, 'http://x');
      const p = u.pathname;
      const q = u.searchParams.get('query')?.replace(/^"|"$/g, '');
      const enviar = (s, o, h = {}) => {
        res.writeHead(s, { 'content-type': 'application/json', ...h });
        res.end(JSON.stringify(o));
      };
      if (p === '/__db') return enviar(200, { db, scripts });
      if (p === '/authentication/sign_in') {
        const j = JSON.parse(corpo);
        const ok = j.user === 'u' && j.password === 'p';
        return ok
          ? enviar(200, {}, { 'set-cookie': ['LWSSO_COOKIE_KEY=s; Path=/'] })
          : enviar(401, { error_code: 'platform.not_authorized' });
      }
      if (!(req.headers.cookie ?? '').includes('LWSSO_COOKIE_KEY=s'))
        return enviar(401, {});
      if (p.endsWith('/workspaces'))
        return enviar(200, { data: [{ id: '2002', name: 'WS' }] });
      if (!p.startsWith(W)) return enviar(404, { p });
      const [col, id, sub] = p.slice(W.length).split('/');

      if (col === 'metadata') {
        const ent = m(q, /entity_name EQ \^(.*?)\^/);
        // `; name EQ`, e não só `name EQ`: este casaria dentro de `entity_name EQ`.
        const nome = m(q, /; name EQ \^(.*?)\^/);
        if (!nome) {
          // Sem filtro de nome: todos os campos da entidade (usado pelo CLI `campos`).
          return enviar(200, {
            data: Object.entries(CAMPOS[ent] ?? {}).map(([n, r]) => ({
              name: n,
              label: n.endsWith('_udf') ? `Rótulo de ${n}` : n,
              field_type: 'reference',
              editable: n !== 'native_status',
              required: false,
              is_user_defined: n.endsWith('_udf'),
              field_type_data: { multiple: false, targets: [{ logical_name: r }] },
            })),
          });
        }
        const raiz = CAMPOS[ent]?.[nome];
        return enviar(200, {
          data: raiz
            ? [
                {
                  field_type_data: { multiple: false, targets: [{ logical_name: raiz }] },
                },
              ]
            : [],
        });
      }
      if (col === 'list_nodes') {
        const raiz = m(q, /\^(.*?)\^/);
        // Pagina como o Octane real: `limit`/`offset` e `total_count`.
        const todos = LISTAS[raiz] ?? [];
        const limite = Number(u.searchParams.get('limit') ?? 100);
        const inicio = Number(u.searchParams.get('offset') ?? 0);
        return enviar(200, {
          total_count: todos.length,
          data: todos.slice(inicio, inicio + limite).map((n) => ({
            id: `${raiz}.${n}`,
            logical_name: `${raiz}.${n}`,
            name: n,
          })),
        });
      }
      if (col === 'programs' || col === 'milestones') {
        return enviar(200, {
          data: m(q, /name EQ \^(.*?)\^/) === 'X' ? [{ id: '77', name: 'X' }] : [],
        });
      }
      if (col === 'attachments') {
        const dono = corpo.match(/"owner_(run_step|run)":\{"type":"\w+","id":"(\d+)"\}/);
        const conteudo = corpo.split('\r\n\r\n').slice(2).join('\r\n\r\n');
        db.attachments.push({
          id: novoId(),
          dono: dono?.[1],
          donoId: dono?.[2],
          conteudo,
        });
        return enviar(201, { data: [{ id: String(seq) }] });
      }
      if (col === 'runs' && sub === 'steps' && req.method === 'PUT') {
        materializar(id);
        return enviar(200, { data: db.run_steps.filter((s) => ref(s.run) === id) });
      }
      if (sub === 'script') {
        if (req.method === 'GET') {
          const s = scripts[id];
          return enviar(200, {
            script: s
              ? `#Auto generated Octane revision tag\n@TID${id}REV0.2.0\n${s}`
              : '',
          });
        }
        scripts[id] = JSON.parse(corpo).script;
        return enviar(200, {});
      }
      const tabela = { suite_run: 'runs', manual_runs: 'runs' }[col] ?? col;
      if (!db[tabela]) return enviar(404, { col });
      if ((col === 'runs' || col === 'run_steps') && req.method === 'POST')
        return enviar(403, { error_code: 'platform.web_application' });

      if (req.method === 'POST') {
        const e = { id: novoId(), ...JSON.parse(corpo).data[0] };
        if (col === 'suite_run') e.subtype = 'run_suite';
        if (col === 'manual_runs') e.subtype = 'run_manual';
        db[tabela].push(e);
        if (col === 'suite_run') {
          setTimeout(() => {
            for (const l of db.test_suite_link_to_tests.filter(
              (x) => ref(x.test_suite) === ref(e.test),
            )) {
              db.runs.push({
                id: novoId(),
                subtype: 'run_manual',
                test: l.test,
                parent_suite: { type: 'run_suite', id: e.id },
                native_status: { id: 'planned' },
              });
            }
          }, 300);
        }
        return enviar(201, { data: [e] });
      }
      if (id) {
        const e = db[tabela].find((x) => x.id === id);
        if (!e) return enviar(404, { error_code: 'platform.entity_not_found' });
        if (req.method === 'DELETE') {
          db[tabela].splice(db[tabela].indexOf(e), 1);
          return enviar(200, {});
        }
        if (req.method === 'PUT') {
          const dados = JSON.parse(corpo);
          if (dados.automation_status?.id === 'list_node.automation_status.automated') {
            return enviar(500, { description: 'contradicts the flow logic' });
          }
          Object.assign(e, dados);
        }
        return enviar(200, e);
      }
      return enviar(200, { data: filtrar(db[tabela], q) });
    });
  });
  return new Promise((ok) => servidor.listen(porta, () => ok(servidor)));
}
