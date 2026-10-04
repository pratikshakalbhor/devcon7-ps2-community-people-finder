/**
 * Front-end for the community people finder.
 *
 * One rule governs this file: **it renders only fields the server already filtered.**
 * There is no code path here that displays raw model output, because the server never
 * sends it. The `rejected` list is server-generated audit data, not model prose.
 */

const form = document.querySelector('#ask-form')
const questionInput = document.querySelector('#question')
const askButton = document.querySelector('#ask-button')
const refreshButton = document.querySelector('#refresh-button')
const results = document.querySelector('#results')
const notice = document.querySelector('#notice')
const statusLine = document.querySelector('#status-line')
const provenance = document.querySelector('#provenance')

/** Every text node is set via textContent, never innerHTML: profile bios are untrusted. */
function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function showNotice(message, tone = 'info') {
  notice.textContent = message
  notice.className = `notice ${tone}`
  notice.hidden = message === ''
}

function setBusy(busy) {
  askButton.disabled = busy
  refreshButton.disabled = busy
  results.setAttribute('aria-busy', busy ? 'true' : 'false')
}

async function readJson(response) {
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const detail = body?.error?.detail ?? `Request failed with HTTP ${response.status}.`
    const error = new Error(detail)
    error.retryable = body?.error?.retryable === true
    throw error
  }
  return body
}

const AVAILABILITY_COPY = {
  available: { label: 'Available now', tone: 'ok' },
  limited: { label: 'Limited availability', tone: 'warn' },
  unavailable: { label: 'Unavailable', tone: 'muted' },
  unknown: { label: 'Availability unknown', tone: 'muted' },
}

function renderMatch(match) {
  const card = el('article', 'card')

  const head = el('header', 'card-head')
  const name = el('a', 'card-name', match.ensName)
  name.href = `https://sepolia.ens.domains/${encodeURIComponent(match.ensName)}`
  name.target = '_blank'
  name.rel = 'noopener noreferrer'
  head.append(name)

  const availability = AVAILABILITY_COPY[match.availability] ?? AVAILABILITY_COPY.unknown
  head.append(el('span', `pill ${availability.tone}`, availability.label))
  card.append(head)

  card.append(el('p', 'card-reason', match.reason))

  if (Array.isArray(match.skills) && match.skills.length > 0) {
    const skills = el('ul', 'card-skills')
    for (const skill of match.skills) skills.append(el('li', 'skill', skill))
    card.append(skills)
  }

  const meta = el('footer', 'card-meta')
  if (Array.isArray(match.matchedSkills) && match.matchedSkills.length > 0)
    meta.append(el('span', 'meta-item', `matched: ${match.matchedSkills.join(', ')}`))
  meta.append(el('span', 'meta-item', `score ${match.score.toFixed(2)}`))

  // Surfaced, not hidden: this person matched on their merits, but their bio tripped the
  // injection heuristics, so the reader gets to judge the profile text for themselves.
  if (match.injectionSuspected)
    meta.append(el('span', 'meta-item flagged', 'bio flagged for injection-style claims'))
  card.append(meta)

  return card
}

function renderAnswer(data) {
  results.replaceChildren()
  showNotice('')

  if (data.degraded) {
    showNotice(
      'The index holds no readable profiles right now, so there is nobody to search. Seed the community and press Refresh.',
      'warn',
    )
  }

  const heading = el('p', 'results-heading')
  const count = data.matches.length
  heading.textContent =
    count === 0
      ? 'No match'
      : `${count} ${count === 1 ? 'person' : 'people'} can help`
  results.append(heading)

  if (data.noMatch) {
    // A legitimate outcome, not an error: styled as a calm panel, never a red alert.
    const empty = el('div', 'empty')
    empty.append(el('p', 'empty-message', data.message))
    empty.append(
      el(
        'p',
        'empty-detail',
        data.noMatchReason === 'nothing-above-threshold'
          ? 'Nobody in this community has a profile that matches. Try a different phrasing or a broader skill.'
          : 'People matched, but none of the suggestions survived the candidate check, so none were shown.',
      ),
    )
    results.append(empty)
    return
  }

  for (const match of data.matches) results.append(renderMatch(match))

  // The audit trail: what the model asked for that we refused. Present only when it
  // actually refused something, so a normal answer stays uncluttered.
  if (Array.isArray(data.rejected) && data.rejected.length > 0) {
    const audit = el('details', 'audit')
    audit.append(el('summary', null, `${data.rejected.length} suggestion(s) blocked`))
    const list = el('ul', 'audit-list')
    for (const entry of data.rejected) {
      const item = el('li')
      item.append(el('code', null, entry.claimedEnsName))
      item.append(el('span', 'audit-reason', entry.reason))
      list.append(item)
    }
    audit.append(list)
    const note = el(
      'p',
      'audit-note',
      'These names were not in the retrieved candidate set, so they were dropped before display.',
    )
    audit.append(note)
    results.append(audit)
  }
}

async function ask(question) {
  setBusy(true)
  results.replaceChildren(el('p', 'loading', 'Searching profiles and asking the model…'))
  try {
    const response = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question }),
    })
    renderAnswer(await readJson(response))
  } catch (error) {
    results.replaceChildren()
    showNotice(error instanceof Error ? error.message : 'Something went wrong.', 'error')
  } finally {
    setBusy(false)
  }
}

async function loadStatus() {
  try {
    const response = await fetch('/api/status')
    const { status } = await readJson(response)
    statusLine.textContent = `${status.profileCount} profiles indexed · ${status.termCount} terms · ${status.embeddingProvider ?? 'lexical only'}`
    provenance.textContent =
      status.source === 'chain'
        ? `Reading live ENS text records from Sepolia under ${status.parentName}. Last built ${new Date(status.builtAt).toLocaleTimeString()}.`
        : `Offline demo: profiles are served from the in-memory fixture set, not read from chain. Parent ${status.parentName}.`
    if (status.degraded)
      showNotice(
        'No profiles are readable from chain. Run `npm run seed`, then press Refresh.',
        'warn',
      )
  } catch (error) {
    statusLine.textContent = 'Could not read index status.'
    showNotice(error instanceof Error ? error.message : 'Could not reach the server.', 'error')
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault()
  const question = questionInput.value.trim()
  if (question !== '') void ask(question)
})

for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => {
    questionInput.value = chip.dataset.question ?? ''
    questionInput.focus()
    void ask(questionInput.value)
  })
}

refreshButton.addEventListener('click', async () => {
  refreshButton.textContent = 'Refreshing…'
  try {
    const response = await fetch('/api/refresh', { method: 'POST' })
    const { status } = await readJson(response)
    statusLine.textContent = `${status.profileCount} profiles indexed · ${status.termCount} terms · ${status.embeddingProvider ?? 'lexical only'}`
    provenance.textContent = `Last refreshed ${new Date(status.builtAt).toLocaleTimeString()}.`
    showNotice(
      `Index rebuilt with ${status.profileCount} profiles. Answers now reflect the latest chain state.`,
      'ok',
    )
  } catch (error) {
    showNotice(error instanceof Error ? error.message : 'Refresh failed.', 'error')
  } finally {
    refreshButton.textContent = 'Refresh community index'
  }
})

void loadStatus()
