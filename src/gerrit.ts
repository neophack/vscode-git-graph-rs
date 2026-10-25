/**
 * Compatibility re-export: the Gerrit integration moved to `src/extension/integrations/gerrit/`
 * (REFACTOR-PLAN task 6.2), split along its natural seam — `gerritProtocol.ts` (the pure
 * change-ref / NoteDb parsing, filtering and sampling model) and `gerrit.ts` (the
 * `GerritDataSource` and fetch scheduling). This module keeps the historical import path —
 * `dataSource.ts`, `gitGraphView.ts`, `extension/commands/gerrit.ts` and the tests import from
 * `./gerrit` — re-exporting the public surface of both unchanged.
 */

export * from './extension/integrations/gerrit/gerrit';
export * from './extension/integrations/gerrit/gerritProtocol';
