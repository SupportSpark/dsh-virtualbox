/**
 * Per-VM state store.
 *
 * The plugin keeps a small JSON record per VM next to its disk so that a fresh
 * session (or a fresh agent) can find the SSH port, login user and key without
 * re-deriving anything from VirtualBox's own settings.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

const STATE_VERSION = 1;

export class VmStateStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
  }

  async ensure() {
    await fsp.mkdir(this.rootDir, { recursive: true });
  }

  fileFor(name) {
    const safe = name.replace(/[^A-Za-z0-9._-]+/g, '_');
    return path.join(this.rootDir, `${safe}.json`);
  }

  async read(name) {
    try {
      const raw = await fsp.readFile(this.fileFor(name), 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && parsed.version === STATE_VERSION ? parsed : null;
    } catch {
      return null;
    }
  }

  async write(name, record) {
    await this.ensure();
    const payload = { version: STATE_VERSION, name, updatedAt: new Date().toISOString(), ...record };
    const file = this.fileFor(name);
    const temp = `${file}.tmp`;
    await fsp.writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await fsp.rename(temp, file);
    return payload;
  }

  async patch(name, patch) {
    const existing = (await this.read(name)) || {};
    return this.write(name, { ...existing, ...patch });
  }

  async remove(name) {
    await fsp.rm(this.fileFor(name), { force: true });
  }

  async list() {
    await this.ensure();
    const out = [];
    for (const entry of await fsp.readdir(this.rootDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(await fsp.readFile(path.join(this.rootDir, entry.name), 'utf8'));
        if (parsed && parsed.version === STATE_VERSION) out.push(parsed);
      } catch {
        /* ignore broken records; they are recreated on next create */
      }
    }
    return out;
  }
}
