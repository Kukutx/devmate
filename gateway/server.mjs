#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { DEFAULT_MAINTENANCE, maintenanceOptions, pruneState, stateSummary } from './maintenance.mjs';

const VERSION = '1.12.0';
const CONFIG_PATH = process.env.AIWG_CONFIG;
if (!CONFIG_PATH) { console.error('AIWG_CONFIG is required'); process.exit(1); }
const CONFIG_DIR = path.dirname(CONFIG_PATH);
const STATE_ROOT = path.join(CONFIG_DIR, 'state');
const BACKUP_ROOT = path.join(STATE_ROOT, 'backups');
const AUDIT_LOG = path.join(STATE_ROOT, 'audit.jsonl');
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT = 120000;
const DEFAULT_TIMEOUT_MS = 180000;
const MAX_DIRECTORY_MUTATION_ENTRIES = 20000;
const PUBLIC_HEALTH_DETAILS = process.env.DEVMATE_PUBLIC_HEALTH_DETAILS === '1';
const STATUS_UI_URI = 'ui://devmate/status.html';
const APP_RESOURCE_MIME = 'text/html;profile=mcp-app';
const writeLocks = new Set();

const HIDDEN_DIRS = new Set(['.git','node_modules','.next','.dart_tool','.firebase','build','dist','coverage','bin','obj','.venv','venv','secrets','secret','credentials','credential','private-key','private_keys','service-account','service_accounts']);
const BLOCKED_EXT = new Set(['.pem','.key','.pfx','.p12','.db','.sqlite','.sqlite3','.log']);
const TEXT_EXT = new Set(['.md','.mdx','.txt','.json','.jsonc','.yaml','.yml','.js','.jsx','.ts','.tsx','.cjs','.mjs','.css','.scss','.sass','.less','.html','.xml','.cs','.csproj','.sln','.dart','.py','.ps1','.sh','.bash','.zsh','.sql','.toml','.ini','.config','.props','.targets','.java','.kt','.kts','.go','.rs','.php','.rb','.swift','.vue','.svelte','.env.example','.env.sample','.sample']);
const ALLOW_BASENAME = new Set(['README','README.md','LICENSE','Dockerfile','Makefile','package.json','package-lock.json','pnpm-lock.yaml','yarn.lock','bun.lockb','pubspec.yaml','pubspec.lock','global.json','Directory.Packages.props']);
const PROJECT_INSTRUCTION_BASENAMES = new Set(['agents.md','claude.md']);
const ROOT_PROJECT_INSTRUCTION_FILES = ['AGENTS.md','CLAUDE.md'];
const PROJECT_INSTRUCTION_SKIP_DIRS = new Set([...HIDDEN_DIRS, '.github', '.vscode', '.idea', 'tmp']);

function readJson(p){ return JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,'')); }
function loadConfig(){ const c=readJson(CONFIG_PATH); c.server ||= {}; c.instanceId ||= 'missing-instance'; c.server.port ||= 8787; c.server.mcpPath = '/mcp'; c.runtime ||= {}; c.runtime.defaultCommandTimeoutMs ||= DEFAULT_TIMEOUT_MS; c.runtime.maxOutputChars ||= DEFAULT_MAX_OUTPUT; c.maintenance = maintenanceOptions(c.maintenance || DEFAULT_MAINTENANCE); c.connection ||= {}; c.workspaces ||= []; c.commands ||= []; return c; }
function saveConfig(c){ fs.writeFileSync(CONFIG_PATH, JSON.stringify(c,null,2)+'\n','utf8'); }
function now(){ return new Date().toISOString(); }
function relParts(p){ return String(p||'').split(/[\\/]+/).filter(Boolean); }
function normalizeSlash(p){ return String(p||'').replace(/\\/g,'/'); }
function isHidden(rel){ return relParts(rel).map(x=>x.toLowerCase()).some(x=>HIDDEN_DIRS.has(x)); }
function isEnvFile(base){ const b=base.toLowerCase(); return b === '.env' || b.startsWith('.env.') || b === 'env.local' || b.endsWith('.env'); }
function isEnvExample(base){ const b=base.toLowerCase(); return b === '.env.example' || b === '.env.sample' || b.endsWith('.env.example') || b.endsWith('.env.sample'); }
function isBinaryOrSecret(rel){ const base=path.basename(rel); if(isHidden(rel)) return true; if(isEnvFile(base) && !isEnvExample(base)) return true; const ext=path.extname(base).toLowerCase(); return BLOCKED_EXT.has(ext); }
function isTextAllowed(rel){ if(isBinaryOrSecret(rel)) return false; const base=path.basename(rel); if(ALLOW_BASENAME.has(base)) return true; if(base.startsWith('.env') && isEnvExample(base)) return true; const ext=path.extname(base).toLowerCase(); return TEXT_EXT.has(ext); }
function isInside(root, target){ const rel=path.relative(root, target); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); }
function safeResolve(root, sub='.'){ const rootPath=path.resolve(root); const target=path.resolve(rootPath, sub || '.'); if(!isInside(rootPath,target)) throw new Error(`Path escapes workspace root: ${sub}`); return target; }
function pathKey(p){ return process.platform === 'win32' ? String(p).toLowerCase() : String(p); }
function realPathInside(root, full){ try{ const rootReal=fs.realpathSync.native(root); const fullReal=fs.realpathSync.native(full); return isInside(rootReal, fullReal) ? fullReal : null; }catch{ return null; } }
function assertRealInside(root, full){
  const rootReal = fs.realpathSync.native(root);
  let check = full;
  if(fs.existsSync(full)) {
    check = fs.realpathSync.native(full);
  } else {
    let parent = path.dirname(full);
    while(!fs.existsSync(parent) && parent !== path.dirname(parent)) parent = path.dirname(parent);
    const parentReal = fs.realpathSync.native(parent);
    check = path.resolve(parentReal, path.relative(parent, full));
  }
  if(!isInside(rootReal, check)) throw new Error(`Path escapes workspace root through symlink/reparse point: ${normalizeSlash(path.relative(root, full))}`);
  return full;
}
function isWorkspaceRootRel(rel){ const n=normalizeSlash(path.normalize(rel || '.')); return n === '.' || n === ''; }
function sha256(text){ return crypto.createHash('sha256').update(text,'utf8').digest('hex'); }
function newTaskId(){ return `task-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`; }
function activeWorkspace(cfg){ return cfg.workspaces.find(w=>w.id===cfg.activeWorkspaceId) || cfg.workspaces.find(w=>!w.reference) || cfg.workspaces[0]; }
function getWs(cfg,id){ const w=id ? cfg.workspaces.find(x=>x.id===id || x.name===id) : activeWorkspace(cfg); if(!w) throw new Error('No workspace configured. Open a project in VS Code and run One-click Start.'); return w; }
function wsPublic(w){ return { id:w.id, name:w.name, role:w.role || (w.reference?'reference':'active'), mode:w.mode || (w.reference?'readonly':'workspace-write'), reference:!!w.reference, writable:!w.reference && (w.mode||'workspace-write') !== 'readonly', root:path.basename(w.root||'') }; }
function permissionProfile(cfg){ return cfg.permissions?.profile || (cfg.permissions?.readOnly ? 'readOnly' : 'fullAccess'); }
function isReadOnlyProfile(cfg){ return permissionProfile(cfg) === 'readOnly'; }
function dangerousGuardEnabled(cfg){ return permissionProfile(cfg) !== 'fullAccess' && cfg.permissions?.blockDangerousOperations !== false; }
function assertCanMutate(cfg, action){ if(isReadOnlyProfile(cfg)) throw new Error(`${action} blocked by readOnly permission profile`); }
function assertReadable(w,rel){ if(!isTextAllowed(rel)) throw new Error(`Read blocked: secret/binary/hidden path: ${rel}`); return assertRealInside(w.root, safeResolve(w.root,rel)); }
function assertWritable(cfg,w,rel){ assertCanMutate(cfg,'Write'); if(w.reference || (w.mode||'workspace-write') === 'readonly') throw new Error(`Workspace is readonly/reference: ${w.id}`); if(isWorkspaceRootRel(rel)) throw new Error('Write blocked: workspace root cannot be mutated directly'); if(isBinaryOrSecret(rel)) throw new Error(`Write blocked: secret/binary/hidden path: ${rel}`); return assertRealInside(w.root, safeResolve(w.root,rel)); }
function assertCwd(w,cwd='.') { return assertRealInside(w.root, safeResolve(w.root,cwd||'.')); }
function truncate(s,max=DEFAULT_MAX_OUTPUT){ s=String(s??''); return { text:s.slice(0,max), truncated:s.length>max, length:s.length }; }
function toolText(payload){ return { content:[{type:'text', text: JSON.stringify(payload,null,2)}], structuredContent: payload }; }
function redactSensitiveString(value){
  return String(value ?? '')
    .replace(/([?&](?:token|key|secret|password|auth|authorization)=)[^&\s]+/gi, '$1redacted')
    .replace(/(\b(?:token|secret|password|authorization|api[_-]?key|authToken)\s*[:=]\s*)[^\s&"'`]+/gi, '$1redacted')
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1redacted')
    .replace(/(\b(?:--password|--token|--api-key|--secret)\s+)[^\s]+/gi, '$1redacted')
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, 'sk-redacted');
}
function redactSensitivePayload(value, key=''){
  if(value == null) return value;
  if(typeof value === 'string') return /token|secret|password|authorization|api[_-]?key|auth/i.test(key) ? 'redacted' : redactSensitiveString(value);
  if(Array.isArray(value)) return value.map((item, index) => redactSensitivePayload(item, String(index)));
  if(typeof value === 'object'){
    const out = {};
    for(const [k,v] of Object.entries(value)) out[k] = redactSensitivePayload(v, k);
    return out;
  }
  return value;
}
const TOOL_OUTPUT_SCHEMA = z.object({}).passthrough();
const READ_ONLY_TOOLS = new Set([
  'gateway_status','gateway_self_test','task_status','list_workspaces','vscode_context','active_editor_context','list_diagnostics',
  'workspace_map','project_snapshot','project_instructions','list_project_scripts','list_configured_commands','detect_validation','list_files','read_file',
  'search_text','git_status','git_diff','git_staged_files','git_log','git_blame','show_changes','task_report','list_backups','read_audit_log','maintenance_status',
  'connection_diagnostics','devmate_status_panel'
]);
const DESTRUCTIVE_TOOLS = new Set([
  'rollback_task','write_file','create_file','apply_patch','delete_file','move_file','restore_backup',
  'run_command','run_configured_command','run_project_script','run_smart_checks',
  'git_add','git_stage','git_commit','git_save','git_push','git_pull','git_branch','git_checkout','git_raw','git_stash'
]);
const OPEN_WORLD_TOOLS = new Set(['run_command','run_configured_command','run_project_script','run_smart_checks','git_save','git_push','git_pull','git_raw']);
function toolAnnotations(name){
  const readOnly = READ_ONLY_TOOLS.has(name);
  return {
    readOnlyHint: readOnly,
    destructiveHint: DESTRUCTIVE_TOOLS.has(name),
    idempotentHint: readOnly,
    openWorldHint: OPEN_WORLD_TOOLS.has(name)
  };
}
function toolConfig(name, config){
  return {
    ...config,
    outputSchema: config.outputSchema || TOOL_OUTPUT_SCHEMA,
    annotations: { ...toolAnnotations(name), ...(config.annotations || {}) }
  };
}
function clampInt(value, fallback, min, max){ const n=Number(value); if(!Number.isFinite(n)) return fallback; return Math.min(max, Math.max(min, Math.trunc(n))); }
function commandLimits(cfg, timeoutMs, maxOutputChars){
  return {
    timeoutMs: clampInt(timeoutMs ?? cfg.runtime?.defaultCommandTimeoutMs, DEFAULT_TIMEOUT_MS, 1000, 1800000),
    maxOutputChars: clampInt(maxOutputChars ?? cfg.runtime?.maxOutputChars, DEFAULT_MAX_OUTPUT, 1000, 500000)
  };
}
function timingSafeStringEqual(a,b){ const ab=Buffer.from(String(a||'')); const bb=Buffer.from(String(b||'')); return ab.length === bb.length && crypto.timingSafeEqual(ab,bb); }
function requestToken(req,url){ const h=req.headers.authorization || ''; const bearer=String(h).match(/^Bearer\s+(.+)$/i)?.[1]; return bearer || req.headers['x-devmate-token'] || url.searchParams.get('token') || ''; }
function isAuthorized(req,url,cfg){ if(cfg.auth?.required === false) return true; const expected=cfg.auth?.token; if(!expected) return false; return timingSafeStringEqual(requestToken(req,url), expected); }
function assertPushAllowed(cfg){ if(cfg.permissions?.confirmBeforePush) throw new Error('Git push is blocked by devMate.confirmBeforePush. Review locally, then disable that setting to push.'); }
function isDangerousCommand(command){
  const c = String(command || '').toLowerCase().replace(/\s+/g,' ').trim();
  return /\brm\s+(-[^\s]*[rf][^\s]*|-[^\s]*[fr][^\s]*)\b/.test(c) ||
    /\bremove-item\b.*\b-recurse\b.*\b-force\b/.test(c) ||
    /\brmdir\b.*\s\/s\b/.test(c) ||
    /\bdel\b.*\s\/s\b/.test(c) ||
    /\bformat\b\s+[a-z]:/.test(c) ||
    /\bshutdown\b|\brestart-computer\b|\bstop-computer\b/.test(c) ||
    /\bgit\s+reset\b.*--hard\b/.test(c) ||
    /\bgit\s+clean\b.*-[^\s]*[fdx]/.test(c) ||
    /\bgit\s+push\b.*--force\b/.test(c) ||
    /\bgit\s+push\b.*--force-with-lease\b/.test(c);
}
function assertCommandAllowed(cfg, command){
  assertCanMutate(cfg,'Command execution');
  if(dangerousGuardEnabled(cfg) && isDangerousCommand(command)) throw new Error(`Dangerous command blocked by DevMate guard: ${command}`);
}
function isDangerousGitArgs(args=[]){
  const a = args.map(x=>String(x).toLowerCase());
  const joined = a.join(' ');
  return (a[0] === 'reset' && a.includes('--hard')) ||
    a[0] === 'clean' ||
    (a[0] === 'push' && (a.includes('--force') || a.includes('-f') || a.includes('--force-with-lease'))) ||
    (a[0] === 'checkout' && joined.includes(' -- ')) ||
    (a[0] === 'restore' && (a.includes('.') || a.includes(':/' ) || a.includes('--staged')));
}
function assertGitAllowed(cfg,args=[],action='Git mutation'){
  assertCanMutate(cfg,action);
  if(args.includes('push')) assertPushAllowed(cfg);
  if(dangerousGuardEnabled(cfg) && isDangerousGitArgs(args)) throw new Error(`Dangerous git operation blocked by DevMate guard: git ${args.join(' ')}`);
}
async function assertDirectoryMutationAllowed(cfg,w,full,rel){
  const st = await fsp.stat(full);
  if(!st.isDirectory()) return st;
  if(!cfg.permissions?.allowDirectoryMutations) throw new Error('Directory mutation blocked. Enable devMate.allowDirectoryMutations to delete or move directories.');
  let count = 0;
  const visited = new Set([pathKey(fs.realpathSync.native(full))]);
  async function scan(dir){
    const entries = await fsp.readdir(dir,{withFileTypes:true});
    for(const e of entries){
      const child = path.join(dir,e.name);
      const childRel = normalizeSlash(path.relative(w.root, child));
      if(isBinaryOrSecret(childRel)) throw new Error(`Directory mutation blocked because it contains protected path: ${childRel}`);
      count++;
      if(count > MAX_DIRECTORY_MUTATION_ENTRIES) throw new Error(`Directory mutation blocked because it contains more than ${MAX_DIRECTORY_MUTATION_ENTRIES} entries.`);
      if(e.isDirectory()){
        const childReal = realPathInside(w.root, child);
        if(!childReal) throw new Error(`Directory mutation blocked because it contains a directory outside the workspace: ${childRel}`);
        const key = pathKey(childReal);
        if(visited.has(key)) continue;
        visited.add(key);
        await scan(child);
      }
    }
  }
  await scan(full);
  return st;
}
async function audit(action, payload){
  try{
    fs.mkdirSync(STATE_ROOT,{recursive:true});
    const cfg = loadConfig();
    const safePayload = redactSensitivePayload(payload || {});
    const entry = {
      time: now(),
      action,
      taskId: payload?.taskId || cfg.task?.currentTaskId || null,
      permissionProfile: permissionProfile(cfg),
      ...safePayload
    };
    await fsp.appendFile(AUDIT_LOG, JSON.stringify(entry)+'\n','utf8');
  }catch{}
}
async function readAuditEntries(limit=1000){
  let lines=[];
  try{ lines=(await fsp.readFile(AUDIT_LOG,'utf8')).trim().split(/\r?\n/).filter(Boolean); }catch{}
  return lines.slice(-limit).map(x=>{try{return redactSensitivePayload(JSON.parse(x))}catch{return {raw:redactSensitiveString(x)}}});
}
function backupSafeRel(rel){
  const parts = normalizeSlash(rel).split('/').filter(x => x && x !== '.' && x !== '..');
  const safeParts = parts.map(x => x.replace(/[<>:"|?*\x00-\x1F]/g,'_'));
  return safeParts.length ? safeParts.join('/') : 'workspace-root';
}
async function backupPath(full, rel){
  try{
    const st=await fsp.stat(full).catch(()=>null);
    if(!st) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g,'-');
    const dst = path.join(BACKUP_ROOT, stamp, backupSafeRel(rel));
    await fsp.mkdir(path.dirname(dst),{recursive:true});
    if(st.isDirectory()) await fsp.cp(full,dst,{recursive:true,force:false});
    else await fsp.copyFile(full,dst);
    return dst;
  }catch(e){ return `backup_failed:${e.message}`; }
}
async function withLock(file, fn){ const key=path.resolve(file).toLowerCase(); if(writeLocks.has(key)) throw new Error(`Path locked by another write: ${file}`); writeLocks.add(key); try{return await fn();} finally{writeLocks.delete(key);} }
async function walk(dir, root, depth, max, out, visited=new Set()){
  if(out.length>=max) return;
  const dirReal = realPathInside(root, dir);
  if(!dirReal) return;
  const dirKey = pathKey(dirReal);
  if(visited.has(dirKey)) return;
  visited.add(dirKey);
  let entries=[];
  try{entries=await fsp.readdir(dir,{withFileTypes:true});}catch{return;}
  entries.sort((a,b)=>a.name.localeCompare(b.name));
  for(const e of entries){
    if(out.length>=max) break;
    const full=path.join(dir,e.name);
    const rel=normalizeSlash(path.relative(root,full));
    if(isHidden(rel)) continue;
    if(e.isDirectory()){
      const childReal = realPathInside(root, full);
      if(!childReal || visited.has(pathKey(childReal))) continue;
      out.push({type:'dir',path:rel});
      if(depth>0) await walk(full,root,depth-1,max,out,visited);
    } else if(e.isFile() && isTextAllowed(rel)){
      const st=await fsp.stat(full);
      out.push({type:'file',path:rel,size:st.size});
    }
  }
}
async function allFiles(dir,root,out,max=10000,visited=new Set()){
  if(out.length>=max) return;
  const dirReal = realPathInside(root, dir);
  if(!dirReal) return;
  const dirKey = pathKey(dirReal);
  if(visited.has(dirKey)) return;
  visited.add(dirKey);
  let entries=[];
  try{entries=await fsp.readdir(dir,{withFileTypes:true});}catch{return;}
  for(const e of entries){
    if(out.length>=max) break;
    const full=path.join(dir,e.name);
    const rel=normalizeSlash(path.relative(root,full));
    if(isHidden(rel)) continue;
    if(e.isDirectory()) await allFiles(full,root,out,max,visited);
    else if(e.isFile() && isTextAllowed(rel)) out.push(full);
  }
}
function execProcess(command,args,{cwd,timeoutMs=DEFAULT_TIMEOUT_MS,maxOutputChars=DEFAULT_MAX_OUTPUT,shell=false}={}){ return new Promise(resolve=>{ const child=spawn(command,args,{cwd,encoding:'utf8',shell,windowsHide:true}); let stdout='', stderr='', done=false; const timer=setTimeout(()=>{ if(done) return; done=true; try{child.kill('SIGKILL');}catch{} resolve({command:shell?command:[command,...args].join(' '),cwd,exitCode:null,timedOut:true,...truncateOutputs(stdout,stderr,maxOutputChars)}); },timeoutMs); child.stdout?.on('data',d=>{ stdout += d.toString(); if(stdout.length>maxOutputChars*2) stdout=stdout.slice(-maxOutputChars*2); }); child.stderr?.on('data',d=>{ stderr += d.toString(); if(stderr.length>maxOutputChars*2) stderr=stderr.slice(-maxOutputChars*2); }); child.on('error',e=>{ if(done) return; done=true; clearTimeout(timer); resolve({command:shell?command:[command,...args].join(' '),cwd,exitCode:null,error:e.message,...truncateOutputs(stdout,stderr,maxOutputChars)}); }); child.on('close',code=>{ if(done) return; done=true; clearTimeout(timer); resolve({command:shell?command:[command,...args].join(' '),cwd,exitCode:code,timedOut:false,...truncateOutputs(stdout,stderr,maxOutputChars)}); }); }); }
function truncateOutputs(stdout,stderr,max){ const so=truncate(stdout,max); const se=truncate(stderr,max); return {stdout:so.text,stderr:se.text,stdoutTruncated:so.truncated,stderrTruncated:se.truncated}; }
async function runGit(w,args,maxOutputChars=DEFAULT_MAX_OUTPUT,timeoutMs=DEFAULT_TIMEOUT_MS){ return execProcess('git',args,{cwd:w.root,maxOutputChars,timeoutMs,shell:false}); }
function gitRel(w, rel){ const full=safeResolve(w.root, rel); return normalizeSlash(path.relative(w.root,full)); }
function getGitPaths(w, paths){ if(!Array.isArray(paths)||paths.length===0) return []; return paths.map(p=>gitRel(w,p)); }

async function readPackageScripts(w, subpath='.') {
  const pkgPath = assertRealInside(w.root, safeResolve(w.root, path.join(subpath || '.', 'package.json')));
  try {
    const pkg = JSON.parse((await fsp.readFile(pkgPath, 'utf8')).replace(/^\uFEFF/,''));
    return { path: normalizeSlash(path.relative(w.root, pkgPath)), packageManager: pkg.packageManager || null, scripts: pkg.scripts || {} };
  } catch (e) {
    return { path: normalizeSlash(path.relative(w.root, pkgPath)), error: e.message, scripts: {} };
  }
}
async function projectInstructionFiles(w, maxFiles=80, maxChars=50000) {
  maxFiles = clampInt(maxFiles, 80, 1, 200);
  maxChars = clampInt(maxChars, 50000, 1000, 200000);
  const loaded = [];
  const available = [];
  const seen = new Set();
  let remainingChars = maxChars;

  for (const rel of ROOT_PROJECT_INSTRUCTION_FILES) {
    const full = safeResolve(w.root, rel);
    const st = await fsp.stat(full).catch(() => null);
    if (!st?.isFile() || !isTextAllowed(rel)) continue;
    const text = await fsp.readFile(full, 'utf8').catch(() => null);
    if (text == null) continue;
    const t = truncate(text, remainingChars);
    loaded.push({ path: rel, length: text.length, truncated: t.truncated, text: t.text });
    remainingChars = Math.max(0, remainingChars - t.text.length);
    seen.add(rel.toLowerCase());
  }

  const visited = new Set();
  async function scan(dir) {
    if (loaded.length + available.length >= maxFiles) return;
    const dirReal = realPathInside(w.root, dir);
    if(!dirReal) return;
    const dirKey = pathKey(dirReal);
    if(visited.has(dirKey)) return;
    visited.add(dirKey);
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (loaded.length + available.length >= maxFiles) break;
      const full = path.join(dir, e.name);
      const rel = normalizeSlash(path.relative(w.root, full));
      const lowerName = e.name.toLowerCase();
      if (e.isDirectory()) {
        if (PROJECT_INSTRUCTION_SKIP_DIRS.has(lowerName)) continue;
        const childReal = realPathInside(w.root, full);
        if(!childReal || visited.has(pathKey(childReal))) continue;
        await scan(full);
      } else if (e.isFile() && PROJECT_INSTRUCTION_BASENAMES.has(lowerName) && !seen.has(rel.toLowerCase()) && isTextAllowed(rel)) {
        const st = await fsp.stat(full).catch(() => null);
        available.push({ path: rel, size: st?.size || 0 });
        seen.add(rel.toLowerCase());
      }
    }
  }

  await scan(w.root);
  return { loaded, available, total: loaded.length + available.length, truncated: loaded.length + available.length >= maxFiles };
}
function parseNumstat(stdout='') {
  const files = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [add, remove, ...rest] = parts;
    files.push({
      path: rest.join('\t'),
      additions: add === '-' ? null : Number(add) || 0,
      removals: remove === '-' ? null : Number(remove) || 0
    });
  }
  return files;
}
function changeSummary(files=[]) {
  let additions = 0;
  let removals = 0;
  let binaryFiles = 0;
  for (const f of files) {
    if (typeof f.additions === 'number') additions += f.additions;
    else binaryFiles++;
    if (typeof f.removals === 'number') removals += f.removals;
  }
  return { filesChanged: files.length, additions, removals, binaryFiles };
}
async function gitChangeReview(w, staged=false, maxOutputChars=80000) {
  const diffArgs = staged ? ['diff','--staged'] : ['diff'];
  const [status, diffStat, numstat, patch] = await Promise.all([
    runGit(w, ['status','--short','--branch'], 20000),
    runGit(w, [...diffArgs, '--stat'], 20000),
    runGit(w, [...diffArgs, '--numstat'], 50000),
    runGit(w, diffArgs, maxOutputChars)
  ]);
  const files = parseNumstat(numstat.stdout);
  return { workspace: wsPublic(w), staged, status, diffStat, summary: changeSummary(files), files, patch };
}
async function compactTree(w, depth=2, maxResults=350) {
  const items=[];
  await walk(w.root, w.root, depth, maxResults, items);
  return items;
}
async function existsInWorkspace(w, rel){ return !!(await fsp.stat(safeResolve(w.root,rel)).catch(()=>null)); }
async function detectPackageManager(w, dir=w.root){
  if(fs.existsSync(path.join(dir,'pnpm-lock.yaml'))) return 'pnpm';
  if(fs.existsSync(path.join(dir,'yarn.lock'))) return 'yarn';
  if(fs.existsSync(path.join(dir,'bun.lockb'))) return 'bun';
  return 'npm';
}
async function validationPlan(w){
  const checks=[];
  const pkg = await readPackageScripts(w,'.');
  if(pkg.scripts && !pkg.error){
    const pm = await detectPackageManager(w);
    for(const name of ['check','lint','test','build']){
      if(Object.prototype.hasOwnProperty.call(pkg.scripts,name)){
        const command = pm==='npm'?`npm run ${name}`:`${pm} ${name}`;
        checks.push({key:`package:${name}`,label:command,command,cwd:'.',kind:'package-script'});
      }
    }
  }
  if(await existsInWorkspace(w,'pubspec.yaml')){
    checks.push({key:'flutter:analyze',label:'flutter analyze',command:'flutter analyze',cwd:'.',kind:'flutter'});
    if(await existsInWorkspace(w,'test')) checks.push({key:'flutter:test',label:'flutter test',command:'flutter test',cwd:'.',kind:'flutter'});
  }
  const rootEntries=await fsp.readdir(w.root).catch(()=>[]);
  if(rootEntries.some(x=>x.endsWith('.sln') || x.endsWith('.csproj'))){
    checks.push({key:'dotnet:build',label:'dotnet build',command:'dotnet build',cwd:'.',kind:'dotnet'});
    checks.push({key:'dotnet:test',label:'dotnet test',command:'dotnet test',cwd:'.',kind:'dotnet'});
  }
  if(await existsInWorkspace(w,'pyproject.toml') || await existsInWorkspace(w,'requirements.txt')){
    checks.push({key:'python:pytest',label:'pytest',command:'pytest',cwd:'.',kind:'python'});
  }
  if(await existsInWorkspace(w,'Cargo.toml')){
    checks.push({key:'rust:test',label:'cargo test',command:'cargo test',cwd:'.',kind:'rust'});
  }
  if(await existsInWorkspace(w,'go.mod')){
    checks.push({key:'go:test',label:'go test ./...',command:'go test ./...',cwd:'.',kind:'go'});
  }
  return checks;
}
function backupRelativePath(backupFull){
  const backupRoot = fs.realpathSync.native(BACKUP_ROOT);
  const full = fs.realpathSync.native(backupFull);
  if(!isInside(backupRoot, full)) throw new Error('Backup path is outside DevMate backup root');
  const parts = path.relative(backupRoot, full).split(path.sep).filter(Boolean);
  if(parts.length < 2) throw new Error('Backup path does not include an original relative path');
  return normalizeSlash(parts.slice(1).join('/'));
}
async function restoreBackupToPath(cfg,w,backupFull,rel,dryRun=false){
  if(!backupFull || String(backupFull).startsWith('backup_failed:')) return {path:rel,backupPath:backupFull,restored:false,reason:'missing backup'};
  const src=assertRealInside(BACKUP_ROOT,path.resolve(backupFull));
  const st=await fsp.stat(src).catch(()=>null);
  if(!st) return {path:rel,backupPath:backupFull,restored:false,reason:'backup not found'};
  const dst=assertWritable(cfg,w,rel);
  if(dryRun) return {path:rel,backupPath:src,restored:false,dryRun:true};
  const currentBackup=fs.existsSync(dst)?await backupPath(dst,rel):null;
  await fsp.mkdir(path.dirname(dst),{recursive:true});
  if(fs.existsSync(dst)) await fsp.rm(dst,{recursive:true,force:true});
  if(st.isDirectory()) await fsp.cp(src,dst,{recursive:true,force:false});
  else await fsp.copyFile(src,dst);
  return {path:rel,backupPath:src,currentBackup,restored:true};
}
async function removePathForRollback(cfg,w,rel,dryRun=false){
  const full=assertWritable(cfg,w,rel);
  if(dryRun) return {path:rel,removed:false,dryRun:true};
  if(!fs.existsSync(full)) return {path:rel,removed:false,reason:'target already absent'};
  const currentBackup=await backupPath(full,rel);
  await fsp.rm(full,{recursive:true,force:true});
  return {path:rel,currentBackup,removed:true};
}
async function rollbackEntry(cfg,entry,dryRun=false){
  const w=getWs(cfg,entry.workspace);
  if(entry.action==='write_file' || entry.action==='apply_patch'){
    return entry.backup ? restoreBackupToPath(cfg,w,entry.backup,entry.path,dryRun) : removePathForRollback(cfg,w,entry.path,dryRun);
  }
  if(entry.action==='create_file'){
    return entry.backup ? restoreBackupToPath(cfg,w,entry.backup,entry.path,dryRun) : removePathForRollback(cfg,w,entry.path,dryRun);
  }
  if(entry.action==='delete_file'){
    return restoreBackupToPath(cfg,w,entry.backup,entry.path,dryRun);
  }
  if(entry.action==='move_file'){
    const results=[];
    if(entry.sourceBackup) results.push(await restoreBackupToPath(cfg,w,entry.sourceBackup,entry.from,dryRun));
    else if(entry.to) results.push(await restoreBackupToPath(cfg,w,entry.to,entry.from,dryRun).catch(()=>({path:entry.from,restored:false,reason:'source backup unavailable'})));
    if(entry.destBackup) results.push(await restoreBackupToPath(cfg,w,entry.destBackup,entry.to,dryRun));
    else if(entry.to) results.push(await removePathForRollback(cfg,w,entry.to,dryRun));
    return {path:entry.from,to:entry.to,results};
  }
  if(entry.action==='restore_backup'){
    return entry.currentBackup ? restoreBackupToPath(cfg,w,entry.currentBackup,entry.targetPath,dryRun) : removePathForRollback(cfg,w,entry.targetPath,dryRun);
  }
  return {action:entry.action,skipped:true,reason:'no safe automatic rollback for this action'};
}

function secondsSinceIso(value){
  if(!value) return null;
  const t = Date.parse(value);
  if(!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 1000));
}
function diagnosticSummary(items=[]){
  const bySeverity = {error:0,warning:0,information:0,hint:0};
  for(const item of items){
    const key = bySeverity[item.severity] == null ? 'information' : item.severity;
    bySeverity[key]++;
  }
  return {total:items.length,bySeverity};
}
async function connectionDiagnosticsData(){
  const cfg=loadConfig();
  const aw=activeWorkspace(cfg);
  const ctx=cfg.vscodeContext || {};
  const contextAgeSeconds=secondsSinceIso(ctx.capturedAt);
  const contextFresh=contextAgeSeconds != null && contextAgeSeconds <= 300;
  const connection=cfg.connection || {};
  const advice=[];
  if(!aw) advice.push('Open a VS Code project folder and run DevMate: Start.');
  if(!ctx.capturedAt) advice.push('No VS Code context snapshot is available yet. Focus VS Code or restart DevMate.');
  else if(!contextFresh) advice.push('VS Code context looks stale. Focus VS Code or run DevMate: Start again.');
  if(!connection.lastPreflightAt) advice.push('No public MCP preflight has been recorded. Run DevMate: Start and paste the verified URL into ChatGPT.');
  if(connection.lastError) advice.push('The last DevMate preflight recorded an error. Run DevMate: Doctor in VS Code.');
  return {
    name:'devmate',
    version:VERSION,
    checkedAt:now(),
    status:advice.length ? 'attention' : 'ready',
    gateway:{
      reachable:true,
      reason:'This MCP tool call reached the DevMate gateway.',
      mcpPath:'/mcp',
      localPort:cfg.server?.port || 8787,
      authRequired:cfg.auth?.required !== false,
      permissionProfile:permissionProfile(cfg),
      blockDangerousOperations:dangerousGuardEnabled(cfg)
    },
    vscode:{
      contextPresent:!!ctx.capturedAt,
      capturedAt:ctx.capturedAt || null,
      contextAgeSeconds,
      fresh:contextFresh,
      activeEditor:ctx.activeEditor ? {
        path:ctx.activeEditor.path,
        languageId:ctx.activeEditor.languageId,
        lineCount:ctx.activeEditor.lineCount,
        isDirty:!!ctx.activeEditor.isDirty
      } : null,
      visibleEditorCount:Array.isArray(ctx.visibleEditors) ? ctx.visibleEditors.length : 0,
      diagnostics:diagnosticSummary(ctx.diagnostics || [])
    },
    workspace:{
      active:aw?wsPublic(aw):null,
      count:cfg.workspaces.length,
      references:cfg.workspaces.filter(w=>w.reference).length
    },
    connection:{
      lastPreflightAt:connection.lastPreflightAt || null,
      lastPreflightAgeSeconds:secondsSinceIso(connection.lastPreflightAt),
      lastCopiedAt:connection.lastCopiedAt || null,
      lastPublicHost:connection.lastPublicHost || '',
      lastMcpPath:connection.lastMcpPath || '/mcp',
      lastToolCount:connection.lastToolCount || null,
      lastServerName:connection.lastServerName || '',
      lastError:connection.lastError ? redactSensitiveString(connection.lastError) : '',
      lastErrorAt:connection.lastErrorAt || null
    },
    maintenance:await stateSummary({backupRoot:BACKUP_ROOT,auditLog:AUDIT_LOG}),
    advice
  };
}
function statusPanelHtml(){
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root{color-scheme:light dark;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    body{margin:0;padding:14px;background:Canvas;color:CanvasText}
    .wrap{max-width:760px;margin:0 auto}
    .top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
    h1{font-size:18px;line-height:1.2;margin:0;font-weight:650}
    button{font:inherit;border:1px solid color-mix(in srgb, CanvasText 22%, transparent);background:ButtonFace;color:ButtonText;border-radius:6px;padding:6px 10px;cursor:pointer}
    .status{display:inline-flex;align-items:center;gap:7px;border-radius:999px;padding:4px 9px;font-size:12px;border:1px solid color-mix(in srgb, CanvasText 16%, transparent)}
    .dot{width:8px;height:8px;border-radius:50%;background:#888}
    .ready .dot{background:#1a7f37}.attention .dot{background:#b54708}.loading .dot{background:#666}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px}
    .card{border:1px solid color-mix(in srgb, CanvasText 14%, transparent);border-radius:8px;padding:10px;background:color-mix(in srgb, Canvas 94%, CanvasText 6%)}
    .label{font-size:11px;text-transform:uppercase;letter-spacing:.04em;opacity:.72;margin-bottom:4px}
    .value{font-size:14px;font-weight:600;overflow-wrap:anywhere}
    .muted{font-size:12px;opacity:.74;margin-top:4px;overflow-wrap:anywhere}
    .advice{margin-top:10px;border-left:3px solid #b54708;padding-left:10px}
    ul{margin:6px 0 0;padding-left:18px}
    li{margin:4px 0}
    pre{white-space:pre-wrap;word-break:break-word;font-size:12px;margin:8px 0 0;opacity:.78}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <h1>DevMate Connection</h1>
        <div class="muted" id="updated">Waiting for diagnostics</div>
      </div>
      <button id="refresh" type="button">Refresh</button>
    </div>
    <div id="root" class="status loading"><span class="dot"></span><span>Loading DevMate status</span></div>
  </div>
  <script>
  (() => {
    const root = document.getElementById('root');
    const updated = document.getElementById('updated');
    const refresh = document.getElementById('refresh');
    const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    const fmtAge = seconds => seconds == null ? 'unknown' : seconds < 60 ? seconds + 's ago' : Math.round(seconds / 60) + 'm ago';
    function unwrap(value) {
      if (!value) return null;
      if (value.structuredContent) return value.structuredContent;
      if (value.result?.structuredContent) return value.result.structuredContent;
      if (value.params?.result?.structuredContent) return value.params.result.structuredContent;
      if (value.content?.[0]?.text) {
        try { return JSON.parse(value.content[0].text); } catch {}
      }
      if (value.result?.content?.[0]?.text) {
        try { return JSON.parse(value.result.content[0].text); } catch {}
      }
      return value.gateway && value.vscode ? value : null;
    }
    function card(label, value, detail) {
      return '<div class="card"><div class="label">' + esc(label) + '</div><div class="value">' + esc(value) + '</div><div class="muted">' + esc(detail) + '</div></div>';
    }
    function render(data) {
      if (!data || !data.gateway) {
        root.className = 'status loading';
        root.innerHTML = '<span class="dot"></span><span>Ask ChatGPT to run devmate_status_panel.</span>';
        return;
      }
      const cls = data.status === 'ready' ? 'ready' : 'attention';
      updated.textContent = 'Checked ' + (data.checkedAt || 'now');
      const diag = data.vscode?.diagnostics || { total: 0, bySeverity: {} };
      const advice = Array.isArray(data.advice) && data.advice.length
        ? '<div class="advice"><strong>Recommended actions</strong><ul>' + data.advice.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul></div>'
        : '';
      root.className = '';
      root.innerHTML =
        '<div class="status ' + cls + '"><span class="dot"></span><span>' + esc(data.status || 'unknown') + '</span></div>' +
        '<div class="grid" style="margin-top:10px">' +
          card('Gateway', data.gateway?.reachable ? 'Reachable' : 'Unknown', 'Port ' + esc(data.gateway?.localPort) + ' ' + esc(data.gateway?.mcpPath)) +
          card('VS Code', data.vscode?.fresh ? 'Fresh context' : 'Check context', 'Captured ' + esc(fmtAge(data.vscode?.contextAgeSeconds))) +
          card('Workspace', data.workspace?.active?.root || 'None', (data.workspace?.count || 0) + ' workspace(s), ' + (data.workspace?.references || 0) + ' reference(s)') +
          card('Permissions', data.gateway?.permissionProfile || 'unknown', data.gateway?.authRequired ? 'token required' : 'auth disabled') +
          card('Diagnostics', String(diag.total || 0), 'errors ' + (diag.bySeverity?.error || 0) + ', warnings ' + (diag.bySeverity?.warning || 0)) +
          card('Last Preflight', data.connection?.lastPreflightAt ? fmtAge(data.connection?.lastPreflightAgeSeconds) : 'Not recorded', data.connection?.lastPublicHost || 'no public host snapshot') +
        '</div>' +
        advice +
        '<pre>' + esc(data.connection?.lastError || '') + '</pre>';
    }
    refresh.addEventListener('click', async () => {
      try {
        if (window.openai?.callTool) {
          render(unwrap(await window.openai.callTool('connection_diagnostics', {})));
        } else {
          render(null);
        }
      } catch (error) {
        root.className = 'status attention';
        root.innerHTML = '<span class="dot"></span><span>' + esc(error?.message || error) + '</span>';
      }
    });
    render(unwrap(window.openai?.toolOutput) || unwrap(window.openai?.toolResult));
    window.addEventListener('message', event => {
      const data = unwrap(event.data);
      if (data?.gateway && data?.vscode) render(data);
    });
  })();
  </script>
</body>
</html>`;
}

function createServer(){
  const server = new McpServer({ name:'devmate', version:VERSION }, { instructions:"DevMate is a personal local development gateway. It supports reading, editing, running commands, and full Git workflows according to the user's request. Keep responses practical and avoid exposing secrets; reference workspaces are read-only." });
  const registerTool = server.registerTool.bind(server);
  server.registerTool = (name, config, handler) => registerTool(name, toolConfig(name, config), handler);
  const S = (shape)=>shape;
  server.registerResource('devmate-status-ui', STATUS_UI_URI, {title:'DevMate status panel',description:'ChatGPT Apps UI for DevMate connection and VS Code diagnostics.',mimeType:APP_RESOURCE_MIME}, async uri => ({
    contents:[{
      uri:uri.href,
      mimeType:APP_RESOURCE_MIME,
      text:statusPanelHtml(),
      _meta:{
        ui:{prefersBorder:true,csp:{connectDomains:[],resourceDomains:[]}},
        'openai/widgetDescription':'Shows DevMate connection status, VS Code context freshness, diagnostics, permissions, and last public MCP preflight.',
        'openai/widgetPrefersBorder':true,
        'openai/widgetCSP':{connect_domains:[],resource_domains:[]}
      }
    }]
  }));
  server.registerTool('gateway_status',{title:'Gateway status',description:'Show gateway runtime and active workspace.',inputSchema:{}},async()=>{ const cfg=loadConfig(); const aw=activeWorkspace(cfg); return toolText({name:'devmate',version:VERSION,mcpPath:'/mcp',permissionProfile:permissionProfile(cfg),blockDangerousOperations:dangerousGuardEnabled(cfg),task:cfg.task || null,activeWorkspace:aw?wsPublic(aw):null,workspaces:cfg.workspaces.map(wsPublic),startedAt:now()}); });
  server.registerTool('gateway_self_test',{title:'Gateway self test',description:'Run basic local checks.',inputSchema:{}},async()=>{ const cfg=loadConfig(); const aw=activeWorkspace(cfg); let git=null; if(aw) git=await runGit(aw,['--version'],2000,5000); return toolText({version:VERSION,configLoaded:true,workspaceCount:cfg.workspaces.length,activeWorkspace:aw?wsPublic(aw):null,git}); });
  server.registerTool('maintenance_status',{title:'Maintenance status',description:'Show backup/audit retention settings and current local state size.',inputSchema:{}},async()=>{ const cfg=loadConfig(); return toolText({retention:cfg.maintenance,storage:await stateSummary({backupRoot:BACKUP_ROOT,auditLog:AUDIT_LOG})}); });
  server.registerTool('connection_diagnostics',{title:'Connection diagnostics',description:'Use this to check whether ChatGPT is currently connected to DevMate, whether VS Code context is fresh, and what may need fixing after switching models or reconnecting.',inputSchema:{},_meta:{ui:{visibility:['model','app']},'openai/widgetAccessible':true}},async()=>toolText(await connectionDiagnosticsData()));
  server.registerTool('devmate_status_panel',{title:'Show DevMate status panel',description:'Use this to render a ChatGPT Apps panel showing DevMate connection, VS Code context, diagnostics, permissions, and last public preflight status.',inputSchema:{},_meta:{ui:{resourceUri:STATUS_UI_URI,visibility:['model','app']},'openai/outputTemplate':STATUS_UI_URI,'openai/widgetAccessible':true,'openai/toolInvocation/invoking':'Checking DevMate','openai/toolInvocation/invoked':'DevMate status ready'}},async()=>{ const diagnostics=await connectionDiagnosticsData(); return {content:[{type:'text',text:`DevMate status: ${diagnostics.status}. VS Code context ${diagnostics.vscode.fresh ? 'fresh' : 'needs attention'}.`}],structuredContent:diagnostics,_meta:{diagnostics}}; });
  server.registerTool('start_task',{title:'Start task session',description:'Start a task session so subsequent writes, commands, and Git mutations share a rollback/report taskId.',inputSchema:{title:z.string().optional()}},async({title=''})=>{ const cfg=loadConfig(); cfg.task={currentTaskId:newTaskId(),title,startedAt:now()}; saveConfig(cfg); await audit('start_task',{taskId:cfg.task.currentTaskId,title}); return toolText({task:cfg.task}); });
  server.registerTool('finish_task',{title:'Finish task session',description:'Finish the current task session and keep audit history available.',inputSchema:{}},async()=>{ const cfg=loadConfig(); const task=cfg.task || null; if(cfg.task) cfg.task.finishedAt=now(); const finished=cfg.task || null; delete cfg.task; saveConfig(cfg); if(finished) await audit('finish_task',{taskId:finished.currentTaskId,title:finished.title,startedAt:finished.startedAt,finishedAt:finished.finishedAt}); return toolText({finished:finished || task}); });
  server.registerTool('task_status',{title:'Task status',description:'Show current task session and recent audit entries for it.',inputSchema:{taskId:z.string().optional(),limit:z.number().int().min(1).max(500).optional()}},async({taskId,limit=100})=>{ const cfg=loadConfig(); const id=taskId || cfg.task?.currentTaskId || null; const entries=(await readAuditEntries(5000)).filter(e=>!id || e.taskId===id).slice(-limit); return toolText({currentTask:cfg.task || null,taskId:id,entries}); });
  server.registerTool('rollback_task',{title:'Rollback task file changes',description:'Rollback file changes from a task session using DevMate backups. Commands and Git history are reported but not automatically reversed.',inputSchema:{taskId:z.string(),dryRun:z.boolean().optional(),limit:z.number().int().min(1).max(1000).optional()}},async({taskId,dryRun=false,limit=1000})=>{ const cfg=loadConfig(); assertCanMutate(cfg,'Rollback'); const entries=(await readAuditEntries(10000)).filter(e=>e.taskId===taskId).slice(-limit); const results=[]; for(const entry of entries.slice().reverse()){ if(['start_task','finish_task','rollback_task'].includes(entry.action)) continue; try{ results.push({entry,rollback:await rollbackEntry(cfg,entry,dryRun)}); }catch(e){ results.push({entry,rollback:{failed:true,error:e.message}}); } } await audit('rollback_task',{taskId,targetTaskId:taskId,dryRun,resultCount:results.length}); return toolText({taskId,dryRun,results}); });
  server.registerTool('list_workspaces',{title:'List workspaces',description:'List active writable and readonly reference workspaces.',inputSchema:{}},async()=>{ const cfg=loadConfig(); return toolText({activeWorkspaceId:cfg.activeWorkspaceId,workspaces:cfg.workspaces.map(wsPublic)}); });
  server.registerTool('vscode_context',{title:'VS Code context',description:'Return the latest VS Code active editor, visible editors, and diagnostics snapshot.',inputSchema:{}},async()=>{ const cfg=loadConfig(); return toolText(cfg.vscodeContext || {activeEditor:null,visibleEditors:[],diagnostics:[]}); });
  server.registerTool('active_editor_context',{title:'Active editor context',description:'Return the latest active VS Code editor and selection snapshot.',inputSchema:{}},async()=>{ const cfg=loadConfig(); return toolText({capturedAt:cfg.vscodeContext?.capturedAt,activeEditor:cfg.vscodeContext?.activeEditor || null}); });
  server.registerTool('list_diagnostics',{title:'List VS Code diagnostics',description:'Return latest VS Code Problems diagnostics, optionally filtered by severity or path.',inputSchema:{severity:z.enum(['error','warning','information','hint']).optional(),path:z.string().optional(),limit:z.number().int().min(1).max(300).optional()}},async({severity,path:pp,limit=100})=>{ const cfg=loadConfig(); let items=cfg.vscodeContext?.diagnostics || []; if(severity) items=items.filter(d=>d.severity===severity); if(pp) items=items.filter(d=>d.path===pp || d.path.endsWith(pp)); return toolText({capturedAt:cfg.vscodeContext?.capturedAt,diagnostics:items.slice(0,limit),total:items.length}); });
  server.registerTool('workspace_map',{title:'Workspace map',description:'Return compact directory map.',inputSchema:{workspaceId:z.string().optional(),depth:z.number().int().min(0).max(6).optional(),maxResults:z.number().int().min(20).max(2000).optional()}},async({workspaceId,depth=2,maxResults=300})=>{ const cfg=loadConfig(); const w=getWs(cfg,workspaceId); const items=[]; await walk(w.root,w.root,depth,maxResults,items); return toolText({workspace:wsPublic(w),depth,items}); });

  server.registerTool('project_snapshot',{title:'Project snapshot',description:'One-call startup context: workspace, compact tree, git status, git diff stat, package scripts, and project instructions when available.',inputSchema:{workspaceId:z.string().optional(),depth:z.number().int().min(0).max(5).optional(),maxResults:z.number().int().min(20).max(1500).optional(),includeScripts:z.boolean().optional(),includeInstructions:z.boolean().optional()}},async({workspaceId,depth=2,maxResults=350,includeScripts=true,includeInstructions=true})=>{ const cfg=loadConfig(); const w=getWs(cfg,workspaceId); const [status,diffStat,tree,scripts,instructions] = await Promise.all([runGit(w,['status','--short','--branch']), runGit(w,['diff','--stat'],20000,30000), compactTree(w,depth,maxResults), includeScripts?readPackageScripts(w,'.'):Promise.resolve(null), includeInstructions?projectInstructionFiles(w,40,40000):Promise.resolve(null)]); return toolText({workspace:wsPublic(w),depth,tree,git:{status,diffStat},package:scripts,instructions}); });
  server.registerTool('project_instructions',{title:'Project instructions',description:'Return root AGENTS.md/CLAUDE.md contents and nested instruction file paths for the active workspace.',inputSchema:{workspaceId:z.string().optional(),maxFiles:z.number().int().min(1).max(200).optional(),maxChars:z.number().int().min(1000).max(200000).optional()}},async({workspaceId,maxFiles=80,maxChars=50000})=>{ const cfg=loadConfig(); const w=getWs(cfg,workspaceId); return toolText({workspace:wsPublic(w),instructions:await projectInstructionFiles(w,maxFiles,maxChars)}); });
  server.registerTool('list_project_scripts',{title:'List project scripts',description:'Read package.json scripts from the workspace or subpath.',inputSchema:{workspaceId:z.string().optional(),subpath:z.string().optional()}},async({workspaceId,subpath='.'})=>{ const cfg=loadConfig(); const w=getWs(cfg,workspaceId); return toolText({workspace:wsPublic(w),...(await readPackageScripts(w,subpath))}); });
  server.registerTool('list_configured_commands',{title:'List configured commands',description:'List trusted commands configured by the VS Code extension.',inputSchema:{}},async()=>{ const cfg=loadConfig(); return toolText({commands:(cfg.commands||[]).map(c=>({key:c.key,label:c.label,readOnly:!!c.readOnly,command:c.command}))}); });
  server.registerTool('detect_validation',{title:'Detect validation checks',description:'Detect the smallest useful validation commands for the active project.',inputSchema:{workspaceId:z.string().optional()}},async({workspaceId})=>{ const cfg=loadConfig(); const w=getWs(cfg,workspaceId); const checks=await validationPlan(w); return toolText({workspace:wsPublic(w),checks}); });

  server.registerTool('list_files',{title:'List files',description:'List safe files/folders under a path.',inputSchema:{workspaceId:z.string().optional(),subpath:z.string().optional(),depth:z.number().int().min(0).max(8).optional(),maxResults:z.number().int().min(1).max(5000).optional()}},async({workspaceId,subpath='.',depth=2,maxResults=500})=>{ const cfg=loadConfig(); const w=getWs(cfg,workspaceId); const root=assertRealInside(w.root,safeResolve(w.root,subpath)); const items=[]; await walk(root,w.root,depth,maxResults,items); return toolText({workspace:wsPublic(w),subpath,items}); });
  server.registerTool('read_file',{title:'Read file',description:'Read a UTF-8 text/code file. Returns sha256.',inputSchema:{workspaceId:z.string().optional(),path:z.string().optional(),filePath:z.string().optional(),startLine:z.number().int().min(1).optional(),endLine:z.number().int().min(1).optional(),maxChars:z.number().int().min(1000).max(500000).optional()}},async({workspaceId,path:pp,filePath,startLine,endLine,maxChars=DEFAULT_MAX_OUTPUT})=>{ const rel=pp||filePath; if(!rel) throw new Error('path is required'); const cfg=loadConfig(); const w=getWs(cfg,workspaceId); const full=assertReadable(w,rel); const st=await fsp.stat(full); if(!st.isFile()) throw new Error('Not a file'); if(st.size>MAX_FILE_BYTES) throw new Error(`File too large: ${st.size} bytes`); let text=await fsp.readFile(full,'utf8'); const fullSha=sha256(text); if(startLine||endLine){ const lines=text.split(/\r?\n/); const s=startLine||1, e=endLine||lines.length; if(s>e) throw new Error('startLine must be <= endLine'); text=lines.slice(s-1,e).join('\n'); } const t=truncate(text,maxChars); return toolText({workspace:wsPublic(w),path:rel,sha256:fullSha,truncated:t.truncated,text:t.text}); });
  server.registerTool('search_text',{title:'Search text',description:'Search text/code files. Literal by default, regex optional.',inputSchema:{workspaceId:z.string().optional(),query:z.string().min(1),subpath:z.string().optional(),maxResults:z.number().int().min(1).max(500).optional(),regex:z.boolean().optional()}},async({workspaceId,query,subpath='.',maxResults=120,regex=false})=>{ const cfg=loadConfig(); const w=getWs(cfg,workspaceId); const root=assertRealInside(w.root,safeResolve(w.root,subpath)); const results=[]; let fallbackRegex=null; if(regex){ try{ fallbackRegex=new RegExp(query); }catch(e){ throw new Error(`Invalid regex: ${e.message}`); } } const rgArgs=['--line-number','--no-heading','--color','never','--glob','!node_modules/**','--glob','!.git/**','--glob','!secrets/**','--glob','!credentials/**']; if(!regex) rgArgs.push('--fixed-strings'); rgArgs.push(query,'.'); const rg=await execProcess('rg',rgArgs,{cwd:root,maxOutputChars:DEFAULT_MAX_OUTPUT,timeoutMs:30000,shell:false}); if(rg.exitCode===0 && rg.stdout){ for(const line of rg.stdout.split(/\r?\n/)){ if(!line) continue; const m=line.match(/^(.*?):(\d+):(.*)$/); if(!m) continue; const rel=normalizeSlash(path.relative(w.root,path.resolve(root,m[1]))); if(isTextAllowed(rel)) results.push({file:rel,line:Number(m[2]),preview:m[3].trim().slice(0,300)}); if(results.length>=maxResults) break; } return toolText({workspace:wsPublic(w),query,engine:'ripgrep',results}); }
    const files=[]; await allFiles(root,w.root,files,10000); const q=query.toLowerCase(); for(const f of files){ if(results.length>=maxResults) break; const st=await fsp.stat(f).catch(()=>null); if(!st||st.size>1024*1024) continue; const text=await fsp.readFile(f,'utf8').catch(()=>null); if(text==null) continue; const lines=text.split(/\r?\n/); for(let i=0;i<lines.length;i++){ const ok=regex ? fallbackRegex.test(lines[i]) : lines[i].toLowerCase().includes(q); if(ok){ results.push({file:normalizeSlash(path.relative(w.root,f)),line:i+1,preview:lines[i].trim().slice(0,300)}); if(results.length>=maxResults) break; } } } return toolText({workspace:wsPublic(w),query,engine:'builtin',results}); });
  server.registerTool('write_file',{title:'Write file',description:'Write or overwrite a text/code file in active workspace. Existing file is backed up.',inputSchema:{workspaceId:z.string().optional(),path:z.string(),content:z.string(),append:z.boolean().optional(),createDirs:z.boolean().optional()}},async({workspaceId,path:rel,content,append=false,createDirs=true})=>{ const cfg=loadConfig(); const w=getWs(cfg,workspaceId); const full=assertWritable(cfg,w,rel); return withLock(full,async()=>{ if(createDirs) await fsp.mkdir(path.dirname(full),{recursive:true}); const backup=await backupPath(full,rel); const before=await fsp.readFile(full,'utf8').catch(()=>null); await fsp.writeFile(full, append ? ((before||'')+content) : content, 'utf8'); await audit('write_file',{workspace:w.id,path:rel,append,backup}); const next=await fsp.readFile(full,'utf8'); return toolText({workspace:wsPublic(w),path:rel,backup,sha256:sha256(next),written:true}); }); });
  server.registerTool('create_file',{title:'Create file',description:'Create a text/code file. Overwrite allowed when requested; existing file is backed up.',inputSchema:{workspaceId:z.string().optional(),path:z.string(),content:z.string(),overwrite:z.boolean().optional(),createDirs:z.boolean().optional()}},async({workspaceId,path:rel,content,overwrite=false,createDirs=true})=>{ const cfg=loadConfig(); const w=getWs(cfg,workspaceId); const full=assertWritable(cfg,w,rel); return withLock(full,async()=>{ if(createDirs) await fsp.mkdir(path.dirname(full),{recursive:true}); const exists=fs.existsSync(full); if(exists && !overwrite) throw new Error('File exists; pass overwrite=true or use write_file/apply_patch'); const backup=exists?await backupPath(full,rel):null; await fsp.writeFile(full,content,'utf8'); await audit('create_file',{workspace:w.id,path:rel,overwrite,backup}); return toolText({workspace:wsPublic(w),path:rel,backup,sha256:sha256(content),created:!exists,overwritten:exists}); }); });
  server.registerTool('apply_patch',{title:'Apply patch',description:'Replace exact oldText with newText. expectedSha256 optional.',inputSchema:{workspaceId:z.string().optional(),path:z.string().optional(),filePath:z.string().optional(),oldText:z.string(),newText:z.string(),expectedSha256:z.string().optional(),allOccurrences:z.boolean().optional()}},async({workspaceId,path:pp,filePath,oldText,newText,expectedSha256,allOccurrences=false})=>{ const rel=pp||filePath; if(!rel) throw new Error('path is required'); const cfg=loadConfig(); const w=getWs(cfg,workspaceId); const full=assertWritable(cfg,w,rel); return withLock(full,async()=>{ const text=await fsp.readFile(full,'utf8'); const beforeSha=sha256(text); if(expectedSha256 && expectedSha256!==beforeSha) throw new Error(`sha256 mismatch: expected ${expectedSha256}, actual ${beforeSha}`); if(!text.includes(oldText)) throw new Error('oldText not found'); if(!allOccurrences && text.indexOf(oldText)!==text.lastIndexOf(oldText)) throw new Error('oldText appears multiple times; set allOccurrences=true or provide more specific oldText'); const backup=await backupPath(full,rel); const next=allOccurrences ? text.split(oldText).join(newText) : text.replace(oldText,newText); await fsp.writeFile(full,next,'utf8'); await audit('apply_patch',{workspace:w.id,path:rel,backup}); return toolText({workspace:wsPublic(w),path:rel,backup,oldSha256:beforeSha,newSha256:sha256(next),changed:true}); }); });
  server.registerTool('delete_file',{title:'Delete file/folder',description:'Delete file or folder in active workspace. Target is backed up first.',inputSchema:{workspaceId:z.string().optional(),path:z.string(),recursive:z.boolean().optional()}},async({workspaceId,path:rel,recursive=false})=>{ const cfg=loadConfig(); const w=getWs(cfg,workspaceId); const full=assertWritable(cfg,w,rel); return withLock(full,async()=>{ const st=await assertDirectoryMutationAllowed(cfg,w,full,rel); if(st.isDirectory() && !recursive) throw new Error('Target is directory; pass recursive=true'); const backup=await backupPath(full,rel); await fsp.rm(full,{recursive:st.isDirectory(),force:false}); await audit('delete_file',{workspace:w.id,path:rel,recursive,backup}); return toolText({workspace:wsPublic(w),path:rel,backup,deleted:true}); }); });
  server.registerTool('move_file',{title:'Move/rename file',description:'Move or rename a file/folder in active workspace. Destination backup when overwritten.',inputSchema:{workspaceId:z.string().optional(),from:z.string(),to:z.string(),overwrite:z.boolean().optional()}},async({workspaceId,from,to,overwrite=false})=>{ const cfg=loadConfig(); const w=getWs(cfg,workspaceId); const src=assertWritable(cfg,w,from); const dst=assertWritable(cfg,w,to); return withLock(src,async()=>withLock(dst,async()=>{ const sourceStat=await assertDirectoryMutationAllowed(cfg,w,src,from); if(fs.existsSync(dst) && !overwrite) throw new Error('Destination exists; pass overwrite=true'); await fsp.mkdir(path.dirname(dst),{recursive:true}); const sourceBackup=await backupPath(src,from); const destBackup=fs.existsSync(dst)?await backupPath(dst,to):null; if(fs.existsSync(dst)) await fsp.rm(dst,{recursive:true,force:true}); await fsp.rename(src,dst); await audit('move_file',{workspace:w.id,from,to,overwrite,sourceIsDirectory:sourceStat.isDirectory(),sourceBackup,destBackup}); return toolText({workspace:wsPublic(w),from,to,sourceBackup,destBackup,moved:true}); })); });
  server.registerTool('run_command',{title:'Run command',description:'Run an arbitrary shell command in active workspace or subdirectory.',inputSchema:{workspaceId:z.string().optional(),command:z.string().min(1),cwd:z.string().optional(),timeoutMs:z.number().int().min(1000).max(1800000).optional(),maxOutputChars:z.number().int().min(1000).max(500000).optional()}},async({workspaceId,command,cwd='.',timeoutMs,maxOutputChars})=>{ const cfg=loadConfig(); const w=getWs(cfg,workspaceId); if(w.reference) throw new Error('Cannot run commands in reference workspace'); assertCommandAllowed(cfg,command); const dir=assertCwd(w,cwd); const limits=commandLimits(cfg,timeoutMs,maxOutputChars); const r=await execProcess(command,[],{cwd:dir,...limits,shell:true}); await audit('run_command',{workspace:w.id,command,cwd,exitCode:r.exitCode,timedOut:r.timedOut}); return toolText({workspace:wsPublic(w),...r}); });
  server.registerTool('run_configured_command',{title:'Run configured command',description:'Run a trusted command from the DevMate configuration by key.',inputSchema:{workspaceId:z.string().optional(),key:z.string().min(1),cwd:z.string().optional(),timeoutMs:z.number().int().min(1000).max(1800000).optional(),maxOutputChars:z.number().int().min(1000).max(500000).optional()}},async({workspaceId,key,cwd='.',timeoutMs,maxOutputChars})=>{ const cfg=loadConfig(); const w=getWs(cfg,workspaceId); if(w.reference) throw new Error('Cannot run commands in reference workspace'); const item=(cfg.commands||[]).find(c=>c.key===key); if(!item) throw new Error(`Configured command not found: ${key}`); assertCommandAllowed(cfg,item.command); const dir=assertCwd(w,cwd); const limits=commandLimits(cfg,timeoutMs,maxOutputChars); const r=await execProcess(item.command,[],{cwd:dir,...limits,shell:true}); await audit('run_configured_command',{workspace:w.id,key,command:item.command,cwd,exitCode:r.exitCode,timedOut:r.timedOut}); return toolText({workspace:wsPublic(w),key,label:item.label,readOnly:!!item.readOnly,...r}); });

  server.registerTool('run_project_script',{title:'Run project script',description:'Run a package.json script using pnpm/npm/yarn/bun detection. Useful for common validation commands.',inputSchema:{workspaceId:z.string().optional(),script:z.string().min(1),subpath:z.string().optional(),packageManager:z.enum(['auto','pnpm','npm','yarn','bun']).optional(),timeoutMs:z.number().int().min(1000).max(1800000).optional(),maxOutputChars:z.number().int().min(1000).max(500000).optional()}},async({workspaceId,script,subpath='.',packageManager='auto',timeoutMs,maxOutputChars})=>{ const cfg=loadConfig(); const w=getWs(cfg,workspaceId); if(w.reference) throw new Error('Cannot run scripts in reference workspace'); const dir=assertCwd(w,subpath); const scripts=await readPackageScripts(w,subpath); if(!scripts.scripts || !Object.prototype.hasOwnProperty.call(scripts.scripts,script)) throw new Error(`Script not found in ${scripts.path}: ${script}`); let pm=packageManager; if(pm==='auto'){ if(fs.existsSync(path.join(dir,'pnpm-lock.yaml'))) pm='pnpm'; else if(fs.existsSync(path.join(dir,'yarn.lock'))) pm='yarn'; else if(fs.existsSync(path.join(dir,'bun.lockb'))) pm='bun'; else pm='npm'; } const command = pm==='npm' ? `npm run ${script}` : `${pm} ${script}`; assertCommandAllowed(cfg,command); const limits=commandLimits(cfg,timeoutMs,maxOutputChars); const r=await execProcess(command,[],{cwd:dir,...limits,shell:true}); await audit('run_project_script',{workspace:w.id,script,subpath,packageManager:pm,exitCode:r.exitCode,timedOut:r.timedOut}); return toolText({workspace:wsPublic(w),package:scripts.path,script,packageManager:pm,...r}); });
  server.registerTool('run_smart_checks',{title:'Run smart validation checks',description:'Run the detected validation checks, starting with the smallest useful commands.',inputSchema:{workspaceId:z.string().optional(),maxChecks:z.number().int().min(1).max(5).optional(),timeoutMs:z.number().int().min(1000).max(1800000).optional(),maxOutputChars:z.number().int().min(1000).max(500000).optional()}},async({workspaceId,maxChecks=2,timeoutMs,maxOutputChars})=>{ const cfg=loadConfig(); const w=getWs(cfg,workspaceId); if(w.reference) throw new Error('Cannot run checks in reference workspace'); const checks=(await validationPlan(w)).slice(0,maxChecks); const limits=commandLimits(cfg,timeoutMs,maxOutputChars); const results=[]; for(const check of checks){ assertCommandAllowed(cfg,check.command); const r=await execProcess(check.command,[],{cwd:assertCwd(w,check.cwd),...limits,shell:true}); await audit('run_smart_checks',{workspace:w.id,key:check.key,command:check.command,exitCode:r.exitCode,timedOut:r.timedOut}); results.push({...check,result:r}); if(r.exitCode!==0 || r.timedOut) break; } return toolText({workspace:wsPublic(w),checks,results}); });

  server.registerTool('git_status',{title:'Git status',description:'Run git status.',inputSchema:{workspaceId:z.string().optional(),porcelain:z.boolean().optional()}},async({workspaceId,porcelain=false})=>{ const cfg=loadConfig(); const w=getWs(cfg,workspaceId); const args=porcelain?['status','--porcelain=v1','--branch']:['status','--short','--branch']; return toolText({workspace:wsPublic(w),...(await runGit(w,args))}); });
  server.registerTool('git_diff',{title:'Git diff',description:'Run git diff.',inputSchema:{workspaceId:z.string().optional(),staged:z.boolean().optional(),paths:z.array(z.string()).optional(),maxOutputChars:z.number().int().min(1000).max(500000).optional()}},async({workspaceId,staged=false,paths=[],maxOutputChars=DEFAULT_MAX_OUTPUT})=>{ const cfg=loadConfig(); const w=getWs(cfg,workspaceId); const args=['diff']; if(staged) args.push('--staged'); const rels=getGitPaths(w,paths); if(rels.length) args.push('--',...rels); return toolText({workspace:wsPublic(w),...(await runGit(w,args,maxOutputChars))}); });
  server.registerTool('git_add',{title:'Git add',description:'Stage paths. Omit paths for git add -A.',inputSchema:{workspaceId:z.string().optional(),paths:z.array(z.string()).optional()}},async({workspaceId,paths=[]})=>{ const cfg=loadConfig(); const w=getWs(cfg,workspaceId); if(w.reference) throw new Error('Cannot stage reference workspace'); assertGitAllowed(cfg,['add'],'Git stage'); const args=['add']; const rels=getGitPaths(w,paths); if(rels.length) args.push('--',...rels); else args.push('-A'); const r=await runGit(w,args); await audit('git_add',{workspace:w.id,paths:rels.length?rels:['-A'],exitCode:r.exitCode}); const status=await runGit(w,['status','--short','--branch']); return toolText({workspace:wsPublic(w),stage: r, status}); });
  server.registerTool('git_stage',{title:'Git stage',description:'Alias of git_add.',inputSchema:{workspaceId:z.string().optional(),paths:z.array(z.string()).optional()}},async(args)=>{ const cfg=loadConfig(); const w=getWs(cfg,args.workspaceId); if(w.reference) throw new Error('Cannot stage reference workspace'); assertGitAllowed(cfg,['add'],'Git stage'); const rels=getGitPaths(w,args.paths||[]); const r=await runGit(w, rels.length?['add','--',...rels]:['add','-A']); await audit('git_stage',{workspace:w.id,paths:rels.length?rels:['-A'],exitCode:r.exitCode}); const status=await runGit(w,['status','--short','--branch']); return toolText({workspace:wsPublic(w),stage:r,status}); });
  server.registerTool('git_staged_files',{title:'Git staged files',description:'List staged files.',inputSchema:{workspaceId:z.string().optional()}},async({workspaceId})=>{ const cfg=loadConfig(); const w=getWs(cfg,workspaceId); return toolText({workspace:wsPublic(w),...(await runGit(w,['diff','--staged','--name-status']))}); });
  server.registerTool('git_commit',{title:'Git commit',description:'Create a git commit. Optionally stage all first.',inputSchema:{workspaceId:z.string().optional(),message:z.string().min(1),all:z.boolean().optional(),allowEmpty:z.boolean().optional()}},async({workspaceId,message,all=false,allowEmpty=false})=>{ const cfg=loadConfig(); const w=getWs(cfg,workspaceId); if(w.reference) throw new Error('Cannot commit reference workspace'); assertGitAllowed(cfg,['commit'],'Git commit'); const stage = all ? await runGit(w,['add','-A']) : null; const args=['commit','-m',message]; if(allowEmpty) args.push('--allow-empty'); const commit=await runGit(w,args,DEFAULT_MAX_OUTPUT,DEFAULT_TIMEOUT_MS); await audit('git_commit',{workspace:w.id,message,all,allowEmpty,exitCode:commit.exitCode}); const status=await runGit(w,['status','--short','--branch']); return toolText({workspace:wsPublic(w),stage,commit,status}); });

  server.registerTool('git_save',{title:'Git save',description:'Convenience workflow: stage paths or all, commit, and optionally push.',inputSchema:{workspaceId:z.string().optional(),message:z.string().min(1),paths:z.array(z.string()).optional(),all:z.boolean().optional(),push:z.boolean().optional(),remote:z.string().optional(),branch:z.string().optional()}},async({workspaceId,message,paths=[],all=true,push=false,remote,branch})=>{ const cfg=loadConfig(); const w=getWs(cfg,workspaceId); if(w.reference) throw new Error('Cannot save reference workspace'); assertGitAllowed(cfg,push?['push']:['commit'],'Git save'); const rels=getGitPaths(w,paths||[]); const stageArgs=rels.length?['add','--',...rels]:(all?['add','-A']:null); const stage=stageArgs?await runGit(w,stageArgs):null; const commit=await runGit(w,['commit','-m',message],DEFAULT_MAX_OUTPUT,DEFAULT_TIMEOUT_MS); let pushed=null; if(push && commit.exitCode===0){ const args=['push']; if(remote) args.push(remote); if(branch) args.push(branch); pushed=await runGit(w,args,DEFAULT_MAX_OUTPUT,DEFAULT_TIMEOUT_MS); } const status=await runGit(w,['status','--short','--branch']); await audit('git_save',{workspace:w.id,message,paths:rels,all,push,commitExitCode:commit.exitCode,pushExitCode:pushed?.exitCode}); return toolText({workspace:wsPublic(w),stage,commit,push:pushed,status}); });

  server.registerTool('git_push',{title:'Git push',description:'Push current branch or specified remote/branch.',inputSchema:{workspaceId:z.string().optional(),remote:z.string().optional(),branch:z.string().optional(),setUpstream:z.boolean().optional(),force:z.boolean().optional(),forceWithLease:z.boolean().optional()}},async({workspaceId,remote,branch,setUpstream=false,force=false,forceWithLease=false})=>{ const cfg=loadConfig(); const w=getWs(cfg,workspaceId); if(w.reference) throw new Error('Cannot push reference workspace'); const args=['push']; if(setUpstream) args.push('-u'); if(forceWithLease) args.push('--force-with-lease'); else if(force) args.push('--force'); if(remote) args.push(remote); if(branch) args.push(branch); assertGitAllowed(cfg,args,'Git push'); const r=await runGit(w,args,DEFAULT_MAX_OUTPUT,DEFAULT_TIMEOUT_MS); await audit('git_push',{workspace:w.id,args,exitCode:r.exitCode}); return toolText({workspace:wsPublic(w),...r}); });
  server.registerTool('git_pull',{title:'Git pull',description:'Run git pull.',inputSchema:{workspaceId:z.string().optional(),remote:z.string().optional(),branch:z.string().optional(),rebase:z.boolean().optional()}},async({workspaceId,remote,branch,rebase=false})=>{ const cfg=loadConfig(); const w=getWs(cfg,workspaceId); if(w.reference) throw new Error('Cannot pull reference workspace'); const args=['pull']; if(rebase) args.push('--rebase'); if(remote) args.push(remote); if(branch) args.push(branch); assertGitAllowed(cfg,args,'Git pull'); const r=await runGit(w,args,DEFAULT_MAX_OUTPUT,DEFAULT_TIMEOUT_MS); await audit('git_pull',{workspace:w.id,args,exitCode:r.exitCode}); return toolText({workspace:wsPublic(w),...r}); });
  server.registerTool('git_branch',{title:'Git branch',description:'List/create/delete branches.',inputSchema:{workspaceId:z.string().optional(),action:z.enum(['list','current','create','delete']).optional(),name:z.string().optional(),force:z.boolean().optional()}},async({workspaceId,action='list',name,force=false})=>{ const cfg=loadConfig(); const w=getWs(cfg,workspaceId); if(w.reference && (action==='create' || action==='delete')) throw new Error('Cannot modify branches in reference workspace'); let args=['branch']; if(action==='current') args=['branch','--show-current']; else if(action==='create'){ assertGitAllowed(cfg,['branch'], 'Git branch create'); if(!name) throw new Error('name required'); args=['branch',name]; } else if(action==='delete'){ assertGitAllowed(cfg,['branch'], 'Git branch delete'); if(!name) throw new Error('name required'); args=['branch',force?'-D':'-d',name]; } const r=await runGit(w,args); await audit('git_branch',{workspace:w.id,action,name,exitCode:r.exitCode}); return toolText({workspace:wsPublic(w),...r}); });
  server.registerTool('git_checkout',{title:'Git switch/checkout',description:'Switch branch using git switch. create=true creates branch.',inputSchema:{workspaceId:z.string().optional(),branch:z.string(),create:z.boolean().optional()}},async({workspaceId,branch,create=false})=>{ const cfg=loadConfig(); const w=getWs(cfg,workspaceId); if(w.reference) throw new Error('Cannot switch reference workspace'); const args=create?['switch','-c',branch]:['switch',branch]; assertGitAllowed(cfg,args,'Git switch'); const r=await runGit(w,args); await audit('git_checkout',{workspace:w.id,branch,create,exitCode:r.exitCode}); return toolText({workspace:wsPublic(w),...r}); });
  server.registerTool('git_log',{title:'Git log',description:'Show recent log.',inputSchema:{workspaceId:z.string().optional(),limit:z.number().int().min(1).max(200).optional(),oneline:z.boolean().optional()}},async({workspaceId,limit=20,oneline=true})=>{ const cfg=loadConfig(); const w=getWs(cfg,workspaceId); const args=['log',`-${limit}`]; if(oneline) args.push('--oneline','--decorate'); return toolText({workspace:wsPublic(w),...(await runGit(w,args))}); });
  server.registerTool('git_blame',{title:'Git blame',description:'Run git blame for a file.',inputSchema:{workspaceId:z.string().optional(),path:z.string(),startLine:z.number().int().min(1).optional(),endLine:z.number().int().min(1).optional(),maxOutputChars:z.number().int().min(1000).max(500000).optional()}},async({workspaceId,path:rel,startLine,endLine,maxOutputChars=DEFAULT_MAX_OUTPUT})=>{ const cfg=loadConfig(); const w=getWs(cfg,workspaceId); const gr=gitRel(w,rel); const args=['blame']; if(startLine||endLine){ if(startLine&&endLine&&startLine>endLine) throw new Error('startLine must be <= endLine'); args.push(`-L`, `${startLine||1},${endLine||''}`); } args.push('--',gr); return toolText({workspace:wsPublic(w),...(await runGit(w,args,maxOutputChars))}); });
  server.registerTool('git_stash',{title:'Git stash',description:'Run git stash actions.',inputSchema:{workspaceId:z.string().optional(),action:z.enum(['push','pop','list','apply','drop']).optional(),message:z.string().optional(),includeUntracked:z.boolean().optional()}},async({workspaceId,action='list',message,includeUntracked=false})=>{ const cfg=loadConfig(); const w=getWs(cfg,workspaceId); if(w.reference && action!=='list') throw new Error('Cannot modify reference workspace'); if(action!=='list') assertGitAllowed(cfg,['stash',action],'Git stash'); let args=['stash']; if(action==='push'){ args.push('push'); if(includeUntracked) args.push('-u'); if(message) args.push('-m',message); } else args.push(action); const r=await runGit(w,args,DEFAULT_MAX_OUTPUT,DEFAULT_TIMEOUT_MS); await audit('git_stash',{workspace:w.id,action,exitCode:r.exitCode}); return toolText({workspace:wsPublic(w),...r}); });
  server.registerTool('git_raw',{title:'Git raw',description:'Run arbitrary git args in active workspace, e.g. ["status", "--short"].',inputSchema:{workspaceId:z.string().optional(),args:z.array(z.string()).min(1),maxOutputChars:z.number().int().min(1000).max(500000).optional(),timeoutMs:z.number().int().min(1000).max(1800000).optional()}},async({workspaceId,args,maxOutputChars,timeoutMs})=>{ const cfg=loadConfig(); const w=getWs(cfg,workspaceId); if(w.reference) throw new Error('Cannot run git_raw in reference workspace'); assertGitAllowed(cfg,args,'Git raw'); const limits=commandLimits(cfg,timeoutMs,maxOutputChars); const r=await runGit(w,args,limits.maxOutputChars,limits.timeoutMs); await audit('git_raw',{workspace:w.id,args,exitCode:r.exitCode}); return toolText({workspace:wsPublic(w),...r}); });

  server.registerTool('show_changes',{title:'Show changes',description:'Summarize current Git changes with status, diff stat, file totals, and a bounded patch for review.',inputSchema:{workspaceId:z.string().optional(),staged:z.boolean().optional(),maxOutputChars:z.number().int().min(1000).max(300000).optional()}},async({workspaceId,staged=false,maxOutputChars=80000})=>{ const cfg=loadConfig(); const w=getWs(cfg,workspaceId); return toolText(await gitChangeReview(w,staged,maxOutputChars)); });

  server.registerTool('task_report',{title:'Task report',description:'Summarize current Git status, unstaged/staged diffs, and recent audit entries after a task.',inputSchema:{workspaceId:z.string().optional(),diffChars:z.number().int().min(1000).max(300000).optional(),auditLimit:z.number().int().min(1).max(200).optional()}},async({workspaceId,diffChars=80000,auditLimit=50})=>{ const cfg=loadConfig(); const w=getWs(cfg,workspaceId); const [status,diff,staged,stagedFiles,recentAudit] = await Promise.all([runGit(w,['status','--short','--branch']),runGit(w,['diff'],diffChars),runGit(w,['diff','--staged'],diffChars),runGit(w,['diff','--staged','--name-status'],20000),readAuditEntries(auditLimit)]); return toolText({workspace:wsPublic(w),status,diff,staged,stagedFiles,recentAudit}); });

  server.registerTool('list_backups',{title:'List backups',description:'List recent automatic backups.',inputSchema:{limit:z.number().int().min(1).max(500).optional()}},async({limit=80})=>{ const items=[]; async function scan(dir){ let entries=[]; try{entries=await fsp.readdir(dir,{withFileTypes:true});}catch{return;} for(const e of entries){ const full=path.join(dir,e.name); if(e.isDirectory()) await scan(full); else { const st=await fsp.stat(full); items.push({path:full,time:st.mtime.toISOString(),size:st.size}); } } } await scan(BACKUP_ROOT); items.sort((a,b)=>b.time.localeCompare(a.time)); return toolText({backups:items.slice(0,limit)}); });
  server.registerTool('restore_backup',{title:'Restore backup',description:'Restore a single file from a DevMate automatic backup. Current target is backed up first.',inputSchema:{workspaceId:z.string().optional(),backupPath:z.string(),targetPath:z.string().optional(),overwrite:z.boolean().optional()}},async({workspaceId,backupPath:bp,targetPath,overwrite=true})=>{ const cfg=loadConfig(); const w=getWs(cfg,workspaceId); const backupFull=assertRealInside(BACKUP_ROOT,path.resolve(bp)); const st=await fsp.stat(backupFull); if(!st.isFile()) throw new Error('Only single-file backup restore is supported'); const rel=targetPath || backupRelativePath(backupFull); const dst=assertWritable(cfg,w,rel); return withLock(dst,async()=>{ if(fs.existsSync(dst) && !overwrite) throw new Error('Target exists; pass overwrite=true to restore over it'); await fsp.mkdir(path.dirname(dst),{recursive:true}); const currentBackup=fs.existsSync(dst)?await backupPath(dst,rel):null; await fsp.copyFile(backupFull,dst); const text=await fsp.readFile(dst,'utf8').catch(()=>null); await audit('restore_backup',{workspace:w.id,backupPath:backupFull,targetPath:rel,currentBackup}); return toolText({workspace:wsPublic(w),backupPath:backupFull,targetPath:rel,currentBackup,sha256:text==null?null:sha256(text),restored:true}); }); });
  server.registerTool('read_audit_log',{title:'Read audit log',description:'Read recent mutation/command audit entries.',inputSchema:{limit:z.number().int().min(1).max(1000).optional()}},async({limit=200})=>{ return toolText({entries:await readAuditEntries(limit)}); });
  return server;
}

const config = loadConfig();
try {
  const maintenance = await pruneState({stateRoot:STATE_ROOT,backupRoot:BACKUP_ROOT,auditLog:AUDIT_LOG}, config.maintenance);
  const deletedBackups = maintenance.backups.deleted.length;
  if (deletedBackups || maintenance.audit.removedEntries) {
    console.log(`Maintenance pruned backups=${deletedBackups} auditEntries=${maintenance.audit.removedEntries}`);
  }
} catch (e) {
  console.error(`Maintenance failed: ${e.message || e}`);
}
const httpServer = http.createServer(async (req,res)=>{
  let url;
  try { url = new URL(req.url || '/', 'http://localhost'); }
  catch {
    res.writeHead(400,{'content-type':'application/json'});
    res.end(JSON.stringify({error:'bad request url'}));
    return;
  }
  if(req.method === 'OPTIONS') { res.writeHead(204, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,GET,DELETE,OPTIONS','Access-Control-Allow-Headers':'content-type,mcp-session-id,authorization,x-devmate-token','Access-Control-Expose-Headers':'Mcp-Session-Id'}); res.end(); return; }
  if(req.method === 'GET' && url.pathname==='/control/health') { const addr = req.socket.remoteAddress || ''; const local = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'; if(!local){ res.writeHead(403,{'content-type':'application/json'}); res.end(JSON.stringify({error:'local control endpoint only'})); return; } res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({name:'devmate',version:VERSION,status:'ok',mcpPath:'/mcp',instanceId:config.instanceId,port:config.server.port,configPath:CONFIG_PATH,stateRoot:STATE_ROOT})); return; }
  if(req.method === 'GET' && (url.pathname==='/' || url.pathname==='/health')) { res.writeHead(200,{'content-type':'application/json'}); const base={name:'devmate',version:VERSION,status:'ok',mcpPath:'/mcp'}; const full={...base,instanceId:config.instanceId,port:config.server.port}; res.end(JSON.stringify(PUBLIC_HEALTH_DETAILS?full:base)); return; }
  if(url.pathname === '/mcp'){
    const requestConfig = loadConfig();
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Access-Control-Expose-Headers','Mcp-Session-Id');
    if(!isAuthorized(req,url,requestConfig)){
      res.writeHead(401,{'content-type':'application/json','WWW-Authenticate':'Bearer realm="DevMate MCP"'});
      res.end(JSON.stringify({error:'unauthorized'}));
      return;
    }
    const mcp = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); mcp.close(); });
    try { await mcp.connect(transport); await transport.handleRequest(req,res); }
    catch(e){ console.error(e); if(!res.headersSent) { res.writeHead(500,{'content-type':'application/json'}); res.end(JSON.stringify({error:String(e.message||e)})); } }
    return;
  }
  res.writeHead(404,{'content-type':'text/plain'}); res.end('Not Found');
});
httpServer.listen(config.server.port,'127.0.0.1',()=>{ console.log(`DevMate ${VERSION} listening on http://127.0.0.1:${config.server.port}/mcp`); console.log(`Config: ${CONFIG_PATH}`); });
