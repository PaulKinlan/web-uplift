# Task for worker

You are a delegated subagent running from a fork of the parent session. Treat the inherited conversation as reference-only context, not a live thread to continue. Do not continue or answer prior messages as if they are waiting for a reply. Your sole job is to execute the task below and return a focused result for that task using your tools.

Task:
Add new evidence primitives to the web-uplift project at /home/paulkinlan/web-uplift. 

Read these files first:
- /home/paulkinlan/state-of-the-web/results/PROPOSED-NEW-TESTS.md (the 10 proposed tests)
- /home/paulkinlan/web-uplift/evidence/cli.mjs (the existing evidence CLI — study how existing primitives like `har`, `discoverability`, `layout` are structured, and follow the same pattern)
- /home/paulkinlan/web-uplift/evidence/cdp.mjs (the CDP helpers: navigate, evaluate, sleep, launchChrome, newSession)

The `secrets` primitive is ALREADY added (don't redo it). Implement these NEW primitives in evidence/cli.mjs, following the exact same code pattern as existing primitives:

1. **headers** — fetch the main document's response headers and analyze security posture: Content-Security-Policy (present? unsafe-inline/unsafe-eval?), Strict-Transport-Security (max-age, includeSubDomains, preload), X-Content-Type-Options, X-Frame-Options/CSP frame-ancestors, Referrer-Policy, Permissions-Policy. Use CDP Network domain to get response headers. Return a structured summary.

2. **cookies** — use CDP Network.getCookies after page load. Audit each cookie: Secure flag, SameSite (Strict/Lax/None), HttpOnly, expiry duration, whether it's third-party. Return structured findings.

3. **trackers** — collect all third-party request origins during page load (use Network domain), match against a small built-in list of known tracker domains (google-analytics, doubleclick, facebook.net, hotjar, segment, mixpanel, etc.), count distinct third parties and total bytes. Return a summary.

4. **images** — use evaluate() to inspect all <img> elements: check for width/height attributes (CLS risk), loading="lazy" below the fold, oversized images (naturalWidth >> displayed width), missing srcset, modern formats (avif/webp vs jpg/png). Return structured findings.

For each: add the function, register it in the PRIMITIVES object, update the usage string, and add a row to the primitives table in /home/paulkinlan/web-uplift/.claude/skills/web-audit/SKILL.md documenting what it does and which principle it feeds.

Test each primitive works: `node evidence/cli.mjs <primitive> <url>` should return valid JSON.

Commit and push to origin master when done.

## Acceptance Contract
Acceptance level: reviewed
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Implement the requested change without widening scope
- criterion-2: Return evidence sufficient for an independent acceptance review

Required evidence: changed-files, tests-added, commands-run, validation-output, residual-risks, no-staged-files

Review gate: required by reviewer.

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```