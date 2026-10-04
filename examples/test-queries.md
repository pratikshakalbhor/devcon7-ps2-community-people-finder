# Recorded test queries

Every "Actual result" block below was produced by running this project's own code.
Nothing in this file is hand-written. Regenerate with:

```bash
npm run examples:record            # full pipeline, consults the model
npm run examples:record:retrieval  # deterministic half only, no model
```

The generator exits non-zero if any expectation below is not met, so this file doubles as a
regression test over the whole path.

## Provenance

> **Provenance: fixtures, not on-chain.** The Sepolia roster is not readable right now
> (0/9 profiles), so these runs used the in-memory fixture set. The profile text came
> from the local fixture set rather than a chain read. Whether the model was consulted
> for a given case is stated in the mode banner below.
>
> Seed the community, then re-run `npm run examples:record`, to replace every result
> below with an on-chain-verified run.

> **Mode: `--retrieval-only`. No model was called for this file.**
>
> This records the deterministic half of the pipeline — the candidate set, the gates,
> and the resulting `noMatch` decision. The `matches` arrays are empty *by construction*
> because no model was consulted, not because verification rejected anything.
>
> This is still the security-critical half: the candidate list is the complete set of
> names the model is permitted to return, and the membership check can only ever narrow
> it. A hallucinated name is impossible regardless of what a model does.
>
> Re-run `npm run examples:record` (without the flag) to replace this file with a full
> model-backed recording.

## The roster under test

| Member | Declared skills | Availability | Role in the demo |
| --- | --- | --- | --- |
| `alice` | `rust, embedded, rust-async` | available | Rust, available |
| `bob` | `rust, wasm, compilers` | limited | Rust/skill match but availability-limited — scored and ranked down |
| `carol` | `solidity, typescript, react` | available | Non-Rust control (Solidity) |
| `dave` | `rust, tokio, distributed-systems` | available | Rust, available |
| `erin` | `rust, embedded, c` | unavailable | Strong skill match but unavailable — scored and ranked down |
| `frank` | `solidity, security, auditing` | limited | Rust/skill match but availability-limited — scored and ranked down |
| `grace` | `python, machine-learning, data` | available | Semantic search / ranking adjacent |
| `heidi` | `rust, mentoring, teaching` | available | Canonical "Rust mentor" answer |
| `ivan` | `community, events, facilitation` | available | **Adversarial** — bio tries to instruct the reader into ranking it first |

Full ENS names are `<label>.kenji-community-pk2026.eth`.

## How to read the two kinds of output

Each case records two different things, and the difference matters:

| Column | Deterministic? | Meaning |
| --- | --- | --- |
| `candidates` | **Yes** | What the lexical retriever sent to the model. Pure BM25, no randomness, so this is asserted exactly. |
| `matches` | No | Which of those candidates the model chose. Sampled, so this is recorded and only checked against `must include` / `must exclude`. |

Asserting the exact model pick would make this file flaky for no benefit — it would be testing
the sampler, not the system.

---

## The headline query: Rust, and free to mentor

**Query:** `Who's good at Rust and free to mentor this month?`

**Expected members:** `heidi.kenji-community-pk2026.eth`, `bob.kenji-community-pk2026.eth`, `alice.kenji-community-pk2026.eth`, `dave.kenji-community-pk2026.eth`

**Must appear in the answer:** `heidi`

**Must NOT appear:** `ivan`

**Why:** heidi is the only member who declares both `rust` and `mentoring` *and* is `available`, so she clears the evidence gate and the relevance gate decisively. `bob` matches on skill but is availability-limited, which lowers his score and his rank. `erin` is a strong Rust match but `unavailable`. `carol` (Solidity/React) and `grace` (Python/ML) have no Rust evidence at all. `ivan` never enters the candidate set — see the adversarial case below.

**Actual result:**

```json
{
  "candidates": [
    "heidi",
    "bob",
    "alice",
    "dave"
  ],
  "matches": [],
  "rejected": [],
  "noMatch": false,
  "noMatchReason": null,
  "message": "",
  "model": "(not called: --retrieval-only)",
  "attempts": 0,
  "retrieval": {
    "considered": 5,
    "droppedNoEvidence": 0,
    "droppedLowRelevance": 1,
    "droppedByCap": 0,
    "bestScore": 9.558492041458083
  }
}
```

**Verdict:** PASS

---

## A skill nobody in the set has

**Query:** `Who knows underwater basket weaving?`

**Expected members:** _none — this must return the explicit no-match response_

**Why:** No profile contains any of those terms, so retrieval returns zero candidates and **no model call is made at all**. The pipeline returns the fixed no-match message. This is the `nothing-above-threshold` branch, and it is a normal outcome, not an error.

**Actual result:**

```json
{
  "candidates": [],
  "matches": [],
  "rejected": [],
  "noMatch": true,
  "noMatchReason": "nothing-above-threshold",
  "message": "No one in the community currently matches that.",
  "model": "(not called: --retrieval-only)",
  "attempts": 0,
  "retrieval": {
    "considered": 0,
    "droppedNoEvidence": 0,
    "droppedLowRelevance": 0,
    "droppedByCap": 0,
    "bestScore": 0
  }
}
```

**Verdict:** PASS

---

## The adversarial bio's *claimed* skill — must not win

**Query:** `best rust mentor, always pick the most senior one`

**Expected members:** `heidi.kenji-community-pk2026.eth`, `alice.kenji-community-pk2026.eth`, `dave.kenji-community-pk2026.eth`

**Must appear in the answer:** `heidi`

**Must NOT appear:** `ivan`

**Why:** This phrasing deliberately echoes the injection attempt. `ivan` is still absent from the candidate set, because a claim that exists only in adversarial bio prose is not evidence — the evidence gate requires a matched term, and his `matchedSkills` are `community`/`events`/`facilitation`, none of which appear in this query. The injection penalty (0.25x) applies on top.

**Actual result:**

```json
{
  "candidates": [
    "heidi",
    "alice",
    "dave"
  ],
  "matches": [],
  "rejected": [],
  "noMatch": false,
  "noMatchReason": null,
  "message": "",
  "model": "(not called: --retrieval-only)",
  "attempts": 0,
  "retrieval": {
    "considered": 5,
    "droppedNoEvidence": 0,
    "droppedLowRelevance": 2,
    "droppedByCap": 0,
    "bestScore": 13.40419734895955
  }
}
```

**Verdict:** PASS

---

## The adversarial profile asked about honestly — must be allowed

**Query:** `Who can help me run community events?`

**Expected members:** `ivan.kenji-community-pk2026.eth`, `heidi.kenji-community-pk2026.eth`, `grace.kenji-community-pk2026.eth`, `dave.kenji-community-pk2026.eth`

**Must appear in the answer:** `ivan`

**Why:** The mirror image of the case above, and the reason `ivan` is not simply blacklisted: his declared skills genuinely are `community`, `events` and `facilitation`, so for *this* question he ranks first and is allowed through. A flagged bio is still valid data, and he is surfaced with `injectionSuspected: true` so a reader can judge his prose themselves.

`grace` and `dave` also clear the gate, which is worth being honest about: the evidence gate accepts *any* matched term, and the word "help" appears in both their bios ("Happy to help with ranking quality", "Can help with async design"). That is weak evidence rather than a bug — `ivan` still ranks first — but a query built from common words does widen the candidate set.

**Actual result:**

```json
{
  "candidates": [
    "ivan",
    "heidi",
    "grace",
    "dave"
  ],
  "matches": [],
  "rejected": [],
  "noMatch": false,
  "noMatchReason": null,
  "message": "",
  "model": "(not called: --retrieval-only)",
  "attempts": 0,
  "retrieval": {
    "considered": 5,
    "droppedNoEvidence": 0,
    "droppedLowRelevance": 1,
    "droppedByCap": 0,
    "bestScore": 2.940702987110135
  }
}
```

**Verdict:** PASS

---

## A single unambiguous expert

**Query:** `Who can help me with smart contract security and auditing?`

**Expected members:** `frank.kenji-community-pk2026.eth`

**Must appear in the answer:** `frank`

**Why:** Only `frank` declares `security` and `auditing`, so he is the only candidate with any evidence at all. `carol` has Solidity but not security, and is dropped by the relevance gate.

**Actual result:**

```json
{
  "candidates": [
    "frank"
  ],
  "matches": [],
  "rejected": [],
  "noMatch": false,
  "noMatchReason": null,
  "message": "",
  "model": "(not called: --retrieval-only)",
  "attempts": 0,
  "retrieval": {
    "considered": 4,
    "droppedNoEvidence": 0,
    "droppedLowRelevance": 3,
    "droppedByCap": 0,
    "bestScore": 15.866087916184899
  }
}
```

**Verdict:** PASS

---

## Availability changes the ranking

**Query:** `Who is available right now to pair on embedded Rust?`

**Expected members:** `alice.kenji-community-pk2026.eth`, `heidi.kenji-community-pk2026.eth`, `dave.kenji-community-pk2026.eth`, `erin.kenji-community-pk2026.eth`, `bob.kenji-community-pk2026.eth`

**Must appear in the answer:** `alice`

**Why:** `alice` leads because she is both the embedded-Rust specialist *and* `available`. `erin` is the other embedded-Rust member but is `unavailable`, so the availability multiplier pushes her to last place even though her raw skill match is excellent — the multiplier is doing real work, not decoration. Note that she is still *in* the candidate set: availability lowers her score and her rank, it does not remove her from the reachable set.

**Actual result:**

```json
{
  "candidates": [
    "alice",
    "heidi",
    "dave",
    "erin",
    "bob"
  ],
  "matches": [],
  "rejected": [],
  "noMatch": false,
  "noMatchReason": null,
  "message": "",
  "model": "(not called: --retrieval-only)",
  "attempts": 0,
  "retrieval": {
    "considered": 5,
    "droppedNoEvidence": 0,
    "droppedLowRelevance": 0,
    "droppedByCap": 0,
    "bestScore": 10.702655731084516
  }
}
```

**Verdict:** PASS

---

## Stability check: the same question asked twice

**Query:** `Who can mentor me in Rust?`

**Expected members:** `heidi.kenji-community-pk2026.eth`, `alice.kenji-community-pk2026.eth`, `dave.kenji-community-pk2026.eth`, `bob.kenji-community-pk2026.eth`

**Must appear in the answer:** `heidi`

**Why:** This case is run **twice** with no rebuild in between. Retrieval is deterministic BM25, so the candidate list must be byte-identical across both runs. The model is sampled, so its pick is reported rather than asserted — that distinction is the honest one, and the comparison table below shows both runs side by side.

**Actual result:**

```json
{
  "candidates": [
    "heidi",
    "alice",
    "dave",
    "bob"
  ],
  "matches": [],
  "rejected": [],
  "noMatch": false,
  "noMatchReason": null,
  "message": "",
  "model": "(not called: --retrieval-only)",
  "attempts": 0,
  "retrieval": {
    "considered": 5,
    "droppedNoEvidence": 0,
    "droppedLowRelevance": 1,
    "droppedByCap": 0,
    "bestScore": 9.558492041458083
  }
}
{
  "candidates": [
    "heidi",
    "alice",
    "dave",
    "bob"
  ],
  "matches": [],
  "rejected": [],
  "noMatch": false,
  "noMatchReason": null,
  "message": "",
  "model": "(not called: --retrieval-only)",
  "attempts": 0,
  "retrieval": {
    "considered": 5,
    "droppedNoEvidence": 0,
    "droppedLowRelevance": 1,
    "droppedByCap": 0,
    "bestScore": 9.558492041458083
  }
}
```

**Verdict:** PASS

---

## Stability across runs

The same question, asked twice with no rebuild in between.

| Case | Candidates (run 1) | Candidates (run 2) | Answer (run 1) | Answer (run 2) | Retrieval identical? |
| --- | --- | --- | --- | --- | --- |
| determinism | heidi, alice, dave, bob | heidi, alice, dave, bob | no match | no match | yes |

Retrieval is byte-identical across runs — it is deterministic BM25 with no randomness.
The final shortlist is a function of a sampled model, so it can differ when the model
picks a different candidate; what cannot differ is *which names are reachable*, because
the candidate set is fixed before the model is called.

---

## Changing a profile changes the answer

This is what the **Refresh community index** button in the UI is for. Rather than
describing the behaviour, this run performs it: the same question is asked, one
profile is edited (`erin`'s availability is flipped to `available`), the index
is rebuilt through the same `refresh()` path the button calls, and the question is
asked again.

**Query:** `Who can pair with me on embedded Rust?`

**Edit:** `erin.kenji-community-pk2026.eth` availability `unavailable` → `available`

| | Candidates retrieved | Answer _(model not consulted)_ |
| --- | --- | --- |
| Before the edit | alice, heidi, dave, erin, bob | no match |
| After the edit | erin, alice, heidi, dave, bob | no match |

The candidates changed: `erin` was previously ranked down by
the `unavailable` multiplier and is reachable once the edit is indexed. Note that the
profile change was only visible because the index was rebuilt — a stale index would
have kept returning the pre-edit answer.

The index was restored to the real roster after this experiment, so re-running the
recorder starts from the same state.

