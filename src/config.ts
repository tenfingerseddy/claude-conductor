// Paths and the account registry. State lives outside the repo and is created on first run.
// This file never reads, writes, or holds a credential. Accounts are names pointing at Claude
// Code config directories; the login inside them stays Claude Code's business.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
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

/** Resolves the state root, creates the tree on first run, and loads the account registry. */
export function loadConfig(): Config {
  const stateRoot = resolveStateRoot();
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

/** Accounts the user has actually pointed at a real login. */
export function usableAccounts(config: Config): AccountEntry[] {
  return config.accounts.filter((a) => !a.placeholder && existsSync(a.configDir));
}
