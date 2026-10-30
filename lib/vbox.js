/**
 * VBoxManage wrapper.
 *
 * Everything goes through `execFile` with an explicit argument vector — no
 * shell string interpolation, so VM names, paths and ISO labels containing
 * spaces or quotes cannot break out into a command line.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export class VBoxError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'VBoxError';
    this.code = details.code;
    this.argv = details.argv;
    this.stdout = details.stdout;
    this.stderr = details.stderr;
    this.durationMs = details.durationMs;
  }
}

/**
 * Locate VBoxManage.
 * Order: explicit config path → env vars → registry-independent default
 * install locations → PATH.
 */
export function resolveVBoxManage(explicit) {
  const isWindows = process.platform === 'win32';
  const exe = isWindows ? 'VBoxManage.exe' : 'VBoxManage';
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.VBOX_MSI_INSTALL_PATH) {
    candidates.push(path.join(process.env.VBOX_MSI_INSTALL_PATH, exe));
  }
  if (process.env.VBOX_INSTALL_PATH) {
    candidates.push(path.join(process.env.VBOX_INSTALL_PATH, exe));
  }
  if (isWindows) {
    for (const drive of ['C:', 'D:', 'E:', 'F:']) {
      candidates.push(`${drive}\\Program Files\\Oracle\\VirtualBox\\${exe}`);
      candidates.push(`${drive}\\Program Files (x86)\\Oracle\\VirtualBox\\${exe}`);
      candidates.push(`${drive}\\VirtualBox\\${exe}`);
      candidates.push(`${drive}\\Oracle\\VirtualBox\\${exe}`);
    }
  } else {
    candidates.push('/usr/bin/VBoxManage', '/usr/local/bin/VBoxManage', '/opt/VirtualBox/VBoxManage');
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    candidates.push(path.join(dir, exe));
  }
  for (const candidate of candidates) {
    try {
      if (candidate && fs.statSync(candidate).isFile()) return path.resolve(candidate);
    } catch {
      /* keep looking */
    }
  }
  throw new VBoxError(
    `VBoxManage not found. Looked at ${candidates.length} locations (config, VBOX_MSI_INSTALL_PATH, default install dirs, PATH). Install VirtualBox, or set vboxManagePath in the plugin config.`,
  );
}

/** Parse `VBoxManage showvminfo --machinereadable` output into a flat object. */
export function parseMachineReadable(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith(' ')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    if (key in result) {
      // Forwarding(n), nicproperties etc. legitimately repeat only with a
      // distinct index in the key; a true duplicate means we keep the last
      // observed value, matching VirtualBox's own "latest wins" semantics.
      result[key] = value;
    } else {
      result[key] = value;
    }
  }
  return result;
}

export class VBox {
  constructor({ executable, timeoutMs = 120000, defaultVmFolder } = {}) {
    this.executable = executable || resolveVBoxManage();
    this.timeoutMs = timeoutMs;
    this.defaultVmFolder = defaultVmFolder;
  }

  /** Run VBoxManage. Resolves on exit 0, rejects with VBoxError otherwise. */
  run(args, { timeoutMs, allowFailure = false, input } = {}) {
    const argv = [this.executable, ...args];
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.executable,
        args,
        {
          timeout: timeoutMs ?? this.timeoutMs,
          maxBuffer: 32 * 1024 * 1024,
          windowsHide: true,
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          const durationMs = Date.now() - started;
          if (error && !allowFailure) {
            reject(
              new VBoxError(
                `VBoxManage ${args[0]} failed: ${(stderr || stdout || error.message || '').trim().split(/\r?\n/)[0]}`,
                {
                  code: error.code ?? (typeof error.code === 'number' ? error.code : undefined),
                  argv,
                  stdout,
                  stderr,
                  durationMs,
                },
              ),
            );
            return;
          }
          resolve({
            argv,
            code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
            stdout: stdout || '',
            stderr: stderr || '',
            durationMs,
            timedOut: Boolean(error && error.killed),
          });
        },
      );
      if (input !== undefined) {
        child.stdin?.end(input);
      }
    });
  }

  async text(args, options) {
    const result = await this.run(args, options);
    return result.stdout.trim();
  }

  async version() {
    return this.text(['--version']);
  }

  async listVms() {
    const out = await this.text(['list', 'vms']);
    const vms = [];
    for (const line of out.split(/\r?\n/)) {
      const match = /^"(.+)"\s+\{([0-9a-f-]+)\}$/.exec(line.trim());
      if (match) vms.push({ name: match[1], uuid: match[2] });
    }
    return vms;
  }

  async runningVms() {
    const out = await this.text(['list', 'runningvms']);
    const names = new Set();
    for (const line of out.split(/\r?\n/)) {
      const match = /^"(.+)"\s+\{([0-9a-f-]+)\}$/.exec(line.trim());
      if (match) names.add(match[1]);
    }
    return names;
  }

  /**
   * Which execution engine VirtualBox gets on this host, and — on Windows —
   * what is holding VT-x.
   *
   * `HypervisorPresent` alone is misleading: disabling the Hyper-V optional
   * features does not release VT-x while VBS / HVCI (memory integrity) is
   * active, so VirtualBox keeps running on NEM/WHP instead of native VT-x.
   * `hvservice` running is the runtime signal that some hypervisor owns VT-x;
   * the registry values say which one was configured.
   */
  async hostVirtualization() {
    if (process.platform !== 'win32') {
      return { engine: 'native', hypervisorPresent: null, note: 'non-Windows host' };
    }
    // sc.exe is not a VBoxManage command, so query it directly.
    const scState = await new Promise((resolve) => {
      execFile('sc.exe', ['query', 'hvservice'], { windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
        const text = `${stdout || ''}${stderr || ''}`;
        const match = /STATE\s*:\s*(\d+)\s+(\w+)/i.exec(text);
        if (error && !match) {
          resolve(null);
          return;
        }
        resolve(match ? { code: Number(match[1]), state: match[2].toUpperCase() } : null);
      });
    });

    const regValue = (key, name) =>
      new Promise((resolve) => {
        execFile('reg.exe', ['query', key, '/v', name], { windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
          if (error) {
            resolve(null);
            return;
          }
          const match = new RegExp(`${name}\\s+REG_DWORD\\s+0x([0-9a-f]+)`, 'i').exec(stdout);
          resolve(match ? Number.parseInt(match[1], 16) : null);
        });
      });

    const vbsEnabled = await regValue(
      'HKLM\\SYSTEM\\CurrentControlSet\\Control\\DeviceGuard',
      'EnableVirtualizationBasedSecurity',
    );
    const hvciEnabled = await regValue(
      'HKLM\\SYSTEM\\CurrentControlSet\\Control\\DeviceGuard\\Scenarios\\HypervisorEnforcedCodeIntegrity',
      'Enabled',
    );
    const hypervisorRunning = scState ? scState.code === 4 : null;

    return {
      engine: hypervisorRunning ? 'nem-whp' : hypervisorRunning === false ? 'native-vmx' : 'unknown',
      hypervisorRunning,
      hvservice: scState,
      vbsConfigured: vbsEnabled === null ? null : vbsEnabled === 1,
      hvciConfigured: hvciEnabled === null ? null : hvciEnabled === 1,
      note: hypervisorRunning
        ? 'a hypervisor holds the CPU virtualization extensions (AMD-V/SVM or VT-x), so VirtualBox falls back to NEM/WHP. Hyper-V being disabled is not sufficient: VBS/HVCI, Credential Guard or KeyGuard keep a hypervisor running, and Windows then ignores hypervisorlaunchtype'
        : 'no hypervisor reported; VirtualBox should use the native virtualization extensions',
    };
  }

  async hostInfo() {
    const out = await this.text(['list', 'hostinfo']);
    const info = {};
    for (const line of out.split(/\r?\n/)) {
      const match = /^([^:]+):\s*(.+)$/.exec(line.trim());
      if (match) info[match[1].trim()] = match[2].trim();
    }
    return info;
  }

  /** Full machine-readable VM state, or null when the VM does not exist. */
  async info(name) {
    const result = await this.run(['showvminfo', name, '--machinereadable'], { allowFailure: true });
    if (result.code !== 0) return null;
    return parseMachineReadable(result.stdout);
  }

  async exists(name) {
    return (await this.info(name)) !== null;
  }

  async state(name) {
    const info = await this.info(name);
    return info ? info.VMState : null;
  }

  async createVm({ name, ostype = 'Debian_64', baseFolder } = {}) {
    const folder = baseFolder || this.defaultVmFolder;
    const args = ['createvm', '--name', name, '--ostype', ostype, '--register'];
    if (folder) {
      await fsp.mkdir(folder, { recursive: true });
      args.push('--basefolder', folder);
    }
    return this.text(args);
  }

  /**
   * Apply modifyvm options. Accepts an object mapping option name (without
   * leading `--`) to a value:
   *   - `true`            → bare flag (`--key`)
   *   - scalar            → `--key value`
   *   - array             → the flag repeated once per element (`--natpf1 a --natpf1 b`)
   *   - `{ args: [...] }` → one flag with several operands (`--uart1 0x3f8 4`)
   */
  async modifyVm(name, options) {
    const args = ['modifyvm', name];
    for (const [key, value] of Object.entries(options)) {
      if (value === undefined || value === null || value === false) continue;
      if (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.args)) {
        args.push(`--${key}`, ...value.args.map(String));
        continue;
      }
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) {
        args.push(`--${key}`);
        if (item !== true) args.push(String(item));
      }
    }
    return this.text(args);
  }

  async createDisk({ file, sizeMB, format = 'VDI' }) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    return this.text([
      'createmedium',
      'disk',
      '--filename',
      file,
      '--size',
      String(sizeMB),
      '--format',
      format,
    ]);
  }

  async modifyMedium({ file, resizeMB }) {
    const args = ['modifymedium', 'disk', file];
    if (resizeMB !== undefined) args.push('--resize', String(resizeMB));
    return this.text(args);
  }

  async convertFromRaw({ input, output, format = 'VDI', variant = 'Standard' }) {
    return this.text([
      'convertfromraw',
      input,
      output,
      '--format',
      format,
      '--variant',
      variant,
    ]);
  }

  async cloneMedium({ source, target, format = 'VDI' }) {
    return this.text(['clonemedium', 'disk', source, target, '--format', format]);
  }

  async storageCtl({ name, ctl, add, controller, portCount, hostIocache }) {
    const args = ['storagectl', name, '--name', ctl];
    if (add) args.push('--add', add);
    if (controller) args.push('--controller', controller);
    if (portCount !== undefined) args.push('--portcount', String(portCount));
    if (hostIocache !== undefined) args.push('--hostiocache', hostIocache ? 'on' : 'off');
    return this.text(args);
  }

  /**
   * Attach (or, with `medium: 'none'`, detach) a medium at one controller slot.
   *
   * `discard` and `nonrotational` are not cosmetic. Without discard the guest's
   * TRIM commands never reach the VDI, so every block the guest has ever written
   * stays allocated: a 20 GiB disk with a few GiB of real data grows towards its
   * full size, and `modifymedium --compact` has nothing to reclaim. `nonrotational`
   * tells the guest kernel the medium is not a spinning disk, so it issues TRIM
   * at all. Both are recorded in the VM settings, so they must be set while the
   * VM is powered off.
   */
  async storageAttach({ name, ctl, port, device = 0, type, medium, mediumType, discard, nonrotational }) {
    const args = ['storageattach', name, '--storagectl', ctl, '--port', String(port), '--device', String(device), '--type', type];
    if (medium) args.push('--medium', medium);
    if (mediumType) args.push('--medium-type', mediumType);
    if (discard !== undefined) args.push('--discard', discard ? 'on' : 'off');
    if (nonrotational !== undefined) args.push('--nonrotational', nonrotational ? 'on' : 'off');
    return this.text(args);
  }

  async setBootOrder(name, order) {
    // `--boot1`..`--boot4` on modifyvm; 'none' for unused slots.
    const options = {};
    for (let i = 0; i < 4; i += 1) options[`boot${i + 1}`] = order[i] || 'none';
    return this.modifyVm(name, options);
  }

  async start(name, type = 'headless') {
    return this.text(['startvm', name, '--type', type], { timeoutMs: 180000 });
  }

  async control(name, command, extra = [], options = {}) {
    return this.text(['controlvm', name, command, ...extra], options);
  }

  async powerOff(name) {
    return this.control(name, 'poweroff', [], { allowFailure: true });
  }

  async acpiShutdown(name) {
    return this.control(name, 'acpipowerbutton', [], { allowFailure: true });
  }

  async saveState(name) {
    return this.control(name, 'savestate', [], { allowFailure: true });
  }

  async unregister(name, { delete: remove = true } = {}) {
    const args = ['unregistervm', name];
    if (remove) args.push('--delete');
    return this.text(args, { allowFailure: true });
  }

  async screenshot(name, file) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) await fsp.rm(file, { force: true });
    return this.control(name, 'screenshotpng', [file]);
  }

  async keyboardPutString(name, text) {
    return this.control(name, 'keyboardputstring', [text]);
  }

  async snapshotList(name) {
    const out = await this.text(['snapshot', name, 'list', '--machinereadable'], {
      allowFailure: true,
    });
    const snapshots = [];
    let current = null;
    for (const line of out.split(/\r?\n/)) {
      const kv = /^([^=]+)="?(.*?)"?$/.exec(line.trim());
      if (!kv) continue;
      const [, key, value] = kv;
      if (key === 'SnapshotName') {
        if (current) snapshots.push(current);
        current = { name: value };
      } else if (key === 'SnapshotUUID' && current) {
        current.uuid = value;
      } else if (key === 'SnapshotDescription' && current) {
        current.description = value;
      }
    }
    if (current) snapshots.push(current);
    return snapshots;
  }

  async snapshotTake(name, snapshotName, description) {
    const args = ['snapshot', name, 'take', snapshotName];
    if (description) args.push('--description', description);
    return this.text(args, { timeoutMs: 600000 });
  }

  async snapshotRestore(name, snapshotName) {
    return this.text(['snapshot', name, 'restore', snapshotName], { timeoutMs: 600000 });
  }

  async snapshotDelete(name, snapshotName) {
    return this.text(['snapshot', name, 'delete', snapshotName], { timeoutMs: 600000 });
  }

  async cloneVm({ name, target, snapshot, mode = 'machine', options = 'keepallmacs', baseFolder }) {
    const args = ['clonevm', name, '--name', target, '--mode', mode, '--options', options];
    if (snapshot) args.push('--snapshot', snapshot);
    if (baseFolder) args.push('--basefolder', baseFolder);
    args.push('--register');
    return this.text(args, { timeoutMs: 1800000 });
  }

  async guestPropertyGet(name, prop) {
    const out = await this.text(['guestproperty', 'get', name, prop], { allowFailure: true });
    const match = /^Value:\s*(.*)$/m.exec(out);
    return match ? match[1].trim() : null;
  }

  /**
   * Read the guest IP that VirtualBox's NAT/DHCP reports for the VM. Only
   * meaningful after Guest Additions or a DHCP lease reports it; for
   * forwarded-port workflows this is informational.
   */
  async guestIps(name) {
    const out = await this.text(['guestproperty', 'enumerate', name], { allowFailure: true });
    const ips = [];
    for (const line of out.split(/\r?\n/)) {
      const match = /^Name:\s*\/VirtualBox\/Guest\/Net\/(\d+)\/V4\/IP,\s*value:\s*(\S+)/.exec(line.trim());
      if (match) ips.push({ nic: Number(match[1]), ip: match[2] });
    }
    return ips;
  }

  // ---------------------------------------------------------------- host-only

  /** `list hostonlyifs` — the host-only adapter pool (DHCP, IP, netmask). */
  async listHostOnlyIfs() {
    const out = await this.text(['list', 'hostonlyifs'], { allowFailure: true });
    return parseBlocks(out).map((row) => ({
      name: row.Name,
      guid: row.GUID,
      ip: row.IPAddress,
      netmask: row.NetworkMask,
      dhcp: row.DHCP,
      ipv6: row.IPV6Address,
      status: row.Status,
    }));
  }

  /** `hostonlyif create` — returns the new adapter name (`vboxnet0`, …). */
  async createHostOnlyIf() {
    const out = await this.text(['hostonlyif', 'create']);
    const match = /Interface '([^']+)'/.exec(out) || /'([^']+)'/.exec(out);
    return match ? match[1] : null;
  }

  async configureHostOnlyIf(name, { ip, netmask } = {}) {
    const args = ['hostonlyif', 'ipconfig', name];
    if (ip) args.push('--ip', ip);
    if (netmask) args.push('--netmask', netmask);
    return this.text(args);
  }

  async removeHostOnlyIf(name) {
    return this.text(['hostonlyif', 'remove', name]);
  }

  // ---------------------------------------------------------------------- NAT

  /** `list natnetworks` — named NAT networks, as opposed to per-NIC NAT. */
  async listNatNetworks() {
    const out = await this.text(['list', 'natnetworks'], { allowFailure: true });
    return parseBlocks(out).map((row) => ({
      name: row.Name,
      network: row.Network,
      gateway: row.Gateway,
      dhcp: row.DHCP,
      enabled: row.Enabled,
      ipv6: row.IPv6,
    }));
  }

  /**
   * Port-forward rules of a VM, read back from `showvminfo --machinereadable`.
   * Each rule renders as `Forwarding(0)="name,protocol,hostip,hostport,guestip,guestport"`,
   * so the NIC index is the key suffix + 1.
   */
  async natRules(name) {
    const info = await this.info(name);
    if (!info) return null;
    const rules = [];
    for (const [key, value] of Object.entries(info)) {
      const match = /^Forwarding\((\d+)\)$/.exec(key);
      if (!match) continue;
      const [ruleName, protocol, hostIp, hostPort, guestIp, guestPort] = String(value).split(',');
      rules.push({
        nic: Number(match[1]) + 1,
        name: ruleName,
        protocol,
        hostIp,
        hostPort,
        guestIp,
        guestPort,
      });
    }
    return rules;
  }

  /** Build the `name,protocol,hostip,hostport,guestip,guestport` rule body. */
  static formatNatRule({ ruleName, protocol = 'tcp', hostIp = '', hostPort, guestIp = '', guestPort }) {
    if (!ruleName) throw new VBoxError('add_nat_rule needs a rule name.');
    if (!hostPort || !guestPort) throw new VBoxError('add_nat_rule needs hostPort and guestPort.');
    return [ruleName, protocol, hostIp, hostPort, guestIp, guestPort].join(',');
  }

  /**
   * Add a port forward. A running VM takes the rule through `controlvm`; a
   * powered-off VM stores it in its own settings through `modifyvm`.
   */
  async natRuleAdd({ name, nic = 1, ruleName, protocol, hostIp, hostPort, guestIp, guestPort, running = false }) {
    const rule = VBox.formatNatRule({ ruleName, protocol, hostIp, hostPort, guestIp, guestPort });
    const flag = `natpf${nic}`;
    return running
      ? this.control(name, flag, [rule])
      : this.text(['modifyvm', name, `--${flag}`, rule]);
  }

  async natRuleDelete({ name, nic = 1, ruleName, running = false }) {
    if (!ruleName) throw new VBoxError('delete_nat_rule needs a rule name.');
    const flag = `natpf${nic}`;
    return running
      ? this.control(name, flag, ['delete', ruleName])
      : this.text(['modifyvm', name, `--${flag}`, 'delete', ruleName]);
  }

  // ------------------------------------------------------------------ storage

  /** `list hdds` — every registered disk medium with its real usage on disk. */
  async listHdds() {
    const out = await this.text(['list', 'hdds'], { allowFailure: true });
    return parseBlocks(out).map((row) => ({
      uuid: row.UUID,
      parentUuid: row['Parent UUID'],
      state: row.State,
      type: row.Type,
      location: row.Location,
      format: row['Storage format'],
      capacity: row.Capacity,
      sizeOnDisk: row['Size on disk'],
    }));
  }

  /** `showmediuminfo disk <file>` — per-medium geometry, including in-use state. */
  async mediumInfo(file) {
    const out = await this.text(['showmediuminfo', 'disk', file], { allowFailure: true });
    const blocks = parseBlocks(out);
    return blocks.length ? blocks[0] : null;
  }

  /** Reclaim zeroed blocks. Only valid while no VM holds the medium. */
  async compactMedium(file) {
    return this.text(['modifymedium', 'disk', file, '--compact'], { timeoutMs: 1800000 });
  }

  /** Detach whatever sits at the slot by attaching the `none` medium. */
  async detachMedium({ name, ctl, port, device = 0 }) {
    return this.storageAttach({ name, ctl, port, device, type: 'hdd', medium: 'none' });
  }

  // ------------------------------------------------------- export / import

  async exportAppliance({ name, output, options = [] }) {
    await fsp.mkdir(path.dirname(output), { recursive: true });
    return this.text(['export', name, '--output', output, ...options], { timeoutMs: 3600000 });
  }

  async importAppliance({ input, options = [] }) {
    return this.text(['import', input, ...options], { timeoutMs: 3600000 });
  }

  // ----------------------------------------------------------------- metrics

  async metricsList({ name } = {}) {
    const args = ['metrics', 'list'];
    if (name) args.push('--vm', name);
    return this.text(args, { allowFailure: true });
  }

  /**
   * Sample metrics. `period` is seconds between samples, `samples` the count;
   * the call blocks for period × samples, so the caller owns the timeout.
   */
  async metricsCollect({ name, period = 1, samples = 1 } = {}) {
    const args = ['metrics', 'collect', String(period), String(samples)];
    if (name) args.push(name);
    return this.text(args, { timeoutMs: Math.max(30000, period * samples * 1000 + 20000), allowFailure: true });
  }

  async metricsQuery({ name, metric = 'CPU/Load/User' } = {}) {
    const args = ['metrics', 'query', metric];
    if (name) args.push('--vm', name);
    return this.text(args, { allowFailure: true });
  }
}

/**
 * Parse VirtualBox's block output — the shape `list hostonlyifs`, `list hdds`,
 * `list natnetworks` and `showmediuminfo` use: `Key: value` lines with a blank
 * line between records.
 */
export function parseBlocks(text) {
  const records = [];
  let current = null;
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      if (current && Object.keys(current).length) records.push(current);
      current = null;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!current) current = {};
    current[key] = value;
  }
  if (current && Object.keys(current).length) records.push(current);
  return records;
}

export function defaultVmFolder() {
  return path.join(os.homedir(), 'VirtualBox VMs');
}
