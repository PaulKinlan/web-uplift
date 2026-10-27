// Writes into a tree the audited agent can write must not follow a link planted at the target
// (web-uplift-rsbb).
//
// The run tree <out>/<site-slug>/<run-id>/ is created by this runner and then handed to an agent
// that holds write tools over it. When that agent exits, the runner writes its own records into the
// same directory: run.json, write-scope.json, the annotated report.json, run-refused.json, the
// flow's evidence. An agent that is finished auditing can leave a link behind at one of those names
// and have the RUNNER's write land on a file outside the tree, with the runner's privileges.
//
// BOTH link types have to be refused, and they need different mechanisms:
//
//   symlink   `open(..., O_NOFOLLOW)` makes the kernel refuse the final component, so there is no
//             check-then-use window. This alone is NOT enough (it was my first cut, and the review
//             found the hole): a SYMLINK is only one way to name another inode.
//   hard link `ln victim run.json` needs no O_NOFOLLOW bypass, because nothing is being followed -
//             the planted name IS the victim's inode. Opening it and writing truncates the victim
//             directly, with no error anywhere, and the runner then reports the run complete.
//             There is no open() flag for this, so the check is on the OPENED FILE DESCRIPTOR
//             (fstat): refuse anything that is not a regular file, and refuse a regular file whose
//             st_nlink is above 1. Doing it on the fd rather than the path is what keeps it race-free
//             - the fd's inode is the inode that would be written.
//
// Also load-bearing: the target is opened WITHOUT O_TRUNC (and the truncation happens only after the
// descriptor check passes). With O_TRUNC in the open flags, a refused target would already have been
// emptied by the time the check ran - the check would report the refusal while the victim was gone.
//
// This is NOT the same defect as web-uplift-9t8 ('tm-runner-harness-write-through-planted-link:
// Fixed' in the same nightly report): 9t8 contained where a PLANTED POINTER may point, so a consumer
// would not READ a directory outside the host root. It refuses nothing about a write landing on a
// planted link, hard or soft.
//
// What this does NOT do, stated rather than hidden: it is not containment (the parent chain is
// checked separately by isRealUnderOutput), it does not authenticate content an agent wrote earlier,
// and on a platform without O_NOFOLLOW it degrades to lstat-then-write, which keeps the hard-link and
// non-regular-file checks but reopens a check-then-use window for symlinks. The honest boundary for
// that is operator-supplied isolation.
import { constants, closeSync, fstatSync, ftruncateSync, lstatSync, openSync, writeFileSync } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

const NOFOLLOW = constants.O_NOFOLLOW;
const HAS_NOFOLLOW = typeof NOFOLLOW === 'number';
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | (HAS_NOFOLLOW ? NOFOLLOW : 0);

export class UnsafeTargetRefused extends Error {
  constructor(path, action, reason) {
    super(`refusing to ${action} ${path}: ${reason}`);
    this.name = 'UnsafeTargetRefused';
    this.code = 'ELOOP';
    this.path = path;
  }
}

function describeKind(st) {
  if (st.isDirectory()) return 'a directory';
  if (st.isFIFO()) return 'a FIFO';
  if (st.isSocket()) return 'a socket';
  if (st.isCharacterDevice()) return 'a character device';
  if (st.isBlockDevice()) return 'a block device';
  if (st.isSymbolicLink()) return 'a symbolic link';
  return 'not a regular file';
}

// The check that covers both link types. `stat` must be the fstat of the descriptor that will be
// written, never a fresh stat of the path.
function assertSafeDescriptor(st, path, action) {
  if (!st.isFile()) {
    throw new UnsafeTargetRefused(
      path,
      action,
      `it is ${describeKind(st)}, not a regular file, so ${action === 'read' ? 'reading' : 'writing'} it would not touch a file this runner created (a planted name in the agent-writable run tree; web-uplift-rsbb)`
    );
  }
  if (st.nlink > 1) {
    throw new UnsafeTargetRefused(
      path,
      action,
      `it has ${st.nlink} hard links, so this is another name for a file that is also reachable outside the run tree; ${action === 'read' ? 'reading' : 'writing'} it would ${action === 'read' ? 'read' : 'change'} that other file (a planted hard link needs no symlink to be followed; web-uplift-rsbb)`
    );
  }
}

const refusedSymlink = (path, action) =>
  new UnsafeTargetRefused(
    path,
    action,
    `the final component is a symbolic link and following it would land outside the run tree (a planted leaf link redirects this runner's own write; web-uplift-rsbb)`
  );

// Replace the file at `path` (or create it), refusing a symlink at the leaf, a non-regular file, and
// a hard link (st_nlink > 1). The existing content is truncated only AFTER the descriptor check.
export async function writeFileNoFollow(path, data, options) {
  await assertSafePath(path, 'write');
  let handle;
  try {
    handle = await open(path, WRITE_FLAGS, options?.mode ?? 0o644);
  } catch (err) {
    if (err.code === 'ELOOP') throw refusedSymlink(path, 'write');
    throw err;
  }
  try {
    assertSafeDescriptor(await handle.stat(), path, 'write');
    await handle.truncate(0);
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}

// Same guard for the synchronous write paths.
export function writeFileNoFollowSync(path, data, options) {
  {
    let st = null;
    try { st = lstatSync(path); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    if (st?.isSymbolicLink()) throw refusedSymlink(path, 'write');
    if (st) assertSafeDescriptor(st, path, 'write');
  }
  let fd;
  try {
    fd = openSync(path, WRITE_FLAGS, options?.mode ?? 0o644);
  } catch (err) {
    if (err.code === 'ELOOP') throw refusedSymlink(path, 'write');
    throw err;
  }
  try {
    assertSafeDescriptor(fstatSync(fd), path, 'write');
    ftruncateSync(fd, 0);
    writeFileSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

// A READ of an agent-controlled path has the mirror problem: readFile() follows a leaf link, so a
// planted `report.json -> <another run>/report.json` (or any readable file, including a hard link) is
// read as if it were this run's report - and then REWRITTEN through the same name.
export async function readFileNoFollow(path, encoding = 'utf8') {
  await assertSafePath(path, 'read');
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (HAS_NOFOLLOW ? NOFOLLOW : 0));
  } catch (err) {
    if (err.code === 'ELOOP') throw refusedSymlink(path, 'read');
    throw err;
  }
  try {
    assertSafeDescriptor(await handle.stat(), path, 'read');
    return await handle.readFile(encoding);
  } finally {
    await handle.close();
  }
}

// A PATH-level check runs on every platform, and it is not redundant with the descriptor check below:
// it is what fails fast and, more importantly, what keeps the runner from OPENING a planted FIFO
// (open(2) on a FIFO with no reader BLOCKS, so a planted name would hang the batch rather than fail
// it). The descriptor check is still the authority - it is race-free - and this one is advisory. On a
// platform without O_NOFOLLOW this path check is also what stands between a symlink and the write, and
// there the residual is a check-then-use window between the lstat and the open.
async function assertSafePath(path, action) {
  let st;
  try {
    st = await lstat(path);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  if (st.isSymbolicLink()) throw refusedSymlink(path, action);
  assertSafeDescriptor(st, path, action);
}

export function isNoFollowSupported() {
  return HAS_NOFOLLOW;
}
