// Throwaway verification for src/engine/isolation.ts. Run: node spikes/isolation/verify.ts
//
// Everything happens in a scratch tree under %TEMP%, never in the user's repos. The point is not
// that the code compiles; it is that the user's checkout is provably unmoved across create, seal and
// discard, that the copy really lacks the uncommitted work, and that every refusal says its sentence.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

say('\n=== logbook lines written ===');
for (const line of readFileSync(config.eventsPath, 'utf8').trim().split('\n')) {
  const e = JSON.parse(line) as Record<string, unknown>;
  if (String(e['kind']).startsWith('workspace')) say(`  ${String(e['kind']).padEnd(24)} ${JSON.stringify({ ...e, ts: undefined })}`);
}

say(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
