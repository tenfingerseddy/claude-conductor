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
//
// Sol's review of the first cut named the flaw that shaped the rest of this file: the before-image
// was honest, but the plan built from it *guessed* at provenance and the preview asserted that guess
// as fact. A diff of "checkpoint versus now" cannot tell the task's work from a human edit made
// afterwards, so undo would happily destroy the human's edit and call it "created by the task".
// Guessing better is not a fix. Three recorded facts replace the guess:
//
//   1. A **post-image**, taken when the task finishes, under refs/conductor/postimage/<taskId>.
//      checkpoint..post-image is what the task did. post-image..now is what somebody else did after
//      it. Provenance becomes something Conductor knows rather than something it infers.
//   2. The **ignore set at checkpoint time**, stored as a blob and pinned by its own ref. Undo asks
//      that recorded set what .gitignore covered, never the current .gitignore, so a task that edits
//      .gitignore cannot widen what undo is allowed to delete.
//   3. A **plan fingerprint**, so the list a human approved is the list that executes.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { Config } from '../config.ts';
import { logEvent } from '../state/logbook.ts';

/** Where Conductor's checkpoints live. Not under refs/heads, so `git branch` never shows them. */
export const REF_PREFIX = 'refs/conductor/checkpoints/';
/** The task-end image. Same plumbing, same invisibility; the other half of provenance. */
export const POSTIMAGE_REF_PREFIX = 'refs/conductor/postimage/';
/** Pins the recorded ignore-set blob so git gc cannot collect the answer undo depends on. */
export const IGNORED_REF_PREFIX = 'refs/conductor/ignored/';

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
 * `.gitattributes` declares `text`, `working-tree-encoding`, `ident` or a clean/smudge filter for a
 * file still gets that file transformed on the way in, and two different working files can clean to
 * one blob, which makes the difference invisible rather than merely lossy. See the limits list in
 * docs/notes/m2-sliceA-findings.md.
 */
const NO_EOL_CONVERSION = ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'core.safecrlf=false'];

/** Identity for the checkpoint commit. A local label, never the user's git identity or an email. */
const COMMIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Conductor',
  GIT_AUTHOR_EMAIL: 'conductor@localhost',
  GIT_COMMITTER_NAME: 'Conductor',
  GIT_COMMITTER_EMAIL: 'conductor@localhost',
};

/** The task-end image of the same working tree. Absent when a task died before it could be taken. */
export interface PostImage {
  ref: string;
  commit: string;
  tree: string;
}

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
  /** Ref pinning the blob that lists what .gitignore covered when the checkpoint was taken. */
  ignoredRef: string | null;
  /** A half-finished merge or rebase at checkpoint time. Recorded so the preview can say so. */
  inProgress: 'merge' | 'rebase' | null;
  /** Filled in by findCheckpoint from the logbook. Null until the task has finished. */
  postImage: PostImage | null;
}

export type CheckpointResult = { ok: true; record: CheckpointRecord } | { ok: false; reason: string };

/** One path undo would change, and what would happen to it. Paths are relative to the repo root. */
export interface UndoChange {
  path: string;
  /** restore: put the checkpoint content back. delete: the task created it, so it goes. */
  action: 'restore' | 'delete';
  /** modified means it existed at checkpoint time and differs now; missing means it was removed. */
  why: 'modified' | 'missing' | 'created';
}

/** A change undo will not make on its own, and the reason it is being held back. */
export interface HeldChange extends UndoChange {
  /**
   * changed-after-task: the post-image proves somebody changed this after the task ended.
   * unknown-provenance: no post-image exists, so nothing here can be attributed to the task.
   */
  held: 'changed-after-task' | 'unknown-provenance';
}

export interface UndoPlan {
  record: CheckpointRecord;
  /** Exactly what applyUndo will do. Nothing else is touched. */
  changes: UndoChange[];
  /** Everything outside the task folder that also differs. Named, never touched. */
  outsideCount: number;
  /** post-image: provenance is known. unknown: the task left no post-image. */
  provenance: 'post-image' | 'unknown';
  /** Held back, listed in full in the preview, and only movable by the named override. */
  held: HeldChange[];
  /** True when the caller passed the override, which folds `held` into `changes`. */
  override: boolean;
  /** Paths whose delete and restore differ only in case, so on Windows they are one file. */
  caseCollisions: string[];
  /** Paths .gitignore covered at checkpoint time. Never restored, never deleted. */
  ignoredSkipped: string[];
  /**
   * Limits this particular repository actually hits, detected rather than left to be discovered.
   * Sol's findings 2, 7, 8 and 9a are all real limits, and the problem with each of them was that
   * the preview said nothing while the limit applied. A limit named in the preview is a limit; a
   * limit nobody is told about is a false promise.
   */
  notes: string[];
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

/**
 * The environment for every git call in this file: the daemon's environment with the whole `GIT_*`
 * namespace stripped, then only the variables Conductor sets deliberately put back.
 *
 * Sol's finding 4. `GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`,
 * `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_CEILING_DIRECTORIES`, `GIT_NAMESPACE`, `GIT_INDEX_FILE`
 * and `GIT_CONFIG_*` all redirect where git reads and writes. Spreading `process.env` wholesale
 * meant a daemon started from a git hook, or from a shell that exports any of them, would have every
 * command here answer about a repository other than the one it names: a before-image written into
 * somebody else's repo, or a restore taken out of one. Deny by default, the same principle as the
 * rail, and nothing is allowed back through: git finds its exec path, its config and its repository
 * from the cwd we hand it, which is the only repository this file is entitled to touch.
 *
 * `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` are stripped with the rest but deliberately not
 * replaced with an empty file. Stripping is what stops an inherited pair steering us; neutralising
 * them as well would mean reading the repository differently from the way the user's own git reads
 * it (`core.longpaths`, `safe.directory`, filters), and the checkpoint has to match what the user
 * sees. The settings that must not vary are passed per command as `-c` instead, which outranks any
 * config file.
 *
 * The match is case-insensitive because the Windows environment is: `Git_Dir` is `GIT_DIR` there.
 */
function gitEnv(options: GitOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^GIT_/i.test(key)) env[key] = value;
  }
  if (options.indexFile) env.GIT_INDEX_FILE = options.indexFile;
  if (options.identity) Object.assign(env, COMMIT_IDENTITY);
  // Conductor never reaches a remote, and a git call that stops to ask for a password would hang
  // the daemon rather than fail it.
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

/**
 * A scratch index path in Conductor's own state root. Never inside the user's repository, and that
 * is enforced at startup rather than assumed here: `loadConfig` (src/config.ts) refuses a state root
 * that sits inside any git checkout, which is also what keeps the daemon token and usage data out of
 * a repository. Sol's finding 10 read this file alone and reasonably feared a scratch index being
 * swept up by `git add -A`; the guard it could not see is the reason that cannot happen.
 */
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
 * therefore not restorable by undo. Undo never deletes those files either, which is why the ignore
 * set is recorded at checkpoint time rather than re-derived later.
 *
 * Not a point-in-time snapshot: `git add -A` walks the tree while the tree can still be written to.
 * Stated limit, not a fixable one without filesystem snapshots.
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

/**
 * A merge or rebase paused mid-flight. The checkpoint is a working-tree image and does not capture
 * it, which is a stated limit; detecting it costs one git call and turns the limit into a sentence
 * in the preview instead of a surprise.
 */
function operationInProgress(repoRoot: string): 'merge' | 'rebase' | null {
  const gitDir = git(['rev-parse', '--absolute-git-dir'], { cwd: repoRoot }).stdout.trim();
  if (!gitDir) return null;
  if (existsSync(join(gitDir, 'rebase-merge')) || existsSync(join(gitDir, 'rebase-apply'))) return 'rebase';
  if (existsSync(join(gitDir, 'MERGE_HEAD'))) return 'merge';
  return null;
}

/** What a checkpoint tree contains that undo cannot fully reproduce. One git call, no guessing. */
function treeFacts(repoRoot: string, tree: string): { submodules: number; symlinks: number; gitattributes: boolean } {
  const listed = git(['ls-tree', '-r', '-z', tree], { cwd: repoRoot });
  const facts = { submodules: 0, symlinks: 0, gitattributes: false };
  if (!listed.ok) return facts;
  for (const entry of listed.stdout.split('\0')) {
    if (!entry) continue;
    const mode = entry.slice(0, 6);
    const path = entry.slice(entry.indexOf('\t') + 1);
    if (mode === '160000') facts.submodules++;
    else if (mode === '120000') facts.symlinks++;
    if (path === '.gitattributes' || path.endsWith('/.gitattributes')) facts.gitattributes = true;
  }
  return facts;
}

/** A task id turned into something git will accept as a ref component. */
export function refFor(taskId: string, prefix: string = REF_PREFIX): string {
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '').replace(/\.lock$/i, '-lock');
  return `${prefix}${safe || 'task'}`;
}

/**
 * Records what .gitignore covered at checkpoint time, as a blob pinned by its own ref.
 *
 * Sol's finding 6: a task that deletes an ignore rule makes a previously ignored file look, at undo
 * time, exactly like a file the task created, and undo deletes it. Re-reading the current .gitignore
 * cannot fix that, because the current .gitignore is the thing the task changed. The set is
 * therefore captured before the task and read back verbatim afterwards. A ref rather than a bare
 * hash, so `git gc` cannot collect it out from under a checkpoint that still exists.
 */
function captureIgnored(repoRoot: string, taskId: string): string | null {
  const listed = git(['ls-files', '-z', '--others', '--ignored', '--exclude-standard'], { cwd: repoRoot });
  if (!listed.ok) return null;
  // --no-filters: this is a path list, not file content, and no attribute may rewrite it.
  const blob = git(['hash-object', '--no-filters', '-w', '--stdin'], { cwd: repoRoot, input: listed.stdout });
  const hash = blob.stdout.trim();
  if (!blob.ok || !hash) return null;
  const ref = refFor(taskId, IGNORED_REF_PREFIX);
  return git(['update-ref', ref, hash], { cwd: repoRoot }).ok ? ref : null;
}

/** The recorded ignore set, or null when the record is missing, which undo treats as a refusal. */
function readIgnored(repoRoot: string, ref: string | null): Set<string> | null {
  if (!ref) return null;
  const out = git(['cat-file', 'blob', ref], { cwd: repoRoot });
  if (!out.ok) return null;
  return new Set(out.stdout.split('\0').filter((p) => p.length > 0));
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
  const inProgress = operationInProgress(repoRoot);
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

    // Recorded before the task, because after it the answer may have changed. Undo refuses rather
    // than guesses when this is missing, so a failure here is a refusal, not a shrug.
    const ignoredRef = captureIgnored(repoRoot, task.id);
    if (!ignoredRef) {
      const reason = 'could not record which files .gitignore covers, so undo could not tell them apart later';
      logEvent(config, { kind: 'checkpoint_refused', taskId: task.id, cwd, reason });
      return { ok: false, reason };
    }

    const listed = git(['ls-tree', '-r', '-z', '--name-only', written.tree], { cwd: repoRoot });
    const files = listed.ok ? listed.stdout.split('\0').filter((p) => p.length > 0).length : 0;

    const record: CheckpointRecord = {
      taskId: task.id,
      ref,
      commit: commitHash,
      tree: written.tree,
      repoRoot,
      cwd,
      head,
      detached,
      files,
      ignoredRef,
      inProgress,
      postImage: null,
    };
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
      ignoredRef,
      inProgress,
    });
    return { ok: true, record };
  } finally {
    discardIndex(indexFile);
  }
}

/**
 * Captures the working tree again when the task ends. This is what makes provenance a fact.
 *
 * Same plumbing as the checkpoint, parented on the checkpoint commit so the pair hangs together.
 * A failure here is logged and swallowed: the task has already finished, and the honest consequence
 * is that undo degrades to "provenance unknown" and refuses the blanket undo, which is handled at
 * the undo end rather than by throwing at the end of somebody's task.
 */
export function postImageTask(config: Config, record: CheckpointRecord): PostImage | null {
  const indexFile = scratchIndex(config, `post-${record.taskId}`);
  try {
    if (!existsSync(record.repoRoot)) return null;
    const head = headCommit(record.repoRoot);
    const written = writeWorktreeTree(record.repoRoot, indexFile, head);
    if (!written.ok) {
      logEvent(config, { kind: 'postimage_failed', taskId: record.taskId, reason: written.reason });
      return null;
    }
    const commit = git(['commit-tree', written.tree, '-p', record.commit, '-m', `conductor post-image after task ${record.taskId}`], {
      cwd: record.repoRoot,
      indexFile,
      identity: true,
    });
    const commitHash = commit.stdout.trim();
    if (!commit.ok || !commitHash) {
      logEvent(config, { kind: 'postimage_failed', taskId: record.taskId, reason: `git commit-tree failed: ${commit.stderr.trim()}` });
      return null;
    }
    const ref = refFor(record.taskId, POSTIMAGE_REF_PREFIX);
    const update = git(['update-ref', ref, commitHash], { cwd: record.repoRoot, indexFile });
    if (!update.ok) {
      logEvent(config, { kind: 'postimage_failed', taskId: record.taskId, reason: `git update-ref failed: ${update.stderr.trim()}` });
      return null;
    }
    logEvent(config, { kind: 'postimage', taskId: record.taskId, ref, commit: commitHash, tree: written.tree, repoRoot: record.repoRoot });
    return { ref, commit: commitHash, tree: written.tree };
  } finally {
    discardIndex(indexFile);
  }
}

// --- finding a checkpoint again ----------------------------------------------

/**
 * The last checkpoint, or the one for a named task, read back out of the logbook, together with the
 * post-image that was taken after it.
 *
 * The logbook is the record on purpose: the spec's simplicity budget says state is a few plain
 * things, and a file holding checkpoint metadata would be one more thing earning nothing the
 * append-only log already provides.
 *
 * The scan runs backwards, which is also what makes the pairing safe: a post-image event is always
 * written after its own checkpoint event, so the first post-image seen while walking backwards
 * belongs to the checkpoint reached later in the same walk. A reused task id from an earlier daemon
 * lifetime cannot lend its post-image to a newer checkpoint.
 */
export function findCheckpoint(config: Config, taskId?: string): CheckpointRecord | null {
  let text: string;
  try {
    text = readFileSync(config.eventsPath, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n');
  const posts = new Map<string, PostImage>();
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
    if (event['kind'] === 'postimage' && id && !posts.has(id)) {
      posts.set(id, { ref: String(event['ref']), commit: String(event['commit']), tree: String(event['tree'] ?? '') });
      continue;
    }
    if (event['kind'] !== 'checkpoint') continue;
    if (taskId && id !== taskId) continue;
    return {
      taskId: id,
      ref: String(event['ref']),
      commit: String(event['commit']),
      tree: String(event['tree'] ?? ''),
      repoRoot: String(event['repoRoot']),
      cwd: String(event['cwd']),
      head: typeof event['head'] === 'string' ? event['head'] : null,
      detached: event['detached'] === true,
      files: typeof event['files'] === 'number' ? event['files'] : 0,
      ignoredRef: typeof event['ignoredRef'] === 'string' ? event['ignoredRef'] : null,
      inProgress: event['inProgress'] === 'merge' || event['inProgress'] === 'rebase' ? event['inProgress'] : null,
      postImage: posts.get(id) ?? null,
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

/** path -> single-letter status, left tree against right tree. Null when git could not answer. */
function diffPaths(repoRoot: string, fromTree: string, toTree: string): Map<string, string> | null {
  // --no-renames keeps the output to one path per line, which is the only shape undo can act on.
  const diff = git(['diff-tree', '-r', '-z', '--no-renames', '--name-status', fromTree, toTree], { cwd: repoRoot });
  if (!diff.ok) return null;
  const fields = diff.stdout.split('\0').filter((f) => f.length > 0);
  const out = new Map<string, string>();
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = (fields[i] ?? '').charAt(0);
    const path = fields[i + 1] ?? '';
    if (path) out.set(path, status);
  }
  return out;
}

export interface PreviewOptions {
  /**
   * Touch the held set too. Deliberately not the same word as "confirm": confirming means "yes, do
   * the list you showed me", while this means "yes, also overwrite work the task did not do".
   */
  overrideChangedAfterTask?: boolean;
}

/**
 * What undo would do, computed without changing anything.
 *
 * Undo is itself destructive, so this exists to be shown to a human first. Three trees are compared,
 * not two. checkpoint..current is the candidate set, which is the only comparison that sees files
 * the task created, because a plain `git diff <commit>` never would: untracked paths are in no index
 * it reads. checkpoint..post-image is what the task actually did. post-image..current is what
 * somebody else did afterwards. Undo acts on the first minus the third, and says so.
 */
export function previewUndo(
  config: Config,
  record: CheckpointRecord,
  options: PreviewOptions = {},
): { ok: true; plan: UndoPlan } | { ok: false; reason: string } {
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

  // Refusal, not a fallback. Re-reading today's .gitignore would answer a question about the past
  // with a file the task may have edited, which is exactly the hole this closes.
  const ignored = readIgnored(record.repoRoot, record.ignoredRef);
  if (!ignored) {
    return {
      ok: false,
      reason:
        `the ignore set recorded with checkpoint "${record.ref}" is missing, so undo cannot tell which files .gitignore ` +
        `covered when the checkpoint was taken. It will not guess from the current .gitignore, because a task can edit it.`,
    };
  }

  const indexFile = scratchIndex(config, `undo-${record.taskId}`);
  try {
    const head = headCommit(record.repoRoot);
    const current = writeWorktreeTree(record.repoRoot, indexFile, head);
    if (!current.ok) return { ok: false, reason: current.reason };

    const checkpointTree = `${record.commit}^{tree}`;
    const candidates = diffPaths(record.repoRoot, checkpointTree, current.tree);
    if (!candidates) return { ok: false, reason: 'git diff-tree failed comparing the checkpoint with the working tree' };

    // Provenance. Verified against the repository, not merely believed from the logbook: a ref that
    // has been deleted degrades to "unknown" the same way a task that never finished does.
    let taskChanged: Map<string, string> | null = null;
    let changedAfter: Map<string, string> | null = null;
    const post = record.postImage;
    if (post?.tree) {
      const postOk = git(['rev-parse', '--verify', '--quiet', `${post.commit}^{commit}`], { cwd: record.repoRoot });
      if (postOk.ok && postOk.stdout.trim()) {
        taskChanged = diffPaths(record.repoRoot, checkpointTree, `${post.commit}^{tree}`);
        changedAfter = diffPaths(record.repoRoot, `${post.commit}^{tree}`, current.tree);
      }
    }
    const provenance: UndoPlan['provenance'] = taskChanged && changedAfter ? 'post-image' : 'unknown';
    const override = options.overrideChangedAfterTask === true;

    const changes: UndoChange[] = [];
    const held: HeldChange[] = [];
    const ignoredSkipped: string[] = [];
    let outsideCount = 0;

    for (const [path, status] of candidates) {
      if (!insideTaskFolder(spec, path)) {
        outsideCount++;
        continue;
      }
      // Ignored at checkpoint time means outside the before-image in both directions. The stated
      // limit says undo neither restores nor deletes these, and this is the line that makes it true
      // even when the task rewrote .gitignore.
      if (ignored.has(path)) {
        ignoredSkipped.push(path);
        continue;
      }
      // Direction: left side is the checkpoint, right side is now. A means it appeared since.
      const change: UndoChange =
        status === 'A' ? { path, action: 'delete', why: 'created' } : status === 'D' ? { path, action: 'restore', why: 'missing' } : { path, action: 'restore', why: 'modified' };

      if (provenance === 'unknown') {
        held.push({ ...change, held: 'unknown-provenance' });
        continue;
      }
      // Two ways to be somebody else's work: the task never touched it, or the task touched it and
      // then somebody touched it again. Both are held.
      if (!taskChanged?.has(path) || changedAfter?.has(path)) {
        held.push({ ...change, held: 'changed-after-task' });
        continue;
      }
      changes.push(change);
    }

    if (override) for (const h of held) changes.push({ path: h.path, action: h.action, why: h.why });

    changes.sort((a, b) => a.path.localeCompare(b.path));
    held.sort((a, b) => a.path.localeCompare(b.path));
    ignoredSkipped.sort((a, b) => a.localeCompare(b));

    return {
      ok: true,
      plan: {
        record,
        changes,
        outsideCount,
        provenance,
        held,
        override,
        caseCollisions: caseCollisionsIn(changes),
        ignoredSkipped,
        notes: limitNotes(record, checkpointTree),
      },
    };
  } finally {
    discardIndex(indexFile);
  }
}

/**
 * The limits this repository actually hits, in plain sentences, for the preview.
 *
 * Every one of these is a limit Sol named and none of them is being fixed here. What changes is that
 * the preview stops being silent about them: a human deciding whether to trust an undo can see that
 * this folder contains a submodule, or a symlink, or a .gitattributes that can hide a difference.
 */
function limitNotes(record: CheckpointRecord, checkpointTree: string): string[] {
  const facts = treeFacts(record.repoRoot, checkpointTree);
  const notes: string[] = [];
  if (facts.submodules > 0) {
    notes.push(
      `${facts.submodules} submodule(s) are in this folder. The checkpoint holds the commit each one pointed at, not the ` +
        `files inside it, so uncommitted work inside a submodule is neither captured nor restored.`,
    );
  }
  if (facts.symlinks > 0) {
    notes.push(`${facts.symlinks} symlink(s) are in this folder. The link itself is restored; whatever it points at is not.`);
  }
  if (facts.gitattributes) {
    notes.push(
      'this repository has a .gitattributes. Attributes such as "text", "working-tree-encoding", "ident" and clean or ' +
        'smudge filters rewrite bytes on the way in, so a file can come back converted, and a difference that is only ' +
        'line endings may not appear in the list above at all.',
    );
  }
  if (record.inProgress) {
    notes.push(`a ${record.inProgress} was in progress when the checkpoint was taken. Undo does not restore it, or the index it belongs to.`);
  }
  return notes;
}

/**
 * Deletions that name the same file as a restore under a different spelling.
 *
 * Sol's finding 5: a task renames `foo.txt` to `FOO.txt`, so the plan restores `foo.txt` and deletes
 * `FOO.txt`. On Windows those are one file, and restoring first meant the delete then removed the
 * file that had just been put back. Ordering the two is the fix; naming the collision is what keeps
 * the fix from quietly regressing, and it puts the case in the preview where a human can see it.
 */
function caseCollisionsIn(changes: UndoChange[]): string[] {
  const restores = new Set(changes.filter((c) => c.action === 'restore').map((c) => c.path.toLowerCase()));
  return changes
    .filter((c) => c.action === 'delete' && restores.has(c.path.toLowerCase()))
    .map((c) => c.path)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * A fingerprint of the exact plan, so confirmation can be bound to the preview a human read.
 *
 * Sol's finding 3: the confirming call recomputed its own plan and applied that, so what executed
 * was never the list anybody approved. The daemon now stores the plan under this fingerprint and
 * applies the stored one. Consent is to a specific list of paths; this is what makes "specific"
 * checkable.
 */
export function planFingerprint(plan: UndoPlan): string {
  const canonical = JSON.stringify({
    taskId: plan.record.taskId,
    ref: plan.record.ref,
    commit: plan.record.commit,
    repoRoot: plan.record.repoRoot,
    cwd: plan.record.cwd,
    provenance: plan.provenance,
    override: plan.override,
    changes: plan.changes.map((c) => [c.path, c.action, c.why]),
    held: plan.held.map((h) => [h.path, h.held]),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export interface UndoOutcome {
  restored: number;
  deleted: number;
  failures: string[];
}

/**
 * Puts the working tree back. Only paths the plan names, which are only paths inside the task
 * folder, which are only paths that were in the checkpoint or are in the current tree and were not
 * ignored when the checkpoint was taken.
 *
 * Deletions run first. That is not a preference: on a case-insensitive filesystem `foo.txt` and
 * `FOO.txt` are one object, so a restore followed by a delete destroys the file it just restored.
 */
export function applyUndo(config: Config, plan: UndoPlan): UndoOutcome {
  const { record } = plan;
  const restore = plan.changes.filter((c) => c.action === 'restore').map((c) => c.path);
  const remove = plan.changes.filter((c) => c.action === 'delete').map((c) => c.path);
  const failures: string[] = [];
  let restored = 0;
  let deleted = 0;

  const emptiedDirs: string[] = [];
  for (const path of remove) {
    const full = join(record.repoRoot, path);
    try {
      rmSync(full, { force: true });
      deleted++;
      emptiedDirs.push(dirname(full));
    } catch (err) {
      failures.push(`could not delete "${full}": ${String(err)}`);
    }
  }

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
        const outcome = checkoutPaths(record.repoRoot, indexFile, restore);
        restored = outcome.restored;
        failures.push(...outcome.failures);
      }
    } finally {
      discardIndex(indexFile);
    }
  }

  // Last, so a directory a restore needed is never pruned between the delete and the restore.
  for (const dir of emptiedDirs) pruneEmptyDirs(dir, record.cwd);

  logEvent(config, {
    kind: 'undo',
    taskId: record.taskId,
    ref: record.ref,
    commit: record.commit,
    repoRoot: record.repoRoot,
    cwd: record.cwd,
    provenance: plan.provenance,
    override: plan.override,
    restored,
    deleted,
    heldBack: plan.held.length,
    outsideLeftAlone: plan.outsideCount,
    failures: failures.length,
  });

  return { restored, deleted, failures };
}

/**
 * checkout-index over a path list, with an honest count when it fails part way.
 *
 * Sol's finding 15: one batch call that fails after writing some files was reported as `restored: 0`
 * next to `applied: true`, so the numbers described a run that never happened. The batch is still
 * the fast path; a failure falls back to one call per path, which costs a process per file only in
 * the case that was already going wrong, and yields a count and a failure list that match what
 * happened on disk.
 */
function checkoutPaths(repoRoot: string, indexFile: string, paths: string[]): { restored: number; failures: string[] } {
  const args = [...NO_EOL_CONVERSION, 'checkout-index', '-f', '-z', '--stdin'];
  const batch = git(args, { cwd: repoRoot, indexFile, input: paths.join('\0') });
  if (batch.ok) return { restored: paths.length, failures: [] };

  const failures: string[] = [`git checkout-index failed for the batch: ${batch.stderr.trim()}`];
  let restored = 0;
  for (const path of paths) {
    const one = git(args, { cwd: repoRoot, indexFile, input: path });
    if (one.ok) restored++;
    else failures.push(`could not restore "${path}": ${one.stderr.trim()}`);
  }
  return { restored, failures };
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

/**
 * One line's verb, and the only place in the preview where authorship is claimed.
 *
 * "created by the task" is a fact when a post-image exists and the path is in checkpoint..post-image.
 * It is a guess in every other case, and Sol failed the first cut of this slice for exactly that:
 * a preview stating a guess as fact. Under unknown provenance, and for any path the override folded
 * in, the verb says only what the record supports, which is how the file differs from the checkpoint.
 * The human then decides, which is the whole point of showing them a list.
 */
function verbFor(change: UndoChange, attributed: boolean): string {
  if (attributed) {
    if (change.action === 'delete') return 'delete   (created by the task)';
    return change.why === 'missing' ? 'restore  (deleted by the task)' : 'restore  (changed by the task)';
  }
  if (change.action === 'delete') return 'delete   (present now, not in the checkpoint)';
  return change.why === 'missing' ? 'restore  (in the checkpoint, absent now)' : 'restore  (differs from the checkpoint)';
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

  if (plan.provenance === 'unknown') {
    lines.push('  NO POST-IMAGE was recorded for this task, so Conductor cannot tell the task\'s work from anybody');
    lines.push('  else\'s. The task did not finish cleanly, or its post-image is gone. Provenance is unknown, so the');
    lines.push('  blanket undo is refused. Nothing below will be touched without the override named at the end.');
    lines.push('');
  }

  if (changes.length === 0) {
    lines.push(plan.held.length > 0 ? '  nothing would be changed: every difference is being held back, see below.' : '  nothing to change: the folder already matches the checkpoint.');
  } else {
    // The held set is what the override folds in. Those paths sit in `changes` and get acted on,
    // but nothing about them is the task's, so they are described and not attributed.
    const heldPaths = new Set(plan.held.map((h) => h.path));
    for (const change of changes) {
      lines.push(`  ${verbFor(change, plan.provenance === 'post-image' && !heldPaths.has(change.path))}  ${change.path}`);
    }
  }

  const restoreCount = changes.filter((c) => c.action === 'restore').length;
  const deleteCount = changes.length - restoreCount;
  lines.push('');
  lines.push(`  ${restoreCount} file(s) restored, ${deleteCount} file(s) deleted.`);

  if (plan.held.length > 0) {
    lines.push('');
    if (plan.override && plan.provenance === 'unknown') {
      lines.push(`  OVERRIDE GIVEN: there is no post-image, so the ${plan.held.length} path(s) below cannot be attributed to`);
      lines.push('  the task or to anybody else. They will be changed anyway:');
    } else if (plan.override) {
      lines.push(`  OVERRIDE GIVEN: the ${plan.held.length} path(s) below are NOT the task's work and will be changed anyway:`);
    } else if (plan.provenance === 'unknown') {
      lines.push(`  held back, provenance unknown (${plan.held.length}):`);
    } else {
      lines.push(`  changed after the task finished, so left alone (${plan.held.length}):`);
    }
    for (const h of plan.held) lines.push(`    ${h.action === 'delete' ? 'would delete ' : 'would restore'}  ${h.path}`);
    if (!plan.override) {
      lines.push(
        plan.provenance === 'post-image'
          ? '  These are somebody else\'s changes, not the task\'s. Undo will not touch them. To include exactly'
          : '  Whose changes these are is not recorded, so undo will not touch them. To include exactly',
      );
      lines.push('  the paths listed above, send "overrideChangedAfterTask": true, or pass');
      lines.push('  --override-changed-after-task on the command line.');
    }
  }

  if (plan.caseCollisions.length > 0) {
    lines.push('');
    lines.push(`  ${plan.caseCollisions.length} path(s) differ from a restored path only in case, so on Windows they are the same file.`);
    lines.push('  Undo deletes before it restores, so the checkpoint spelling is what ends up on disk:');
    for (const path of plan.caseCollisions) lines.push(`    ${path}`);
  }

  if (plan.outsideCount > 0) {
    lines.push(`  ${plan.outsideCount} changed file(s) outside the task folder are left exactly as they are.`);
  }
  if (plan.ignoredSkipped.length > 0) {
    lines.push(`  ${plan.ignoredSkipped.length} path(s) .gitignore covered when the checkpoint was taken are left alone.`);
  }
  lines.push('  files ignored by .gitignore when the checkpoint was taken were never in the before-image, so undo');
  lines.push('  neither restores nor deletes them, whatever .gitignore says now.');
  lines.push('  directories a deletion leaves empty are removed, up to the task folder.');
  lines.push('  your index, HEAD, branch and any merge or rebase in progress are not read and not restored. This is');
  lines.push('  a working-tree image only: staged state the task destroyed does not come back.');
  for (const note of plan.notes) lines.push(`  ${note}`);
  lines.push('  this list is not a guarantee of completeness. The known limits are in docs/notes/m2-sliceA-findings.md.');
  return lines.join('\n');
}
