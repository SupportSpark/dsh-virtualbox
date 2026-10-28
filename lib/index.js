/**
 * dsh-virtualbox — Cordis plugin entry.
 *
 * Registers `vbox_*` tools backed by VBoxManage so an agent can create, boot
 * and drive Linux VMs from a template on the local host.
 */

import os from 'node:os';
import path from 'node:path';

import { VmManager } from './vm.js';
import { createToolDefs } from './tools.js';

export const name = 'dsh-virtualbox';

/** Services used by this plugin. */
export const inject = ['tools'];

/**
 * `defineTool` compiles the parameter/output shorthand into JSON Schema and
 * builds the validators a registry-ready definition needs — it is not a plain
 * identity helper. Under DSH the module specifier is mapped by the loader (the
 * same way every third-party bundle imports it), which is the supported path.
 *
 * The identity fallback exists only so the package can be loaded and
 * self-tested outside DSH; `apply()` reports it loudly instead of letting tools
 * register with uncompiled schemas.
 */
let defineTool = (definition) => definition;
let defineToolSource = 'fallback';
try {
  const mod = await import('@deepseek-ai/dsh-tools');
  if (typeof mod.defineTool === 'function') {
    defineTool = mod.defineTool;
    defineToolSource = 'dsh-tools';
  }
} catch {
  /* outside the DSH loader; apply() warns */
}

const DEFAULTS = {
  vboxManagePath: undefined,
  homeDir: path.join(os.homedir(), 'dsh-virtualbox'),
  defaultTemplate: 'debian-12',
  defaultCpus: 2,
  mirror: 'direct',
  // 'auto' picks a nearby apt mirror per distro (see APT_MIRRORS); false keeps
  // the image's own sources.
  aptMirror: 'auto',
  startType: 'headless',
  commandTimeoutMs: 180000,
  downloadTimeoutMs: 30 * 60 * 1000,
  bootTimeoutMs: 10 * 60 * 1000,
  timezone: 'UTC',
  verbose: true,
};

/**
 * Resolve configuration into the manager's paths.
 * Every path is derived from `homeDir`, so overriding one field relocates the
 * whole working set.
 */
export function resolveConfig(input = {}) {
  const merged = { ...DEFAULTS, ...input };
  const homeDir = merged.homeDir || DEFAULTS.homeDir;
  return {
    ...merged,
    homeDir,
    vmDir: merged.vmDir || path.join(homeDir, 'vms'),
    cacheDir: merged.cacheDir || path.join(homeDir, 'cache'),
    stateDir: merged.stateDir || path.join(homeDir, 'state'),
    keyPath: merged.keyPath || path.join(homeDir, 'keys', 'id_ed25519'),
  };
}

export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config);
  const manager = new VmManager(resolved);
  manager.config.logger = ctx.logger;
  if (defineToolSource !== 'dsh-tools') {
    try {
      ctx.logger?.warn(
        'dsh-virtualbox: @deepseek-ai/dsh-tools did not resolve, so vbox_* tools are registered without compiled schemas. ' +
          'This only happens outside a DSH boot; install the bundle through the profile plugin manager.',
      );
    } catch {
      /* logging must never break mounting */
    }
  }
  const disposers = [];
  ctx.effect(() => {
    for (const definition of createToolDefs(defineTool, manager)) {
      disposers.push(ctx.tools.register(definition));
    }
    return () => {
      while (disposers.length > 0) {
        const dispose = disposers.pop();
        try {
          dispose?.();
        } catch {
          /* disposal must not throw during teardown */
        }
      }
    };
  }, 'dsh-virtualbox: vbox_* tools');
  return { manager };
}

export { VmManager, createToolDefs, resolveConfig as resolveVirtualBoxConfig };
