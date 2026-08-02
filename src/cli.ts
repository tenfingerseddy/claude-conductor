// The terminal door. A thin client over the daemon's loopback server and nothing else: it never
// reads or writes Conductor's state directly, because one engine with many doors only holds if the
// doors have no private path to the state. Everything here is an HTTP call or a WebSocket frame.
//
// No CLI framework. Five commands plus the daemon does not earn a dependency.

import { createInterface } from 'node:readline';
import { WebSocket } from 'ws';
import { loadConfig } from './config.ts';
import { runDaemon } from './main.ts';
import { serverBaseUrl, serverPort, BIND_HOST } from './server/http.ts';
import { readDaemonToken, tokenPath } from './state/token.ts';

const USAGE = `conductor <command>

  daemon                       start the daemon in the foreground (loopback only)
  status                       daemon health, current task, task list
  gauge                        every account, every bucket, with source and freshness
  add <prompt> --cwd <dir>     queue a task
       [--account <name>] [--model <model>] [--title <text>]
                               every task is attended: --trust autonomous is refused until M2
  run                          start working the pending list
  undo [taskId] [--yes]        discard the task's own copy: delete the worktree and its branch
                               without --yes it only describes the copy and what would go.
                               Your own folder is never touched either way, because the task
                               never worked in it
  stop                         ask the daemon to shut down and log the stop
  tail [n]                     last n logbook events (default 20)
  watch                        stream the running session and answer approval stops
`;

/**
 * The daemon's token, read from the state root. This is the whole of the CLI's authentication:
 * being able to read a file in the user's own state root is the credential, which is the same
 * thing being able to reach a loopback port used to be, only true this time.
 */
function daemonToken(): string {
  const config = loadConfig();
  const token = readDaemonToken(config);
  if (!token) {
    throw new Error(
      `no daemon token at "${tokenPath(config)}". Start the daemon with "conductor daemon", and ` +
        `check CONDUCTOR_HOME points at the same state root the daemon is using.`,
    );
  }
  return token;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case 'daemon':
      await runDaemon();
      return -1; // stays in the foreground until a signal stops it
    case 'status':
      return await showStatus();
    case 'gauge':
      return await showGauge();
    case 'add':
      return await addTask(rest);
    case 'run':
      return await startRun();
    case 'undo':
      return await undo(rest);
    case 'stop':
      return await stopDaemon();
    case 'tail':
      return await tail(rest[0]);
    case 'watch':
      return await watch();
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      out(USAGE);
      return 0;
    default:
      out(`conductor: no command "${command}"\n\n${USAGE}`);
      return 2;
  }
}

// --- commands --------------------------------------------------------------

async function showStatus(): Promise<number> {
  const status = asRecord(await get('/status'));
  const tasks = Array.isArray(status['tasks']) ? status['tasks'] : [];
  const accounts = Array.isArray(status['accounts']) ? status['accounts'] : [];
  const pending = Array.isArray(status['pendingApprovals']) ? status['pendingApprovals'] : [];

  out(`conductor ${String(status['version'])}, pid ${String(status['pid'])}, up ${String(status['uptimeSeconds'])}s`);
  out(`  state root:  "${String(status['stateRoot'])}"`);
  out(`  running:     ${status['running'] === true ? `yes, task ${String(status['currentTask'])}` : 'no'}`);
  out(`  doors open:  ${String(status['doors'])}`);
  out(`  accounts:    ${accounts.map((a) => `${String(asRecord(a)['name'])}${asRecord(a)['usable'] === true ? '' : ' (unusable)'}`).join(', ') || 'none'}`);
  out(`  tasks:       ${tasks.length}`);
  for (const raw of tasks) {
    const task = asRecord(raw);
    out(`    ${String(task['id'])}  ${String(task['status']).padEnd(8)} ${String(task['trust']).padEnd(10)} ${String(task['title'])}`);
  }
  for (const raw of pending) {
    const p = asRecord(raw);
    out(`  waiting on a tap: ${String(p['toolName'])} (${String(p['reason'])}). Run "conductor watch" to answer.`);
  }
  return 0;
}

async function showGauge(): Promise<number> {
  const gauge = asRecord(await get('/gauge'));
  const accounts = Array.isArray(gauge['accounts']) ? gauge['accounts'] : [];
  if (accounts.length === 0) out('no usable accounts configured');

  for (const raw of accounts) {
    const account = asRecord(raw);
    out(`account "${String(account['account'])}"`);
    for (const bucketRaw of Array.isArray(account['buckets']) ? account['buckets'] : []) {
      const bucket = asRecord(bucketRaw);
      const percent = bucket['percent'];
      const value = typeof percent === 'number' ? `${percent.toFixed(1)}% used` : typeof bucket['tokens'] === 'number' ? `${String(bucket['tokens'])} tokens` : 'no reading';
      const resets = typeof bucket['resetsAt'] === 'string' ? `, resets ${bucket['resetsAt']}` : '';
      out(`  ${String(bucket['id']).padEnd(20)} ${value.padEnd(18)} [${String(bucket['source'])}, ${String(bucket['confidence'])}${resets}]`);
    }
    out(`  context: ${typeof account['contextPercent'] === 'number' ? `${String(account['contextPercent'])}%` : 'no session yet'}`);
    out(`  line: ${String(account['line'])}`);
  }
  return 0;
}

async function addTask(args: string[]): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const prompt = positional.join(' ').trim();
  if (!prompt) {
    out('conductor add needs a prompt.\n\n' + USAGE);
    return 2;
  }
  if (!flags['cwd']) {
    out('conductor add needs --cwd, the project folder the task runs in.');
    return 2;
  }

  const body = {
    prompt,
    cwd: flags['cwd'],
    ...(flags['account'] ? { account: flags['account'] } : {}),
    ...(flags['trust'] ? { trust: flags['trust'] } : {}),
    ...(flags['model'] ? { model: flags['model'] } : {}),
    ...(flags['title'] ? { title: flags['title'] } : {}),
  };

  const response = asRecord(await post('/tasks', body));
  if (response['error']) {
    out(`conductor: ${String(response['error'])}`);
    return 1;
  }
  const task = asRecord(response['task']);
  out(`added ${String(task['id'])}: ${String(task['title'])}`);
  out(`  cwd "${String(task['cwd'])}", account ${String(task['account'])}, trust ${String(task['trust'])}${task['model'] ? `, model ${String(task['model'])}` : ''}`);
  return 0;
}

async function startRun(): Promise<number> {
  const response = asRecord(await post('/run', {}));
  if (response['started'] !== true) {
    out(`conductor: ${String(response['error'] ?? 'the run did not start')}`);
    return 1;
  }
  out(`run started over ${String(response['count'])} task(s). Attach with "conductor watch" to see turns and answer approval stops.`);
  return 0;
}

/**
 * Undo the last task, or a named one, by discarding the copy it worked in.
 *
 * Two round trips on purpose: the first describes the copy and changes nothing, and only `--yes`
 * sends the second. Discarding is total, and it deletes the branch the task's work was sealed onto,
 * so a human sees what will go before it goes. Forgetting the flag costs a reprint.
 *
 * The confirming call names the taskId the preview resolved, rather than saying "the last one"
 * twice, and carries the previewToken that preview minted. The daemon will not discard without one,
 * so the two-step is the daemon's rule and this flow is only its most convenient client.
 */
async function undo(args: string[]): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const wanted = positional[0]?.trim();
  const confirm = flags['yes'] === 'true' || flags['y'] === 'true';

  const preview = asRecord(await get(`/undo${wanted ? `?taskId=${encodeURIComponent(wanted)}` : ''}`));
  if (preview['error']) {
    out(`conductor: ${String(preview['error'])}`);
    return 1;
  }

  const taskId = String(preview['taskId']);
  out(String(preview['workspace'] ?? ''));
  out('');
  out('discarding would:');
  out(`  remove the copy    ${String(preview['worktreePath'])}`);
  out(`  delete the branch  ${String(preview['branch'])}`);
  out(`  seal state         ${sealLine(preview)}`);
  out(`  leave alone        ${String(preview['repoRoot'])}, your own folder`);

  if (!confirm) {
    out('');
    out(`nothing has been changed. Run "conductor undo ${taskId} --yes" to discard exactly this copy.`);
    return 0;
  }

  const done = asRecord(await post('/undo', { taskId, confirm: true, previewToken: preview['previewToken'] }));
  if (done['error']) {
    out('');
    out(`conductor: ${String(done['error'])}`);
    return 1;
  }
  out('');
  out(`discarded: the copy at "${String(done['worktreePath'])}" is gone and the branch "${String(done['branch'])}" is deleted.`);
  if (done['note']) out(`  note: ${String(done['note'])}`);
  return 0;
}

/** What the logbook says about the seal, said in words rather than in a boolean nobody can read. */
function sealLine(preview: Record<string, unknown>): string {
  if (typeof preview['sealFailure'] === 'string') {
    return `the seal failed, so the branch holds no commit from this task (${String(preview['sealFailure'])})`;
  }
  if (preview['sealed'] === true) {
    const files = preview['files'];
    return `sealed, ${typeof files === 'number' ? `${files} file(s)` : 'an unrecorded number of files'} committed on that branch`;
  }
  if (preview['sealed'] === false) return 'sealed with nothing to commit, so the task changed no files';
  return 'the logbook does not say whether the work was sealed, so assume the branch may hold work';
}

/**
 * The programmatic shutdown. Windows cannot deliver SIGINT to a child process, so anything that
 * starts the daemon and later wants it stopped needs this rather than a signal, and the daemon logs
 * `daemon_stop` on the way out instead of dying silently.
 */
async function stopDaemon(): Promise<number> {
  const response = asRecord(await post('/stop', {}));
  if (response['stopping'] !== true) {
    out(`conductor: ${String(response['error'] ?? 'the daemon did not accept the stop')}`);
    return 1;
  }
  out('daemon stopping.');
  return 0;
}

async function tail(countArg: string | undefined): Promise<number> {
  const count = Number(countArg ?? '20');
  const response = asRecord(await get(`/events?tail=${Number.isFinite(count) && count > 0 ? Math.floor(count) : 20}`));
  for (const event of Array.isArray(response['events']) ? response['events'] : []) {
    out(JSON.stringify(event));
  }
  return 0;
}

/**
 * The attended door. Streamed turns go to stdout; an approval request stops and asks y or n, which
 * is how a task gets its taps in M1. Answering no is the safe default: closing the terminal, or
 * saying anything but yes, denies.
 */
async function watch(): Promise<number> {
  // The token rides in a header, which is exactly why a browser cannot open this socket.
  const socket = new WebSocket(`ws://${BIND_HOST}:${serverPort()}/ws`, { headers: { authorization: `Bearer ${daemonToken()}` } });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let asking: Promise<void> = Promise.resolve();

  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  }).catch((err: unknown) => {
    throw new Error(`could not reach the daemon at ${serverBaseUrl()}: ${err instanceof Error ? err.message : String(err)}`);
  });

  out(`watching ${serverBaseUrl()}. Ctrl+C to detach.`);

  socket.on('message', (data) => {
    const event = asRecord(safeParse(String(data)));
    if (event['type'] === 'approval_request') {
      // An approval is addressed to one door. A watcher that is not the addressee sees the question
      // and says so, rather than prompting for an answer the daemon would refuse.
      if (event['yours'] === false) {
        out(`  (a tap is waiting at ${String(event['door'])}, not at this window: ${String(event['toolName'])})`);
        return;
      }
      // Serialised: two stops must not fight over stdin.
      asking = asking.then(() => askApproval(socket, rl, event));
      return;
    }
    const rendered = render(event);
    if (rendered) out(rendered);
  });

  await new Promise<void>((resolve) => {
    socket.once('close', () => resolve());
    rl.once('SIGINT', () => {
      socket.close();
      resolve();
    });
  });

  rl.close();
  return 0;
}

async function askApproval(socket: WebSocket, rl: ReturnType<typeof createInterface>, event: Record<string, unknown>): Promise<void> {
  const input = JSON.stringify(event['input'] ?? {});
  out('');
  out('  ---- Conductor stopped for a tap ----');
  out(`  task:  ${String(event['taskId'])}`);
  out(`  tool:  ${String(event['toolName'])}`);
  out(`  input: ${input.length > 500 ? `${input.slice(0, 500)}...` : input}`);
  out(`  why:   ${String(event['reason'])}`);

  const answer = await new Promise<string>((resolve) => rl.question('  approve? [y/N] ', resolve));
  const approved = /^y(es)?$/i.test(answer.trim());
  socket.send(JSON.stringify({ type: 'approval_response', id: event['id'], approved }));
  out(`  ${approved ? 'approved' : 'denied'}.`);
  out('');
}

// --- rendering -------------------------------------------------------------

function render(event: Record<string, unknown>): string | null {
  const type = String(event['type']);

  if (type === 'session_message') return renderSessionMessage(String(event['taskId']), asRecord(event['message']));
  if (type === 'task_started') {
    const head = `\n=== task ${String(event['taskId'])} started: ${String(event['title'])} (${String(event['account'])}, ${String(event['trust'])}) ===`;
    // The description of the copy belongs here, at the top of the task, because what the copy lacks
    // is what a human needs to know before the task starts acting on it rather than afterwards.
    return typeof event['workspace'] === 'string' ? `${head}\n${event['workspace']}` : head;
  }
  if (type === 'task_finished') {
    const error = event['errorText'] ? `, error: ${String(event['errorText'])}` : '';
    return `=== task ${String(event['taskId'])} finished: ${String(event['outcome'])}${error} ===\n  handoff: ${String(event['handoffPath'] ?? 'none')}`;
  }
  if (type === 'run_started') return `run started over ${(event['tasks'] as unknown[] | undefined)?.length ?? 0} task(s)`;
  if (type === 'run_done') return 'run done.';
  if (type === 'run_error') return `run error: ${String(event['error'])}`;
  if (type === 'workspace_discarded') return `  (copy for task ${String(event['taskId'])} discarded, branch ${String(event['branch'])} deleted)`;
  if (type === 'approval_settled') return `  (approval ${String(event['id'])} ${event['approved'] === true ? 'approved' : 'denied'})`;
  if (type === 'error') return `daemon says: ${String(event['error'])}`;
  if (type === 'door_message') return `  (message sent to the session: ${String(event['text'])})`;
  return null; // hello and task_added are noise once you are watching
}

function renderSessionMessage(taskId: string, message: Record<string, unknown>): string | null {
  const tag = `[${taskId}]`;
  const type = String(message['type']);

  if (type === 'system' && message['subtype'] === 'init') return `${tag} session ${String(message['session_id'])} on ${String(message['model'])}`;
  if (type === 'result') return `${tag} result: ${String(message['subtype'])}`;

  if (type === 'assistant' || type === 'user') {
    const content = asRecord(message['message'])['content'];
    if (typeof content === 'string') return `${tag} ${type}: ${truncate(content)}`;
    if (!Array.isArray(content)) return null;

    const lines: string[] = [];
    for (const raw of content) {
      const block = asRecord(raw);
      const kind = String(block['type']);
      if (kind === 'text' && typeof block['text'] === 'string' && block['text'].trim()) lines.push(`${tag} ${truncate(block['text'])}`);
      else if (kind === 'tool_use') lines.push(`${tag} tool: ${String(block['name'])} ${truncate(JSON.stringify(block['input'] ?? {}), 300)}`);
      else if (kind === 'tool_result') lines.push(`${tag} result: ${truncate(flatten(block['content']), 300)}`);
    }
    return lines.length ? lines.join('\n') : null;
  }
  return null;
}

function flatten(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? '');
  return content.map((raw) => (typeof asRecord(raw)['text'] === 'string' ? String(asRecord(raw)['text']) : '')).join(' ');
}

function truncate(text: string, limit = 400): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}...` : flat;
}

// --- plumbing --------------------------------------------------------------

/** `--flag value` and `--flag=value`. Everything else is positional. */
function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[body] = next;
      i++;
    } else {
      flags[body] = 'true';
    }
  }
  return { positional, flags };
}

async function get(path: string): Promise<unknown> {
  return await call('GET', path);
}

async function post(path: string, body: unknown): Promise<unknown> {
  return await call('POST', path, body);
}

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  let response: Response;
  const headers: Record<string, string> = { authorization: `Bearer ${daemonToken()}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  try {
    response = await fetch(`${serverBaseUrl()}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (err) {
    throw new Error(`could not reach the daemon at ${serverBaseUrl()}. Start it with "conductor daemon". (${err instanceof Error ? err.message : String(err)})`);
  }
  return (await response.json()) as unknown;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

const code = await main(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`conductor: ${err instanceof Error ? err.message : String(err)}\n`);
  return 1;
});
// Setting exitCode rather than calling process.exit, because `undo` is the first command that makes
// two HTTP calls in one invocation and that combination crashes Node 24.11.1 on Windows:
// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\win\\async.c, line 76", with an
// exit code of 127 after the command had already printed the right answer. Reproduced outside
// Conductor with two bare fetch calls followed by process.exit, so it is the platform, not us.
// Letting the loop drain by itself exits immediately and cleanly. The unref'd timer is a safety net
// only: it can never hold the process open, and it exists so a future command that leaves a handle
// alive fails loudly rather than hanging a terminal forever.
if (code >= 0) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 5000).unref();
}
