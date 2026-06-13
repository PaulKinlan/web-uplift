// Build the structured findings object (schema/findings.schema.json) and a
// human-readable markdown report from the raw detector output.

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

export function buildReport({ url, mode, pathResults, score }) {
  const findings = [];
  const paths = [];
  let idCounter = 1;

  for (const pr of pathResults) {
    paths.push({
      id: pr.pathId,
      description: `Scenario route #${pr.pathId}`,
      url: routeUrlFor(url, pr.pathId),
      conditions: pr.conditions,
      result: pr.findings.length ? 'issues' : 'pass',
    });
    for (const f of pr.findings) {
      findings.push({
        id: `F-${String(idCounter++).padStart(3, '0')}`,
        pathId: pr.pathId,
        url: routeUrlFor(url, pr.pathId),
        principleId: f.principleId,
        principleCheckId: f.principleCheckId,
        guidanceId: f.guidanceId,
        guidanceCategory: f.guidanceCategory,
        severity: f.severity,
        confidence: f.confidence,
        summary: f.summary,
        evidence: f.evidence,
        suggestedFix: f.suggestedFix,
        effort: f.effort,
        scenario: f.scenario,
      });
    }
  }

  // Prioritised, deduplicated task list (highest severity first).
  const sorted = [...findings].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
  const taskList = sorted.map((f, i) => ({
    id: `T-${String(i + 1).padStart(3, '0')}`,
    title: f.summary,
    priority: i + 1,
    findingIds: [f.id],
    guidanceId: f.guidanceId,
    status: 'open',
  }));

  const report = {
    url,
    auditedAt: new Date().toISOString(),
    mode: mode === 'fixed' ? 'report' : 'report',
    status: 'completed',
    page: { appType: 'spa', notes: 'Hash-routed playground SPA.' },
    paths,
    findings,
    taskList,
    budget: { pathCount: paths.length, auditPasses: 1 },
  };

  // Attach the eval score as a non-schema sidecar field (the schema is open to
  // additional properties at the top level).
  report.eval = score;
  return report;
}

function routeUrlFor(baseUrl, hash) {
  try {
    const u = new URL(baseUrl);
    u.hash = `#${hash}`;
    return u.toString();
  } catch {
    return baseUrl;
  }
}

export function renderMarkdown(report) {
  const lines = [];
  const s = report.eval;
  lines.push(`# web-uplift audit report`);
  lines.push('');
  lines.push(`- **URL:** ${report.url}`);
  lines.push(`- **Audited at:** ${report.auditedAt}`);
  lines.push(`- **Mode under test:** ${s?.mode ?? 'issues'}`);
  lines.push(`- **Status:** ${report.status}`);
  lines.push(`- **Browser:** system Chrome (headless) via Chrome DevTools Protocol (chrome-remote-interface)`);
  lines.push('');

  if (s) {
    lines.push('## Eval vs ground truth');
    lines.push('');
    if (s.mode === 'fixed') {
      lines.push(
        `Fixed mode false-positive check: expected **0** findings, got **${s.foundCount}**.`,
      );
      lines.push('');
      lines.push(`- **Precision:** ${(s.precision * 100).toFixed(0)}%`);
      if (s.spurious.length) {
        lines.push(`- **Spurious findings:** ${s.spurious.join(', ')}`);
      }
    } else {
      lines.push(
        `| Metric | Value |`,
        `|---|---|`,
        `| Expected scenarios | ${s.expectedCount} |`,
        `| Detected (true positives) | ${s.truePositives} |`,
        `| Missed (false negatives) | ${s.falseNegatives} |`,
        `| Spurious (false positives) | ${s.falsePositives} |`,
        `| **Precision** | **${(s.precision * 100).toFixed(0)}%** |`,
        `| **Recall** | **${(s.recall * 100).toFixed(0)}%** |`,
      );
      lines.push('');
      if (s.missed.length) lines.push(`- **Missed:** ${s.missed.join(', ')}`);
      if (s.spurious.length) lines.push(`- **Spurious:** ${s.spurious.join(', ')}`);
      if (s.principleAlignment?.length) {
        lines.push('');
        lines.push('Principle alignment (ground truth uses pre-rename ids; mapped to current):');
        lines.push('');
        lines.push('| Scenario | Expected principle | Found principle | Aligned |');
        lines.push('|---|---|---|---|');
        for (const a of s.principleAlignment) {
          lines.push(
            `| ${a.scenario} | ${a.expectedPrinciple} | ${a.foundPrinciple} | ${a.aligned ? 'yes' : 'no'} |`,
          );
        }
      }
    }
    lines.push('');
  }

  lines.push(`## Findings (${report.findings.length})`);
  lines.push('');
  if (!report.findings.length) {
    lines.push('_No findings._');
  }
  for (const f of report.findings) {
    lines.push(`### ${f.id} - ${f.summary}`);
    lines.push('');
    lines.push(`- **Severity:** ${f.severity}${f.confidence ? ` (confidence ${f.confidence})` : ''}`);
    lines.push(`- **Principle:** ${f.principleId} / ${f.principleCheckId}`);
    if (f.guidanceId) {
      lines.push(`- **Guidance:** ${f.guidanceId}${f.guidanceCategory ? ` (${f.guidanceCategory})` : ''}`);
    }
    lines.push(`- **Path:** ${f.url}`);
    lines.push(`- **Evidence:** ${f.evidence}`);
    lines.push(`- **Suggested fix:** ${f.suggestedFix}`);
    lines.push('');
  }

  lines.push('## Prioritised task list');
  lines.push('');
  if (!report.taskList.length) {
    lines.push('_Nothing to fix._');
  }
  for (const t of report.taskList) {
    lines.push(
      `${t.priority}. ${t.title}${t.guidanceId ? ` (guidance: ${t.guidanceId})` : ''} - ${t.findingIds.join(', ')}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
