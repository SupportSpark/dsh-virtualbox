#!/usr/bin/env node
/**
 * Self-test for dsh-virtualbox.
 *
 *   node scripts/selftest.mjs offline   # format writers + registration + read-only tools
 *   node scripts/selftest.mjs e2e       # full Debian VM: create → ssh → snapshot → restart → destroy
 *
 * The e2e run downloads a cloud image (~350 MiB) on first use and leaves the
 * image cache in place for later runs. Set DSH_VBOX_HOME to relocate the whole
 * working set; the default keeps test VMs off the system drive when E: exists.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildIso9660, parseIso9660 } from '../lib/iso9660.js';
import { buildUserData, buildMetaData, writeSeedIso } from '../lib/seed.js';
import { detectImageFormat } from '../lib/image-cache.js';
import { VBox, resolveVBoxManage } from '../lib/vbox.js';
import { TEMPLATES, getTemplate, mirrorUrl, resolveAptMirror } from '../lib/images.js';
import { parseBoxFile, defaultBoxFile } from '../lib/specfile.js';
import * as plugin from '../lib/index.js';

const results = [];
let failures = 0;

async function test(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, detail });
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
    return true;
  } catch (error) {
    failures += 1;
    results.push({ name, ok: false, ms: Date.now() - started, error: error.message });
    console.log(`  ✗ ${name} — ${error.message}`);
    if (process.env.DSH_VBOX_DEBUG) console.error(error);
    return false;
  }
}

function section(title) {
  console.log(`\n${title}`);
}

function testHome() {
  if (process.env.DSH_VBOX_HOME) return process.env.DSH_VBOX_HOME;
  if (fs.existsSync('E:\\VMs')) return 'E:\\VMs\\dsh-virtualbox';
  return path.join(os.tmpdir(), 'dsh-virtualbox');
}

/** Mock Cordis context good enough to observe what the plugin registers. */
function mockContext() {
  const registered = [];
  const effects = [];
  return {
    registered,
    effects,
    ctx: {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      tools: {
        register(definition) {
          registered.push(definition);
          return () => {
            const index = registered.indexOf(definition);
            if (index >= 0) registered.splice(index, 1);
          };
        },
      },
      effect(fn, label) {
        const dispose = fn();
        effects.push({ label, dispose });
        return dispose;
      },
    },
  };
}

async function offline() {
  section('ISO9660 writer');
  await test('builds a NoCloud seed image that parses back', () => {
    const iso = buildIso9660({
      volumeLabel: 'cidata',
      files: [
        { name: 'meta-data', data: 'instance-id: test\n' },
        { name: 'user-data', data: '#cloud-config\nhostname: demo\n' },
      ],
    });
    assert.equal(iso.length % 2048, 0, 'image must be sector aligned');
    const parsed = parseIso9660(iso);
    assert.equal(parsed.label, 'CIDATA');
    assert.equal(parsed.joliet, true, 'Joliet tree is required so cloud-init sees exact names');
    assert.deepEqual(Object.keys(parsed.files).sort(), ['meta-data', 'user-data']);
    assert.equal(parsed.files['user-data'].toString('utf8'), '#cloud-config\nhostname: demo\n');
    return `${iso.length} bytes, label ${parsed.label}, joliet ${parsed.joliet}`;
  });

  await test('rejects duplicate file names', () => {
    assert.throws(
      () =>
        buildIso9660({
          files: [
            { name: 'user-data', data: 'a' },
            { name: 'user-data', data: 'b' },
          ],
        }),
      /duplicate/,
    );
    return 'guarded';
  });

  section('cloud-init rendering');
  await test('user-data carries user, key, sudo and runcmd', () => {
    const userData = buildUserData({
      user: 'dev',
      sshPublicKey: 'ssh-ed25519 AAAA test@host',
      hostname: 'demo-vm',
      packages: ['curl', 'jq'],
      runcmd: ['echo hi > /tmp/marker'],
      password: 'secret',
    });
    assert.match(userData, /#cloud-config/);
    assert.match(userData, /name: dev/);
    assert.match(userData, /sudo: ALL=\(ALL\) NOPASSWD:ALL/);
    assert.match(userData, /ssh-ed25519 AAAA test@host/);
    assert.match(userData, /- curl/);
    assert.match(userData, /echo hi > \/tmp\/marker/);
    assert.match(userData, /growpart:/);
    assert.match(userData, /hostname: demo-vm/);
    return `${userData.split('\n').length} lines`;
  });

  await test('meta-data is a valid NoCloud document', () => {
    const meta = buildMetaData({ instanceId: 'dsh-demo', hostname: 'demo-vm' });
    assert.match(meta, /^instance-id: dsh-demo$/m);
    assert.match(meta, /^local-hostname: demo-vm$/m);
    return 'ok';
  });

  await test('apt mirror is injected ahead of package installation', () => {
    const debianMirror = resolveAptMirror('auto', 'debian');
    assert.ok(debianMirror?.uri, 'auto must resolve a mirror for debian');
    const userData = buildUserData({
      user: 'dev',
      sshPublicKey: 'ssh-ed25519 AAAA t',
      hostname: 'demo',
      packages: ['curl'],
      aptMirror: debianMirror,
    });
    assert.match(userData, /^apt:$/m);
    assert.match(userData, /uri: 'http:\/\/mirror\.nju\.edu\.cn\/debian'/);
    assert.match(userData, /security:/);
    const none = buildUserData({ user: 'dev', hostname: 'demo', aptMirror: resolveAptMirror(false, 'debian') });
    assert.doesNotMatch(none, /^apt:$/m, 'aptMirror=false must keep the image sources');
    return debianMirror.uri;
  });

  await test('writeSeedIso writes a labelled image', async () => {
    const home = testHome();
    const outPath = path.join(home, 'selftest', 'seed.iso');
    const seed = await writeSeedIso({
      outPath,
      spec: { name: 'demo', user: 'dev', packages: [], runcmd: [] },
      sshPublicKey: 'ssh-ed25519 AAAA demo',
      hostname: 'demo',
    });
    assert.ok(fs.existsSync(outPath));
    assert.equal(seed.sha256.length, 64);
    return `${seed.iso.length} bytes → ${outPath}`;
  });

  section('image + catalog');
  await test('qcow2 magic is recognised', async () => {
    const home = testHome();
    const sample = path.join(home, 'selftest', 'sample.qcow2');
    fs.mkdirSync(path.dirname(sample), { recursive: true });
    const head = Buffer.alloc(4096, 0);
    head.writeUInt32BE(0x514649fb, 0);
    fs.writeFileSync(sample, head);
    assert.equal(await detectImageFormat(sample), 'qcow2');
    fs.rmSync(sample, { force: true });
    return 'magic detected';
  });

  await test('every template resolves and is self-consistent', () => {
    for (const template of TEMPLATES) {
      assert.ok(template.id, 'template needs an id');
      assert.ok(template.url.startsWith('https://'), `${template.id} needs an https url`);
      assert.ok(['qcow2', 'raw', 'tar.xz', 'vmdk', 'iso'].includes(template.format), `${template.id} format`);
      assert.ok(['bios', 'efi'].includes(template.firmware), `${template.id} firmware`);
      assert.ok(template.defaultUser, `${template.id} default user`);
      assert.equal(new URL(template.url).protocol, 'https:');
    }
    assert.equal(getTemplate('debian-12').defaultUser, 'debian');
    assert.throws(() => getTemplate('nope'), /Unknown template/);
    assert.match(mirrorUrl('https://github.com/x/y', 'ghproxy'), /^https:\/\/ghfast\.top\//);
    return `${TEMPLATES.length} templates`;
  });

  section('box file (template layer)');
  await test('comments are stripped without touching string literals', () => {
    const text = `{
      // a line comment
      "boxes": {
        "x": {
          /* block
             comment */
          "url": "https://example.com/a//b",
          "template": "debian-12"
        }
      }
    }`;
    const parsed = parseBoxFile(text, 'inline');
    assert.equal(parsed.boxes.x.url, 'https://example.com/a//b');
    assert.equal(parsed.boxes.x.template, 'debian-12');
    return 'url survived';
  });

  await test('defaults are merged into every box', () => {
    const parsed = parseBoxFile(
      JSON.stringify({
        defaults: { template: 'debian-12', cpus: 2, memoryMB: 2048 },
        boxes: { a: { cpus: 4 }, b: {} },
      }),
      'inline',
    );
    assert.equal(parsed.boxes.a.cpus, 4);
    assert.equal(parsed.boxes.a.memoryMB, 2048);
    assert.equal(parsed.boxes.b.cpus, 2);
    assert.equal(parsed.boxes.a.name, 'a');
    assert.deepEqual(parsed.order, ['a', 'b']);
    return 'merged';
  });

  await test('a box file without boxes is rejected', () => {
    assert.throws(() => parseBoxFile('{"defaults":{}}', 'inline'), /boxes/);
    assert.throws(() => parseBoxFile('not json', 'inline'), /valid JSON/);
    return 'guarded';
  });

  await test('the packaged example parses', async () => {
    const parsed = await defaultBoxFile('../examples/boxes.json');
    assert.ok(parsed.order.length >= 3, 'example should define several boxes');
    for (const name of parsed.order) {
      assert.ok(parsed.boxes[name].template, `${name} needs a template`);
      getTemplate(parsed.boxes[name].template);
    }
    return `${parsed.order.length} boxes: ${parsed.order.join(', ')}`;
  });

  section('plugin wiring');
  const { ctx, registered } = mockContext();
  const config = { homeDir: path.join(testHome(), 'selftest-home'), verbose: false };
  const api = plugin.apply(ctx, config);
  await test('apply() registers the vbox_* tool set', () => {
    assert.ok(registered.length >= 12, `expected the full tool set, got ${registered.length}`);
    const names = registered.map((definition) => definition.name);
    assert.equal(new Set(names).size, names.length, 'tool names must be unique');
    for (const definition of registered) {
      assert.match(definition.name, /^vbox_/);
      assert.ok(definition.description.length > 40, `${definition.name} needs a real description`);
      assert.equal(typeof definition.execute, 'function');
      assert.ok(definition.output?.render, `${definition.name} needs a renderer`);
    }
    return `${registered.length} tools`;
  });

  await test('resolved config keeps every path under homeDir', () => {
    const resolved = plugin.resolveVirtualBoxConfig(config);
    for (const key of ['vmDir', 'cacheDir', 'stateDir', 'keyPath']) {
      assert.ok(resolved[key].startsWith(resolved.homeDir), `${key} escaped homeDir`);
    }
    return path.relative(resolved.homeDir, resolved.vmDir) || '.';
  });

  await test('vbox_status reports the real engine', async () => {
    const status = await api.manager.status();
    assert.match(status.version, /^\d+\.\d+/);
    assert.ok(status.executable.toLowerCase().includes('vboxmanage'));
    console.log(`      engine ${status.version} at ${status.executable}, ${status.inventory.length} VM(s)`);
    return `${status.inventory.length} VMs, ${status.cpuCount} host CPUs`;
  });

  await test('host virtualization state is detected', async () => {
    const status = await api.manager.status();
    const virt = status.virtualization;
    assert.ok(virt, 'status must carry a virtualization facet');
    assert.ok(['nem-whp', 'native-vmx', 'native', 'unknown'].includes(virt.engine), `engine=${virt.engine}`);
    if (virt.engine !== 'unknown') {
      assert.equal(typeof virt.hypervisorRunning, 'boolean');
    }
    console.log(
      `      engine=${virt.engine} hvservice=${virt.hvservice ? virt.hvservice.state : 'absent'} vbs=${virt.vbsConfigured} hvci=${virt.hvciConfigured}`,
    );
    return virt.engine;
  });

  await test('vbox_templates lists cache state', async () => {
    const rows = await api.manager.templates();
    assert.ok(rows.length > 5);
    assert.ok(rows.every((row) => typeof row.cached === 'boolean'));
    const cached = rows.filter((row) => row.cached);
    return `${rows.length} rows, ${cached.length} cached`;
  });

  await test('tool definitions execute through the registry shape', async () => {
    const statusTool = registered.find((definition) => definition.name === 'vbox_status');
    const value = await statusTool.execute({}, {});
    assert.ok(value.summary.includes('VBoxManage'));
    return 'summary rendered';
  });

  await test('VBoxManage resolves deterministically', () => {
    const executable = resolveVBoxManage(config.vboxManagePath);
    assert.ok(fs.existsSync(executable));
    return executable;
  });

  return api;
}

async function e2e() {
  const home = testHome();
  const { ctx, registered } = mockContext();
  const api = plugin.apply(ctx, { homeDir: home, verbose: true, bootTimeoutMs: 900000 });
  const manager = api.manager;
  const tool = (name) => {
    const found = registered.find((definition) => definition.name === name);
    if (!found) throw new Error(`tool ${name} not registered`);
    return found;
  };

  const vmName = `selftest-${Date.now().toString(36)}`;
  let created = false;
  const timings = {};

  console.log(`\n  work dir: ${home}`);
  console.log(`  target VM: ${vmName}\n`);

  await test('e2e: vbox_fetch_image warms the cache', async () => {
    const started = Date.now();
    const value = await tool('vbox_fetch_image').execute({ template: 'debian-12' }, {});
    timings.download = Date.now() - started;
    assert.ok(fs.existsSync(value.path));
    assert.ok(value.bytes > 100 * 1024 * 1024, 'expected a plausible cloud image');
    console.log(`      ${(value.bytes / 1048576).toFixed(0)} MiB ${value.cached ? '(cached)' : '(downloaded)'} in ${(timings.download / 1000).toFixed(0)}s`);
    return `${(value.bytes / 1048576).toFixed(0)} MiB`;
  });

  const createResult = await test('e2e: vbox_create boots a headless Debian box', async () => {
    const started = Date.now();
    const value = await tool('vbox_create').execute(
      {
        name: vmName,
        template: 'debian-12',
        cpus: 2,
        memoryMB: 1024,
        diskGB: 10,
        user: 'dev',
        hostname: 'dsh-selftest',
        packages: ['curl'],
        runcmd: ['echo "provisioned $(date -u +%FT%TZ)" > /var/tmp/dsh-marker'],
      },
      {},
    );
    timings.create = Date.now() - started;
    created = true;
    assert.equal(value.name, vmName);
    assert.ok(value.ready?.ready, `VM did not become SSH-ready: ${value.ready?.error}`);
    console.log(`      boot+cloud-init in ${(timings.create / 1000).toFixed(0)}s`);
    console.log(`      ${value.sshCommand}`);
    return value.sshCommand;
  });

  await test('e2e: vbox_ssh reaches the guest', async () => {
    const value = await tool('vbox_ssh').execute(
      { name: vmName, command: 'uname -srm; id -un; cat /etc/debian_version; test -f /var/tmp/dsh-marker && echo marker-ok' },
      {},
    );
    assert.equal(value.code, 0, value.stderr);
    assert.match(value.stdout, /Linux \d/);
    assert.match(value.stdout, /^dev$/m);
    assert.match(value.stdout, /marker-ok/);
    return value.stdout.split('\n')[0];
  });

  await test('e2e: vbox_ssh reports non-zero exits without failing the call', async () => {
    const value = await tool('vbox_ssh').execute({ name: vmName, command: 'exit 7' }, {});
    assert.equal(value.code, 7);
    assert.equal(value.ok, false);
    return 'exit 7 surfaced';
  });

  await test('e2e: sudo works passwordless', async () => {
    const value = await tool('vbox_ssh').execute({ name: vmName, command: 'sudo -n id -u' }, {});
    assert.equal(value.code, 0, value.stderr);
    assert.equal(value.stdout.trim(), '0');
    return 'uid 0';
  });

  await test('e2e: baseline snapshot exists', async () => {
    const value = await tool('vbox_snapshot').execute({ name: vmName, action: 'list' }, {});
    const names = value.snapshots.map((snapshot) => snapshot.name);
    assert.ok(names.includes('clean'), `expected a "clean" snapshot, got ${names.join(', ') || 'none'}`);
    return names.join(', ');
  });

  await test('e2e: guest filesystem grew to the requested disk size', async () => {
    const value = await tool('vbox_ssh').execute(
      { name: vmName, command: "df -BG --output=size / | tail -n1 | tr -dc '0-9'" },
      {},
    );
    const gigabytes = Number(value.stdout.trim());
    assert.ok(gigabytes >= 9, `expected ~10 GiB, got ${gigabytes}`);
    return `${gigabytes} GiB`;
  });

  await test('e2e: vbox_stop + vbox_start round-trips', async () => {
    await tool('vbox_stop').execute({ name: vmName }, {});
    await tool('vbox_start').execute({ name: vmName }, {});
    const value = await tool('vbox_wait').execute({ name: vmName, timeoutSec: 300 }, {});
    assert.ok(value.ready);
    const probe = await tool('vbox_ssh').execute({ name: vmName, command: 'echo back-online' }, {});
    assert.match(probe.stdout, /back-online/);
    return 'restarted and reachable';
  });

  await test('e2e: vbox_console captures a PNG', async () => {
    const value = await tool('vbox_console').execute({ name: vmName }, {});
    assert.ok(fs.existsSync(value.screenshotPath));
    const size = fs.statSync(value.screenshotPath).size;
    assert.ok(size > 1000, `screenshot looks empty (${size} bytes)`);
    return `${size} bytes → ${value.screenshotPath}`;
  });

  await test('e2e: vbox_list and vbox_info see the VM', async () => {
    const list = await tool('vbox_list').execute({}, {});
    assert.ok(list.vms.some((row) => row.name === vmName && row.running));
    const info = await tool('vbox_info').execute({ name: vmName }, {});
    assert.equal(info.state, 'running');
    assert.ok(info.sshPort);
    return info.sshPort;
  });

  await test('e2e: vbox_destroy cleans up', async () => {
    const value = await tool('vbox_destroy').execute({ name: vmName }, {});
    assert.ok(value.existed);
    assert.equal(await manager.vbox.state(vmName), null);
    created = false;
    return 'removed';
  });

  if (created) {
    console.log('\n  ! cleanup: destroying leftover VM');
    await manager.destroyVm(vmName).catch(() => {});
  }

  console.log('\n  timings:', Object.entries(timings).map(([key, ms]) => `${key}=${(ms / 1000).toFixed(0)}s`).join(' · '));
}

async function main() {
  const mode = process.argv[2] || 'offline';
  console.log(`dsh-virtualbox selftest — mode: ${mode}`);
  if (mode === 'offline') await offline();
  else if (mode === 'e2e') {
    await offline();
    section('end-to-end');
    await e2e();
  } else {
    console.error(`unknown mode "${mode}" (expected offline or e2e)`);
    process.exit(2);
  }

  const passed = results.filter((entry) => entry.ok).length;
  console.log(`\n${passed}/${results.length} checks passed${failures ? `, ${failures} failed` : ''}`);
  for (const failure of results.filter((entry) => !entry.ok)) {
    console.log(`  ✗ ${failure.name}: ${failure.error}`);
  }
  process.exit(failures ? 1 : 0);
}

await main();
