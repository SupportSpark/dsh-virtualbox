/**
 * Guest access helpers: key material, TCP/SSH readiness probes, command
 * execution. Uses the host's OpenSSH client so no guest agent is required.
 */

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

function runHost(command, args, { timeoutMs = 60000, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: stdout || '',
          stderr: stderr || '',
          message: error?.message,
        });
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

/**
 * Restrict the private key to the current user.
 *
 * OpenSSH refuses a private key that other accounts can read ("UNPROTECTED
 * PRIVATE KEY FILE ... bad permissions"), and on Windows a freshly written file
 * inherits the parent directory's ACEs — which routinely include
 * `Authenticated Users` and `BUILTIN\Users`. Without this step every guest
 * login fails with `Permission denied (publickey)` even though the key is the
 * right one. Applied to existing keys too, so a profile repaired from an older
 * version heals on next use.
 */
/** Paths already hardened in this process, so repeated SSH calls stay cheap. */
const hardenedKeys = new Set();

export async function hardenPrivateKey(keyPath) {
  const dir = path.dirname(keyPath);
  if (hardenedKeys.has(keyPath)) return;
  if (process.platform === 'win32') {
    const user = `${process.env.USERDOMAIN || process.env.COMPUTERNAME}\\${process.env.USERNAME}`;
    // Directory first: new files inherit from it, so tighten the source.
    await runHost('icacls', [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`]);
    await runHost('icacls', [keyPath, '/inheritance:r', '/grant:r', `${user}:F`]);
    hardenedKeys.add(keyPath);
    return;
  }
  await fsp.chmod(keyPath, 0o600).catch(() => {});
  await fsp.chmod(dir, 0o700).catch(() => {});
  hardenedKeys.add(keyPath);
}

/**
 * Ensure an ed25519 key pair exists, generating it when missing, and make sure
 * the private half is not readable by other accounts.
 * @returns {Promise<{privateKeyPath:string, publicKey:string, created:boolean}>}
 */
export async function ensureSshKey(keyPath) {
  const dir = path.dirname(keyPath);
  await fsp.mkdir(dir, { recursive: true });
  const pubPath = `${keyPath}.pub`;
  const exists = fs.existsSync(keyPath) && fs.existsSync(pubPath);
  if (!exists) {
    const result = await runHost('ssh-keygen', [
      '-t',
      'ed25519',
      '-f',
      keyPath,
      '-N',
      '',
      '-C',
      'dsh-virtualbox',
    ]);
    if (result.code !== 0) {
      throw new Error(
        `ssh-keygen failed (${result.code}): ${(result.stderr || result.message || '').trim()}`,
      );
    }
  }
  // Always harden: covers freshly generated keys and keys from older installs
  // whose inherited ACLs OpenSSH rejects.
  await hardenPrivateKey(keyPath);
  return {
    privateKeyPath: keyPath,
    publicKey: (await fsp.readFile(pubPath, 'utf8')).trim(),
    created: !exists,
  };
}

/** Generate a throwaway key pair (used when a spec must not touch the shared key). */
export async function createEphemeralKey(dir) {
  await fsp.mkdir(dir, { recursive: true });
  const keyPath = path.join(dir, `id_ed25519_${crypto.randomBytes(4).toString('hex')}`);
  return ensureSshKey(keyPath);
}

/** Resolve once a TCP connect to host:port succeeds. */
export function probeTcp(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait until the guest answers on its forwarded SSH port, then until the login
 * actually succeeds (sshd accepts our key).
 */
export async function waitForSsh(
  { host = '127.0.0.1', port, user, privateKeyPath, knownHostsPath, timeoutMs = 300000, intervalMs = 3000, signal },
) {
  const deadline = Date.now() + timeoutMs;
  const attempts = [];
  let tcpReady = false;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('aborted while waiting for SSH');
    if (!tcpReady) tcpReady = await probeTcp(host, port, 3000);
    if (tcpReady) {
      const probe = await sshExec({
        host,
        port,
        user,
        privateKeyPath,
        knownHostsPath,
        command: 'echo dsh-ssh-ready',
        timeoutMs: 20000,
      });
      attempts.push(probe.code);
      if (probe.code === 0 && probe.stdout.includes('dsh-ssh-ready')) {
        return { ready: true, waitedMs: timeoutMs - (deadline - Date.now()), attempts: attempts.length };
      }
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `SSH did not become ready within ${Math.round(timeoutMs / 1000)}s on ${host}:${port} (user ${user}); probes: ${attempts.length}`,
  );
}

/**
 * Run one command in the guest over SSH.
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
export async function sshExec({
  host = '127.0.0.1',
  port,
  user,
  privateKeyPath,
  knownHostsPath,
  command,
  timeoutMs = 120000,
  input,
}) {
  await hardenPrivateKey(privateKeyPath);
  const args = [
    '-p',
    String(port),
    '-i',
    privateKeyPath,
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    `UserKnownHostsFile=${knownHostsPath}`,
    '-o',
    'LogLevel=ERROR',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=15',
    `${user}@${host}`,
    command,
  ];
  const result = await runHost('ssh', args, { timeoutMs, input });
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}

/** Copy a local file into the guest (needs the OpenSSH scp client). */
export async function scpToGuest({
  host = '127.0.0.1',
  port,
  user,
  privateKeyPath,
  knownHostsPath,
  localPath,
  remotePath,
  timeoutMs = 300000,
}) {
  const args = [
    '-P',
    String(port),
    '-i',
    privateKeyPath,
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    `UserKnownHostsFile=${knownHostsPath}`,
    '-o',
    'LogLevel=ERROR',
    localPath,
    `${user}@${host}:${remotePath}`,
  ];
  const result = await runHost('scp', args, { timeoutMs });
  if (result.code !== 0) {
    throw new Error(`scp failed: ${(result.stderr || result.message || '').trim()}`);
  }
  return result;
}

/** Wait for cloud-init to finish, so provisioning commands can rely on it. */
export async function waitForCloudInit({
  host = '127.0.0.1',
  port,
  user,
  privateKeyPath,
  knownHostsPath,
  timeoutMs = 600000,
  signal,
}) {
  const deadline = Date.now() + timeoutMs;
  const ssh = (command, timeout = 30000) =>
    sshExec({ host, port, user, privateKeyPath, knownHostsPath, command, timeoutMs: timeout });

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('aborted while waiting for cloud-init');
    // `boot-finished` is cloud-init's own end-of-boot sentinel: it appears only
    // after the final (scripts-user / runcmd) stage, which is exactly the point
    // callers care about. Parsing `cloud-init status` text alone is not enough —
    // it can read "done" for a stage while later stages are still queued.
    const probe = await ssh(
      'if [ -f /var/lib/cloud/instance/boot-finished ]; then echo SENTINEL-DONE; ' +
        'elif command -v cloud-init >/dev/null 2>&1; then echo SENTINEL-WAITING; ' +
        'else echo SENTINEL-NONE; fi',
    );
    const text = `${probe.stdout}${probe.stderr}`;
    if (text.includes('SENTINEL-NONE')) return { status: 'unavailable' };
    if (text.includes('SENTINEL-DONE')) {
      const final = await ssh('cloud-init status 2>&1 | head -n 4');
      const finalText = `${final.stdout}${final.stderr}`;
      if (/status:\s*error/.test(finalText)) {
        const detail = await ssh('cloud-init status --long 2>&1 | head -n 12');
        const log = await ssh('sudo -n tail -n 40 /var/log/cloud-init-output.log 2>&1');
        return {
          status: 'error',
          detail: detail.stdout.trim(),
          log: log.stdout.trim(),
        };
      }
      return { status: 'done' };
    }
    await sleep(5000);
  }
  return { status: 'timeout' };
}

export { runHost, sleep };
