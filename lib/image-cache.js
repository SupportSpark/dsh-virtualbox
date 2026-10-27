/**
 * Image acquisition: download → cache → materialise as a VDI.
 *
 * Format detection is by magic bytes, never by file extension, because cloud
 * endpoints are inconsistent (`*.img` is qcow2 on Ubuntu, raw on others).
 */

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { looksLikeQcow2, qcow2ToRaw } from './qcow2.js';

const QCOW2_MAGIC = 0x514649fb;
const XZ_MAGIC = Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);

/** Probe the on-disk format of an image file. */
export async function detectImageFormat(filePath) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const head = Buffer.alloc(512);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    if (bytesRead < 4) throw new Error(`image too small to identify (${bytesRead} bytes)`);
    if (head.readUInt32BE(0) === QCOW2_MAGIC) return 'qcow2';
    if (head.subarray(0, 6).equals(XZ_MAGIC)) return 'xz';
    if (head[0] === 0x1f && head[1] === 0x8b) return 'gzip';
    if (head.toString('ascii', 257, 262) === 'ustar') return 'tar';
    // MBR/GPT signatures → a partition table, i.e. a raw disk image.
    if (head[510] === 0x55 && head[511] === 0xaa) return 'raw';
    if (head.toString('ascii', 0, 8) === 'EFI PART') return 'raw';
    return 'raw';
  } finally {
    await handle.close();
  }
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * Download a URL into a cache file, atomically and idempotently.
 * Reuses an existing complete file without re-downloading.
 */
export async function downloadImage({
  url,
  cacheDir,
  fileName,
  expectedSha256,
  timeoutMs = 30 * 60 * 1000,
  onProgress,
  signal,
}) {
  await fsp.mkdir(cacheDir, { recursive: true });
  const target = path.join(cacheDir, fileName);
  const part = `${target}.part`;

  if (fs.existsSync(target)) {
    const stat = await fsp.stat(target);
    if (stat.size > 0) {
      const sha256 = expectedSha256 ? await sha256File(target) : undefined;
      if (!expectedSha256 || sha256 === expectedSha256) {
        onProgress?.({ phase: 'cached', received: stat.size, total: stat.size });
        return { path: target, bytes: stat.size, cached: true, sha256 };
      }
      await fsp.rm(target, { force: true });
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`download timed out after ${timeoutMs} ms`)), timeoutMs);
  const abortFromCaller = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abortFromCaller, { once: true });

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'dsh-virtualbox/0.1 (+https://github.com/SupportSpark)' },
    });
    if (!response.ok) {
      throw new Error(`download failed: HTTP ${response.status} ${response.statusText} for ${url}`);
    }
    const total = Number(response.headers.get('content-length') || 0);
    let received = 0;
    let lastReport = 0;
    const meter = new Transform({
      transform(chunk, _enc, callback) {
        received += chunk.length;
        const now = Date.now();
        if (onProgress && (now - lastReport > 500 || received === total)) {
          lastReport = now;
          onProgress({ phase: 'download', received, total });
        }
        callback(null, chunk);
      },
    });
    await pipeline(response.body, meter, fs.createWriteStream(part));
    const size = (await fsp.stat(part)).size;
    if (total && size !== total) {
      throw new Error(`download truncated: expected ${total} bytes, got ${size} (${url})`);
    }
    const sha256 = await sha256File(part);
    if (expectedSha256 && sha256 !== expectedSha256) {
      await fsp.rm(part, { force: true });
      throw new Error(`checksum mismatch for ${url}: expected ${expectedSha256}, got ${sha256}`);
    }
    await fsp.rename(part, target);
    onProgress?.({ phase: 'done', received: size, total: size });
    return { path: target, bytes: size, cached: false, sha256 };
  } catch (error) {
    await fsp.rm(part, { force: true }).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

/**
 * Pick a tar we can drive predictably.
 *
 * On Windows the `tar` on PATH is frequently the MSYS/GNU build shipped with
 * Git for Windows, which rewrites path arguments into its POSIX view and fails
 * on a Windows-relative `-C` target ("Cannot open: No such file or directory").
 * The OS-provided bsdtar (`%SystemRoot%\System32\tar.exe`) handles native paths,
 * has liblzma for `.tar.xz`, and is preferred. `DSH_VBOX_TAR` overrides.
 */
function resolveTar() {
  if (process.env.DSH_VBOX_TAR) return process.env.DSH_VBOX_TAR;
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const candidate = path.join(systemRoot, 'System32', 'tar.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'tar';
}

function runTool(command, args, { timeoutMs = 20 * 60 * 1000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: 'utf8', cwd },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${command} failed: ${(stderr || stdout || error.message).trim().split(/\r?\n/)[0]}`));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

/**
 * `tar` (bsdtar on Windows) parses a `-f` argument as `[user@]host:path`, so a
 * Windows archive path such as `E:\cache\x.tar.xz` is misread as the remote
 * host `E`. Running from the archive's directory and passing only the base
 * name keeps the colon out of tar's argument.
 */
async function extractArchive(archivePath, destDir, format) {
  if (format !== 'xz' && format !== 'tar' && format !== 'gzip') {
    throw new Error(`unsupported archive format ${format}`);
  }
  await fsp.mkdir(destDir, { recursive: true });
  const cwd = path.dirname(archivePath);
  const base = path.basename(archivePath);
  // A relative -C target has no colon, so tar cannot mistake it for a host.
  const relativeDest = path.relative(cwd, destDir) || '.';
  await runTool(resolveTar(), ['-xf', base, '-C', relativeDest], { cwd });
  const entries = await listFilesRecursive(destDir);
  const disk = entries.find((file) => /(\.raw|\.img|\.qcow2)$/i.test(file));
  if (!disk) {
    throw new Error(
      `archive ${base} contains no disk image (members: ${entries.map((file) => path.basename(file)).join(', ') || 'none'})`,
    );
  }
  return disk;
}

async function listFilesRecursive(dir) {
  const out = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFilesRecursive(full)));
    else out.push(full);
  }
  return out;
}

/**
 * Turn a downloaded image into a VDI that VirtualBox can attach.
 *
 * @param {object} options
 * @param {import('./vbox.js').VBox} options.vbox
 * @param {string} options.imagePath   downloaded payload
 * @param {string} options.workDir     scratch directory for intermediates
 * @param {string} options.outputVdi   final VDI path
 * @param {number} [options.diskGB]    grow the virtual disk to at least this size
 * @param {(message:string)=>void} [options.log]
 */
export async function materializeVdi({
  vbox,
  imagePath,
  workDir,
  outputVdi,
  diskGB,
  log = () => {},
}) {
  await fsp.mkdir(workDir, { recursive: true });
  await fsp.mkdir(path.dirname(outputVdi), { recursive: true });
  const format = await detectImageFormat(imagePath);
  log(`image format detected: ${format}`);

  let diskImage = imagePath;
  if (format === 'xz' || format === 'tar' || format === 'gzip') {
    log('extracting archive…');
    diskImage = await extractArchive(imagePath, path.join(workDir, 'extract'), format);
    const inner = await detectImageFormat(diskImage);
    log(`archive member format: ${inner}`);
    if (inner === 'qcow2') {
      const rawPath = path.join(workDir, 'disk.raw');
      log('converting qcow2 → raw (in-process)…');
      await qcow2ToRaw(diskImage, rawPath, {
        onProgress: (fraction) => {
          if (Math.round(fraction * 100) % 20 === 0) log(`qcow2 conversion ${Math.round(fraction * 100)}%`);
        },
      });
      diskImage = rawPath;
    }
  } else if (format === 'qcow2') {
    const rawPath = path.join(workDir, 'disk.raw');
    log('converting qcow2 → raw (in-process)…');
    const result = await qcow2ToRaw(diskImage, rawPath, {
      onProgress: (fraction) => {
        const pct = Math.round(fraction * 100);
        if (pct % 20 === 0) log(`qcow2 conversion ${pct}%`);
      },
    });
    log(
      `qcow2 converted: ${result.allocatedClusters} clusters, ${(result.copiedBytes / 1048576).toFixed(0)} MiB of ${(result.virtualSize / 1048576).toFixed(0)} MiB`,
    );
    diskImage = rawPath;
  } else if (format === 'vmdk') {
    log('cloning vmdk → vdi…');
    await vbox.cloneMedium({ source: diskImage, target: outputVdi, format: 'VDI' });
    diskImage = null;
  }

  if (diskImage) {
    if (fs.existsSync(outputVdi)) await fsp.rm(outputVdi, { force: true });
    log('writing VDI from raw…');
    await vbox.convertFromRaw({ input: diskImage, output: outputVdi, format: 'VDI' });
  }

  const stat = await fsp.stat(outputVdi);
  if (stat.size === 0) throw new Error(`VDI creation produced an empty file: ${outputVdi}`);

  if (diskGB) {
    const targetMB = Math.round(diskGB * 1024);
    await vbox.modifyMedium({ file: outputVdi, resizeMB: targetMB });
    log(`virtual disk resized to ${diskGB} GiB (guest growpart expands the filesystem)`);
  }

  return { vdi: outputVdi, bytes: (await fsp.stat(outputVdi)).size, sourceFormat: format };
}

export { sha256File, runTool };
