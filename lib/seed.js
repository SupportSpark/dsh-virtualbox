/**
 * cloud-init NoCloud seed generation (meta-data + user-data → ISO9660).
 *
 * The seed is what turns a stock cloud image into a usable, SSH-reachable VM:
 * it creates the login user, installs the SSH public key, enables passwordless
 * sudo, starts sshd and (optionally) runs provisioning commands.
 */

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { buildIso9660 } from './iso9660.js';

/** YAML scalar quoting: bare when safe, single-quoted otherwise. */
function yamlScalar(value) {
  const text = String(value);
  if (text === '') return "''";
  if (/^[A-Za-z0-9_./@+-]+$/.test(text) && !/^(true|false|null|yes|no|on|off)$/i.test(text)) {
    return text;
  }
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * Build cloud-config user-data.
 * @param {object} options
 */
export function buildUserData({
  user = 'dev',
  password,
  sshPublicKey,
  hostname,
  sudo = true,
  packages = [],
  runcmd = [],
  writeFiles = [],
  growpart = true,
  sshPasswordAuth = false,
  timezone = 'UTC',
  locale,
  aptMirror,
}) {
  const lines = ['#cloud-config', 'preserve_hostname: false'];
  lines.push(`hostname: ${yamlScalar(hostname || 'dsh-vm')}`);
  if (timezone) lines.push(`timezone: ${yamlScalar(timezone)}`);
  // A locale is only emitted when the caller asks for one: cloud images ship
  // without generated locales, and `update-locale` then exits non-zero, which
  // fails cloud-init's whole config stage and silently skips `runcmd`.
  if (locale) {
    lines.push('locale: ' + yamlScalar(locale));
    lines.push('locale_configfile: /etc/default/locale');
  }
  // Upstream mirrors can be an order of magnitude slower than a nearby one
  // (deb.debian.org measured 76 kB/s here vs 12.6 MB/s from a regional mirror),
  // which turns `apt-get update` into minutes. cloud-init rewrites the sources
  // before any `packages:` work happens.
  if (aptMirror && aptMirror.uri) {
    lines.push('apt:');
    lines.push('  primary:');
    lines.push('    - arches: [default]');
    lines.push(`      uri: ${yamlScalar(aptMirror.uri)}`);
    if (aptMirror.suites && aptMirror.suites.length) {
      lines.push('      suites:');
      for (const suite of aptMirror.suites) lines.push(`        - ${yamlScalar(suite)}`);
    }
    if (aptMirror.security && aptMirror.security.uri) {
      lines.push('  security:');
      lines.push('    - arches: [default]');
      lines.push(`      uri: ${yamlScalar(aptMirror.security.uri)}`);
    }
    lines.push('  conf: |');
    lines.push('    Acquire::Retries "3";');
  }

  lines.push('users:');
  lines.push(`  - name: ${yamlScalar(user)}`);
  lines.push('    lock_passwd: false');
  lines.push('    shell: /bin/bash');
  if (sudo) lines.push('    sudo: ALL=(ALL) NOPASSWD:ALL');
  if (sshPublicKey) {
    lines.push('    ssh_authorized_keys:');
    for (const key of String(sshPublicKey).split(/\r?\n/).map((k) => k.trim()).filter(Boolean)) {
      lines.push(`      - ${yamlScalar(key)}`);
    }
  }

  lines.push('ssh_pwauth: ' + (sshPasswordAuth ? 'true' : 'false'));
  lines.push('disable_root: false');

  if (password) {
    // chpasswd list form keeps the hash out of shell history; cloud-init
    // hashes plain-text entries itself when `type: text` is given.
    lines.push('chpasswd:');
    lines.push('  expire: false');
    lines.push('  users:');
    lines.push(`    - {name: ${yamlScalar(user)}, password: ${yamlScalar(password)}, type: text}`);
    lines.push(`    - {name: root, password: ${yamlScalar(password)}, type: text}`);
  }

  if (growpart) {
    lines.push('growpart:');
    lines.push('  mode: auto');
    lines.push('  devices: ["/"]');
    lines.push('  ignore_growroot_disabled: false');
    lines.push('resize_rootfs: true');
  }

  if (packages.length > 0) {
    lines.push('package_update: true');
    lines.push('packages:');
    for (const pkg of packages) lines.push(`  - ${yamlScalar(pkg)}`);
  }

  if (writeFiles.length > 0) {
    lines.push('write_files:');
    for (const file of writeFiles) {
      lines.push(`  - path: ${yamlScalar(file.path)}`);
      if (file.permissions) lines.push(`    permissions: ${yamlScalar(file.permissions)}`);
      if (file.owner) lines.push(`    owner: ${yamlScalar(file.owner)}`);
      const content = Buffer.isBuffer(file.content)
        ? file.content.toString('base64')
        : String(file.content ?? '');
      if (Buffer.isBuffer(file.content)) {
        lines.push('    encoding: b64');
        lines.push(`    content: ${yamlScalar(content)}`);
      } else {
        lines.push('    content: |');
        for (const line of content.split(/\r?\n/)) lines.push(`      ${line}`);
      }
    }
  }

  const commands = [...runcmd];
  // A marker file lets `vbox_wait_ssh` distinguish "sshd up" from "cloud-init
  // finished", which is what callers actually want before running tests.
  if (growpart) commands.push('echo ready > /var/run/cloud-init-done || true');
  if (commands.length > 0) {
    lines.push('runcmd:');
    for (const command of commands) lines.push(`  - ${yamlScalar(command)}`);
  }

  lines.push('final_message: "dsh-virtualbox: cloud-init finished in $UPTIME seconds"');
  return `${lines.join('\n')}\n`;
}

export function buildMetaData({ instanceId, hostname }) {
  return [
    `instance-id: ${instanceId}`,
    `local-hostname: ${hostname || 'dsh-vm'}`,
    'cloud-name: dsh-virtualbox',
    '',
  ].join('\n');
}

/**
 * Render the seed ISO for a spec.
 * @returns {Promise<{path:string, iso:Buffer, userData:string, metaData:string, sha256:string}>}
 */
export async function writeSeedIso({ outPath, spec, sshPublicKey, hostname }) {
  const instanceId = spec.instanceId || `dsh-${crypto.randomUUID()}`;
  const userData = buildUserData({
    user: spec.user,
    password: spec.password,
    sshPublicKey,
    hostname: hostname || spec.name,
    packages: spec.packages || [],
    runcmd: spec.runcmd || [],
    writeFiles: spec.writeFiles || [],
    growpart: spec.growpart !== false,
    sshPasswordAuth: Boolean(spec.sshPasswordAuth),
    timezone: spec.timezone,
    locale: spec.locale,
    aptMirror: spec.aptMirror,
  });
  const metaData = buildMetaData({ instanceId, hostname: hostname || spec.name });
  const files = [
    { name: 'meta-data', data: metaData },
    { name: 'user-data', data: userData },
  ];
  if (spec.networkConfig) {
    files.push({ name: 'network-config', data: spec.networkConfig });
  }
  const iso = buildIso9660({ volumeLabel: 'cidata', files });
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.writeFile(outPath, iso);
  return {
    path: outPath,
    iso,
    userData,
    metaData,
    sha256: crypto.createHash('sha256').update(iso).digest('hex'),
  };
}
