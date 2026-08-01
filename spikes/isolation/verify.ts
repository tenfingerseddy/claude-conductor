// Throwaway verification for src/engine/isolation.ts. Run: node spikes/isolation/verify.ts
//
// Everything happens in a scratch tree under %TEMP%, never in the user's repos. The point is not
// that the code compiles; it is that the user's checkout is provably unmoved across create, seal and
// discard, that the copy really lacks the uncommitted work, and that every refusal says its sentence.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(tmpdir(), 'cond-iso');
const STATE = join(ROOT, 'state');
const REPO = join(ROOT, 'my repo (test)');
const REPO_B = join(ROOT, 'detached');
const NOTREPO = join(ROOT, 'plain');
const EMPTY = join(ROOT, 'empty');
const BADNAME = join(ROOT, 'badname');

let failures = 0;
function say(text: string): void {
  process.stdout.write(text + '\n');
}
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  say(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ${detail}` : ''}`);
}

function sh(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}
function shSoft(cwd: string, args: string[]): { code: number | null; out: string; err: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false, windowsHide: true });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}
function sha(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

/** The four measures hazard 1 names. Nothing here may change while Conductor works. */
interface Measure {
  status: string;
  index: string;
  head: string;
  reflog: string;
}
function measure(repo: string): Measure {
  const gitDir = sh(repo, ['rev-parse', '--absolute-git-dir']).trim();
  const indexPath = join(gitDir, 'index');
  const reflogPath = join(gitDir, 'logs', 'HEAD');
  return {
    index: existsSync(indexPath) ? sha(readFileSync(indexPath)) : 'absent',
    reflog: existsSync(reflogPath) ? sha(readFileSync(reflogPath)) : 'absent',
    head: sh(repo, ['rev-parse', 'HEAD']).trim() + ' ' + (shSoft(repo, ['symbolic-ref', 'HEAD']).out.trim() || '(detached)'),
    status: sha(sh(repo, ['status', '--porcelain=v1', '-uall'])),
  };
}
function same(label: string, a: Measure, b: Measure): void {
  check(`${label}: git status --porcelain identical`, a.status === b.status, `${a.status} -> ${b.status}`);
  check(`${label}: .git/index hash identical`, a.index === b.index, `${a.index} -> ${b.index}`);
  check(`${label}: HEAD unmoved`, a.head === b.head, `${a.head} -> ${b.head}`);
  check(`${label}: HEAD reflog identical`, a.reflog === b.reflog, `${a.reflog} -> ${b.reflog}`);
}

/** A throwaway repository with one commit. Returns that commit. */
function newRepo(dir: string, files: Record<string, string> = { 'a.txt': 'one\n' }): string {
  mkdirSync(dir, { recursive: true });
  sh(dir, ['init', '-q', '-b', 'main']);
  sh(dir, ['config', 'user.name', 'Scratch User']);
  sh(dir, ['config', 'user.email', 'scratch@localhost']);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  sh(dir, ['add', '-A']);
  sh(dir, ['commit', '-q', '-m', 'first commit']);
  return sh(dir, ['rev-parse', 'HEAD']).trim();
}

/**
 * git prints worktree paths with forward slashes, and as the true long name. %TEMP% here is the 8.3
 * short name ("KANESN~1"), so a raw string compare against git's output silently never matches. Same
 * trap the module's realPath comment describes, met again in the harness.
 */
function slash(path: string): string {
  let full = path;
  try {
    full = realpathSync.native(path);
  } catch {
    // Not on disk any more (a deliberately deleted worktree): resolve the parent instead.
    try {
      full = join(realpathSync.native(dirname(path)), basename(path));
    } catch {
      full = path;
    }
  }
  return full.replace(/\\/g, '/');
}

// --- scratch world ------------------------------------------------------------

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(REPO, 'sub', 'deep'), { recursive: true });
sh(REPO, ['init', '-q', '-b', 'main']);
sh(REPO, ['config', 'user.name', 'Scratch User']);
sh(REPO, ['config', 'user.email', 'scratch@localhost']);
writeFileSync(join(REPO, '.gitignore'), 'build/\n');
writeFileSync(join(REPO, 'tracked.txt'), 'committed content\n');
writeFileSync(join(REPO, 'sub', 'deep', 'nested.txt'), 'nested committed\n');
sh(REPO, ['add', '-A']);
sh(REPO, ['commit', '-q', '-m', 'first commit']);
const BASE = sh(REPO, ['rev-parse', 'HEAD']).trim();
// Dirty it the three ways that matter.
writeFileSync(join(REPO, 'tracked.txt'), 'HUMAN EDIT not committed\n');
writeFileSync(join(REPO, 'untracked.txt'), 'human untracked\n');
mkdirSync(join(REPO, 'build'), { recursive: true });
writeFileSync(join(REPO, 'build', 'out.bin'), 'ignored build output\n');

mkdirSync(NOTREPO, { recursive: true });
mkdirSync(EMPTY, { recursive: true });
sh(EMPTY, ['init', '-q', '-b', 'main']);

process.env['CONDUCTOR_HOME'] = STATE;
delete process.env['GIT_DIR'];
const { loadConfig } = await import('../../src/config.ts');
const iso = await import('../../src/engine/isolation.ts');
const config = loadConfig();
say(`state root: ${config.stateRoot}`);
say(`scratch repo: ${REPO}`);
say(`base commit: ${BASE}`);

// --- 1. dirty tree, task cwd is a subfolder ------------------------------------

say('\n=== 1. create in a dirty repo, task cwd = sub/deep ===');
measure(REPO); // warm-up: `git status` itself may refresh and rewrite the index
const before = measure(REPO);
const created = iso.createWorkspace(config, { id: 't1', cwd: join(REPO, 'sub', 'deep') });
if (!created.ok) {
  say(`FATAL: createWorkspace refused: ${created.reason}`);
  process.exit(1);
}
const ws = created.workspace;
say(JSON.stringify(ws, null, 2));
say('\n--- describeWorkspace ---');
say(iso.describeWorkspace(ws));
say('---\n');
same('after create', before, measure(REPO));
check('baseCommit is the user HEAD', ws.baseCommit === BASE);
check('baseRef recorded', ws.baseRef === 'refs/heads/main', ws.baseRef ?? 'null');
check('relPath is the subfolder', ws.relPath === 'sub/deep', ws.relPath);
check('workdir is inside the copy', ws.workdir === join(ws.worktreePath, 'sub', 'deep'), ws.workdir);
check('modifiedTracked counted', ws.modifiedTracked === 1, String(ws.modifiedTracked));
check('untracked counted', ws.untracked === 1, String(ws.untracked));

say('\n--- what the copy contains ---');
const copiedTracked = readFileSync(join(ws.worktreePath, 'tracked.txt'), 'utf8');
say(`copy tracked.txt: ${JSON.stringify(copiedTracked)}`);
// Line endings are whatever the repository's own settings produce (core.autocrlf is on for this
// machine's global git), which is the point of hazard 5. Compare content, not bytes.
check('copy does NOT have the uncommitted edit', copiedTracked.replace(/\r/g, '') === 'committed content\n');
check('copy does NOT have the untracked file', !existsSync(join(ws.worktreePath, 'untracked.txt')));
check('copy does NOT have the ignored file', !existsSync(join(ws.worktreePath, 'build', 'out.bin')));
check('copy has the tracked nested file', existsSync(join(ws.worktreePath, 'sub', 'deep', 'nested.txt')));
say(sh(REPO, ['worktree', 'list']));

// hazard 9: the state root guard must still let the daemon start with a worktree below it
say('--- hazard 9: loadConfig with a workspace present ---');
try {
  const again = loadConfig();
  check('loadConfig still succeeds', again.stateRoot === config.stateRoot);
} catch (err) {
  check('loadConfig still succeeds', false, String(err));
}

// --- 2. the task writes, then seal ---------------------------------------------

say('\n=== 2. task writes in the copy, then seal ===');
writeFileSync(join(ws.workdir, 'made-by-task.txt'), 'task output\n');
writeFileSync(join(ws.worktreePath, 'tracked.txt'), 'task edited this\n');
const sealed = iso.sealWorkspace(config, ws);
say(JSON.stringify(sealed, null, 2).slice(0, 600));
check('seal ok', sealed.ok === true, sealed.ok ? '' : sealed.reason);
same('after seal', before, measure(REPO));
if (sealed.ok) {
  const tip = sh(REPO, ['rev-parse', ws.branch]).trim();
  check('branch exists in the user repo', tip.length === 40, tip);
  check('branch tip is the seal commit', tip === sealed.commit, `${tip} vs ${sealed.commit}`);
  check('seal commit parent is the base commit', sh(REPO, ['rev-parse', `${ws.branch}^`]).trim() === BASE);
  say(sh(REPO, ['log', '--oneline', '--name-status', `${BASE}..${ws.branch}`]));
  say(sh(REPO, ['log', '-1', '--format=author=%an <%ae>%ncommitter=%cn <%ce>%nsubject=%s', ws.branch]));
  check('files counted', sealed.files === 2, String(sealed.files));
}

say('--- an unchanged copy seals to nothing ---');
const noop = iso.sealWorkspace(config, ws);
check('second seal makes no empty commit', noop.ok === true && noop.committed === false, JSON.stringify(noop.ok ? { committed: noop.committed } : noop));

// --- 3. findWorkspace, then discard ---------------------------------------------

say('\n=== 3. findWorkspace and discard ===');
const found = iso.findWorkspace(config, 't1');
check('findWorkspace recovers the record', JSON.stringify(found) === JSON.stringify(ws));
const discarded = iso.discardWorkspace(config, 't1');
check('discard ok', discarded.ok === true, discarded.ok ? '' : discarded.reason);
same('after discard', before, measure(REPO));
check('worktree folder is gone', !existsSync(ws.worktreePath));
check('branch is gone', shSoft(REPO, ['show-ref', '--verify', '--quiet', `refs/heads/${ws.branch}`]).code !== 0);
const list = sh(REPO, ['worktree', 'list']);
say(list);
check('worktree list has only the user checkout', list.trim().split('\n').length === 1);
check('findWorkspace no longer returns it', iso.findWorkspace(config, 't1') === null);
say(`the human's tracked.txt is still: ${JSON.stringify(readFileSync(join(REPO, 'tracked.txt'), 'utf8'))}`);
check('the human edit survived everything', readFileSync(join(REPO, 'tracked.txt'), 'utf8') === 'HUMAN EDIT not committed\n');
check('the human untracked file survived', existsSync(join(REPO, 'untracked.txt')));
check('the ignored file survived', existsSync(join(REPO, 'build', 'out.bin')));

// --- 4. detached HEAD -----------------------------------------------------------

say('\n=== 4. detached HEAD repo ===');
mkdirSync(REPO_B, { recursive: true });
sh(REPO_B, ['init', '-q', '-b', 'main']);
sh(REPO_B, ['config', 'user.name', 'Scratch User']);
sh(REPO_B, ['config', 'user.email', 'scratch@localhost']);
writeFileSync(join(REPO_B, 'a.txt'), 'one\n');
sh(REPO_B, ['add', '-A']);
sh(REPO_B, ['commit', '-q', '-m', 'one']);
writeFileSync(join(REPO_B, 'a.txt'), 'two\n');
sh(REPO_B, ['commit', '-q', '-am', 'two']);
sh(REPO_B, ['checkout', '-q', '--detach', 'HEAD']);
measure(REPO_B);
const beforeB = measure(REPO_B);
const madeB = iso.createWorkspace(config, { id: 't2', cwd: REPO_B });
check('create ok on detached HEAD', madeB.ok === true, madeB.ok ? '' : madeB.reason);
if (madeB.ok) {
  check('baseRef is null when detached', madeB.workspace.baseRef === null, String(madeB.workspace.baseRef));
  say(iso.describeWorkspace(madeB.workspace).split('\n').slice(0, 6).join('\n'));
  same('detached, after create', beforeB, measure(REPO_B));
  writeFileSync(join(madeB.workspace.workdir, 'b.txt'), 'from the task\n');
  const sealedB = iso.sealWorkspace(config, madeB.workspace);
  check('seal ok on detached HEAD', sealedB.ok === true, sealedB.ok ? '' : sealedB.reason);
  same('detached, after seal', beforeB, measure(REPO_B));
  const disB = iso.discardWorkspace(config, madeB.workspace);
  check('discard ok on detached HEAD', disB.ok === true, disB.ok ? '' : disB.reason);
  same('detached, after discard', beforeB, measure(REPO_B));
  check('detached repo worktree list clean', sh(REPO_B, ['worktree', 'list']).trim().split('\n').length === 1);
}

// --- 5. every refusal, verbatim ---------------------------------------------------

say('\n=== 5. refusals ===');
function refusal(label: string, id: string, cwd: string): void {
  const r = iso.createWorkspace(config, { id, cwd });
  say(`  ${label}:`);
  say(`    ${r.ok ? 'NO REFUSAL, created a workspace' : r.reason}`);
  if (r.ok) failures++;
}
refusal('path not absolute', 'r1', 'some\\relative\\path');
refusal('does not exist', 'r2', join(REPO, 'nope'));
refusal('not a directory', 'r3', join(REPO, 'tracked.txt'));
refusal('not inside a git repository', 'r4', NOTREPO);
refusal('repository has no commits', 'r5', EMPTY);

sh(REPO, ['branch', 'conductor/task-r6', BASE]);
refusal('branch already exists', 'r6', REPO);
sh(REPO, ['branch', '-D', 'conductor/task-r6']);

mkdirSync(join(STATE, 'workspaces', 'r7'), { recursive: true });
refusal('worktree path already exists', 'r7', REPO);
rmSync(join(STATE, 'workspaces', 'r7'), { recursive: true, force: true });

const longId = 'x'.repeat(200);
refusal('path too long', longId, REPO);

// A hostile task id must come out as a legal refname rather than a refusal or an injection.
for (const id of ['..', 'a b/../../etc', 'HEAD.lock', '-dashes-', 'a~b^c:d?e*f[g\\h']) {
  const b = iso.branchFor(id);
  const legal = shSoft(REPO, ['check-ref-format', `refs/heads/${b}`]).code === 0;
  say(`  id ${JSON.stringify(id)} -> branch ${JSON.stringify(b)}  check-ref-format ${legal ? 'ok' : 'REJECTED'}`);
  check(`sanitised id ${JSON.stringify(id)} is a legal refname`, legal);
}

// git worktree add itself failing. A required smudge filter whose command does not exist makes the
// checkout fail after git has already made the folder, the metadata and the branch, which is exactly
// the half-done state the cleanup path exists for.
mkdirSync(BADNAME, { recursive: true });
sh(BADNAME, ['init', '-q', '-b', 'main']);
sh(BADNAME, ['config', 'user.name', 'Scratch User']);
sh(BADNAME, ['config', 'user.email', 'scratch@localhost']);
writeFileSync(join(BADNAME, '.gitattributes'), '*.txt filter=boom\n');
writeFileSync(join(BADNAME, 'ok.txt'), 'fine\n');
sh(BADNAME, ['add', '-A']);
sh(BADNAME, ['commit', '-q', '-m', 'needs a filter that does not exist']);
sh(BADNAME, ['config', 'filter.boom.smudge', 'conductor-no-such-filter-command']);
sh(BADNAME, ['config', 'filter.boom.required', 'true']);
refusal('git worktree add fails', 'r8', BADNAME);
say(`    litter check: workspaces/r8 exists? ${existsSync(join(STATE, 'workspaces', 'r8'))}`);
say(`    litter check: branch conductor/task-r8 exists? ${shSoft(BADNAME, ['show-ref', '--verify', '--quiet', 'refs/heads/conductor/task-r8']).code === 0}`);
check('no litter after a failed create', !existsSync(join(STATE, 'workspaces', 'r8')));

// --- 6. discard refuses to touch what it cannot account for -------------------------

say('\n=== 6. discard verifies rather than assumes ===');
const made3 = iso.createWorkspace(config, { id: 't3', cwd: REPO });
if (made3.ok) {
  // Somebody checked a different branch out in our worktree. Discard must not delete anything.
  sh(REPO, ['branch', 'someone-elses', BASE]);
  sh(made3.workspace.worktreePath, ['checkout', '-q', 'someone-elses']);
  const bad = iso.discardWorkspace(config, 't3');
  say(`  ${bad.ok ? 'DISCARDED ANYWAY' : bad.reason}`);
  check('discard refuses a worktree it cannot account for', bad.ok === false);
  check('the workspace is still there', existsSync(made3.workspace.worktreePath));
  check('our branch still exists', shSoft(REPO, ['show-ref', '--verify', '--quiet', `refs/heads/${made3.workspace.branch}`]).code === 0);
  // Clean up for real.
  sh(made3.workspace.worktreePath, ['checkout', '-q', made3.workspace.branch]);
  const good = iso.discardWorkspace(config, 't3');
  check('discard works once it adds up again', good.ok === true, good.ok ? '' : good.reason);
  sh(REPO, ['branch', '-D', 'someone-elses']);
}

// ================================================================================
// Sol's M2 isolation review, one reproduction per accepted finding. Each of these fails against
// commit a6effd6 and passes against the fix. The theme of 1 to 4 is one mistake: a name or a path
// is not proof of ownership.
// ================================================================================

// --- 7. finding 1: sealing onto a branch the session switched to ---------------------

say('\n=== 7. finding 1: seal must refuse when the copy is not on our branch ===');
{
  const R = join(ROOT, 'f1');
  const base1 = newRepo(R);
  const made = iso.createWorkspace(config, { id: 'f1', cwd: R });
  check('f1 create ok', made.ok === true, made.ok ? '' : made.reason);
  if (made.ok) {
    const w = made.workspace;
    sh(R, ['branch', 'release', base1]);
    sh(w.worktreePath, ['switch', '-q', 'release']);
    writeFileSync(join(w.worktreePath, 'task-work.txt'), 'task output\n');
    const s = iso.sealWorkspace(config, w);
    say(`  seal said: ${s.ok ? 'SEALED ANYWAY' : s.reason}`);
    check('seal refuses when the copy is on another branch', s.ok === false);
    check('the refusal names what is actually checked out', s.ok === false && s.reason.includes('refs/heads/release'));
    check('the user branch "release" was not advanced', sh(R, ['rev-parse', 'release']).trim() === base1, sh(R, ['rev-parse', 'release']).trim());
    check('the task work is still in the copy', existsSync(join(w.worktreePath, 'task-work.txt')));
    check('nothing was staged in the copy', sh(w.worktreePath, ['status', '--porcelain']).includes('?? task-work.txt'));

    sh(w.worktreePath, ['checkout', '-q', '--detach']);
    const s2 = iso.sealWorkspace(config, w);
    say(`  detached seal said: ${s2.ok ? 'SEALED ANYWAY' : s2.reason}`);
    check('seal refuses on a detached HEAD in the copy', s2.ok === false);
    check('our task branch is still at the base commit', sh(R, ['rev-parse', w.branch]).trim() === base1);
  }
}

// --- 8. finding 2: failed-add cleanup must not delete a branch that is not ours -------

say('\n=== 8. finding 2: failed-add cleanup only deletes a branch still at the base commit ===');
{
  const R = join(ROOT, 'f2');
  const base2 = newRepo(R, { 'ok.txt': 'fine\n', '.gitattributes': '*.txt filter=boom\n' });
  // A commit nobody else references. If cleanup deletes the branch, this work is gone.
  sh(R, ['checkout', '-q', '-b', 'temp']);
  writeFileSync(join(R, 'ok.txt'), 'unique human work\n');
  sh(R, ['commit', '-q', '-am', 'unique human work']);
  const unique = sh(R, ['rev-parse', 'HEAD']).trim();
  sh(R, ['checkout', '-q', 'main']);
  sh(R, ['branch', '-D', 'temp']);

  // A stray worktree whose folder is gone: unscoped `git worktree prune` would deregister it.
  const stray2 = join(ROOT, 'stray-add');
  sh(R, ['worktree', 'add', '--detach', '-q', stray2, base2]);
  rmSync(stray2, { recursive: true, force: true });

  // Deterministic stand-in for Sol's race. A required smudge filter runs inside `git worktree add`,
  // points refs/heads/conductor/task-f2 at the unique commit, then fails the checkout. The state
  // cleanup then sees is exactly Sol's: our add failed and a branch of that name exists whose tip is
  // not the base commit. Only how it got there differs; cleanup cannot tell the difference anyway.
  const boom = join(ROOT, 'boom.sh');
  writeFileSync(
    boom,
    '#!/bin/sh\n' +
      `mkdir -p "${slash(R)}/.git/refs/heads/conductor"\n` +
      `printf '%s\\n' "${unique}" > "${slash(R)}/.git/refs/heads/conductor/task-f2"\n` +
      'exit 1\n',
  );
  sh(R, ['config', 'filter.boom.smudge', `sh "${slash(boom)}"`]);
  sh(R, ['config', 'filter.boom.required', 'true']);

  const r = iso.createWorkspace(config, { id: 'f2', cwd: R });
  say(`  create said: ${r.ok ? 'CREATED' : r.reason}`);
  check('create refuses when worktree add fails', r.ok === false);
  const tip = shSoft(R, ['rev-parse', '--verify', '--quiet', 'refs/heads/conductor/task-f2']).out.trim();
  say(`  branch conductor/task-f2 tip after cleanup: ${tip || '(deleted)'}  unique=${unique}`);
  check('the branch that is not at the base commit survives cleanup', tip === unique, tip || '(deleted)');
  check('the refusal names the branch it left alone', r.ok === false && r.reason.includes('conductor/task-f2'));
  const listed2 = sh(R, ['worktree', 'list', '--porcelain']);
  check('an unrelated stray worktree is still registered after a failed add', listed2.includes(slash(stray2)), listed2.replace(/\n/g, ' | '));
}

// --- 9. finding 3: discard must not delete a branch that merely shares the name -------

say('\n=== 9. finding 3: discard leaves a same-named branch it cannot account for ===');
{
  const R = join(ROOT, 'f3');
  newRepo(R);
  const made = iso.createWorkspace(config, { id: 'f3', cwd: R });
  check('f3 create ok', made.ok === true, made.ok ? '' : made.reason);
  if (made.ok) {
    const w = made.workspace;
    // The worktree and the branch go away outside Conductor.
    sh(R, ['worktree', 'remove', '--force', w.worktreePath]);
    sh(R, ['branch', '-D', w.branch]);
    // Later, a human makes an independent branch that happens to reuse the name.
    writeFileSync(join(R, 'a.txt'), 'human work\n');
    sh(R, ['commit', '-q', '-am', 'human work']);
    const human = sh(R, ['rev-parse', 'HEAD']).trim();
    sh(R, ['branch', w.branch, human]);

    const d = iso.discardWorkspace(config, 'f3');
    say(`  discard said: ${d.ok ? `ok${'note' in d && d.note ? ` (${d.note})` : ''}` : d.reason}`);
    const still = shSoft(R, ['rev-parse', '--verify', '--quiet', `refs/heads/${w.branch}`]).out.trim();
    check("the human's same-named branch survives discard", still === human, still || '(deleted)');
    check('discard says it left that branch alone', d.ok === true && typeof d.note === 'string' && d.note.includes(w.branch), d.ok ? String(d.note) : d.reason);
  }
}

// --- 10. finding 4: a detached worktree at our path is not ours -----------------------

say('\n=== 10. finding 4: a detached worktree at the recorded path is not ours ===');
{
  const R = join(ROOT, 'f4');
  const base4 = newRepo(R);
  const made = iso.createWorkspace(config, { id: 'f4', cwd: R });
  check('f4 create ok', made.ok === true, made.ok ? '' : made.reason);
  if (made.ok) {
    const w = made.workspace;
    sh(R, ['worktree', 'remove', '--force', w.worktreePath]);
    sh(R, ['worktree', 'add', '--detach', '-q', w.worktreePath, base4]);
    const humanFile = join(w.worktreePath, 'human-uncommitted.txt');
    writeFileSync(humanFile, 'not committed anywhere\n');

    const d = iso.discardWorkspace(config, 'f4');
    say(`  discard said: ${d.ok ? 'DISCARDED ANYWAY' : d.reason}`);
    check('discard refuses a detached worktree at our path', d.ok === false);
    check('the refusal says a detached HEAD is there', d.ok === false && /detached/i.test(d.reason), d.ok ? '' : d.reason);
    check("the human's uncommitted file was not destroyed", existsSync(humanFile));
    check('the replacement worktree is still registered', sh(R, ['worktree', 'list', '--porcelain']).includes(slash(w.worktreePath)));
    check('the branch was left alone', shSoft(R, ['show-ref', '--verify', '--quiet', `refs/heads/${w.branch}`]).code === 0);
  }
}

// --- 11. finding 5: a read that writes ------------------------------------------------

say('\n=== 11. finding 5: createWorkspace must not rewrite the primary .git/index ===');
{
  const R = join(ROOT, 'f5');
  newRepo(R, { 'a.txt': 'one\n', 'b.txt': 'two\n' });
  const indexPath = join(R, '.git', 'index');
  sh(R, ['status', '--porcelain']); // settle the stat data
  sh(R, ['status', '--porcelain']);
  const settled = sha(readFileSync(indexPath));
  // Touched, not changed: same bytes, new mtime. This is what makes git want to refresh the index.
  const later = new Date(Date.now() + 4000);
  utimesSync(join(R, 'a.txt'), later, later);
  const beforeIndex = sha(readFileSync(indexPath));
  check('touching a file does not itself rewrite the index', settled === beforeIndex, `${settled} -> ${beforeIndex}`);
  const made = iso.createWorkspace(config, { id: 'f5', cwd: R });
  const afterIndex = sha(readFileSync(indexPath));
  say(`  .git/index ${beforeIndex} -> ${afterIndex}`);
  check('f5 create ok', made.ok === true, made.ok ? '' : made.reason);
  check('the primary .git/index is byte-identical across create', beforeIndex === afterIndex, `${beforeIndex} -> ${afterIndex}`);
  if (made.ok) {
    const d = iso.discardWorkspace(config, 'f5');
    check('f5 discard ok', d.ok === true, d.ok ? '' : d.reason);
    check('the primary .git/index is byte-identical across discard too', sha(readFileSync(indexPath)) === beforeIndex);
  }
}

// --- 12. finding 7: unscoped `git worktree prune` is not ours to run -------------------

say('\n=== 12. finding 7: discard must not prune unrelated worktree metadata ===');
{
  const R = join(ROOT, 'f7');
  const base7 = newRepo(R);
  const stray = join(ROOT, 'stray-worktree');
  sh(R, ['worktree', 'add', '--detach', '-q', stray, base7]);
  rmSync(stray, { recursive: true, force: true }); // the disconnected drive
  check('the stray worktree is registered before we start', sh(R, ['worktree', 'list', '--porcelain']).includes(slash(stray)));
  const made = iso.createWorkspace(config, { id: 'f7', cwd: R });
  check('f7 create ok', made.ok === true, made.ok ? '' : made.reason);
  if (made.ok) {
    const d = iso.discardWorkspace(config, 'f7');
    check('f7 discard ok', d.ok === true, d.ok ? '' : d.reason);
    const listed = sh(R, ['worktree', 'list', '--porcelain']);
    say(`  ${listed.replace(/\n/g, ' | ')}`);
    check("the unrelated worktree's metadata survives discard", listed.includes(slash(stray)));
    check('our own worktree is no longer registered', !listed.includes(slash(made.workspace.worktreePath)));
  }
}

// --- 13. finding 8: zero is not the same as unknown ------------------------------------

say('\n=== 13. finding 8: a failed status must not read as a clean folder ===');
{
  const R = join(ROOT, 'f8');
  newRepo(R);
  writeFileSync(join(R, '.git', 'index'), 'this is not a git index');
  const statusFails = shSoft(R, ['status', '--porcelain']);
  say(`  git status exit ${statusFails.code}: ${(statusFails.err || statusFails.out).trim().split('\n')[0]}`);
  check('git status really does fail with a corrupt index', statusFails.code !== 0);
  const made = iso.createWorkspace(config, { id: 'f8', cwd: R });
  say(`  create said: ${made.ok ? 'ok' : made.reason}`);
  if (made.ok) {
    const w = made.workspace;
    say(`  counts: modifiedTracked=${JSON.stringify(w.modifiedTracked)} untracked=${JSON.stringify(w.untracked)}`);
    const text = iso.describeWorkspace(w);
    say(text);
    check('counts are null, not zero, when git status failed', w.modifiedTracked === null && w.untracked === null);
    check('the description never claims the copy matches the folder', !text.includes('matches what you are looking at'));
    check('the description says it could not tell', text.includes('could not tell'));
  } else {
    check('create still works when the primary index is corrupt', false, made.reason);
  }
}

say('--- finding 8, the stated limit rather than a fix ---');
{
  const R = join(ROOT, 'f8b');
  newRepo(R);
  sh(R, ['update-index', '--assume-unchanged', 'a.txt']);
  writeFileSync(join(R, 'a.txt'), 'changed behind git back\n');
  say(`  git status with assume-unchanged: ${JSON.stringify(sh(R, ['status', '--porcelain']))}`);
  const made = iso.createWorkspace(config, { id: 'f8b', cwd: R });
  check('f8b create ok', made.ok === true, made.ok ? '' : made.reason);
  if (made.ok) {
    const text = iso.describeWorkspace(made.workspace);
    check('the description states the assume-unchanged limit out loud', text.includes('assume-unchanged'), text.split('\n').slice(6, 10).join(' | '));
  }
}

// --- 14. finding 9: the label can be wrong even though the copy never is ---------------

say('\n=== 14. finding 9: HEAD moving during creation is recorded ===');
{
  const R = join(ROOT, 'f9');
  const base9 = newRepo(R);
  sh(R, ['branch', 'other', base9]);
  // The human switches branch while the copy is being made. A post-checkout hook is the only way to
  // hit that window deterministically; it fires inside `git worktree add`, once.
  const hook = join(R, '.git', 'hooks', 'post-checkout');
  writeFileSync(
    hook,
    '#!/bin/sh\n' +
      `test -f "${slash(ROOT)}/f9-fired" && exit 0\n` +
      `: > "${slash(ROOT)}/f9-fired"\n` +
      `git --git-dir="${slash(R)}/.git" symbolic-ref HEAD refs/heads/other\n`,
  );
  const made = iso.createWorkspace(config, { id: 'f9', cwd: R });
  check('f9 create ok', made.ok === true, made.ok ? '' : made.reason);
  say(`  the user's HEAD is now: ${shSoft(R, ['symbolic-ref', 'HEAD']).out.trim()}`);
  if (made.ok) {
    const w = made.workspace;
    check('the hook really did move HEAD', shSoft(R, ['symbolic-ref', 'HEAD']).out.trim() === 'refs/heads/other');
    check('the record says HEAD moved during creation', w.headMovedDuringCreate === true, JSON.stringify(w.headMovedDuringCreate));
    check('the copy is still made from the recorded commit', w.baseCommit === base9);
    const text = iso.describeWorkspace(w);
    check('the description says the folder moved while the copy was being made', text.includes('moved while the copy was being made'), text.split('\n').slice(-8).join(' | '));
  }
}

// --- 15. finding 6, rejected: belt and braces on a state root inside the checkout -------

say('\n=== 15. finding 6 (rejected by triage): the one-line second guard ===');
{
  const R = join(ROOT, 'f6');
  newRepo(R);
  const inside = join(R, '.conductor-state');
  const rigged = { ...config, stateRoot: inside };
  const r = iso.createWorkspace(rigged, { id: 'f6', cwd: R });
  say(`  create said: ${r.ok ? 'CREATED INSIDE THE REPO' : r.reason}`);
  check('createWorkspace refuses a workspace path inside the repository', r.ok === false);
  check('nothing was created inside the user folder', !existsSync(inside));
  check("the user's folder is still clean", sh(R, ['status', '--porcelain']).trim() === '');
  // The primary guard is loadConfig, which refuses the state root before the daemon starts at all.
  process.env['CONDUCTOR_HOME'] = inside;
  let threw = '';
  try {
    loadConfig();
  } catch (err) {
    threw = String(err);
  }
  process.env['CONDUCTOR_HOME'] = STATE;
  say(`  loadConfig said: ${threw || 'NOTHING, it accepted a state root inside a checkout'}`);
  check('loadConfig is the primary guard and refuses first', threw.includes('inside the git checkout'));
}

// ================================================================================
// Sol's confirmation pass after the first fix round. Five findings closed, four partial, one new
// defect. These are the reproductions for the second round; 17, 18 and 19 fail against commit
// f1ad8bd and pass against the fix.
// ================================================================================

// --- 16. residuals 2 and 3: deleting a branch is now compare-and-delete ----------------

say('\n=== 16. residuals 2 and 3: update-ref -d is a compare-and-delete ===');
{
  const R = join(ROOT, 'r23');
  const base = newRepo(R);
  writeFileSync(join(R, 'a.txt'), 'second\n');
  sh(R, ['commit', '-q', '-am', 'second']);
  const moved = sh(R, ['rev-parse', 'HEAD']).trim();
  sh(R, ['branch', 'demo', moved]);

  // The primitive itself. This is what closes the gap between "the branch is still the one we
  // confirmed" and "delete it": git takes the ref lock and checks the tip inside that lock.
  const wrong = shSoft(R, ['update-ref', '-d', 'refs/heads/demo', base]);
  say(`  wrong expected tip: exit ${wrong.code}  ${wrong.err.trim()}`);
  check('update-ref -d refuses when the expected tip is wrong', wrong.code !== 0);
  check('the branch survives that refusal', shSoft(R, ['rev-parse', '--verify', '--quiet', 'refs/heads/demo']).out.trim() === moved);

  const right = shSoft(R, ['update-ref', '-d', 'refs/heads/demo', moved]);
  say(`  right expected tip: exit ${right.code}`);
  check('update-ref -d deletes when the expected tip matches', right.code === 0);
  check('the branch is gone afterwards', shSoft(R, ['rev-parse', '--verify', '--quiet', 'refs/heads/demo']).out.trim() === '');
  check('its reflog went with it', !existsSync(join(R, '.git', 'logs', 'refs', 'heads', 'demo')));

  // And the module really uses it. The race window this closes is sub-second and inside a single
  // `git worktree remove`, so there is no hook to fire in it and no way to stage it from outside;
  // what can be pinned is that no unconditional `branch -D` is left anywhere in the file.
  const source = readFileSync(fileURLToPath(new URL('../../src/engine/isolation.ts', import.meta.url)), 'utf8');
  check('isolation.ts no longer runs an unconditional branch -D', !/'branch',\s*'-D'/.test(source));
  check('isolation.ts deletes branches with update-ref -d', (source.match(/'update-ref',\s*'-d'/g) ?? []).length === 2);
}

// --- 17. residual 6: a junction under the state root must not reach into the repo -------

say('\n=== 17. residual 6: a junction at <stateRoot>/workspaces cannot smuggle the copy into the repo ===');
{
  const R = join(ROOT, 'r6');
  newRepo(R);
  const stateInside = join(ROOT, 'r6-state');
  const target = join(R, 'hidden');
  mkdirSync(stateInside, { recursive: true });
  mkdirSync(target, { recursive: true });
  // A junction, not a symlink: Windows allows these without administrator rights, which is exactly
  // why this is a real bypass rather than a theoretical one.
  symlinkSync(target, join(stateInside, 'workspaces'), 'junction');
  say(`  ${join(stateInside, 'workspaces')} -> ${realpathSync.native(join(stateInside, 'workspaces'))}`);
  check('the junction really resolves inside the repository', realpathSync.native(join(stateInside, 'workspaces')).startsWith(realpathSync.native(R)));

  const rigged = { ...config, stateRoot: stateInside };
  const r = iso.createWorkspace(rigged, { id: 'r6', cwd: R });
  say(`  create said: ${r.ok ? 'CREATED THROUGH THE JUNCTION' : r.reason}`);
  check('createWorkspace refuses a workspace path that resolves inside the repository', r.ok === false);
  check('the refusal says the path is inside the repository', r.ok === false && r.reason.includes('is inside the repository'));
  check('nothing was written through the junction', !existsSync(join(target, 'r6')));
  check("the user's folder is still clean", sh(R, ['status', '--porcelain']).trim() === '');
  check('no branch was created', shSoft(R, ['show-ref', '--verify', '--quiet', 'refs/heads/conductor/task-r6']).code !== 0);
  check('no worktree was registered', sh(R, ['worktree', 'list', '--porcelain']).trim().split('\n\n').length === 1);
}

// --- 18. the new defect: a failed `git worktree list` is not an empty one ----------------

say('\n=== 18. new defect: git failing to answer must not read as "there is nothing there" ===');
{
  const R = join(ROOT, 'r10');
  newRepo(R);
  const made = iso.createWorkspace(config, { id: 'r10', cwd: R });
  check('r10 create ok', made.ok === true, made.ok ? '' : made.reason);
  if (made.ok) {
    const w = made.workspace;
    // The copy's folder goes away outside Conductor, so the recorded path is absent...
    rmSync(w.worktreePath, { recursive: true, force: true });
    // ...and the repository is then in a state where git cannot answer any question about it.
    writeFileSync(join(R, '.git', 'config'), readFileSync(join(R, '.git', 'config'), 'utf8') + '[core\nnot a valid line\n');
    const listFails = shSoft(R, ['worktree', 'list', '--porcelain']);
    say(`  git worktree list exit ${listFails.code}: ${(listFails.err || listFails.out).trim().split('\n')[0]}`);
    check('git worktree list really does fail here', listFails.code !== 0);

    const d = iso.discardWorkspace(config, 'r10');
    say(`  discard said: ${d.ok ? `ok${'note' in d && d.note ? ` (${d.note})` : ''}` : d.reason}`);
    check('discard does not report success over a repository git could not read', d.ok === false);
    check('the refusal says git could not read the metadata', d.ok === false && d.reason.includes('could not read the worktree metadata'));
    check('the workspace is still findable, so a later discard can retry', iso.findWorkspace(config, 'r10') !== null);
  }
}

// --- 19. the false removal sentence -------------------------------------------------------

say('\n=== 19. a folder at the recorded path that git does not register: no removal ran ===');
{
  const R = join(ROOT, 'r11');
  newRepo(R);
  const made = iso.createWorkspace(config, { id: 'r11', cwd: R });
  check('r11 create ok', made.ok === true, made.ok ? '' : made.reason);
  if (made.ok) {
    const w = made.workspace;
    // Removed properly outside Conductor, so no metadata is left...
    sh(R, ['worktree', 'remove', '--force', w.worktreePath]);
    // ...and then somebody puts an ordinary folder of their own back at that path.
    mkdirSync(w.worktreePath, { recursive: true });
    const theirs = join(w.worktreePath, 'somebody-elses-notes.txt');
    writeFileSync(theirs, 'not conductor work\n');

    const d = iso.discardWorkspace(config, 'r11');
    say(`  discard said: ${d.ok ? 'DISCARDED' : d.reason}`);
    check('discard refuses rather than claiming a removal', d.ok === false);
    check('it does not claim git reported a removal', d.ok === false && !d.reason.includes('git reported the worktree removed'));
    check('it says git does not register a worktree there', d.ok === false && d.reason.includes('git does not register a'));
    check("the stranger's folder was not touched", existsSync(theirs));
    check('the branch was left alone', shSoft(R, ['show-ref', '--verify', '--quiet', `refs/heads/${w.branch}`]).code === 0);
  }
}

// --- 20. residual 9: the labels claim only what was observed --------------------------------

say('\n=== 20. residual 9: dirty-count wording is past tense, anchored to creation time ===');
{
  const Rd = join(ROOT, 'r9d');
  newRepo(Rd);
  writeFileSync(join(Rd, 'a.txt'), 'edited\n');
  writeFileSync(join(Rd, 'new.txt'), 'untracked\n');
  const dirty = iso.createWorkspace(config, { id: 'r9d', cwd: Rd });
  check('r9d create ok', dirty.ok === true, dirty.ok ? '' : dirty.reason);
  if (dirty.ok) {
    const text = iso.describeWorkspace(dirty.workspace);
    say(text.split('\n').slice(6, 10).map((l) => `  |${l}`).join('\n'));
    check('the dirty wording is past tense', text.includes('did not contain') && text.includes('at that moment'));
    check('the dirty wording no longer says "does NOT contain"', !text.includes('does NOT contain'));
  }

  const Rc = join(ROOT, 'r9c');
  newRepo(Rc);
  const clean = iso.createWorkspace(config, { id: 'r9c', cwd: Rc });
  check('r9c create ok', clean.ok === true, clean.ok ? '' : clean.reason);
  if (clean.ok) {
    const text = iso.describeWorkspace(clean.workspace);
    say(text.split('\n').slice(6, 10).map((l) => `  |${l}`).join('\n'));
    check('the clean wording is anchored to creation time', text.includes('had no uncommitted changes when the copy was made'));
    check('it no longer claims the copy matches what the user is looking at now', !text.includes('matches what you are looking at'));
    check('it says changes since then are not in the copy', text.includes('not in the copy'));
  }
}

say('\n=== logbook lines written ===');
for (const line of readFileSync(config.eventsPath, 'utf8').trim().split('\n')) {
  const e = JSON.parse(line) as Record<string, unknown>;
  if (String(e['kind']).startsWith('workspace')) say(`  ${String(e['kind']).padEnd(24)} ${JSON.stringify({ ...e, ts: undefined })}`);
}

say(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
