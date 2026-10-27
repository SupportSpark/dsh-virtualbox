/**
 * qcow2 → raw disk converter (no external dependencies).
 *
 * VirtualBox cannot read qcow2, and this host has no `qemu-img`. Most cloud
 * images (Debian nocloud, Ubuntu, Rocky, Alma, Fedora, Alpine, openSUSE) ship
 * as qcow2, so converting in-process keeps the plugin self-contained.
 *
 * Supported subset — deliberately explicit rather than optimistic:
 *   - qcow2 version 2 and version 3
 *   - unencrypted images without a backing file
 *   - standard (non-extended) L2 entries
 *   - allocated clusters and unallocated (hole) clusters
 *   - v3 zero clusters
 *
 * Anything outside that subset throws an `UnsupportedQcow2Error` naming the
 * exact feature, so the caller can fall back to a raw/vmdk template instead of
 * silently producing a corrupt disk.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';

const MAGIC = 0x514649fb; // "QFI\xfb"
const O_FLAG_COPIED = 1n << 0n;
const O_FLAG_COMPRESSED = 1n << 1n;
const O_FLAG_ZERO = 1n << 62n;
const OFFSET_MASK = 0x00fffffffffffe00n;

const INCOMPAT_DIRTY = 1n << 0n;
const INCOMPAT_CORRUPT = 1n << 1n;
const INCOMPAT_EXTERNAL_DATA = 1n << 2n;
const INCOMPAT_COMPRESSION_TYPE = 1n << 3n;
const INCOMPAT_EXTENDED_L2 = 1n << 4n;

export class UnsupportedQcow2Error extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsupportedQcow2Error';
    this.code = 'UNSUPPORTED_QCOW2';
  }
}

/** Read and validate the qcow2 header. */
export async function readQcow2Header(filePath) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const head = Buffer.alloc(112);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    if (bytesRead < 72) throw new Error(`qcow2 header truncated (${bytesRead} bytes)`);
    const magic = head.readUInt32BE(0);
    if (magic !== MAGIC) throw new Error('not a qcow2 image (bad magic)');
    const version = head.readUInt32BE(4);
    if (version !== 2 && version !== 3) {
      throw new UnsupportedQcow2Error(`qcow2 version ${version} is not supported`);
    }
    const header = {
      version,
      backingFileOffset: head.readBigUInt64BE(8),
      clusterBits: head.readUInt32BE(20),
      virtualSize: head.readBigUInt64BE(24),
      cryptMethod: head.readUInt32BE(32),
      l1Size: head.readUInt32BE(36),
      l1TableOffset: head.readBigUInt64BE(40),
      incompatibleFeatures: version >= 3 ? head.readBigUInt64BE(72) : 0n,
      compatibleFeatures: version >= 3 ? head.readBigUInt64BE(80) : 0n,
    };
    if (header.cryptMethod !== 0) throw new UnsupportedQcow2Error('encrypted qcow2 images are not supported');
    if (header.backingFileOffset !== 0n) {
      throw new UnsupportedQcow2Error('qcow2 images with a backing file are not supported');
    }
    if (header.clusterBits < 9 || header.clusterBits > 21) {
      throw new UnsupportedQcow2Error(`unusable cluster_bits ${header.clusterBits}`);
    }
    if (header.incompatibleFeatures & INCOMPAT_CORRUPT) {
      throw new UnsupportedQcow2Error('qcow2 image is marked corrupt');
    }
    if (header.incompatibleFeatures & INCOMPAT_DIRTY) {
      throw new UnsupportedQcow2Error('qcow2 image is marked dirty (unclean shutdown)');
    }
    if (header.incompatibleFeatures & INCOMPAT_EXTERNAL_DATA) {
      throw new UnsupportedQcow2Error('qcow2 external data files are not supported');
    }
    if (header.incompatibleFeatures & INCOMPAT_COMPRESSION_TYPE) {
      throw new UnsupportedQcow2Error('qcow2 compressed clusters are not supported');
    }
    if (header.incompatibleFeatures & INCOMPAT_EXTENDED_L2) {
      throw new UnsupportedQcow2Error('qcow2 extended L2 (subcluster) images are not supported');
    }
    header.clusterSize = 1 << header.clusterBits;
    return header;
  } finally {
    await handle.close();
  }
}

/**
 * Convert a qcow2 image to a sparse raw file.
 * @param {string} sourcePath
 * @param {string} targetPath
 * @param {{onProgress?: (done:number,total:number)=>void}} [options]
 * @returns {Promise<{virtualSize:number, copiedBytes:number, allocatedClusters:number}>}
 */
export async function qcow2ToRaw(sourcePath, targetPath, options = {}) {
  const header = await readQcow2Header(sourcePath);
  const { clusterSize, clusterBits } = header;
  const entriesPerL2 = clusterSize / 8;
  const virtualSize = Number(header.virtualSize);

  const src = await fsp.open(sourcePath, 'r');
  const out = await fsp.open(targetPath, 'w');
  let copiedBytes = 0;
  let allocatedClusters = 0;
  try {
    const totalClusters = Math.ceil(virtualSize / clusterSize);
    const l2Count = Math.ceil(totalClusters / entriesPerL2);
    // The L1 table may be shorter than l2Count for a truncated image; respect
    // the header's own l1_size rather than assuming it covers the disk.
    const l1Entries = Math.min(header.l1Size, l2Count);
    const l1 = Buffer.alloc(header.l1Size * 8);
    await src.read(l1, 0, l1.length, Number(header.l1TableOffset));

    // Pre-size the raw file. Setting EOF first keeps untouched ranges
    // unallocated on NTFS, which matters for 10+ GiB virtual disks.
    await out.truncate(virtualSize);

    const cluster = Buffer.alloc(clusterSize);
    const l2Raw = Buffer.alloc(clusterSize);

    for (let l1Index = 0; l1Index < header.l1Size; l1Index += 1) {
      const l1EntryOffset = l1.readBigUInt64BE(l1Index * 8);
      const l2TableHost = Number(l1EntryOffset & OFFSET_MASK);
      if (!l2TableHost) continue;
      const l2Entries = Math.min(
        entriesPerL2,
        Math.max(0, totalClusters - l1Index * entriesPerL2),
      );
      if (l2Entries <= 0) break;
      await src.read(l2Raw, 0, clusterSize, l2TableHost);

      for (let l2Index = 0; l2Index < l2Entries; l2Index += 1) {
        const raw = l2Raw.readBigUInt64BE(l2Index * 8);
        if (raw === 0n) continue; // hole → leave zeros
        if (raw & O_FLAG_COMPRESSED) {
          throw new UnsupportedQcow2Error(
            'this qcow2 image stores its data in compressed clusters, which this in-process converter does not decode. ' +
              'Use the same distribution\'s .tar.xz or .raw payload instead (see vbox_templates), or pass an explicit `url` ' +
              'pointing at an uncompressed image.',
          );
        }
        const virtualOffset = (l1Index * entriesPerL2 + l2Index) * clusterSize;
        const remaining = virtualSize - virtualOffset;
        const length = Math.min(clusterSize, remaining);
        if (raw & O_FLAG_ZERO) continue; // explicit zero cluster
        const hostOffset = Number(raw & OFFSET_MASK);
        if (!hostOffset) continue;
        if (!(raw & O_FLAG_COPIED)) {
          // A non-copied standard cluster has no meaningful payload without a
          // backing file, which we rejected in the header check.
          throw new UnsupportedQcow2Error('qcow2 cluster is not allocated but has no zero flag');
        }
        const { bytesRead } = await src.read(cluster, 0, length, hostOffset);
        if (bytesRead !== length) throw new Error(`short read at host offset ${hostOffset}`);
        await out.write(cluster, 0, length, virtualOffset);
        copiedBytes += length;
        allocatedClusters += 1;
      }
      if (options.onProgress) {
        options.onProgress(
          Math.min(1, (l1Index + 1) / Math.max(1, l1Entries)),
          copiedBytes,
        );
      }
    }
    if (allocatedClusters === 0) {
      throw new Error('qcow2 contains no allocated clusters');
    }
    return { virtualSize, copiedBytes, allocatedClusters };
  } finally {
    await src.close();
    await out.close();
  }
}

/** Quick structural probe used by the self-test and by `vbox_templates`. */
export async function describeQcow2(filePath) {
  const stat = await fsp.stat(filePath);
  const header = await readQcow2Header(filePath);
  return {
    version: header.version,
    clusterSize: header.clusterSize,
    virtualSize: Number(header.virtualSize),
    fileSize: stat.size,
    virtualSizeMB: Math.round(Number(header.virtualSize) / 1048576),
    compressionRatio: stat.size / Math.max(1, Number(header.virtualSize)),
  };
}

/** True when the file starts with the qcow2 magic. */
export function looksLikeQcow2(head) {
  return head.length >= 4 && head.readUInt32BE(0) === MAGIC;
}

export { fs };
