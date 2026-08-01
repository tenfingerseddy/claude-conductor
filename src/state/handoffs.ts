// handoffs/, one markdown file per finished task. This is the memory a fresh cut carries forward,
// so the format is plain markdown a human can read and a later session can be handed verbatim.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Config } from '../config.ts';

export interface Handoff {
  /** Short title of the task this note closes. Becomes the filename slug. */
  task: string;
  whatWasDone: string;
  whatMatters: string;
  openThreads: string[];
  followUps: string[];
}

const SECTIONS = [
  ['What was done', 'whatWasDone'],
  ['What matters', 'whatMatters'],
  ['Open threads', 'openThreads'],
  ['Follow-up tasks', 'followUps'],
] as const;

/** Writes the note and returns its absolute path. Never throws into the caller. */
export function writeHandoff(config: Config, handoff: Handoff, at: Date = new Date()): string | null {
  const path = join(config.handoffsDir, `${stamp(at)}-${slug(handoff.task)}.md`);
  try {
    mkdirSync(config.handoffsDir, { recursive: true });
    writeFileSync(path, render(handoff, at), 'utf8');
    return path;
  } catch (err) {
    process.stderr.write(`conductor: could not write handoff to "${path}": ${String(err)}\n`);
    return null;
  }
}

/** Reads a note back into its shape. Returns null rather than throwing on anything unexpected. */
export function readHandoff(path: string): Handoff | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    process.stderr.write(`conductor: could not read handoff at "${path}": ${String(err)}\n`);
    return null;
  }

  const bodies = new Map<string, string>();
  let current: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (current) bodies.set(current, buffer.join('\n').trim());
    buffer = [];
  };

  for (const line of text.split(/\r?\n/)) {
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading?.[1]) {
      flush();
      current = heading[1].trim();
    } else if (current) {
      buffer.push(line);
    }
  }
  flush();

  const title = /^#\s+(.*)$/m.exec(text)?.[1]?.trim();
  return {
    task: title ?? basename(path, '.md'),
    whatWasDone: bodies.get('What was done') ?? '',
    whatMatters: bodies.get('What matters') ?? '',
    openThreads: bullets(bodies.get('Open threads')),
    followUps: bullets(bodies.get('Follow-up tasks')),
  };
}

/** Handoff file paths, oldest first. The timestamp prefix makes filename order time order. */
export function listHandoffs(config: Config): string[] {
  if (!existsSync(config.handoffsDir)) return [];
  try {
    return readdirSync(config.handoffsDir)
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((f) => join(config.handoffsDir, f));
  } catch (err) {
    process.stderr.write(`conductor: could not list "${config.handoffsDir}": ${String(err)}\n`);
    return [];
  }
}

function render(handoff: Handoff, at: Date): string {
  const out = [`# ${handoff.task.trim() || 'Untitled task'}`, '', `Finished ${at.toISOString()}`, ''];
  for (const [heading, key] of SECTIONS) {
    const value = handoff[key];
    const body = Array.isArray(value)
      ? value.map((v) => `- ${v.trim()}`).join('\n') || '- none'
      : value.trim() || 'none';
    out.push(`## ${heading}`, '', body, '');
  }
  return out.join('\n');
}

function bullets(body: string | undefined): string[] {
  if (!body) return [];
  return body
    .split(/\r?\n/)
    .map((l) => l.replace(/^[-*]\s+/, '').trim())
    .filter((l) => l.length > 0 && l.toLowerCase() !== 'none');
}

// Colons are illegal in Windows filenames, so the ISO stamp is flattened rather than used raw.
function stamp(at: Date): string {
  return at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function slug(task: string): string {
  const s = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return s || 'task';
}
