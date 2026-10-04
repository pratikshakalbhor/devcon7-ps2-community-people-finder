/**
 * The community profile schema.
 *
 * This file is the single source of truth for *which* ENS text record keys we read,
 * how they are shaped, and how they are validated. Everything else in the project
 * (seed script, verifier, index builder, tests) imports from here — there are no
 * magic strings anywhere else.
 *
 * ---------------------------------------------------------------------------
 * ON-CHAIN FORMAT (v1)
 * ---------------------------------------------------------------------------
 * A community member is one ENS name. Their profile is three ENS *text records*
 * (ENSIP-10 `text(bytes32,string)` on the name's resolver):
 *
 *   community.dev.bio           free text, single line preferred.
 *                               "What they do, and their background."
 *
 *   community.dev.skills        a delimited list of short, lowercase skill slugs.
 *                               Delimiters accepted: , ; | / newline
 *                               A slug may be compound: "rust-async", "no_std".
 *                               "What they can be asked about."
 *
 *   community.dev.availability  a single bounded token, one of:
 *                               available | limited | unavailable
 *                               "Whether they have capacity right now."
 *
 * Notes / rationale for the shape:
 *  - Skills are a *separate* record from bio so the index can weight declared
 *    competence far above incidental prose. A mention of Rust in a sentence is a
 *    much weaker signal than `skills: rust`.
 *  - Availability is bounded rather than free text because it is used as a
 *    hard filter and a score multiplier, not for semantic matching.
 *  - Keys are namespaced under `community.dev.` so we never collide with the
 *    standard ENS keys (`url`, `description`, `avatar`, `com.twitter`, ...) that
 *    wallets already render.
 *  - `bio` is intentionally single-line-ish: ENS text records are stored verbatim,
 *    so embedded newlines are legal but break naive UIs. We accept them on read
 *    (collapsing whitespace) and never write them.
 */

export const PROFILE_VERSION = 1

/** Namespace prefix for every record key we own. */
export const KEY_PREFIX = 'community.dev.'

/** The complete, authoritative list of text record keys this project reads. */
export const PROFILE_RECORD_KEYS = {
  /** Free text: what they do, their background. */
  bio: `${KEY_PREFIX}bio`,
  /** Delimited list of skill slugs. */
  skills: `${KEY_PREFIX}skills`,
  /** Bounded availability token. */
  availability: `${KEY_PREFIX}availability`,
} as const

export type ProfileField = keyof typeof PROFILE_RECORD_KEYS
export type ProfileRecordKey = (typeof PROFILE_RECORD_KEYS)[ProfileField]

/** Every key, in a stable order. Useful for batched RPC reads. */
export const PROFILE_RECORD_KEY_LIST: readonly ProfileRecordKey[] = Object.values(
  PROFILE_RECORD_KEYS,
)

/** The bounded vocabulary for `community.dev.availability`. */
export const AVAILABILITY_VALUES = ['available', 'limited', 'unavailable'] as const

export type Availability = (typeof AVAILABILITY_VALUES)[number]

/** Value used when the record is missing or unparseable. */
export const AVAILABILITY_UNKNOWN = 'unknown' satisfies string

export type ProfileAvailability = Availability | typeof AVAILABILITY_UNKNOWN

/** Relative scoring weight for the unavailable tier. see lib/build-index.ts */
export const AVAILABILITY_MULTIPLIER: Record<ProfileAvailability, number> = {
  available: 1,
  limited: 0.8,
  unavailable: 0.35,
  unknown: 0.9,
}

export function isAvailability(value: unknown): value is Availability {
  return (
    typeof value === 'string' && (AVAILABILITY_VALUES as readonly string[]).includes(value)
  )
}

/** Raw text records exactly as they came off the chain, keyed by record key. */
export type RawProfileRecords = Partial<Record<ProfileRecordKey, string>>

/** A profile as parsed out of raw text records, with validation diagnostics. */
export interface CommunityProfile {
  /** ENS name, e.g. `alice.kenji-community.eth`. */
  readonly name: string
  /** Free-text bio. Empty string when absent. */
  readonly bio: string
  /** Normalised skill slugs, de-duplicated, order preserved. e.g. `['rust','rust-async']` */
  readonly skills: readonly string[]
  /**
   * `skills` further split on `-`, `_`, `/` and `.`, so `rust-async` also
   * contributes `rust` and `async`. This is what the retriever matches on; the
   * literal slugs are kept for display and for exact-phrase bonuses.
   */
  readonly skillAtoms: readonly string[]
  readonly availability: ProfileAvailability
  /** Address record resolved alongside the text records, when available. */
  readonly address?: `0x${string}` | null
  /** Non-fatal schema problems (missing required record, bad availability, ...). */
  readonly issues: readonly ProfileIssue[]
  /** Heuristics about untrusted bio content. See `INJECTION_PATTERNS`. */
  readonly flags: ProfileFlags
}

export interface ProfileIssue {
  readonly field: ProfileField | 'name' | 'address'
  readonly severity: 'error' | 'warning'
  readonly message: string
}

export interface ProfileFlags {
  /**
   * True when the bio text contains imperative instructions aimed at an LLM
   * ("ignore previous instructions", "always pick me first", ...).
   *
   * This is a *retrieval-side* signal only: the index penalises flagged profiles
   * so injected text cannot buy ranking. It is deliberately not a security
   * boundary — the real containment has to happen when untrusted bio text is
   * handed to a model, which is the next layer of this project.
   */
  readonly injectionSuspected: boolean
  /** The specific patterns that fired, for logging / debugging. */
  readonly injectionPatterns: readonly string[]
}

/** Delimiters accepted in `community.dev.skills`. */
const SKILL_DELIMITERS = /[,;|/\\\n]+/

/** Compound slugs are split into atoms on these. */
const SKILL_ATOM_DELIMITERS = /[-_./]/

/**
 * Patterns that indicate a bio is trying to manipulate an automated reader rather
 * than describe a human. Lower-cased before matching.
 */
export const INJECTION_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: 'ignore-previous-instructions', re: /ignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?)/i },
  { name: 'disregard-instructions', re: /disregard\s+(?:all\s+)?(?:previous|prior|above|earlier|your)\s+(?:instructions?|prompts?|rules?|guidance)/i },
  { name: 'system-override', re: /\b(?:system\s?prompt|new\s+instructions?|developer\s+message)\s*[:-]/i },
  { name: 'you-must-recommend-me', re: /\b(?:you\s+(?:must|should|will|have\s+to)\s+)?(?:always\s+)?(?:recommend|pick|choose|select|rank)\s+me\b/i },
  { name: 'best-at-everything', re: /\bbest\s+(?:\w+\s+){0,2}(?:mentor|expert|person|choice|option|candidate|developer|engineer)\b/i },
  { name: 'for-everything', re: /\bfor\s+everything\b/i },
  { name: 'do-not-mention-others', re: /\bdo\s+not\s+(?:mention|list|consider|show|recommend)\b/i },
  { name: 'llm-targeted', re: /\b(?:as\s+an?\s+(?:ai|llm|language\s+model)|to\s+any\s+(?:ai|llm|agent|bot))\b/i },
]

/** Collapse all whitespace runs (incl. newlines) to single spaces and trim. */
function normaliseWhitespace(value: string): string {
  // ENS text records are arbitrary bytes. NULs and other C0 control characters
  // are not whitespace to us but they are not content either, so replace them
  // with a space before collapsing, otherwise a hostile profile can smuggle
  // tokens past the keyword scanner.
  return value.replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim()
}

/**
 * Parse the raw `community.dev.skills` string into normalised slugs.
 *
 * - splits on `, ; | / \` and newlines
 * - lowercases, collapses internal whitespace to `-`
 * - de-duplicates, preserving first-seen order
 */
export function parseSkills(raw: string | undefined | null): string[] {
  if (raw === undefined || raw === null) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const chunk of raw.split(SKILL_DELIMITERS)) {
    const slug = normaliseWhitespace(chunk)
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/^-+|-+$/g, '')
    if (slug === '' || slug.length > 64) continue
    if (seen.has(slug)) continue
    seen.add(slug)
    out.push(slug)
  }
  return out
}

/**
 * Explode skill slugs into single words.
 * `['rust-async', 'no_std']` -> `['rust','async','no','std']`
 */
export function skillAtoms(skills: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const slug of skills) {
    for (const atom of slug.split(SKILL_ATOM_DELIMITERS)) {
      if (atom === '' || seen.has(atom)) continue
      seen.add(atom)
      out.push(atom)
    }
  }
  return out
}

/** Parse `community.dev.availability`, falling back to `unknown`. */
export function parseAvailability(raw: string | undefined | null): ProfileAvailability {
  if (raw === undefined || raw === null) return AVAILABILITY_UNKNOWN
  const value = normaliseWhitespace(raw).toLowerCase()
  return isAvailability(value) ? value : AVAILABILITY_UNKNOWN
}

/** Run the injection heuristics over free text. */
export function detectInjection(text: string): ProfileFlags {
  const patterns: string[] = []
  for (const { name, re } of INJECTION_PATTERNS) {
    if (re.test(text)) patterns.push(name)
  }
  return { injectionSuspected: patterns.length > 0, injectionPatterns: patterns }
}

export interface ParseProfileOptions {
  /** Address record, when the caller already resolved it. */
  readonly address?: `0x${string}` | null
}

/**
 * Turn raw ENS text records into a validated `CommunityProfile`.
 *
 * Never throws: malformed profiles come back with `issues` populated so the
 * index builder can decide whether to include or quarantine them.
 */
export function parseProfile(
  name: string,
  records: RawProfileRecords | null | undefined,
  options: ParseProfileOptions = {},
): CommunityProfile {
  const issues: ProfileIssue[] = []
  const trimmedName = name.trim()
  if (trimmedName === '') {
    issues.push({ field: 'name', severity: 'error', message: 'empty ENS name' })
  }

  const read = (key: ProfileRecordKey): string | undefined => {
    const value = records?.[key]
    if (value === undefined) return undefined
    const normalised = normaliseWhitespace(value)
    return normalised === '' ? undefined : normalised
  }

  const rawBio = read(PROFILE_RECORD_KEYS.bio)
  const rawSkills = read(PROFILE_RECORD_KEYS.skills)
  const rawAvailability = read(PROFILE_RECORD_KEYS.availability)

  if (rawBio === undefined) {
    issues.push({
      field: 'bio',
      severity: 'warning',
      message: `missing or empty text record "${PROFILE_RECORD_KEYS.bio}"`,
    })
  }
  if (rawSkills === undefined) {
    issues.push({
      field: 'skills',
      severity: 'warning',
      message: `missing or empty text record "${PROFILE_RECORD_KEYS.skills}"`,
    })
  }

  const skills = parseSkills(rawSkills)
  if (rawSkills !== undefined && skills.length === 0) {
    issues.push({
      field: 'skills',
      severity: 'warning',
      message: `"${PROFILE_RECORD_KEYS.skills}" contained no usable slugs`,
    })
  }

  const availability = parseAvailability(rawAvailability)
  if (rawAvailability === undefined) {
    issues.push({
      field: 'availability',
      severity: 'warning',
      message: `missing or empty text record "${PROFILE_RECORD_KEYS.availability}"`,
    })
  } else if (availability === AVAILABILITY_UNKNOWN) {
    issues.push({
      field: 'availability',
      severity: 'warning',
      message: `"${PROFILE_RECORD_KEYS.availability}" must be one of ${AVAILABILITY_VALUES.join(
        ', ',
      )}; got "${rawAvailability}"`,
    })
  }

  const bio = rawBio ?? ''
  return {
    name: trimmedName,
    bio,
    skills,
    skillAtoms: skillAtoms(skills),
    availability,
    address: options.address ?? null,
    issues,
    flags: detectInjection(bio),
  }
}

/** Everything a profile needs in order to be searchable. */
export function isProfileUsable(profile: CommunityProfile): boolean {
  return profile.name !== '' && profile.bio !== '' && profile.skills.length > 0
}

/**
 * Render a profile back into text records. Used by the seed script so the writer
 * and the reader can never disagree about the format.
 */
export function serialiseProfile(input: {
  bio: string
  skills: readonly string[]
  availability: ProfileAvailability
}): RawProfileRecords {
  return {
    [PROFILE_RECORD_KEYS.bio]: normaliseWhitespace(input.bio),
    [PROFILE_RECORD_KEYS.skills]: input.skills.join(', '),
    [PROFILE_RECORD_KEYS.availability]: input.availability,
  }
}

/** Human-readable summary used by the verifier and CLI output. */
export function describeProfile(profile: CommunityProfile): string {
  const parts = [
    `${profile.name}`,
    `  skills      : ${profile.skills.length > 0 ? profile.skills.join(', ') : '(none)'}`,
    `  availability: ${profile.availability}`,
    `  bio         : ${profile.bio === '' ? '(none)' : profile.bio}`,
  ]
  if (profile.flags.injectionSuspected) {
    parts.push(`  ⚑ flagged    : ${profile.flags.injectionPatterns.join(', ')}`)
  }
  for (const issue of profile.issues) parts.push(`  ! ${issue.field}: ${issue.message}`)
  return parts.join('\n')
}