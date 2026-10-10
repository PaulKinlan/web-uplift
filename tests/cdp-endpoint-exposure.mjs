#!/usr/bin/env node
// Tests for CDP endpoint exposure (web-uplift-4rv): the audit's Chrome exposes an
// UNAUTHENTICATED DevTools endpoint for the life of the run, so the launch pins it to loopback
// and then MEASURES that the pin held.
//
// The verdict has two paths, and both are tested against real sockets rather than only against
// stubs, because the failure this exists to catch is a kernel fact:
//   1. the kernel binding of our own browser pid (IPv4 and IPv6, /proc/net/tcp{,6}),
//   2. reachability, which also has to ask WHO is answering, or an unrelated daemon on the same
//      address would refuse a healthy audit.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyBoundListeners,
  cdpEndpointExposure,
  decodeProcAddress,
  isLoopbackAddress,
  launchChrome,
  probeDevtools,
  readBoundListeners,
} from '../evidence/cdp.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const here = fileURLToPath(import.meta.url);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Sockets are tracked so they can be destroyed at close: net.Server.close() waits for open
// connections, a probe leaves one half-open, and closeAllConnections() does not exist on this
// Node build (an optional call no-ops silently, which is how a test hangs for two minutes).
const listen = (host) =>
  new Promise((resolveListen, reject) => {
    const sockets = new Set();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.trackedSockets = sockets;
    server.once('error', reject);
    server.listen(0, host, () => resolveListen(server));
  });

const close = (server) =>
  new Promise((r) => {
    for (const socket of server.trackedSockets ?? []) socket.destroy();
    server.close(r);
  });

// A child process holding a real 0.0.0.0 listener, so attribution can be tested across pids.
const childWithWildcardListener = () =>
  new Promise((resolveChild, reject) => {
    const child = spawn(process.execPath, ['-e', "const s=require('net').createServer();s.listen(0,'0.0.0.0',()=>console.log(s.address().port));setTimeout(()=>{},60000)"], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const onData = (chunk) => {
      const port = Number(String(chunk).trim());
      if (Number.isInteger(port) && port > 0) {
        child.stdout.off('data', onData);
        resolveChild({ child, port });
      }
    };
    child.stdout.on('data', onData);
    child.once('error', reject);
    child.once('exit', () => reject(new Error('the helper child exited before listening')));
  });

export async function testCdpEndpointExposure() {
  // 1. THE DECODER: /proc's own encodings, including the address forms where a wrong byte order
  // still LOOKS like a plausible address (which is how ::1 came out as 0:1:0:0:0:0:0:0).
  assert(decodeProcAddress('0100007F', false) === '127.0.0.1', '127.0.0.1 must decode');
  assert(decodeProcAddress('00000000', false) === '0.0.0.0', 'the IPv4 wildcard must decode');
  assert(decodeProcAddress('00000000000000000000000001000000', true) === '0:0:0:0:0:0:0:1', '::1 must decode, not 0:1:0:0:0:0:0:0');
  assert(decodeProcAddress('00000000000000000000000000000000', true) === '0:0:0:0:0:0:0:0', 'the IPv6 wildcard must decode');
  assert(decodeProcAddress('zz', false) === null && decodeProcAddress('0100', false) === null, 'undecodable input must be null, never a made-up address');
  assert(isLoopbackAddress('127.0.0.1') && isLoopbackAddress('127.9.9.9'), 'the whole 127/8 is loopback');
  assert(isLoopbackAddress('0:0:0:0:0:0:0:1') && !isLoopbackAddress('0:0:0:0:0:0:0:0'), '::1 is loopback and the IPv6 wildcard is not');
  assert(!isLoopbackAddress('10.42.0.42') && !isLoopbackAddress('::ffff:10.42.0.42'), 'a routed address is not loopback');

  // 2. REAL SOCKETS, REAL KERNEL, our own pid. Each case binds the way a browser could and asks
  // the kernel; nothing here is a stub, so this is the check itself being tested.
  const v4Loop = await listen('127.0.0.1');
  const v4Wild = await listen('0.0.0.0');
  const v6Loop = await listen('::1');
  const v6Wild = await listen('::');
  const helper = await childWithWildcardListener().catch(() => null);
  try {
    const mineRead = readBoundListeners(process.pid);
    assert(mineRead && Array.isArray(mineRead.listeners) && Array.isArray(mineRead.unreadable),
      `our own listeners must be readable from /proc, with the tables that were not readable named: ${JSON.stringify(mineRead)}`);
    assert(mineRead.unreadable.length === 0, `this host must expose both address-family tables: ${JSON.stringify(mineRead.unreadable)}`);
    const mine = mineRead.listeners;
    const find = (server) => mine.find((l) => l.port === server.address().port);

    assert(find(v4Loop)?.address === '127.0.0.1', `a 127.0.0.1 listener must read back as loopback: ${JSON.stringify(find(v4Loop))}`);
    assert(find(v4Wild)?.address === '0.0.0.0', `a 0.0.0.0 listener must read back as the wildcard: ${JSON.stringify(find(v4Wild))}`);
    assert(find(v6Loop)?.address === '0:0:0:0:0:0:0:1', `an ::1 listener must read back as loopback: ${JSON.stringify(find(v6Loop))}`);
    assert(find(v6Wild)?.address === '0:0:0:0:0:0:0:0', `an :: listener must read back as the IPv6 wildcard: ${JSON.stringify(find(v6Wild))}`);

    for (const [server, expected, label] of [[v4Loop, false, 'IPv4 loopback'], [v4Wild, true, 'IPv4 wildcard'], [v6Loop, false, 'IPv6 loopback'], [v6Wild, true, 'IPv6 wildcard']]) {
      const verdict = classifyBoundListeners(server.address().port, mine);
      assert(verdict.exposed === expected, `${label}: expected exposed=${expected}, got ${JSON.stringify(verdict)}`);
    }
    assert(/0\.0\.0\.0/.test(classifyBoundListeners(v4Wild.address().port, mine).reason), 'the refusal must name the address it was bound to');
    assert(classifyBoundListeners(v6Wild.address().port, mine).reason.includes('[0:0:0:0:0:0:0:0]'), 'an IPv6 refusal must name the bracketed address');
    // No listener on that port is UNKNOWN, never "safe".
    const unknown = classifyBoundListeners(1, mine);
    assert(unknown.exposed === false && unknown.unknown === true, `a port with no listener must be unknown: ${JSON.stringify(unknown)}`);

    // 3. ATTRIBUTION: a foreign process holding the same kind of listener must not decide our
    // browser's fate - its pid's read has it, our pid's read does not.
    if (helper) {
      const theirs = readBoundListeners(helper.child.pid).listeners;
      assert(Array.isArray(theirs) && theirs.some((l) => l.port === helper.port && l.address === '0.0.0.0'),
        `the helper's own wildcard listener must be attributable to the helper: ${JSON.stringify(theirs)}`);
      assert(!mine.some((l) => l.port === helper.port), 'the helper\'s listener must not appear against our pid');
      assert(classifyBoundListeners(helper.port, mine).exposed === false, 'a foreign listener must not mark OUR browser as exposed');
    } else {
      console.log('  (could not start the helper child: the cross-pid attribution case was skipped)');
    }

    // 4. THE VERDICT THE LAUNCH ACTUALLY USES, with the browser pid: a loopback-bound browser is
    // cleared BY THE KERNEL, and an all-interfaces one is refused by it.
    const cleared = await cdpEndpointExposure(v4Loop.address().port, { pid: process.pid });
    assert(cleared.exposed === false && cleared.verifiedBy === 'the kernel binding',
      `a loopback-bound endpoint must be cleared by the binding check: ${JSON.stringify(cleared)}`);
    const refusedByBinding = await cdpEndpointExposure(v4Wild.address().port, { pid: process.pid });
    assert(refusedByBinding.exposed === true && refusedByBinding.verifiedBy === 'the kernel binding',
      `an all-interfaces endpoint must be refused by the binding check: ${JSON.stringify(refusedByBinding)}`);
    const refusedV6 = await cdpEndpointExposure(v6Wild.address().port, { pid: process.pid });
    assert(refusedV6.exposed === true, `an IPv6 wildcard bind must be refused: ${JSON.stringify(refusedV6)}`);

    // 5. THE DECISION TABLE, with injected interfaces and verdicts so every branch is pinned on
    // any machine. IPv6 is part of the table on purpose: an IPv4-only sweep is the blind spot
    // that would have missed the :: case above.
    const interfaces = {
      eth0: [{ address: '10.0.0.5', family: 'IPv4', internal: false }],
      eth1: [{ address: '2001:db8::5', family: 'IPv6', internal: false }],
      eth2: [{ address: 'fe80::5', family: 'IPv6', internal: false, scopeid: 2 }],
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      lo6: [{ address: '::1', family: 'IPv6', internal: true }],
    };
    const seen = [];
    const respond = (verdict) => async (host, port) => {
      seen.push(`${host}:${port}`);
      return verdict;
    };
    const noPid = { interfaces, readListeners: () => null };
    assert((await cdpEndpointExposure(9222, { ...noPid, connect: respond('devtools') })).exposed === true, 'a DevTools answer on a non-loopback address is exposure');
    const nondvt = await cdpEndpointExposure(9222, { ...noPid, connect: respond('other') });
    assert(nondvt.exposed === false && /not with DevTools/.test(nondvt.note), `a non-DevTools listener must NOT refuse a healthy audit: ${JSON.stringify(nondvt)}`);
    const refused = await cdpEndpointExposure(9222, { ...noPid, connect: respond('refused') });
    // Every address was decided and refused, so this IS a verification - by reachability. There is
    // no pid here, so there was no binding read to be incomplete about, hence no note.
    assert(refused.exposed === false && refused.verifiedBy === 'reachability' && refused.unknown === undefined && !refused.note,
      `refusals everywhere mean loopback-only, verified by reachability: ${JSON.stringify(refused)}`);
    // A pid whose binding cannot be read (no /proc, or no reader) is incomplete: still verified by
    // reachability when every address is decided, but the note says which check did not run.
    const noBindingRead = await cdpEndpointExposure(9222, { interfaces, pid: 4242, readListeners: () => null, connect: respond('refused') });
    assert(noBindingRead.verifiedBy === 'reachability' && /could not be read/.test(noBindingRead.note),
      `a pid whose binding cannot be read must say so: ${JSON.stringify(noBindingRead)}`);
    const noReader = await cdpEndpointExposure(9222, { interfaces, pid: 4242, readListeners: null, connect: respond('refused') });
    assert(noReader.verifiedBy === 'reachability' && /could not be checked/.test(noReader.note),
      `a pid with no reader must say the binding was not checked: ${JSON.stringify(noReader)}`);
    const undecided = await cdpEndpointExposure(9222, { ...noPid, connect: respond('timeout') });
    // The FIELDS, not only the note: a verdict that cannot be decided must not claim a verifier
    // (web-uplift-sj4c). "verifiedBy: reachability" beside "unconfirmed" reads as a clean result.
    assert(undecided.exposed === false && undecided.unknown === true && undecided.verifiedBy === undefined,
      `an undecided probe is UNKNOWN and names no verifier: ${JSON.stringify(undecided)}`);
    assert(/unconfirmed/.test(undecided.note) && /could not be decided/.test(undecided.note),
      `an undecided probe must say so: ${JSON.stringify(undecided)}`);
    // ...and one undecided address among decided ones is enough: the decided ones do not carry it.
    const oneUndecided = await cdpEndpointExposure(9222, {
      ...noPid,
      connect: async (host) => (host.startsWith('2001:') ? 'timeout' : 'refused'),
    });
    assert(oneUndecided.unknown === true && oneUndecided.verifiedBy === undefined,
      `one undecidable address must make the whole verdict unknown: ${JSON.stringify(oneUndecided)}`);
    assert(seen.some((h) => h.startsWith('2001:db8::5:')) && seen.some((h) => h.startsWith('fe80::5%2:')),
      `IPv6 must be probed, including a link-local address with its zone: ${JSON.stringify(seen)}`);
    // The pid is what makes the binding check attributable: assert it is passed through.
    let askedPid = null;
    await cdpEndpointExposure(9222, { interfaces: {}, pid: 4242, readListeners: (pid) => { askedPid = pid; return null; } });
    assert(askedPid === 4242, 'the exposure check must ask about the BROWSER pid it was given');
    // A host with only loopback can only be reached on loopback.
    const loopbackOnly = await cdpEndpointExposure(9222, { interfaces: { lo: interfaces.lo, lo6: interfaces.lo6 }, pid: null, connect: respond('devtools') });
    assert(loopbackOnly.exposed === false && /no non-loopback address/.test(loopbackOnly.note), `a loopback-only host must say so: ${JSON.stringify(loopbackOnly)}`);
    assert((await cdpEndpointExposure(0, { interfaces })).exposed === false, 'a launch with no port yet must not be reported as exposed');
    assert(readBoundListeners(99999999) === null, 'an unreadable pid must be null, not an empty list that reads as safe');

    // A read that found NO listener for the announced port is also incomplete (review finding):
    // the endpoint was announced, so not seeing it means the read did not cover it, and the
    // reachability-only verdict must not read as if the kernel had confirmed anything.
    const noSocket = await cdpEndpointExposure(9222, {
      interfaces,
      pid: 4242,
      readListeners: () => ({ listeners: [{ address: '127.0.0.1', port: 1, family: 'IPv4' }], unreadable: [] }),
      connect: respond('refused'),
    });
    assert(noSocket.verifiedBy === 'reachability' && /no listening socket for port 9222/.test(noSocket.note),
      `a port with no listener must say the read did not cover it: ${JSON.stringify(noSocket)}`);
    assert(/kernel binding was incomplete/.test(noSocket.note),
      `and it must say the binding was not the verifier: ${JSON.stringify(noSocket)}`);

    // 5b. web-uplift-03da: an unreadable address-family table is an INCOMPLETE read, never a
    // verified-safe binding. A v4-only kernel or a sandbox without /proc/net/tcp6 leaves the IPv4
    // half looking perfect while a browser bound to a non-loopback IPv6 address is invisible.
    const partial = readBoundListeners(process.pid, { tcpFiles: ['/proc/net/tcp', '/proc/net/tcp6-not-on-this-host'] });
    assert(partial.unreadable.length === 1 && /tcp6-not-on-this-host/.test(partial.unreadable[0]),
      `a table that could not be read must be named: ${JSON.stringify(partial.unreadable)}`);
    assert(partial.listeners.some((l) => l.port === v4Loop.address().port && l.address === '127.0.0.1'),
      `the readable family must still be answered: ${JSON.stringify(partial.listeners)}`);
    const incomplete = await cdpEndpointExposure(9222, {
      interfaces,
      pid: 4242,
      readListeners: () => partial,
      connect: respond('refused'),
    });
    assert(incomplete.verifiedBy === 'reachability' && incomplete.unknown === undefined,
      `an incomplete binding read must fall through to reachability, not claim the kernel: ${JSON.stringify(incomplete)}`);
    assert(/tcp6-not-on-this-host/.test(incomplete.note) && /unchecked/.test(incomplete.note),
      `the verdict must name the family it could not read: ${JSON.stringify(incomplete)}`);
    // The finding's actual scenario: the readable family looks clean, an IPv6 listener is invisible
    // to us, and it IS reachable. Before this fix the clean IPv4 answer returned
    // "verifiedBy: the kernel binding" and never probed - a false all-clear.
    const blindSpot = await cdpEndpointExposure(9222, {
      interfaces,
      pid: 4242,
      readListeners: () => ({ listeners: [{ address: '127.0.0.1', port: 9222, family: 'IPv4' }], unreadable: ['/proc/net/tcp6'] }),
      connect: async (host) => (host.includes(':') ? 'devtools' : 'refused'),
    });
    assert(blindSpot.exposed === true,
      `an IPv6 listener we could not read must still be found by reachability: ${JSON.stringify(blindSpot)}`);
    assert(blindSpot.verifiedBy === 'reachability' && /DevTools on [\w:.%]*::[\w:.%]*:9222/.test(blindSpot.reason),
      `the refusal must name the IPv6 address that answered: ${JSON.stringify(blindSpot)}`);
    // A complete read is unchanged: loopback-only is still verified by the kernel, with no unknown.
    const complete = await cdpEndpointExposure(9222, {
      interfaces,
      pid: 4242,
      readListeners: () => ({ listeners: [{ address: '127.0.0.1', port: 9222, family: 'IPv4' }], unreadable: [] }),
      connect: respond('devtools'),
    });
    assert(complete.exposed === false && complete.verifiedBy === 'the kernel binding' && complete.unknown === undefined,
      `a complete loopback-only binding is verified by the kernel and needs no probe: ${JSON.stringify(complete)}`);

    // 6. THE PROBE ITSELF, against real servers: a plain listener is 'connecting but not
    // DevTools', a DevTools-shaped answer is exposure, and a closed port is refused.
    const plainHttp = await listen('0.0.0.0');
    plainHttp.on('connection', (socket) => socket.end('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<html>hello, not devtools</html>'));
    const fakeDevtools = await listen('0.0.0.0');
    fakeDevtools.on('connection', (socket) =>
      socket.end('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"Browser":"Chrome/154.0","webSocketDebuggerUrl":"ws://localhost/devtools/browser/x"}\n'));
    const closedProbe = await listen('127.0.0.1');
    const closedPort = closedProbe.address().port;
    await close(closedProbe);
    try {
      assert((await probeDevtools('127.0.0.1', closedPort, 800)) === 'refused', 'a closed port must probe as refused');
      assert((await probeDevtools('127.0.0.1', plainHttp.address().port, 800)) === 'other', 'a non-DevTools listener must probe as other');
      assert((await probeDevtools('127.0.0.1', fakeDevtools.address().port, 800)) === 'devtools', 'a DevTools-shaped answer must probe as devtools');
      // ...and the end-to-end refusal for a real DevTools listener on a non-loopback address.
      const nonLoopback = Object.values((await import('node:os')).networkInterfaces()).flat()
        .filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
      if (nonLoopback.length > 0) {
        const throughProbe = await cdpEndpointExposure(fakeDevtools.address().port, { pid: null });
        assert(throughProbe.exposed === true && throughProbe.verifiedBy === 'reachability',
          `a DevTools listener on 0.0.0.0 must be refused through the reachability path: ${JSON.stringify(throughProbe)}`);
        const plainThroughProbe = await cdpEndpointExposure(plainHttp.address().port, { pid: null });
        assert(plainThroughProbe.exposed === false,
          `a plain listener on 0.0.0.0 must not refuse an audit: ${JSON.stringify(plainThroughProbe)}`);
      } else {
        console.log('  (no non-loopback interface on this host: the reachability exposure cases were skipped)');
      }
    } finally {
      await close(plainHttp);
      await close(fakeDevtools);
    }

    // 7. THE LAUNCH PATH, both ways, with a real browser.
    // (a) A healthy launch: the pin is measured from the kernel and the endpoint is cleared.
    const log = [];
    const chrome = await launchChrome({ log: (m) => log.push(m) });
    try {
      const verdict = await cdpEndpointExposure(chrome.port, { pid: chrome.proc.pid });
      assert(verdict.exposed === false && verdict.verifiedBy === 'the kernel binding' && verdict.unknown === undefined,
        `a real launch must be cleared by its own kernel binding: ${JSON.stringify(verdict)}`);
      assert(!log.some((m) => /unconfirmed|not with DevTools/.test(m)), `a healthy launch must not log an unresolved exposure note: ${JSON.stringify(log)}`);
    } finally {
      await chrome.close();
    }
    // (b) A refusal must REFUSE: reject with the reason, attribute the refusal, kill the browser,
    // remove the profile - and NOT retry, because a retry loop can spawn another exposed listener
    // and hand the exposed browser back when a later attempt cannot decide.
    const launchesFile = join(tmpdir(), `web-uplift-4rv-launches-${process.pid}.jsonl`);
    rmSync(launchesFile, { force: true });
    const previousSink = process.env.WEB_UPLIFT_LAUNCH_LOG;
    process.env.WEB_UPLIFT_LAUNCH_LOG = launchesFile;
    let attempts = 0;
    let refusal = null;
    try {
      await launchChrome({
        log: () => {},
        exposureProbe: async (port) => {
          attempts += 1;
          return { exposed: true, verifiedBy: 'test', reason: `test-injected exposure on port ${port}` };
        },
      });
    } catch (err) {
      refusal = err;
    }
    if (previousSink === undefined) delete process.env.WEB_UPLIFT_LAUNCH_LOG;
    else process.env.WEB_UPLIFT_LAUNCH_LOG = previousSink;
    assert(attempts === 1, `an exposure refusal must NOT be retried (probe ran ${attempts} times)`);
    assert(refusal instanceof Error && /test-injected exposure on port \d+/.test(refusal.message),
      `an exposed endpoint must fail the launch with the reason: ${refusal && refusal.message}`);
    const records = readFileSync(launchesFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const recorded = records.find((r) => /test-injected exposure/.test(r.reason ?? ''));
    assert(recorded, `the refused launch must be attributed to the run log: ${JSON.stringify(records)}`);
    assert(!existsSync(recorded.profileDir), `a refused launch must not leave its profile dir behind (${recorded.profileDir})`);
    assert(!(recorded.pid && existsSync(`/proc/${recorded.pid}`)), `a refused launch must not leave the browser running (pid ${recorded.pid})`);
    rmSync(launchesFile, { force: true });

    // 8. THE LAUNCH ARGUMENTS. The live check above proves the pin held for this Chrome; these
    // assert the two things that make the check a check rather than a hope.
    const source = readFileSync(join(repoRoot, 'evidence', 'cdp.mjs'), 'utf8');
    assert(source.includes("'--remote-debugging-address=127.0.0.1'"),
      'the launch must pin the debugging address to loopback, not rely on Chrome defaulting to it');
    assert(source.includes('exposureProbe(port, proc.pid)'),
      'the launch must run the exposure check against ITS OWN browser pid, not against the port alone');
  } finally {
    await close(v4Loop);
    await close(v4Wild);
    await close(v6Loop);
    await close(v6Wild);
    if (helper) helper.child.kill('SIGKILL');
  }
  console.log(`${here.split('/').slice(-2).join('/')}: tests OK`);
}

if (process.argv[1] && resolve(process.argv[1]) === here) {
  await testCdpEndpointExposure();
}
