/* A COWORKER'S NAME, EMAIL AND AVATAR ARE NOT REACHABLE FROM THEIR ID.
 *
 * Seth, 2026-08-28, looking at the Coworkers list: "we want member researcher e-mail address and
 * avatar and name not to be accessible from their ID like this."
 *
 * ⚠ THIS REVERSED A DECISION THE CODE ARGUED FOR, which is why it is pinned rather than merely done.
 * The members route carried a comment justifying the disclosure: owner-only route, mutual
 * relationship, the member handed over their ID to be added at all — so showing the owner who they
 * are reveals nothing the exchange did not establish. That is sound, and it answers a question about
 * CONSENT. The question that decides it is different: what does the panel HOLD on a device that is
 * lost or no longer in trusted hands? A collaborator directory, refetched on every open. v449 removed
 * exactly that from device pairing for exactly this reason; the researcher panel had kept it.
 *
 * ⚠ NOTHING WAS DELETED TO ACHIEVE IT, and that is worth knowing before someone "restores" it: the
 * identity was never stored per membership. project_member is (project_id, researcher_id, caps,
 * added_at, added_by). The name/email/avatar were JOINED at read time from the researcher row, where
 * they belong for that account's OWN sign-in. Removing the join removed the disclosure.
 *
 * Run: node test/coworker-identity.test.mjs
 */
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };
const worker = read('../worker/src/v1.js');
const panel = read('../docs/js/researcher-panel.js');
const schema = read('../worker/schema-current.sql');

console.log('\nthe members route returns no identity at all');
{
  const i = worker.indexOf("'SELECT m.researcher_id, m.caps, m.added_at, m.added_by, '");
  ok(i > 0, 'the members query is findable');
  const q = worker.slice(i, i + 400);
  for (const col of ['display_name', 'drive_email', 'avatar_url']) {
    ok(!q.includes(col), `⚠ the query does not select ${col}`);
  }
  ok(/\(r\.pubkey IS NOT NULL\) AS pubkey_set/.test(q),
     '⚠ but pubkey_set REMAINS — a boolean that identifies nobody, and the only way an owner can tell '
     + '"waiting for them to finish enrolling" from "broken"');
}

console.log('\n...and the panel does not render any, even from an older worker that still sends it');
{
  const row = panel.slice(panel.indexOf('rp-share-row'), panel.indexOf('rp-share-row') + 1800);
  for (const f of ['display_name', 'drive_email', 'avatar_url', 'x.email']) {
    ok(!row.includes(f), `⚠ the coworker row never reads ${f} — an old worker still sends them`);
  }
  ok(/memberNick\(x\.researcher_id\)/.test(row), 'a coworker is named by the owner\'s own nickname');
  ok(/rp-rid-sm/.test(row), '...beside the ID, which is what the owner actually pasted to add them');
}

console.log('\nthe nickname is LOCAL — putting it server-side would rebuild the directory');
{
  ok(/Researcher\.setPref\('coworkerNames', next\)/.test(panel),
     '⚠ stored via setPref — the account prefs blob, encrypted under Kr before it leaves the browser');
  ok(/\(\(await Researcher\.getPrefs\(\)\) \|\| \{\}\)\.coworkerNames/.test(panel),
     '...and read back from the same place');
  ok(!/coworkerNames/.test(worker),
     '⚠⚠ the WORKER knows nothing about nicknames — D1 stores ciphertext, and one hop server-side '
     + 'would rebuild exactly the collaborator directory this removed');
  ok(!/coworker_name|nickname/i.test(schema.split('CREATE TABLE IF NOT EXISTS project_member')[1] || ''),
     '...and project_member grew no column for it');
}

console.log('\nthe OPERATOR approval list is untouched — a different question, deliberately');
{
  /* An operator deciding whether to approve a brand-new researcher account is judging a PERSON, and
   * needs to see who they are. That list keeps its identity, and conflating the two would be the
   * obvious over-correction. */
  ok(/p\.avatar_url \? `<img class="invite-avatar"/.test(panel),
     '⚠ the pending-approval list still shows name, email and avatar — an operator approving a real '
     + 'person needs them, and that is not the leak that was closed');
}

console.log(fail ? `\nFAILED (${fail}) — coworker identity is reachable again.\n`
                 : '\nPASS: coworkers are an ID plus a name only their owner can read.\n');
process.exit(fail ? 1 : 0);
