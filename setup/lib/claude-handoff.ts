/**
 * User-initiated handoff to Codex, parallel to claude-assist.ts.
 *
 * claude-assist is for failures: it runs Codex non-interactively, parses
 * a suggested command, and offers to run it. This module is for the opposite
 * case — the user is mid-flow, not stuck on an error, and wants Codex to
 * walk them through something the driver can't fully automate (Azure portal
 * clickthrough, writing a manifest, tunneling a port, etc.).
 *
 * Flow:
 *   1. Build a handoff prompt from the caller's context: channel, current
 *      step, completed steps, collected values (secrets redacted), relevant
 *      files to read.
 *   2. Spawn `codex exec` with the handoff context on stdin.
 *   3. When Codex exits,
 *      control returns to the setup driver. The driver can then re-offer the
 *      same step (e.g., "How did that go?" select).
 *
 * Also exports a small helper for text/password prompts: `validateWithHelpEscape`
 * wraps a validate callback so typing `?` triggers the handoff instead of
 * attempting to parse it as a real answer.
 */
import { spawn } from 'child_process';
import path from 'path';

import * as p from '@clack/prompts';
import {
  type AssistContext,
  BIG_PICTURE_FILES,
  isSetupAssistEnabled,
  ensureCodexReady,
  offerClaudeAssist,
  STEP_FILES,
} from './claude-assist.js';
import { ensureAnswer } from './runner.js';
import { brandBody, note } from './theme.js';

export interface HandoffContext {
  /** Channel this handoff is happening in (e.g., 'teams'). */
  channel: string;
  /** Short name of the current step the user is stuck on. */
  step: string;
  /** Human-readable summary of what the user was trying to do at this step. */
  stepDescription: string;
  /** Checklist of sub-steps already completed (displayed as `✓ <item>`). */
  completedSteps?: string[];
  /**
   * Key/value pairs of values collected so far. Callers should redact
   * secrets before passing (e.g., show last 4 chars). Used to give Codex
   * the state of the operator's progress.
   */
  collectedValues?: Record<string, string>;
  /**
   * Repo-relative paths Codex should consider reading. Always gets
   * logs/setup.log and the relevant SKILL.md appended by the builder.
   */
  files?: string[];
}

/**
 * Ask Codex for contextual help. Returns when Codex exits.
 */
export async function offerClaudeHandoff(ctx: HandoffContext): Promise<boolean> {
  if (!isSetupAssistEnabled()) return false;
  if (!(await ensureCodexReady())) return false;

  const systemPrompt = buildSystemPrompt(ctx);

  note(
    ["I'm asking Codex to help with this setup step.", 'It has the context of where you are in setup.'].join('\n'),
    'Asking Codex',
  );

  return new Promise<boolean>((resolve) => {
    const child = spawn('codex', ['exec', '--cd', process.cwd(), '--sandbox', 'danger-full-access', '-'], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    child.stdin?.end(systemPrompt);
    child.on('close', () => {
      p.log.success(brandBody("Back from Codex. Let's continue."));
      resolve(true);
    });
    child.on('error', () => {
      p.log.error("Couldn't launch Codex. Continuing without handoff.");
      resolve(false);
    });
  });
}

/**
 * Sentinel returned by `validateWithHelpEscape` when the user types `?`.
 * The caller compares against this to decide whether to trigger a handoff.
 */
export const HELP_ESCAPE_SENTINEL = '__NANOCLAW_HELP_ESCAPE__';

/**
 * Wrap a clack `validate` callback so typing `?` short-circuits validation
 * and returns the HELP_ESCAPE_SENTINEL. Caller should check for the sentinel
 * after awaiting the prompt and trigger offerClaudeHandoff if matched.
 *
 * Usage:
 *   const answer = await p.text({
 *     message: 'Paste your Azure App ID',
 *     validate: validateWithHelpEscape((v) => {
 *       if (!/^[0-9a-f-]{36}$/.test(v)) return 'Expected a UUID';
 *       return undefined;
 *     }),
 *   });
 *   if (answer === HELP_ESCAPE_SENTINEL) { await offerClaudeHandoff(ctx); ... }
 */
export function validateWithHelpEscape(
  inner?: (value: string) => string | Error | undefined,
): (value: string) => string | Error | undefined {
  return (value: string) => {
    if ((value ?? '').trim() === '?') {
      // Returning undefined lets clack accept the `?` as the "answer". The
      // caller sees a literal "?" and should compare + escape to handoff.
      return undefined;
    }
    return inner ? inner(value) : undefined;
  };
}

/**
 * True if the value returned by a text/password prompt should trigger a
 * handoff. Abstracts the sentinel check so callers don't have to import it
 * directly at every site.
 */
export function isHelpEscape(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === '?';
}

function buildSystemPrompt(ctx: HandoffContext): string {
  const lines: string[] = [
    `The user is running NanoClaw's interactive \`setup:auto\` flow to wire the ${ctx.channel} channel.`,
    `They got stuck at the step: "${ctx.step}" (${ctx.stepDescription}) and asked for help.`,
    '',
    'Your job: help them complete this specific step and get back to setup.',
    'You can read files, run commands, search the web, and explain concepts.',
    'Be concise. End with the exact next action the user should take in setup.',
    '',
  ];

  if (ctx.completedSteps && ctx.completedSteps.length > 0) {
    lines.push('Steps they have already completed:');
    for (const s of ctx.completedSteps) lines.push(`  ✓ ${s}`);
    lines.push('');
  }

  if (ctx.collectedValues && Object.keys(ctx.collectedValues).length > 0) {
    lines.push('Values collected so far (secrets redacted):');
    for (const [k, v] of Object.entries(ctx.collectedValues)) {
      lines.push(`  ${k}: ${v}`);
    }
    lines.push('');
  }

  const files = [
    ...(ctx.files ?? []),
    'logs/setup.log',
    'logs/setup-steps/',
    `.agents/skills/add-${ctx.channel}/SKILL.md`,
    `setup/channels/${ctx.channel}.ts`,
  ].filter((v, i, a) => a.indexOf(v) === i);

  lines.push('Relevant files (read as needed):');
  for (const f of files) lines.push(`  - ${f}`);

  return lines.join('\n');
}

/**
 * Drop-in replacement for `offerClaudeAssist` at failure call sites.
 */
export async function offerClaudeOnFailure(ctx: AssistContext, projectRoot: string = process.cwd()): Promise<boolean> {
  return offerClaudeAssist(ctx, projectRoot);
}

/**
 * Interactive Codex handoff for setup failures. Same role as
 * `offerClaudeAssist` but spawns an interactive session instead of
 * parsing a structured REASON/COMMAND response.
 *
 * Returns `true` if Codex was launched (the user may have fixed
 * things during the session), `false` if skipped/declined/unavailable.
 */
async function offerFailureHandoff(ctx: AssistContext, projectRoot: string): Promise<boolean> {
  if (!isSetupAssistEnabled()) return false;
  if (!(await ensureCodexReady())) return false;

  const want = ensureAnswer(
    await p.confirm({
      message: 'Want to debug this with Codex?',
      initialValue: true,
    }),
  );
  if (!want) return false;

  const systemPrompt = buildFailureSystemPrompt(ctx, projectRoot);

  note(
    ['Launching Codex to help debug this failure.', 'It has the context of what went wrong.'].join('\n'),
    'Asking Codex',
  );

  return new Promise<boolean>((resolve) => {
    const child = spawn('codex', ['exec', '--cd', projectRoot, '--sandbox', 'danger-full-access', '-'], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    child.stdin?.end(systemPrompt);
    child.on('close', () => {
      p.log.success(brandBody("Back from Codex. Let's continue."));
      resolve(true);
    });
    child.on('error', () => {
      p.log.error("Couldn't launch Codex. Continuing without handoff.");
      resolve(false);
    });
  });
}

function buildFailureSystemPrompt(ctx: AssistContext, projectRoot: string): string {
  const stepRefs = STEP_FILES[ctx.stepName] ?? [];
  const references = [
    ...BIG_PICTURE_FILES,
    ...stepRefs,
    'logs/setup.log',
    ctx.rawLogPath ? path.relative(projectRoot, ctx.rawLogPath) : 'logs/setup-steps/',
  ].filter((v, i, a) => a.indexOf(v) === i);

  const lines: string[] = [
    "The user is running NanoClaw's interactive setup flow and hit a failure.",
    '',
    `Failed step: ${ctx.stepName}`,
    `Error: ${ctx.msg}`,
  ];

  if (ctx.hint) lines.push(`Hint: ${ctx.hint}`);

  lines.push(
    '',
    'Your job: help them diagnose and fix this issue. Read the referenced files',
    'and logs to understand what went wrong, then help them fix it. You can read',
    'files, run commands, check logs, and explain what happened. Be concise.',
    'End with the exact next action the user should take in setup.',
    '',
    'Relevant files (read as needed with the Read tool):',
  );
  for (const f of references) lines.push(`  - ${f}`);

  return lines.join('\n');
}
