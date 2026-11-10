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
import { assertTargetUrlAllowed, parseSchemeOptIn } from '../evidence/target-url.mjs';

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

// The opt-in is expressed the same way on every surface: `--allow-scheme <list>`
// inside the free-form flags string is the SAME flag the CLI's parseArgs reads, so
// an operator (or agent) says it once and both doors accept it (web-uplift-fs20).
function optInFromFlags(flags) {
  if (!flags) return [];
  const values = [];
  const re = /--allow-scheme[ =]([^\s]+)/g;
  let m;
  while ((m = re.exec(flags)) !== null) values.push(m[1]);
  return parseSchemeOptIn(values);
}

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
  async ({ url, flags }) => {
    // Target-URL scheme gate (web-uplift-fs20), the MCP door of the ONE allow-list:
    // without this, a caller-supplied file:/javascript:/data: url reached the agent
    // as instructions whose first navigation had no gate at all (the bug: flow
    // replay had a scheme check, the audited target did not). A refusal renders AS
    // the prompt, so the calling agent reads why instead of a skill it must not
    // run; the CLI's gather() still re-checks at the navigation boundary.
    let refusal = null;
    try {
      assertTargetUrlAllowed(url, { optInSchemes: optInFromFlags(flags) });
    } catch (err) {
      refusal = err.message;
    }
    const skill = await skillText();
    if (refusal) {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text:
                `${refusal}\n\n` +
                `Do not run the web-audit skill for this target: the URL was refused by the target-URL scheme gate before any browser was launched. ` +
                `Audit the http(s) URL the operator intended, or re-run with --allow-scheme <scheme> if this non-web target is deliberate.`,
            },
          },
        ],
      };
    }
    return {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `${skill}\n\n---\n\n` +
              `Follow the skill above with these arguments: ${url}${flags ? ` ${flags}` : ''}`,
          },
        },
      ],
    };
  }
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
