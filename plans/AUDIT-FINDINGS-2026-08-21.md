# Phase C authorization audit — findings, 2026-08-21

⚠ **NOT DEPLOYED.** All of this is on branch `claude/cut-tab-waveform-displays-2owdfx`. Increment 1
(the project namespace join) IS in production and is not implicated. No `project_member` rows exist
anywhere, so nothing here was ever reachable in the field — every finding was caught before shipping,
which is what the gate was for.

## Status: ROUND 1 + SWEEP COMPLETE. ALL 23 CONFIRMED FINDINGS FIXED. NOT YET A CLEAN RUN.

| | round 1 | sweep |
|---|---|---|
| lenses | 6 | 3 |
| candidates | 23 | 12 |
| **confirmed** | **17** | **6** (4 distinct — two pairs were one defect reported twice) |
| refuted | 16 votes | 6 |
| fate | all fixed | all fixed |

Plus the completeness critic's own findings, two of which were live defects in the REMEDIATION and
are also fixed (read-time capability enforcement; owner-only key delivery).

⚠ **THE CRITIC'S VERDICT WAS "NO — NOT A CLEAN RUN", AND IT STILL STANDS**, though for a smaller
reason than when it was written. Its three grounds were: four live defects open (now fixed); the
write-time-only deferral (now fixed); and a containment script with four blind spots (now fixed, and
mutation-tested). What remains is §"STILL OPEN" below — items nobody has yet examined. **A clean run
means a sweep that finds nothing, and no sweep has yet been run against the CURRENT code.**

## What the two rounds actually proved, and what they did not

**Round 1's nine same-root findings were closed by making the CAPABILITY ungrantable, not by fixing
the routes.** The account-wide `docId` tag searches are still there, untouched. That is a deliberate
trade — see the fix section — but it means the Drive lane is deferred, not repaired.

⚠ **And the heuristic that justified it was FALSE.** validateCaps claimed "EVERY dangerous route is
one where the member names a Drive file or text; EVERY safe route works only from D1." The sweep
disproved it within hours via `changeSettings`, which names no Drive id and could repoint a field
device's entire backend. **A rule that explains the last outage is not thereby a rule about the next
one** — that sentence is now in the source where the rule used to be.

---

## STILL OPEN — examined by nobody, filed rather than fixed

None of these is reachable by a v1 member holding only `manageDevices`/`createInvites`, which is why
they are filed rather than blocking. They are recorded because the next person to widen capabilities
inherits every one of them.

1. **`GET /v1/researcher/keys` has no membership, project or revoked predicate.** It is the ONLY way
   a member learns any instance id — `GET /v1/researcher` lists devices by `researcher_id`, so a
   member sees none of the project's. That makes this query the precondition for every member-side
   attack in the confirmed list, and it is unscoped.
2. **The INSTALL lane of `GET /v1/instances/<id>` answers three distinguishable states BEFORE any
   authentication succeeds** — `{wipe:true}` 200, `revoked` 410, or 401 — from a wrong or absent
   install secret. The researcher branch 20 lines below was fixed; nobody looked above it.
3. **`POST /v1/researcher/delete` deletes no `project`, `project_member`, `member_key` or `session`
   rows.** Auth fails closed (the researcher row is gone), so this is retention rather than access —
   but grants outlive the instances they name and `GET /v1/researcher/keys` keeps serving them.
   Belongs with the revoked-row minimisation work.
4. **`authMember`'s `{ crowd }` target has ZERO call sites.** Every crowd route is still
   `WHERE researcher_id=?`, and `crowd_recorder.project_id` is written and never read for
   authorization. Fail-closed, but a third of the typed target surface is untested dead code and the
   containment script never scans `/v1/crowd`.
5. **⚠ A MEMBER-ENROLLED DEVICE SHOWS THE FIELD USER THE WRONG HUMAN.** The identity presented at the
   accept gate resolves through `instance.researcher_id`, which is always the project OWNER — so when
   a member enrols a coworker's device, the person confirming sees the owner's identity rather than
   the researcher actually enrolling them. That is a correctness question about the ANTI-PHISHING
   gate, whose whole purpose is that the field user can tell who they are being linked to.
6. **No attribution for member device actions.** `logApproval` fires for member_added, grant_revoked
   and text_moved — but not for rename, instance revoke, install revoke, approve, key delivery or
   invite. A command's `by` field is the only member action an owner can attribute. No stated
   invariant requires this; it is a gap nobody has looked at.

---

---

## ROOT CAUSE 1 — authorize the project, then act on any id in the account (9 findings)

**One defect, nine faces.** Each of these routes correctly asks *"is this researcher allowed in
project A?"* — and then acts on a Drive text or file id supplied by the CALLER, resolved by a tag
search across the owner's ENTIRE Drive, never constrained to the project that was just authorized.

It is the building-pass failure: the badge is checked for Building A, and then any room number
opens any door in any building.

⚠ **This was latent, not new — but reaching it is new.** The account-wide tag search is deliberate
and documented (`driveEnsureTextFolder`: *"The tag search is scoped to trashed=false but NOT to the
parent"*), and was harmless while these routes were owner-only. Converting them to `authMember` on
2026-08-20 is what made them reachable by a member. The conversion did not introduce the search; it
removed the only thing that made it safe.

⚠ It is also the exact inverse of the boundary Seth set the same evening — *"They shouldn't have
access to the parent folder, I mean, or other projects."*

### CRITICAL — `Converted member routes resolve a text by caller-supplied docId with an account-wide Drive search, so a member of one pr` (v1.js:3679)

**The five Drive-touching routes that were converted to authMember (texts/<docId>/files, assignment/begin, assignment/finish, adopt, move) bind authorization to the instanceId in the PATH but then resolve the actual Drive object from a caller-supplied docId via a `spaces=drive` appProperties tag search across the OWNER's entire Drive. Nothing between authMember and the Drive call compares the found folder's parents to the project authMember resolved, and `project.drive_folder_id` — the field the members-POST migration gate exists to guarantee — is read by no route a member can reach.**

**Attack.** Owner O owns project A and project B. M is a project_member of A with {"assignTexts":true,"drive":"read"} and is NOT in B (or was removed from B and still has its docIds, which are plaintext in the panel's move/pending maps and survive removal). 1) M sends GET /v1/instances/<A-instance-id>/texts/<B-docId>/files. authMember({instance:A-instance},'drive:read') resolves project A → ok; the `owned` re-check only asks whether the A instance still belongs to the owner. The tag query then runs over the whole account and returns project B's text folderId, originalsFolderId, and every child file's id/name/size/mime/role. 2) M then sends POST /v1/instances/<A-instance-id>/texts/<B-docId>/adopt with body {}. The same account-wide query finds B's text folder and `driveReparent(access, f.id, toFolder, f.parents)` moves it under a device folder inside project A, clearing flextextUnassigned so no sweep returns it. B's recordings, flextexts and consent files are now physically inside A. POST .../texts/<B-docId>/move {to:<second A instance>} does the same. Note the same crossing happens with no attacker foresight at all whenever the owner moves a device between projects with POST /v1/researcher/projects/assign: docIds M legitimately learned while the device was in A keep resolving after it becomes B's.

<details><summary>Evidence</summary>

```
worker/src/v1.js:3663-3680 (files) — `const ctx = await authMember(request, env, { instance: instanceId }, 'drive:read');` … `const docId = String(seg[4] || '').replace(/[^\w-]/g, '').slice(0, 64);` … `const fq = encodeURIComponent(\`appProperties has { key='flextextDoc' and value='${docId}' } and mimeType='application/vnd.google-apps.folder' and trashed=false\`);` / `const found = await driveJson(access, 'GET', 'https://www.googleapis.com/drive/v3/files?spaces=drive&orderBy=createdTime&fields=files(id)&q=' + fq);` — with `const r = ctx.owner;` at 3666 and `const access = await driveAccessToken(env, r);` at 3677, i.e. the OWNER's token. Identical unscoped queries at 3868-3870 (adopt, followed by `if (!(f.parents || []).includes(toFolder)) await driveReparent(access, f.id, toFolder, f.parents);`) and 3909-3910 (move). driveEnsureTextFolder states the property outright at v1.js:1134-1136: “The tag search is scoped to trashed=false but NOT to the parent”. validateCaps' own comment (v1.js:474-478) already knows this — “a member restricted to one device could still open another's files through any docId-routed Drive route … The honest boundary is the one Drive can actually enforce, and that is the project” — but no route enforces the project either: grep shows `drive_folder_id` read only at 1679/1700/1760/2400/2473/3234, never in the /v1/instances block.
```

</details>

### CRITICAL — `assignment/finish, move and adopt mint owner-authority streaming URLs for any caller-supplied Drive file id, and redempt` (v1.js:3828)

**mintTextfileUrl validates nothing about the file (`if (!fileId) return null;` then straight into the token), the call sites pass `r.researcher_id` where `r = ctx.owner`, and /v1/textfile's member-grant check asks only whether the minter still belongs to the SCOPED instance's project — never whether tk.f is inside that project. assignTexts in one project therefore yields read access to every app-created file in the owner's whole Drive, across all their projects.**

**Attack.** M is a project_member of project A with {"assignTexts":true}. M obtains a file id from outside project A — e.g. straight out of the cross-project listing above, or cached from a project they were removed from. M sends POST /v1/instances/<A-instance-id>/texts/<any-docId>/assignment/finish with {"promptFileId":"<foreign-file-id>","ttlDays":400}. authMember passes on project A; promptUrl is minted with scope = null, so the token is v1-shaped with tk.m = M, tk.r = owner, and a 400-day life (clampTtlDays caps at 400, v1.js:1186-1190). The response hands M the URL. GET /v1/textfile/<token> takes the `tk.m && !tk.i` branch, whose query is 'is M a member of ANY project this owner owns' — true because of project A — and streams the file with the owner's Drive token to a header-less fetch. Because the prompt token is deliberately unscoped, it also survives revocation of every device in project A. audioFileId/flextextFileId on finish/move/adopt work the same way with a project-A instance in tk.i, which the membership query then happily confirms.

<details><summary>Evidence</summary>

```
worker/src/v1.js:3826-3828 — `const audioUrl = await mintTextfileUrl(env, url.origin, r.researcher_id, body.audioFileId, '', ttlMs, scope, ctx.caller.researcher_id);` / `…body.flextextFileId…` / `const promptUrl = await mintTextfileUrl(env, url.origin, r.researcher_id, body.promptFileId, '', ttlMs, null, ctx.caller.researcher_id);` with `const r = ctx.owner;` at 3811. mintTextfileUrl, v1.js:1209-1213: `if (!fileId) return null; const tk = { r: researcherId, f: fileId, x: extract || '', e: … };` — no Drive lookup, no parentage check. Redemption, v1.js:1885-1896: `ok2 = tk.i ? …'FROM project_member pm JOIN instance i ON i.project_id=pm.project_id WHERE pm.researcher_id=? AND i.instance_id=?' : …'FROM project_member pm JOIN project p ON p.project_id=pm.project_id WHERE pm.researcher_id=? AND p.owner_id=?'` — neither query mentions tk.f. The streaming call at 1904 is `fetch('…/files/' + encodeURIComponent(tk.f) + '?alt=media', { headers: { Authorization: 'Bearer ' + access } })` where access came from `driveAccessToken(env, owner)`. Same unvalidated mint at 3881 (adopt) and 3921 (move).
```

</details>

### CRITICAL — `Text-scoped routes resolve the text by a caller-supplied docId through an account-wide Drive search, so a member can ste` (v1.js:3868)

**POST /v1/instances/<id>/texts/<docId>/adopt (and .../move) authorize on the instanceId in the path but then locate the text folder by a caller-supplied docId with a Drive-wide tag search that is never constrained to the project authMember resolved — so a member of project A can re-parent a text folder belonging to project B into a device folder inside project A.**

**Attack.** Researcher M is a project_member of project A with caps {"assignTexts":true}; the owner also owns project B, which M is not a member of (or was removed from, and still holds the docIds). M knows a docId of a text in project B. M sends POST /v1/instances/<A-instance-id>/texts/<B-docId>/adopt with body {}. authMember({instance: A-instance}, 'assignTexts') resolves project A and returns ok. The route then runs the tag query for flextextDoc='<B-docId>' over spaces=drive (the owner's WHOLE Drive), finds project B's text folder, and calls driveReparent(access, f.id, toFolder, f.parents) where toFolder is a device folder in project A. Project B's text — every uploaded recording, flextext and consent file in it — is now physically inside project A, where M has drive:read/assignTexts, and its flextextUnassigned tag is cleared so nothing sweeps it back. Same sequence works via POST .../texts/<B-docId>/move {to:<another A instance>}.

<details><summary>Evidence</summary>

```
worker/src/v1.js:3855-3875 —
  if (m === 'POST' && sub === 'texts' && seg.length === 6 && seg[5] === 'adopt') {
    const ctx = await authMember(request, env, { instance: instanceId }, 'assignTexts');
    ...
    const docId = String(seg[4] || '').replace(/[^\w-]/g, '').slice(0, 64);
    ...
    const fq = encodeURIComponent(`appProperties has { key='flextextDoc' and value='${docId}' } and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const found = await driveJson(access, 'GET', 'https://www.googleapis.com/drive/v3/files?spaces=drive&orderBy=createdTime&fields=files(id,parents)&q=' + fq);
    const f = (found.files || [])[0];
    ...
      if (!(f.parents || []).includes(toFolder)) await driveReparent(access, f.id, toFolder, f.parents);
The identical unscoped search is repeated in /move at v1.js:3909-3910. Nothing between the authMember call and the reparent compares the found folder's parents to the resolved project's drive_folder_id.
```

</details>

### HIGH — `GET /v1/instances/<id>/texts/<docId>/files lists any text in the owner's entire Drive, not just the resolved project's` (v1.js:3676)

**The route authorizes drive:read against the instance in the path, then runs the flextextDoc tag search over spaces=drive with a docId the caller fully controls, returning folder ids, file ids, names and sizes for a text that may belong to a different project of the same owner.**

**Attack.** Researcher M is a project_member of project A with {"drive":"read"}. M sends GET /v1/instances/<A-instance-id>/texts/<docId-belonging-to-project-B>/files. authMember resolves project A and passes; the `owned` re-check only confirms the A instance still belongs to the owner. The Drive query is then account-wide, so the response body carries project B's text folderId, its originalsFolderId, and every child file's id, name, size, mime and role. Those file ids feed directly into the mint finding above to read the bytes.

<details><summary>Evidence</summary>

```
worker/src/v1.js:3663-3680 —
  const ctx = await authMember(request, env, { instance: instanceId }, 'drive:read');
  ...
  const docId = String(seg[4] || '').replace(/[^\w-]/g, '').slice(0, 64);
  ...
  const fq = encodeURIComponent(`appProperties has { key='flextextDoc' and value='${docId}' } and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const found = await driveJson(access, 'GET', 'https://www.googleapis.com/drive/v3/files?spaces=drive&orderBy=createdTime&fields=files(id)&q=' + fq);
  ... return j({ folderId, originalsFolderId: ..., files }, 200, origin, env);
The comment on driveEnsureTextFolder states the same property explicitly (v1.js:1134-1136): "The tag search is scoped to trashed=false but NOT to the parent".
```

</details>

### HIGH — `assignment/upload/start writes into an unvalidated caller-supplied Drive parent, letting a member plant files in another` (v1.js:3765)

**`parent` is taken verbatim from body.originalsFolderId with no files.get, no parentage check and no relation to the instance, text or project authMember resolved, and the resumable session is opened with the OWNER's token — so a member with assignTexts writes anywhere in the owner's app-created estate. The sibling begin route has the same hole one level up: driveEnsureTextFolder trusts body.folderId as long as it merely exists and is untrashed.**

**Attack.** M is a project_member of project A with {"assignTexts":true}. 1) M learns a foreign folder id F — from GET /v1/instances/<A-instance>/texts/<B-docId>/files, which returns project B's `folderId` and `originalsFolderId`, or from adopt's `folderId`. 2) M sends POST /v1/instances/<A-instance-id>/texts/<any-docId>/assignment/upload/start {"name":"consent.flextext","mime":"application/xml","size":1024,"kind":"flextext","originalsFolderId":"F"} → 200 with an uploadId. 3) M PUTs the bytes to .../assignment/upload/chunk (the only check there is `sess.rr !== r.researcher_id`, and rr is the owner, so it passes). The file lands inside project B tagged flextextRole:'source-flextext', where B's panel and B's device treat it as legitimate source material. The same call with F = the master 'FlexText Uploads' folder id writes outside every project. Variant on begin: POST .../texts/<any-docId>/assignment/begin {"folderId":"<B-text-folder-id>"} returns that foreign folder and creates an `originals` child inside it.

<details><summary>Evidence</summary>

```
worker/src/v1.js:3764-3777 — `const access = await driveAccessToken(env, r);` (r = ctx.owner, 3751) / `let parent = String(body.originalsFolderId || '');` / `if (body.kind === 'consent-prompt') { parent = await driveEnsureDeviceFolder(...); }` / `if (!parent) return j({ error: 'bad_folder' }, 400, origin, env);` / `body: JSON.stringify({ name, mimeType: mime, parents: [parent], appProperties: { flextextRole: role } }),`. The only prior binding is `authMember(request, env, { instance: instanceId }, 'assignTexts')` at 3748 plus an instance-ownership SELECT; `parent` is never compared to the device folder, the text folder, or project.drive_folder_id. begin, v1.js:3737: `const folder = await driveEnsureTextFolder(access, deviceFolder, docId, body.title, body.folderId);` and driveEnsureTextFolder's knownId path at 1147-1153 returns any id for which `files.get` succeeds and `!f.trashed`.
```

</details>

### HIGH — `Textfile tokens are minted for a caller-chosen Drive file id that is never checked against the caller's project (cross-p` (v1.js:3826)

**POST /v1/instances/<id>/texts/<docId>/assignment/finish mints a /v1/textfile token whose `f` is taken verbatim from the request body, with no check that the file lies inside the caller's project — and redemption re-checks only the owner, the instance and the minter's membership, never the file — so a member of one project can have the owner's Drive token stream any app-created file in the owner's account, including files in another project and under the account master folder.**

**Attack.** Owner O has projects A and B. M is a member of A with assignTexts (and drive:read). 1) M calls GET /v1/instances/<instance in A>/texts/<docId belonging to a text in project B>/files — that route resolves the folder with a whole-Drive tag search (`spaces=drive`, line 3678: `appProperties has { key='flextextDoc' and value='${docId}' }`) with no parent/project constraint, and returns the ids of every file in project B's text folder. (Any file id M knew from a project they were removed from works equally well; nothing else is needed.) 2) M calls POST /v1/instances/<instance in A>/texts/<any docId>/assignment/finish with {"promptFileId":"<project-B file id>","ttlDays":400}. authMember passes: the target instance really is in project A and M really has assignTexts there. 3) The response contains promptUrl. GET that URL: tk.r is O, so driveAccessToken(env, owner) fetches https://www.googleapis.com/drive/v3/files/<project-B file id>?alt=media and streams project B's audio/flextext back to M. Using promptFileId rather than audioFileId is the sharp variant: line 3828 passes `null` for scope, so the token carries no `i`, is not killed by revoking any device, and lives the full clamped TTL (up to 400 days via clampTtlDays).

<details><summary>Evidence</summary>

```
worker/src/v1.js:3826-3828 — `const audioUrl = await mintTextfileUrl(env, url.origin, r.researcher_id, body.audioFileId, '', ttlMs, scope, ctx.caller.researcher_id);` / `const flextextUrl = await mintTextfileUrl(env, url.origin, r.researcher_id, body.flextextFileId, '', ttlMs, scope, ctx.caller.researcher_id);` / `const promptUrl = await mintTextfileUrl(env, url.origin, r.researcher_id, body.promptFileId, '', ttlMs, null, ctx.caller.researcher_id);` — the only prior validation is worker/src/v1.js:3815 `if (!body.audioFileId && !body.flextextFileId && !body.promptFileId) return j({ error: 'nothing_to_mint' }, 400, origin, env);`. mintTextfileUrl (worker/src/v1.js:1209-1215) copies it straight in: `if (!fileId) return null;` … `const tk = { r: researcherId, f: fileId, x: extract || '', …}`. At redemption the route resolves the owner, the scoped instance and the minter's membership but never the file: worker/src/v1.js:1904 `const g = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(tk.f) + '?alt=media', { headers: { Authorization: 'Bearer ' + access, … } });`. The id-discovery step is member-reachable and equally unscoped: worker/src/v1.js:3663 `const ctx = await authMember(request, env, { instance: instanceId }, 'drive:read');` then worker/src/v1.js:3678-3679 `const fq = encodeURIComponent(\`appProperties has { key='flextextDoc' and value='${docId}' } …\`); const found = await driveJson(access, 'GET', 'https://www.googleapis.com/drive/v3/files?spaces=drive&orderBy=createdTime&fields=files(id)&q=' + fq);`
```

</details>

### HIGH — `A member with assignTexts can mint a /v1/textfile URL for any Drive file id in the owner's account` (v1.js:3921)

**In the converted texts/move and texts/adopt routes the file ids that get sealed into a /v1/textfile bearer token come straight from the request body and are never checked against the doc, the device or ctx.project_id — the token is minted with the OWNER's researcher_id, so any member holding assignTexts in one project can obtain the bytes of any app-created file in the owner's whole Drive, including other projects and the account master folder.**

**Attack.** 1. M is a member of project A with caps {"assignTexts":true}; A contains devices D1 and D2 (ids a member legitimately knows).
2. M knows a Drive file id F that belongs to project B of the same owner O (e.g. from an earlier membership, a forwarded link, or a docId listed through GET /v1/instances/<D1>/texts/<docId>/files, whose Drive query at v1.js:3677 is account-wide with no parent constraint).
3. M calls POST /v1/instances/D1/texts/<anyDocId>/move with body {to:"D2", flextextFileId:"F"}. authMember resolves D1 -> project A and passes assignTexts; `from`/`to` are validated only by `researcher_id=?` bound to ctx.owner (v1.js:3899-3903), i.e. the owner's entire estate, and nothing validates F at all.
4. The response contains flextextUrl = <origin>/v1/textfile/<token> where the token is {r:O, f:F, m:M, i:D2}.
5. M fetches that URL. The Phase C grant recheck at v1.js:1886-1889 only asks whether M is still a member of the project D2 belongs to — which is project A — so it passes, and the worker streams F using the owner's Drive access token (v1.js:1904-1907). Same primitive via audioFileId and via the /adopt route at v1.js:3881.

<details><summary>Evidence</summary>

```
v1.js:3921 — `const mint = (fileId, extract) => mintTextfileUrl(env, url.origin, r.researcher_id, fileId, extract, 0, { instanceId: to.instance_id, docId }, ctx.caller.researcher_id);`
v1.js:3922-3923 — `const flextextUrl = await mint(body.flextextFileId) || await mint(body.extractFromZipId, 'flextext');\n        const audioUrl = await mint(body.audioFileId);` — caller-supplied ids, unvalidated.
v1.js:3899-3903 — `const from = await env.DB.prepare('SELECT instance_id, nickname, oauth_folder_id FROM instance WHERE instance_id=? AND researcher_id=? AND revoked=0')…` / same for `to` — scoped to the OWNER's account, never to ctx.project_id.
v1.js:1886-1889 — the redemption check is `SELECT 1 AS ok FROM project_member pm JOIN instance i ON i.project_id=pm.project_id WHERE pm.researcher_id=? AND i.instance_id=?`, i.e. it validates the DESTINATION device's project, not the file's.
```

</details>

### MEDIUM — `A member action can create a project's device folder directly under the account master, putting project data outside eve` (v1.js:1029)

**Every member-reachable call to driveEnsureDeviceFolder omits the projectFolderId argument, so when the instance has no live oauth_folder_id the parent falls through to `driveMasterFolder(access)` — the account root of the FlexText estate. A member with assignTexts therefore creates a container, its text folder and its uploaded assignment files at the account master level, outside the project folder the members-POST gate insists must exist before sharing is allowed.**

**Attack.** Instance D belongs to project A (project_id stamped by the backfill) but has oauth_folder_id NULL — a device enrolled and never uploaded, which is exactly the device assign-by-upload targets. M, a member of A with {"assignTexts":true}, sends POST /v1/instances/<D>/texts/<docId>/assignment/begin {"title":"Story 1"}. driveEnsureDeviceFolder(env, access, D, nickname, null) runs with projectFolderId undefined; drivePriorProjectParent('') returns ''; so parent = driveMasterFolder(access) and the device folder is created directly under 'FlexText Uploads'. begin then creates the text folder and originals/ beneath it and M uploads the assignment there. The bytes now sit outside project A's Drive folder, so any listing rooted at project.drive_folder_id (the confinement the 409 not_migrated gate was added to guarantee) cannot see them, while reconcileProjects leaves the row alone because a container under master has projectId '' (v1.js:1801-1806: `if (!d.projectId || !d.folderId) continue;`). The same fallback fires on adopt (3867) and move (3905) whenever a device folder has been trashed and its old parent is gone.

<details><summary>Evidence</summary>

```
worker/src/v1.js:1028-1029 — `const parent = projectFolderId || (await drivePriorProjectParent(access, existingId))` / `|| await driveMasterFolder(access);`. Member-reachable call sites all pass five arguments, never the sixth: 3736 `driveEnsureDeviceFolder(env, access, instanceId, inst.nickname, inst.oauth_folder_id)` (begin), 3767 (upload/start, consent-prompt), 3867 (adopt), 3905 (move). Contrast POST /v1/instances at 3492, which does pass a project: `driveEnsureDeviceFolder(env, access, instance_id, nickname, '', wantProject)`. The members gate at 2473-2482 states the rule this breaks: “a member's file listing has to be ROOTED at that folder rather than walked from the account master”.
```

</details>

### MEDIUM — `/texts/<docId>/move accepts a destination instance in a different project of the same owner` (v1.js:3900)

**The destination instance named in body.to is validated only against the owner's researcher_id, never against ctx.project_id, so a member of one project can push a text into a device belonging to a project they have no grant on.**

**Attack.** Researcher M is a project_member of project A with {"assignTexts":true} and knows an instance id in the owner's project B (for example from a membership in B that has since been deleted). M sends POST /v1/instances/<A-instance-id>/texts/<A-docId>/move {"to":"<B-instance-id>"}. authMember resolves project A from the path instance and passes. The `to` lookup binds researcher_id = ctx.owner.researcher_id, which is the same denormalized owner for every one of that owner's instances in every project, so the B instance resolves; the text folder is then re-parented under B's device folder and delivery tokens are minted for it. A member acting outside their project boundary silently re-homes project A's data into project B.

<details><summary>Evidence</summary>

```
worker/src/v1.js:3890-3903 —
  const ctx = await authMember(request, env, { instance: instanceId }, 'assignTexts');
  ...
  const r = ctx.owner;   // the PROJECT OWNER's row
  const toId = String(body.to || '');
  ...
  const to = await env.DB.prepare('SELECT instance_id, nickname, oauth_folder_id FROM instance WHERE instance_id=? AND researcher_id=? AND revoked=0')
    .bind(toId, r.researcher_id).first();
  if (!from || !to) return j({ error: 'not_found' }, 404, origin, env);
No second authMember({ instance: toId }) call and no comparison of the destination's project_id with ctx.project_id appears anywhere in the route.
```

</details>

---

## ROOT CAUSE 2 — revocation that does not revoke (3 findings)

Removing a member is supposed to take their key grants with it — the whole basis for calling access
"revocable". These are the paths where it does not.

### HIGH — `Removing a member does not revoke Ki grants minted while the instance was in the dual-read window (member_key.project_id` (v1.js:2300)

**POST /v1/researcher/keys stamps member_key.project_id with the sentinel '' whenever instance.project_id is NULL (the dual-read/legacy state), but DELETE /v1/projects/<id>/members deletes grants by project_id — so those rows survive member removal, and GET /v1/researcher/keys, which is scoped only by researcher_id, keeps handing the removed member the wrapped Ki.**

**Attack.** 1. Owner O owns migrated project P (project.drive_folder_id set). O adds member M: POST /v1/projects/P/members {"researcher_id":"M","caps":{"drive":"read"}} -> ok.
2. O creates a device: POST /v1/instances {"nickname":"Village phone"} -> instance I. The INSERT at v1.js:3471 does not include project_id, so instance.project_id is NULL.
3. O grants M the device key: POST /v1/researcher/keys {"instance_id":"I","grants":[{"researcher_id":"O","wrapped_ki":"..."},{"researcher_id":"M","wrapped_ki":"..."}]}. Because inst.project_id is NULL, line 2279 yields proj.project_id = null and line 2300 binds String(null || '') = '' -> both member_key rows are written with project_id ''.
4. Trust breaks; O removes M: DELETE /v1/projects/P/members {"researcher_id":"M"}. Line 2501 runs DELETE FROM member_key WHERE project_id='P' AND researcher_id='M' -> 0 rows. The response is {ok:true, removed:1, grants_removed:0} — i.e. it reports success.
5. M, now a non-member, calls GET /v1/researcher/keys with their own credentials. Line 2314 selects member_key by researcher_id only, so M is still handed wrapped_ki for instance I, unwraps it with their researcher private key, and can decrypt that device's E2EE material for as long as the row exists. Because of the companion finding (instances are created with project_id NULL and are usually never stamped), this is the DEFAULT outcome for devices created after Phase C ships, not an edge case.

<details><summary>Evidence</summary>

```
worker/src/v1.js:2277-2279 — `const proj = inst.project_id ? await env.DB.prepare('SELECT project_id, owner_id FROM project WHERE project_id=?')... : { project_id: null, owner_id: inst.researcher_id };`
worker/src/v1.js:2300 — `).bind(String(proj.project_id || ''), instanceId, String(g.researcher_id), version, String(g.wrapped_ki), r.researcher_id, now));`  (comment at 2292-2299: "'' means \"no project yet\"… ⚠ Phase C must treat '' as unassigned rather than as a project id")
worker/src/v1.js:2501 — `env.DB.prepare('DELETE FROM member_key WHERE project_id=? AND researcher_id=?').bind(projectId, who),` under the comment "REMOVING A MEMBER ALSO DELETES THEIR KEY GRANTS, in the same batch. Without that, \"removed\" would mean \"no longer listed\" while they still hold every wrapped Ki"
worker/src/v1.js:2313-2315 — `'SELECT instance_id, key_version, wrapped_ki FROM member_key WHERE researcher_id=? ...'` — no membership check on the read path, so deletion is the only control.
worker/migrate-projects.sql:53 — `PRIMARY KEY (instance_id, researcher_id, key_version)` — project_id is not part of the row's identity, so nothing else repairs the sentinel.
```

</details>

### HIGH — `Removing a member does not remove their key grants when member_key.project_id is '' (or stale)` (v1.js:2501)

**DELETE /v1/projects/<id>/members deletes member_key rows scoped by project_id, but member_key.project_id is a snapshot written at grant time — it is '' for any instance whose project_id was still NULL (every freshly created device) and stale for any instance that later moved projects — so those grants survive removal and GET /v1/researcher/keys keeps serving the wrapped Ki to the removed member, while the response reports grants_removed:0.**

**Attack.** 1. Owner O owns migrated project P (project.drive_folder_id set). O creates a device: POST /v1/instances {nickname:"Phone"} -> instance D. The INSERT at v1.js:3471 has no project_id column, so instance.project_id is NULL until a later panel estate load stamps it (reconcileProjects only stamps devices whose Drive folder already sits under a project folder, so a device with no uploads stays NULL indefinitely).
2. O adds member M: POST /v1/projects/P/members {researcher_id:M, caps:{"manageDevices":true}} -> 200.
3. O shares D's key: POST /v1/researcher/keys {instance_id:D, grants:[{researcher_id:O,wrapped_ki:...},{researcher_id:M,wrapped_ki:...}]}. Because inst.project_id is NULL, the dual-read fallback at v1.js:2278 yields proj.project_id=null and the row is stored with project_id='' (v1.js:2300).
4. O removes M: DELETE /v1/projects/P/members {researcher_id:M}. The batch deletes member_key WHERE project_id='P' -> matches nothing. Response: {ok:true, removed:1, grants_removed:0}.
5. M calls GET /v1/researcher/keys (v1.js:2310-2318 — no membership check at all, keyed only on researcher_id) and still receives {instance_id:D, wrapped_ki} and can unwrap it with their researcher private key.
Same outcome without the NULL window: grant M a key for device D while D is in project A (row carries project_id=A), then move D to project B (POST /v1/projects/assign, v1.js:3238, or reconcileProjects' correction at v1.js:1814), then remove M from B — the delete scoped by B never touches the row stamped A.

<details><summary>Evidence</summary>

```
v1.js:2499-2506 — `const res = await env.DB.batch([\n  env.DB.prepare('DELETE FROM project_member WHERE project_id=? AND researcher_id=?').bind(projectId, who),\n  env.DB.prepare('DELETE FROM member_key WHERE project_id=? AND researcher_id=?').bind(projectId, who),\n]);` … `return j({ ok: true, removed: gone, grants_removed: keys }, …)`
v1.js:2300 — `).bind(String(proj.project_id || ''), instanceId, String(g.researcher_id), version, String(g.wrapped_ki), r.researcher_id, now));` with the comment above it: "`|| ''` IS LOAD-BEARING … '' means \"no project yet\"".
v1.js:2312-2315 — `SELECT instance_id, key_version, wrapped_ki FROM member_key WHERE researcher_id=? …` (no project or membership predicate).
worker/schema-current.sql:107-116 — `PRIMARY KEY (instance_id, researcher_id, key_version)`; project_id is not part of the key, i.e. it is a label, not identity.
The route's own comment (v1.js:2424-2427) claims the opposite: "REMOVING A MEMBER ALSO DELETES THEIR KEY GRANTS, in the same batch. Without that, 'removed' would mean 'no longer listed' while they still hold every wrapped Ki".
```

</details>

### MEDIUM — `DELETE /v1/researcher/keys cannot revoke a grant once the instance is revoked` (v1.js:2369)

**The new per-grant revoke route resolves authorization through authMember({instance}), whose instance lookup filters `revoked=0`, so after the owner revokes a device the route answers not_found and the owner can no longer withdraw any grant on it — while GET /v1/researcher/keys keeps handing the wrapped Ki to the grantee, and instance revocation itself deletes no member_key rows.**

**Attack.** 1. Owner O grants member M a key on device D: POST /v1/researcher/keys {instance_id:D, grants:[{O,…},{M,…}]} -> stored.
2. The device is lost, so O revokes it: POST /v1/instances/D/revoke -> instance.revoked=1 (v1.js:3966-3968; the batch touches instance and install only — no member_key delete).
3. O tries to withdraw M's key: DELETE /v1/researcher/keys {instance_id:D, researcher_id:M}. authMember's instance branch runs `SELECT project_id, researcher_id FROM instance WHERE instance_id=? AND revoked=0` (v1.js:555), finds no row, so addressedRow stays false, project_id stays '' and the helper returns {ok:false}; the route answers 404 not_found (v1.js:2371). There is no other per-grant delete path.
4. M calls GET /v1/researcher/keys?instance=D and is still served the wrapped Ki. (The members DELETE is not a substitute — it only removes rows whose stored project_id equals the project being managed; see the other finding.)

<details><summary>Evidence</summary>

```
v1.js:2369-2371 — `const ctx = await authMember(request, env, { instance: instanceId }, null);\n    if (!ctx) return j({ error: 'unauthorized' }, 401, origin, env);\n    if (!ctx.ok || !ctx.isOwner) return j({ error: 'not_found' }, 404, origin, env);`
v1.js:555 — `const row = await env.DB.prepare('SELECT project_id, researcher_id FROM instance WHERE instance_id=? AND revoked=0')` — a revoked instance never resolves, and v1.js:594-598 then denies (`if (!project_id) { … return deny; }`).
v1.js:3965-3969 — revoke writes only `UPDATE instance SET revoked=1 …` and `UPDATE install SET revoked=1 …`; no member_key cleanup.
v1.js:2312-2315 — GET /v1/researcher/keys serves rows by researcher_id with no instance-state or membership check.
```

</details>

---

## THE REST (5 findings)

### MEDIUM — `The fallback minter check asks "a member of ANY project of this owner", so removing a member from the project they minte` (v1.js:1894)

**For a member-minted token with no scoped instance (`m` present, `i` absent — which is exactly what /assignment/finish mints for promptFileId, line 3828), redemption asks only whether the minter is still a member of some project owned by tk.r. A member of two of the same owner's projects therefore keeps a live streaming URL after being removed from the project the URL was minted in, contradicting the comment's claim that "the coarse one still closes on removal".**

**Attack.** Owner O has projects A and B; M is a member of both. M calls POST /v1/instances/<instance in A>/texts/<docId>/assignment/finish with a promptFileId, receiving an unscoped token carrying m=M, r=O, e=now+400d. O then removes M from project A entirely (DELETE /v1/projects/A/members), believing that withdrew M's access. M re-fetches the saved promptUrl: tk.i is absent so the fallback query runs, finds M's surviving project_member row for project B (p.owner_id is still O), returns ok, and the file keeps streaming for the remainder of the TTL. The same holds if the owner deletes project A outright while M remains in B.

<details><summary>Evidence</summary>

```
worker/src/v1.js:1882-1897 — `if (tk.m && tk.m !== tk.r) { … ok2 = tk.i ? …  : await env.DB.prepare('SELECT 1 AS ok FROM project_member pm JOIN project p ON p.project_id=pm.project_id ' + 'WHERE pm.researcher_id=? AND p.owner_id=?').bind(tk.m, tk.r).first(); … if (!ok2) return j({ error: 'gone' }, 410, origin, env); }` — the bind pair is (minter, OWNER), never (minter, the project the token was minted in); the token carries no project id to bind against. The unscoped member-minted token that lands here is worker/src/v1.js:3828 `const promptUrl = await mintTextfileUrl(env, url.origin, r.researcher_id, body.promptFileId, '', ttlMs, null, ctx.caller.researcher_id);`
```

</details>

### MEDIUM — `The dual-read/legacy branch never closes: POST /v1/instances creates every instance with project_id NULL and nothing rel` (v1.js:3471)

**authMember's legacy branch is justified by the claim that it is a shrinking migration window ("It closes on its own: every lazy mint removes rows from it, and it is unreachable once none are left"), but instance creation never writes project_id, the lazy backfill only fires for researchers who have NO project row at all, and the lazy device-folder path parents new folders under the account master — so a device created after Phase C can stay in the legacy branch permanently, which both breaks project-scoped member access for it and stamps every grant it receives with the '' sentinel.**

**Attack.** 1. Owner O already has a project row (true for every researcher after the Phase B backfill), so the lazy mint at v1.js:2628-2630 (`if (!mine) await backfillProjectsFor(...)`) never runs again for O.
2. O creates a device from a flat estate or the stray tab, so the panel sends no projectFolderId: POST /v1/instances {"nickname":"phone"} -> the INSERT at 3471 omits project_id; instance.project_id is NULL.
3. The device's folder is created lazily on its first upload: driveEnsureDeviceFolder is called with no projectFolderId and no existing id (v1.js:4130 / 4231), so the parent chain at 1028-1029 resolves to `await driveMasterFolder(access)` — the folder is NOT inside any project folder. (driveProjectFolderFor is not even consulted on the device path, and the appProperty it searches, `flextextProject`, is never written anywhere in the file.)
4. buildDriveEstate therefore reports projectId '' for that device, and reconcileProjects skips it at 1804 (`if (!d.projectId || !d.folderId) continue;`). Repeat GET /v1/researcher/drive-estate as often as you like: instance.project_id stays NULL forever.
5. Consequences, both testable: (a) member M of O's project with manageDevices gets 404 not_found from POST /v1/instances/I/rename, because authMember falls to the legacy branch which consults project_member not at all — access is project-scoped in name only for new devices; (b) every POST /v1/researcher/keys for I writes member_key.project_id = '' (see the companion finding), so grants for it are unrevokable by member removal. The branch that the audit note calls transient and self-closing is the live authorization path for every device created from now on.

<details><summary>Evidence</summary>

```
worker/src/v1.js:3470-3472 — `'INSERT INTO instance (instance_id, researcher_id, type, nickname, desired_blob, desired_rev, revoked, created_at, estate) VALUES (?,?,?,?,?,0,0,?,?)'` — no project_id column, and the route's own comment at 3480-3484 still asserts "Eager creation also makes Drive PARENTAGE the record from birth… no `project_id` written anywhere, nothing to drift."
worker/src/v1.js:588-591 — `if (!project_id) { if (addressedRow && legacyOwner && legacyOwner === caller.researcher_id) { return { ok: true, caller, owner: caller, project_id: '', caps: {}, isOwner: true, legacy: true }; }` with the comment at 585-587: "It closes on its own: every lazy mint removes rows from it, and it is unreachable once none are left."
worker/src/v1.js:2628-2630 — `const mine = await env.DB.prepare('SELECT project_id FROM project WHERE owner_id=? LIMIT 1')… if (!mine) await backfillProjectsFor(env, r, now);` — the only lazy adoption, gated on the researcher having no project at all.
worker/src/v1.js:1028-1029 — `const parent = projectFolderId || (await drivePriorProjectParent(access, existingId)) || await driveMasterFolder(access);`
worker/src/v1.js:1803-1804 — `for (const d of (estate.devices || [])) { if (!d.projectId || !d.folderId) continue;`
worker/src/v1.js:4491-4493 (same defect for crowd, stated outright by the code) — "driveEnsureCrowdFolder resolves its parent from `rec.project_id`, which is always NULL".
```

</details>

### LOW — `The minter check never re-checks the capability the mint required, so a capability downgrade leaves the member's tokens ` (v1.js:1887)

**Minting requires the assignTexts capability (authMember(..., 'assignTexts')), but redemption re-checks bare membership only — no caps are read — so an owner who strips a member's capabilities without removing the membership row leaves every URL that member minted live for the full TTL.**

**Attack.** Owner O adds M to project A with caps {assignTexts:true, drive:'read'}. M mints assignment URLs (up to 400 days). O decides M should no longer assign or read and re-POSTs /v1/projects/A/members with {researcher_id:M, caps:{}} — the handler is `INSERT OR REPLACE INTO project_member …` (worker/src/v1.js:2488), so the row survives with empty caps and every subsequent authMember('assignTexts'/'drive:read') call denies M. M re-fetches the saved audioUrl/flextextUrl: the scoped query below matches on the surviving membership row alone and the file streams.

<details><summary>Evidence</summary>

```
worker/src/v1.js:1886-1889 — `ok2 = tk.i ? await env.DB.prepare('SELECT 1 AS ok FROM project_member pm JOIN instance i ON i.project_id=pm.project_id ' + 'WHERE pm.researcher_id=? AND i.instance_id=?').bind(tk.m, tk.i).first()` — it selects a constant, not `pm.caps`, and nothing downstream parses caps. Compare the mint site's requirement, worker/src/v1.js:3806: `const ctx = await authMember(request, env, { instance: instanceId }, 'assignTexts');`
```

</details>

### LOW — `POST /v1/researcher/keys decides authorization itself and answers 403, making instance ids enumerable` (v1.js:2280)

**This route is project data but bypasses authMember (a second authorization authority, against I1) and distinguishes 'exists but not yours' (403) from 'does not exist' (404), so any authenticated researcher can probe whether an arbitrary instance GUID exists.**

**Attack.** Researcher A (any approved account, member of nothing) POSTs /v1/researcher/keys {instance_id:'<guess>', grants:[{researcher_id:'x', wrapped_ki:'y'}]}. A non-existent id returns 404 not_found (v1.js:2273); an id belonging to another researcher returns 403 forbidden (v1.js:2280). The two responses are distinguishable, which is exactly the oracle the design forbids and which check-project-scoping.sh tests for — but that script only inspects lines matching `if (!ctx.ok`, so this route, having no authMember call, is invisible to it. The route also omits `AND revoked=0` on the instance lookup and skips the not_migrated gate that POST /v1/projects/<id>/members enforces.

<details><summary>Evidence</summary>

```
v1.js:2271-2280 — `const inst = await env.DB.prepare('SELECT instance_id, project_id, researcher_id FROM instance WHERE instance_id=?').bind(instanceId).first();` / `if (!inst) return j({ error: 'not_found' }, 404, origin, env);` ... `if (r.researcher_id !== proj.owner_id) return j({ error: 'forbidden' }, 403, origin, env);`
Contrast v1.js:2371 in the sibling DELETE route, which was converted: `if (!ctx.ok || !ctx.isOwner) return j({ error: 'not_found' }, 404, origin, env);`
check-project-scoping.sh: `if grep 'if (!ctx.ok' "$W" | grep -q '}, 403,'` — the guard only sees authMember call sites.
```

</details>

### LOW — `The assign and uploadDelete commands are gated on manageDevices, bypassing the separately-defined assignTexts capability` (v1.js:3554)

**POST /v1/instances/<id>/command requires only manageDevices, yet the command types it accepts include 'assign', 'delete' and 'uploadDelete' — the text-assignment and text-removal actions that validateCaps models as the distinct assignTexts capability everywhere else.**

**Attack.** The owner adds researcher M to project A with caps {"manageDevices":true} and deliberately withholds assignTexts, intending M to enroll and rename devices but not to hand out or remove texts. M sends POST /v1/instances/<A-instance-id>/command with {"command":{"type":"assign","id":"<docId>","url":"<any url>"}} — accepted, queued with by = M, and delivered to the field device on its next poll. The same call with {"type":"uploadDelete","id":"<docId>"} makes a device upload-and-delete a text. Neither requires the capability the owner withheld.

<details><summary>Evidence</summary>

```
worker/src/v1.js:3554-3564 —
  const ctx = await authMember(request, env, { instance: instanceId }, 'manageDevices');
  ...
  if (cmd.type === 'assign' && !cmd.id) return j({ error: 'assign_needs_id' }, 400, origin, env);     // §F.5
  if (!['assign', 'delete', 'changeSettings', 'triggerUpload', 'uploadDelete', 'setDone'].includes(cmd.type)) return j({ error: 'unknown_command' }, 400, origin, env);
validateCaps (v1.js:497) lists 'assignTexts' as its own capability, and the neighbouring assignment routes gate on it (v1.js:3724, 3748, 3791, 3806, 3855, 3890); the command lane never consults it for the assign/delete/uploadDelete types.
```

</details>

---

## The decided fix — ship device management, defer file sharing

There is a clean line through Root Cause 1: **every dangerous route is one where the member names a
Drive file or text; every safe route works only from D1, or from the device's own stored folder id.**
That splits the capabilities exactly:

| Capability | Reaches Drive by caller-supplied id? | v1 |
|---|---|---|
| `manageDevices` | no — renames use the instance's own `oauth_folder_id` from D1 | ✅ ship |
| `createInvites` | no — D1 only | ✅ ship |
| `assignTexts` | **yes** — every finding above | ❌ refuse for now |
| `drive` | **yes** | ❌ refuse for now |

So `validateCaps` REFUSES `assignTexts` and `drive` — refuses, never silently drops, for the same
reason it already refuses `see` and `wipe`: an owner must be told, not quietly granted nothing.

⚠ And gate the `assign` / `uploadDelete` COMMAND types on assignTexts rather than manageDevices
(the low finding at v1.js:3554), or manageDevices quietly retains an assignment path.

What a member can still do is genuinely useful — run the field team's devices: rename them, push
settings, chase uploads, revoke a lost phone, enrol coworkers. They simply cannot touch the corpus
files yet. This is Seth's own fallback made precise: *"the priority is making the researcher panel
side work and we can drop the Google Drive visibility integration if we need to"* — not dropped,
sequenced.

**The real fix, when the Drive half is built:** VII.1's `drive_object` table, which is now on the
critical path rather than deferred. Note that it needs only `project_id` for authorization since
access is project-scoped (II.D7 clarified) — `instance_id` and `doc_id` become provenance.
