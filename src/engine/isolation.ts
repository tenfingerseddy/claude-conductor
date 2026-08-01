// Isolation. Each task works in its own copy of the project, never in the folder the human watches.
//
// This replaces checkpoint-and-undo (src/engine/checkpoint.ts), which two rounds of adversarial
// review killed for a structural reason rather than a fixable one: comparing a live working folder
// before and after a task proves *timing*, not *authorship*. An edit the human makes while a task
// runs is indistinguishable from the task's own, so undo would destroy the human's work and report
// it as cleanup.
//
// Isolation replaces that inference with a fact. The task gets a git worktree of the user's repo,
// created from a named commit, on its own branch, living under <stateRoot>/workspaces/<taskId>/.
// Nobody else writes there, so everything in it is the task's. The output is a branch to review and
// merge. Undo is discarding the worktree and deleting the branch: total, instant, exact.
//
// The hard constraint is the same as before and is verified rather than assumed: **the user's
// checkout does not move.** `git worktree add` writes `.git/worktrees/<name>/` metadata and one new
// ref under refs/heads/. That is all it may do. `git status --porcelain`, the `.git/index` bytes,
// HEAD and the HEAD reflog are byte-identical across create, seal and discard.
//
// Two rules follow from that constraint and both were learned from Sol's review of this file.
//
// A read must not write. `git status` performs an optional index refresh and rewrites the primary
// `.git/index` when a tracked file's timestamp has moved, which broke the invariant above from
// inside the code that measures it. Every read-only call here goes through `gitRead`, which passes
// `--no-optional-locks`. Only worktree add, worktree remove, add, commit and update-ref -d write.
//
// A name or a path is not proof of ownership. A branch called conductor/task-t1 may be a human's; a
// folder at the recorded worktree path may be a human's replacement. Nothing is removed unless git's
// own metadata confirms it is ours, and where that cannot be confirmed the thing is left alone and
// the returned sentence says so.
//
// What the copy lacks, said out loud rather than discovered later: a fresh worktree holds only what
// the base commit tracks. Uncommitted work in the human's folder is not in it, untracked files are
// not in it, and ignored files (local config, build output, node_modules) are not in it. The counts
// are measured at creation time, stored in the record, logged, and printed by describeWorkspace.
//
// Stated limit on those counts: files marked `assume-unchanged` or `skip-worktree` are invisible to
// `git status` by design, so edits to them are never counted and never mentioned. That is git's
// contract, not something this file can work around, and describeWorkspace says it out loud. A count
// that could not be taken at all is null, never zero: "could not tell" must never read as "clean".

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Config } from '../config.ts';
import { logEvent } from '../state/logbook.ts';

/**
 * Branches are deliberately visible, unlike the old checkpoint refs under refs/conductor/.
 * A task's output is meant to be read: `git log conductor/task-x`, `git diff main...conductor/task-x`,
 * `git merge conductor/task-x` all work with no Conductor-specific knowledge.
 */
export const BRANCH_PREFIX = 'conductor/task-';

/** Identity for the seal commit. A local label, never the user's git identity or an email. */
const COMMIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Conductor',
  GIT_AUTHOR_EMAIL: 'conductor@localhost',
  GIT_COMMITTER_NAME: 'Conductor',
  GIT_COMMITTER_EMAIL: 'conductor@localhost',
};

/**
 * Windows MAX_PATH is 260 and the state root already contains spaces and parentheses. Files inside
 * a repository routinely add another eighty characters, so a worktree root past this is a failure
 * waiting to happen halfway through a checkout. Refuse up front with a number rather than let git
 * fail on file 900 of 1200.
 */
const MAX_WORKTREE_ROOT_LENGTH = 150;

export interface Workspace {
  taskId: string;
  /** The user's repository, resolved through realPath. Never written to except by git worktree. */
  repoRoot: string;
  /** The commit the copy was made from. Named, so "what did this start from" is never a guess. */
  baseCommit: string;
  /** Where the user's HEAD pointed, e.g. refs/heads/main. Null when their HEAD was detached. */
  baseRef: string | null;
  /** Short branch name, e.g. conductor/task-t1. Lives under refs/heads so git tooling sees it. */
  branch: string;
  /** The worktree root, resolved through realPath. */
  worktreePath: string;
  /** The task cwd relative to the repo root, '/'-separated. Empty string when it is the root. */
  relPath: string;
  /** Where the session actually runs: worktreePath joined with relPath. */
  workdir: string;
  /**
   * Tracked files with uncommitted changes in the user's folder when the copy was made.
   * Null when the count could not be taken, which is a different thing from zero and is printed
   * as "could not tell" rather than as a clean folder.
   */
  modifiedTracked: number | null;
  /** Untracked, non-ignored files in the user's folder when the copy was made. Null as above. */
  untracked: number | null;
  /** True when relPath did not exist in the base commit and Conductor had to create it empty. */
  workdirCreated: boolean;
  /**
   * True when the user's HEAD moved between the moment it was read and the moment the copy existed.
   * The copy is still made from baseCommit, so the copy is never wrong; only baseRef and the counts
   * can describe an earlier moment than the folder does. describeWorkspace says so when this is set.
   */
  headMovedDuringCreate: boolean;
}

export type CreateResult = { ok: true; workspace: Workspace } | { ok: false; reason: string };
export type SealResult =
  | { ok: true; workspace: Workspace; commit: string; committed: boolean; files: number }
  | { ok: false; reason: string };
export type DiscardResult =
  /** `note` is set when something was deliberately left alone, for instance a branch of the right
   *  name that git's metadata could not confirm was ours. Silence about that would be a small lie. */
  | { ok: true; workspace: Workspace; note?: string }
  | { ok: false; reason: string };

// --- git plumbing ------------------------------------------------------------
// Ported unchanged in behaviour from checkpoint.ts, which is the only thing carried over from it.

interface GitOptions {
  cwd: string;
  identity?: boolean;
}

interface GitText {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * The environment for every git call here: the daemon's environment with the whole `GIT_*` namespace
 * stripped, then only what Conductor sets deliberately put back.
 *
 * Sol's finding 4 against slice A. `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`,
 * `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_CEILING_DIRECTORIES`,
 * `GIT_NAMESPACE`, `GIT_INDEX_FILE` and `GIT_CONFIG_*` all redirect where git reads and writes.
 * Spreading `process.env` wholesale meant a daemon started from a git hook, or from a shell that
 * exports any of them, would have every command here answer about a repository other than the one it
 * names. Deny by default, the same principle as the rail. Git finds its exec path, its config and
 * its repository from the cwd we hand it, which is the only repository we are entitled to touch.
 *
 * `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` are stripped but deliberately not replaced with an
 * empty file: neutralising them would mean reading the repository differently from the way the
 * user's own git reads it (`core.longpaths`, `safe.directory`, filters), and here that matters more
 * than it did for checkpoints, because a seal commit is meant to join the user's history.
 *
 * The match is case-insensitive because the Windows environment is: `Git_Dir` is `GIT_DIR` there.
 */
function gitEnv(options: GitOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^GIT_/i.test(key)) env[key] = value;
  }
  if (options.identity) Object.assign(env, COMMIT_IDENTITY);
  // Conductor never reaches a remote, and a git call that stops to ask for a password would hang the
  // daemon rather than fail it.
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

/** One git call. Argument array, no shell, output as text. Never throws. */
function git(args: string[], options: GitOptions): GitText {
  const result = spawnSync('git', args, {
    cwd: options.cwd,
    env: gitEnv(options),
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) return { ok: false, stdout: '', stderr: String(result.error) };
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * One read-only git call. Identical to `git` except for `--no-optional-locks`.
 *
 * Sol's finding 5, and the best of the nine: a read that writes. `git status` performs an optional
 * index refresh, so measuring the user's folder rewrote the primary `.git/index` whenever a tracked
 * file's timestamp had moved without its contents changing. The module's one hard invariant, that
 * the user's checkout does not move, was being broken by the code that reports on it. Reproduced on
 * this machine: the index hash changed across createWorkspace before this flag, and does not after.
 *
 * The flag is on every read here rather than only on `status`, because "does this command refresh
 * the index" is exactly the kind of detail that is true today and different two versions from now.
 * Writing commands (worktree add, worktree remove, add, commit, update-ref -d) are meant to take
 * locks and do not use this.
 */
function gitRead(args: string[], options: GitOptions): GitText {
  return git(['--no-optional-locks', ...args], options);
}

/**
 * The one spelling of a path this file trusts, or null when the operating system would not give it.
 *
 * Found the hard way in slice A: git's `--show-toplevel` answers with the true long path, while a
 * caller can hand us the same folder as an 8.3 short name ("KANESN~1"). Comparing the two with
 * `relative()` said the task folder was outside its own repository, and undo silently did nothing.
 * Both ends of every comparison in this file go through here.
 */
function realPathStrict(path: string): string | null {
  try {
    return realpathSync.native(resolve(path));
  } catch {
    return null;
  }
}

/**
 * realPathStrict with a lexical fallback, for the uses where a best-effort spelling is good enough:
 * log lines, messages, a path we are about to hand to git anyway.
 *
 * Sol's final pass, item 2. This fallback used to be the only spelling available, and it reached the
 * containment check, where it is not good enough at all. `resolve()` cannot see a junction, so a
 * failed canonicalisation degraded into a lexical answer that says "outside the repository" about a
 * path nobody has actually resolved. Unknown reading as contained is the same shape of lie as unknown
 * reading as clean. Wherever containment is decided, realPathStrict is used and a null refuses.
 */
function realPath(path: string): string {
  return realPathStrict(path) ?? resolve(path);
}

/**
 * realPathStrict for a path that does not exist yet: resolves the deepest ancestor that does, then
 * puts the missing tail back on. Null when that ancestor would not resolve.
 *
 * `realpathSync` fails on a path that is not there, and the fallback used to hand back the caller's
 * spelling. On this machine %TEMP% arrives as the 8.3 short name, so a state root that had not been
 * created yet stayed short while the repository root was long, and `relative()` between them said
 * "outside" for a folder that was plainly inside. Caught by the finding 6 reproduction failing
 * against the fix, which is the reproduction earning its keep.
 *
 * Strict, with no lenient twin, because it has exactly one caller and that caller decides
 * containment before creating a directory. Sol's last pass: the old lexical fallback here sat in
 * front of a `mkdirSync`, so a state root that would not resolve produced an unverified path and the
 * directory was then created through whatever that path really led to. A write may not stand on a
 * guess, and the strict check after the directory exists is too late to stop the write.
 */
function realPathDeepStrict(path: string): string | null {
  let current = resolve(path);
  const tail: string[] = [];
  for (;;) {
    if (existsSync(current)) {
      const real = realPathStrict(current);
      if (real === null) return null;
      return tail.length ? join(real, ...tail.reverse()) : real;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    tail.push(basename(current));
    current = parent;
  }
}

/** The work tree root for a folder, or null when it is not in a git checkout. Asked of git. */
export function gitRepoRoot(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const result = gitRead(['rev-parse', '--show-toplevel'], { cwd: dir });
  if (!result.ok) return null;
  const root = result.stdout.trim();
  return root ? realPath(root) : null;
}

function headCommit(repoRoot: string): string | null {
  const result = gitRead(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: repoRoot });
  const hash = result.stdout.trim();
  return result.ok && hash ? hash : null;
}

/** The full ref HEAD points at, or null when HEAD is detached. */
function headRef(repoRoot: string): string | null {
  const result = gitRead(['symbolic-ref', '--quiet', 'HEAD'], { cwd: repoRoot });
  const ref = result.stdout.trim();
  return result.ok && ref ? ref : null;
}

/**
 * What a branch ref points at: a commit, nothing, or an answer git would not give.
 *
 * Sol's findings, item 1, twice over. First round: `rev-parse --verify --quiet` exits non-zero for
 * both "no such branch" and "this repository will not answer", and taking `.stdout.trim()` off it
 * flattened the second into the first. An empty string then read as "there is no branch to delete",
 * so discard could remove a worktree, silently skip the deletion, and log a clean success.
 *
 * Second round: separating those two by whether git said anything on stderr does not actually
 * separate them, because a repository that fails quietly looks exactly like a missing ref. The probe
 * is therefore `for-each-ref`, whose exit code carries the distinction instead of its silence:
 *
 *   present     exit 0, the hash on stdout
 *   absent      exit 0, nothing on stdout        <- an answer, not a failure
 *   unreadable  non-zero                          <- git refused to answer at all
 *
 * Verified on git 2.52.0.windows.1, all three, plus the fourth case below.
 *
 * One refinement on top of that mapping. A ref whose file holds something that is not a hash makes
 * `for-each-ref` exit 0 with empty output and "warning: ignoring broken ref" on stderr, which would
 * otherwise read as a clean absence. Anything git had to say about the ref means it is not a clean
 * absence, so an empty answer with output on stderr is unreadable. That errs towards refusing, which
 * is the direction this whole file errs in.
 */
type BranchTip = { state: 'present'; hash: string } | { state: 'absent' } | { state: 'unreadable'; detail: string };

function branchTip(repoRoot: string, ref: string): BranchTip {
  const result = gitRead(['for-each-ref', ref, '--format=%(objectname)'], { cwd: repoRoot });
  const detail = result.stderr.trim();
  if (!result.ok) return { state: 'unreadable', detail: detail || 'git could not read it' };
  const hash = result.stdout.trim();
  if (hash) return { state: 'present', hash };
  return detail ? { state: 'unreadable', detail } : { state: 'absent' };
}

// --- refusals ----------------------------------------------------------------

/**
 * Null when a task may be isolated here, or the sentence explaining why it may not.
 *
 * An honest refusal beats a copy that does not exist. There is deliberately no fallback to running
 * in the user's folder: that fallback is the whole failure mode isolation was chosen to remove.
 */
export function isolationRefusal(cwd: string): string | null {
  const path = cwd.trim();
  if (!path || !isAbsolute(path)) return `the task folder "${cwd}" is not an absolute path`;
  if (!existsSync(path)) return `the task folder "${path}" does not exist`;
  if (!statSync(path).isDirectory()) return `the task folder "${path}" is not a directory`;
  const root = gitRepoRoot(path);
  if (!root) {
    return (
      `the folder "${path}" is not inside a git repository, so Conductor cannot make an isolated copy ` +
      `of it and nothing it did there would be reversible. Run "git init" in that folder, or point the ` +
      `task at a folder that is already under version control.`
    );
  }
  if (!headCommit(root)) {
    return (
      `the repository "${root}" has no commits yet, so there is nothing to copy from. An isolated copy ` +
      `is made from a named commit. Make one commit in that repository and try again.`
    );
  }
  return null;
}

/**
 * A task id turned into something git will accept as a refname component and Windows will accept as
 * a folder name. Validated afterwards with `git check-ref-format` rather than trusted, because the
 * refname rules are longer than any regex written from memory.
 */
export function branchFor(taskId: string): string {
  const safe = taskId
    .replace(/[^A-Za-z0-9._-]/g, '-')
    // A run of dots is the case a regex written from memory misses: ".." is illegal anywhere in a
    // refname, not only at the start, so an id like "a/../b" sanitised character by character still
    // produces a name git rejects. Verified: check-ref-format refused exactly that one.
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\-]+/, '')
    .replace(/[.\-]+$/, '')
    .replace(/\.lock$/i, '-lock');
  return `${BRANCH_PREFIX}${safe || 'task'}`;
}

/**
 * Untracked and modified-tracked counts for the user's folder. Ignored files are not counted.
 *
 * Both counts are null when git could not answer, which is Sol's finding 8. Returning zeroes there
 * made a corrupt index read as "your folder has no uncommitted changes, so the copy matches what you
 * are looking at", which is the gauge's unforgivable lie wearing a different hat: a number invented
 * because none was available. Nothing downstream may turn null back into zero.
 *
 * Stated limit, not fixed here: `assume-unchanged` and `skip-worktree` files are invisible to
 * `git status` on purpose, so an edit to one is not in these counts and cannot be.
 */
function dirtyCounts(repoRoot: string): { modifiedTracked: number | null; untracked: number | null } {
  // --no-renames keeps every record to one NUL-separated field, so the -z parse has no special case.
  const status = gitRead(['status', '--porcelain=v1', '-z', '-uall', '--no-renames'], { cwd: repoRoot });
  let modifiedTracked = 0;
  let untracked = 0;
  if (!status.ok) return { modifiedTracked: null, untracked: null };
  for (const entry of status.stdout.split('\0')) {
    if (entry.length < 3) continue;
    if (entry.startsWith('??')) untracked++;
    else modifiedTracked++;
  }
  return { modifiedTracked, untracked };
}

// --- creating the copy -------------------------------------------------------

/**
 * Makes the isolated copy. Returns the record, or a refusal sentence with git's own stderr in it.
 *
 * There is no fallback path. Every failure below is a refusal; running the task in the user's folder
 * instead would silently hand back the guarantee this whole module exists to provide.
 */
export function createWorkspace(config: Config, task: { id: string; cwd: string }): CreateResult {
  const refuse = (reason: string): CreateResult => {
    logEvent(config, { kind: 'workspace_refused', taskId: task.id, cwd: task.cwd, reason });
    return { ok: false, reason };
  };

  const refusal = isolationRefusal(task.cwd);
  if (refusal) return refuse(refusal);

  const cwd = realPath(task.cwd);
  const repoRoot = gitRepoRoot(cwd);
  if (!repoRoot) return refuse(`could not resolve the git work tree for "${cwd}"`);
  // Containment below is decided by comparing this path with the workspace path, so a repository root
  // that the operating system would not canonicalise is not a usable end of that comparison. Refuse
  // rather than compare against a spelling nobody confirmed; nothing has been created at this point.
  if (realPathStrict(repoRoot) === null) {
    return refuse(
      `the repository root "${repoRoot}" could not be resolved to a real path, so Conductor cannot prove the isolated copy ` +
        `would live outside it. Nothing was created. Check that the folder is readable and try again.`,
    );
  }

  const baseCommit = headCommit(repoRoot);
  if (!baseCommit) return refuse(`the repository "${repoRoot}" has no commits yet, so there is nothing to copy from`);
  const baseRef = headRef(repoRoot);

  const relPath = relative(repoRoot, cwd).split(sep).join('/');
  if (relPath.startsWith('../') || relPath === '..' || isAbsolute(relPath)) {
    return refuse(`the task folder "${cwd}" does not sit inside the repository "${repoRoot}"`);
  }

  const branch = branchFor(task.id);
  const fullRef = `refs/heads/${branch}`;
  const format = gitRead(['check-ref-format', fullRef], { cwd: repoRoot });
  if (!format.ok) {
    return refuse(`the task id "${task.id}" does not make a legal git branch name ("${branch}"), so no branch can be created for it`);
  }
  if (gitRead(['show-ref', '--verify', '--quiet', fullRef], { cwd: repoRoot }).ok) {
    return refuse(
      `the branch "${branch}" already exists in "${repoRoot}". Conductor will not reuse or overwrite it, because ` +
        `it may hold work from an earlier run of task ${task.id}. Merge or delete that branch, or give the task a new id.`,
    );
  }

  // Through realPath at this end too, not only after creation. An 8.3 short name ("KANESN~1") is a
  // different string and a different length from the same folder's long name, so measuring or
  // comparing the short one answers about a path git will never report back to us.
  //
  // Sol's finding 6, which the triage rejected as a finding and kept as a second lock, then his
  // confirmation pass reopened. The primary guard is loadConfig in src/config.ts: it refuses at
  // startup any state root inside a git checkout, which is also what keeps the daemon token out of a
  // repository. This is defence in depth for a Config built by hand rather than by loadConfig: a copy
  // of a folder may not live inside the folder it is a copy of, or making it would change the very
  // checkout this module promises not to touch.
  //
  // The confirmation pass caught the hole: resolving only the state root and then appending
  // "workspaces/<id>" lexically is the same 8.3 mistake in junction form. A junction at
  // <stateRoot>/workspaces can point at a directory inside the repository, and the lexical path stays
  // innocently outside it while `worktree add` writes through the junction and into the user's
  // checkout. So the check runs twice: once lexically, before anything is created, and once against
  // the real path of the workspaces directory, which is also the path that goes in the record.
  const containmentRefusal = (path: string, lexical?: string): string | null => {
    const inside = relative(repoRoot, path);
    if (inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside)) return null;
    return (
      `the workspace folder "${path}" is inside the repository "${repoRoot}"` +
      (lexical && lexical !== path ? ` (reached through "${lexical}", which is a link into that repository)` : '') +
      `. The isolated copy cannot live inside the folder it is a copy of, because making it would change that folder. ` +
      `Point CONDUCTOR_HOME outside every git checkout, and check that nothing under it links back into one.`
    );
  };

  const leaf = branch.slice(BRANCH_PREFIX.length);
  // Strict before the first check, because the `mkdirSync` below is a write and the check in front of
  // it is only as good as the path it is given. A state root whose deepest existing ancestor will not
  // resolve is not a location, it is a guess, and the guess is exactly what a junction hides behind.
  const stateRoot = realPathDeepStrict(config.stateRoot);
  if (stateRoot === null) {
    return refuse(
      `the state root "${config.stateRoot}" could not be resolved to a real path, so Conductor cannot tell where it actually ` +
        `leads and will not create anything under it. Nothing was created. Check that path, and any link along it, and try again.`,
    );
  }
  const lexicalWorkspacesDir = join(stateRoot, 'workspaces');
  const lexicalRefusal = containmentRefusal(join(lexicalWorkspacesDir, leaf));
  if (lexicalRefusal) return refuse(lexicalRefusal);

  // Created before the real path can be read, because a path that is not on disk has no real path.
  // Only <stateRoot>/workspaces is created here, and only ever under Conductor's own state root.
  try {
    mkdirSync(lexicalWorkspacesDir, { recursive: true });
  } catch (err) {
    return refuse(`the workspace folder "${lexicalWorkspacesDir}" could not be created, so there is nowhere to put the copy: ${String(err)}`);
  }
  // Strict, not best-effort. This is the resolution the junction check depends on, and a lexical
  // fallback here would answer "outside the repository" about a path that was never resolved.
  const workspacesDir = realPathStrict(lexicalWorkspacesDir);
  if (workspacesDir === null) {
    return refuse(
      `the workspace folder "${lexicalWorkspacesDir}" could not be resolved to a real path, so Conductor cannot tell where it ` +
        `actually leads and cannot prove the copy would live outside "${repoRoot}". Nothing was created. Check that path, and ` +
        `any link along it, and try again.`,
    );
  }
  const worktreePath = join(workspacesDir, leaf);
  const resolvedRefusal = containmentRefusal(worktreePath, join(lexicalWorkspacesDir, leaf));
  if (resolvedRefusal) return refuse(resolvedRefusal);

  if (existsSync(worktreePath)) {
    return refuse(
      `the workspace folder "${worktreePath}" already exists. Conductor will not reuse or overwrite it. ` +
        `Discard the old workspace, or give the task a new id.`,
    );
  }
  if (worktreePath.length > MAX_WORKTREE_ROOT_LENGTH) {
    return refuse(
      `the workspace folder "${worktreePath}" is ${worktreePath.length} characters long, past the ${MAX_WORKTREE_ROOT_LENGTH} ` +
        `Conductor allows. Files inside a repository add to that and Windows stops at 260, so the copy would fail part way ` +
        `through. Point CONDUCTOR_HOME at a shorter path, or shorten the task id.`,
    );
  }

  // Measured before the copy exists, so the numbers describe the folder the human is looking at.
  const { modifiedTracked, untracked } = dirtyCounts(repoRoot);

  const add = git(['worktree', 'add', '-b', branch, worktreePath, baseCommit], { cwd: repoRoot });
  if (!add.ok) {
    // A failed `git worktree add` can still leave the folder, the metadata and the branch behind,
    // for instance when the checkout hits a path Windows will not accept. Leaving that litter would
    // make the very next attempt refuse with "already exists" and blame the user for our mess.
    const leftBehind = cleanUpFailedAdd(repoRoot, worktreePath, branch, baseCommit);
    return refuse(
      `git worktree add failed, so there is no isolated copy and the task will not run: ${add.stderr.trim() || add.stdout.trim()}` +
        (leftBehind ? ` (${leftBehind})` : ''),
    );
  }

  const realWorktree = realPath(worktreePath);
  const workdir = relPath ? join(realWorktree, ...relPath.split('/')) : realWorktree;
  // A task folder that the base commit does not track has no counterpart in the copy. Creating it
  // empty is the honest outcome: the session runs where it was told to, and describeWorkspace says
  // the folder started empty rather than letting somebody assume their files are there.
  let workdirCreated = false;
  if (!existsSync(workdir)) {
    mkdirSync(workdir, { recursive: true });
    workdirCreated = true;
  }

  // Sol's finding 9. The copy is made from baseCommit, so the copy itself is never wrong. But HEAD
  // can move between reading it and the copy existing, and then baseRef and the counts describe a
  // moment the user's folder has already left. Reading HEAD again is the whole fix: it cannot make
  // the label right, it can say that the label is old, which is the honest thing this file can do.
  const headMovedDuringCreate = headCommit(repoRoot) !== baseCommit || headRef(repoRoot) !== baseRef;

  const workspace: Workspace = {
    taskId: task.id,
    repoRoot,
    baseCommit,
    baseRef,
    branch,
    worktreePath: realWorktree,
    relPath,
    workdir,
    modifiedTracked,
    untracked,
    workdirCreated,
    headMovedDuringCreate,
  };
  logEvent(config, { kind: 'workspace_created', ...workspace });
  return { ok: true, workspace };
}

/**
 * Best-effort tidy-up after a failed creation. `note` is empty when nothing of ours is left behind,
 * and otherwise says what was left and why, for the refusal sentence.
 *
 * Sol's finding 2. Deleting the branch because it exists and has our name treats timing as
 * authorship, which is the exact mistake that killed the checkpoint design. The branch is ours only
 * if `git worktree add -b` just created it, and a branch git just created points at the base commit
 * and nothing else. Any other tip means somebody else's commits are on it, so it stays, reflog and
 * all, and the refusal names it rather than quietly leaving litter.
 *
 * The confirmation pass then pointed out that reading the tip and deleting the branch were two
 * commands, so the branch could be replaced between them and the replacement deleted. `git update-ref
 * -d <ref> <expected-tip>` is git's own compare-and-delete: it takes the ref lock, checks the tip is
 * still what we saw, and refuses otherwise. That closes the gap between the check and the deletion
 * rather than narrowing it.
 */
function cleanUpFailedAdd(repoRoot: string, worktreePath: string, branch: string, baseCommit: string): string {
  const ref = `refs/heads/${branch}`;
  if (existsSync(worktreePath)) git(['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot });

  const notes: string[] = [];
  const tip = branchTip(repoRoot, ref);
  if (tip.state === 'unreadable') {
    // A tip git would not give is not the same as no branch. Saying nothing here would leave litter
    // Conductor knows it cannot account for, and the next attempt would refuse with "already exists".
    notes.push(
      `Conductor could not read the branch "${branch}" to tell whether git had just created it (${tip.detail}), so nothing ` +
        `was deleted; check for that branch and remove it by hand if it is there`,
    );
  } else if (tip.state === 'present' && tip.hash === baseCommit) {
    const deleted = git(['update-ref', '-d', ref, baseCommit], { cwd: repoRoot });
    if (!deleted.ok) {
      const now = branchTip(repoRoot, ref);
      if (now.state === 'unreadable') {
        notes.push(
          `deleting the branch "${branch}" failed and Conductor could not then read it to see whether it is still there ` +
            `(${now.detail}), so check for it and remove it by hand if it is`,
        );
      } else if (now.state === 'present' && now.hash !== baseCommit) {
        notes.push(
          `the branch "${branch}" moved to ${now.hash.slice(0, 12)} between the moment Conductor looked at it and the moment ` +
            `it tried to delete it, so it is no longer the branch git created here and it was left alone`,
        );
      }
    }
  } else if (tip.state === 'present') {
    notes.push(
      `the branch "${branch}" points at ${tip.hash.slice(0, 12)} rather than the commit the copy was to be made from, ` +
        `so it is not the one Conductor just created and it was left alone`,
    );
  }

  if (notes.length === 0 && gitRead(['show-ref', '--verify', '--quiet', ref], { cwd: repoRoot }).ok) {
    notes.push(`the branch "${branch}" could not be deleted, so remove it by hand`);
  }
  if (existsSync(worktreePath)) notes.push(`the partial copy at "${worktreePath}" could not be cleaned up, so remove it by hand`);
  return notes.join('; ');
}

// --- sealing -----------------------------------------------------------------

/**
 * Commits whatever the task left in the copy, on the task's own branch.
 *
 * This deliberately reverses a slice A decision. Checkpoint commits forced
 * `core.autocrlf=false -c core.eol=lf -c core.safecrlf=false` because they were byte-for-byte
 * before-images that never joined the user's history, so raw bytes were exactly right. A seal commit
 * is the opposite: it is meant to be reviewed and merged into the user's branches, so it must be an
 * ordinary commit that respects the repository's own line-ending settings, .gitattributes and clean
 * filters. Forcing raw bytes here would produce a branch that shows a whole-file diff on every text
 * file the moment it is merged. NO_EOL_CONVERSION is not carried over, on purpose.
 *
 * Two deliberate exceptions to "ordinary". The identity is Conductor's, not the user's, so nothing
 * in the log claims a human wrote it. And signing is off: signing under Conductor's name with the
 * user's key would misattribute, and a pinentry prompt would hang a daemon nobody is watching.
 *
 * Hooks are left on, because they are part of the repository's normal settings. A pre-commit hook
 * that fails therefore fails the seal, and that is reported rather than worked around: the work is
 * still in the copy, so the honest answer is to say the seal failed and leave the workspace alone.
 */
export function sealWorkspace(config: Config, workspace: Workspace): SealResult {
  const fail = (reason: string): SealResult => {
    logEvent(config, { kind: 'workspace_seal_failed', taskId: workspace.taskId, branch: workspace.branch, reason });
    return { ok: false, reason };
  };

  if (!existsSync(workspace.worktreePath)) {
    return fail(`the workspace "${workspace.worktreePath}" is gone, so there is nothing to seal`);
  }

  const wt = workspace.worktreePath;

  // Sol's finding 1. Nothing stops the session running `git switch` inside its own copy, and the old
  // code checked only that the folder existed. Staging then committed onto whatever was checked out,
  // so a session could advance a user-owned branch like "release" while the record still advertised
  // the task branch as the output. The copy is ours; the branch checked out in it may not be. Checked
  // before `git add`, because a refusal after staging would leave a staged index behind.
  const expected = `refs/heads/${workspace.branch}`;
  const actual = gitRead(['symbolic-ref', '--quiet', 'HEAD'], { cwd: wt }).stdout.trim();
  if (actual !== expected) {
    const detachedAt = gitRead(['rev-parse', '--short', 'HEAD'], { cwd: wt }).stdout.trim();
    const what = actual ? `"${actual}"` : `a detached HEAD at ${detachedAt || 'an unreadable commit'}`;
    return fail(
      `the copy at "${wt}" has ${what} checked out, not "${expected}". Conductor only commits onto the branch it ` +
        `created, so nothing was staged and the task's work is untouched in the copy. Check "${workspace.branch}" out ` +
        `again in that folder to seal it, or take the work out by hand.`,
    );
  }

  const add = git(['add', '-A', '--', '.'], { cwd: wt });
  if (!add.ok) return fail(`git add failed in the workspace: ${add.stderr.trim()}`);

  // Nothing staged means the task changed nothing. That is a result, not a failure, and an empty
  // commit would put a meaningless entry in a history somebody is going to read.
  const staged = gitRead(['diff', '--cached', '--quiet'], { cwd: wt });
  const names = gitRead(['diff', '--cached', '--name-only', '-z'], { cwd: wt });
  const files = names.ok ? names.stdout.split('\0').filter((p) => p.length > 0).length : 0;
  if (staged.ok) {
    logEvent(config, {
      kind: 'workspace_sealed',
      taskId: workspace.taskId,
      branch: workspace.branch,
      commit: workspace.baseCommit,
      committed: false,
      files: 0,
    });
    return { ok: true, workspace, commit: workspace.baseCommit, committed: false, files: 0 };
  }

  const message = `conductor task ${workspace.taskId}`;
  const commit = git(['commit', '--no-gpg-sign', '-m', message], { cwd: wt, identity: true });
  if (!commit.ok) {
    return fail(`git commit failed in the workspace, so the task's work is still uncommitted there: ${commit.stderr.trim() || commit.stdout.trim()}`);
  }
  const head = gitRead(['rev-parse', 'HEAD'], { cwd: wt }).stdout.trim();
  logEvent(config, { kind: 'workspace_sealed', taskId: workspace.taskId, branch: workspace.branch, commit: head, committed: true, files });
  return { ok: true, workspace, commit: head, committed: true, files };
}

// --- discarding --------------------------------------------------------------

/**
 * The worktree entries git itself knows about, as path -> branch ref (or null when detached).
 *
 * Null, never an empty map, when git could not answer. That distinction is the defect the
 * confirmation pass found in the previous fix round: an empty map reads as "git says there are no
 * worktrees", which is an authoritative statement of absence, and a failed `git worktree list` is the
 * opposite of that. Turning the second into the first let discard report success over a repository it
 * had not been able to look at, and findWorkspace then treated that success as final. Every caller
 * below handles null as its own case.
 */
function registeredWorktrees(repoRoot: string): Map<string, string | null> | null {
  const out = new Map<string, string | null>();
  const listed = gitRead(['worktree', 'list', '--porcelain'], { cwd: repoRoot });
  if (!listed.ok) return null;
  let path: string | null = null;
  for (const line of listed.stdout.split('\n')) {
    const text = line.trimEnd();
    if (text.startsWith('worktree ')) {
      path = realPath(text.slice('worktree '.length));
      out.set(path, null);
    } else if (text.startsWith('branch ') && path) {
      out.set(path, text.slice('branch '.length));
    } else if (text === '') {
      path = null;
    }
  }
  return out;
}

/**
 * Undo. Removes the worktree and deletes its branch, then verifies both actually happened.
 *
 * Verification is the point. Windows holds file locks, and `git worktree remove --force` can fail
 * with the folder half gone; a discard that reports success in that state is a lie about the one
 * operation the whole reversibility argument rests on. The branch is only ever deleted by the exact
 * name in the record, and only after git's own worktree metadata confirms that worktree was ours
 * and carried that branch.
 *
 * Sol's findings 3, 4 and 7, all the same mistake in three places. Ownership now comes from one
 * question asked of git: does it register a worktree at our recorded path, with exactly our branch
 * checked out. Anything else, a different branch, a detached HEAD, no entry at all, means the thing
 * is not ours, so nothing is removed and nothing is deleted, and the answer says so. The unscoped
 * `git worktree prune` is gone: it would deregister an unrelated worktree whose drive happens to be
 * disconnected. `git worktree remove` cleans up its own metadata and we confirm that by asking.
 *
 * Three things the confirmation pass added. The branch tip is read during the ownership check and the
 * deletion is `update-ref -d <ref> <that tip>`, so the delete either happens to the branch we
 * confirmed or does not happen. A failed `git worktree list` is its own answer, not an empty one:
 * "git could not say" stops the discard rather than passing for "there is nothing there". And a
 * folder at the recorded path that git does not register gets its own sentence, because no removal
 * ran and claiming one did would be a small lie about the one operation undo rests on.
 */
export function discardWorkspace(config: Config, workspaceOrTaskId: Workspace | string): DiscardResult {
  const workspace = typeof workspaceOrTaskId === 'string' ? findWorkspace(config, workspaceOrTaskId) : workspaceOrTaskId;
  if (!workspace) return { ok: false, reason: `no workspace is recorded for task "${String(workspaceOrTaskId)}"` };

  const fail = (reason: string): DiscardResult => {
    logEvent(config, { kind: 'workspace_discarded', taskId: workspace.taskId, branch: workspace.branch, worktreePath: workspace.worktreePath, ok: false, reason });
    return { ok: false, reason };
  };

  if (!existsSync(workspace.repoRoot)) return fail(`the repository "${workspace.repoRoot}" is gone, so its worktree metadata cannot be cleaned up`);

  const ref = `refs/heads/${workspace.branch}`;
  const registered = registeredWorktrees(workspace.repoRoot);
  if (registered === null) {
    return fail(
      `git could not read the worktree metadata in "${workspace.repoRoot}", so Conductor cannot tell whether the copy at ` +
        `"${workspace.worktreePath}" is the one it made. Nothing was removed and the branch "${workspace.branch}" was left ` +
        `alone. Fix whatever is wrong with that repository and discard again.`,
    );
  }
  const listedHere = registered.has(workspace.worktreePath);
  const branchThere = registered.get(workspace.worktreePath) ?? null;
  // Ours means: git registers a worktree at that exact path, with that exact branch checked out.
  // A detached HEAD there is somebody else's replacement worktree, not ours with its head turned.
  const ours = listedHere && branchThere === ref;
  if (listedHere && !ours) {
    return fail(
      `the worktree registered at "${workspace.worktreePath}" has ${branchThere ? `"${branchThere}"` : 'a detached HEAD'} ` +
        `checked out, not "${ref}", so Conductor cannot tell that it is the copy it made. Nothing was removed and the ` +
        `branch "${workspace.branch}" was left alone. Remove that folder by hand if it really is leftover.`,
    );
  }

  // Read here, in the same breath as the ownership confirmation above and before anything is removed,
  // because this is the value the branch deletion at the end compares against. Reading it after the
  // removal instead is what let a branch be replaced in between and the replacement deleted.
  //
  // A tip git will not give up stops the discard here, while nothing has happened yet. Undo is one
  // operation, not two: removing the copy and then finding out we never knew whether a branch was
  // there would leave a half-done job reported as a whole one.
  let ownedTip = '';
  if (ours) {
    const tip = branchTip(workspace.repoRoot, ref);
    if (tip.state === 'unreadable') {
      return fail(
        `git would not say what the branch "${workspace.branch}" points at (${tip.detail}), so Conductor cannot delete it ` +
          `safely and will not remove the copy at "${workspace.worktreePath}" while half the job is unknown. Nothing was ` +
          `changed. Fix that repository and discard again.`,
      );
    }
    if (tip.state === 'present') ownedTip = tip.hash;
  }

  if (ours) {
    const removed = git(['worktree', 'remove', '--force', workspace.worktreePath], { cwd: workspace.repoRoot });
    if (!removed.ok) {
      return fail(`git worktree remove failed, so the copy is still there: ${removed.stderr.trim() || removed.stdout.trim()}`);
    }
  }
  // Verified, not assumed. Removal reporting success while the folder survives is the Windows case.
  if (existsSync(workspace.worktreePath)) {
    if (!ours) {
      // Nothing was removed here, so saying "git reported the worktree removed" would describe a
      // command that never ran. What is actually true is smaller and stranger: there is a folder
      // where our copy used to be and git does not think it is a worktree at all.
      return fail(
        `there is a folder at "${workspace.worktreePath}", where Conductor recorded its copy, but git does not register a ` +
          `worktree there, so nothing was removed and Conductor cannot tell whose folder it is. The branch ` +
          `"${workspace.branch}" was left alone too. Look at that folder and delete it by hand if it really is leftover.`,
      );
    }
    return fail(
      `git reported the worktree removed but "${workspace.worktreePath}" is still on disk, most likely a file lock. ` +
        `Nothing else was changed and the branch "${workspace.branch}" was left alone. Close whatever is holding it and try again.`,
    );
  }
  // Asked, not pruned. `git worktree remove` deregisters what it removes; if git still lists our
  // entry then the removal did not finish, and saying so beats reaching for a repo-wide prune. A
  // second listing that fails is not confirmation of anything, so it is not treated as absence.
  if (ours) {
    const after = registeredWorktrees(workspace.repoRoot);
    if (after === null) {
      return fail(
        `git worktree remove reported success for "${workspace.worktreePath}" and the folder is gone, but git could not be ` +
          `read afterwards to confirm its metadata went with it, so the discard is unconfirmed. The branch ` +
          `"${workspace.branch}" was left alone. Fix that repository and discard again.`,
      );
    }
    if (after.has(workspace.worktreePath)) {
      return fail(
        `git still lists a worktree at "${workspace.worktreePath}" after removing it, so its metadata is not cleaned up. ` +
          `The branch "${workspace.branch}" was left alone. Run "git worktree prune" in "${workspace.repoRoot}" yourself if that folder really is gone.`,
      );
    }
  }

  // Only now, only this exact name, and only when the metadata above said the worktree was ours.
  // Mere existence of a branch with our name proves nothing: the record can outlive the worktree,
  // and a human is free to create a branch of any name afterwards. `update-ref -d` with the tip read
  // during that ownership check makes the delete conditional on the branch still pointing where it
  // pointed then, so a branch that moved, or was replaced at a different commit, survives.
  //
  // The parked limit, stated exactly: this does not survive a branch deleted and recreated at the
  // same commit inside that window, because the tip git compares is the only evidence there is and
  // it matches. What is lost in that case is a branch name pointing at a commit that still exists in
  // the repository, not work. Closing it properly would need a ref transaction spanning `worktree
  // remove`, which git does not offer.
  let note: string | undefined;
  if (ours && ownedTip) {
    const deleted = git(['update-ref', '-d', ref, ownedTip], { cwd: workspace.repoRoot });
    if (!deleted.ok) {
      const now = branchTip(workspace.repoRoot, ref);
      // Deletion failed and git will not say whether the branch is still there. The copy is already
      // gone, so this is a discard that half happened, and it is reported as a failure for exactly
      // that reason: the alternative is logging a success nobody checked.
      if (now.state === 'unreadable') {
        return fail(
          `the copy at "${workspace.worktreePath}" is gone, but deleting the branch "${workspace.branch}" failed and git ` +
            `would not then say whether that branch is still there (${now.detail}), so the discard is unconfirmed. Check for ` +
            `that branch by hand.`,
        );
      }
      if (now.state === 'present' && now.hash !== ownedTip) {
        return fail(
          `the copy at "${workspace.worktreePath}" is gone, but the branch "${workspace.branch}" now points at ` +
            `${now.hash.slice(0, 12)} rather than the ${ownedTip.slice(0, 12)} it held a moment ago, so somebody else moved or ` +
            `recreated it and it was left alone. Delete it yourself if it is leftover.`,
        );
      }
      if (now.state === 'present') {
        return fail(`the worktree is gone but the branch "${workspace.branch}" could not be deleted: ${deleted.stderr.trim()}`);
      }
    }
  } else if (!ours) {
    const leftover = branchTip(workspace.repoRoot, ref);
    if (leftover.state === 'unreadable') {
      return fail(
        `git had no worktree registered at "${workspace.worktreePath}", so nothing was removed, but git would not then say ` +
          `whether a branch named "${workspace.branch}" is there (${leftover.detail}). Conductor will not call a discard done ` +
          `on a question it could not get an answer to. Fix that repository and discard again.`,
      );
    }
    if (leftover.state === 'present') {
      note =
        `git had no worktree registered at "${workspace.worktreePath}", so the copy was already gone and nothing was removed. ` +
        `A branch named "${workspace.branch}" exists, but Conductor cannot confirm from git's metadata that it is the one it ` +
        `created, so it was left alone. Delete it yourself if it is leftover.`;
    }
  }

  logEvent(config, { kind: 'workspace_discarded', taskId: workspace.taskId, branch: workspace.branch, worktreePath: workspace.worktreePath, ok: true, ...(note ? { note } : {}) });
  return note ? { ok: true, workspace, note } : { ok: true, workspace };
}

// --- finding a workspace again -----------------------------------------------

/**
 * The last workspace, or the one for a named task, read back out of the logbook.
 *
 * Same pattern findCheckpoint used, and for the same reason: the spec's simplicity budget says state
 * is a few plain things, and a file of workspace metadata would be one more thing earning nothing the
 * append-only log already provides. The scan runs backwards, so a discard seen first correctly
 * cancels the creation reached later in the same walk.
 */
export function findWorkspace(config: Config, taskId?: string): Workspace | null {
  let text: string;
  try {
    text = readFileSync(config.eventsPath, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n');
  const discarded = new Set<string>();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const id = typeof event['taskId'] === 'string' ? event['taskId'] : '';
    if (event['kind'] === 'workspace_discarded' && event['ok'] === true && id) {
      discarded.add(id);
      continue;
    }
    if (event['kind'] !== 'workspace_created') continue;
    if (taskId && id !== taskId) continue;
    if (discarded.has(id)) continue;
    return {
      taskId: id,
      repoRoot: String(event['repoRoot']),
      baseCommit: String(event['baseCommit']),
      baseRef: typeof event['baseRef'] === 'string' ? event['baseRef'] : null,
      branch: String(event['branch']),
      worktreePath: String(event['worktreePath']),
      relPath: String(event['relPath'] ?? ''),
      workdir: String(event['workdir']),
      // Null, not zero, when the log has no number. An absent count is an unknown count.
      modifiedTracked: typeof event['modifiedTracked'] === 'number' ? event['modifiedTracked'] : null,
      untracked: typeof event['untracked'] === 'number' ? event['untracked'] : null,
      workdirCreated: event['workdirCreated'] === true,
      headMovedDuringCreate: event['headMovedDuringCreate'] === true,
    };
  }
  return null;
}

// --- the sentence the doors show ---------------------------------------------

/**
 * What every door says about the copy before the task starts.
 *
 * The spec is explicit that the service states what the copy lacks plainly rather than silently
 * starting from an older state, so the dirty counts are not a footnote here; they are the reason
 * this function exists at all.
 */
export function describeWorkspace(workspace: Workspace): string {
  const w = workspace;
  const lines = [
    `task ${w.taskId} runs in its own copy of "${w.repoRoot}", not in that folder itself.`,
    `  copy:   ${w.worktreePath}`,
    `  workdir:${w.relPath ? ` ${w.workdir}` : ` ${w.workdir}  (the repository root)`}`,
    `  branch: ${w.branch}`,
    `  from:   ${w.baseCommit.slice(0, 12)}${w.baseRef ? ` on ${w.baseRef}` : ' (your HEAD was detached)'}`,
    '',
  ];

  if (w.modifiedTracked === null || w.untracked === null) {
    // Sol's finding 8. Git could not answer, so neither can we. The one thing this must never do is
    // let an unknown read as a clean folder, which is what two zeroes did.
    lines.push('  Conductor could not tell what state your folder was in when it made the copy, because git could not');
    lines.push('  report on it. So it cannot say whether the copy matches your folder. What is certain is the commit');
    lines.push('  above: the copy is made from that and holds nothing you have not committed.');
  } else {
    // Past tense on purpose, and this is Sol's finding 9 answered by wording rather than by code.
    // The counts were taken from the user's folder in the moment before the copy was made. That
    // folder can change a second later, and no number of re-reads makes two git commands into one
    // observation, so the honest thing is to claim exactly what was observed and date it. The copy
    // itself is never wrong: it is made from the commit named above.
    const lacks: string[] = [];
    if (w.modifiedTracked > 0) lacks.push(`${w.modifiedTracked} tracked file(s) you had changed but not committed`);
    if (w.untracked > 0) lacks.push(`${w.untracked} untracked file(s)`);
    if (lacks.length > 0) {
      lines.push(`  the copy is made from the commit above, so it did not contain ${lacks.join(', and ')} at that moment.`);
      lines.push('  the task starts from that commit. Commit the work first if the task needs to see it.');
    } else {
      lines.push('  your folder had no uncommitted changes when the copy was made, so the copy matched it at that moment.');
      lines.push('  anything you have changed since then is not in the copy.');
    }
    lines.push('  git hides files marked assume-unchanged or skip-worktree, so edits to those are not in that count.');
  }
  if (w.headMovedDuringCreate) {
    lines.push("  your folder's HEAD moved while the copy was being made, so the branch and the counts above describe");
    lines.push('  the moment just before that. The copy really is made from the commit above; only the labels are old.');
  }
  lines.push('  files .gitignore covers are never in a fresh copy either: local config, build output, installed');
  lines.push('  packages. A task that needs them has to create or install them inside the copy.');
  if (w.workdirCreated) {
    lines.push(`  "${w.relPath}" is not tracked at that commit, so the task's folder in the copy starts empty.`);
  }
  lines.push('');
  lines.push(`  nothing the task does can reach "${w.repoRoot}". Its output is the branch "${w.branch}",`);
  lines.push(`  which you can read with "git log ${w.branch}" and merge normally. Undo is discarding the copy`);
  lines.push('  and deleting that branch, which leaves your folder exactly as it is now.');
  return lines.join('\n');
}
