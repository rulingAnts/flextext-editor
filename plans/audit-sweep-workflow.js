/* PHASE C AUDIT — THE COMPLETION PASS. Run with the Workflow tool:
 *     Workflow({ scriptPath: 'plans/audit-sweep-workflow.js' })
 *
 * ⚠ WHY THIS FILE EXISTS IN THE REPO rather than in a session scratch dir. The 2026-08-21 audit ran
 * round one and its verification to completion, then lost its SECOND attack round and its
 * completeness critic to the monthly spend limit — the third time that limit has killed this same
 * audit. Workflow resume is SAME-SESSION ONLY, so the cached round-one results cannot be reached
 * from a later session; the missing pass has to be a self-contained run. And the workspace has been
 * re-cloned from origin repeatedly, so anything not committed does not survive. Hence: in the repo.
 *
 * ⚠ IT IS DELIBERATELY THE SWEEP ONLY. Round one's six lenses found 17 confirmed findings that are
 * already written up in plans/AUDIT-FINDINGS-2026-08-21.md and already have a decided fix. Re-running
 * them would spend the budget rediscovering known things. This asks the question that was never
 * asked: what did nobody think to look for?
 */
export const meta = {
  name: 'phase-c-audit-sweep',
  description: 'The second attack round and completeness critic the 2026-08-21 audit never got',
  phases: [
    { title: 'Sweep', detail: 'three lenses aimed away from what round one covered' },
    { title: 'Verify', detail: 'three refuters per finding, refute-by-default' },
    { title: 'Critic', detail: 'what is still unexamined' },
  ],
}

const FINDING = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'informational'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          claim: { type: 'string' },
          attack: { type: 'string', description: 'Concrete request/state sequence. Specific enough to test.' },
          evidence: { type: 'string', description: 'Quoted code with file:line' },
        },
        required: ['title', 'severity', 'file', 'claim', 'attack', 'evidence'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean' },
    reasoning: { type: 'string' },
    correction: { type: 'string' },
  },
  required: ['refuted', 'reasoning'],
}

const CTX = [
  'Repo /home/user/flextext-editor. Worker backend: worker/src/v1.js. Branch:',
  'claude/cut-tab-waveform-displays-2owdfx. NOTHING HERE IS DEPLOYED.',
  '',
  'READ plans/AUDIT-FINDINGS-2026-08-21.md FIRST. It holds 17 already-confirmed findings with a',
  'decided fix. DO NOT RE-REPORT THEM. Your job is what nobody looked for.',
  '',
  'The system: Phase C adds multi-researcher project sharing. authMember(req, env, target, needCap)',
  'is the single authorization helper — returns null (401), { ok:false } (deny, routes answer',
  'not_found), or { ok:true, caller, owner, project_id, caps, isOwner, legacy? }. validateCaps',
  'validates the caps JSON on write. ~19 routes were converted from authResearcher to authMember.',
  '',
  'REMEDIATION HAS ALREADY LANDED since those 17 findings — read the CURRENT code, not the findings',
  'doc, for what is true now. Do not re-report anything below as a new finding:',
  ' . validateCaps now REFUSES `assignTexts` and `drive` outright (DEFERRED_CAPS). Members get only',
  '   manageDevices, createInvites and cancelOthers. That is what closed the nine same-root findings',
  '   — the dangerous routes are unreachable because the capability cannot be granted, NOT because',
  '   the routes were individually fixed. The account-wide docId tag searches are STILL THERE.',
  ' . Text-scoped COMMAND types (assign, delete, uploadDelete, setDone) additionally require',
  '   assignTexts, so manageDevices cannot reach the text lane.',
  ' . Member removal now deletes grants resolved through `instance`, not through the denormalised',
  '   member_key.project_id (which is the legacy sentinel on old rows).',
  ' . authMember gained `allowRevoked`, opt-in, used only by DELETE /v1/researcher/keys, and',
  '   check-project-scoping.sh enforces that every use is owner-only.',
  ' . POST /v1/researcher/keys goes through authMember and answers not_found, never 403.',
  ' . POST /v1/instances stamps project_id from a Drive folder it has just verified.',
  ' . mintTextfileUrl REFUSES to mint when a minter is recorded and no instance scope is given.',
  '',
  'SO THE MOST VALUABLE QUESTIONS NOW ARE: does the capability deferral actually hold everywhere, or',
  'is there a route reachable WITHOUT assignTexts/drive that still takes a caller-supplied Drive id?',
  'Does anything else grant capabilities besides validateCaps? Can a stale project_member row from',
  'before the deferral still carry them? And is the remediation itself sound — the new SQL, the',
  'allowRevoked opt-in, the command gate?',
  '',
  'DESIGN RULES THAT DEFINE A DEFECT:',
  ' . I1 one authority — authMember is the only place authorization is decided.',
  ' . I4 FAIL CLOSED — every unresolvable step denies; never fall back to researcher_id scoping.',
  ' . Denial is indistinguishable from absence (not_found, never 403) so ids cannot be enumerated.',
  ' . Access is PROJECT-scoped. A member reaches everything in their project, nothing outside it,',
  '   and never the account master Drive folder or another project.',
  ' . The owner is never a project_member row; ownership is project.owner_id.',
  ' . member_key wrap-to-owner — the owner always retains a readable copy.',
  ' . Identity is not advertised: no email or display name in cross-researcher lookups.',
  ' . wipe and force-remove are owner-only; no capability delegates them.',
  '',
  'Report ONLY defects you can evidence in code. Quote the lines. A finding that cannot be turned',
  'into a concrete request sequence is not a finding. Prefer FEWER, REAL findings; an empty array is',
  'a valid and useful result. No style, naming or test-coverage findings.',
].join('\n')

phase('Sweep')

const LENSES = [
  { key: 'invariants', prompt: 'LENS: THE INVARIANTS THEMSELVES. Take each of I1, I4, denial-indistinguishability, project-scoping, wrap-to-owner, owner-is-not-a-member, identity-not-advertised, and owner-only-wipe. For EACH, either find one concrete way the current code violates it, or state with quoted evidence that it holds. Be most adversarial about the ones that look obviously fine — those are where nobody has looked.' },
  { key: 'sequencing', prompt: 'LENS: ORDER, STATE AND CONCURRENCY. Hunt TOCTOU and ordering defects: authorization resolved from state a concurrent request could change between check and use; D1 batches that are not atomic where they must be; a value checked before it is normalised or used after it is; a member removed mid-request whose in-flight call still completes; two requests racing on the same row. Include the boundary where an instance transitions out of the dual-read window (project_id NULL to set) while a request is in flight.' },
  { key: 'unexamined', prompt: 'LENS: THE PARTS NOBODY AIMED AT. Round one aimed at the converted instance routes, the new endpoints, the textfile token and cross-project Drive leakage. Aim elsewhere: crowd_recorder targets passed to authMember; project targets vs instance targets; routes taking one id from the URL and a different id from the BODY; the migration gate edge cases; the interaction between two new pieces rather than either alone; anything a member can trigger that runs LATER (queued commands, waitUntil work, background sweeps); and the 22 routes still on authResearcher — confirm they are genuinely account-scoped and inert for members rather than assuming it.' },
]

const round = await parallel(LENSES.map((l) => () =>
  agent(CTX + '\n\n' + l.prompt, { label: 'sweep:' + l.key, phase: 'Sweep', schema: FINDING, effort: 'high' })))

const seen = new Set()
const pool = round.filter(Boolean).flatMap((r) => r.findings || []).filter((f) => {
  const k = (f.file || '') + ':' + (f.line || 0) + ':' + (f.title || '').slice(0, 40)
  if (seen.has(k)) return false; seen.add(k); return true
})
log('sweep: ' + pool.length + ' candidate findings')

phase('Verify')

const judged = (await parallel(pool.map((f) => () =>
  parallel(['correctness', 'reachability', 'does-it-actually-reproduce'].map((lens) => () =>
    agent(CTX + '\n\nTRY TO REFUTE THIS FINDING. Default to refuted=true when uncertain — a'
      + ' plausible-but-wrong finding that survives is worse than a missed one, because it gets'
      + ' "fixed" and the fix causes a real bug. Judge through the ' + lens + ' lens.\n\n'
      + 'TITLE: ' + f.title + '\nCLAIM: ' + f.claim + '\nFILE: ' + f.file + ':' + (f.line || '?')
      + '\nATTACK: ' + f.attack + '\nEVIDENCE: ' + f.evidence + '\n\n'
      + 'Read the ACTUAL code there and around it. Refute if the code does not say what is claimed, a'
      + ' guard elsewhere prevents it, the sequence cannot be performed, the path is unreachable, or'
      + ' the behaviour is deliberate and correct. Confirm ONLY if you can trace it yourself.',
      { label: 'verify:' + lens + ':' + (f.title || '').slice(0, 20), phase: 'Verify', schema: VERDICT, effort: 'high' })))
    .then((vs) => {
      const good = vs.filter(Boolean)
      return { finding: f, votes: good, survives: good.length > 0 && good.filter((v) => !v.refuted).length >= 2 }
    })))).filter(Boolean)

const confirmed = judged.filter((j) => j.survives).map((j) => j.finding)
log('verified: ' + confirmed.length + ' survived of ' + pool.length)

phase('Critic')

const critic = await agent(CTX + '\n\nTwo audit rounds have now run on this code. Round one produced the 17'
  + ' findings in plans/AUDIT-FINDINGS-2026-08-21.md. This sweep confirmed:\n\n'
  + JSON.stringify(confirmed, null, 2) + '\n\nand refuted:\n'
  + JSON.stringify(judged.filter((j) => !j.survives).map((j) => ({ title: j.finding.title, why: (j.votes[0] || {}).reasoning })), null, 2)
  + '\n\nAs a completeness critic, answer:\n'
  + '1. What is STILL unexamined? Name specific routes, helpers or invariants no lens has covered across BOTH rounds.\n'
  + '2. Which confirmed findings look wrong to you, and which refutations look wrong?\n'
  + '3. Does the audit now satisfy "the fan-out audit owes a clean run before Phase C ships"? Answer\n'
  + '   yes or no plainly. If no, say exactly what remains — and if yes, say what that claim does NOT cover.\n'
  + 'Markdown, concise, no preamble.', { label: 'completeness', phase: 'Critic', effort: 'high' })

return { confirmed, refuted: judged.length - confirmed.length, candidates: pool.length, critic }
