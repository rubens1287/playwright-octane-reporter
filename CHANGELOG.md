# Changelog

## 0.1.0

Primeira versão.

- Teste gherkin por teste do Playwright, um step por `test.step`; vínculo pela tag `@octane:<id>`.
- Test suite, run por execução, status por step, log de falha no Actual.
- Evidência no step que falhou (ou no último): screenshot (web) ou troca HTTP (API, `comEvidencia`, com segredos mascarados).
- Configuração por `OCTANE_*`, liga/desliga por `OCTANE_ENABLED`, campos de lista por `OCTANE_FIELD_<campo>`.
- Autenticação por usuário e senha.
- CLI de consulta `npx playwright-octane-reporter campos [campo] [valor] [--todos] [--valores]`: lista os campos de lista aceitos por `OCTANE_FIELD_*`, com rótulo, entidades e valores; campos com muitos valores aparecem resumidos, com busca por valor.
- Buscas paginadas: listas com mais de 1.000 valores são lidas por inteiro (sem isso, valores além da 1ª página eram recusados como inexistentes).
