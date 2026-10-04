import { describe, expect, it } from 'vitest'
import {
  canonicalForms,
  expandQueryTerms,
  normaliseToken,
  splitTokens,
  tokenize,
} from '../lib/tokenize.js'

describe('tokenizer', () => {
  it('splits on punctuation and lowercases', () => {
    expect(splitTokens('Rust, async & no_std!')).toEqual(['rust', 'async', 'no_std'])
  })

  it('keeps a compound term whole and also indexes its parts', () => {
    const tokens = tokenize('rust-async')
    expect(tokens).toContain('rust-async')
    expect(tokens).toContain('rust')
    expect(tokens).toContain('async')
  })

  it('does not stem short words away', () => {
    // "rust" must survive: over-stemming to "ru" would break every rust query.
    expect(normaliseToken('rust')).toBe('rust')
    expect(normaliseToken('run')).toBe('run')
    expect(normaliseToken('gas')).toBe('gas')
  })

  it('strips common inflections', () => {
    expect(normaliseToken('mentoring')).toBe('mentor')
    expect(normaliseToken('mentored')).toBe('mentor')
    expect(normaliseToken('mentorship')).toBe('mentor')
    expect(normaliseToken('auditing')).toBe('audit')
    expect(normaliseToken('audited')).toBe('audit')
    expect(normaliseToken('compilers')).toBe('compiler')
    expect(normaliseToken('carries')).toBe('carry')
  })

  it('drops stopwords but keeps domain words', () => {
    expect(tokenize('I am looking for the best')).not.toContain('the')
    expect(tokenize('I am looking for the best')).not.toContain('am')
    // "want" is a stopword; "wasm" must not be.
    expect(tokenize('wasm and want')).toContain('wasm')
    expect(tokenize('wasm and want')).not.toContain('and')
  })

  it('widens query terms with aliases', () => {
    const mentorForms = expandQueryTerms('mentor')
    expect(mentorForms).toContain('mentor')
    expect(mentorForms).toContain('coach')
    expect(mentorForms).toContain('tutor')

    expect(expandQueryTerms('solidity')).toContain('evm')
    expect(expandQueryTerms('embedded')).toContain('firmware')
  })

  it('de-duplicates widened terms', () => {
    const terms = expandQueryTerms('rust rust rust')
    expect(terms.filter((t) => t === 'rust')).toHaveLength(1)
  })

  it('is idempotent, so a stem is never stemmed twice', () => {
    // The stemmer is single-pass by design: re-normalising an already stemmed
    // token must be a no-op, otherwise `embedded` -> `embed` -> `embe`.
    const vocabulary = [
      'embedded', 'embedded-systems', 'rust', 'mentoring', 'mentored', 'mentorship',
      'auditing', 'audited', 'auditor', 'compilers', 'compiling', 'compiler', 'compiler-errors',
      'distributed-systems', 'p2p', 'solidity', 'typescript', 'javascript', 'no_std', 'wasm',
      'passing', 'passed', 'biggest', 'coaching', 'tutoring', 'carries', 'carried',
    ]
    for (const word of vocabulary) {
      const once = normaliseToken(word)
      expect(normaliseToken(once), `${word} -> ${once}`).toBe(once)
      expect(once.length).toBeGreaterThanOrEqual(3)
    }
  })

  it('keeps canonicalForms total', () => {
    expect(canonicalForms('rust')).toContain('rust')
    expect(canonicalForms('zzz-unknown-term')).toEqual(['zzz-unknown-term'])
  })
})