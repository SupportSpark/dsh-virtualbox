/**
 * Minimal ISO9660 + Joliet image writer.
 *
 * Purpose: build the NoCloud "seed" image that cloud-init reads from a CD-ROM.
 * cloud-init's DataSourceNoCloud mounts a filesystem labelled `cidata` (or
 * `CIDATA`) and then opens `/user-data` and `/meta-data`.
 *
 * Two directory trees are written so the seed is unambiguous everywhere:
 *
 *   • primary ISO9660 tree  — upper-case `USER-DATA;1` identifiers, which a
 *     reader may lower-case and strip (Linux `map=normal` does exactly that);
 *   • Joliet tree (UCS-2)   — exact `user-data` / `meta-data` names, which is
 *     what `genisoimage -joliet -rock` / `cloud-localds` produce and what
 *     cloud-init is tested against.
 *
 * With Joliet present, no reader has to guess at name mangling.
 *
 * Format references: ECMA-119 (volume descriptors §8.4, directory records
 * §9.1) and the Joliet specification (escape sequence `%/E`, UCS-2 names).
 */

const SECTOR = 2048;
const SYSTEM_AREA_SECTORS = 16;

/** Sector plan: the two path-table pairs and the two directory trees. */
const SECTORS = {
  pvd: SYSTEM_AREA_SECTORS, // 16
  svd: SYSTEM_AREA_SECTORS + 1, // 17
  terminator: SYSTEM_AREA_SECTORS + 2, // 18
  primaryPathL: SYSTEM_AREA_SECTORS + 3, // 19
  primaryPathM: SYSTEM_AREA_SECTORS + 4, // 20
  jolietPathL: SYSTEM_AREA_SECTORS + 5, // 21
  jolietPathM: SYSTEM_AREA_SECTORS + 6, // 22
  primaryRoot: SYSTEM_AREA_SECTORS + 7, // 23
  jolietRoot: SYSTEM_AREA_SECTORS + 8, // 24
  dataStart: SYSTEM_AREA_SECTORS + 9, // 25
};

function recordingDate(date) {
  return Buffer.from([
    (date.getUTCFullYear() - 1900) & 0xff,
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    0,
  ]);
}

function recordingDateLong(date) {
  const text =
    String(date.getUTCFullYear()).padStart(4, '0') +
    String(date.getUTCMonth() + 1).padStart(2, '0') +
    String(date.getUTCDate()).padStart(2, '0') +
    String(date.getUTCHours()).padStart(2, '0') +
    String(date.getUTCMinutes()).padStart(2, '0') +
    String(date.getUTCSeconds()).padStart(2, '0') +
    '00';
  const buf = Buffer.alloc(17, 0);
  buf.write(text, 0, 'ascii');
  return buf;
}

function writeBothEndian32(buf, offset, value) {
  buf.writeUInt32LE(value >>> 0, offset);
  buf.writeUInt32BE(value >>> 0, offset + 4);
}

function writeBothEndian16(buf, offset, value) {
  buf.writeUInt16LE(value & 0xffff, offset);
  buf.writeUInt16BE(value & 0xffff, offset + 2);
}

/** Primary tree identifier: upper-case with the `;1` version suffix. */
function primaryIdentifier(name) {
  return Buffer.from(`${String(name).toUpperCase()};1`, 'ascii');
}

/** Joliet identifier: UCS-2 big-endian, no version suffix. */
function jolietIdentifier(name) {
  const text = String(name);
  const buf = Buffer.alloc(text.length * 2);
  for (let index = 0; index < text.length; index += 1) {
    buf.writeUInt16BE(text.charCodeAt(index), index * 2);
  }
  return buf;
}

/**
 * Pad a Joliet string to a fixed byte width using UCS-2 spaces (0x0020).
 * Padding with single-byte 0x20 would decode as U+2020 in UCS-2, which is why
 * a mis-padded volume label reads back as `CIDATA††††`.
 */
function jolietField(text, bytes = 32) {
  const chars = Math.floor(bytes / 2);
  const buf = Buffer.alloc(bytes, 0);
  const source = String(text);
  for (let index = 0; index < chars; index += 1) {
    buf.writeUInt16BE(index < source.length ? source.charCodeAt(index) : 0x20, index * 2);
  }
  return buf;
}

function directoryRecord(entry) {
  const nameLen = entry.name.length;
  const length = 33 + nameLen + (nameLen % 2 === 0 ? 1 : 0);
  const buf = Buffer.alloc(length, 0);
  buf[0] = length;
  buf[1] = 0;
  writeBothEndian32(buf, 2, entry.extent);
  writeBothEndian32(buf, 10, entry.size);
  recordingDate(entry.date).copy(buf, 18);
  buf[25] = entry.flags;
  buf[26] = 0;
  buf[27] = 0;
  writeBothEndian16(buf, 28, 1);
  buf[32] = nameLen;
  entry.name.copy(buf, 33);
  return buf;
}

function buildVolumeDescriptor({ type, labelField, totalSectors, pathTableSectorL, pathTableSectorM, rootRecord, date, joliet }) {
  const desk = Buffer.alloc(SECTOR, 0);
  desk[0] = type;
  desk.write('CD001', 1, 'ascii');
  desk[6] = 1;
  desk.fill(0x20, 8, 40); // system identifier
  labelField.copy(desk, 40, 0, 32); // volume identifier (already padded)
  writeBothEndian32(desk, 80, totalSectors);
  if (joliet) {
    // Escape sequence "%/E": UCS-2 level 3 (Joliet).
    desk[88] = 0x25;
    desk[89] = 0x2f;
    desk[90] = 0x45;
  }
  writeBothEndian16(desk, 120, 1); // volume set size
  writeBothEndian16(desk, 124, 1); // volume sequence number
  writeBothEndian16(desk, 128, SECTOR); // logical block size
  writeBothEndian32(desk, 132, 10); // path table size (single root entry)
  desk.writeUInt32LE(pathTableSectorL, 140);
  desk.writeUInt32LE(0, 144);
  desk.writeUInt32BE(pathTableSectorM, 148);
  desk.writeUInt32BE(0, 152);
  rootRecord.copy(desk, 156);
  desk.fill(0x20, 190, 318);
  desk.fill(0x20, 318, 446);
  desk.fill(0x20, 446, 483);
  desk.fill(0x20, 483, 520);
  desk.fill(0x20, 520, 557);
  recordingDateLong(date).copy(desk, 813);
  recordingDateLong(date).copy(desk, 830);
  desk.fill(0x30, 847, 864);
  desk.fill(0x30, 864, 881);
  desk[881] = 1; // file structure version
  return desk;
}

/**
 * Create an ISO9660 + Joliet image.
 * @param {{volumeLabel?: string, files: Array<{name: string, data: Buffer|string}>, date?: Date, joliet?: boolean}} options
 * @returns {Buffer}
 */
export function buildIso9660({ volumeLabel = 'cidata', files, date = new Date(), joliet = true }) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('buildIso9660: at least one file is required');
  }
  const label = String(volumeLabel).toUpperCase().slice(0, 32);
  const entries = files.map((file) => ({
    primaryName: primaryIdentifier(file.name),
    jolietName: jolietIdentifier(file.name),
    data: Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8'),
  }));

  const seen = new Set();
  for (const entry of entries) {
    const key = entry.primaryName.toString('ascii');
    if (seen.has(key)) throw new Error(`buildIso9660: duplicate file name ${key}`);
    seen.add(key);
  }

  let cursor = SECTORS.dataStart;
  for (const entry of entries) {
    entry.sectors = Math.max(1, Math.ceil(entry.data.length / SECTOR));
    entry.extent = cursor;
    cursor += entry.sectors;
  }
  const totalSectors = cursor;
  const image = Buffer.alloc(totalSectors * SECTOR, 0);

  const rootRecordPrimary = directoryRecord({
    extent: SECTORS.primaryRoot,
    size: SECTOR,
    name: Buffer.from([0x00]),
    flags: 0x02,
    date,
  });
  const rootRecordJoliet = directoryRecord({
    extent: SECTORS.jolietRoot,
    size: SECTOR,
    name: Buffer.from([0x00]),
    flags: 0x02,
    date,
  });

  // --- Volume descriptors -------------------------------------------------
  const primaryLabelField = Buffer.alloc(32, 0x20);
  primaryLabelField.write(label.slice(0, 32), 0, 'ascii');
  const pvd = buildVolumeDescriptor({
    type: 1,
    labelField: primaryLabelField,
    totalSectors,
    pathTableSectorL: SECTORS.primaryPathL,
    pathTableSectorM: SECTORS.primaryPathM,
    rootRecord: rootRecordPrimary,
    date,
    joliet: false,
  });
  pvd.copy(image, SECTORS.pvd * SECTOR);

  if (joliet) {
    const svd = buildVolumeDescriptor({
      type: 2,
      labelField: jolietField(label, 32),
      totalSectors,
      pathTableSectorL: SECTORS.jolietPathL,
      pathTableSectorM: SECTORS.jolietPathM,
      rootRecord: rootRecordJoliet,
      date,
      joliet: true,
    });
    svd.copy(image, SECTORS.svd * SECTOR);
  }

  const terminator = Buffer.alloc(SECTOR, 0);
  terminator[0] = 255;
  terminator.write('CD001', 1, 'ascii');
  terminator[6] = 1;
  terminator.copy(image, SECTORS.terminator * SECTOR);

  // --- Path tables --------------------------------------------------------
  const pathTable = (rootSector, bigEndian) => {
    const buf = Buffer.alloc(10, 0);
    buf[0] = 1; // length of directory identifier
    if (bigEndian) {
      buf.writeUInt32BE(rootSector, 2);
      buf.writeUInt16BE(1, 6);
    } else {
      buf.writeUInt32LE(rootSector, 2);
      buf.writeUInt16LE(1, 6);
    }
    return buf;
  };
  pathTable(SECTORS.primaryRoot, false).copy(image, SECTORS.primaryPathL * SECTOR);
  pathTable(SECTORS.primaryRoot, true).copy(image, SECTORS.primaryPathM * SECTOR);
  if (joliet) {
    pathTable(SECTORS.jolietRoot, false).copy(image, SECTORS.jolietPathL * SECTOR);
    pathTable(SECTORS.jolietRoot, true).copy(image, SECTORS.jolietPathM * SECTOR);
  }

  // --- Directory trees ----------------------------------------------------
  const writeTree = (rootSector, nameKey) => {
    const records = [
      directoryRecord({
        extent: rootSector,
        size: SECTOR,
        name: Buffer.from([0x00]),
        flags: 0x02,
        date,
      }),
      directoryRecord({
        extent: rootSector,
        size: SECTOR,
        name: Buffer.from([0x01]),
        flags: 0x02,
        date,
      }),
      ...entries.map((entry) =>
        directoryRecord({
          extent: entry.extent,
          size: entry.data.length,
          name: entry[nameKey],
          flags: 0x00,
          date,
        }),
      ),
    ];
    let offset = rootSector * SECTOR;
    for (const record of records) {
      if (offset + record.length > (rootSector + 1) * SECTOR) {
        throw new Error('buildIso9660: root directory does not fit in one sector');
      }
      record.copy(image, offset);
      offset += record.length;
    }
  };
  writeTree(SECTORS.primaryRoot, 'primaryName');
  if (joliet) writeTree(SECTORS.jolietRoot, 'jolietName');

  // --- File data ----------------------------------------------------------
  for (const entry of entries) {
    entry.data.copy(image, entry.extent * SECTOR);
  }

  return image;
}

/**
 * Decode a UCS-2 **big-endian** string (Joliet) — Node's 'ucs2' is little
 * endian, so the bytes are swapped first.
 */
function decodeUcs2Be(buffer) {
  const copy = Buffer.from(buffer);
  if (copy.length % 2 !== 0) return copy.toString('ascii');
  copy.swap16();
  return copy.toString('utf16le');
}

/**
 * Parse an image back into its files. When a Joliet descriptor is present its
 * names win, matching what a guest will actually mount.
 */
export function parseIso9660(image) {
  const readDescriptor = (sector) => {
    const base = sector * SECTOR;
    if (image.toString('ascii', base + 1, base + 6) !== 'CD001') return null;
    const type = image[base];
    const volumeIdRaw = image.subarray(base + 40, base + 72);
    return {
      type,
      escape: image.toString('ascii', base + 88, base + 91),
      totalSectors: image.readUInt32LE(base + 80),
      rootExtent: image.readUInt32LE(base + 156 + 2),
      label: (type === 2 ? decodeUcs2Be(volumeIdRaw) : volumeIdRaw.toString('ascii')).replace(/\s+$/, ''),
      volumeIdRaw,
    };
  };

  const primary = readDescriptor(SECTORS.pvd);
  if (!primary) throw new Error('parseIso9660: missing CD001 signature at sector 16');
  const joliet = readDescriptor(SECTORS.svd);

  const descriptor = joliet && joliet.type === 2 ? joliet : primary;
  const useJoliet = Boolean(joliet && joliet.type === 2);
  const label = descriptor.label;

  const files = {};
  let cursor = descriptor.rootExtent * SECTOR;
  while (image[cursor] > 0) {
    const length = image[cursor];
    const extent = image.readUInt32LE(cursor + 2);
    const size = image.readUInt32LE(cursor + 10);
    const flags = image[cursor + 25];
    const nameLen = image[cursor + 32];
    const raw = image.subarray(cursor + 33, cursor + 33 + nameLen);
    if (!(flags & 0x02)) {
      const name = useJoliet
        ? decodeUcs2Be(raw)
        : raw.toString('ascii').replace(/;\d+$/, '').toLowerCase();
      files[name] = image.subarray(extent * SECTOR, extent * SECTOR + size);
    }
    cursor += length;
  }
  return {
    label,
    totalSectors: descriptor.totalSectors,
    joliet: useJoliet,
    files,
  };
}
