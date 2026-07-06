// Version computation for the no-argument `bump.mjs` path.

// Returns the next release version: bumps patch for a stable x.y.z, or the
// trailing prerelease counter for a hyphenated version (0.9.151-beta.1 ->
// 0.9.151-beta.2), so re-running the bump on a beta cuts the next beta.
export function nextVersion(current) {
  const m = current.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$/);
  if (!m) {
    throw new Error(`Unrecognized version "${current}" — expected x.y.z or x.y.z-suffix`);
  }
  const [, major, minor, patch, pre] = m;
  if (pre) {
    const preMatch = pre.match(/^(.*?)(\d+)$/);
    const nextPre = preMatch ? `${preMatch[1]}${Number(preMatch[2]) + 1}` : `${pre}.1`;
    return `${major}.${minor}.${patch}-${nextPre}`;
  }
  return `${major}.${minor}.${Number(patch) + 1}`;
}
