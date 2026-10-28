/**
 * VM lifecycle orchestration on top of VBoxManage.
 *
 * A "template" (lib/images.js) supplies the OS payload; a "spec" supplies the
 * sizing, networking and provisioning. Everything else — download, format
 * conversion, seed ISO, NAT forwarding, readiness probes — is derived so that
 * creating a fresh box is one call.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { VBox, VBoxError } from './vbox.js';
import {
  DEFAULT_MIRROR,
  getTemplate,
  imageCacheName,
  mirrorUrl,
  resolveAptMirror,
  resolveImageUrl,
  templateSummary,
} from './images.js';
import { downloadImage, materializeVdi, detectImageFormat } from './image-cache.js';
import { defaultBoxFile, loadBoxFile } from './specfile.js';
import { writeSeedIso } from './seed.js';
import { ensureSshKey, probeTcp, sshExec, waitForCloudInit, waitForSsh } from './ssh.js';
import { VmStateStore } from './state.js';

const SSH_BANNER_MARKER = 'dsh-ssh-ready';
const PORT_RANGE_START = 2222;
const PORT_RANGE_END = 2399;

/** RFC 1123 host label from a VM name. */
export function guestHostname(name) {
  const label = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return label || 'dsh-vm';
}

function sanitizeVmName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('VM name is required');
  if (/["\\/]/.test(trimmed)) throw new Error('VM name must not contain quotes or slashes');
  return trimmed;
}

export class VmManager {
  constructor(config) {
    this.config = config;
    this.vbox = new VBox({
      executable: config.vboxManagePath,
      timeoutMs: config.commandTimeoutMs ?? 180000,
      defaultVmFolder: config.vmDir,
    });
    this.store = new VmStateStore(config.stateDir);
    this.log = [];
  }

  note(message) {
    this.log.push(`${new Date().toISOString()} ${message}`);
    if (this.config.verbose) {
      try {
        this.config.logger?.info?.(`dsh-virtualbox: ${message}`);
      } catch {
        /* logging must never break the operation */
      }
    }
  }

  async paths() {
    const { vmDir, cacheDir, keyPath } = this.config;
    await fsp.mkdir(vmDir, { recursive: true });
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.mkdir(path.dirname(keyPath), { recursive: true });
    return { vmDir, cacheDir, keyPath };
  }

  /** Engine + inventory snapshot. */
  async status() {
    const version = await this.vbox.version();
    const [vms, running, host, virtualization] = await Promise.all([
      this.vbox.listVms(),
      this.vbox.runningVms(),
      this.vbox.hostInfo().catch(() => ({})),
      this.vbox.hostVirtualization().catch((error) => ({ engine: 'unknown', error: error.message })),
    ]);
    const records = await this.store.list();
    const byName = new Map(records.map((record) => [record.name, record]));
    const inventory = [];
    for (const vm of vms) {
      const record = byName.get(vm.name);
      inventory.push({
        name: vm.name,
        uuid: vm.uuid,
        running: running.has(vm.name),
        template: record?.template ?? null,
        sshPort: record?.sshPort ?? null,
        user: record?.user ?? null,
        createdAt: record?.createdAt ?? null,
      });
    }
    return {
      executable: this.vbox.executable,
      version,
      platform: process.platform,
      cpuCount: host['Processor count'] || host['Processor online count'] || null,
      vmDir: this.config.vmDir,
      cacheDir: this.config.cacheDir,
      virtualization,
      nestedHwVirt: host['Processor supports nested HW virtualization'] === 'yes',
      unrestrictedGuest: host['Processor supports unrestricted guest'] === 'yes',
      hwVirt: host['Processor supports HW virtualization'] === 'yes',
      inventory,
      untrackedStateRecords: records
        .filter((record) => !vms.some((vm) => vm.name === record.name))
        .map((record) => record.name),
    };
  }

  /** Catalog with cache annotations. */
  async templates() {
    const { cacheDir } = await this.paths();
    const rows = [];
    for (const template of (await import('./images.js')).TEMPLATES) {
      const url = resolveImageUrl(template);
      const cachedPath = path.join(cacheDir, imageCacheName(template, url));
      let cached = false;
      let cachedBytes = 0;
      try {
        const stat = await fsp.stat(cachedPath);
        cached = stat.size > 0;
        cachedBytes = stat.size;
      } catch {
        /* not cached */
      }
      rows.push({ ...templateSummary(template), cached, cachedBytes, mirror: DEFAULT_MIRROR });
    }
    return rows;
  }

  /** Ensure the image payload is present locally; returns its path. */
  async ensureImage(template, { mirror, url, onProgress, signal, forceDownload } = {}) {
    const { cacheDir } = await this.paths();
    const resolved = resolveImageUrl(template, { mirror, url });
    const fileName = imageCacheName(template, resolved);
    const target = path.join(cacheDir, fileName);
    if (forceDownload) await fsp.rm(target, { force: true });
    let downloadUrl = resolved;
    let result;
    try {
      result = await downloadImage({
        url: downloadUrl,
        cacheDir,
        fileName,
        onProgress,
        signal,
        timeoutMs: this.config.downloadTimeoutMs ?? 30 * 60 * 1000,
      });
    } catch (error) {
      const fallback = template.altUrl && !url ? mirrorUrl(template.altUrl, mirror) : null;
      if (!fallback) throw error;
      this.note(`primary download failed (${error.message}); retrying alternate payload ${fallback}`);
      downloadUrl = fallback;
      result = await downloadImage({
        url: downloadUrl,
        cacheDir,
        fileName: imageCacheName(template, fallback),
        onProgress,
        signal,
        timeoutMs: this.config.downloadTimeoutMs ?? 30 * 60 * 1000,
      });
    }
    return { ...result, url: downloadUrl };
  }

  /** Find a free loopback port for NAT SSH forwarding. */
  async pickSshPort(preferred) {
    const records = await this.store.list();
    const used = new Set(records.map((record) => record.sshPort).filter(Boolean));
    const candidates = [];
    if (preferred) candidates.push(preferred);
    for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port += 1) candidates.push(port);
    for (const port of candidates) {
      if (used.has(port)) continue;
      if (!(await probeTcp('127.0.0.1', port, 400))) return port;
    }
    throw new Error(`no free SSH forwarding port in ${PORT_RANGE_START}-${PORT_RANGE_END}`);
  }

  normalizeSpec(input = {}) {
    const templateId = input.template || this.config.defaultTemplate;
    const template = getTemplate(templateId);
    const name = input.name ? sanitizeVmName(input.name) : `${template.id}-${Date.now().toString(36)}`;
    const isIso = template.format === 'iso';
    const memoryMB = input.memoryMB ?? Math.max(template.minMemoryMB, 2048);
    const diskGB = isIso ? undefined : input.diskGB ?? Math.max(template.minDiskGB, 10);
    return {
      name,
      template,
      templateId,
      memoryMB,
      cpus: input.cpus ?? Math.min(4, Math.max(1, (this.config.defaultCpus ?? 2))),
      diskGB,
      firmware: input.firmware || template.firmware || 'bios',
      ostype: input.ostype || template.ostype || 'Linux26_64',
      user: input.user || template.defaultUser,
      password: input.password,
      sshPort: input.sshPort,
      sshPasswordAuth: Boolean(input.sshPasswordAuth),
      packages: input.packages || [],
      runcmd: input.runcmd || [],
      writeFiles: input.writeFiles || [],
      hostname: guestHostname(input.hostname || name),
      mirror: input.mirror || this.config.mirror || DEFAULT_MIRROR,
      url: input.url,
      nicType: input.nicType,
      paravirt: input.paravirt,
      // Exposes the virtualization extensions to the guest (VirtualBox's
      // --nested-hw-virt). Only meaningful when VirtualBox itself owns them;
      // with a Windows hypervisor present the host reports nested support = no.
      nestedHwVirt: Boolean(input.nestedHwVirt),
      aptMirror: input.aptMirror === undefined ? this.config.aptMirror : input.aptMirror,
      start: input.start !== false,
      snapshot: input.snapshot === undefined ? 'clean' : input.snapshot,
      growpart: input.growpart !== false,
      timezone: input.timezone || this.config.timezone,
      locale: input.locale,
      networkConfig: input.networkConfig,
      sharedFolder: input.sharedFolder,
      description: input.description || `dsh-virtualbox ${template.id}`,
    };
  }

  /**
   * Create (and by default boot) a VM from a template + spec.
   */
  async create(input = {}, { onProgress, signal } = {}) {
    const spec = this.normalizeSpec(input);
    await this.paths();
    const existing = await this.vbox.info(spec.name);
    if (existing) {
      throw new Error(
        `a VM named "${spec.name}" already exists (state ${existing.VMState}); pick another name or destroy it first`,
      );
    }

    const vmFolder = path.join(this.config.vmDir, spec.name);
    await fsp.mkdir(vmFolder, { recursive: true });

    // 1. payload
    this.note(`resolving image for ${spec.template.id}`);
    const image = await this.ensureImage(spec.template, {
      mirror: spec.mirror,
      url: spec.url,
      onProgress,
      signal,
    });
    const payloadFormat = spec.template.format === 'iso' ? 'iso' : await detectImageFormat(image.path);

    // 2. disk
    const diskPath = path.join(vmFolder, 'disk0.vdi');
    let disk = null;
    if (payloadFormat !== 'iso') {
      this.note(`materialising disk from ${path.basename(image.path)}`);
      disk = await materializeVdi({
        vbox: this.vbox,
        imagePath: image.path,
        workDir: path.join(vmFolder, 'work'),
        outputVdi: diskPath,
        diskGB: spec.diskGB,
        log: (message) => this.note(message),
      });
    }

    // 3. seed ISO (cloud-init) or boot media
    const key = await ensureSshKey(this.config.keyPath);
    let seedIso = null;
    let bootMedia = null;
    if (spec.template.cloudInit) {
      const seedPath = path.join(vmFolder, 'seed.iso');
      const seed = await writeSeedIso({
        outPath: seedPath,
        spec: {
          ...spec,
          instanceId: `dsh-${spec.name}`,
          aptMirror: resolveAptMirror(spec.aptMirror, spec.template.distro),
        },
        sshPublicKey: key.publicKey,
        hostname: spec.hostname,
      });
      seedIso = { path: seedPath, sha256: seed.sha256, bytes: seed.iso.length };
      this.note(`seed ISO written (${seed.iso.length} bytes)`);
    } else {
      bootMedia = image.path;
      this.note('template has no cloud-init; booting the payload as removable media');
    }

    // 4. VM definition
    const sshPort = spec.template.cloudInit ? await this.pickSshPort(spec.sshPort) : null;
    this.note(`creating VM ${spec.name}`);
    await this.vbox.createVm({ name: spec.name, ostype: spec.ostype, baseFolder: this.config.vmDir });
    const options = {
      memory: spec.memoryMB,
      cpus: spec.cpus,
      ioapic: 'on',
      rtcuseutc: 'on',
      nic1: 'nat',
      graphicscontroller: 'vmsvga',
      vram: 16,
      firmware: spec.firmware === 'efi' ? 'efi' : 'bios',
      description: spec.description,
      boot1: payloadFormat === 'iso' ? 'dvd' : 'disk',
      boot2: payloadFormat === 'iso' ? 'disk' : 'dvd',
      boot3: 'none',
      boot4: 'none',
      // With Hyper-V present VirtualBox runs on NEM/WHP, where the KVM
      // paravirt clock drifts badly: the guest reported 578 s of uptime after
      // ~70 s of wall clock, which desynchronises cloud-init, TLS and apt.
      // Disabling paravirt makes the guest fall back to a stable clocksource.
      paravirtprovider: spec.paravirt || 'none',
    };
    if (spec.nestedHwVirt) {
      // Ask for nesting explicitly; VirtualBox still refuses when the host
      // reports no nested HW virtualization support.
      options['nested-hw-virt'] = 'on';
    }
    if (spec.nicType) options.nictype1 = spec.nicType;
    if (sshPort) {
      options.natpf1 = [`ssh,tcp,127.0.0.1,${sshPort},,22`];
    }
    if (spec.sharedFolder) {
      options.sharedclipboard = 'disabled';
    }
    await this.vbox.modifyVm(spec.name, options);

    // Optional extras that vary across VirtualBox builds: failures here must
    // not abort VM creation, so they are applied best-effort. uart1 takes two
    // operands (I/O port, IRQ) and uartmode1 takes two (mode, file), which is
    // why they are passed as explicit operand lists.
    const serialLog = path.join(vmFolder, 'serial.log');
    await this.vbox
      .modifyVm(spec.name, {
        uart1: { args: ['0x3f8', '4'] },
        uartmode1: { args: ['file', serialLog] },
      })
      .catch((error) => this.note(`serial log unavailable: ${error.message}`));

    // 5. storage
    await this.vbox.storageCtl({
      name: spec.name,
      ctl: 'SATA',
      add: 'sata',
      controller: 'IntelAhci',
      portCount: 2,
      hostIocache: true,
    });
    if (disk) {
      await this.vbox.storageAttach({
        name: spec.name,
        ctl: 'SATA',
        port: 0,
        device: 0,
        type: 'hdd',
        medium: diskPath,
      });
    }
    if (seedIso || bootMedia) {
      await this.vbox.storageAttach({
        name: spec.name,
        ctl: 'SATA',
        port: 1,
        device: 0,
        type: 'dvddrive',
        medium: seedIso ? seedIso.path : bootMedia,
      });
    }

    // 6. shared folder (optional, needs Guest Additions at runtime; harmless
    //    to declare so the guest can mount it once additions are present)
    if (spec.sharedFolder) {
      await this.vbox
        .run(
          [
            'sharedfolder',
            'add',
            spec.name,
            '--name',
            spec.sharedFolder.name,
            '--hostpath',
            spec.sharedFolder.hostPath,
            ...(spec.sharedFolder.readonly ? ['--readonly'] : []),
            ...(spec.sharedFolder.automount ? ['--automount'] : []),
          ],
          { allowFailure: true },
        )
        .catch(() => {});
    }

    const record = await this.store.write(spec.name, {
      template: spec.template.id,
      templateLabel: spec.template.label,
      user: spec.user,
      hostname: spec.hostname,
      sshPort,
      firmware: spec.firmware,
      cpus: spec.cpus,
      memoryMB: spec.memoryMB,
      diskGB: spec.diskGB ?? null,
      keyPath: this.config.keyPath,
      vmFolder,
      diskPath: disk ? diskPath : null,
      seedIso: seedIso ? seedIso.path : null,
      serialLog,
      imageUrl: image.url,
      imageSha256: image.sha256 ?? null,
      createdAt: new Date().toISOString(),
      status: 'created',
    });

    // 7. clean baseline snapshot before the first boot
    if (spec.snapshot) {
      await this.vbox
        .snapshotTake(spec.name, spec.snapshot, 'pristine image, before first boot')
        .then(() => this.note(`baseline snapshot "${spec.snapshot}" taken`))
        .catch((error) => this.note(`baseline snapshot failed: ${error.message}`));
    }

    // 8. boot + readiness
    let ready = null;
    if (spec.start) {
      await this.vbox.start(spec.name, this.config.startType || 'headless');
      if (sshPort) {
        ready = await this.waitReady(spec.name, {
          timeoutMs: this.config.bootTimeoutMs ?? 600000,
          signal,
        }).catch((error) => ({ ready: false, error: error.message }));
      }
    }

    await this.store.patch(spec.name, {
      status: ready?.ready ? 'ready' : spec.start ? 'started' : 'created',
      ready,
    });

    return {
      name: spec.name,
      template: spec.template.id,
      templateLabel: spec.template.label,
      memoryMB: spec.memoryMB,
      cpus: spec.cpus,
      diskGB: spec.diskGB ?? null,
      firmware: spec.firmware,
      user: spec.user,
      hostname: spec.hostname,
      sshPort,
      sshCommand: sshPort ? `ssh -p ${sshPort} -i "${this.config.keyPath}" ${spec.user}@127.0.0.1` : null,
      vmFolder,
      diskPath: record.diskPath,
      seedIso: record.seedIso,
      serialLog,
      image: { url: image.url, bytes: image.bytes, cached: image.cached, format: payloadFormat },
      snapshot: spec.snapshot || null,
      started: spec.start,
      ready,
      log: this.log,
    };
  }

  /**
   * Converge a declarative box file to reality: create what is missing, boot
   * what is down, leave what is already running. This is the "one call, whole
   * environment" entry point — editing the file is how a template changes.
   */
  async applyBoxes({ file, only, dryRun = false, timeoutMs } = {}) {
    const spec = file ? await loadBoxFile(file) : await defaultBoxFile();
    const wanted = new Set(only && only.length ? only : spec.order);
    for (const name of wanted) {
      if (!spec.boxes[name]) {
        throw new Error(
          `box "${name}" is not defined in ${spec.source}; defined: ${spec.order.join(', ')}`,
        );
      }
    }
    const rows = [];
    for (const name of spec.order) {
      if (!wanted.has(name)) continue;
      const box = spec.boxes[name];
      const state = await this.vbox.state(name);
      if (dryRun) {
        rows.push({
          name,
          action: !state ? 'create' : state === 'running' ? 'running' : 'start',
          template: box.template ?? null,
          state: state ?? 'absent',
        });
        continue;
      }
      if (!state) {
        const created = await this.create({ ...box, name });
        rows.push({
          name,
          action: 'created',
          template: created.template,
          sshPort: created.sshPort,
          ready: Boolean(created.ready?.ready),
          sshCommand: created.sshCommand,
        });
        continue;
      }
      const record = (await this.store.read(name)) || {};
      if (state === 'running') {
        rows.push({
          name,
          action: 'running',
          template: record.template ?? box.template ?? null,
          sshPort: record.sshPort ?? null,
          ready: true,
          sshCommand: record.sshPort ? `ssh -p ${record.sshPort} ${record.user}@127.0.0.1` : null,
        });
        continue;
      }
      await this.startVm(name);
      let ready = { ready: false };
      if (record.sshPort) {
        ready = await this.waitReady(name, { timeoutMs: timeoutMs ?? this.config.bootTimeoutMs }).catch(
          (error) => ({ ready: false, error: error.message }),
        );
      }
      rows.push({
        name,
        action: 'started',
        template: record.template ?? box.template ?? null,
        sshPort: record.sshPort ?? null,
        ready: Boolean(ready.ready),
        sshCommand: record.sshPort ? `ssh -p ${record.sshPort} ${record.user}@127.0.0.1` : null,
        error: ready.error,
      });
    }
    return { file: spec.source, boxes: rows };
  }

  /** Rewind a VM to a snapshot and bring it back up. */
  async resetVm(name, { snapshot = 'clean', timeoutMs } = {}) {
    const info = await this.vbox.info(name);
    if (!info) throw new Error(`VM "${name}" does not exist`);
    if (info.VMState === 'running') await this.stopVm(name, { force: false });
    const snapshots = await this.vbox.snapshotList(name);
    const target = snapshot && snapshots.find((entry) => entry.name === snapshot);
    if (snapshot && !target) {
      throw new Error(
        `snapshot "${snapshot}" not found on "${name}"; available: ${snapshots.map((entry) => entry.name).join(', ') || '(none)'}`,
      );
    }
    if (target) await this.vbox.snapshotRestore(name, snapshot);
    await this.startVm(name);
    const record = (await this.store.read(name)) || {};
    const ready = record.sshPort
      ? await this.waitReady(name, { timeoutMs: timeoutMs ?? this.config.bootTimeoutMs }).catch((error) => ({
          ready: false,
          error: error.message,
        }))
      : { ready: false };
    return {
      name,
      snapshot: target ? snapshot : null,
      ready,
      sshPort: record.sshPort ?? null,
      sshCommand: record.sshPort ? `ssh -p ${record.sshPort} ${record.user}@127.0.0.1` : null,
    };
  }

  /**
   * Per-VM known_hosts file. Each box gets its own, because forwarded loopback
   * ports are reused: a shared file would make every new VM trigger "REMOTE
   * HOST IDENTIFICATION HAS CHANGED" and disable key auth.
   */
  knownHostsFor(name) {
    const safe = String(name).replace(/[^A-Za-z0-9._-]+/g, '_');
    const dir = path.join(this.config.cacheDir, 'known_hosts');
    // ssh writes the file but never creates the directory, so make it here.
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, safe);
  }

  /** Wait for SSH (and cloud-init) inside a running VM. */
  async waitReady(name, { timeoutMs, signal, skipCloudInit = false } = {}) {
    const record = await this.store.read(name);
    if (!record) throw new Error(`no state record for "${name}"; was it created by this plugin?`);
    if (!record.sshPort) throw new Error(`"${name}" has no SSH forwarding (ISO template?)`);
    const ssh = await waitForSsh({
      port: record.sshPort,
      user: record.user,
      privateKeyPath: record.keyPath || this.config.keyPath,
      knownHostsPath: this.knownHostsFor(name),
      timeoutMs: timeoutMs ?? this.config.bootTimeoutMs ?? 600000,
      signal,
    });
    let cloudInit = null;
    if (!skipCloudInit) {
      // The full budget, not half of it: a slow apt mirror can legitimately
      // spend minutes inside cloud-init's final stage, and cutting the wait
      // short reports "ready" while `packages`/`runcmd` have not run yet.
      cloudInit = await waitForCloudInit({
        port: record.sshPort,
        user: record.user,
        privateKeyPath: record.keyPath || this.config.keyPath,
        knownHostsPath: this.knownHostsFor(name),
        timeoutMs: timeoutMs ?? this.config.bootTimeoutMs ?? 600000,
        signal,
      });
    }
    return { ...ssh, cloudInit };
  }

  async startVm(name, { type } = {}) {
    const info = await this.vbox.info(name);
    if (!info) throw new Error(`VM "${name}" does not exist`);
    if (info.VMState === 'running') return { name, state: 'running', alreadyRunning: true };
    await this.vbox.start(name, type || this.config.startType || 'headless');
    await this.store.patch(name, { status: 'running', startedAt: new Date().toISOString() });
    return { name, state: 'running', alreadyRunning: false };
  }

  async stopVm(name, { force = false } = {}) {
    const info = await this.vbox.info(name);
    if (!info) throw new Error(`VM "${name}" does not exist`);
    if (info.VMState !== 'running') return { name, state: info.VMState, stopped: false };
    if (force) await this.vbox.powerOff(name);
    else {
      await this.vbox.acpiShutdown(name);
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        const state = await this.vbox.state(name);
        if (state !== 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      const state = await this.vbox.state(name);
      if (state === 'running') await this.vbox.powerOff(name);
    }
    await this.store.patch(name, { status: 'stopped', stoppedAt: new Date().toISOString() });
    return { name, state: await this.vbox.state(name), stopped: true, forced: force };
  }

  async destroyVm(name, { keepDisk = false } = {}) {
    const info = await this.vbox.info(name);
    if (!info) {
      await this.store.remove(name);
      return { name, existed: false };
    }
    if (info.VMState === 'running') await this.vbox.powerOff(name);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await this.vbox.unregister(name, { delete: !keepDisk });
    const record = await this.store.read(name);
    if (!keepDisk && record?.vmFolder) {
      await fsp.rm(record.vmFolder, { recursive: true, force: true }).catch(() => {});
    }
    await this.store.remove(name);
    return { name, existed: true, keptDisk: keepDisk };
  }

  async exec(name, command, { timeoutMs, input } = {}) {
    const record = await this.store.read(name);
    if (!record) throw new Error(`no state record for "${name}"`);
    if (!record.sshPort) throw new Error(`"${name}" has no SSH forwarding`);
    const result = await sshExec({
      port: record.sshPort,
      user: record.user,
      privateKeyPath: record.keyPath || this.config.keyPath,
      knownHostsPath: this.knownHostsFor(name),
      command,
      timeoutMs: timeoutMs ?? 120000,
      input,
    });
    return { name, command, ...result, ok: result.code === 0 };
  }

  async snapshot(name, { action = 'list', snapshotName, description } = {}) {
    if (action === 'list') {
      return { name, snapshots: await this.vbox.snapshotList(name) };
    }
    if (action === 'take') {
      if (!snapshotName) throw new Error('snapshotName is required for action=take');
      await this.vbox.snapshotTake(name, snapshotName, description);
      return { name, action, snapshotName, snapshots: await this.vbox.snapshotList(name) };
    }
    if (action === 'restore') {
      if (!snapshotName) throw new Error('snapshotName is required for action=restore');
      await this.vbox.snapshotRestore(name, snapshotName);
      return { name, action, snapshotName };
    }
    if (action === 'delete') {
      if (!snapshotName) throw new Error('snapshotName is required for action=delete');
      await this.vbox.snapshotDelete(name, snapshotName);
      return { name, action, snapshotName, snapshots: await this.vbox.snapshotList(name) };
    }
    throw new Error(`unknown snapshot action "${action}"`);
  }

  async clone(name, { target, snapshot, mode = 'machine', keepDisk = true } = {}) {
    if (!target) throw new Error('target name is required');
    const info = await this.vbox.info(name);
    if (!info) throw new Error(`VM "${name}" does not exist`);
    await this.vbox.cloneVm({
      name,
      target,
      snapshot,
      mode,
      baseFolder: this.config.vmDir,
    });
    const source = await this.store.read(name);
    if (source) {
      const sshPort = await this.pickSshPort();
      await this.vbox.modifyVm(target, { natpf1: [`ssh,tcp,127.0.0.1,${sshPort},,22`] });
      await this.store.write(target, {
        ...source,
        name: target,
        sshPort,
        createdAt: new Date().toISOString(),
        status: 'cloned',
        clonedFrom: name,
        keyPath: this.config.keyPath,
      });
      return { name, target, sshPort, clonedFrom: name };
    }
    return { name, target, clonedFrom: name };
  }

  /** Screenshot the VM console (works headless) plus a serial log tail. */
  async console(name, { outPath } = {}) {
    const info = await this.vbox.info(name);
    if (!info) throw new Error(`VM "${name}" does not exist`);
    if (info.VMState !== 'running') throw new Error(`VM "${name}" is ${info.VMState}; console is only available while running`);
    const target = outPath || path.join(this.config.cacheDir, 'console', `${name}.png`);
    await this.vbox.screenshot(name, target);
    const record = await this.store.read(name);
    let serialTail = null;
    if (record?.serialLog) {
      try {
        const raw = await fsp.readFile(record.serialLog, 'utf8');
        serialTail = raw.split(/\r?\n/).slice(-60).join('\n');
      } catch {
        serialTail = null;
      }
    }
    return { name, screenshotPath: target, serialLog: record?.serialLog ?? null, serialTail };
  }

  async sendKeys(name, text) {
    const info = await this.vbox.info(name);
    if (!info) throw new Error(`VM "${name}" does not exist`);
    if (info.VMState !== 'running') throw new Error(`VM "${name}" is ${info.VMState}; cannot type into it`);
    await this.vbox.keyboardPutString(name, text);
    return { name, typed: text.length };
  }

  async info(name) {
    const info = await this.vbox.info(name);
    if (!info) throw new Error(`VM "${name}" does not exist`);
    const record = await this.store.read(name);
    return {
      name,
      uuid: info.UUID,
      state: info.VMState,
      cpus: info.cpus ? Number(info.cpus) : null,
      memoryMB: info.memory ? Number(info.memory) : null,
      firmware: info.firmware || null,
      guestAdditions: info.GuestAdditionsVersion || null,
      sshPort: record?.sshPort ?? null,
      user: record?.user ?? null,
      template: record?.template ?? null,
      vmFolder: record?.vmFolder ?? null,
      nic: info.nic1 ? { type: info.nic1, mac: info.macaddress1 } : null,
      forwardings: Object.entries(info)
        .filter(([key]) => /^Forwarding\(\d+\)$/.test(key))
        .map(([, value]) => value),
      guestIps: await this.vbox.guestIps(name).catch(() => []),
    };
  }

  async list() {
    const records = await this.store.list();
    const running = await this.vbox.runningVms();
    const names = new Set([...(await this.vbox.listVms()).map((vm) => vm.name), ...records.map((r) => r.name)]);
    const rows = [];
    for (const name of names) {
      const record = records.find((r) => r.name === name);
      const state = await this.vbox.state(name);
      rows.push({
        name,
        state: state || 'missing',
        running: running.has(name),
        template: record?.template ?? null,
        sshPort: record?.sshPort ?? null,
        user: record?.user ?? null,
        sshCommand: record?.sshPort
          ? `ssh -p ${record.sshPort} ${record.user}@127.0.0.1`
          : null,
      });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  }
}

export { VBoxError, templateSummary };
