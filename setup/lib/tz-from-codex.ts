/**
 * Headless Codex fallback for timezone resolution.
 *
 * When the user answers the UTC-confirmation prompt with something that
 * isn't a valid IANA zone ("NYC", "Jerusalem time", "eastern"), spawn
 * `codex exec` with a narrow prompt asking for a single IANA string and
 * validate the reply with `isValidTimezone` before returning it.
 */
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import * as p from '@clack/prompts';
import k from 'kleur';

import { isValidTimezone } from '../../src/timezone.js';
import { fitToWidth, fmtDuration } from './theme.js';

export function codexCliAvailable(): boolean {
  try {
    execSync('command -v codex', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ask headless Codex to map a free-text location/timezone description to
 * a valid IANA zone. Shows a spinner with elapsed time. Returns the
 * resolved zone string on success, or null if the CLI is missing, Codex
 * errored, or the reply wasn't a valid IANA zone.
 */
export async function resolveTimezoneViaCodex(input: string): Promise<string | null> {
  if (!codexCliAvailable()) return null;

  const prompt = buildPrompt(input);

  const s = p.spinner();
  const start = Date.now();
  const label = 'Looking up that timezone…';
  s.start(fitToWidth(label, ' (99m 59s)'));
  const tick = setInterval(() => {
    const suffix = ` (${fmtDuration(Date.now() - start)})`;
    s.message(`${fitToWidth(label, suffix)}${k.dim(suffix)}`);
  }, 1000);

  const reply = await queryCodex(prompt);

  clearInterval(tick);
  const suffix = ` (${fmtDuration(Date.now() - start)})`;

  const resolved = reply ? extractTimezone(reply) : null;
  if (resolved) {
    s.stop(`${fitToWidth(`Interpreted as ${resolved}.`, suffix)}${k.dim(suffix)}`);
    return resolved;
  }
  s.stop(`${fitToWidth("Couldn't interpret that as a timezone.", suffix)}${k.dim(suffix)}`, 1);
  return null;
}

function buildPrompt(input: string): string {
  return [
    "Convert the user's description of where they are into a single IANA",
    'timezone identifier (e.g. "America/New_York", "Europe/London",',
    '"Asia/Jerusalem"). Respond with ONLY the IANA string on a single line,',
    'nothing else: no prose, no quotes, no punctuation. If you cannot',
    'determine a zone with reasonable confidence, reply with exactly:',
    'UNKNOWN',
    '',
    `User's description: ${input}`,
  ].join('\n');
}

function queryCodex(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    const outputPath = path.join(os.tmpdir(), `nanoclaw-timezone-${process.pid}-${Date.now()}.txt`);
    const child = spawn(
      'codex',
      ['exec', '--sandbox', 'read-only', '--ephemeral', '--output-last-message', outputPath, '-'],
      { stdio: ['pipe', 'ignore', 'ignore'] },
    );
    let settled = false;
    const settle = (value: string | null): void => {
      if (settled) return;
      settled = true;
      try {
        fs.unlinkSync(outputPath);
      } catch {}
      resolve(value);
    };

    child.on('close', (code) => {
      const stdout = code === 0 && fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf-8') : '';
      settle(stdout.trim() ? stdout : null);
    });
    child.on('error', () => settle(null));

    child.stdin.end(prompt);
  });
}

function extractTimezone(reply: string): string | null {
  // Models sometimes prefix with a backtick or wrap in quotes despite
  // instructions; take the first line that looks like a zone.
  const lines = reply
    .split('\n')
    .map((l) => l.trim().replace(/^["'`]+|["'`]+$/g, ''))
    .filter(Boolean);
  for (const line of lines) {
    if (line === 'UNKNOWN') return null;
    if (isValidTimezone(line)) return line;
  }
  return null;
}
