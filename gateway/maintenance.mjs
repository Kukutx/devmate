import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_MAINTENANCE = {
  backupRetentionDays: 30,
  auditRetentionDays: 30,
  maxBackupBytes: 256 * 1024 * 1024,
  maxAuditBytes: 5 * 1024 * 1024
};

export function clampMaintenanceNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function maintenanceOptions(input = {}) {
  return {
    backupRetentionDays: clampMaintenanceNumber(input.backupRetentionDays, DEFAULT_MAINTENANCE.backupRetentionDays, 1, 3650),
    auditRetentionDays: clampMaintenanceNumber(input.auditRetentionDays, DEFAULT_MAINTENANCE.auditRetentionDays, 1, 3650),
    maxBackupBytes: clampMaintenanceNumber(input.maxBackupBytes, DEFAULT_MAINTENANCE.maxBackupBytes, 1024 * 1024, 10 * 1024 * 1024 * 1024),
    maxAuditBytes: clampMaintenanceNumber(input.maxAuditBytes, DEFAULT_MAINTENANCE.maxAuditBytes, 256 * 1024, 100 * 1024 * 1024)
  };
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function statOrNull(file) {
  try { return await fsp.stat(file); } catch { return null; }
}

async function lstatOrNull(file) {
  try { return await fsp.lstat(file); } catch { return null; }
}

async function directorySizeBytes(root) {
  const st = await lstatOrNull(root);
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  let total = st.size;
  let entries = [];
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return total; }
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      const linkStat = await lstatOrNull(child);
      total += linkStat?.size || 0;
    } else if (entry.isDirectory()) {
      total += await directorySizeBytes(child);
    } else {
      const childStat = await lstatOrNull(child);
      total += childStat?.size || 0;
    }
  }
  return total;
}

async function safeRemoveChild(root, target) {
  const rootPath = path.resolve(root);
  const targetPath = path.resolve(target);
  if (targetPath === rootPath || !isInside(rootPath, targetPath)) {
    throw new Error(`Refusing to remove path outside maintenance root: ${target}`);
  }
  await fsp.rm(targetPath, { recursive: true, force: true });
}

async function listBackupSets(backupRoot) {
  let entries = [];
  try { entries = await fsp.readdir(backupRoot, { withFileTypes: true }); } catch { return []; }
  const sets = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(backupRoot, entry.name);
    const st = await statOrNull(full);
    if (!st) continue;
    sets.push({
      name: entry.name,
      path: full,
      mtimeMs: st.mtimeMs,
      sizeBytes: await directorySizeBytes(full)
    });
  }
  sets.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
  return sets;
}

async function countFiles(root) {
  let count = 0;
  async function scan(dir) {
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await scan(full);
      else count++;
    }
  }
  await scan(root);
  return count;
}

export async function stateSummary(paths) {
  const backupSets = await listBackupSets(paths.backupRoot);
  const auditStat = await statOrNull(paths.auditLog);
  let auditEntries = 0;
  try {
    const text = await fsp.readFile(paths.auditLog, 'utf8');
    auditEntries = text.split(/\r?\n/).filter(Boolean).length;
  } catch {}
  return {
    backupSets: backupSets.length,
    backupFiles: await countFiles(paths.backupRoot),
    backupBytes: backupSets.reduce((sum, item) => sum + item.sizeBytes, 0),
    auditEntries,
    auditBytes: auditStat?.size || 0
  };
}

export async function pruneBackups(backupRoot, options = {}, nowMs = Date.now()) {
  const opts = maintenanceOptions(options);
  await fsp.mkdir(backupRoot, { recursive: true });
  let sets = await listBackupSets(backupRoot);
  const beforeBytes = sets.reduce((sum, item) => sum + item.sizeBytes, 0);
  const beforeSets = sets.length;
  const cutoff = nowMs - opts.backupRetentionDays * DAY_MS;
  const deleted = [];
  for (const item of sets) {
    if (item.mtimeMs >= cutoff) continue;
    await safeRemoveChild(backupRoot, item.path);
    deleted.push({ path: item.path, reason: 'age', sizeBytes: item.sizeBytes });
  }
  sets = (await listBackupSets(backupRoot)).sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
  let total = sets.reduce((sum, item) => sum + item.sizeBytes, 0);
  for (const item of sets) {
    if (total <= opts.maxBackupBytes) break;
    await safeRemoveChild(backupRoot, item.path);
    total -= item.sizeBytes;
    deleted.push({ path: item.path, reason: 'size', sizeBytes: item.sizeBytes });
  }
  const afterSets = await listBackupSets(backupRoot);
  return {
    beforeSets,
    afterSets: afterSets.length,
    beforeBytes,
    afterBytes: afterSets.reduce((sum, item) => sum + item.sizeBytes, 0),
    deleted
  };
}

export async function pruneAuditLog(auditLog, options = {}, nowMs = Date.now()) {
  const opts = maintenanceOptions(options);
  const stat = await statOrNull(auditLog);
  if (!stat) return { beforeEntries: 0, afterEntries: 0, beforeBytes: 0, afterBytes: 0, removedEntries: 0, changed: false };
  const original = await fsp.readFile(auditLog, 'utf8');
  const lines = original.split(/\r?\n/).filter(Boolean);
  const cutoff = nowMs - opts.auditRetentionDays * DAY_MS;
  let kept = lines.filter(line => {
    try {
      const t = Date.parse(JSON.parse(line).time || '');
      return !Number.isFinite(t) || t >= cutoff;
    } catch {
      return true;
    }
  });
  while (kept.length && Buffer.byteLength(`${kept.join('\n')}\n`, 'utf8') > opts.maxAuditBytes) {
    kept.shift();
  }
  const next = kept.length ? `${kept.join('\n')}\n` : '';
  const changed = next !== original;
  if (changed) {
    await fsp.mkdir(path.dirname(auditLog), { recursive: true });
    const tmp = `${auditLog}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, next, 'utf8');
    await fsp.rename(tmp, auditLog);
  }
  return {
    beforeEntries: lines.length,
    afterEntries: kept.length,
    beforeBytes: stat.size,
    afterBytes: Buffer.byteLength(next, 'utf8'),
    removedEntries: lines.length - kept.length,
    changed
  };
}

export async function pruneState(paths, options = {}, nowMs = Date.now()) {
  await fsp.mkdir(paths.stateRoot, { recursive: true });
  await fsp.mkdir(paths.backupRoot, { recursive: true });
  const opts = maintenanceOptions(options);
  const backups = await pruneBackups(paths.backupRoot, opts, nowMs);
  const audit = await pruneAuditLog(paths.auditLog, opts, nowMs);
  return { options: opts, backups, audit };
}
