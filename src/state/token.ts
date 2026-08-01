// The per-daemon bearer token. One secret, generated fresh at every daemon start, living in the
// state root and nowhere else.
//
// Why a token at all when the bind is loopback-only: loopback is not a trust boundary on a desktop.
// Any page a browser loads, any extension, any other process on this machine can reach 127.0.0.1.
// Sol's pass 1 showed the whole chain, where a loopback-reachable page queues an autonomous task,
// starts it, and then approves its own rail stops. The token closes it, and because it must arrive
// in an Authorization header, a browser cannot carry it on a WebSocket at all.
//
// The token is a runtime secret in the state root, which is outside the repo (D5) and gitignored.
// It is never logged, never broadcast, and never written into any committed file.

import { randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { Config } from '../config.ts';

export const TOKEN_FILENAME = 'daemon-token';

export function tokenPath(config: Config): string {
  return join(config.stateRoot, TOKEN_FILENAME);
}

/**
 * Mints a token for this daemon and writes it owner-only. Called once, at daemon start, so a token
 * captured from a previous run stops working the moment the daemon restarts.
 */
export function mintDaemonToken(config: Config): string {
  const token = randomBytes(32).toString('hex');
  const path = tokenPath(config);
  writeFileSync(path, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  restrictToOwner(path);
  return token;
}

/** What a door reads to talk to the daemon. Null means no daemon has started here. */
export function readDaemonToken(config: Config): string | null {
  try {
    const text = readFileSync(tokenPath(config), 'utf8').trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/**
 * Owner-only permissions, honestly. Node's mode bits are close to meaningless on Windows, which is
 * the first-class platform here, so on win32 the ACL is rewritten with icacls: inheritance broken,
 * one grant to the current user. Best effort by design. If it fails the daemon still starts, since
 * the state root already sits inside the user profile, whose default ACL is already user-only; the
 * icacls pass is defence in depth on top of that, not the only thing holding.
 */
function restrictToOwner(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // Not fatal anywhere; on Windows this only ever toggles the read-only attribute.
  }
  if (process.platform !== 'win32') return;
  const user = process.env['USERNAME'];
  if (!user) return;
  try {
    execFileSync('icacls', [path, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'ignore', timeout: 10_000 });
  } catch {
    // An Azure AD machine can refuse this. The profile ACL still applies, so carry on quietly.
  }
}

/** Constant-time-ish compare. Short-circuiting on length is fine; both sides are fixed-width hex. */
export function tokenMatches(expected: string, offered: string | null): boolean {
  if (!offered || offered.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ offered.charCodeAt(i);
  return diff === 0;
}
