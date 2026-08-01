// Paths and the account registry. State lives outside the repo and is created on first run.
// This file never reads, writes, or holds a credential. Accounts are names pointing at Claude
// Code config directories; the login inside them stays Claude Code's business.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PLAYBOOK_SEED } from './state/playbook.ts';

/** A named Claude account: a label plus the CLAUDE_CONFIG_DIR a session runs against. */
export interface AccountEntry {
  /** Conductor's own local label. Never an email, never an account UUID. */
  name: string;
  /** Absolute path used as CLAUDE_CONFIG_DIR for sessions on this account. */
  configDir: string;
  /** Left out of scheduling until the user has replaced the seeded placeholder. */
  placeholder: boolean;
}

export interface Config {
  stateRoot: string;
  configFilePath: string;
  playbookPath: string;
  eventsPath: string;
  handoffsDir: string;
  accounts: AccountEntry[];
}

/** Shape of "config.json" in the state root. Kept tiny on purpose; it is a file a human edits. */
interface StoredConfig {
  accounts?: Record<string, string>;
}

// Obvious placeholders. Real folder names belong in the user's own state file, never in the repo.
const SEED_ACCOUNTS: Record<string, string> = {
  work: 'C:\\Users\\you\\.claude-work',
  personal: 'C:\\Users\\you\\.claude-personal',
};

const CONFIG_SEED_COMMENT =
  'Edit "accounts": map a short label to the Claude Code config directory for that login.\n' +
  'The seeded entries are placeholders and are ignored until you change them.';

/** %USERPROFILE%\\.conductor by default, overridable with CONDUCTOR_HOME. */
export function resolveStateRoot(): string {
  const override = process.env['CONDUCTOR_HOME']?.trim();
  return override ? resolve(override) : join(homedir(), '.conductor');
}

/**
 * Walks up from a directory looking for a `.git`, so "is this inside a checkout" can be answered
 * without shelling out to git. Returns the work tree root, or null.
 *
 * This exists for one reason: state and Claude config directories hold usage data, handoffs, the
 * daemon token and, in an account directory, a login. None of that may ever land inside a
 * repository, and this one is public (golden rules 1 and 5). A path check is cheap and the failure
 * it prevents is not recoverable once it has been pushed.
 */
export function gitWorkTreeAbove(dir: string): string | null {
  let current = resolve(dir);
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Resolves the state root, creates the tree on first run, and loads the account registry. */
export function loadConfig(): Config {
  const stateRoot = resolveStateRoot();
  const repo = gitWorkTreeAbove(stateRoot);
  if (repo) {
    throw new Error(
      `conductor: the state root "${stateRoot}" is inside the git checkout at "${repo}". ` +
        `Conductor keeps usage data, handoffs and its daemon token there, and none of that may sit ` +
        `in a repository. Point CONDUCTOR_HOME somewhere outside any checkout and start again.`,
    );
  }
  const configFilePath = join(stateRoot, 'config.json');
  const playbookPath = join(stateRoot, 'playbook.md');
  const eventsPath = join(stateRoot, 'events.jsonl');
  const handoffsDir = join(stateRoot, 'handoffs');

  mkdirSync(handoffsDir, { recursive: true }); // also creates the state root
  seedFile(playbookPath, PLAYBOOK_SEED);
  seedFile(eventsPath, ''); // exists from run one so tailing never races the first event
  seedFile(configFilePath, JSON.stringify({ _comment: CONFIG_SEED_COMMENT, accounts: SEED_ACCOUNTS }, null, 2) + '\n');

  return { stateRoot, configFilePath, playbookPath, eventsPath, handoffsDir, accounts: readAccounts(configFilePath) };
}

/** Writes only when absent, so an edited playbook or config survives every later run. */
function seedFile(path: string, contents: string): void {
  if (existsSync(path)) return;
  // "wx" fails rather than truncates if another process won the race to create it.
  try {
    writeFileSync(path, contents, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
}

function readAccounts(configFilePath: string): AccountEntry[] {
  let stored: StoredConfig;
  try {
    stored = JSON.parse(readFileSync(configFilePath, 'utf8')) as StoredConfig;
  } catch (err) {
    // A hand-edited file with a typo must not take the daemon down.
    process.stderr.write(`conductor: could not parse "${configFilePath}", running with no accounts: ${String(err)}\n`);
    return [];
  }

  return Object.entries(stored.accounts ?? {})
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([name, configDir]) => ({
      name,
      configDir,
      placeholder: SEED_ACCOUNTS[name] === configDir,
    }));
}

/**
 * Accounts the user has actually pointed at a real login. An account directory inside a git
 * checkout is refused rather than used: it holds the login Claude Code created, and a login inside
 * a repository is the one mistake that cannot be walked back after a push.
 */
export function usableAccounts(config: Config): AccountEntry[] {
  return config.accounts.filter((account) => {
    if (account.placeholder || !existsSync(account.configDir)) return false;
    const repo = gitWorkTreeAbove(account.configDir);
    if (repo) {
      process.stderr.write(
        `conductor: account "${account.name}" points at "${account.configDir}", which is inside the ` +
          `git checkout at "${repo}". Claude's login lives in that folder, so the account is ignored. ` +
          `Move it outside any checkout.\n`,
      );
      return false;
    }
    return true;
  });
}

/**
 * The one way to turn a task's account name into a directory a session may run against.
 *
 * Sol's re-check finding 7: the checks above only ever ran on the listing path, while the task
 * loop looked the name up in the raw registry and checked placeholder and existence itself. So an
 * account whose login sits inside a git checkout was excluded from every list and still handed to
 * CLAUDE_CONFIG_DIR when a task named it. Every caller that is about to execute goes through here,
 * so there is one set of rules and no second, weaker copy of them.
 */
export function resolveAccount(config: Config, name: string): AccountEntry | null {
  return usableAccounts(config).find((account) => account.name === name) ?? null;
}
