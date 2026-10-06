// OS-level isolation for headless fix mode.
//
// WHY: fix mode drives an agent whose prompt context carries untrusted page
// content while that agent holds file-write tools and a provider credential. The
// snapshot/diff/refuse tripwire in runner-side `write-scope.mjs` only NOTICES a
// write after it happened, and it explicitly cannot cover everything. This module
// is the boundary: the agent is launched as a child whose filesystem view is built
// for it, empty to start with and populated path by path.
//
// WHAT IT IS: bubblewrap (bwrap) is the mandatory launcher for headless fix mode.
// It builds an empty mount namespace; nothing of the host is visible except what is
// bound below. An `unshare --user --mount` layout is accepted as a fallback ONLY
// when it builds and passes the SAME probe (private mounts plus pivot_root);
// presence of a binary is never taken as proof. Otherwise the run is REFUSED
// before any agent spawns - fail closed, never "run anyway and hope".
//
// MOUNT CONTRACT (see buildPlan):
//   read-write, host-backed : the --target source tree and this run's --out dir.
//   read-only               : the project tree (skill + vendored tool + everything
//                             else the audit reads), the agent executable and its
//                             runtime closure, node, Chrome, ffmpeg, system
//                             binaries/libraries, CA certs, resolver config, fonts.
//                             .git, node_modules, .web-uplift and the report history
//                             are re-bound READ-ONLY even when nested inside the
//                             read-write --target, so a target that IS the project
//                             root cannot be used to rewrite the tooling or the
//                             published results.
//   private writable, not host-backed : /tmp, an empty HOME, Chrome scratch.
//   virtual                 : /proc in a PID namespace, /dev, /dev/shm.
//   NOT MOUNTED             : other checkouts, the real HOME, SSH/cloud/git
//                             credentials, container sockets, unrelated secrets and
//                             the host report tree. Only the provider credential a
//                             particular agent CLI needs is bound, read-only, at its
//                             expected path.
//
// WHAT THIS DOES NOT DO - stated here, in the refusal/override text and in the
// run record, because claiming otherwise would be a lie:
//   * NETWORK. The network namespace is deliberately RETAINED (bwrap unshares it by
//     default, so this module passes --share-net explicitly): a legitimate fix must
//     reach the audited page, the guidance feed and the provider. So this sandbox
//     does NOT stop SSRF, cloud-metadata access, arbitrary egress, or exfiltration
//     of the credential handed to the child. Those need host/VM egress controls;
//     the hardened evidence-fetch checks and the pinned `--ignore-scripts` guidance
//     invocation remain the in-process mitigations.
//   * The provider CLI still receives a credential that can be exfiltrated over the
//     network it is allowed to use.
//   * Anything the child writes inside its read-write mounts is real: this is
//     isolation FROM the rest of the host, not a scratch copy of the target.
//
// OVERRIDE: --allow-unsandboxed-agent keeps a run possible on a host with no
// provider. It is recorded as an explicit, section-7-style accepted risk - never as
// I4 compliance - and it is loud: a warning on stderr and an atomic marker written
// BEFORE the first spawn, which also travels into the retained result.

import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveChromePath } from '../evidence/cdp.mjs';

// Read-only system surface: enough to run a dynamically linked binary, resolve
// DNS, validate TLS and render text. Deliberately not the whole root.
const SYSTEM_RO = [
  '/usr', '/bin', '/sbin', '/lib', '/lib64',
  '/etc/ssl', '/etc/ca-certificates', '/etc/fonts', '/etc/hosts', '/etc/resolv.conf',
  '/etc/nsswitch.conf', '/etc/passwd', '/etc/group', '/etc/localtime', '/etc/ld.so.cache',
];

// Nested inside --target these must stay READ-ONLY even though the target itself is
// writable: the vendored tool and dependency tree are executed by later steps, the
// git directory carries hooks, and reports/ carries the published run pointers.
const PROTECTED_NAMES = ['.git', 'node_modules', '.web-uplift', 'reports'];

// Credential locations per agent CLI. Bound read-only, at the host path and inside
// the private HOME, so an agent that resolves either way still authenticates.
const PROVIDER_AUTH = {
  claude: ['.claude'],
  codex: ['.codex'],
  gemini: ['.gemini'],
  agy: ['.gemini'],
  pi: ['.pi'],
  opencode: ['.config/opencode', '.local/share/opencode'],
  copilot: ['.config/github-copilot'],
};

// Environment keys worth passing through. Everything else is dropped: the child
// does not inherit the operator's environment, so a stray secret in a shell does
// not travel into a process that a page can influence.
const ENV_ALLOW = ['PATH', 'LANG', 'LANGUAGE', 'LC_ALL', 'TZ', 'TERM'];

export const SANDBOX_HOME = '/run/web-uplift-home';

function realOrNull(p) {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Everything the plan needs, with paths resolved and symlinks followed, so the
// launch uses exactly what was validated.
export function buildPlan({ projectRoot, targetDir, outDir, agentName, agentBin, extraReadOnly = [] }) {
  const notes = [];
  const refuse = (reason) => notes.push({ level: 'refuse', reason });
  const warn = (reason) => notes.push({ level: 'warn', reason });

  const root = realOrNull(projectRoot);
  const target = realOrNull(targetDir);
  const out = realOrNull(outDir);
  if (!root) refuse(`project root is not a readable directory: ${projectRoot}`);
  if (!target) refuse(`--target is not a readable directory: ${targetDir}`);
  if (!out) refuse(`--out cannot be resolved: ${outDir}`);
  if (target && out && target === out) {
    refuse('--target and --out resolve to the same directory: a run that writes its report into its own editable source tree cannot be scoped');
  }
  if (root && target && !(target === root || target.startsWith(root + sep))) {
    warn('--target is outside the project root: the tool tree and --out are mounted separately, so only those two are writable');
  }

  const ro = [];
  for (const p of SYSTEM_RO) if (existsSync(p)) ro.push(p);

  // The agent executable and the node it runs on: bind the resolved paths, not
  // $HOME wholesale.
  const binReal = realOrNull(agentBin);
  if (binReal) {
    ro.push(binReal);
    const binDir = dirname(binReal);
    if (isDir(binDir)) ro.push(binDir);
  } else {
    refuse(`agent executable cannot be resolved: ${agentBin}`);
  }
  const nodeReal = realOrNull(process.execPath);
  if (nodeReal) {
    ro.push(nodeReal);
    const prefix = resolve(dirname(nodeReal), '..');
    if (isDir(prefix)) ro.push(prefix); // the whole node install (bin/lib/include/share)
  }

  // The project tree read-only, minus nothing: the audit's skill, vendored CLI,
  // schemas and knowledge all live here.
  if (root) ro.push(root);

  for (const p of extraReadOnly) {
    const r = realOrNull(p);
    if (r) ro.push(r);
  }

  // Chrome (for the evidence primitives) and a bounded slice of its cache dir.
  const chrome = (() => {
    try {
      return resolveChromePath();
    } catch {
      return null;
    }
  })();
  if (chrome) {
    const c = realOrNull(chrome);
    if (c) ro.push(c);
    const cacheRoot = dirname(dirname(dirname(c ?? '')));
    if (cacheRoot && cacheRoot !== '/' && isDir(cacheRoot)) ro.push(cacheRoot);
  } else {
    warn('no Chrome resolved: the evidence primitives that need a browser will fail inside the sandbox');
  }

  // Provider credentials, read-only.
  const auth = [];
  for (const rel of PROVIDER_AUTH[agentName] ?? []) {
    const host = join(process.env.HOME ?? '/root', rel);
    if (existsSync(host)) auth.push(host);
  }
  if (auth.length === 0) {
    warn(`no ${agentName} credential directory found: the provider may fail to authenticate inside the sandbox`);
  }

  // Protected paths nested under the writable target.
  const protectedPaths = [];
  if (target) {
    for (const name of PROTECTED_NAMES) {
      const p = join(target, name);
      if (existsSync(p)) {
        const r = realOrNull(p);
        if (!r) continue;
        if (r === target) continue;
        // A symlinked protected dir pointing outside the project is exactly the
        // defeat this layer must not accept: the read-only bind would land on the
        // link, not the real tree.
        if (r !== p && root && !(r === root || r.startsWith(root + sep))) {
          refuse(`${name} under --target is a symlink to ${r}, outside the project: it cannot be protected read-only`);
          continue;
        }
        protectedPaths.push({ path: p, real: r, name });
      }
    }
  }

  const env = {};
  for (const k of ENV_ALLOW) if (process.env[k] !== undefined) env[k] = process.env[k];
  const nodeBinDir = nodeReal ? dirname(nodeReal) : null;
  env.PATH = [nodeBinDir, '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean).join(':');
  env.HOME = SANDBOX_HOME;
  env.TMPDIR = '/tmp';

  return {
    projectRoot: root ?? projectRoot,
    targetDir: target ?? targetDir,
    outDir: out ?? outDir,
    ro: [...new Set(ro)],
    rw: [target, out].filter(Boolean),
    protectedPaths,
    auth,
    chrome: chrome ? realOrNull(chrome) : null,
    env,
    notes,
    refused: notes.some((n) => n.level === 'refuse'),
  };
}

// The bwrap argv for a plan. Mount order matters: later binds win, so the writable
// target is bound after the read-only project, and the read-only protections (and
// the writable --out) are bound after that.
export function bwrapArgs(plan, command, argv = []) {
  const a = [
    '--die-with-parent',
    '--new-session',
    '--unshare-pid', '--unshare-uts', '--unshare-ipc', '--unshare-cgroup',
    // bwrap UNSHARES the network namespace by default, so retaining it must be
    // explicit. A fix run needs the audited page, the guidance feed and the
    // provider; a sandbox that silently cut the network would break every real run
    // (and did, until the browser-driven test caught it). See the network section
    // of the header: this boundary does NOT restrict egress.
    '--share-net',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--tmpfs', '/dev/shm',
    '--tmpfs', '/run',
    '--dir', SANDBOX_HOME,
  ];
  for (const p of plan.ro) a.push('--ro-bind', p, p);
  if (plan.projectRoot) a.push('--ro-bind', plan.projectRoot, plan.projectRoot);
  for (const authPath of plan.auth) {
    a.push('--ro-bind', authPath, authPath);
    a.push('--ro-bind', authPath, join(SANDBOX_HOME, authPath.split(sep).pop()));
  }
  // Order is load-bearing. Bind the writable --target tree, THEN re-bind the
  // protected paths inside it read-only, THEN bind --out. If --out sits under a
  // protected name (the default `reports/fix-<host>` case, with --target at the
  // project root) it must win over that read-only re-bind, and it can only win by
  // being bound after it.
  const [targetBind, ...otherRw] = plan.rw;
  if (targetBind) a.push('--bind', targetBind, targetBind);
  for (const p of plan.protectedPaths) a.push('--ro-bind', p.real, p.path);
  for (const p of otherRw) a.push('--bind', p, p);
  a.push('--chdir', plan.projectRoot);
  for (const [k, v] of Object.entries(plan.env)) a.push('--setenv', k, v);
  a.push('--', command, ...argv);
  return a;
}

// The unshare fallback builds the SAME layout and then pivot_roots into it. It is
// only ever used when its own probe passes; a bare `unshare` proves nothing.
export function unshareScript(plan, command, argv = []) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const lines = [
    'set -e',
    'root=$(mktemp -d /tmp/uplift-root.XXXXXX)',
    'mount --make-rprivate / 2>/dev/null || true',
    `mkdir -p "$root"${['/proc', '/dev', '/tmp', '/run', SANDBOX_HOME, ...plan.ro, ...plan.rw, ...plan.protectedPaths.map((p) => p.path)].map((p) => ` "$root${p}"`).join('')}`,
    `mount -t tmpfs none "$root/tmp"`,
    `mount -t tmpfs none "$root/run"`,
  ];
  for (const p of plan.ro) lines.push(`mount --bind ${q(p)} "$root${p}" && mount -o remount,bind,ro ${q(p)} "$root${p}"`);
  if (plan.projectRoot) lines.push(`mount --bind ${q(plan.projectRoot)} "$root${plan.projectRoot}" && mount -o remount,bind,ro ${q(plan.projectRoot)} "$root${plan.projectRoot}"`);
  for (const authPath of plan.auth) lines.push(`mount --bind ${q(authPath)} "$root${authPath}" && mount -o remount,bind,ro ${q(authPath)} "$root${authPath}"`);
  // Same load-bearing order as bwrapArgs: target, then protections, then --out.
  const [targetBind, ...otherRw] = plan.rw;
  if (targetBind) lines.push(`mount --bind ${q(targetBind)} "$root${targetBind}"`);
  for (const p of plan.protectedPaths) lines.push(`mount --bind ${q(p.real)} "$root${p.path}" && mount -o remount,bind,ro ${q(p.real)} "$root${p.path}"`);
  for (const p of otherRw) lines.push(`mount --bind ${q(p)} "$root${p}"`);
  lines.push('mount -t proc proc "$root/proc"');
  lines.push('mount --rbind /dev "$root/dev"');
  lines.push(`cd "$root" && pivot_root . . && exec chroot . /bin/sh -c ${q(['exec', command, ...argv].map(q).join(' '))}`);
  return lines.join('\n');
}

// The probe needs the two path lists in the child; they travel in the plan's env
// so the command stays one plain `/bin/sh -c` string.
//
// The read-only list is the paths that are SUPPOSED to be read-only, which is not
// simply "the project root": when --target IS the project root, the project tree is
// the writable one by contract, and only the protected paths nested inside it must
// refuse a write. Getting this wrong makes the probe demand the impossible.
function probeEnv(plan) {
  const target = plan.targetDir;
  const protectedPaths = new Set(plan.protectedPaths.map((p) => p.path));
  const insideTarget = (p) => target && (p === target || p.startsWith(target + sep));
  const ro = [plan.projectRoot, ...protectedPaths]
    .filter((p) => p && (protectedPaths.has(p) || !insideTarget(p)));
  return {
    UPLIFT_PROBE_RW: plan.rw.filter(Boolean).join(' '),
    UPLIFT_PROBE_RO: [...new Set(ro)].join(' '),
  };
}

function probeCommand() {
  // The probe asserts the CONTRACT, not that a binary exists: the writable roots
  // must be writable, and the project tree plus every protected path must NOT be.
  return [
    'set -e',
    'for d in $UPLIFT_PROBE_RW; do t="$d/.uplift-probe-$$"; printf x > "$t" || { echo "not writable: $d"; exit 3; }; rm -f "$t"; done',
    'for d in $UPLIFT_PROBE_RO; do [ -r "$d" ] || { echo "not readable: $d"; exit 4; }; t="$d/.uplift-probe-$$"; if printf x > "$t" 2>/dev/null; then rm -f "$t"; echo "writable but should be read-only: $d"; exit 5; fi; done',
    'echo PROBE-OK',
  ].join('; ');
}

// Runs the real launcher against a synthetic probe. Returns {ok, provider, detail}.
export function probeProvider(provider, plan, { spawn = spawnSync } = {}) {
  const argv = provider === 'bwrap'
    ? ['bwrap', ...bwrapArgs(plan, '/bin/sh', ['-c', probeCommand()])]
    : ['unshare', '--user', '--map-root-user', '--mount', '--pid', '--fork', '--', 'sh', '-c', unshareScript(plan, '/bin/sh', ['-c', probeCommand()])];
  let res;
  try {
    res = spawn(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...plan.env, ...probeEnv(plan) } });
  } catch (err) {
    return { ok: false, provider, detail: `launch failed: ${err.message}` };
  }
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim().split('\n').slice(-3).join(' | ');
  const ok = res.status === 0 && /PROBE-OK/.test(res.stdout ?? '');
  return { ok, provider, detail: out || `exit ${res.status}` };
}

// Deterministic ordering: probe the full bwrap profile first, then the unshare
// candidate, then refuse. `force` exists for the provider-seam tests and for an
// operator who knows the host cannot sandbox (it does NOT grant the override).
export function resolveIsolation({ plan, force = process.env.WEB_UPLIFT_SANDBOX_FORCE, spawn = spawnSync }) {
  const attempts = [];
  if (plan.refused) {
    return { isolation: 'refused', provider: null, attempts, plan };
  }
  const order = force === 'bwrap' ? ['bwrap']
    : force === 'unshare' ? ['unshare']
      : force === 'none' || force === 'off' ? []
        : ['bwrap', 'unshare'];
  for (const provider of order) {
    const probe = probeProvider(provider, plan, { spawn });
    attempts.push({ provider, ok: probe.ok, detail: probe.detail });
    if (probe.ok) return { isolation: provider, provider, attempts, plan, probe };
  }
  return { isolation: 'refused', provider: null, attempts, plan, forcedNone: order.length === 0 };
}

// The marker the brief requires before the first spawn. Written atomically
// (tmp + rename) so a reader never sees a half-written record.
export function writeRunSecurity(outDir, record) {
  const dest = join(outDir, 'run-security.json');
  const tmp = `${dest}.tmp-${process.pid}`;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(tmp, JSON.stringify({ ...record, writtenAt: new Date().toISOString(), runId: record.runId ?? null }, null, 2) + '\n');
  renameSync(tmp, dest);
  return dest;
}

// Human-readable refusal/override text. Names what was found and what is required,
// and says explicitly that no agent was started.
export function isolationMessage(resolution, { override = false, outDir } = {}) {
  const tried = resolution.attempts.map((a) => `${a.provider}: ${a.ok ? 'ok' : a.detail}`).join('; ') || 'no provider was available to probe';
  const wanted = [
    `writable: ${resolution.plan.rw.filter(Boolean).join(', ') || '(none resolved)'}`,
    `read-only: project tree${resolution.plan.protectedPaths.length ? `, ${resolution.plan.protectedPaths.map((p) => p.name).join(', ')}` : ''}`,
  ].join('; ');
  if (resolution.isolation !== 'refused') {
    return `agent isolation: ${resolution.isolation} (probe: ${resolution.attempts.map((a) => `${a.provider}=${a.ok ? 'ok' : 'fail'}`).join(' ')}). This sandbox does not restrict the NETWORK: SSRF, metadata access and credential exfiltration are out of its scope.`;
  }
  const why = resolution.plan.notes.filter((n) => n.level === 'refuse').map((n) => n.reason).join('; ');
  return [
    'REFUSED: no usable OS sandbox for this fix run, and NO AGENT WAS STARTED.',
    `provider probe: ${tried}`,
    `what this run requires: ${wanted}`,
    why ? `unusable host paths: ${why}` : '',
    'bwrap is the required launcher; an unshare layout qualifies only if it builds and passes the same probe.',
    override
      ? 'continuing anyway is not possible with an override path that failed to record - refusing is safer'
      : `to deliberately run unsandboxed as an accepted risk, re-run with --allow-unsandboxed-agent (records isolation: none in ${join(outDir ?? '<out>', 'run-security.json')})`,
  ].filter(Boolean).join('\n');
}

export { PROTECTED_NAMES, PROVIDER_AUTH };
