/**
 * Normalisation for ENS names.
 *
 * The membership check in `lib/verify-candidates.ts` compares a model-invented name
 * against a list of real names. That comparison must be lenient about the things that
 * are genuinely equivalent (surrounding whitespace, letter case, a trailing dot) and
 * strict about everything else. This helper is deliberately the *only* place that
 * decides what "the same name" means.
 */


/**
 * Canonical form used for every membership comparison.
 *
 * Lowercased and whitespace-stripped. Nothing else is removed: a trailing dot is
 * dropped because `.eth.` and `.eth` are the same name per ENSIP-15, but a *leading*
 * label is never dropped, so `eth` still cannot match `alice.eth`.
 */
export function canonicalizeEnsName(name: string): string {
  return name.trim().toLowerCase().replace(/\.+$/, '')
}

/** True when `name` looks like a plausible ENS name at all. */
export function looksLikeEnsName(name: string): boolean {
  const canonical = canonicalizeEnsName(name)
  // One label, or a dotted path, of non-empty labels. Deliberately permissive about
  // which TLD: testnets and unusual suffixes are legitimate.
  return /^[a-z0-9-_]+(?:\.[a-z0-9-_]+)+$/.test(canonical)
}

/**
 * Raised when a caller sends something this library cannot use as a query.
 *
 * Distinct from an internal failure: the fix is to change the request, so it is
 * reported as the caller's mistake.
 */
export class BadQueryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadQueryError'
  }
}
