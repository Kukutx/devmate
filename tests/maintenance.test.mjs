import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_MAINTENANCE,
  maintenanceOptions,
  pruneAuditLog,
  pruneBackups,
  pruneState,
  stateSummary
} from '../gateway/maintenance.mjs';

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-maintenance-'));
}

async function writeFile(file, content) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content);
}

test('maintenanceOptions clamps invalid values to safe bounds', () => {
  assert.deepEqual(maintenanceOptions({
    backupRetentionDays: -10,
    auditRetentionDays: 'bad',
    maxBackupBytes: 10,
    maxAuditBytes: 10
  }), {
    backupRetentionDays: 1,
    auditRetentionDays: DEFAULT_MAINTENANCE.auditRetentionDays,
    maxBackupBytes: 1024 * 1024,
    maxAuditBytes: 256 * 1024
  });
});

test('pruneAuditLog removes expired JSON entries and keeps recent or unparsable lines', async () => {
  const dir = await tempDir();
  try {
    const auditLog = path.join(dir, 'audit.jsonl');
    const nowMs = Date.parse('2026-06-19T00:00:00.000Z');
    await writeFile(auditLog, [
      JSON.stringify({ time: '2026-05-01T00:00:00.000Z', action: 'old' }),
      JSON.stringify({ time: '2026-06-18T00:00:00.000Z', action: 'recent' }),
      'not json'
    ].join('\n') + '\n');

    const result = await pruneAuditLog(auditLog, { auditRetentionDays: 30 }, nowMs);
    const text = await fsp.readFile(auditLog, 'utf8');

    assert.equal(result.removedEntries, 1);
    assert(!text.includes('"old"'));
    assert(text.includes('"recent"'));
    assert(text.includes('not json'));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('pruneAuditLog trims oldest entries when the audit log exceeds maxAuditBytes', async () => {
  const dir = await tempDir();
  try {
    const auditLog = path.join(dir, 'audit.jsonl');
    const lines = [];
    for (let i = 0; i < 80; i++) {
      lines.push(JSON.stringify({
        time: '2026-06-18T00:00:00.000Z',
        index: i,
        payload: 'x'.repeat(5000)
      }));
    }
    await writeFile(auditLog, lines.join('\n') + '\n');

    const result = await pruneAuditLog(auditLog, { auditRetentionDays: 30, maxAuditBytes: 256 * 1024 }, Date.parse('2026-06-19T00:00:00.000Z'));
    const text = await fsp.readFile(auditLog, 'utf8');

    assert(result.afterBytes <= 256 * 1024);
    assert(result.removedEntries > 0);
    assert(!text.includes('"index":0'));
    assert(text.includes('"index":79'));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('pruneBackups removes expired backup sets and trims oldest sets by size', async () => {
  const dir = await tempDir();
  try {
    const backupRoot = path.join(dir, 'backups');
    const oldSet = path.join(backupRoot, '2026-05-01T00-00-00-000Z');
    const middleSet = path.join(backupRoot, '2026-06-17T00-00-00-000Z');
    const newestSet = path.join(backupRoot, '2026-06-18T00-00-00-000Z');

    await writeFile(path.join(oldSet, 'old.txt'), 'old');
    await writeFile(path.join(middleSet, 'middle.bin'), Buffer.alloc(700 * 1024, 1));
    await writeFile(path.join(newestSet, 'newest.bin'), Buffer.alloc(700 * 1024, 2));

    const oldDate = new Date('2026-05-01T00:00:00.000Z');
    const middleDate = new Date('2026-06-17T00:00:00.000Z');
    const newestDate = new Date('2026-06-18T00:00:00.000Z');
    await fsp.utimes(oldSet, oldDate, oldDate);
    await fsp.utimes(middleSet, middleDate, middleDate);
    await fsp.utimes(newestSet, newestDate, newestDate);

    const result = await pruneBackups(backupRoot, {
      backupRetentionDays: 30,
      maxBackupBytes: 1024 * 1024
    }, Date.parse('2026-06-19T00:00:00.000Z'));

    assert.equal(result.beforeSets, 3);
    assert.equal(result.afterSets, 1);
    assert(result.deleted.some(item => item.reason === 'age' && item.path.endsWith('2026-05-01T00-00-00-000Z')));
    assert(result.deleted.some(item => item.reason === 'size' && item.path.endsWith('2026-06-17T00-00-00-000Z')));
    await assert.rejects(fsp.stat(oldSet));
    await assert.rejects(fsp.stat(middleSet));
    await fsp.stat(newestSet);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('pruneState creates missing state folders and reports current storage summary', async () => {
  const dir = await tempDir();
  try {
    const paths = {
      stateRoot: path.join(dir, 'state'),
      backupRoot: path.join(dir, 'state', 'backups'),
      auditLog: path.join(dir, 'state', 'audit.jsonl')
    };
    const result = await pruneState(paths, {}, Date.now());
    const summary = await stateSummary(paths);

    assert.equal(result.backups.beforeSets, 0);
    assert.equal(summary.backupSets, 0);
    assert.equal(summary.auditEntries, 0);
    await fsp.stat(paths.stateRoot);
    await fsp.stat(paths.backupRoot);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
