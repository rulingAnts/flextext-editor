/* PHASE C AUDIT — THE UNCOVERED SURFACE. Run with the Workflow tool:
 *     Workflow({ scriptPath: 'plans/audit-sweep-uncovered-workflow.js' })
 *
 * ⚠ WHY A THIRD SWEEP EXISTS. `audit-sweep-workflow.js` ran twice (2026-08-23): round A found one
 * real defect, it was fixed, round B came back EMPTY. By the gate's stated definition — "a clean run
 * means a sweep that finds nothing" — that is met. But the completeness critic answered NO, with an
 * argument worth taking seriously:
 *
 *     "an empty result from a sweep that never looked at the open surface is not a clean run —
 *      it is an un-run one."
 *
 * That is half right, and the half that is right is what this file is for. The original sweep is
 * deliberately scoped to the CONVERTED member surface and explicitly instructs agents not to
 * re-report known findings, so its empty result is honest but NARROW. Several surfaces have had no
 * lens across ALL THREE rounds. This sweep points at exactly those, so that "empty" finally means
 * "looked at and found nothing" rather than "never asked".
 *
 * ⚠ IT IS NOT A RE-RUN of the original. Do not merge them: the original's value is that it stays
 * pointed at the converted routes and can be re-run cheaply after a change there.
 */
export const meta = {
  name: 'phase-c-audit-uncovered',
  description: 'The surfaces no lens has covered in three rounds: crowd, install lanes, the six open items, the guards themselves',
  phases: [
    { title: 'Sweep', detail: 'five lenses on never-examined surface' },
    { title: 'Verify', detail: 'three refuters per finding, refute-by-default' },
    { title: 'Critic', detail: 'is the audit finally complete, and what does that not cover' },
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
          reachable_by_v1_member: { type: 'boolean', description: 'True only if a member holding ONLY manageDevices/createInvites/cancelOthers can trigger it today.' },
        },
        required: ['title', 'severity', 'file', 'claim', 'attack', 'evidence', 'reachable_by_v1_member'],
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
  'You are auditing the Cloudflare Worker backend of the FlexText suite. The worker is',
  'worker/src/v1.js (one large routing function). Branch claude/cut-tab-waveform-displays-2owdfx.',
  'NOTHING IN THIS BRANCH IS DEPLOYED. Read the CURRENT code — never assume a doc is up to date.',
  '',
  'THE SYSTEM. Phase C adds multi-researcher project sharing. An OWNER researcher may invite another',
  'researcher into one of their PROJECTS. authMember(req, env, target, needCap) is the single',
  'authorization helper: returns null (=> route answers 401), { ok:false } (=> route answers',
  'not_found), or { ok:true, caller, owner, project_id, caps, isOwner, legacy? }. `caller` is who is',
  'acting; `owner` is whose Drive/credentials the work runs against. ~21 routes use it. Roughly 42',
  'other references still use authResearcher (account-scoped).',
  '',
  'WHAT A v1 MEMBER CAN HOLD: manageDevices, createInvites, cancelOthers. `assignTexts` and `drive`',
  'are in DEFERRED_CAPS — validateCaps REFUSES to write them and authMember DENIES any stored row',
  'carrying them. That is what closed nine earlier findings: the dangerous Drive routes are',
  'UNREACHABLE because the capability cannot be granted, NOT because the routes were fixed. The',
  'account-wide Drive searches are still in the code.',
  '',
  'DESIGN RULES THAT DEFINE A DEFECT:',
  ' . I1 one authority — authMember is the only place authorization is decided.',
  ' . I4 FAIL CLOSED — every unresolvable step denies; never fall back to researcher_id scoping.',
  ' . Denial is indistinguishable from absence (not_found, never 403) so ids cannot be enumerated.',
  ' . Access is PROJECT-scoped. A member reaches everything in their project, nothing outside it,',
  '   and never the account master Drive folder or another project.',
  ' . The owner is never a project_member row; ownership is project.owner_id.',
  ' . member_key wrap-to-owner — the owner always retains a readable copy.',
  ' . Identity is not advertised in cross-researcher lookups (the PAIRING response is the deliberate',
  '   exception: the field user must see who is enrolling their device).',
  ' . wipe and force-remove are owner-only; no capability delegates them.',
  '',
  '⚠⚠ DO NOT RE-REPORT ANY OF THESE — they are known, and several are already fixed. Reporting one',
  'again wastes the round:',
  ' . The nine Drive/docId findings closed by DEFERRED_CAPS. Known. The routes still contain',
  '   account-wide Drive tag searches; that is documented and deliberate.',
  ' . member_key removal missing a legacy-\'\' grant whose device MOVED to another project. FIXED',
  '   2026-08-23: the DELETE now has a third ORed arm.',
  ' . A member-enrolled device showing the OWNER identity at pairing. FIXED 2026-08-23 via a new',
  '   nullable invite.invited_by column + pairingIdentity() resolving COALESCE(invited_by, owner).',
  ' . cancelOthers is grantable by validateCaps but the cancel route gates on manageDevices, so it',
  '   grants nothing extra. KNOWN, deliberate interim (the own/other split needs commands to name an',
  '   issuer; `by` is only now being written), pending a decision. Do not re-report the bare fact.',
  '   You MAY report a CONSEQUENCE of it nobody has stated.',
  ' . changeSettings repointing a device backend. FIXED on both sides: the worker refuses a plaintext',
  '   settings payload, and the DEVICE refuses the relayWorker key (REMOTE_FORBIDDEN in',
  '   docs/js/app.js, verified running in a real browser 2026-08-23).',
  '',
  'Report ONLY defects you can evidence in code. Quote the lines. A finding that cannot be turned',
  'into a concrete request sequence is not a finding. Prefer FEWER, REAL findings; AN EMPTY ARRAY IS',
  'A VALID AND VALUABLE RESULT — this round exists to establish coverage, and a lens that honestly',
  'finds nothing on its assigned surface is exactly as useful as one that finds something. No style,',
  'naming, or test-coverage findings. Set reachable_by_v1_member honestly: most of this surface is',
  'NOT member-reachable today, and a finding inherited only when capabilities widen is still worth',
  'reporting — just mark it false.',
].join('\n')

phase('Sweep')

const LENSES = [
  { key: 'crowd', prompt:
    'LENS: THE CROWD LANE — NEVER SWEPT IN THREE ROUNDS.\n'
    + 'All /v1/crowd routes live in ONE block (worker/src/v1.js, around line 4744). authMember has a\n'
    + '`{ crowd }` target branch that resolves crowd_recorder.project_id — and it has ZERO call sites;\n'
    + 'every crowd route is still `WHERE researcher_id=?`. crowd_recorder.project_id is WRITTEN\n'
    + '(backfill, /projects/assign) and never read for authorization. check-project-scoping.sh never\n'
    + 'scans this block.\n'
    + 'Examine: the researcher-facing management routes (list, create, config/update, delete) AND the\n'
    + 'PUBLIC submit routes (submit/start, submit/chunk, submit) which are deliberately anonymous and\n'
    + 'act in the OWNER\'s Drive by loading the owner researcher row. Ask: can an authenticated\n'
    + 'researcher who is not the owner reach another owner\'s crowd recorder? Do the public submit\n'
    + 'routes leak owner identity, Drive ids, or estate structure to an anonymous caller? Are the\n'
    + 'quota/rate counters (submit_count, bytes_total, day_count/day_key, max_per_day, max_bytes_total)\n'
    + 'enforceable, or can they be raced or bypassed? Is the dead `{crowd}` branch itself a hazard —\n'
    + 'i.e. would wiring it up naively today grant something it should not?' },

  { key: 'installlane', prompt:
    'LENS: THE authInstall DEVICE LANE — the WRITE and UPLOAD routes, never swept.\n'
    + 'authInstall (worker/src/v1.js ~line 464) authenticates a DEVICE (install) rather than a\n'
    + 'researcher. Call sites: accept (~4254), wipe-ack (~4354), upload/start (~4386), upload/chunk\n'
    + '(~4453), upload finish (~4471), report (~4529), and the GET desired lane (~4561).\n'
    + 'Earlier rounds looked ONLY at the GET desired lane. Sweep the rest.\n'
    + 'Ask: does each route bind BOTH instance_id and install_id, so a valid install secret for device\n'
    + 'A cannot act on device B (including across DIFFERENT researchers/projects)? Can a revoked or\n'
    + 'pending (unapproved, unaccepted) install still write — report inventory, start or continue an\n'
    + 'upload, ack a wipe? Does the upload lane let a device write into a Drive folder it does not own,\n'
    + 'or supply a caller-controlled folder/file id? Are the chunked-upload session ids guessable or\n'
    + 'reusable across installs? Does wipe-ack let a device clear a wipe it was not issued? Is there a\n'
    + 'state where accept/report resurrects a device the researcher revoked?' },

  { key: 'openitems', prompt:
    'LENS: THE SIX STILL-OPEN ITEMS, EXAMINED PROPERLY RATHER THAN ASSUMED.\n'
    + 'These are FILED as known-but-unfixed. Nobody has audited them; they were triaged as\n'
    + '"unreachable by a v1 member" and left. Your job is to establish what is ACTUALLY true of each\n'
    + 'in the current code, and to report any consequence that has not been stated. Reporting "this is\n'
    + 'exactly as filed and bounded by X" with quoted evidence is a valuable result.\n'
    + ' 1. GET /v1/researcher/keys selects member_key by researcher_id ALONE — no membership, project\n'
    + '    or revoked predicate. It is the only way a member learns instance ids. What precisely can a\n'
    + '    CURRENT member, and a FORMER member, still obtain through it? Does any other route\n'
    + '    compound it?\n'
    + ' 2. The INSTALL lane of GET /v1/instances/<id> answers three distinguishable states BEFORE any\n'
    + '    authentication succeeds ({wipe:true} 200 / revoked 410 / 401). Note the 410 auto-release is\n'
    + '    load-bearing (a revoked device must un-orphan itself) and is pinned by the device-compat\n'
    + '    probe. What does an unauthenticated caller who guesses/knows an install_id+instance_id pair\n'
    + '    actually learn, and is there a formulation that keeps auto-release while leaking less?\n'
    + ' 3. POST /v1/researcher/delete deletes no project, project_member, member_key or session rows.\n'
    + '    What survives an account deletion, and what can still be done with it afterwards?\n'
    + ' 4. (covered by the crowd lens — skip)\n'
    + ' 5. (fixed — skip)\n'
    + ' 6. No attribution logging for member device actions (rename, revoke, approve, key, invite).\n'
    + '    Which member-reachable actions are unattributable, and does any EXISTING log record the\n'
    + '    wrong actor (e.g. logging ctx.owner where ctx.caller acted)? A log naming the wrong person\n'
    + '    is worse than no log — report that specifically if you find it.' },

  { key: 'authresearcher', prompt:
    'LENS: THE ~42 authResearcher REFERENCES — assumed account-scoped, never verified.\n'
    + 'Phase C converted ~21 routes to authMember and left the rest on authResearcher. The assumption\n'
    + 'recorded is that those are genuinely ACCOUNT-scoped and therefore inert for a member (a member\n'
    + 'calling them acts on their OWN account, reaching nothing of the owner\'s). VERIFY that, route by\n'
    + 'route, rather than assuming it.\n'
    + 'Enumerate the authResearcher routes and for EACH ask: does it read or write any row keyed by\n'
    + 'something OTHER than the caller\'s own researcher_id — an instance_id, crowd_id, project_id,\n'
    + 'install_id, invite_id, docId or Drive id taken from the URL or BODY? If so, is that id\n'
    + 'ownership-checked against the caller? Any route that takes a caller-supplied id and does not\n'
    + 'bind it to the caller\'s researcher_id is the finding. Pay particular attention to: the\n'
    + 'researcher/keys routes, pubkey publish/read, projects create/rename/assign, sessions, the admin\n'
    + 'backfill, textfile minting/redemption, and anything touching drive-estate / drive-file /\n'
    + 'drive-purge. Also flag any route that answers 403 (or otherwise distinguishes "exists but\n'
    + 'forbidden" from "not found") for a resource the caller does not own.' },

  { key: 'guards', prompt:
    'LENS: THE GUARDS THEMSELVES — can they FAIL, or are they decoration?\n'
    + 'This codebase has twice shipped a check that passed over the very thing it guarded, and treats\n'
    + 'that as worse than no check because it then gets quoted as evidence. Audit the guards, not the\n'
    + 'worker.\n'
    + 'Read check-project-scoping.sh, check-native-containment.sh, check-secrets.sh, and the tests\n'
    + 'test/worker-members.probe.mjs, test/worker-route-scoping.probe.mjs, test/project-authz.test.mjs,\n'
    + 'test/worker-device-compat.probe.mjs.\n'
    + 'For EACH guard ask: (a) what exact string/pattern does it match, and what LEGITIMATE spelling of\n'
    + 'the thing it guards would slip past it (e.g. matching `const r = await authResearcher` while a\n'
    + 'route writes `asResearcher = await authResearcher`)? (b) what is its SCOPE — does it scan the\n'
    + 'whole worker or only one block? It is known that check-project-scoping.sh bounds its route scan\n'
    + 'to the /v1/instances/<id> block, so /v1/researcher/keys, /v1/projects/<id>/members and /v1/crowd\n'
    + 'are outside it; state precisely which checks that exempts and what regression would go\n'
    + 'unnoticed. (c) does it verify a mechanism EXISTS but not that it ACTS (e.g. a list-based check\n'
    + 'that still passes when the list is emptied)? (d) would it actually fail the build — does its\n'
    + 'exit code reach the caller?\n'
    + 'Report a guard gap as a finding with the concrete regression it would let through.' },
]

const round = await parallel(LENSES.map((l) => () =>
  agent(CTX + '\n\n' + l.prompt, { label: 'sweep:' + l.key, phase: 'Sweep', schema: FINDING, effort: 'high' })))

const seen = new Set()
const pool = round.filter(Boolean).flatMap((r) => r.findings || []).filter((f) => {
  const k = (f.file || '') + ':' + (f.line || 0) + ':' + (f.title || '').slice(0, 40)
  if (seen.has(k)) return false; seen.add(k); return true
})
log('sweep: ' + pool.length + ' candidate findings from ' + round.filter(Boolean).length + '/' + LENSES.length + ' lenses')

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
      + ' the behaviour is deliberate and correct. Confirm ONLY if you can trace it yourself.'
      + ' NOTE: "not reachable by a v1 member" is NOT grounds to refute — it is a severity fact, and'
      + ' the finding records it separately. Refute on whether the DEFECT IS REAL.',
      { label: 'verify:' + lens + ':' + (f.title || '').slice(0, 20), phase: 'Verify', schema: VERDICT, effort: 'high' })))
    .then((vs) => {
      const good = vs.filter(Boolean)
      return { finding: f, votes: good, survives: good.length > 0 && good.filter((v) => !v.refuted).length >= 2 }
    })))).filter(Boolean)

const confirmed = judged.filter((j) => j.survives).map((j) => j.finding)
log('verified: ' + confirmed.length + ' survived of ' + pool.length)

phase('Critic')

const critic = await agent(CTX + '\n\nTHREE audit rounds have now run. Round 1 (six lenses) produced 17'
  + ' findings, all fixed. Round 2 (the sweep: invariants / sequencing / unexamined) found one defect,'
  + ' which was fixed, and its re-run came back EMPTY. THIS round aimed five lenses at the surfaces'
  + ' none of them had ever covered: the crowd lane, the authInstall write/upload lanes, the six'
  + ' still-open items, the ~42 authResearcher routes, and the guard scripts themselves.\n\n'
  + 'This round confirmed:\n' + JSON.stringify(confirmed, null, 2)
  + '\n\nand refuted:\n'
  + JSON.stringify(judged.filter((j) => !j.survives).map((j) => ({ title: j.finding.title, why: (j.votes.find((v) => v.refuted) || {}).reasoning })), null, 2)
  + '\n\nAs completeness critic, answer PLAINLY and in order:\n'
  + '1. Is there any surface of this worker that STILL has had no lens across all three rounds? Name'
  + ' specific routes, helpers, or invariants — or say plainly that there are none left.\n'
  + '2. Which confirmed findings look wrong to you, and which refutations look wrong?\n'
  + '3. Does the fan-out audit NOW have its clean run? Answer yes or no. If no, say exactly what'
  + ' remains. If yes, state precisely what that claim does NOT cover — in particular that the'
  + ' deferred Drive capabilities make nine findings unreachable rather than repaired.\n'
  + '4. What should a maintainer NOT conclude from this audit? Be blunt.\n'
  + 'Markdown, concise, no preamble.', { label: 'completeness', phase: 'Critic', effort: 'high' })

return { confirmed, refuted: judged.length - confirmed.length, candidates: pool.length, critic }
