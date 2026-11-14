#!/usr/bin/env node
/**
 * Minimal MCP server that distributes this project's skills to any MCP
 * client, instead of (or alongside) the per-CLI wrapper files.
 *
 * Exposes the canonical web-audit skill two ways:
 *  - an MCP *prompt* - surfaces as a slash command in hosts that support
 *    prompt discovery (Claude Code: /mcp__web-uplift__web-audit,
 *    Gemini CLI similarly; Codex pending openai/codex#8342)
 *  - a skill:// *resource* - the SEP-2640 "Skills Extension" convention,
 *    so hosts that implement skills-over-MCP auto-discover the SKILL.md
 *
 * Run: node mcp/skills-server.mjs (stdio transport; registered in
 * .mcp.json / .gemini/settings.json / .codex/config.toml)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFile } from 'node:fs/promises';
import { untrustedArgumentBlock } from '../runner/untrusted.mjs';
import { z } from 'zod';

const SKILL_PATH = new URL('../.claude/skills/web-audit/SKILL.md', import.meta.url);
const DESCRIPTION =
  'Audit a URL for modern web quality, fully agentically: the model gathers ' +
  'multi-modal evidence via generic raw-CDP primitives, chooses its own tools ' +
  '(Lighthouse, axe, ad-hoc probes), reasons over it, and judges every ' +
  'principle (Una Kravets five + the Lighthouse dimensions) against Modern Web ' +
  'Guidance, emitting structured findings plus a prioritised task list. --fix ' +
  'writes guidance-backed fixes to local source and re-audits. No hard-coded ' +
  'checks, no fast path.';

const skillText = () => readFile(SKILL_PATH, 'utf8');

const server = new McpServer({ name: 'web-uplift', version: '0.1.0' });

server.registerPrompt(
  'web-audit',
  {
    description: DESCRIPTION,
    argsSchema: {
      url: z.string().describe('The URL to audit'),
      flags: z
        .string()
        .optional()
        .describe(
          'Optional flags: --out <dir> | --source <dir> | --fix | --findings <path> | --max-iterations <n> | --expected <file>'
        ),
    },
  },
  async ({ url, flags }) => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text:
            `${await skillText()}\n\n---\n\n` +
            // The url and flags are CALLER-SUPPLIED and land in the instructions of a write-capable agent, so they
            // are DATA here, not instruction text (web-uplift-8m4y, web-uplift-d3a6). Same helper as the runner's
            // prompts: a second local escaping rule at this call site is the drift this pair exists to prevent.
            //
            // STRUCTURE only, no scheme policy, and that is deliberate (web-uplift-oxw2, web-uplift-sz7g): this
            // prompt forwards its target to the gated CLI, which owns the scheme decision and is the single
            // enforcement point - tests/target-url.test.mjs pins that the chain lands there for file:// and
            // javascript: alike. Refusing a scheme HERE would duplicate policy at the surface and break that
            // funnel, which is why the helper's scheme check belongs to the runner's own prompt, where the runner
            // owns the audit set.
            `Follow the skill above with ${untrustedArgumentBlock(
              [url, ...(flags ? [flags] : [])],
              { label: 'UNTRUSTED CALLER ARGUMENTS' },
            )}`,
        },
      },
    ],
  })
);

server.registerResource(
  'web-audit-skill',
  'skill://web-audit/SKILL.md',
  {
    title: 'web-audit skill',
    description: DESCRIPTION,
    mimeType: 'text/markdown',
  },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'text/markdown', text: await skillText() }],
  })
);

await server.connect(new StdioServerTransport());
