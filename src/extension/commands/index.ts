/**
 * The Git Graph command layer (REFACTOR-PLAN task 4.6): the {@link CommandManager} registering
 * every command in registry order around the declarative {@link COMMANDS} registry, with the
 * handlers split by command group (one module per group) around a shared {@link CommandHost}.
 */
export { CommandManager } from './commandManager';
export { COMMANDS, COMMAND_IDS } from './registry';
export type { CommandId, CommandSpec, MenuLocation } from './registry';
