/**
 * Image / OS template catalog.
 *
 * The URLs follow the image matrix popularised by bin456789/reinstall: the
 * official cloud-image endpoints for each distribution, plus the mirror
 * rewrites that repository uses for networks where github / cloud endpoints
 * are slow. Every entry declares how the payload must be materialised, so
 * `vm.js` never has to guess:
 *
 *   qcow2   → converted to raw in-process (lib/qcow2.js) then to VDI
 *   raw     → written straight to VDI with convertfromraw
 *   tar.xz  → the archive member is a raw or qcow2 disk, extracted then handled
 *   vmdk    → attached as-is (cloned to VDI when a private copy is wanted)
 *   iso     → boot media only, no disk provisioning
 */

/** Rewrites for GitHub / general hosts used by the reinstall project. */
export const MIRRORS = {
  direct: { id: 'direct', label: 'direct (upstream)', rewrite: (url) => url },
  ghproxy: {
    id: 'ghproxy',
    label: 'ghproxy (github only)',
    rewrite: (url) =>
      url.startsWith('https://github.com/') || url.startsWith('https://raw.githubusercontent.com/')
        ? `https://ghfast.top/${url}`
        : url,
  },
  'npmmirror-cloud': {
    id: 'npmmirror-cloud',
    label: 'npmmirror cloud-images mirror',
    rewrite: (url) =>
      url.replace('https://cloud-images.ubuntu.com/', 'https://mirror.nju.edu.cn/ubuntu-cloud-images/')
        .replace('https://cloud.debian.org/', 'https://mirror.nju.edu.cn/debian-cd/'),
  },
};

export const DEFAULT_MIRROR = 'direct';

/**
 * @typedef {object} ImageTemplate
 * @property {string} id            stable template id used by tools
 * @property {string} distro
 * @property {string} release
 * @property {string} label         human label
 * @property {string} arch
 * @property {'qcow2'|'raw'|'tar.xz'|'vmdk'|'iso'} format
 * @property {string} url
 * @property {string} [member]      archive member path for tar.xz
 * @property {string} defaultUser
 * @property {string[]} [sudoers]
 * @property {'bios'|'efi'} firmware
 * @property {number} minMemoryMB
 * @property {number} minDiskGB
 * @property {string} [ostype]      VBoxManage ostype hint
 * @property {boolean} cloudInit    whether a NoCloud seed is required
 * @property {string} [notes]
 */

/** @type {ImageTemplate[]} */
export const TEMPLATES = [
  {
    id: 'debian-13',
    distro: 'debian',
    release: '13 (trixie)',
    label: 'Debian 13 trixie cloud image',
    arch: 'amd64',
    format: 'tar.xz',
    url: 'https://cloud.debian.org/images/cloud/trixie/latest/debian-13-generic-amd64.tar.xz',
    altUrl: 'https://cloud.debian.org/images/cloud/trixie/latest/debian-13-generic-amd64.raw',
    defaultUser: 'debian',
    firmware: 'bios',
    minMemoryMB: 1024,
    minDiskGB: 10,
    ostype: 'Debian_64',
    cloudInit: true,
    notes:
      'Uses the *generic* (not genericcloud) build: the genericcloud initramfs is trimmed to virtio drivers and cannot find its root disk on a SATA/AHCI controller, which stalls the boot in initramfs. The generic build ships the full initramfs (ahci included). The tar.xz member is a plain raw disk, so no qcow2 conversion is needed either.',
  },
  {
    id: 'debian-12',
    distro: 'debian',
    release: '12 (bookworm)',
    label: 'Debian 12 bookworm cloud image',
    arch: 'amd64',
    format: 'tar.xz',
    url: 'https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-generic-amd64.tar.xz',
    altUrl: 'https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-generic-amd64.raw',
    defaultUser: 'debian',
    firmware: 'bios',
    minMemoryMB: 1024,
    minDiskGB: 10,
    ostype: 'Debian_64',
    cloudInit: true,
    notes:
      'Default smoke-test target. Generic (not genericcloud) build because the cloud initramfs only carries virtio storage drivers and cannot see a SATA/AHCI root disk; the tarball member is disk.raw (3 GiB sparse), and the matching .qcow2 is compression-encoded and deliberately avoided.',
  },
  {
    id: 'debian-11',
    distro: 'debian',
    release: '11 (bullseye)',
    label: 'Debian 11 bullseye cloud image',
    arch: 'amd64',
    format: 'tar.xz',
    url: 'https://cloud.debian.org/images/cloud/bullseye/latest/debian-11-generic-amd64.tar.xz',
    altUrl: 'https://cloud.debian.org/images/cloud/bullseye/latest/debian-11-generic-amd64.raw',
    defaultUser: 'debian',
    firmware: 'bios',
    minMemoryMB: 1024,
    minDiskGB: 10,
    ostype: 'Debian_64',
    cloudInit: true,
    notes: 'Older glibc; useful when a target binary needs bullseye libraries.',
  },
  {
    id: 'ubuntu-24.04',
    distro: 'ubuntu',
    release: '24.04 LTS (noble)',
    label: 'Ubuntu 24.04 LTS cloud image',
    arch: 'amd64',
    format: 'qcow2',
    url: 'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img',
    defaultUser: 'ubuntu',
    firmware: 'bios',
    minMemoryMB: 1024,
    minDiskGB: 12,
    ostype: 'Ubuntu24_LTS_64',
    cloudInit: true,
    notes: 'The .img payload is qcow2 despite the extension; ubuntu user has passwordless sudo.',
  },
  {
    id: 'ubuntu-22.04',
    distro: 'ubuntu',
    release: '22.04 LTS (jammy)',
    label: 'Ubuntu 22.04 LTS cloud image',
    arch: 'amd64',
    format: 'qcow2',
    url: 'https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img',
    defaultUser: 'ubuntu',
    firmware: 'bios',
    minMemoryMB: 1024,
    minDiskGB: 12,
    ostype: 'Ubuntu22_LTS_64',
    cloudInit: true,
  },
  {
    id: 'rocky-9',
    distro: 'rocky',
    release: '9 (generic cloud)',
    label: 'Rocky Linux 9 generic cloud',
    arch: 'x86_64',
    format: 'qcow2',
    url: 'https://dl.rockylinux.org/pub/rocky/9/images/x86_64/Rocky-9-GenericCloud-Base.latest.x86_64.qcow2',
    defaultUser: 'rocky',
    firmware: 'bios',
    minMemoryMB: 2048,
    minDiskGB: 12,
    ostype: 'RedHat_64',
    cloudInit: true,
    notes: 'RHEL clone; selinux enforcing, firewalld active.',
  },
  {
    id: 'alma-9',
    distro: 'almalinux',
    release: '9 (generic cloud)',
    label: 'AlmaLinux 9 generic cloud',
    arch: 'x86_64',
    format: 'qcow2',
    url: 'https://repo.almalinux.org/almalinux/9/cloud/x86_64/images/AlmaLinux-9-GenericCloud-latest.x86_64.qcow2',
    defaultUser: 'almalinux',
    firmware: 'bios',
    minMemoryMB: 2048,
    minDiskGB: 12,
    ostype: 'RedHat_64',
    cloudInit: true,
  },
  {
    id: 'fedora-42',
    distro: 'fedora',
    release: '42 (cloud base)',
    label: 'Fedora 42 cloud base',
    arch: 'x86_64',
    format: 'qcow2',
    url: 'https://download.fedoraproject.org/pub/fedora/linux/releases/42/Cloud/x86_64/images/Fedora-Cloud-Base-Generic-42-1.1.x86_64.qcow2',
    defaultUser: 'fedora',
    firmware: 'bios',
    minMemoryMB: 2048,
    minDiskGB: 12,
    ostype: 'Fedora_64',
    cloudInit: true,
    notes: 'Point release in the filename: override `url` when 42-1.1 is superseded.',
  },
  {
    id: 'opensuse-leap-15.6',
    distro: 'opensuse',
    release: 'Leap 15.6',
    label: 'openSUSE Leap 15.6 cloud',
    arch: 'x86_64',
    format: 'qcow2',
    url: 'https://download.opensuse.org/distribution/leap/15.6/appliances/openSUSE-Leap-15.6-Minimal-VM.x86_64-Cloud.qcow2',
    defaultUser: 'opensuse',
    firmware: 'bios',
    minMemoryMB: 2048,
    minDiskGB: 12,
    ostype: 'OpenSUSE_64',
    cloudInit: true,
  },
  {
    id: 'alpine-3.21',
    distro: 'alpine',
    release: '3.21 (nocloud)',
    label: 'Alpine Linux 3.21 nocloud',
    arch: 'x86_64',
    format: 'qcow2',
    url: 'https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/cloud/nocloud_alpine-3.21.3-x86_64-bios-cloudinit-r0.qcow2',
    defaultUser: 'alpine',
    firmware: 'bios',
    minMemoryMB: 512,
    minDiskGB: 2,
    ostype: 'Linux26_64',
    cloudInit: true,
    notes: 'Alpine filenames carry the point release; override `url` when 3.21.3 is superseded.',
  },
  {
    id: 'alpine-virt',
    distro: 'alpine',
    release: '3.21 (virt ISO)',
    label: 'Alpine virt ISO (RAM disk, no cloud-init)',
    arch: 'x86_64',
    format: 'iso',
    url: 'https://dl-cdn.alpinelinux.org/alpine/v3.21/releases/x86_64/alpine-virt-3.21.3-x86_64.iso',
    defaultUser: 'root',
    firmware: 'bios',
    minMemoryMB: 512,
    minDiskGB: 1,
    ostype: 'Linux26_64',
    cloudInit: false,
    notes: 'Boots to a live shell in RAM (~80 MB). Instant smoke test for console automation.',
  },
  {
    id: 'reinstall-iso',
    distro: 'multi',
    release: 'reinstall (bin456789)',
    label: 'bin456789/reinstall bootable ISO',
    arch: 'x86_64',
    format: 'iso',
    url: 'https://github.com/bin456789/reinstall/releases/latest/download/reinstall.iso',
    defaultUser: 'root',
    firmware: 'bios',
    minMemoryMB: 1024,
    minDiskGB: 10,
    ostype: 'Linux26_64',
    cloudInit: false,
    notes:
      'Boots the upstream reinstaller; drive it through the console (see vbox_keys). The release asset name is verified by the template probe before use.',
  },
];

export function getTemplate(id) {
  const found = TEMPLATES.find((tpl) => tpl.id === id);
  if (!found) {
    throw new Error(
      `Unknown template "${id}". Known templates: ${TEMPLATES.map((tpl) => tpl.id).join(', ')}`,
    );
  }
  return found;
}

/** Apply a mirror rewrite to a template URL. */
export function mirrorUrl(url, mirror = DEFAULT_MIRROR) {
  const entry = MIRRORS[mirror] || MIRRORS.direct;
  return entry.rewrite(url);
}

/** Resolve the download URL for a template, honouring mirror + explicit URL. */
export function resolveImageUrl(template, { mirror, url } = {}) {
  return mirrorUrl(url || template.url, mirror);
}

/**
 * Cache file name: mirror-independent so switching mirrors reuses the same
 * cache entry, and stable across runs.
 */
export function imageCacheName(template, url) {
  const tail = url.split('/').pop() || `${template.id}.img`;
  const safe = tail.replace(/[^A-Za-z0-9._-]+/g, '_');
  return `${template.id}--${safe}`;
}

/** Compact catalog row for tool output. */
export function templateSummary(template) {
  return {
    id: template.id,
    distro: template.distro,
    release: template.release,
    arch: template.arch,
    format: template.format,
    firmware: template.firmware,
    user: template.defaultUser,
    minMemoryMB: template.minMemoryMB,
    minDiskGB: template.minDiskGB,
    cloudInit: template.cloudInit,
    url: template.url,
  };
}
