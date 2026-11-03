/** Returns only the editor context that changed within the current session. */
export function editorContextDiff(previous: string | undefined, current: string): string {
  if (!current || previous === current) return '';
  if (!previous) return current;
  const withoutCursor = (text: string): string => text.replace(/^Cursor:.*(?:\n|$)/m, '');
  if (withoutCursor(previous) === withoutCursor(current)) {
    return current.match(/^Cursor:.*$/m)?.[0] || current;
  }
  return current;
}
