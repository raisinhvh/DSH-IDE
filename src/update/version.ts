const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export const isVersion = (value: string): boolean => VERSION.test(value);

/** Semver precedence: negative when `a` is older than `b`. Unparseable input sorts lowest. */
export function compareVersions(a: string, b: string): number {
  const left = VERSION.exec(a);
  const right = VERSION.exec(b);
  if (!left || !right) return left ? 1 : right ? -1 : 0;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference) return difference < 0 ? -1 : 1;
  }
  const preLeft = left[4];
  const preRight = right[4];
  if (!preLeft || !preRight) return preLeft ? -1 : preRight ? 1 : 0;
  const partsLeft = preLeft.split('.');
  const partsRight = preRight.split('.');
  for (let index = 0; index < Math.max(partsLeft.length, partsRight.length); index += 1) {
    const x = partsLeft[index];
    const y = partsRight[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const numericX = /^\d+$/.test(x);
    const numericY = /^\d+$/.test(y);
    if (numericX && numericY) { if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1; }
    else if (numericX !== numericY) return numericX ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
