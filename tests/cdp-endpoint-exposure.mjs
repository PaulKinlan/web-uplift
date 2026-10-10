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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    // The PORT transport must be requested explicitly (web-uplift-ndud). The default is now the pipe,
    // which publishes no endpoint at all, so launching without this made the assertion below compare a
    // verdict about "no CDP port to probe" with a clearance - the test still ran, still failed, and in
    // between stopped proving anything about 4rv's exposure guard. This is the path that has a listener.
    const chrome = await launchChrome({ log: (m) => log.push(m), transport: 'port' });
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
      // Explicit port transport for the same reason as 7(a): on the pipe there is no port, so the
      // probe is never invoked and the REFUSAL path this case exists to prove is bypassed entirely.
      await launchChrome({
        log: () => {},
        transport: 'port',
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

// The non-loopback probes are independent read-only reachability checks, so they must run together
// rather than one after another: serially, N interfaces that each wait the full deadline cost N times
// the deadline before Chrome launch verification can finish, which is the whole of web-uplift-690r.
// The claim asserted is the PEAK number of probes in flight, not the elapsed time: a peak of one is
// what serialising produces, and it does not depend on how loaded the machine is.
export async function testEndpointProbesRunConcurrently() {
  const interfaces = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    eth0: [{ address: '10.0.0.5', family: 'IPv4', internal: false }],
    docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
    tun0: [{ address: '10.8.0.2', family: 'IPv4', internal: false }],
  };
  const deadline = 200;
  let inFlight = 0;
  let peak = 0;
  const connect = async (host, port, timeoutMs) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((done) => setTimeout(done, timeoutMs));
    inFlight -= 1;
    return 'timeout';
  };
  const started = Date.now();
  const verdict = await cdpEndpointExposure(9222, { interfaces, connect, timeoutMs: deadline });
  const elapsed = Date.now() - started;
  assert(peak === 3,
    `all three non-loopback probes must be in flight together, peak was ${peak} (serialising gives 1)`);
  assert(elapsed < 6 * deadline,
    `three ${deadline}ms probes must not cost their sum: took ${elapsed}ms, which is serial`);
  assert(verdict.exposed === false && verdict.unknown === true && !verdict.verifiedBy,
    `probes that were never decided must stay undecided and name no verifier: ${JSON.stringify(verdict)}`);
  console.log(`endpoint probes concurrent OK: peak ${peak} probes in flight, ${elapsed}ms elapsed for three ${deadline}ms probes`);
}

// The ordered rethrow inside cdpEndpointExposure, and the fail-open shape it prevents, are NOT covered
// by the await census: the census guards the allSettled line but not the loop body. Changing
// `throw outcome.reason` to `continue` turns a rejecting probe into a clean
// {exposed:false, verifiedBy:'reachability'} - fail-open - and every other focused suite still passes,
// so these assertions are the only thing between that edit and a silent regression
// (web-uplift-690r, second review round).
export async function testEndpointProbeRejectionStaysFailClosed() {
  const interfaces = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    eth0: [{ address: '10.0.0.5', family: 'IPv4', internal: false }],
    docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
    tun0: [{ address: '10.8.0.2', family: 'IPv4', internal: false }],
  };
  const run = async (connect) => {
    try {
      return { verdict: await cdpEndpointExposure(9222, { interfaces, connect, timeoutMs: 50 }) };
    } catch (err) {
      return { error: err };
    }
  };
  // (a) An earlier host answers as DevTools and a LATER probe rejects. The refusal must win, because
  //     the caller closes the browser only on the refusal path.
  const later = await run(async (host) => {
    if (host === '10.0.0.5') return 'devtools';
    if (host === '10.8.0.2') throw new Error('boom-later');
    return 'refused';
  });
  assert(!later.error,
    `a later rejection must not displace an earlier refusal, but it threw ${later.error && later.error.message}`);
  assert(later.verdict.exposed === true && /10\.0\.0\.5/.test(later.verdict.reason || ''),
    `the refusal must survive and name the host that answered as DevTools: ${JSON.stringify(later.verdict)}`);
  // (b) The rejection is FIRST in host order, so its own error is the one that must be thrown - the
  //     first in order, not the first in time.
  const first = await run(async (host) => {
    if (host === '10.0.0.5') throw new Error('boom-first');
    if (host === '172.17.0.1') return 'devtools';
    return 'refused';
  });
  assert(first.error && first.error.message === 'boom-first',
    `the first rejection in host order must be the one thrown, got ${first.error ? first.error.message : JSON.stringify(first.verdict)}`);
  // (c) A LONE rejection with every other host refused must still throw. This case states the fail-open
  //     property directly: with `continue` it resolves {exposed:false, verifiedBy:'reachability'}, a clean
  //     answer for a probe that never answered, while treating the rejection as merely undecided resolves
  //     unknown:true with no verifier instead. (b) fires first for BOTH of those rewrites; (c) is kept so
  //     the fail-open shape is asserted by name, not only as a side effect of (b)
  //     (web-uplift-690r, fourth review round: my earlier version of this comment named the wrong mutant).
  const only = await run(async (host) => {
    if (host === '10.0.0.5') throw new Error('boom-only');
    return 'refused';
  });
  assert(only.error && only.error.message === 'boom-only',
    `a rejected probe must never resolve as a clean answer: got ${only.error ? only.error.message : JSON.stringify(only.verdict)}`);
  // (d) Two rejecting hosts, where the LATER host in interface order rejects FIRST in time. This is the
  //     only case that distinguishes "first in host order" from "first in time": every other scenario
  //     here has a single rejecting host, so the two orders coincide and a mutation that throws the
  //     earliest-in-time error would pass everything (web-uplift-690r, third review round).
  const both = await run(async (host) => {
    if (host === '172.17.0.1') {
      await new Promise((done) => setTimeout(done, 30));
      throw new Error('boom-slow-earlier-host');
    }
    if (host === '10.8.0.2') throw new Error('boom-fast-later-host');
    return 'refused';
  });
  assert(both.error && both.error.message === 'boom-slow-earlier-host',
    `the error thrown must be the first rejecting host in ORDER, not the first in time: got ${both.error ? both.error.message : JSON.stringify(both.verdict)}`);
  console.log('endpoint probe rejection OK: a later rejection cannot displace a refusal, host order decides which error is thrown even when a later host fails first in time, and a lone rejection stays fail-closed');
}

// A probe that THROWS, or that RESOLVES WITHOUT A VERDICT, must neither leak the spawned browser nor be
// accepted. Before this: an escaping exception skipped both recordLaunchFailure and close(), so the
// browser and its profile outlived the failed launch; and a probe returning {} read as "not exposed", so
// the launch SUCCEEDED - fail-open for the one check whose whole purpose is to refuse (web-uplift-uuod).
//
// The shapes are all run, not just the throw, because a mutant that deletes only the verdict validation
// passed every other test in the repo while {} went back to returning a handle. Covering the throw alone
// left the fix for the fail-open unguarded.
//
// The pid and profile come from the launch record rather than from a file the fake writes. An earlier
// version had the fake report its pid, which raced the launch: if the shell paused between printing the
// DevTools line and writing the pid, the launch finished first, the pid was empty, the liveness loop was
// skipped, and a LEAKING tree PASSED.
export async function testExposureProbeFailuresDoNotLeakTheBrowser() {
  const revoked = Proxy.revocable({}, {});
  const revokedProxy = revoked.proxy;
  revoked.revoke();
  const shapes = [
    ['throws', () => { throw new Error('probe-boom'); }],
    ['returns undefined', () => undefined],
    ['resolves to null', async () => null],
    ['returns no verdict object', () => ({})],
    // A throw that cannot be turned into a message: the coercion itself has to be total, or the
    // failure reason is built by a statement that throws and escapes before close().
    ['throws an unprintable value', () => { throw Object.create(null); }],
    ['throws a revoked Proxy', () => { throw revokedProxy; }],
  ];
  for (const [label, probe] of shapes) {
    const dir = mkdtempSync(join(tmpdir(), 'web-uplift-uuod-'));
    const launchesFile = join(dir, 'launches.jsonl');
    const fake = join(dir, 'leaky-chrome');
    // Announces a port, then stays alive, so a leak is a live process at check time.
    const fakePidFile = join(dir, 'fake-pid');
    // The fake reports its own pid and TMPDIR points at dir, so the finally can clean up even in the
    // shapes where the launch dies before recording anything - a mutant that removes the validation
    // escapes before recordLaunchFailure, so pid and profileDir stay empty and the fake would survive
    // into later tests in a full ALL_TESTS run (web-uplift-uuod review 3).
    writeFileSync(fake, `#!/bin/sh\necho $$ > ${fakePidFile}\necho "DevTools listening on ws://127.0.0.1:1/" >&2\nexec sleep 30\n`, { mode: 0o755 });
    const savedBin = process.env.CHROME_BIN;
    const savedSink = process.env.WEB_UPLIFT_LAUNCH_LOG;
    const savedTmp = process.env.TMPDIR;
    process.env.CHROME_BIN = fake;
    process.env.WEB_UPLIFT_LAUNCH_LOG = launchesFile;
    process.env.TMPDIR = dir;
    let pid = '';
    let profileDir = null;
    let handle = null;
    try {
      let error = null;
      try {
        handle = await launchChrome({ transport: 'port', devtoolsTimeoutMs: 2000, log: () => {}, exposureProbe: probe });
      } catch (err) {
        error = err;
      } finally {
        // A shape that returns a handle owns a browser; close it here so it cannot outlive the test.
        if (handle && handle.close) { try { await handle.close(); } catch {} }
      }
      // Read the record BEFORE the message assertions: the finally needs the pid to kill the fake, and a
      // failing message assertion used to run before the pid was known, so the fake was never killed.
      const records = existsSync(launchesFile)
        ? readFileSync(launchesFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
        : [];
      const failed = records.filter((record) => record.outcome === 'failed');
      if (failed[0] && failed[0].pid) pid = String(failed[0].pid);
      if (failed[0] && failed[0].profileDir) profileDir = failed[0].profileDir;
      assert(error instanceof Error, `${label}: must fail the launch, not return a handle: ${error}`);
      assert(/endpoint exposure probe failed/.test(error.message),
        `${label}: the failure must name the probe so an operator can tell it apart from a bind verdict: ${error.message}`);
      assert(/after 1 attempt/.test(error.message),
        `${label}: a probe that gave no verdict must not be retried: ${error.message}`);
      assert(failed.length === 1, `${label}: the failed attempt must be recorded exactly once, saw ${failed.length} failed of ${records.length} record(s)`);
      assert(failed[0].pid, `${label}: the record must carry the spawned pid: ${JSON.stringify(failed[0])}`);
      assert(profileDir, `${label}: the record must carry the profile directory`);
      // Bounded on the REPEATS, not just the outcome: close() reaps asynchronously.
      let alive = false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (!existsSync(`/proc/${pid}`)) { alive = false; break; }
        alive = true;
        await new Promise((done) => setTimeout(done, 50));
      }
      assert(!alive, `${label}: the spawned browser must not outlive the failed launch (pid ${pid} is still in /proc)`);
      assert(!existsSync(profileDir), `${label}: the profile directory must not be left behind: ${profileDir}`);
      console.log(`${label} OK: fails fatally after one attempt, records the attempt, and leaves neither browser nor profile behind`);
    } finally {
      // When no record was written, fall back to the pid the fake reported, and TMPDIR means the
      // profile directory is inside dir, which is removed below.
      if (!pid && existsSync(fakePidFile)) pid = readFileSync(fakePidFile, 'utf8').trim();
      if (pid) { try { process.kill(Number(pid), 'SIGKILL'); } catch {} }
      if (profileDir) rmSync(profileDir, { recursive: true, force: true });
      if (savedBin === undefined) delete process.env.CHROME_BIN;
      else process.env.CHROME_BIN = savedBin;
      if (savedSink === undefined) delete process.env.WEB_UPLIFT_LAUNCH_LOG;
      else process.env.WEB_UPLIFT_LAUNCH_LOG = savedSink;
      if (savedTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = savedTmp;
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

// The verdict must be read exactly once, inside the try. A probe whose `exposed` getter answers a
// boolean to the validation and throws on a second read used to escape at the use site with the browser
// spawned and no close() on that path (web-uplift-uuod review 3).
export async function testExposureVerdictIsReadOnceInsideTheTry() {
  const dir = mkdtempSync(join(tmpdir(), 'web-uplift-uuod-'));
  const fake = join(dir, 'readonce-chrome');
  const fakePidFile = join(dir, 'fake-pid');
  // The fake reports its own pid and TMPDIR points at dir, for the same reason the crash test does it: a
  // mutant makes the exception escape before any handle exists, so without this the fake outlives the
  // test and in a full ALL_TESTS run survives into later tests (uuod review 4).
  writeFileSync(fake, `#!/bin/sh\necho $$ > ${fakePidFile}\necho "DevTools listening on ws://127.0.0.1:1/" >&2\nexec sleep 30\n`, { mode: 0o755 });
  const savedBin = process.env.CHROME_BIN;
  const savedTmp = process.env.TMPDIR;
  process.env.CHROME_BIN = fake;
  process.env.TMPDIR = dir;
  let reads = 0;
  let handle = null;
  try {
    handle = await launchChrome({
      transport: 'port',
      devtoolsTimeoutMs: 2000,
      log: () => {},
      exposureProbe: () => ({
        get exposed() {
          reads += 1;
          if (reads > 1) throw new Error('exposed read twice');
          return false;
        },
      }),
    });
    // A valid verdict of not-exposed is a SUCCESS, so the launch must return a handle and the getter
    // must have been consulted exactly once.
    assert(handle, 'a valid not-exposed verdict must still yield a handle');
    assert(reads === 1, `the verdict must be read exactly once, read ${reads} time(s)`);
    console.log('verdict read once OK: the getter was consulted once and the launch succeeded');
  } finally {
    if (handle && handle.close) { try { await handle.close(); } catch {} }
    if (existsSync(fakePidFile)) {
      const pid = readFileSync(fakePidFile, 'utf8').trim();
      if (pid) { try { process.kill(Number(pid), 'SIGKILL'); } catch {} }
    }
    if (savedBin === undefined) delete process.env.CHROME_BIN;
    else process.env.CHROME_BIN = savedBin;
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
    rmSync(dir, { recursive: true, force: true });
  }
}

// A probe note that cannot be turned into a string must not fail the launch, and must not be logged
// raw. The coercion is wrapped and only a real string reaches log(), because a Symbol note or one whose
// toString throws used to escape with no "launch failed" wrapper and the browser left running
// (web-uplift-uuod review 4). This is the guard for that fix: reverting the coercion must fail here.
export async function testUnprintableProbeNoteDoesNotFailTheLaunch() {
  const dir = mkdtempSync(join(tmpdir(), 'web-uplift-uuod-'));
  const fake = join(dir, 'note-chrome');
  const fakePidFile = join(dir, 'fake-pid');
  writeFileSync(fake, `#!/bin/sh\necho $$ > ${fakePidFile}\necho "DevTools listening on ws://127.0.0.1:1/" >&2\nexec sleep 30\n`, { mode: 0o755 });
  const savedBin = process.env.CHROME_BIN;
  const savedTmp = process.env.TMPDIR;
  process.env.CHROME_BIN = fake;
  process.env.TMPDIR = dir;
  const logged = [];
  let handle = null;
  try {
    handle = await launchChrome({
      transport: 'port',
      devtoolsTimeoutMs: 2000,
      log: (line) => logged.push(line),
      exposureProbe: () => ({ exposed: false, note: { toString() { throw new Error('note boom'); } } }),
    });
    assert(handle, 'a note that cannot be printed must not fail a launch with a valid verdict');
    assert(logged.every((line) => typeof line === 'string'),
      `only real strings may reach log(): ${JSON.stringify(logged)}`);
    assert(!logged.some((line) => /note boom/.test(line)),
      `an unprintable note must be dropped, not escaped: ${JSON.stringify(logged)}`);
    console.log('unprintable note OK: the launch succeeded, only strings were logged, and nothing raw escaped');
  } finally {
    if (handle && handle.close) { try { await handle.close(); } catch {} }
    if (existsSync(fakePidFile)) {
      const pid = readFileSync(fakePidFile, 'utf8').trim();
      if (pid) { try { process.kill(Number(pid), 'SIGKILL'); } catch {} }
    }
    if (savedBin === undefined) delete process.env.CHROME_BIN;
    else process.env.CHROME_BIN = savedBin;
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
    rmSync(dir, { recursive: true, force: true });
  }
}

// probeDevtools' socket.setTimeout is an IDLE timeout, so a peer that trickles bytes resets it forever
// and holds the probe up to the 64KB cap - measured at 2321ms for a 300ms timeout against a peer that
// dripped for 2s (web-uplift-wf0r). A hard total deadline now bounds it. The verdict on expiry is
// asserted to be 'timeout' rather than 'other' on purpose: 'other' reads as "answers, but not with
// DevTools" and earns a reachability verifier, so a DevTools body still arriving in pieces would be
// laundered into a clean verdict, while 'timeout' leaves the host undecided and fails closed. The
// control peers keep this test from passing by always answering 'timeout'.
export async function testTricklingPeerIsBoundedByTheTotalDeadline() {
  const sockets = new Set();
  const track = (server) => {
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
    });
    return server;
  };
  const timeoutMs = 300;
  const trickler = track(createServer((socket) => {
    // Drip partial bytes for far longer than timeoutMs so the idle timer never fires.
    let sent = 0;
    const timer = setInterval(() => {
      sent += 1;
      try { socket.write('x'); } catch {}
      if (sent * 50 >= 2000) clearInterval(timer);
    }, 50);
    socket.on('close', () => clearInterval(timer));
  }));
  const devtools = track(createServer((socket) => {
    socket.end('HTTP/1.1 200 OK\r\n\r\n{"webSocketDebuggerUrl":"ws://x"}');
  }));
  const other = track(createServer((socket) => {
    socket.end('HTTP/1.1 200 OK\r\n\r\nhello, not devtools');
  }));
  const listen = (server) => new Promise((done) => server.listen(0, '127.0.0.1', () => done(server.address().port)));
  try {
    const tricklingPort = await listen(trickler);
    const started = Date.now();
    const verdict = await probeDevtools('127.0.0.1', tricklingPort, timeoutMs);
    const elapsed = Date.now() - started;
    assert(verdict === 'timeout', `a trickling peer must leave the host undecided, got ${verdict}`);
    // Generous against a loaded VM, but far below the 2000ms the drip would otherwise take.
    assert(elapsed < 1200, `the total deadline must bound the probe, took ${elapsed}ms for a ${timeoutMs}ms budget`);
    const devtoolsVerdict = await probeDevtools('127.0.0.1', await listen(devtools), timeoutMs);
    assert(devtoolsVerdict === 'devtools', `the control must still be detected as DevTools, got ${devtoolsVerdict}`);
    const otherVerdict = await probeDevtools('127.0.0.1', await listen(other), timeoutMs);
    assert(otherVerdict === 'other', `a non-DevTools responder must still read as other, got ${otherVerdict}`);
    console.log(`trickling peer OK: bounded at ${elapsed}ms with verdict=timeout, while the controls still answer devtools and other`);
  } finally {
    for (const socket of sockets) { try { socket.destroy(); } catch {} }
    for (const server of [trickler, devtools, other]) { try { server.close(); } catch {} }
  }
}

// A caller-supplied log is the one call in the post-spawn region that is not ours, so it can throw
// anywhere. Before this test, a throw on the success message ("[browser] DevTools port ...") escaped
// launchChromeOnce with no handle returned and left the browser it had just spawned running
// (web-uplift-l93f) - a resource leak, not a security hole, but unbounded in time for a long-lived
// process. The fix is a try/finally with a handedOff flag, and this test has to pin BOTH sides: with a
// healthy log a handle comes back and the browser is the caller's to close, and with a throwing log
// nothing is left running. Without the healthy case, a launcher that closed unconditionally would pass.
export async function testThrowingLogDoesNotLeakTheSpawnedBrowser() {
  const dir = mkdtempSync(join(tmpdir(), 'l93f-log-'));
  const fakeImpl = join(dir, 'fake-chrome.mjs');
  const fake = join(dir, 'fake-chrome');
  const pidFile = join(dir, 'fake.pid');
  // A fake Chrome: ignore the arguments Chrome would receive, announce a listening line on stderr so
  // the launch proceeds, record our pid so the test can check liveness, and stay alive long enough for
  // a leak to be observable rather than a race.
  writeFileSync(fakeImpl, [
    "import { existsSync, writeFileSync } from 'node:fs';",
    // FAKE_FAIL_ONCE, when set, names a marker file: the first run creates it and dies with code 3 (a
    // retryable startup failure), later runs behave normally. That is what makes launchChrome's retry
    // path - and therefore its "launch recovered on attempt N" log - reachable in a test.
    "const marker = process.env.FAKE_FAIL_ONCE;",
    "if (marker && !existsSync(marker)) { writeFileSync(marker, 'attempt 1'); process.exit(3); }",
    "process.stderr.write('DevTools listening on ws://127.0.0.1:9001/devtools/browser/fake\\n');",
    "writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));",
    "setTimeout(() => {}, 120000);",
    '',
  ].join('\n'));
  writeFileSync(fake, `#!/bin/sh\nexec ${process.execPath} ${fakeImpl}\n`, { mode: 0o755 });
  // Injected so the test needs no real CDP endpoint: this test is about the log throwing, not about
  // the probe's verdict.
  const exposureProbe = async () => ({ exposed: false, verifiedBy: 'reachability' });
  // Save every variable we touch. An earlier version of a sibling test mutated CHROME_BIN and never
  // restored it, which leaked a dangling path into every later test AND every child they spawned.
  const saved = {
    CHROME_BIN: process.env.CHROME_BIN,
    TMPDIR: process.env.TMPDIR,
    FAKE_PID_FILE: process.env.FAKE_PID_FILE,
    FAKE_FAIL_ONCE: process.env.FAKE_FAIL_ONCE,
  };
  process.env.CHROME_BIN = fake;
  process.env.TMPDIR = dir;
  process.env.FAKE_PID_FILE = pidFile;
  const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const readPid = () => (existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : null);
  let handle = null;
  try {
    // (a) The healthy path: a handle is returned, and the browser it names is ALIVE because it now
    // belongs to the caller. This is the control against a launcher that closes too eagerly.
    handle = await launchChrome({ log: () => {}, transport: 'port', exposureProbe });
    const ownedPid = readPid();
    assert(handle && typeof handle.close === 'function', 'a healthy log must still return a handle');
    assert(ownedPid !== null && pidAlive(ownedPid), `the returned handle must name a live browser, pid=${ownedPid}`);
    await handle.close();
    handle = null;

    // (b) The defect: the sink throws on the success message, after the spawn.
    if (existsSync(pidFile)) rmSync(pidFile);
    let threw = null;
    try {
      await launchChrome({
        log: (...args) => { if (args.join(' ').includes('DevTools port')) throw new Error('log boom'); },
        transport: 'port',
        exposureProbe,
      });
    } catch (err) { threw = err; }
    assert(threw !== null, 'a throwing log must propagate rather than be swallowed');
    assert(/log boom/.test(String(threw && threw.message)), `the caller's own error must be the one raised, got ${threw}`);
    const leakedPid = readPid();
    assert(leakedPid !== null, 'the fake should still have recorded its pid before the log threw');
    assert(!pidAlive(leakedPid), `the browser must not outlive the failed handoff, but pid ${leakedPid} is still running`);
    console.log('throwing log OK: the error propagated and the spawned browser did not survive it');

    // (c) The site OUTSIDE launchChromeOnce: "launch recovered on attempt N" runs after a SUCCESSFUL
    // attempt, so a throwing log there leaked the recovered handle. The fake is told to die once, which
    // makes the retry path reachable for real (exit 3 is a retryable startup failure, and the backoff
    // is a quarter second). Without this case that site has no behavioural guard at all: reverting it to
    // a bare log() passes every other test, and only the census notices the await count dropping.
    if (existsSync(pidFile)) rmSync(pidFile);
    process.env.FAKE_FAIL_ONCE = join(dir, 'failed-once');
    let recoveredThrew = null;
    try {
      await launchChrome({
        log: (...args) => { if (args.join(' ').includes('recovered')) throw new Error('recovered boom'); },
        transport: 'port',
        exposureProbe,
      });
    } catch (err) { recoveredThrew = err; }
    const recoveredPid = readPid();
    assert(recoveredThrew !== null, 'a throwing log on the recovered message must propagate');
    assert(/recovered boom/.test(String(recoveredThrew && recoveredThrew.message)), `the caller's own error must be raised, got ${recoveredThrew}`);
    assert(recoveredPid !== null, 'the second attempt should have recorded its pid');
    assert(!pidAlive(recoveredPid), `the recovered browser must not outlive the failed handoff, but pid ${recoveredPid} is still running`);
    console.log('recovered log OK: a throw after a successful retry also left nothing running');
  } finally {
    // Restore the environment first, so a failure below cannot leak CHROME_BIN to later tests.
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (handle) { try { await handle.close(); } catch {} }
    const leftover = readPid();
    if (leftover !== null && pidAlive(leftover)) { try { process.kill(-leftover, 'SIGKILL'); } catch {} try { process.kill(leftover, 'SIGKILL'); } catch {} }
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === here) {
  // Run EVERY test in this file: a direct invocation must not look green while silently skipping
  // the ones added later. This ran only the first until web-uplift-690r added the concurrency
  // test - the same trap the gemini review of e93a028 found in tests/cdp-pipe-transport.mjs.
  await testCdpEndpointExposure();
  await testEndpointProbesRunConcurrently();
  await testEndpointProbeRejectionStaysFailClosed();
  await testExposureProbeFailuresDoNotLeakTheBrowser();
  await testExposureVerdictIsReadOnceInsideTheTry();
  await testUnprintableProbeNoteDoesNotFailTheLaunch();
  await testTricklingPeerIsBoundedByTheTotalDeadline();
  await testThrowingLogDoesNotLeakTheSpawnedBrowser();
}
