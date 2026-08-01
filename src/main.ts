// Daemon entry point. This slice boots config and state, logs one daemon_start, and exits.
// The session runner, gauge, server, and CLI land in later slices; the shape here is what they
// plug into.

import { loadConfig, usableAccounts } from './config.ts';
import { logEvent } from './state/logbook.ts';
import { readPlaybook } from './state/playbook.ts';

const VERSION = '0.1.0';

function main(): void {
  const config = loadConfig();
  const accounts = usableAccounts(config);
  const playbook = readPlaybook(config);

  logEvent(config, {
    kind: 'daemon_start',
    pid: process.pid,
    stateRoot: config.stateRoot,
    version: VERSION,
    accounts: accounts.length,
  });

  process.stdout.write(
    [
      `conductor ${VERSION}`,
      `  state root: "${config.stateRoot}"`,
      `  playbook:   ${playbook.length} chars`,
      `  accounts:   ${accounts.length} usable of ${config.accounts.length} configured`,
      '',
    ].join('\n'),
  );

  if (accounts.length === 0) {
    process.stdout.write(
      `\nNo usable accounts yet. Edit "${config.configFilePath}" and point each entry at a real\n` +
        `Claude Code config directory.\n`,
    );
  }
  // daemon_stop belongs to the real shutdown path, which arrives with the session runner.
}

main();
