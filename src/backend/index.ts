/**
 * Compatibility re-export: backend selection and fallback routing moved to
 * `src/extension/git/read/backendIndex.ts` (REFACTOR-PLAN task 3.3), which also re-exports the
 * backend contract (`gitReader.ts`), the data contract (`types.ts`) and the CLI reader
 * (`cli/index.ts` — the historical `backend/cliBackend.ts` compatibility module was deleted once
 * this became its only consumer). This module keeps the historical import path — `dataSource.ts`,
 * `gitGraphView.ts` and the tests import from `./backend` — re-exporting the public surface
 * unchanged.
 */

export * from '../extension/git/read/backendIndex';
