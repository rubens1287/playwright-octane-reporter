/**
 * playwright-octane-reporter — publica execuções do Playwright no ALM Octane
 * (OpenText / Micro Focus).
 *
 * Uso como reporter, no `playwright.config.ts`:
 *
 *   reporter: [['list'], ['playwright-octane-reporter']]
 *
 * Evidência de testes de API (request + response por step):
 *
 *   import { comEvidencia } from 'playwright-octane-reporter';
 *   export const test = base.extend({
 *     request: async ({ request }, use, testInfo) => use(comEvidencia(request, testInfo)),
 *   });
 *
 * Configuração por variáveis de ambiente `OCTANE_*` — ver README.
 */
export { default } from './reporter';
export { ANEXO_API, comEvidencia } from './evidencia';
export type { OctaneConfig } from './config';
