// Checkpoints and undo. The thing that earns the permissive default.
//
// The reason to interrupt a human is that a mistake is expensive to undo, so Conductor attacks the
// undo instead of the permission. Before every task in a git project the whole working tree,
// including files git has never seen, is committed to a Conductor-owned ref. Nothing else in M2 may
// loosen a permission before this works.
//
// The hard constraint, and the reason this file is all plumbing: **the user's repository state is
// not ours to move.** No branch switch, no HEAD move, no staging, no push, nothing written into
// `.git/index`. Every command here runs with GIT_INDEX_FILE pointed at a scratch file in Conductor's
// own state root, so the index git reads and writes is one we made and delete afterwards. The user's
// `git status` reads identically before and after a checkpoint, and that is verified, not assumed.
//
// Every git call is an argument array through spawnSync with no shell, so nothing re-parses a
// string after we have written it. That is the same lesson the rail learned the expensive way.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Config } from '../config.ts';
import { logEvent } from '../state/logbook.ts';

/** Where Conductor's checkpoints live. Not under refs/heads, so `git branch` never shows them. */
export const REF_PREFIX = 'refs/conductor/checkpoints/';

/**
 * Line-ending conversion turned off for the two commands that move file content.
 *
 * Found during verification, and it mattered: this machine has core.autocrlf on, so `git add` stored
 * the blob with LF and `git checkout-index` wrote it back with CRLF. Undo reported success and every
 * restored file had different bytes from the file it replaced. A checkpoint that cannot reproduce
 * the exact bytes is not a before-image.
 *
 * These `-c` overrides apply to Conductor's own git calls only. They do not touch the user's config
 * and the checkpoint commit never joins the user's history, so storing raw bytes rather than
 * normalised ones costs nothing. Known limit, stated rather than hidden: a repository whose
 * `.gitattributes` declares `text` for a file still gets that file normalised on the way in, so the
 * round trip is exact only when the file on disk already matches what its attributes declare.
 */
const NO_EOL_CONVERSION = ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'core.safecrlf=false'];

/** Identity for the checkpoint commit. A local label, never the user's git identity or an email. */
const COMMIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Conductor',
  GIT_AUTHOR_EMAIL: 'conductor@localhost',
  GIT_COMMITTER_NAME: 'Conductor',
  GIT_COMMITTER_EMAIL: 'conductor@localhost',
};

export interface CheckpointRecord {
  taskId: string;
  ref: string;
  /** The checkpoint commit. Its tree is the before-image. */
  commit: string;
  tree: string;
  repoRoot: string;
  /** The task's folder, which is the only place undo is ever allowed to write. */
  cwd: string;
  /** Where the user's HEAD was. Recorded, never moved. */
  head: string | null;
  detached: boolean;
  files: number;
}

export type CheckpointResult = { ok: true; record: CheckpointRecord } | { ok: false; reason: string };

/** One path undo would change, and what would happen to it. Paths are relative to the repo root. */
export interface UndoChange {
  path: string;
  /** restore: put the checkpoint content back. delete: the task created it, so it goes. */
  action: 'restore' | 'delete';
  /** modified means it existed at checkpoint time and differs now; missing means the task removed it. */
  why: 'modified' | 'missing' | 'created';
}

export interface UndoPlan {
  record: CheckpointRecord;
  changes: UndoChange[];
  /** Everything outside the task folder that also differs. Named, never touched. */
  outsideCount: number;
}

// --- git plumbing ------------------------------------------------------------

interface GitOptions {
  cwd: string;
  indexFile?: string;
  /** Fed to stdin. Used for the -z path lists, which have no length limit and no quoting rules. */
  input?: string;
  identity?: boolean;
}

interface GitText {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function gitEnv(options: GitOptions): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(options.indexFile ? { GIT_INDEX_FILE: options.indexFile } : {}),
    ...(options.identity ? COMMIT_IDENTITY : {}),
    // Conductor never reaches a remote, and a git call that stops to ask for a password would hang
    // the daemon rather than fail it.
    GIT_TERMINAL_PROMPT: '0',
  };
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
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  if (result.error) return { ok: false, stdout: '', stderr: String(result.error) };
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * The one spelling of a path this file trusts.
 *
 * Found the hard way during verification: git's `--show-toplevel` answers with the true long path,
 * while a caller can hand us the same folder as an 8.3 short name ("KANESN~1"). Comparing the two
 * with `relative()` said the task folder was outside its own repository, so undo computed an empty
 * plan and cheerfully reported success. A checkpoint tool that silently does nothing is worse than
 * one that fails, so both ends now go through the same resolver. Symlinks collapse here too, which
 * is the same reason the M2 rail rebuild will want it.
 */
function realPath(path: string): string {
  try {
    return realpathSync.native(resolve(path));
  } catch {
    return resolve(path);
  }
}

/**
 * The work tree root for a folder, or null when it is not in a git checkout. Asked of git rather
 * than guessed from a `.git` walk, so worktrees, submodules and `.git` files answer correctly.
 */
export function gitRepoRoot(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const result = git(['rev-parse', '--show-toplevel'], { cwd: dir });
  if (!result.ok) return null;
  const root = result.stdout.trim();
  return root ? realPath(root) : null;
}

/**
 * Null when a task may run here, or the sentence explaining why it may not.
 *
 * An honest refusal beats a checkpoint that does not exist. A folder outside version control has no
 * before-image, so nothing Conductor does in it is reversible, and saying so is the only truthful
 * answer available.
 */
export function checkpointRefusal(cwd: string): string | null {
  const path = cwd.trim();
  if (!path || !isAbsolute(path)) return `the task folder "${cwd}" is not an absolute path`;
  if (!existsSync(path)) return `the task folder "${path}" does not exist`;
  if (!statSync(path).isDirectory()) return `the task folder "${path}" is not a directory`;
  const root = gitRepoRoot(path);
  if (!root) {
    return (
      `the folder "${path}" is not inside a git repository, so Conductor cannot checkpoint it and ` +
      `nothing it does there would be undoable. Run "git init" in that folder, or point the task at ` +
      `a folder that is already under version control.`
    );
  }
  return null;
}

// --- building a tree from the working tree -----------------------------------

/** A scratch index path in Conductor's own state root. Never inside the user's repository. */
function scratchIndex(config: Config, label: string): string {
  const dir = join(config.stateRoot, 'tmp');
  mkdirSync(dir, { recursive: true });
  return join(dir, `index-${label}-${randomBytes(6).toString('hex')}`);
}

function discardIndex(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // A leftover scratch index is litter, not a failure. Never let it break the task.
  }
}

/**
 * Writes the current working tree, including untracked files, as a git tree object and returns its
 * hash. The user's index is not read and not written: a scratch index is seeded from HEAD (so files
 * that are tracked despite being ignored keep their tracked status) and then brought up to date with
 * the working tree.
 *
 * Ignored paths are not included, because `git add -A` honours .gitignore. That is deliberate and it
 * is a real limit: build output and anything else in .gitignore is not in the before-image and
 * therefore not restorable by undo. Undo never deletes those files either, so the rule is
 * consistent: what git ignores, Conductor ignores.
 */
function writeWorktreeTree(repoRoot: string, indexFile: string, head: string | null): { ok: true; tree: string } | { ok: false; reason: string } {
  if (head) {
    const seed = git(['read-tree', head], { cwd: repoRoot, indexFile });
    if (!seed.ok) return { ok: false, reason: `git read-tree failed: ${seed.stderr.trim()}` };
  }
  // -A covers modified, new and deleted in one pass. --force is not passed: ignored files stay out.
  const add = git([...NO_EOL_CONVERSION, 'add', '-A', '--', '.'], { cwd: repoRoot, indexFile });
  if (!add.ok) return { ok: false, reason: `git add failed: ${add.stderr.trim()}` };
  const write = git(['write-tree'], { cwd: repoRoot, indexFile });
  if (!write.ok) return { ok: false, reason: `git write-tree failed: ${write.stderr.trim()}` };
  const tree = write.stdout.trim();
  return tree ? { ok: true, tree } : { ok: false, reason: 'git write-tree returned nothing' };
}

/** HEAD as a commit hash, or null in a repository with no commits yet. */
function headCommit(repoRoot: string): string | null {
  const result = git(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: repoRoot });
  const hash = result.stdout.trim();
  return result.ok && hash ? hash : null;
}

function headIsDetached(repoRoot: string): boolean {
  // symbolic-ref exits non-zero exactly when HEAD is not pointing at a branch.
  return !git(['symbolic-ref', '--quiet', 'HEAD'], { cwd: repoRoot }).ok;
}

/** A task id turned into something git will accept as a ref component. */
export function refFor(taskId: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '').replace(/\.lock$/i, '-lock');
  return `${REF_PREFIX}${safe || 'task'}`;
}

// --- the checkpoint ----------------------------------------------------------

/**
 * Captures the working tree before a task runs. Returns the record, or a refusal sentence.
 *
 * Sequence, all of it plumbing so nothing the user can see moves: read HEAD, seed a scratch index
 * from it, `git add -A` into that index, `git write-tree`, `git commit-tree` parented on HEAD, then
 * `git update-ref` on a ref under refs/conductor. No checkout, no branch, no push, no staging.
 */
export function checkpointTask(config: Config, task: { id: string; cwd: string }): CheckpointResult {
  const refusal = checkpointRefusal(task.cwd);
  if (refusal) {
    logEvent(config, { kind: 'checkpoint_refused', taskId: task.id, cwd: task.cwd, reason: refusal });
    return { ok: false, reason: refusal };
  }

  const cwd = realPath(task.cwd);
  const repoRoot = gitRepoRoot(cwd);
  if (!repoRoot) return { ok: false, reason: `could not resolve the git work tree for "${cwd}"` };

  const head = headCommit(repoRoot);
  const detached = head ? headIsDetached(repoRoot) : false;
  const indexFile = scratchIndex(config, task.id);

  try {
    const written = writeWorktreeTree(repoRoot, indexFile, head);
    if (!written.ok) {
      logEvent(config, { kind: 'checkpoint_refused', taskId: task.id, cwd, reason: written.reason });
      return { ok: false, reason: written.reason };
    }

    const message = `conductor checkpoint before task ${task.id}`;
    const commitArgs = ['commit-tree', written.tree, ...(head ? ['-p', head] : []), '-m', message];
    const commit = git(commitArgs, { cwd: repoRoot, indexFile, identity: true });
    if (!commit.ok) {
      const reason = `git commit-tree failed: ${commit.stderr.trim()}`;
      logEvent(config, { kind: 'checkpoint_refused', taskId: task.id, cwd, reason });
      return { ok: false, reason };
    }
    const commitHash = commit.stdout.trim();

    const ref = refFor(task.id);
    const update = git(['update-ref', ref, commitHash], { cwd: repoRoot, indexFile });
    if (!update.ok) {
      const reason = `git update-ref failed: ${update.stderr.trim()}`;
      logEvent(config, { kind: 'checkpoint_refused', taskId: task.id, cwd, reason });
      return { ok: false, reason };
    }

    const listed = git(['ls-tree', '-r', '-z', '--name-only', written.tree], { cwd: repoRoot });
    const files = listed.ok ? listed.stdout.split('\0').filter((p) => p.length > 0).length : 0;

    const record: CheckpointRecord = { taskId: task.id, ref, commit: commitHash, tree: written.tree, repoRoot, cwd, head, detached, files };
    logEvent(config, {
      kind: 'checkpoint',
      taskId: task.id,
      ref,
      commit: commitHash,
      tree: written.tree,
      repoRoot,
      cwd,
      head,
      detached,
      files,
    });
    return { ok: true, record };
  } finally {
    discardIndex(indexFile);
  }
}

// --- finding a checkpoint again ----------------------------------------------

/**
 * The last checkpoint, or the one for a named task, read back out of the logbook.
 *
 * The logbook is the record on purpose: the spec's simplicity budget says state is four plain
 * things, and a fifth file holding checkpoint metadata would be a fifth thing earning nothing the
 * append-only log already provides.
 */
export function findCheckpoint(config: Config, taskId?: string): CheckpointRecord | null {
  let text: string;
  try {
    text = readFileSync(config.eventsPath, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event['kind'] !== 'checkpoint') continue;
    if (taskId && event['taskId'] !== taskId) continue;
    return {
      taskId: String(event['taskId']),
      ref: String(event['ref']),
      commit: String(event['commit']),
      tree: String(event['tree'] ?? ''),
      repoRoot: String(event['repoRoot']),
      cwd: String(event['cwd']),
      head: typeof event['head'] === 'string' ? event['head'] : null,
      detached: event['detached'] === true,
      files: typeof event['files'] === 'number' ? event['files'] : 0,
    };
  }
  return null;
}

// --- undo --------------------------------------------------------------------

/**
 * Repo-root-relative prefix for the task folder: null when the task folder is the repository root,
 * a string when it is a subfolder, and `false` when the two paths do not relate at all, which is the
 * failure that must be loud rather than quiet.
 */
function pathspecFor(record: CheckpointRecord): string | null | false {
  const rel = relative(realPath(record.repoRoot), realPath(record.cwd)).split(sep).join('/');
  if (rel === '' || rel === '.') return null;
  if (rel.startsWith('../') || rel === '..' || isAbsolute(rel)) return false;
  return rel;
}

function insideTaskFolder(spec: string | null, repoRelPath: string): boolean {
  return spec === null || repoRelPath === spec || repoRelPath.startsWith(`${spec}/`);
}

/**
 * What undo would do, computed without changing anything.
 *
 * Undo is itself destructive, so this exists to be shown to a human first. It compares the
 * checkpoint's tree with a tree built the same way from the current working tree, which is the only
 * comparison that sees files the task created: a plain `git diff <commit>` never would, because
 * untracked paths are not in any index it reads.
 */
export function previewUndo(config: Config, record: CheckpointRecord): { ok: true; plan: UndoPlan } | { ok: false; reason: string } {
  if (!existsSync(record.repoRoot)) return { ok: false, reason: `the repository "${record.repoRoot}" is gone` };
  const resolved = git(['rev-parse', '--verify', '--quiet', `${record.ref}^{commit}`], { cwd: record.repoRoot });
  if (!resolved.ok || !resolved.stdout.trim()) {
    return { ok: false, reason: `the checkpoint ref "${record.ref}" no longer exists in "${record.repoRoot}"` };
  }

  const spec = pathspecFor(record);
  if (spec === false) {
    return {
      ok: false,
      reason: `the task folder "${record.cwd}" does not sit inside the repository "${record.repoRoot}", so undo cannot say which files are its own`,
    };
  }

  const indexFile = scratchIndex(config, `undo-${record.taskId}`);
  try {
    const head = headCommit(record.repoRoot);
    const current = writeWorktreeTree(record.repoRoot, indexFile, head);
    if (!current.ok) return { ok: false, reason: current.reason };

    // --no-renames keeps the output to one path per line, which is the only shape undo can act on.
    const diff = git(['diff-tree', '-r', '-z', '--no-renames', '--name-status', `${record.commit}^{tree}`, current.tree], {
      cwd: record.repoRoot,
    });
    if (!diff.ok) return { ok: false, reason: `git diff-tree failed: ${diff.stderr.trim()}` };

    const fields = diff.stdout.split('\0').filter((f) => f.length > 0);
    const changes: UndoChange[] = [];
    let outsideCount = 0;
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const status = (fields[i] ?? '').charAt(0);
      const path = fields[i + 1] ?? '';
      if (!path) continue;
      if (!insideTaskFolder(spec, path)) {
        outsideCount++;
        continue;
      }
      // Direction: left side is the checkpoint, right side is now. A means the task added it.
      if (status === 'A') changes.push({ path, action: 'delete', why: 'created' });
      else if (status === 'D') changes.push({ path, action: 'restore', why: 'missing' });
      else changes.push({ path, action: 'restore', why: 'modified' });
    }
    changes.sort((a, b) => a.path.localeCompare(b.path));
    return { ok: true, plan: { record, changes, outsideCount } };
  } finally {
    discardIndex(indexFile);
  }
}

export interface UndoOutcome {
  restored: number;
  deleted: number;
  failures: string[];
}

/**
 * Puts the working tree back. Only paths the plan names, which are only paths inside the task
 * folder, which are only paths that were in the checkpoint or are in the current tree. Ignored files
 * are in neither, so undo cannot reach them.
 */
export function applyUndo(config: Config, plan: UndoPlan): UndoOutcome {
  const { record } = plan;
  const restore = plan.changes.filter((c) => c.action === 'restore').map((c) => c.path);
  const remove = plan.changes.filter((c) => c.action === 'delete').map((c) => c.path);
  const failures: string[] = [];
  let restored = 0;
  let deleted = 0;

  if (restore.length > 0) {
    const indexFile = scratchIndex(config, `restore-${record.taskId}`);
    try {
      // The scratch index holds the checkpoint, so checkout-index writes checkpoint content with
      // checkpoint file modes. The user's index is untouched and HEAD does not move.
      const read = git(['read-tree', `${record.commit}^{tree}`], { cwd: record.repoRoot, indexFile });
      if (!read.ok) {
        failures.push(`git read-tree failed: ${read.stderr.trim()}`);
      } else {
        // checkout-index will not create leading directories for us, so the ones a deletion removed
        // are made first.
        for (const path of restore) mkdirSync(dirname(join(record.repoRoot, path)), { recursive: true });
        const out = git([...NO_EOL_CONVERSION, 'checkout-index', '-f', '-z', '--stdin'], {
          cwd: record.repoRoot,
          indexFile,
          input: restore.join('\0'),
        });
        if (out.ok) restored = restore.length;
        else failures.push(`git checkout-index failed: ${out.stderr.trim()}`);
      }
    } finally {
      discardIndex(indexFile);
    }
  }

  for (const path of remove) {
    const full = join(record.repoRoot, path);
    try {
      rmSync(full, { force: true });
      deleted++;
      pruneEmptyDirs(dirname(full), record.cwd);
    } catch (err) {
      failures.push(`could not delete "${full}": ${String(err)}`);
    }
  }

  logEvent(config, {
    kind: 'undo',
    taskId: record.taskId,
    ref: record.ref,
    commit: record.commit,
    repoRoot: record.repoRoot,
    cwd: record.cwd,
    restored,
    deleted,
    outsideLeftAlone: plan.outsideCount,
    failures: failures.length,
  });

  return { restored, deleted, failures };
}

/** Removes directories a deletion emptied, never climbing above the task folder. */
function pruneEmptyDirs(dir: string, stopAt: string): void {
  let current = resolve(dir);
  const boundary = resolve(stopAt);
  while (current !== boundary && current.startsWith(boundary + sep)) {
    try {
      if (readdirSync(current).length > 0) return;
      rmdirSync(current); // rmSync without recursive refuses a directory outright
    } catch {
      return;
    }
    current = dirname(current);
  }
}

/** The preview a human reads before answering. Plain lines, no diff, counts at the end. */
export function describePlan(plan: UndoPlan): string {
  const { record, changes } = plan;
  const lines: string[] = [
    `undo would restore the folder "${record.cwd}" to the checkpoint taken before task ${record.taskId}.`,
    `  ref:    ${record.ref}`,
    `  commit: ${record.commit}`,
    '',
  ];
  if (changes.length === 0) {
    lines.push('  nothing to change: the folder already matches the checkpoint.');
  } else {
    for (const change of changes) {
      const verb = change.action === 'delete' ? 'delete   (created by the task)' : change.why === 'missing' ? 'restore  (deleted by the task)' : 'restore  (changed by the task)';
      lines.push(`  ${verb}  ${change.path}`);
    }
  }
  const restoreCount = changes.filter((c) => c.action === 'restore').length;
  const deleteCount = changes.length - restoreCount;
  lines.push('');
  lines.push(`  ${restoreCount} file(s) restored, ${deleteCount} file(s) deleted.`);
  if (plan.outsideCount > 0) {
    lines.push(`  ${plan.outsideCount} changed file(s) outside the task folder are left exactly as they are.`);
  }
  lines.push('  files ignored by .gitignore were never checkpointed, so undo neither restores nor deletes them.');
  lines.push('  your branch, HEAD and staged changes are not touched.');
  return lines.join('\n');
}
