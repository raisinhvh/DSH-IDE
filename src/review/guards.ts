/** Pure preflight rules shared by mirror admission and workspace edit application. */
export function assertLocalFileScheme(scheme: string): void {
  if (scheme !== 'file') throw new Error('DSH review supports saved files in a local workspace; untitled and remote documents are not review targets.');
}

/** Match the text VS Code/UTF-8 decoding exposes, including CRLF and BOM normalization. */
export function contentEqualIgnoringLineEndings(left: string, right: string): boolean {
  if (left === right) return true;
  return left.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n') === right.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

const uniformEol = (text: string): string | undefined => {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  if (crlf > 0 && lf === 0) return '\r\n';
  if (lf > 0 && crlf === 0) return '\n';
  return undefined;
};

/** Keep the reviewed file's line-ending style so an LF rewrite of a CRLF file is not a whole-file diff. */
export function alignLineEndings(base: string, proposed: string): string {
  const baseEol = uniformEol(base);
  const proposedEol = uniformEol(proposed);
  if (!baseEol || !proposedEol || baseEol === proposedEol) return proposed;
  return proposed.replace(/\r?\n/g, baseEol);
}

export function assertApplyPrecondition(
  path: string,
  base: string | undefined,
  live: string | undefined,
  dirty: boolean,
  deleting: boolean,
): void {
  // Ordinary edits replace the current file, including manual changes. Deletions
  // and rename sources still need to match the file that was reviewed. A missing
  // file is treated as already deleted so concurrent apply/ack races do not fail.
  if (deleting && live !== undefined && (base === undefined || !contentEqualIgnoringLineEndings(base, live))) {
    throw new Error(`Review conflict in ${path}: file changed before deletion or rename.`);
  }
  if (deleting && live !== undefined && dirty) throw new Error(`Save or close the dirty buffer for ${path} before deleting it.`);
}
