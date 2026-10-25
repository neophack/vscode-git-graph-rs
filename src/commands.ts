/**
 * Compatibility seam for the task 4.6 commands split: the implementation now lives in
 * `src/extension/commands/` (split by command group around a declarative registry); this
 * module keeps the historical `./commands` import path working unchanged.
 */
export * from './extension/commands';
