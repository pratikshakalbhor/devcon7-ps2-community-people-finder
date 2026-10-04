/**
 * Text normalisation for the lexical retriever.
 *
 * Deliberately small and dependency-free: a light suffix normaliser plus a
 * hand-written alias map. It is not linguistics — it just has to make
 * "mentoring" / "mentored" / "mentor" and "coaching" collapse onto each other,
 * which is the whole reason a naive `includes('rust')` matcher gets this wrong.
 */

const STOPWORDS = new Set([
  'a', 'about', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'but', 'by',
  'can', 'cant', 'could', 'did', 'do', 'does', 'for', 'from', 'get', 'got', 'had', 'has',
  'have', 'he', 'her', 'hers', 'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it',
  'its', 'just', 'me', 'more', 'most', 'my', 'no', 'not', 'of', 'on', 'or', 'our', 'ours',
  'out', 'she', 'should', 'so', 'some', 'such', 'than', 'that', 'the', 'their', 'theirs',
  'them', 'then', 'there', 'these', 'they', 'this', 'those', 'to', 'too', 'up', 'us', 'very',
  'want', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'whom', 'why',
  'will', 'with', 'would', 'you', 'your', 'yours',
])

/**
 * Terms that should collapse onto a single canonical form. Keys and values are
 * already in normalised (stemmed) form.
 *
 * `coach` -> `mentor` is the non-obvious one: a user asking for a "rust mentor"
 * should surface people who say "I coach".
 */
const ALIASES: Readonly<Record<string, readonly string[]>> = {
  mentor: ['mentorship', 'coaching', 'coach', 'tutor', 'tutoring', 'trainer', 'advisor', 'advise'],
  rust: ['rustlang', 'rs'],
  solidity: ['sol', 'evm'],
  ethereum: ['eth', 'evm'],
  javascript: ['js', 'typescript'],
  typescript: ['ts', 'javascript'],
  embedded: ['firmware', 'baremetal', 'microcontroller'],
  security: ['sec', 'infosec', 'audit', 'auditor'],
  distributed: ['p2p'],
  system: ['system', 'sys'],
  frontend: ['fe', 'web', 'ui'],
  backend: ['be', 'server'],
  compiler: ['compilers', 'compiling', 'codegen'],
  async: ['asynchronous', 'asyncio'],
  unavailable: ['unavailable'],
}

/** Characters allowed inside a token, so `rust-async` and `no_std` survive. */
const TOKEN_RE = /[^\p{L}\p{N}\-_.]+/u
/** Edge characters trimmed from a token (trailing sentence punctuation). */
const TOKEN_EDGE_RE = /^[-_.]+|[-_.]+$/g
/** Suffixes that carry no retrieval signal. Longest first. */
const SUFFIXES = [
  'ations', 'ation', 'ship', 'ingly', 'edly', 'ings', 'ing', 'ies', 'est', 'ed', 'es', 'er', 's',
] as const
/** Consonants doubled when a suffix was removed: "embedd"ed -> "embed". */
const DOUBLED = new Set(['b', 'd', 'g', 'l', 'm', 'n', 'p', 'r', 's', 't', 'z'])
/**
 * Words that merely look inflected but are the base form.
 *
 * Without this list a single-pass stemmer is not idempotent: `embed` would stem
 * to `embe`, `interest` to `interes`. Small and explicit beats clever here — a
 * base form stops the stripping, so `embed` and `embedded` collapse onto the
 * same term, which is exactly what retrieval wants.
 */
const BASE_FORMS: ReadonlySet<string> = new Set([
  // Common nouns that look inflected but are singular base forms.
  'access', 'address', 'analysis', 'apex', 'atlas', 'august', 'basis', 'bias', 'bonus', 'bus',
  'business', 'canvas', 'chest', 'chorus', 'class', 'consensus', 'digest', 'focus', 'genius',
  'genesis', 'harvest', 'honest', 'hypothesis', 'index', 'interest', 'is', 'janus', 'lens',
  'less', 'mass', 'minus', 'miss', 'modest', 'pass', 'plus', 'press', 'process', 'progress',
  'quest', 'request', 'rust', 'series', 'species', 'status', 'stress', 'success', 'this',
  'wrist', 'yes',
  // -er / -or agent nouns: the "r" belongs to the word, not to an inflection.
  'advisor', 'analyst', 'architect', 'auditor', 'author', 'browser', 'builder', 'cluster',
  'coach', 'collector', 'compiler', 'container', 'contributor', 'coordinator', 'curator',
  'designer', 'developer', 'director', 'editor', 'engineer', 'evaluator', 'exporter', 'founder',
  'importer', 'inspector', 'instructor', 'interpreter', 'investor', 'launcher', 'leader',
  'maintainer', 'mapper', 'mentor', 'moderator', 'monitor', 'operator', 'owner', 'packager',
  'parser', 'producer', 'programmer', 'promoter', 'provider', 'reader', 'recruiter', 'register',
  'renderer', 'reporter', 'researcher', 'reviewer', 'runner', 'sampler', 'scaler', 'serializer',
  'server', 'solver', 'speaker', 'student', 'subscriber', 'teacher', 'tester', 'tokenizer',
  'tracker', 'tracer', 'trainer', 'translator', 'tutor', 'user', 'vendor', 'watcher', 'wrapper',
  // -ed / -ing base verbs.
  'config', 'conduct', 'connect', 'content', 'context', 'contract', 'contrast', 'control',
  'convert', 'embed', 'expect', 'format', 'instruct', 'invest', 'protect', 'record', 'reject',
  'report', 'respect', 'select', 'submit', 'suggest', 'target', 'transmit',
])

/**
 * Split raw text into word-ish tokens. Letters, digits and the internal glue
 * characters `-`, `_`, `.` are kept so compound tech slugs survive intact;
 * leading/trailing glue is trimmed.
 */
export function splitTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(TOKEN_RE)
    .map((token) => token.replace(TOKEN_EDGE_RE, ''))
    .filter((token) => token !== '')
}

/**
 * Very light suffix stripping. Order matters — the longest suffix that leaves a
 * plausible stem wins, and words are never reduced below 3 characters so "rust"
 * does not become "ru".
 */
export function normaliseToken(token: string): string {
  const value = token.toLowerCase()
  if (value.length <= 3 || BASE_FORMS.has(value)) return value
  for (const suffix of SUFFIXES) {
    if (value.length - suffix.length < 3 || !value.endsWith(suffix)) continue
    let stem = value.slice(0, -suffix.length)
    // "ties" -> "ty", "carries" -> "carri": restore the y.
    if (suffix === 'ies') stem += 'y'
    // "embedd"ed -> "embed", "bigg"est -> "big", but leave "pass" alone.
    if (stem.length > 4) {
      const last = stem.charAt(stem.length - 1)
      const beforeLast = stem.charAt(stem.length - 2)
      if (last === beforeLast && DOUBLED.has(last)) stem = stem.slice(0, -1)
    }
    return stem
  }
  return value
}

/**
 * Both keys and values are pushed through `normaliseToken` when the index is
 * built, so `embedded`, `embed` and `embedd` all resolve to the same bucket
 * regardless of how the alias table was spelled.
 */
const ALIAS_INDEX: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, Set<string>>()
  const add = (key: string, forms: readonly string[]) => {
    const bucket = map.get(key) ?? new Set<string>()
    for (const form of forms) bucket.add(form)
    map.set(key, bucket)
  }
  for (const [key, aliases] of Object.entries(ALIASES)) {
    const canonical = normaliseToken(key)
    add(canonical, [canonical, ...aliases.map(normaliseToken)])
    for (const alias of aliases) add(normaliseToken(alias), [alias, canonical])
  }
  return new Map([...map].map(([key, forms]) => [key, [...forms]]))
})()

/**
 * Canonical token set for a term, including aliases and the term itself.
 *
 * Pass `assumeNormalised` when the term came out of `tokenize` already — the
 * stemmer is single-pass by design, so re-running it on `embed` would produce
 * `embe`.
 */
export function canonicalForms(
  term: string,
  options: { assumeNormalised?: boolean } = {},
): string[] {
  const normalised = options.assumeNormalised ? term.toLowerCase() : normaliseToken(term)
  return [...(ALIAS_INDEX.get(normalised) ?? [normalised])]
}

/**
 * Tokenise free text into index terms.
 *
 * Stopwords are dropped. Compound tech slugs are kept whole *and* split
 * (`rust-async` yields `rust-async`, `rust`, `async`) so both an exact skill
 * match and a looser word match can score.
 */
export function tokenize(text: string, options: { keepStopwords?: boolean } = {}): string[] {
  const out: string[] = []
  for (const raw of splitTokens(text)) {
    if (raw.length > 64) continue
    const compound = normaliseToken(raw)
    if (!options.keepStopwords && STOPWORDS.has(compound)) continue
    out.push(compound)
    if (!/[-_./]/.test(raw)) continue
    for (const part of raw.split(SKILL_ATOM_SPLIT)) {
      if (part === '' || part === raw) continue
      const piece = normaliseToken(part)
      if (piece === '' || piece === compound) continue
      if (!options.keepStopwords && STOPWORDS.has(piece)) continue
      out.push(piece)
    }
  }
  return out
}

const SKILL_ATOM_SPLIT = /[-_./]+/

/** Tokenise a query, widening each term with its aliases. De-duplicated. */
export function expandQueryTerms(query: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const token of tokenize(query)) {
    for (const form of canonicalForms(token, { assumeNormalised: true })) {
      if (seen.has(form)) continue
      seen.add(form)
      out.push(form)
    }
  }
  return out
}

/** Adjacent bigrams, for cheap exact-phrase bonuses ("rust mentor"). */
export function bigrams(tokens: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    const a = tokens[i]
    const b = tokens[i + 1]
    if (a === undefined || b === undefined) continue
    out.push(`${a} ${b}`)
  }
  return out
}

export { STOPWORDS }