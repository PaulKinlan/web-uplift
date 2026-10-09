#!/usr/bin/env node
// The corpus this tool emits must arrive WHOLE when stdout is a pipe (web-uplift-as3).
//
// process.stdout.write() is asynchronous and process.exit() does not wait for it, so piping a
// corpus larger than the pipe buffer used to emit whatever had been flushed and drop the rest
// while still exiting 0: 232941 bytes with -o, exactly 131072 through a pipe, and the only
// signal was a JSON parse failure in whatever consumed it. These cases pin both halves of the
// contract: a pipe gets every byte, and a consumer that goes away is reported.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const here = fileURLToPath(import.meta.url);
const CLI = join(repoRoot, 'tests', 'mwg-drift-classify.mjs');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// A package whose extracted corpus is comfortably larger than the 64 KiB pipe buffer.
function makeBigPackage(dir) {
  const guides = join(dir, 'skills', 'modern-web-guidance', 'guides', 'big');
  mkdirSync(guides, { recursive: true });
  const body = `# Guide\n\n${'This paragraph is repeated so the corpus crosses the pipe buffer by a wide margin. '.repeat(40)}\n`;
  for (let i = 1; i <= 45; i += 1) {
    writeFileSync(join(guides, `big-guide-${i}.md`), `${body}\n## Section\n\nUnique id ${i}.\n${'More text to grow the file, and then some more, so a pipe full of it cannot be buffered away. '.repeat(180)}\n`, 'utf8');
  }
  return dir;
}

// Byte handling without Node Buffer (AGENTS.md): chunks are Uint8Array views that have to be
// copied out of the stream's own buffer, then concatenated and compared by hand.
const concatBytes = (chunks) => {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
};

const sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);

const decoder = new TextDecoder();

const runCli = (args) => new Promise((resolveRun) => {
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [];
  const err = [];
  child.stdout.on('data', (c) => out.push(new Uint8Array(c)));
  child.stderr.on('data', (c) => err.push(new Uint8Array(c)));
  child.once('close', (code, signal) => resolveRun({ code, signal, out: concatBytes(out), err: decoder.decode(concatBytes(err)) }));
});

// Two corpora whose delta is big enough that the REPORT outgrows the pipe buffer: the
// classification report and its --json line are the other unbounded thing this tool emits.
function makeBigDelta(dir, count) {
  const body = 'x'.repeat(40);
  const guides = (prefix, n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}-${i + 1}`, body]));
  const oldCorpus = join(dir, 'corpus-old.json');
  const newCorpus = join(dir, 'corpus-new.json');
  writeFileSync(oldCorpus, JSON.stringify({ version: '1.0.0', guides: guides('guide', count), provenance: {} }), 'utf8');
  writeFileSync(newCorpus, JSON.stringify({
    version: '2.0.0',
    guides: { ...guides('guide', count), ...guides('brand-new', count) },
    provenance: {},
  }), 'utf8');
  return { oldCorpus, newCorpus };
}

export async function testMwgDriftExtractPipe() {
  const tmp = mkdtempSync(join(tmpdir(), 'web-uplift-as3-'));
  try {
    const pkg = makeBigPackage(join(tmp, 'pkg'));
    const fileOut = join(tmp, 'corpus.json');
    const toFile = await runCli(['--extract', pkg, '--version', '1.0.0', '-o', fileOut]);
    assert(toFile.code === 0, `the -o run must succeed: ${toFile.code} ${toFile.err}`);
    const fileBytes = new Uint8Array(readFileSync(fileOut));
    // Wide margin over the pipe buffer on purpose: the closed-consumer case below must not be
    // satisfiable by buffers anywhere in the path.
    assert(fileBytes.length > 256 * 1024, `the fixture must exceed the pipe buffer by a wide margin: ${fileBytes.length} bytes`);

    // 1. THE PIPE GETS EVERY BYTE. Without this, a pipe is a lossy channel that reports success.
    const piped = await runCli(['--extract', pkg, '--version', '1.0.0']);
    assert(piped.code === 0, `the piped run must succeed: ${piped.code} ${piped.err}`);
    assert(piped.out.length === fileBytes.length,
      `the piped corpus must be the whole corpus: ${piped.out.length} bytes through a pipe vs ${fileBytes.length} with -o`);
    assert(sameBytes(piped.out, fileBytes), 'the piped corpus must be byte-identical to the -o corpus');
    const parsed = JSON.parse(decoder.decode(piped.out));
    const guideCount = parsed.guides && typeof parsed.guides === 'object' ? Object.keys(parsed.guides).length : -1;
    assert(guideCount === 45, `the piped corpus must parse and hold every guide: ${guideCount}`);

    // 2. A CONSUMER THAT GOES AWAY IS REPORTED, not swallowed: | head, or anything that exits
    // before reading, must not leave this tool claiming success for a corpus nobody received.
    // The reader is a separate process whose stdin IS this run's stdout, because destroying the
    // parent's read stream does not close the pipe fd and the writer then blocks instead.
    // The reader goes away MID-WRITE: it exits on its first read (or after 1.5s if the writer
    // never starts), which closes the read end of the pipe while the writer still has hundreds
    // of kilobytes to go. Nothing here depends on scheduling, and the test does not take the
    // closure on trust: it asserts below that the writer was interrupted part-way, so a run
    // where the reader never closed fails instead of passing quietly.
    const reader = spawn(process.execPath, ['-e', "process.stdin.once('data', () => process.exit(0)); setTimeout(() => process.exit(0), 1500);"], {
      stdio: ['pipe', 'ignore', 'inherit'],
    });
    const child = spawn(process.execPath, [CLI, '--extract', pkg, '--version', '1.0.0'], { stdio: ['ignore', reader.stdin, 'pipe'] });
    const err = [];
    child.stderr.on('data', (c) => err.push(new Uint8Array(c)));
    const result = await new Promise((resolveClose) => child.once('close', (code, signal) => resolveClose({ code, signal })));
    assert(result.code !== 0, `a closed consumer must not exit 0 (code=${result.code} signal=${result.signal})`);
    const refused = /could not write the extracted corpus to stdout \((\d+) of (\d+) bytes written\)/.exec(decoder.decode(concatBytes(err)));
    assert(refused, `the failure must name how much was written: ${decoder.decode(concatBytes(err))}`);
    assert(Number(refused[1]) < Number(refused[2]),
      `the consumer must have gone away mid-write for this case to test anything (${refused[1]} of ${refused[2]} bytes written)`);
    reader.kill('SIGKILL');
    // 3. THE CLASSIFICATION REPORT IS A PAYLOAD TOO, and it goes out with the same emitter: a
    // 12000-guide delta lost 572803 of its 638339 bytes to the pipe buffer while still exiting 2.
    const { oldCorpus, newCorpus } = makeBigDelta(tmp, 6000);
    const basis = join(repoRoot, 'tests', 'fixtures', 'mwg-drift', 'basis-fixture.json');
    const classifyArgs = ['--old-corpus', oldCorpus, '--new-corpus', newCorpus, '--basis', basis, '--json'];
    const toFileReport = await runCli(classifyArgs);
    assert(toFileReport.code === 2, `a delta must still exit 2: ${toFileReport.code} ${toFileReport.err}`);
    assert(toFileReport.out.length > 256 * 1024, `the fixture delta must exceed the pipe buffer: ${toFileReport.out.length} bytes`);
    const pipedReport = await runCli(classifyArgs);
    assert(pipedReport.code === 2, `the piped run must exit 2 as well: ${pipedReport.code}`);
    assert(pipedReport.out.length === toFileReport.out.length,
      `the piped report must be the whole report: ${pipedReport.out.length} bytes through a pipe vs ${toFileReport.out.length} to a file`);
    assert(sameBytes(pipedReport.out, toFileReport.out), 'the piped report must be byte-identical to the file report');
    const summary = JSON.parse(decoder.decode(pipedReport.out).trim().split('\n').slice(-1)[0]);
    assert(summary.new.length === 6000, `the JSON summary line must survive the pipe: ${summary.new?.length} new guides`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`${here.split('/').slice(-2).join('/')}: tests OK`);
}

if (process.argv[1] && resolve(process.argv[1]) === here) {
  await testMwgDriftExtractPipe();
}
