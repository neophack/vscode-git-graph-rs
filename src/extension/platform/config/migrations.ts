/**
 * Deprecated-key migrations for user data: contributed configuration keys
 * are added, never removed, and a deprecated key keeps being read and mapped onto its modern
 * equivalent with the precedence `modern > deprecated > default`.
 */

/** The shape of `vscode.WorkspaceConfiguration` a migration-aware read goes through. Structural (no vscode import), so tests inject a plain map - and the real object satisfies it without adaptation. */
export interface ConfigurationReader {
	get<T>(section: string, defaultValue?: T): T | undefined;
}

/**
 * Deprecated setting keys -> their modern equivalents. When a setting is deprecated, its
 * package.json entry gains a `deprecationMessage` and a row `'old.key': 'new.key'` is added
 * here; {@link readWithMigrations} then resolves every read of the modern key with the
 * precedence modern > deprecated > default.
 *
 * Surveyed at the introduction of the configuration model: none of the 99 contributed settings
 * carries a deprecation message, and every key is still contributed, so the table starts empty.
 * schema.test.ts fails as soon as a setting is marked deprecated without a row here (and when a
 * row's modern key stops being contributed).
 */
export const CONFIG_MIGRATIONS: Readonly<Record<string, string>> = {};

/**
 * Read one setting honouring the deprecated-key migrations: the modern key's value wins when it
 * is explicitly set; otherwise the deprecated key's value; otherwise the given default.
 * @param config The configuration to read from.
 * @param key The modern (dotted) setting key, relative to the configuration section.
 * @param defaultValue The value returned when neither key is set (the manifest default).
 * @param migrations The deprecated -> modern table; defaults to {@link CONFIG_MIGRATIONS} and is
 * injectable so the precedence itself can be tested against a synthetic table.
 */
export function readWithMigrations<T>(config: ConfigurationReader, key: string, defaultValue: T, migrations: Readonly<Record<string, string>> = CONFIG_MIGRATIONS): T {
	const modern = config.get<T>(key);
	if (modern !== undefined) return modern;
	const deprecatedKey = migrations[key];
	if (deprecatedKey !== undefined) {
		const deprecated = config.get<T>(deprecatedKey);
		if (deprecated !== undefined) return deprecated;
	}
	return defaultValue;
}
