# dsh-virtualbox

A DSH (DeepSeek Harness) plugin that turns **a config entry into a booted, SSH-reachable Linux VM** on the local VirtualBox host.

Everything goes through `VBoxManage`. No `qemu-img`, no WSL, no Guest Additions, no npm runtime dependencies.

```
vbox_templates  →  what can I boot
vbox_create     →  build one and wait until it answers SSH
vbox_ssh        →  run commands inside it
vbox_reset      →  back to pristine
vbox_apply      →  bring up a whole environment from a config file
```

## Why

Standing up a throwaway Linux box is the slowest part of testing anything OS-specific. This plugin makes it one tool call: official cloud images (Debian, Ubuntu, Rocky, AlmaLinux, Fedora, openSUSE, Alpine — the image matrix follows [bin456789/reinstall](https://github.com/bin456789/reinstall)), an in-process image→VDI conversion, a cloud-init seed ISO built by the plugin itself, NAT with a loopback SSH forward, and a pristine snapshot before first boot.

## Requirements

| Need | Notes |
|---|---|
| VirtualBox 7.x | only `VBoxManage` is used; found via `VBOX_MSI_INSTALL_PATH`, the default install paths, or `PATH` |
| Node.js ≥ 20 | supplied by DSH |
| `ssh`, `ssh-keygen` | built into Windows 10+; Git for Windows also works |
| `tar` | for `.tar.xz` payloads (bsdtar ships with Windows 10+) |

Payloads are `raw`, `tar.xz`, uncompressed `qcow2`, or `vmdk`. **Compressed qcow2** (how Debian ships its `.qcow2`) is rejected with an actionable error rather than silently producing a broken disk — the Debian templates point at the equivalent `.tar.xz` instead.

Two host-specific constraints shaped the defaults:

- **Debian `generic`, not `genericcloud`.** The cloud build trims its initramfs to virtio drivers, so on a SATA/AHCI controller the kernel stops in initramfs with `ALERT! PARTUUID=… does not exist`. The generic build carries the full initramfs (ahci included) and boots in ~40 s.
- **`paravirtprovider: none`.** With Hyper-V enabled VirtualBox runs on NEM/WHP, where the KVM paravirt clock drifts ~8×: a guest reported 578 s of uptime after ~70 s of wall clock, which desynchronises cloud-init, TLS and apt. Disabling paravirt brings the guest clock back in line (1 s drift over 50 s).

## Install

```bash
dsh plugin add link:/absolute/path/to/dsh-virtualbox
# or
dsh plugin add github:SupportSpark/dsh-virtualbox
```

Activation is declared in `cordis.patch.yml`. You can also add it from the **Plugins** page in the Web sidebar.

> **Desktop app**: the Electron app manages the `desktop` profile exclusively and the CLI refuses to touch it (`profile "desktop" is managed exclusively by the Electron application`). Install from the **Plugins** page there, or restart the app so it reconciles. For any other profile the CLI works — `--dump-config` was used to confirm the plugin row composes into the tree.

Configuration is optional; every field has a default (see `DEFAULTS` in `lib/index.js`):

```yaml
- id: dsh-virtualbox
  name: dsh-virtualbox
  config:
    homeDir: E:\dsh-vm
    defaultTemplate: debian-12
    defaultCpus: 2
    mirror: direct            # direct | ghproxy | npmmirror-cloud
    startType: headless       # headless | gui
    bootTimeoutMs: 600000
    boxFile: E:\dsh-vm\boxes.json
```

`homeDir` holds `vms/`, `cache/`, `state/`, `keys/`.

## Tools

| Tool | Purpose |
|---|---|
| `vbox_status` | engine version, host CPUs, VM inventory, SSH ports |
| `vbox_templates` | image catalog: format, default user, firmware, minimums, cache state |
| `vbox_fetch_image` | warm the image cache without creating a VM |
| `vbox_create` | download → convert → seed ISO → NAT forward → snapshot → wait for SSH |
| `vbox_list`, `vbox_info` | inventory / one VM in detail |
| `vbox_start`, `vbox_stop`, `vbox_destroy` | power and lifecycle |
| `vbox_wait` | wait for SSH and for cloud-init |
| `vbox_ssh` | run a command in the guest, return exit code + stdout/stderr |
| `vbox_snapshot` | `list` / `take` / `restore` / `delete` |
| `vbox_reset` | restore the `clean` snapshot and boot again |
| `vbox_clone` | clone a VM (optionally from a snapshot), new MAC and port |
| `vbox_apply` | converge a boxes file: create missing, boot stopped, wait for SSH |
| `vbox_console` | console PNG + serial-log tail (for boxes that will not boot) |
| `vbox_keys` | type into the console (drives text installers) |
| `vbox_network` | port forwards, host-only adapters, NAT networks (`action` = `list_nat_rules` / `add_nat_rule` / `list_hostonlyifs` / …) |
| `vbox_storage` | disks: list media, inspect one, create, attach, detach, resize, clone, compact |
| `vbox_export` | export a VM to OVA/OVF, or import one |
| `vbox_metrics` | host and per-VM CPU/RAM counters (`list` / `sample` / `query` / `host`) |
| `vbox_help` | inventory of every `vbox_*` tool plus worked recipes |

The last five are *portmanteau* tools: one tool per domain with an `action`
discriminator. An agent that already knows VirtualBox needs the operations, not
a few dozen more names in the tool list, so related verbs share one schema. The
lifecycle tools stay discrete because they are reached for by intent
("boot this box"), not by category.

## Template workflow

Edit `examples/boxes.json` — one VM per key — then:

```
vbox_apply {}
vbox_apply { "only": ["lab-alpine"] }
vbox_apply { "dryRun": true }
```

Changing `template` / `cpus` / `memoryMB` / `diskGB` in that file is how you get a different box. `//` and `/* */` comments are allowed; string literals are scanned properly, so `https://…` is never mistaken for a comment.

## How it works

1. **Image** → `cache/<template>--<filename>`, atomic `.part` write, optional SHA-256, automatic fallback to the template's `altUrl`.
2. **Materialise** by magic bytes, never by extension: `raw` → `convertfromraw`; uncompressed `qcow2` → in-process L1/L2 table walk → raw → VDI; `tar.xz` → `tar -xf` → `disk.raw`; `vmdk` → `clonemedium`.
3. **Grow** → `modifymedium --resize`; cloud-init's `growpart` expands the filesystem inside.
4. **Seed** → `meta-data` / `user-data` packed into an ISO9660 image **with a Joliet tree** (volume label `cidata`), so cloud-init sees exactly `user-data` / `meta-data` regardless of name-mangling rules.
5. **Assemble** → `createvm` + `modifyvm` (BIOS/EFI, `ioapic`, NAT + `natpf1`, vmsvga, serial log to file) + SATA/AHCI disk and CD.
6. **Snapshot** `clean` before first boot, so `vbox_reset` is a true factory reset.
7. **Readiness** → TCP probe, then a real SSH login, then `cloud-init status`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `vbox_wait` times out | `vbox_console` for the screenshot and `vms/<name>/serial.log`; usually a firmware mismatch (try `firmware: "efi"`) or cloud-init never saw the seed |
| VM feels slow, guest clock runs away | `vbox_status` reports the `execution engine`: `NEM/WHP` means another hypervisor holds the CPU virtualization extensions. **Unticking Hyper-V in Windows Features is not enough** — VBS / memory integrity (HVCI), Credential Guard and KeyGuard all keep a hypervisor alive; the same line reports `VBS configured` / `HVCI configured` / `hvservice` |
| Does memory integrity break this plugin? | **No.** Both states were measured on this host: with HVCI on, e2e 28/28 and a 40 s create; with it off, 30/30 and 41 s — the difference is noise. The only real cost is nested virtualisation and possibly slower CPU-bound work. `paravirtprovider` already defaults to `none`, so the guest clock is correct either way |
| Want native AMD-V / VT-x | You have to take apart the whole chain — memory integrity, `KeyGuard`, plus `vsmlaunchtype` *and* `hypervisorlaunchtype` set to off — then **reboot** (a hypervisor cannot be unloaded at runtime). Note that **Windows 11 24H2/26H2 may insist on keeping a hypervisor** on VBS-capable hardware: on this machine all four switches were off across two reboots and `HypervisorPresent` stayed true. Staying on NEM is then the pragmatic choice, not a compromise in features |
| cloud-init reports `error` | `vbox_ssh` → `/var/log/cloud-init-output.log`; the wait path returns the last 40 lines itself. Note that a failure in cloud-init's `config` stage skips `runcmd` entirely |
| VM will not start at all | with Hyper-V enabled, VirtualBox runs on WHP and needs *Windows Hypervisor Platform* enabled |
| `Permission denied (publickey)` with `UNPROTECTED PRIVATE KEY FILE` | On Windows the private key inherits its parent directory's ACL (including `Authenticated Users`), and OpenSSH refuses it. The plugin runs `icacls /inheritance:r` to the current user before every login; keys copied in by hand need the same |
| `packages:` / `runcmd` is slow or seems not to run | The default apt origin (`deb.debian.org`) can be tens of kB/s on some routes, so `apt-get update` takes minutes and overruns the readiness window. The plugin points guest apt at a regional mirror by default (`aptMirror: "auto"`, measured 12.6 MB/s here); set `aptMirror: false` to keep the image's own sources |
| Disk is only ~3 GiB | `diskGB` only applies at creation time; rebuild the VM |
| Download stalls | try `mirror: "npmmirror-cloud"` or `ghproxy`, or pre-warm with `vbox_fetch_image` |

## Nested virtualization (a VM inside a VM)

**Currently unavailable.** Measured on this host with memory integrity on:

| Check | Result |
|---|---|
| `VBoxManage list hostinfo` | `Processor supports nested HW virtualization: no` |
| guest `/proc/cpuinfo` | **no `svm` / `vmx` flag** |
| guest `/dev/kvm` | absent |
| guest `modprobe kvm_amd` | `Operation not supported` |

The Windows hypervisor strips AMD-V/SVM out of CPUID, so VirtualBox never gets the extensions and cannot pass them on.

VirtualBox has the knob — `--nested-hw-virt on`, exposed here as `vbox_create { "nestedHwVirt": true }` — but it only means anything once VirtualBox actually owns the extensions, i.e. after the hypervisor lets go (see the "Want native AMD-V / VT-x" row; Windows 11 26H2 may refuse).

### On Microsoft's "run Hyper-V in a VM" doc

`Set-VMProcessor -VMName X -ExposeVirtualizationExtensions $true` is a **Hyper-V** cmdlet operating on Hyper-V VMs, and needs the Hyper-V role installed (Windows Server 2016+/Win10+; AMD hosts require Win11+, and VM configuration version ≥ 8.0 on Intel / ≥ 9.3 on AMD).

It does not transfer to VirtualBox: here `Microsoft-Hyper-V-All` is Disabled and the Hyper-V PowerShell module is absent (`Get-VMProcessor` does not exist), so the command cannot even run; and what it does is expose the extensions to a *Hyper-V* guest, which is a different path from VirtualBox's NEM.

Two ways to actually get nesting:

1. **Switch backends** — install the Hyper-V role, build the VM with Hyper-V, then apply that doc's `ExposeVirtualizationExtensions` (this keeps memory integrity on).
2. **Stay on VirtualBox** — the hypervisor must release AMD-V (disable the whole VBS chain and reboot), then `nestedHwVirt: true`.

## Disk space

Data disks are attached with `--discard on --nonrotational on`, so the guest's
TRIM commands reach the VDI: blocks the guest has freed are given back instead of
staying allocated. Without that pair a 20 GiB disk climbs towards its nominal size
even when the guest only holds a few GiB, and `modifymedium --compact` has nothing
to reclaim.

VMs created before 0.2.1 still have `discard` off. Fix one in place while it is
powered off:

```bash
VBoxManage storageattach <vm> --storagectl SATA --port 0 --device 0 \
  --type hdd --medium "<current disk file>" --discard on --nonrotational on
```

then switch the guest timer on once: `systemctl enable --now fstrim.timer`.
`vbox_storage action=compact_disk` reclaims what has already accumulated, but a
disk that still has snapshots must be merged first — and merging deletes the
snapshot, so `vbox_reset` loses that reset point.

## Known limits

- No Guest Additions: no shared folders, drag-and-drop or clipboard. Move files with `vbox_ssh` / `scp`.
- SATA/AHCI only: the `VirtIO` controller is rejected by the VirtualBox build this was verified on (`Invalid controller type 11`), so a trimmed initramfs cannot be worked around by switching the bus — swap the image instead.
- Compressed qcow2 is unsupported by design (clear error, never a corrupt disk).
- `paravirtprovider` defaults to `none` because of the clock drift above; override with `paravirt: "kvm"` if a workload needs the paravirt clock.
- ISO templates boot to a console; `vbox_console` + `vbox_keys` can drive them, but installer dialogues are not parsed.
- Single-user, low-concurrency: port allocation and state assume one plugin instance.

## Development

```bash
node scripts/selftest.mjs offline   # writers, catalog, tool registration, read-only tools (~2 s)
node scripts/selftest.mjs e2e       # real Debian VM: create → ssh → snapshot → restart → destroy
```

## License

MIT
