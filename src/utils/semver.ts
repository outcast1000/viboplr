// Simple semver comparison: returns true if current >= required. Compares the
// numeric major.minor.patch only — a leading "v" and a pre-release/build suffix
// are dropped first, or "1.0.111-beta.1" splits into a NaN segment (same rule
// as the Rust checker). One copy for every minAppVersion check: plugin
// activation and the gallery suggestions must agree on what an app can run.
export function semverSatisfies(current: string, required: string): boolean {
  const parse = (v: string) =>
    v.trim().replace(/^v/, "").split(/[-+]/)[0].split(".").map((s) => Number(s) || 0);
  const c = parse(current);
  const r = parse(required);
  for (let i = 0; i < 3; i++) {
    const cv = c[i] ?? 0;
    const rv = r[i] ?? 0;
    if (cv > rv) return true;
    if (cv < rv) return false;
  }
  return true; // equal
}
