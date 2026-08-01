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
// What the copy lacks, said out loud rather than discovered later: a fresh worktree holds only what
// the base commit tracks. Uncommitted work in the human's folder is not in it, untracked files are
// not in it, and ignored files (local config, build output, node_modules) are not in it. The counts
// are measured at creation time, stored in the record, logged, and printed by describeWorkspace.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
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
  /** Tracked files with uncommitted changes in the user's folder when the copy was made. */
  modifiedTracked: number;
  /** Untracked, non-ignored files in the user's folder when the copy was made. */
  untracked: number;
  /** True when relPath did not exist in the base commit and Conductor had to create it empty. */
  workdirCreated: boolean;
}

export type CreateResult = { ok: true; workspace: Workspace } | { ok: false; reason: string };
export type SealResult =
  | { ok: true; workspace: Workspace; commit: string; committed: boolean; files: number }
  | { ok: false; reason: string };
export type DiscardResult = { ok: true; workspace: Workspace } | { ok: false; reason: string };

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
 * The one spelling of a path this file trusts.
 *
 * Found the hard way in slice A: git's `--show-toplevel` answers with the true long path, while a
 * caller can hand us the same folder as an 8.3 short name ("KANESN~1"). Comparing the two with
 * `relative()` said the task folder was outside its own repository, and undo silently did nothing.
 * Both ends of every comparison in this file go through here.
 */
function realPath(path: string): string {
  try {
    return realpathSync.native(resolve(path));
  } catch {
    return resolve(path);
  }
}

/** The work tree root for a folder, or null when it is not in a git checkout. Asked of git. */
export function gitRepoRoot(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const result = git(['rev-parse', '--show-toplevel'], { cwd: dir });
  if (!result.ok) return null;
  const root = result.stdout.trim();
  return root ? realPath(root) : null;
}

function headCommit(repoRoot: string): string | null {
  const result = git(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: repoRoot });
  const hash = result.stdout.trim();
  return result.ok && hash ? hash : null;
}

/** The full ref HEAD points at, or null when HEAD is detached. */
function headRef(repoRoot: string): string | null {
  const result = git(['symbolic-ref', '--quiet', 'HEAD'], { cwd: repoRoot });
  const ref = result.stdout.trim();
  return result.ok && ref ? ref : null;
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

/** Untracked and modified-tracked counts for the user's folder. Ignored files are not counted. */
function dirtyCounts(repoRoot: string): { modifiedTracked: number; untracked: number } {
  // --no-renames keeps every record to one NUL-separated field, so the -z parse has no special case.
  const status = git(['status', '--porcelain=v1', '-z', '-uall', '--no-renames'], { cwd: repoRoot });
  let modifiedTracked = 0;
  let untracked = 0;
  if (!status.ok) return { modifiedTracked, untracked };
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

  const baseCommit = headCommit(repoRoot);
  if (!baseCommit) return refuse(`the repository "${repoRoot}" has no commits yet, so there is nothing to copy from`);
  const baseRef = headRef(repoRoot);

  const relPath = relative(repoRoot, cwd).split(sep).join('/');
  if (relPath.startsWith('../') || relPath === '..' || isAbsolute(relPath)) {
    return refuse(`the task folder "${cwd}" does not sit inside the repository "${repoRoot}"`);
  }

  const branch = branchFor(task.id);
  const fullRef = `refs/heads/${branch}`;
  const format = git(['check-ref-format', fullRef], { cwd: repoRoot });
  if (!format.ok) {
    return refuse(`the task id "${task.id}" does not make a legal git branch name ("${branch}"), so no branch can be created for it`);
  }
  if (git(['show-ref', '--verify', '--quiet', fullRef], { cwd: repoRoot }).ok) {
    return refuse(
      `the branch "${branch}" already exists in "${repoRoot}". Conductor will not reuse or overwrite it, because ` +
        `it may hold work from an earlier run of task ${task.id}. Merge or delete that branch, or give the task a new id.`,
    );
  }

  // Through realPath at this end too, not only after creation. An 8.3 short name ("KANESN~1") is a
  // different string and a different length from the same folder's long name, so measuring or
  // comparing the short one answers about a path git will never report back to us.
  const workspacesDir = join(realPath(config.stateRoot), 'workspaces');
  const worktreePath = join(workspacesDir, branch.slice(BRANCH_PREFIX.length));
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

  mkdirSync(workspacesDir, { recursive: true });
  const add = git(['worktree', 'add', '-b', branch, worktreePath, baseCommit], { cwd: repoRoot });
  if (!add.ok) {
    // A failed `git worktree add` can still leave the folder, the metadata and the branch behind,
    // for instance when the checkout hits a path Windows will not accept. Leaving that litter would
    // make the very next attempt refuse with "already exists" and blame the user for our mess.
    const cleaned = cleanUpFailedAdd(repoRoot, worktreePath, branch);
    return refuse(
      `git worktree add failed, so there is no isolated copy and the task will not run: ${add.stderr.trim() || add.stdout.trim()}` +
        (cleaned ? '' : ` (and the partial copy at "${worktreePath}" could not be cleaned up, so remove it by hand)`),
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
  };
  logEvent(config, { kind: 'workspace_created', ...workspace });
  return { ok: true, workspace };
}

/** Best-effort tidy-up after a failed creation. True when nothing of ours is left behind. */
function cleanUpFailedAdd(repoRoot: string, worktreePath: string, branch: string): boolean {
  if (existsSync(worktreePath)) git(['worktree', 'remove', '--force', worktreePath], { cwd: repoRoot });
  git(['worktree', 'prune'], { cwd: repoRoot });
  if (git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoRoot }).ok) {
    git(['branch', '-D', branch], { cwd: repoRoot });
  }
  return !existsSync(worktreePath) && !git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoRoot }).ok;
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
  const add = git(['add', '-A', '--', '.'], { cwd: wt });
  if (!add.ok) return fail(`git add failed in the workspace: ${add.stderr.trim()}`);

  // Nothing staged means the task changed nothing. That is a result, not a failure, and an empty
  // commit would put a meaningless entry in a history somebody is going to read.
  const staged = git(['diff', '--cached', '--quiet'], { cwd: wt });
  const names = git(['diff', '--cached', '--name-only', '-z'], { cwd: wt });
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
  const head = git(['rev-parse', 'HEAD'], { cwd: wt }).stdout.trim();
  logEvent(config, { kind: 'workspace_sealed', taskId: workspace.taskId, branch: workspace.branch, commit: head, committed: true, files });
  return { ok: true, workspace, commit: head, committed: true, files };
}

// --- discarding --------------------------------------------------------------

/** The worktree entries git itself knows about, as path -> branch ref (or null when detached). */
function registeredWorktrees(repoRoot: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const listed = git(['worktree', 'list', '--porcelain'], { cwd: repoRoot });
  if (!listed.ok) return out;
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
 */
export function discardWorkspace(config: Config, workspaceOrTaskId: Workspace | string): DiscardResult {
  const workspace = typeof workspaceOrTaskId === 'string' ? findWorkspace(config, workspaceOrTaskId) : workspaceOrTaskId;
  if (!workspace) return { ok: false, reason: `no workspace is recorded for task "${String(workspaceOrTaskId)}"` };

  const fail = (reason: string): DiscardResult => {
    logEvent(config, { kind: 'workspace_discarded', taskId: workspace.taskId, branch: workspace.branch, worktreePath: workspace.worktreePath, ok: false, reason });
    return { ok: false, reason };
  };

  if (!existsSync(workspace.repoRoot)) return fail(`the repository "${workspace.repoRoot}" is gone, so its worktree metadata cannot be cleaned up`);

  const registered = registeredWorktrees(workspace.repoRoot);
  const ours = registered.has(workspace.worktreePath);
  const branchThere = registered.get(workspace.worktreePath) ?? null;
  if (ours && branchThere !== null && branchThere !== `refs/heads/${workspace.branch}`) {
    return fail(
      `the worktree at "${workspace.worktreePath}" now has "${branchThere}" checked out, not "refs/heads/${workspace.branch}". ` +
        `Conductor will not remove a worktree or delete a branch it cannot account for.`,
    );
  }

  if (ours) {
    const removed = git(['worktree', 'remove', '--force', workspace.worktreePath], { cwd: workspace.repoRoot });
    if (!removed.ok) {
      return fail(`git worktree remove failed, so the copy is still there: ${removed.stderr.trim() || removed.stdout.trim()}`);
    }
  }
  // Verified, not assumed. Removal reporting success while the folder survives is the Windows case.
  if (existsSync(workspace.worktreePath)) {
    return fail(
      `git reported the worktree removed but "${workspace.worktreePath}" is still on disk, most likely a file lock. ` +
        `Nothing else was changed and the branch "${workspace.branch}" was left alone. Close whatever is holding it and try again.`,
    );
  }

  // Only now, and only this exact name.
  if (ours || git(['show-ref', '--verify', '--quiet', `refs/heads/${workspace.branch}`], { cwd: workspace.repoRoot }).ok) {
    const deleted = git(['branch', '-D', workspace.branch], { cwd: workspace.repoRoot });
    if (!deleted.ok && git(['show-ref', '--verify', '--quiet', `refs/heads/${workspace.branch}`], { cwd: workspace.repoRoot }).ok) {
      return fail(`the worktree is gone but the branch "${workspace.branch}" could not be deleted: ${deleted.stderr.trim()}`);
    }
  }

  git(['worktree', 'prune'], { cwd: workspace.repoRoot });
  logEvent(config, { kind: 'workspace_discarded', taskId: workspace.taskId, branch: workspace.branch, worktreePath: workspace.worktreePath, ok: true });
  return { ok: true, workspace };
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
      modifiedTracked: typeof event['modifiedTracked'] === 'number' ? event['modifiedTracked'] : 0,
      untracked: typeof event['untracked'] === 'number' ? event['untracked'] : 0,
      workdirCreated: event['workdirCreated'] === true,
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

  const lacks: string[] = [];
  if (w.modifiedTracked > 0) lacks.push(`${w.modifiedTracked} tracked file(s) you have changed but not committed`);
  if (w.untracked > 0) lacks.push(`${w.untracked} untracked file(s)`);
  if (lacks.length > 0) {
    lines.push(`  the copy is made from the commit above, so it does NOT contain ${lacks.join(', and ')}.`);
    lines.push('  the task starts from that commit. Commit the work first if the task needs to see it.');
  } else {
    lines.push('  your folder has no uncommitted changes, so the copy matches what you are looking at.');
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
