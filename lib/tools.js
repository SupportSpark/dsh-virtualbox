/**
 * Model-facing tools. Every tool maps to one VmManager operation and renders a
 * compact text summary so a long transcript stays readable.
 */

const MAX_OUTPUT_CHARS = 12000;

function truncate(text, limit = MAX_OUTPUT_CHARS) {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n… [truncated ${value.length - limit} chars]`;
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let index = 0;
  let value = bytes;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

const objectOutput = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [
    { type: 'text', text: value && value.summary ? value.summary : JSON.stringify(value, null, 2) },
  ],
};

/**
 * Build the tool definitions bound to one manager instance.
 * @param {(ctx: any, def: any) => any} defineToolFactory
 * @param {import('./vm.js').VmManager} manager
 */
export function createToolDefs(defineToolFactory, manager) {
  return [
    defineToolFactory({
      name: 'vbox_status',
      description:
        'VirtualBox engine + inventory snapshot: VBoxManage path/version, host CPU count, configured VM and cache directories, every registered VM with its state, and the SSH forwarding port of VMs created by this plugin. Call this first in a fresh session.',
      parameters: {},
      output: objectOutput,
      async execute() {
        const status = await manager.status();
        const virt = status.virtualization || {};
        const virtLine =
          virt.engine === 'nem-whp'
            ? 'execution engine: NEM/WHP — a hypervisor holds the CPU virtualization extensions (AMD-V/SVM or VT-x), so VirtualBox cannot use them directly'
            : virt.engine === 'native-vmx'
              ? 'execution engine: native virtualization extensions (no hypervisor reported)'
              : `execution engine: unknown${virt.error ? ` (${virt.error})` : ''}`;
        const lines = [
          `VBoxManage: ${status.version} (${status.executable})`,
          `host CPUs: ${status.cpuCount ?? '?'} · platform: ${status.platform}`,
          virtLine,
          virt.vbsConfigured !== undefined && virt.vbsConfigured !== null
            ? `  VBS configured: ${virt.vbsConfigured} · HVCI (memory integrity) configured: ${virt.hvciConfigured} · hvservice: ${virt.hvservice ? virt.hvservice.state : 'absent'}`
            : null,
          `vm dir: ${status.vmDir}`,
          `image cache: ${status.cacheDir}`,
          `VMs (${status.inventory.length}):`,
          ...(status.inventory.length
            ? status.inventory.map(
                (vm) =>
                  `  ${vm.running ? '●' : '○'} ${vm.name} — ${vm.running ? 'running' : 'stopped'}${vm.template ? ` · ${vm.template}` : ''}${vm.sshPort ? ` · ssh 127.0.0.1:${vm.sshPort}` : ''}`,
              )
            : ['  (none)']),
        ].filter(Boolean);
        if (status.untrackedStateRecords.length) {
          lines.push(`stale state records (VM gone): ${status.untrackedStateRecords.join(', ')}`);
        }
        return { ...status, summary: lines.join('\n') };
      },
    }),

    defineToolFactory({
      name: 'vbox_templates',
      description:
        'List the OS image catalog (Debian/Ubuntu/Rocky/Alma/Fedora/openSUSE/Alpine cloud images plus the bin456789/reinstall ISO), with the virtualisation format of each payload, the default login user, firmware, minimum RAM/disk, and whether the image is already cached locally. Pass a template id to `vbox_create`.',
      parameters: {},
      output: objectOutput,
      async execute() {
        const rows = await manager.templates();
        const lines = rows.map(
          (row) =>
            `${row.id} — ${row.distro} ${row.release} [${row.format}/${row.firmware}] user=${row.user} minRam=${row.minMemoryMB}MB minDisk=${row.minDiskGB}GB ${row.cloudInit ? 'cloud-init' : 'no-cloud-init'} ${row.cached ? `· cached ${formatBytes(row.cachedBytes)}` : ''}\n    ${row.url}`,
        );
        return {
          templates: rows,
          summary: [`${rows.length} templates:`, ...lines].join('\n'),
        };
      },
    }),

    defineToolFactory({
      name: 'vbox_fetch_image',
      description:
        'Download a template image into the local cache without creating a VM, so a later `vbox_create` does not block on the network. Reports bytes, cache path and SHA-256. Safe to re-run: a complete cache entry is reused.',
      parameters: {
        template: { type: 'string', description: 'Template id from vbox_templates.', required: true },
        mirror: {
          type: 'string',
          description: 'Mirror id: direct (default), ghproxy, npmmirror-cloud.',
        },
        url: { type: 'string', description: 'Override the template URL (e.g. a pinned release).' },
        force: { type: 'boolean', description: 'Re-download even when the cache entry is complete.' },
      },
      timeoutMs: 45 * 60 * 1000,
      output: objectOutput,
      async execute(args, exec) {
        const { TEMPLATES } = await import('./images.js');
        const template = TEMPLATES.find((tpl) => tpl.id === args.template);
        if (!template) {
          throw new Error(`unknown template "${args.template}"; see vbox_templates`);
        }
        const progress = [];
        const result = await manager.ensureImage(template, {
          mirror: args.mirror,
          url: args.url,
          forceDownload: Boolean(args.force),
          signal: exec?.signal,
          onProgress: (event) => {
            if (event.phase === 'download' && event.total) {
              const pct = Math.round((event.received / event.total) * 100);
              if (pct % 10 === 0) progress.push(`${pct}%`);
            }
          },
        });
        return {
          template: template.id,
          path: result.path,
          bytes: result.bytes,
          cached: result.cached,
          url: result.url,
          sha256: result.sha256 ?? null,
          summary: `${result.cached ? 'already cached' : 'downloaded'} ${template.id}: ${formatBytes(result.bytes)}\n  ${result.path}\n  source: ${result.url}${result.sha256 ? `\n  sha256: ${result.sha256}` : ''}`,
        };
      },
    }),

    defineToolFactory({
      name: 'vbox_create',
      description:
        'Create a Linux VM from a template and boot it: downloads/reuses the cloud image, converts it to a VDI, writes a cloud-init NoCloud seed ISO (login user + SSH key + optional packages/runcmd), configures NAT with a loopback SSH forward, takes a pristine snapshot and waits until SSH answers. Returns the ready-to-use ssh command. Everything is derived from the spec, so changing `template`/`cpus`/`memoryMB`/`diskGB` is enough to get a different box.',
      parameters: {
        name: { type: 'string', description: 'VM name. Default: <template>-<timestamp>.' },
        template: {
          type: 'string',
          description: 'Template id from vbox_templates. Default from config (debian-12).',
        },
        cpus: { type: 'number', description: 'vCPU count. Default 2.' },
        memoryMB: { type: 'number', description: 'RAM in MiB. Default max(template minimum, 2048).' },
        diskGB: { type: 'number', description: 'Target virtual disk size; the guest grows its filesystem via cloud-init.' },
        user: { type: 'string', description: 'Login user created by cloud-init. Default: template user.' },
        password: { type: 'string', description: 'Optional console password (SSH stays key-only unless sshPasswordAuth is set).' },
        hostname: { type: 'string', description: 'Guest hostname. Default: sanitised VM name.' },
        sshPort: { type: 'number', description: 'Loopback port for SSH forwarding. Default: first free port from 2222.' },
        firmware: { type: 'string', description: 'bios (default) or efi.' },
        packages: {
          type: 'array',
          items: { type: 'string' },
          description: 'Packages installed by cloud-init on first boot.',
        },
        runcmd: {
          type: 'array',
          items: { type: 'string' },
          description: 'Shell commands run once by cloud-init after boot.',
        },
        start: { type: 'boolean', description: 'Boot immediately. Default true.' },
        snapshot: { type: 'string', description: 'Name of the pristine snapshot taken before first boot. Default "clean"; empty string skips it.' },
        mirror: { type: 'string', description: 'Mirror id: direct, ghproxy, npmmirror-cloud.' },
        url: { type: 'string', description: 'Override the template image URL.' },
      },
      timeoutMs: 60 * 60 * 1000,
      output: objectOutput,
      async execute(args, exec) {
        const result = await manager.create(
          {
            ...args,
            snapshot: args.snapshot === '' ? null : args.snapshot,
          },
          { signal: exec?.signal },
        );
        const lines = [
          `${result.name} — ${result.templateLabel}`,
          `  resources: ${result.cpus} vCPU · ${result.memoryMB} MiB · ${result.diskGB ? `${result.diskGB} GiB disk` : 'no disk (ISO boot)'} · firmware ${result.firmware}`,
          `  image: ${result.image.format} · ${formatBytes(result.image.bytes)}${result.image.cached ? ' (cached)' : ''}`,
          `  login: ${result.user}@${result.hostname} (key: ${manager.config.keyPath})`,
          result.sshCommand ? `  ssh: ${result.sshCommand}` : '  ssh: unavailable (template has no cloud-init)',
          `  ready: ${result.ready?.ready ? 'yes' : result.started ? `no (${result.ready?.error ?? 'unknown'})` : 'not started'}`,
          result.ready?.cloudInit
            ? `  cloud-init: ${result.ready.cloudInit.status}${result.ready.cloudInit.detail ? ` — ${String(result.ready.cloudInit.detail).split('\n')[0]}` : ''}`
            : null,
          `  folder: ${result.vmFolder}`,
          result.serialLog ? `  serial log: ${result.serialLog}` : null,
          result.snapshot ? `  baseline snapshot: ${result.snapshot}` : null,
        ].filter(Boolean);
        return { ...result, summary: lines.join('\n') };
      },
    }),

    defineToolFactory({
      name: 'vbox_list',
      description: 'List every VM this host knows about, with live state, template, SSH port and a ready-to-paste ssh command.',
      parameters: {},
      output: objectOutput,
      async execute() {
        const rows = await manager.list();
        const lines = rows.length
          ? rows.map(
              (row) =>
                `${row.running ? '●' : '○'} ${row.name} — ${row.state}${row.template ? ` · ${row.template}` : ''}${row.sshPort ? ` · ${row.sshCommand}` : ''}`,
            )
          : ['(no VMs)'];
        return { vms: rows, summary: lines.join('\n') };
      },
    }),

    defineToolFactory({
      name: 'vbox_apply',
      description:
        'Converge a declarative box file (default: the packaged examples/boxes.json): create the VMs that are missing, boot the ones that are down, leave running ones alone, and wait for SSH. This is the "edit the config, get an environment" entry point — one call turns a template into live boxes. Idempotent: safe to re-run at any time.',
      parameters: {
        file: {
          type: 'string',
          description: 'Path to a boxes JSON file. Default: the packaged examples/boxes.json.',
        },
        only: {
          type: 'array',
          items: { type: 'string' },
          description: 'Restrict the run to these box names.',
        },
        dryRun: {
          type: 'boolean',
          description: 'Report what would happen without changing anything.',
        },
        timeoutSec: { type: 'number', description: 'Per-box SSH wait limit. Default 600.' },
      },
      timeoutMs: 120 * 60 * 1000,
      output: objectOutput,
      async execute(args, exec) {
        const result = await manager.applyBoxes({
          file: args.file || manager.config.boxFile,
          only: args.only,
          dryRun: Boolean(args.dryRun),
          timeoutMs: (args.timeoutSec ?? 600) * 1000,
          signal: exec?.signal,
        });
        const lines = result.boxes.map(
          (box) =>
            `${box.action.padEnd(8)} ${box.name}${box.template ? ` · ${box.template}` : ''}${box.sshPort ? ` · ssh 127.0.0.1:${box.sshPort}` : ''}${box.ready === false ? ' · NOT READY' : ''}${box.error ? ` · ${box.error}` : ''}`,
        );
        return {
          ...result,
          summary: [`boxes from ${result.file}`, ...lines].join('\n'),
        };
      },
    }),

    defineToolFactory({
      name: 'vbox_reset',
      description:
        'Rewind a VM to a snapshot (default "clean") and boot it again, discarding everything written since the snapshot. This is how to get a pristine box back between test rounds without paying for a rebuild.',
      parameters: {
        name: { type: 'string', description: 'VM name.', required: true },
        snapshot: { type: 'string', description: 'Snapshot to restore. Default "clean".' },
        timeoutSec: { type: 'number', description: 'SSH wait limit after boot. Default 600.' },
      },
      timeoutMs: 30 * 60 * 1000,
      output: objectOutput,
      async execute(args, exec) {
        const result = await manager.resetVm(args.name, {
          snapshot: args.snapshot || 'clean',
          timeoutMs: (args.timeoutSec ?? 600) * 1000,
        });
        return {
          ...result,
          summary: `${args.name} rewound to ${result.snapshot ?? '(no snapshot)'} and ${result.ready?.ready ? 'is reachable' : 'did not become reachable'}${result.sshCommand ? ` · ${result.sshCommand}` : ''}`,
        };
      },
    }),

    defineToolFactory({
      name: 'vbox_info',
      description: 'Detailed state for one VM: power state, resources, firmware, NAT forwardings, guest-reported IPs, template and paths.',
      parameters: {
        name: { type: 'string', description: 'VM name.', required: true },
      },
      output: objectOutput,
      async execute(args) {
        const info = await manager.info(args.name);
        const lines = [
          `${info.name} — ${info.state}`,
          `  uuid: ${info.uuid}`,
          `  resources: ${info.cpus ?? '?'} vCPU · ${info.memoryMB ?? '?'} MiB · firmware ${info.firmware ?? '?'}`,
          info.template ? `  template: ${info.template}` : null,
          info.sshPort ? `  ssh: port ${info.sshPort} as ${info.user}` : '  ssh: none',
          info.forwardings.length ? `  nat: ${info.forwardings.join(' | ')}` : null,
          info.guestIps.length ? `  guest ips: ${info.guestIps.map((entry) => `${entry.ip} (nic${entry.nic})`).join(', ')}` : '  guest ips: unknown (no Guest Additions)',
          info.vmFolder ? `  folder: ${info.vmFolder}` : null,
        ].filter(Boolean);
        return { ...info, summary: lines.join('\n') };
      },
    }),

    defineToolFactory({
      name: 'vbox_start',
      description: 'Power on a VM. Default type is headless; use gui to open a VirtualBox window.',
      parameters: {
        name: { type: 'string', description: 'VM name.', required: true },
        type: { type: 'string', description: 'headless (default) or gui.' },
      },
      timeoutMs: 5 * 60 * 1000,
      output: objectOutput,
      async execute(args) {
        const result = await manager.startVm(args.name, { type: args.type });
        return {
          ...result,
          summary: result.alreadyRunning ? `${args.name} is already running` : `${args.name} started (${args.type || 'headless'})`,
        };
      },
    }),

    defineToolFactory({
      name: 'vbox_stop',
      description:
        'Shut a VM down gracefully (ACPI). With force=true it powers off immediately, like pulling the plug — use that only when the guest is wedged, because the filesystem is left dirty.',
      parameters: {
        name: { type: 'string', description: 'VM name.', required: true },
        force: { type: 'boolean', description: 'Hard power off instead of ACPI shutdown.' },
      },
      timeoutMs: 5 * 60 * 1000,
      output: objectOutput,
      async execute(args) {
        const result = await manager.stopVm(args.name, { force: Boolean(args.force) });
        return {
          ...result,
          summary: result.stopped
            ? `${args.name} stopped (${result.forced ? 'forced' : 'ACPI'}) → ${result.state}`
            : `${args.name} was already ${result.state}`,
        };
      },
    }),

    defineToolFactory({
      name: 'vbox_destroy',
      description:
        'Unregister a VM and delete its disk, seed ISO and serial log. Set keepDisk=true to keep the VDI on disk for later re-attachment.',
      parameters: {
        name: { type: 'string', description: 'VM name.', required: true },
        keepDisk: { type: 'boolean', description: 'Keep the virtual disk and VM folder.' },
      },
      timeoutMs: 10 * 60 * 1000,
      output: objectOutput,
      async execute(args) {
        const result = await manager.destroyVm(args.name, { keepDisk: Boolean(args.keepDisk) });
        return {
          ...result,
          summary: result.existed
            ? `${args.name} destroyed${result.keptDisk ? ' (disk kept)' : ''}`
            : `${args.name} did not exist; state record cleared`,
        };
      },
    }),

    defineToolFactory({
      name: 'vbox_wait',
      description:
        'Wait until a booting VM accepts SSH (and, unless skipped, until cloud-init finishes). Use after vbox_start or after booting a fresh box, before running tests inside it.',
      parameters: {
        name: { type: 'string', description: 'VM name.', required: true },
        timeoutSec: { type: 'number', description: 'How long to wait. Default 600.' },
        skipCloudInit: { type: 'boolean', description: 'Return as soon as SSH answers.' },
      },
      timeoutMs: 30 * 60 * 1000,
      output: objectOutput,
      async execute(args, exec) {
        const result = await manager.waitReady(args.name, {
          timeoutMs: (args.timeoutSec ?? 600) * 1000,
          signal: exec?.signal,
          skipCloudInit: Boolean(args.skipCloudInit),
        });
        return {
          name: args.name,
          ...result,
          summary: `${args.name} is reachable over SSH after ${Math.round(result.waitedMs / 1000)}s${result.cloudInit ? ` · cloud-init: ${result.cloudInit.status}` : ''}`,
        };
      },
    }),

    defineToolFactory({
      name: 'vbox_ssh',
      description:
        'Run a shell command inside a running VM over SSH and return exit code, stdout and stderr. This is the main way to execute and verify things in the guest; there is no interactive session, so pass one self-contained command (and use && / ; for sequences).',
      parameters: {
        name: { type: 'string', description: 'VM name.', required: true },
        command: { type: 'string', description: 'Command to run in the guest (POSIX sh).', required: true },
        timeoutSec: { type: 'number', description: 'Command timeout in seconds. Default 120.' },
      },
      timeoutMs: 30 * 60 * 1000,
      output: objectOutput,
      async execute(args) {
        const result = await manager.exec(args.name, args.command, {
          timeoutMs: (args.timeoutSec ?? 120) * 1000,
        });
        const body = [`exit=${result.code}`, `$ ${args.command}`];
        if (result.stdout.trim()) body.push(result.stdout.trimEnd());
        if (result.stderr.trim()) body.push(`[stderr] ${result.stderr.trimEnd()}`);
        return {
          name: args.name,
          command: args.command,
          code: result.code,
          stdout: truncate(result.stdout),
          stderr: truncate(result.stderr),
          ok: result.ok,
          summary: truncate(body.join('\n')),
        };
      },
    }),

    defineToolFactory({
      name: 'vbox_snapshot',
      description:
        'Manage VM snapshots: list, take, restore or delete. The restore action rewinds both disk and memory-less state, so it discards everything written since the snapshot.',
      parameters: {
        name: { type: 'string', description: 'VM name.', required: true },
        action: { type: 'string', description: 'list (default), take, restore or delete.', required: true },
        snapshotName: { type: 'string', description: 'Snapshot name for take/restore/delete.' },
      },
      timeoutMs: 30 * 60 * 1000,
      output: objectOutput,
      async execute(args) {
        const result = await manager.snapshot(args.name, {
          action: args.action,
          snapshotName: args.snapshotName,
        });
        const list = result.snapshots
          ? result.snapshots.map((snap) => `  ${snap.name}${snap.description ? ` — ${snap.description}` : ''}`)
          : [];
        const head =
          args.action === 'list'
            ? `${args.name} snapshots (${list.length}):`
            : `${args.name}: snapshot ${args.action} ${args.snapshotName ?? ''}`.trim();
        return { ...result, summary: [head, ...list].join('\n') };
      },
    }),

    defineToolFactory({
      name: 'vbox_clone',
      description:
        'Clone a VM (optionally from a snapshot) into a new VM with a fresh MAC and SSH port. Cloning a pristine snapshot is the fast way to hand out identical test boxes.',
      parameters: {
        name: { type: 'string', description: 'Source VM name.', required: true },
        target: { type: 'string', description: 'New VM name.', required: true },
        snapshot: { type: 'string', description: 'Clone from this snapshot instead of the current state.' },
      },
      timeoutMs: 60 * 60 * 1000,
      output: objectOutput,
      async execute(args) {
        const result = await manager.clone(args.name, {
          target: args.target,
          snapshot: args.snapshot,
        });
        return {
          ...result,
          summary: `${args.target} cloned from ${args.name}${args.snapshot ? `@${args.snapshot}` : ''}${result.sshPort ? ` · ssh port ${result.sshPort}` : ''}`,
        };
      },
    }),

    defineToolFactory({
      name: 'vbox_console',
      description:
        'Capture the VM console as a PNG (works while headless) and tail the serial log. Use this when a box does not come up: it shows the bootloader/kernel messages that SSH cannot report.',
      parameters: {
        name: { type: 'string', description: 'VM name.', required: true },
      },
      timeoutMs: 2 * 60 * 1000,
      output: objectOutput,
      async execute(args) {
        const result = await manager.console(args.name);
        const lines = [`${args.name} console: ${result.screenshotPath}`];
        if (result.serialTail) lines.push('--- serial (tail) ---', result.serialTail);
        return { ...result, summary: lines.join('\n') };
      },
    }),

    defineToolFactory({
      name: 'vbox_keys',
      description:
        'Type text into the VM console as keystrokes (VBoxManage keyboardputstring). Used to drive text-mode installers such as the bin456789/reinstall ISO or Alpine setup, where no SSH is available yet.',
      parameters: {
        name: { type: 'string', description: 'VM name.', required: true },
        text: { type: 'string', description: 'Text to type. Use \\n for Enter (typed as a newline character).', required: true },
      },
      output: objectOutput,
      async execute(args) {
        const result = await manager.sendKeys(args.name, args.text);
        return {
          ...result,
          summary: `typed ${result.typed} chars into ${args.name} console`,
        };
      },
    }),
  ];
}

export { formatBytes, truncate };
