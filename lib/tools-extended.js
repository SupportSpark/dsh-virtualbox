/**
 * Extended model-facing tools: networking, storage, export/import, metrics and
 * a self-describing help entry.
 *
 * Each of these is a *portmanteau* tool — one tool per domain with an `action`
 * discriminator — because an agent that already knows VirtualBox needs the
 * operations, not seventeen more names in the tool list. The base `vbox_*`
 * lifecycle tools stay discrete: they are the ones an agent reaches for by
 * intent, not by category.
 *
 * Everything routes through the same `manager.vbox` wrapper, so no shell string
 * is ever built from model input.
 */

const MAX_OUTPUT_CHARS = 12000;

function truncate(text, limit = MAX_OUTPUT_CHARS) {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n… [truncated ${value.length - limit} chars]`;
}

const objectOutput = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [
    { type: 'text', text: value && value.summary ? value.summary : JSON.stringify(value, null, 2) },
  ],
};

/** VirtualBox prints capacities as `20480 MBytes`; keep the number usable. */
function mbFromVirtualBox(value) {
  const match = /^(\d+)\s*MBytes?/i.exec(String(value ?? '').trim());
  return match ? Number(match[1]) : null;
}

function formatMB(mb) {
  if (!mb) return '0 MiB';
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GiB` : `${mb} MiB`;
}

const NETWORK_ACTIONS = [
  'list_hostonlyifs',
  'create_hostonlyif',
  'configure_hostonlyif',
  'remove_hostonlyif',
  'list_natnetworks',
  'list_nat_rules',
  'add_nat_rule',
  'delete_nat_rule',
];

const STORAGE_ACTIONS = [
  'list_disks',
  'medium_info',
  'create_disk',
  'attach_disk',
  'detach_disk',
  'resize_disk',
  'clone_disk',
  'compact_disk',
];

const HELP_INVENTORY = [
  ['vbox_status', 'engine + inventory snapshot; call first'],
  ['vbox_templates', 'image catalogue and cache state'],
  ['vbox_fetch_image', 'download a template image without creating a VM'],
  ['vbox_create', 'create and boot one VM from a template'],
  ['vbox_apply', 'converge a boxes.json file into running VMs'],
  ['vbox_list', 'every VM with state, SSH port and ssh command'],
  ['vbox_info', 'full inventory row for one VM'],
  ['vbox_start / vbox_stop', 'boot headless/gui, ACPI shutdown or hard power off'],
  ['vbox_wait', 'block until SSH answers and cloud-init finishes'],
  ['vbox_ssh', 'run one shell command inside a running VM'],
  ['vbox_reset', 'rewind to a snapshot and boot'],
  ['vbox_snapshot', 'list / take / restore / delete snapshots'],
  ['vbox_clone', 'clone a VM, optionally from a snapshot'],
  ['vbox_console', 'PNG of the VM console plus the serial log tail'],
  ['vbox_keys', 'type keystrokes into the console'],
  ['vbox_destroy', 'unregister a VM, optionally keeping its disk'],
  ['vbox_network', 'host-only adapters, NAT networks and port forwards'],
  ['vbox_storage', 'disks: list, create, attach, detach, resize, clone, compact'],
  ['vbox_export', 'export a VM to OVA/OVF, or import one'],
  ['vbox_metrics', 'host and per-VM CPU/RAM sampling'],
  ['vbox_help', 'this inventory'],
];

const HELP_RECIPES = [
  ['Give a VM a reachable port', 'vbox_network action=add_nat_rule name=demo nic=1 ruleName=ssh protocol=tcp hostPort=2222 guestPort=22'],
  ['Add a second disk to a powered-off VM', 'vbox_storage action=create_disk file=<path>.vdi sizeMB=20480 then action=attach_disk name=demo ctl=SATA port=1 median=…'],
  ['Shrink a sparse disk on disk', 'vbox_storage action=compact_disk file=<path>.vdi (detach or power off first)'],
  ['Hand a box to someone else', 'vbox_export action=export name=demo output=<path>.ova'],
  ['Find out what is eating CPU', 'vbox_metrics action=sample name=demo period=1 samples=5'],
];

/**
 * Build the extended tool definitions bound to one manager instance.
 * @param {(ctx: any, def: any) => any} defineToolFactory
 * @param {import('./vm.js').VmManager} manager
 */
export function createExtendedToolDefs(defineToolFactory, manager) {
  const vbox = () => manager.vbox;

  return [
    defineToolFactory({
      name: 'vbox_network',
      description:
        'Networking for VirtualBox: host-only adapters (list/create/configure/remove), named NAT networks, and per-VM port-forward rules (list/add/delete). Port forwards are what make a guest service reachable from the host; adding one to a running VM applies immediately.',
      parameters: {
        action: {
          type: 'string',
          description: NETWORK_ACTIONS.join(', '),
          required: true,
        },
        name: { type: 'string', description: 'VM name, for the *_nat_rules and add/delete_nat_rule actions.' },
        iface: { type: 'string', description: 'Host-only adapter name (vboxnet0), for configure/remove_hostonlyif.' },
        ip: { type: 'string', description: 'IPv4 address for configure_hostonlyif.' },
        netmask: { type: 'string', description: 'Netmask for configure_hostonlyif.' },
        nic: { type: 'string', description: 'NIC index for a port forward, 1-based (default 1).' },
        ruleName: { type: 'string', description: 'Port-forward rule name, for add_nat_rule/delete_nat_rule.' },
        protocol: { type: 'string', description: 'tcp (default) or udp.' },
        hostIp: { type: 'string', description: 'Bind address on the host; empty means all interfaces.' },
        hostPort: { type: 'string', description: 'Port on the host.' },
        guestIp: { type: 'string', description: 'Guest address; empty means the guest DHCP address.' },
        guestPort: { type: 'string', description: 'Port inside the guest.' },
      },
      timeoutMs: 5 * 60 * 1000,
      output: objectOutput,
      async execute(args) {
        const action = String(args.action || '').trim();
        const nic = args.nic ? Number(args.nic) : 1;

        if (action === 'list_hostonlyifs') {
          const adapters = await vbox().listHostOnlyIfs();
          return {
            action,
            adapters,
            summary: adapters.length
              ? `host-only adapters (${adapters.length}):\n${adapters
                  .map((a) => `  ${a.name}  ${a.ip ?? '?'}/${a.netmask ?? '?'}  dhcp=${a.dhcp ?? 'disabled'}`)
                  .join('\n')}`
              : 'no host-only adapters registered',
          };
        }

        if (action === 'create_hostonlyif') {
          const iface = await vbox().createHostOnlyIf();
          return { action, iface, summary: `created host-only adapter ${iface ?? '(name not reported)'}` };
        }

        if (action === 'configure_hostonlyif') {
          if (!args.iface) throw new Error('configure_hostonlyif needs iface.');
          const out = await vbox().configureHostOnlyIf(args.iface, { ip: args.ip, netmask: args.netmask });
          return {
            action,
            iface: args.iface,
            output: out,
            summary: `configured ${args.iface}${args.ip ? ` ip=${args.ip}` : ''}${args.netmask ? ` netmask=${args.netmask}` : ''}`,
          };
        }

        if (action === 'remove_hostonlyif') {
          if (!args.iface) throw new Error('remove_hostonlyif needs iface.');
          const out = await vbox().removeHostOnlyIf(args.iface);
          return { action, iface: args.iface, output: out, summary: `removed host-only adapter ${args.iface}` };
        }

        if (action === 'list_natnetworks') {
          const networks = await vbox().listNatNetworks();
          return {
            action,
            networks,
            summary: networks.length
              ? `NAT networks (${networks.length}):\n${networks
                  .map((n) => `  ${n.name}  ${n.network ?? '?'} gw=${n.gateway ?? '?'} dhcp=${n.dhcp ?? '?'}`)
                  .join('\n')}`
              : 'no named NAT networks (per-NIC NAT is still available on every VM)',
          };
        }

        if (action === 'list_nat_rules') {
          if (!args.name) throw new Error('list_nat_rules needs name.');
          const rules = await vbox().natRules(args.name);
          if (rules === null) throw new Error(`VM "${args.name}" does not exist`);
          return {
            action,
            name: args.name,
            rules,
            summary: rules.length
              ? `${args.name} port forwards (${rules.length}):\n${rules
                  .map(
                    (r) =>
                      `  nic${r.nic} ${r.name} ${r.protocol} ${r.hostIp || '*'}:${r.hostPort} -> ${r.guestIp || 'guest'}:${r.guestPort}`,
                  )
                  .join('\n')}`
              : `${args.name} has no port forwards`,
          };
        }

        if (action === 'add_nat_rule') {
          if (!args.name) throw new Error('add_nat_rule needs name.');
          if (!args.hostPort || !args.guestPort) throw new Error('add_nat_rule needs hostPort and guestPort.');
          const state = await vbox().state(args.name);
          const running = state === 'running';
          const out = await vbox().natRuleAdd({
            name: args.name,
            nic,
            ruleName: args.ruleName || `rule${nic}`,
            protocol: args.protocol || 'tcp',
            hostIp: args.hostIp || '',
            hostPort: String(args.hostPort),
            guestIp: args.guestIp || '',
            guestPort: String(args.guestPort),
            running,
          });
          return {
            action,
            name: args.name,
            nic,
            appliedLive: running,
            output: out,
            summary: `added ${args.protocol || 'tcp'} forward on ${args.name}: host:${args.hostPort} -> guest:${args.guestPort}${running ? ' (applied to the running VM)' : ' (stored in the VM settings; takes effect on next start)'}`,
          };
        }

        if (action === 'delete_nat_rule') {
          if (!args.name || !args.ruleName) throw new Error('delete_nat_rule needs name and ruleName.');
          const state = await vbox().state(args.name);
          const running = state === 'running';
          const out = await vbox().natRuleDelete({ name: args.name, nic, ruleName: args.ruleName, running });
          return {
            action,
            name: args.name,
            ruleName: args.ruleName,
            appliedLive: running,
            output: out,
            summary: `deleted port forward ${args.ruleName} on ${args.name}`,
          };
        }

        throw new Error(`unknown action "${action}"; expected one of ${NETWORK_ACTIONS.join(', ')}`);
      },
    }),

    defineToolFactory({
      name: 'vbox_storage',
      description:
        'Disk media and controller wiring: list every registered medium with its real on-disk usage, inspect one, create, attach, detach, resize, clone, or compact a disk. Attaching requires the VM to have a controller; the port/device pair identifies the slot.',
      parameters: {
        action: { type: 'string', description: STORAGE_ACTIONS.join(', '), required: true },
        file: { type: 'string', description: 'Disk file path (create/info/resize/clone-dest/compact).' },
        source: { type: 'string', description: 'Source disk for clone_disk.' },
        target: { type: 'string', description: 'Destination disk for clone_disk.' },
        format: { type: 'string', description: 'VDI (default), VMDK or VHD.' },
        sizeMB: { type: 'string', description: 'Capacity in MiB for create_disk.' },
        resizeMB: { type: 'string', description: 'New capacity in MiB for resize_disk.' },
        name: { type: 'string', description: 'VM name for attach_disk/detach_disk.' },
        ctl: { type: 'string', description: 'Controller name, e.g. SATA or IDE.' },
        port: { type: 'string', description: 'Port on the controller (default 0).' },
        device: { type: 'string', description: 'Device on the port (default 0).' },
        medium: { type: 'string', description: 'Disk path to attach.' },
        mediumType: { type: 'string', description: 'normal (default) or writethrough.' },
        discard: {
          type: 'string',
          description:
            'on (default) or off — pass the guest TRIM commands through to the disk file. Off means blocks the guest has freed stay allocated on the host.',
        },
        nonrotational: {
          type: 'string',
          description: 'on (default) or off — advertise the medium as non-rotational, which is what makes the guest issue TRIM.',
        },
      },
      timeoutMs: 60 * 60 * 1000,
      output: objectOutput,
      async execute(args) {
        const action = String(args.action || '').trim();

        if (action === 'list_disks') {
          const disks = await vbox().listHdds();
          const lines = disks.map((d) => {
            const capacity = formatMB(mbFromVirtualBox(d.capacity));
            const onDisk = formatMB(mbFromVirtualBox(d.sizeOnDisk));
            const kind = d.format || d.type || '?';
            const state = d.state ? `, state=${d.state}` : '';
            const broken =
              String(d.state ?? '').toLowerCase() === 'inaccessible'
                ? '\n    inaccessible: VirtualBox cannot open this medium — run medium_info on it for the access error'
                : '';
            return `  ${d.location}\n    ${capacity} capacity, ${onDisk} on disk, ${kind}${state}${broken}`;
          });
          return {
            action,
            disks,
            summary: disks.length
              ? `disk media (${disks.length}):\n${lines.join('\n')}`
              : 'no disk media registered (create one with action=create_disk)',
          };
        }

        if (action === 'medium_info') {
          if (!args.file) throw new Error('medium_info needs file.');
          const info = await vbox().mediumInfo(args.file);
          if (!info) throw new Error(`medium "${args.file}" is not a registered disk`);
          const detail = Object.entries(info)
            .map(([key, value]) => `  ${key}: ${value}`)
            .join('\n');
          return { action, file: args.file, info, summary: `${args.file}\n${detail}` };
        }

        if (action === 'create_disk') {
          if (!args.file || !args.sizeMB) throw new Error('create_disk needs file and sizeMB.');
          const out = await vbox().createDisk({
            file: args.file,
            sizeMB: Number(args.sizeMB),
            format: args.format || 'VDI',
          });
          return {
            action,
            file: args.file,
            output: truncate(out),
            summary: `created ${formatMB(Number(args.sizeMB))} ${args.format || 'VDI'} disk at ${args.file}`,
          };
        }

        if (action === 'attach_disk') {
          if (!args.name || !args.medium) throw new Error('attach_disk needs name and medium.');
          if (!args.ctl) throw new Error('attach_disk needs ctl (the controller name, e.g. SATA).');
          const out = await vbox().storageAttach({
            name: args.name,
            ctl: args.ctl,
            port: args.port ?? 0,
            device: args.device ?? 0,
            type: 'hdd',
            medium: args.medium,
            mediumType: args.mediumType || 'normal',
            discard: String(args.discard ?? 'on').toLowerCase() !== 'off',
            nonrotational: String(args.nonrotational ?? 'on').toLowerCase() !== 'off',
          });
          return {
            action,
            name: args.name,
            output: out,
            summary: `attached ${args.medium} to ${args.name} at ${args.ctl}:${args.port ?? 0}/${args.device ?? 0} (discard=${String(args.discard ?? 'on').toLowerCase() !== 'off' ? 'on' : 'off'})`,
          };
        }

        if (action === 'detach_disk') {
          if (!args.name || !args.ctl) throw new Error('detach_disk needs name and ctl.');
          const out = await vbox().detachMedium({
            name: args.name,
            ctl: args.ctl,
            port: args.port ?? 0,
            device: args.device ?? 0,
          });
          return {
            action,
            name: args.name,
            output: out,
            summary: `detached the medium at ${args.name} ${args.ctl}:${args.port ?? 0}/${args.device ?? 0}`,
          };
        }

        if (action === 'resize_disk') {
          if (!args.file || !args.resizeMB) throw new Error('resize_disk needs file and resizeMB.');
          const out = await vbox().modifyMedium({ file: args.file, resizeMB: Number(args.resizeMB) });
          return {
            action,
            file: args.file,
            output: truncate(out),
            summary: `resized ${args.file} to ${formatMB(Number(args.resizeMB))} (grow only; the guest filesystem still has to be grown)`,
          };
        }

        if (action === 'clone_disk') {
          if (!args.source || !args.target) throw new Error('clone_disk needs source and target.');
          const out = await vbox().cloneMedium({ source: args.source, target: args.target, format: args.format || 'VDI' });
          return {
            action,
            source: args.source,
            target: args.target,
            output: truncate(out),
            summary: `cloned ${args.source} -> ${args.target}`,
          };
        }

        if (action === 'compact_disk') {
          if (!args.file) throw new Error('compact_disk needs file.');
          const out = await vbox().compactMedium(args.file);
          return {
            action,
            file: args.file,
            output: truncate(out),
            summary: `compacted ${args.file} (sparse blocks reclaimed; the medium must not be in use)`,
          };
        }

        throw new Error(`unknown action "${action}"; expected one of ${STORAGE_ACTIONS.join(', ')}`);
      },
    }),

    defineToolFactory({
      name: 'vbox_export',
      description:
        'Move a VM in or out of the host as an OVA/OVF appliance. Export writes a self-contained file another VirtualBox can import; import registers the VM it contains.',
      parameters: {
        action: { type: 'string', description: 'export or import.', required: true },
        name: { type: 'string', description: 'VM name to export.' },
        output: { type: 'string', description: 'Destination .ova/.ovf path for export.' },
        input: { type: 'string', description: 'Source .ova/.ovf path for import.' },
        options: {
          type: 'string',
          description: 'Extra VBoxManage flags, space separated (e.g. "--vsys 0 --vmname newname").',
        },
      },
      timeoutMs: 2 * 60 * 60 * 1000,
      output: objectOutput,
      async execute(args) {
        const action = String(args.action || '').trim();
        const extra = args.options ? String(args.options).match(/"[^"]*"|\S+/g) || [] : [];
        const flags = extra.map((token) => token.replace(/^"|"$/g, ''));

        if (action === 'export') {
          if (!args.name || !args.output) throw new Error('export needs name and output.');
          const out = await vbox().exportAppliance({ name: args.name, output: args.output, options: flags });
          return {
            action,
            name: args.name,
            output: args.output,
            log: truncate(out),
            summary: `exported ${args.name} to ${args.output}`,
          };
        }

        if (action === 'import') {
          if (!args.input) throw new Error('import needs input.');
          const out = await vbox().importAppliance({ input: args.input, options: flags });
          return {
            action,
            input: args.input,
            log: truncate(out),
            summary: `imported ${args.input}`,
          };
        }

        throw new Error(`unknown action "${action}"; expected export or import`);
      },
    }),

    defineToolFactory({
      name: 'vbox_metrics',
      description:
        'Sample VirtualBox performance counters. `sample` blocks for period × samples seconds and returns the raw collector output; `query` reads one named counter; `host` returns the host inventory. Use this instead of guessing why a VM is slow.',
      parameters: {
        action: { type: 'string', description: 'list (default), sample, query or host.', required: true },
        name: { type: 'string', description: 'VM name; omit for host-wide counters.' },
        metric: { type: 'string', description: 'Counter name for query, e.g. CPU/Load/User or RAM/Usage/Used.' },
        period: { type: 'string', description: 'Seconds between samples (default 1).' },
        samples: { type: 'string', description: 'Number of samples (default 1).' },
      },
      timeoutMs: 10 * 60 * 1000,
      output: objectOutput,
      async execute(args) {
        const action = String(args.action || 'list').trim();

        if (action === 'list') {
          const out = await vbox().metricsList({ name: args.name });
          const empty = !out.trim();
          const summary = empty
            ? `no metrics reported for ${args.name ? `VM "${args.name}"` : 'the host'} — ` +
              (args.name
                ? 'VirtualBox only reports per-VM counters after the VM has run with them enabled; start the VM, then use action=sample'
                : 'run action=sample first so the collector populates its tables')
            : truncate(out);
          return { action, name: args.name ?? null, output: truncate(out), summary };
        }

        if (action === 'sample') {
          const period = Number(args.period || 1);
          const samples = Number(args.samples || 1);
          const out = await vbox().metricsCollect({ name: args.name, period, samples });
          return {
            action,
            name: args.name ?? null,
            period,
            samples,
            output: truncate(out),
            summary: truncate(out) || `collected ${samples} sample(s) every ${period}s but VirtualBox reported nothing`,
          };
        }

        if (action === 'query') {
          const out = await vbox().metricsQuery({ name: args.name, metric: args.metric || 'CPU/Load/User' });
          return {
            action,
            metric: args.metric || 'CPU/Load/User',
            output: truncate(out),
            summary: truncate(out) || 'counter has no value yet — run action=sample first',
          };
        }

        if (action === 'host') {
          const info = await vbox().hostInfo();
          return {
            action,
            info,
            summary: `host:\n${Object.entries(info)
              .map(([k, v]) => `  ${k}: ${v}`)
              .join('\n')}`,
          };
        }

        throw new Error(`unknown action "${action}"; expected list, sample, query or host`);
      },
    }),

    defineToolFactory({
      name: 'vbox_help',
      description:
        'Inventory of every vbox_* tool with one-line purpose, plus worked recipes for the most common tasks. Read this instead of probing tools to discover what exists.',
      parameters: {
        topic: { type: 'string', description: 'Optional filter: a tool name fragment (network, storage, snapshot, …).' },
      },
      output: objectOutput,
      async execute(args) {
        const topic = String(args.topic || '').trim().toLowerCase();
        const inventory = topic
          ? HELP_INVENTORY.filter(([tool]) => tool.toLowerCase().includes(topic))
          : HELP_INVENTORY;
        const recipes = topic
          ? HELP_RECIPES.filter(([title, body]) => `${title} ${body}`.toLowerCase().includes(topic))
          : HELP_RECIPES;

        const lines = [
          `vbox_* tools (${inventory.length}):`,
          ...inventory.map(([tool, purpose]) => `  ${tool} — ${purpose}`),
        ];
        if (recipes.length) {
          lines.push('', 'recipes:');
          for (const [title, body] of recipes) lines.push(`  ${title}: ${body}`);
        }
        return { topic: topic || null, tools: inventory, recipes, summary: lines.join('\n') };
      },
    }),
  ];
}
