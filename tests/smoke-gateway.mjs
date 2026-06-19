import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const port = Number(process.env.DEVMATE_SMOKE_PORT || 8798);
const token = 'smoke-token';
const configPath = path.join(os.tmpdir(), `devmate-smoke-${port}.json`);
const bundledGateway = path.join(root, 'gateway', 'server.bundle.mjs');
const gatewayScript = process.env.DEVMATE_GATEWAY_SCRIPT || (fs.existsSync(bundledGateway) ? 'gateway/server.bundle.mjs' : 'gateway/server.mjs');

const config = {
  version: 5,
  appVersion: '1.7.1',
  instanceId: `smoke-${Date.now()}`,
  server: { port, mcpPath: '/mcp' },
  runtime: { defaultCommandTimeoutMs: 30000, maxOutputChars: 80000 },
  auth: { required: true, token },
  permissions: { profile: 'fullAccess', readOnly: false, blockDangerousOperations: false, confirmBeforePush: false, allowDirectoryMutations: true },
  vscodeContext: {
    capturedAt: new Date().toISOString(),
    activeEditor: { path: 'README.md', languageId: 'markdown', lineCount: 1, isDirty: false, selection: { start: { line: 1, character: 1 }, end: { line: 1, character: 1 } }, selectedText: '' },
    visibleEditors: [],
    diagnostics: [{ path: 'README.md', severity: 'warning', message: 'smoke diagnostic', source: 'smoke', code: '', range: { start: { line: 1, character: 1 }, end: { line: 1, character: 2 } } }]
  },
  activeWorkspaceId: 'devmate',
  workspaces: [
    { id: 'devmate', name: 'devmate', root, mode: 'workspace-write', reference: false, role: 'active' }
  ],
  commands: [
    { key: 'node-version', label: 'node --version', command: 'node --version', readOnly: true }
  ]
};

// Include a BOM deliberately. Windows-native tools can create this, and the gateway must tolerate it.
fs.writeFileSync(configPath, `\uFEFF${JSON.stringify(config, null, 2)}`, 'utf8');

const child = spawn(process.execPath, [gatewayScript], {
  cwd: root,
  env: { ...process.env, AIWG_CONFIG: configPath },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe']
});

let stdout = '';
let stderr = '';
child.stdout.on('data', chunk => { stdout += chunk; });
child.stderr.on('data', chunk => { stderr += chunk; });

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function stopGateway() {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    delay(3000)
  ]);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { response, text, json };
}

async function waitReady() {
  for (let i = 0; i < 40; i++) {
    await delay(250);
    try {
      const { response, json } = await fetchJson(`http://127.0.0.1:${port}/control/health`);
      if (response.ok && json?.name === 'devmate' && json?.instanceId === config.instanceId) return;
    } catch {}
  }
  throw new Error(`Gateway did not become ready.\nstdout=${stdout}\nstderr=${stderr}`);
}

async function rpc(method, params, authToken = token) {
  const url = authToken
    ? `http://127.0.0.1:${port}/mcp?token=${encodeURIComponent(authToken)}`
    : `http://127.0.0.1:${port}/mcp`;
  return fetchJson(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 100000), method, params })
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertToolError(result, label) {
  const isError = !!result.json?.error || result.json?.result?.isError === true;
  assert(isError, `${label} unexpectedly succeeded: ${result.text}`);
}
function writeConfigPatch(mutator) {
  const current = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  mutator(current);
  fs.writeFileSync(configPath, JSON.stringify(current, null, 2), 'utf8');
}

try {
  await waitReady();

  const publicHealth = await fetchJson(`http://127.0.0.1:${port}/health`);
  assert(publicHealth.response.ok && publicHealth.json?.status === 'ok', 'public health failed');
  assert(!Object.hasOwn(publicHealth.json, 'configPath'), 'public health leaked configPath');

  const noAuth = await rpc('tools/list', {}, '');
  assert(noAuth.response.status === 401, `expected unauthenticated MCP request to return 401, got ${noAuth.response.status}`);

  const init = await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'devmate-smoke', version: '1.7.1' }
  });
  assert(init.response.ok && init.json?.result?.serverInfo?.name === 'devmate', `initialize failed: ${init.text}`);

  const tools = await rpc('tools/list', {});
  assert(tools.response.ok && Array.isArray(tools.json?.result?.tools), `tools/list failed: ${tools.text}`);
  assert(tools.json.result.tools.length >= 40, `unexpectedly low tool count: ${tools.json.result.tools.length}`);
  const toolByName = new Map(tools.json.result.tools.map(t => [t.name, t]));
  assert(toolByName.get('read_file')?.outputSchema?.type === 'object', 'read_file is missing outputSchema');
  assert(toolByName.get('read_file')?.annotations?.readOnlyHint === true, 'read_file is missing readOnlyHint');
  assert(toolByName.get('write_file')?.annotations?.destructiveHint === true, 'write_file is missing destructiveHint');
  assert(toolByName.get('delete_file')?.annotations?.destructiveHint === true, 'delete_file is missing destructiveHint');
  assert(toolByName.get('run_command')?.annotations?.openWorldHint === true, 'run_command is missing openWorldHint');
  assert(toolByName.get('project_instructions')?.annotations?.readOnlyHint === true, 'project_instructions is missing readOnlyHint');
  assert(toolByName.get('show_changes')?.annotations?.readOnlyHint === true, 'show_changes is missing readOnlyHint');

  const status = await rpc('tools/call', { name: 'gateway_status', arguments: {} });
  assert(status.response.ok && status.text.includes('fullAccess'), `gateway_status did not report fullAccess: ${status.text}`);

  const vscodeContext = await rpc('tools/call', { name: 'vscode_context', arguments: {} });
  assert(vscodeContext.response.ok && vscodeContext.text.includes('README.md'), `vscode_context failed: ${vscodeContext.text}`);

  const projectInstructions = await rpc('tools/call', { name: 'project_instructions', arguments: {} });
  assert(projectInstructions.response.ok && projectInstructions.text.includes('AGENTS.md'), `project_instructions failed: ${projectInstructions.text}`);

  const changes = await rpc('tools/call', { name: 'show_changes', arguments: { maxOutputChars: 5000 } });
  assert(changes.response.ok && changes.text.includes('filesChanged'), `show_changes failed: ${changes.text}`);

  const validation = await rpc('tools/call', { name: 'detect_validation', arguments: {} });
  assert(validation.response.ok && validation.text.includes('package:check'), `detect_validation failed: ${validation.text}`);

  const commands = await rpc('tools/call', { name: 'list_configured_commands', arguments: {} });
  assert(commands.response.ok && commands.json?.result, `list_configured_commands failed: ${commands.text}`);

  const commandRun = await rpc('tools/call', { name: 'run_configured_command', arguments: { key: 'node-version' } });
  assert(commandRun.response.ok && commandRun.text.includes('node-version'), `run_configured_command failed: ${commandRun.text}`);

  const invalidRegex = await rpc('tools/call', { name: 'search_text', arguments: { query: '(', regex: true } });
  assertToolError(invalidRegex, 'invalid regex block');

  const secretCommand = await rpc('tools/call', { name: 'run_command', arguments: { command: 'node -e "console.log(\'token=secret123\')"', maxOutputChars: 2000 } });
  assert(secretCommand.response.ok, `secret command failed: ${secretCommand.text}`);
  const auditLog = await rpc('tools/call', { name: 'read_audit_log', arguments: { limit: 20 } });
  assert(auditLog.response.ok && auditLog.text.includes('token=redacted') && !auditLog.text.includes('secret123'), `audit redaction failed: ${auditLog.text}`);

  const task = await rpc('tools/call', { name: 'start_task', arguments: { title: 'smoke rollback' } });
  assert(task.response.ok && task.text.includes('task-'), `start_task failed: ${task.text}`);
  const tempPath = 'tmp/devmate-smoke-rollback.txt';
  const create = await rpc('tools/call', { name: 'create_file', arguments: { path: tempPath, content: 'rollback me', overwrite: true } });
  assert(create.response.ok && create.text.includes('created'), `create_file for rollback failed: ${create.text}`);
  const taskJson = JSON.parse(task.json.result.content[0].text);
  const taskId = taskJson.task.currentTaskId;
  const rollback = await rpc('tools/call', { name: 'rollback_task', arguments: { taskId } });
  assert(rollback.response.ok && rollback.text.includes('removed'), `rollback_task failed: ${rollback.text}`);
  const rolledBackRead = await rpc('tools/call', { name: 'read_file', arguments: { path: tempPath } });
  assertToolError(rolledBackRead, 'rollback removed file');
  await rpc('tools/call', { name: 'finish_task', arguments: {} });

  writeConfigPatch(c => {
    c.permissions = { ...c.permissions, profile: 'balanced', readOnly: false, blockDangerousOperations: true, allowDirectoryMutations: false };
  });
  const dangerousCommand = await rpc('tools/call', { name: 'run_command', arguments: { command: 'git reset --hard' } });
  assertToolError(dangerousCommand, 'dangerous command block');

  const readme = await rpc('tools/call', { name: 'read_file', arguments: { path: 'README.md', maxChars: 2000 } });
  assert(readme.response.ok && readme.text.includes('DevMate'), `read_file README failed: ${readme.text}`);

  const envBlocked = await rpc('tools/call', { name: 'read_file', arguments: { path: '.env' } });
  assertToolError(envBlocked, 'secret read block');

  const directoryBlocked = await rpc('tools/call', { name: 'delete_file', arguments: { path: 'docs', recursive: true } });
  assertToolError(directoryBlocked, 'directory mutation block');

  console.log(JSON.stringify({
    ok: true,
    health: publicHealth.json.status,
    unauthStatus: noAuth.response.status,
    server: init.json.result.serverInfo.name,
    toolCount: tools.json.result.tools.length
  }));
} finally {
  await stopGateway();
  try { fs.rmdirSync(path.join(root, 'tmp')); } catch {}
}
