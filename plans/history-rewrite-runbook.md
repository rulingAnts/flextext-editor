# Runbook — removing a class of content from published history

**Status: PREPARED, NOT RUN.** Written 2026-08-19 so that when it is done it is a checklist rather
than an improvisation. Seth's decision: do it **deliberately, and not during a release.**

Generic on purpose. It applies to anything that must not remain in a public history — a leaked
credential, personal data, or wording that misdescribes the project. **The specific match list is
never duplicated here.** For the wording case it is the list inside `test/threat-language.test.mjs`,
which is deliberately terse; use that file as the single source so the runbook and the test cannot
drift apart, and so this document does not restate what it exists to remove.

⚠ **Correct the working tree FIRST, in an ordinary commit, and let it settle.** That is already done
for the current case. It matters for two reasons: the fix is what protects going forward regardless
of whether the rewrite ever happens, and it makes the rewrite's most important verification possible
(step 5b).

---

## 0. Scope — establish it before anything else

Measure, do not assume:

```sh
git log --all --oneline -S'<term>' -i            # commits whose DIFF touched it
git log --all --oneline --grep='<term>' -i       # commits whose MESSAGE carries it
git log --all --oneline -S'<term>' -i -- <path>  # per path, to bound the blast radius
```

⚠ **Commit MESSAGES are usually the most explicit artifact and the one people forget.** A rewrite
that fixes file contents and leaves messages is not a rewrite.

**For the current case (measured 2026-08-19):** 9 commit messages, contents from 2026-07-28 onward,
and — checked — **nothing in `satellites/` or `paragraph-analysis/` ever carried it**, so the three
GitHub Pages mirror repos and the PAT Worker are out of scope. One repository:
`rulingAnts/flextext-editor`.

## 1. Preconditions

- [ ] No release in flight. `productionWeb` quiet, no Cloudflare build running, `sync-satellites`
      not mid-run.
- [ ] Every branch and tag pushed, so the backup captures everything.
- [ ] Seth present and expecting it — this force-pushes the branch that serves the live field site.
- [ ] `git filter-repo` installed. **Do NOT use `git filter-branch`** — deprecated, far slower, and
      it silently mangles edge cases this repository has (empty commits, merges).

## 2. Back up first, offline

```sh
git clone --mirror git@github.com:rulingAnts/flextext-editor.git backup-$(date +%F).git
```

Keep it off the machine doing the rewrite. This is the only undo.

## 3. Rewrite on a fresh mirror clone

`filter-repo` insists on a fresh clone, which is a feature — it cannot corrupt a working repo.

```sh
git clone --mirror git@github.com:rulingAnts/flextext-editor.git rewrite.git
cd rewrite.git
git filter-repo --replace-text ../replacements.txt --message-callback "$(cat ../msg.py)"
```

`--mirror` is what makes it cover **all** refs and tags rather than one branch.

`replacements.txt` is `literal:<old>==><new>` lines, built from the test's match list — generate it,
do not hand-copy, or the two drift. `msg.py` applies the same substitutions to commit messages.
⚠ Substitute to a neutral replacement, never to a marker like `***REMOVED***`: a redaction marker
advertises that something was removed and defeats the purpose.

## 4. If a rewrite is impossible or disproportionate

The alternative with precedent in this repository: **a fresh snapshot.** `worker/` was imported on
2026-07-23 as one, explicitly *"so nothing that may lurk in old commits was published."* At repo
level that means a new repository with a single initial commit of the current tree. It is the only
option that leaves nothing to garbage-collect — at the cost of all history, issues, stars, every
existing clone, and the Cloudflare/Pages git integrations.

## 5. Verify BEFORE pushing — this is the step that makes it safe

- [ ] **(a) The content is gone from every ref, including messages:**
  ```sh
  git log --all -p | grep -i -c '<term>'          # expect 0
  git log --all --format=%B | grep -i -c '<term>' # expect 0
  ```
- [ ] **(b) ⚠ THE TREES ARE IDENTICAL.** Because the working tree was already corrected in step 0,
      a correct rewrite changes *history* and not *content*. For each branch:
  ```sh
  git diff <old-tip-sha> <new-tip-sha>            # expect EMPTY
  ```
  **A non-empty diff means the rewrite altered something it should not have. Stop.** This single
  check catches the class of error that would otherwise ship a mangled tree to the live site.
- [ ] **(c) Topology preserved:** same branches, same tags, comparable commit count.
- [ ] **(d)** Run the full suite against each rewritten tip: `./check-native-containment.sh`
      (which runs `test/*.test.mjs`), plus `./check-secrets.sh`.

## 6. Push — ordering and side effects

- [ ] `staging` first. Confirm it lands and the Cloudflare build is green.
- [ ] `main` next. Wait for its build; **never fire two pushes for the same Worker within a couple
      of minutes** (CLAUDE.md — they cancel each other).
- [ ] `productionWeb` last, and know what it triggers: **GitHub Pages rebuilds the live field site,
      and `sync-satellites.yml` republishes all three mirrors.** Both are normal, but a rewrite is
      not the moment to discover them.
- [ ] The pre-push hook blocks production-branch pushes — `ALLOW_MAIN_PUSH=1` only after Seth has
      approved that specific push. It also blocks workflow pushes (`ALLOW_WORKFLOW_PUSH=1`).
- [ ] Force-push is `--force-with-lease` where possible; a mirror push is
      `git push --mirror --force`, which is exactly as blunt as it sounds — hence step 2.

## 7. After — without this the rewrite is cosmetic

- [ ] ⚠ **Ask GitHub Support to garbage-collect unreachable objects.** Until they do, every old
      commit remains fetchable **by SHA** on GitHub even though no ref points at it, and those SHAs
      are in PR pages, Actions logs and anyone's notes. **This is the step that decides whether the
      rewrite achieved anything.**
- [ ] **Forks retain everything**, and nothing you do to your repository changes that. Check whether
      any exist; if they do, that is a conversation, not a command.
- [ ] Every existing clone still holds the old history. Anyone with one must re-clone.
- [ ] Re-check the Cloudflare git integrations and the Pages build after the force-push; a rewritten
      history can leave them pointing at a SHA that no longer exists.
- [ ] Re-run `test/threat-language.test.mjs` on the pushed result.

## 8. Judgement call to make consciously, not by default

⚠ **A rewrite is itself conspicuous.** Force-pushing weeks of history with altered messages is more
visible to anyone watching the repository than the original text was — it reads as *"something was
removed."* Weigh that against the benefit, decide deliberately, and prefer a quiet moment. It is the
reason "not during a release" is in the title and not a footnote.
