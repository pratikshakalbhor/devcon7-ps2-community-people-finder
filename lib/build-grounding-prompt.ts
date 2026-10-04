/**
 * Builds the grounded-answer prompt.
 *
 * Security model, in one line: **profile data never reaches the system message.**
 *
 * The conversation has three messages, in this order:
 *
 *   1. `system` — authored constants only (see `lib/instruction-fragments.ts`). It does
 *      not vary with the query, the community, or the candidates. There is no template
 *      hole for a bio to reach through.
 *   2. `user` — the candidate profiles, fenced and labelled as untrusted data.
 *   3. `user` — the actual question.
 *
 * Roles matter more than delimiters. Placing profile text in a `user` message means it
 * arrives with a weaker authority than the system message regardless of what the text
 * says, and a bio that literally contains "ignore the above" is quoting itself in a
 * message that carries no instruction authority.
 *
 * The candidate block is emitted as JSON rather than prose. That removes the ambient
 * authority of natural language: a bio is a *string value* in a known field, next to
 * commas and braces, not a paragraph the model may read as a directive.
 */

import {
  AUTHORED_INSTRUCTION_LINES,
  BASE_INSTRUCTIONS,
  CANDIDATE_DATA_FOOTER,
  CANDIDATE_DATA_HEADER,
} from './instruction-fragments.js'
import type { ChatMessage } from './llm-client.js'
import { BadQueryError } from './normalize-ens-name.js'
import type { Candidate } from './retrieve.js'

/**
 * Builds the system message.
 *
 * Takes no arguments on purpose. There is no parameter through which a caller could
 * accidentally pass community data, and no interpolation to sanitise.
 */
export function buildSystemPrompt(): string {
  return BASE_INSTRUCTIONS.join('\n')
}

/**
 * Serialises candidates as the untrusted data block.
 *
 * Only the four fields the model needs to answer are emitted. Notably `address` is
 * omitted: it is not needed to answer "who can help with X", and a prompt is the last
 * place you want to be handing out addresses.
 */
export function buildCandidateBlock(candidates: readonly Candidate[]): string {
  const payload = candidates.map((candidate, index) => ({
    candidateId: index + 1,
    ensName: candidate.name,
    skills: candidate.profile.skills,
    availability: candidate.availability,
    bio: candidate.profile.bio,
  }))

  return [
    ...CANDIDATE_DATA_HEADER,
    JSON.stringify(payload, null, 2),
    CANDIDATE_DATA_FOOTER,
  ].join('\n')
}

/**
 * Builds the full message list for a question and its candidates.
 *
 * @throws {BadQueryError} if the query is empty. Thrown before anything is built so a
 * blank question can never produce a prompt.
 */
export function buildGroundingMessages(
  query: string,
  candidates: readonly Candidate[],
): ChatMessage[] {
  if (typeof query !== 'string' || query.trim() === '')
    throw new BadQueryError('The query is empty. Provide a non-empty string to answer.')

  return [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: buildCandidateBlock(candidates) },
    { role: 'user', content: query.trim() },
  ]
}

export { AUTHORED_INSTRUCTION_LINES, BASE_INSTRUCTIONS }
