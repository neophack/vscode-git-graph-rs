/**
 * The ONE configuration module (REFACTOR-PLAN 3.3 + OPTIMIZATION-PLAN A4), split by role:
 *
 * - `schema.ts` — the checked-in `ConfigSnapshot` interface and the typed
 *   `field -> { key, type, default }` table mirroring `package.json#contributes.configuration`
 *   (the one place a default exists in code; `schema.test.ts` asserts manifest parity both
 *   ways).
 * - `snapshot.ts` — `takeSnapshot` / `onConfigChange` / the structural workspace types, plus
 *   the `git.path` read (`gitPathsOf`).
 * - `migrations.ts` — the deprecated-key table and the migration-aware read.
 * - `cooked.ts` — the derived (webview-model) views over a snapshot, pure functions.
 * - `service.ts` — the `ConfigService` long-lived consumers hold (`.current`, subscription
 *   managed internally).
 */

export { CONFIG_SECTION } from './snapshot';
export type {
	BranchGlobPatternSetting, CommitAuthorSetting, ConfigSnapshot, ContextMenuActionsVisibilitySetting,
	ContextMenuVisibilityGroup, DefaultColumnVisibilitySetting, EmojiShortcodeMappingSetting, KeyboardShortcutSetting,
	OpenNewTabEditorGroupSetting, SettingType, SnapshotField, SchemaRow
} from './schema';
export { CONFIG_SCHEMA } from './schema';
export type {
	ConfigurationChangeEventLike, DisposableLike, ObservableWorkspaceLike, WorkspaceConfigurationLike, WorkspaceLike
} from './snapshot';
export { gitPathsOf, onConfigChange, takeSnapshot } from './snapshot';
export { CONFIG_MIGRATIONS, readWithMigrations } from './migrations';
export type { ConfigurationReader } from './migrations';
export {
	commitAuthorsOf, commitDetailsViewOf, commitOrderingOf, contextMenuActionsVisibilityOf, cookConfig,
	customBranchGlobPatternsOf, customEmojiShortcodeMappingsOf, customPullRequestProvidersOf, dateFormatOf,
	defaultColumnVisibilityOf, dialogDefaultsOf, gerritOf, graphOf, interfaceLanguageSettingOf, keybindingsOf,
	muteCommitsOf, onRepoLoadOf, referenceLabelsOf, repoDropdownOrderOf, resolvedInterfaceLanguage,
	squashMessageFormatOf, tabIconColourThemeOf, viewColumnOfEditorGroup, dateTypeOf
} from './cooked';
export type { CookedConfig } from './cooked';
export { ConfigService } from './service';
export type { ConfigProvider } from './service';
