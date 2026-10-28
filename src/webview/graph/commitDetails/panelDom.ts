/**
 * The panel's scoped DOM lookups: the one place the Commit Details View's panes resolve elements
 * by id (the shell's scoped lookup — every pane module used to carry its own copy of this).
 */

/** The element with the given id under the panel's scope, or NULL (the shell's scoped lookup). */
export function byId(scope: ParentNode, id: string): HTMLElement | null {
	return scope.querySelector<HTMLElement>('#' + id);
}
