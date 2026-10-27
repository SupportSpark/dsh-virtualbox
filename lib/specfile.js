/**
 * Declarative box file — the "template" layer the user edits.
 *
 * A single JSON file describes a fleet of VMs:
 *
 *   {
 *     "defaults": { "template": "debian-12", "cpus": 2, "memoryMB": 2048, "diskGB": 10 },
 *     "boxes": {
 *       "lab-debian": { "packages": ["build-essential"] },
 *       "lab-ubuntu": { "template": "ubuntu-24.04", "memoryMB": 4096 }
 *     }
 *   }
 *
 * `vbox_apply` reads it, creates whatever is missing and boots whatever is
 * down, so changing one field is all it takes to get a different environment.
 * Comments are tolerated (// and /* *\/) so the file can be self-documenting;
 * strings are scanned properly, so a URL like https://... is never mistaken for
 * a comment.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** Strip // and /* *\/ comments while respecting string literals. */
export function stripJsonComments(text) {
  let out = '';
  let index = 0;
  let inString = false;
  let quote = '';
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (inString) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        index += 2;
        continue;
      }
      if (char === quote) inString = false;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      out += char;
      index += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1;
      index += 2;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/** Parse a box file from text. */
export function parseBoxFile(text, sourceName = '<inline>') {
  let parsed;
  try {
    parsed = JSON.parse(stripJsonComments(text));
  } catch (error) {
    throw new Error(`${sourceName} is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`${sourceName} must contain a JSON object`);
  }
  const defaults = parsed.defaults && typeof parsed.defaults === 'object' ? parsed.defaults : {};
  const boxes = parsed.boxes && typeof parsed.boxes === 'object' ? parsed.boxes : null;
  if (!boxes) throw new Error(`${sourceName} must have a "boxes" object`);
  const names = Object.keys(boxes);
  if (names.length === 0) throw new Error(`${sourceName} has no boxes defined`);
  const resolved = {};
  for (const name of names) {
    const box = boxes[name] || {};
    resolved[name] = { ...defaults, ...box, name };
  }
  return { defaults, boxes: resolved, source: sourceName, order: names };
}

/** Read + parse a box file. Missing files fall back to the packaged example. */
export async function loadBoxFile(filePath) {
  const absolute = path.resolve(filePath);
  const text = await fsp.readFile(absolute, 'utf8');
  return parseBoxFile(text, absolute);
}

/** The packaged example, used when no file is configured. */
export async function defaultBoxFile(relative = '../examples/boxes.json') {
  // Resolved against this module's URL (lib/), so `../` is the package root.
  const candidate = new URL(relative, import.meta.url);
  const text = await fsp.readFile(candidate, 'utf8');
  return parseBoxFile(text, decodeURIComponent(candidate.pathname.replace(/^\/([A-Za-z]:)/, '$1')));
}

export function boxFileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}
