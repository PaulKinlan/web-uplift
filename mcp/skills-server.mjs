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
import { z } from 'zod';

const SKILL_PATH = new URL('../.claude/skills/web-audit/SKILL.md', import.meta.url);
const DESCRIPTION =
  'Audit a URL for modern web UX quality: explore the site, write a per-site ' +
  'test plan, evaluate against modern-UX principles and Modern Web Guidance, ' +
  'and emit structured findings plus a prioritised task list. --fix applies ' +
  'guidance-backed fixes to local source and re-audits.';

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
          'Optional flags: --plan-only | --path <id> | --out <dir> | --replan | --fix | --source <dir>'
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
            `Follow the skill above with these arguments: ${url}${flags ? ` ${flags}` : ''}`,
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
