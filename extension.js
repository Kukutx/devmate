const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const VERSION = '1.14.0';
const BASE_PORT = 8787;
const MCP_PATH = '/mcp';
let gatewayProcess = null;
let ngrokProcess = null;
let output = null;
let statusBar = null;
let panel = null;
let lastPublicUrl = '';
let selectedPort = BASE_PORT;
let globalContext = null;
let startCommandProcess = null;
let contextWriteTimer = null;

function cfg(){ return vscode.workspace.getConfiguration('devMate'); }
function configuredPort(){ return Number(cfg().get('port') || BASE_PORT); }
function ngrokCommand(){ return cfg().get('ngrokCommandPath') || 'ngrok'; }
function log(s){ if(output) output.appendLine(`[${new Date().toLocaleTimeString()}] ${s}`); }
function ensureDir(p){ fs.mkdirSync(p,{recursive:true}); }
function configPath(ctx){ return path.join(ctx.globalStorageUri.fsPath,'config.json'); }
function gatewayPath(ctx){
  const bundled = path.join(ctx.extensionPath,'gateway','server.bundle.mjs');
  return fs.existsSync(bundled) ? bundled : path.join(ctx.extensionPath,'gateway','server.mjs');
}
function esc(v){ return String(v ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch])); }
function currentRoot(){ return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || ''; }
function readJson(p){ try { return JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,'')); } catch { return null; } }
function writeJson(p,data){ ensureDir(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(data,null,2)+'\n','utf8'); }
function makeId(root){ return path.basename(root).replace(/[^a-zA-Z0-9_-]+/g,'-').toLowerCase() || 'workspace'; }
function pathKey(p){ const resolved = path.resolve(p); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; }
function samePath(a,b){ return !!a && !!b && pathKey(a) === pathKey(b); }
function uniqueWorkspaceId(workspaces, base, currentId=''){
  const cleanBase = String(base || 'workspace').replace(/[^a-zA-Z0-9_-]+/g,'-').toLowerCase() || 'workspace';
  if(currentId && !workspaces.some(w => w.id === currentId)) return currentId;
  let id = cleanBase;
  let n = 2;
  while(workspaces.some(w => w.id === id && id !== currentId)) id = `${cleanBase}-${n++}`;
  return id;
}
function normalizeWorkspaceRoles(data){
  data.workspaces ||= [];
  for(const w of data.workspaces){
    if(w.reference){
      w.mode = 'readonly';
      w.role = 'reference';
    } else if(w.id === data.activeWorkspaceId){
      w.mode = 'workspace-write';
      w.role = 'active';
    } else {
      w.mode ||= 'workspace-write';
      w.role = 'workspace';
      w.reference = false;
    }
  }
}
function syncCurrentWorkspace(data, root){
  const references = (data.workspaces || []).filter(w => w.reference && !samePath(w.root, root));
  const existing = (data.workspaces || []).find(w => !w.reference && samePath(w.root, root));
  let id = existing?.id || makeId(root);
  if(references.some(w => w.id === id)) id = uniqueWorkspaceId(references, makeId(root));
  data.activeWorkspaceId = id;
  data.workspaces = [
    { id, name:path.basename(root), root, mode:'workspace-write', reference:false, role:'active' },
    ...references
  ];
}
function newAuthToken(){ return crypto.randomBytes(32).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function nonce(){ return crypto.randomBytes(16).toString('base64'); }
function authRequired(){ return cfg().get('requireAuthToken') !== false; }
function permissionProfile(){ const v = cfg().get('permissionProfile'); return ['readOnly','balanced','fullAccess'].includes(v) ? v : 'fullAccess'; }
function maintenanceConfig(){
  return {
    backupRetentionDays: Number(cfg().get('backupRetentionDays') || 30),
    auditRetentionDays: Number(cfg().get('auditRetentionDays') || 30),
    maxBackupBytes: Number(cfg().get('maxBackupBytes') || 268435456),
    maxAuditBytes: Number(cfg().get('maxAuditBytes') || 5242880)
  };
}
function relToRoot(fsPath){
  const root = currentRoot();
  if(!root || !fsPath) return '';
  const rel = path.relative(root, fsPath);
  if(rel.startsWith('..') || path.isAbsolute(rel)) return '';
  return rel.replace(/\\/g,'/');
}
function isProtectedName(filePath){
  const base = path.basename(filePath || '').toLowerCase();
  const parts = String(filePath || '').split(/[\\/]+/).map(x=>x.toLowerCase());
  if(parts.some(x=>['.git','node_modules','secrets','secret','credentials','credential','private-key','private_keys','service-account','service_accounts'].includes(x))) return true;
  if(base === '.env' || base.startsWith('.env.') || base === 'env.local' || base.endsWith('.env')) return !(base.endsWith('.env.example') || base.endsWith('.env.sample'));
  return ['.pem','.key','.pfx','.p12','.db','.sqlite','.sqlite3','.log'].includes(path.extname(base));
}
function rangePublic(range){
  return {
    start: { line: range.start.line + 1, character: range.start.character + 1 },
    end: { line: range.end.line + 1, character: range.end.character + 1 }
  };
}
function collectVsCodeContext(){
  const root = currentRoot();
  const editor = vscode.window.activeTextEditor;
  let active = null;
  if(editor){
    const rel = relToRoot(editor.document.uri.fsPath);
    active = {
      path: rel || editor.document.uri.toString(),
      languageId: editor.document.languageId,
      lineCount: editor.document.lineCount,
      isDirty: editor.document.isDirty,
      selection: rangePublic(editor.selection),
      selectedText: (rel && !isProtectedName(editor.document.uri.fsPath) && !editor.selection.isEmpty) ? editor.document.getText(editor.selection).slice(0,20000) : ''
    };
  }
  const visibleEditors = vscode.window.visibleTextEditors.map(e=>({
    path: relToRoot(e.document.uri.fsPath) || e.document.uri.toString(),
    languageId: e.document.languageId,
    isDirty: e.document.isDirty,
    selection: rangePublic(e.selection)
  })).slice(0,20);
  const diagnostics = [];
  if(root){
    for(const [uri, items] of vscode.languages.getDiagnostics()){
      const rel = relToRoot(uri.fsPath);
      if(!rel || isProtectedName(uri.fsPath)) continue;
      for(const d of items.slice(0,50)){
        diagnostics.push({
          path: rel,
          severity: ['error','warning','information','hint'][d.severity] || String(d.severity),
          message: String(d.message || '').slice(0,1000),
          source: d.source || '',
          code: d.code == null ? '' : String(typeof d.code === 'object' ? d.code.value : d.code),
          range: rangePublic(d.range)
        });
        if(diagnostics.length >= 300) break;
      }
      if(diagnostics.length >= 300) break;
    }
  }
  return {
    capturedAt: new Date().toISOString(),
    workspaceRoot: root,
    activeEditor: active,
    visibleEditors,
    diagnostics
  };
}
function redactUrl(url){
  try {
    const u = new URL(url);
    if(u.searchParams.has('token')) u.searchParams.set('token','redacted');
    return u.toString();
  } catch {
    return String(url || '').replace(/([?&]token=)[^&\s]+/g,'$1redacted');
  }
}
function publicHost(url){
  try { return new URL(url).host; } catch { return ''; }
}
function updateConnectionSnapshot(ctx, patch){
  if(!ctx) return;
  const data = ensureConfig(ctx,false);
  const cleanPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  data.connection = { ...(data.connection || {}), ...cleanPatch };
  writeJson(configPath(ctx), data);
  refreshPanel();
}
function mcpUrlFor(baseUrl, ctx){
  const data = ctx ? ensureConfig(ctx,false) : null;
  const u = new URL(`${String(baseUrl).replace(/\/$/,'')}${MCP_PATH}`);
  if(authRequired() && data?.auth?.token) u.searchParams.set('token', data.auth.token);
  return u.toString();
}

function defaultConfig(ctx){
  const root = currentRoot();
  return {
    version: 9,
    appVersion: VERSION,
    instanceId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`,
    server: { port: configuredPort(), mcpPath: MCP_PATH },
    runtime: { defaultCommandTimeoutMs: Number(cfg().get('defaultCommandTimeoutMs') || 180000), maxOutputChars: Number(cfg().get('maxOutputChars') || 120000) },
    maintenance: maintenanceConfig(),
    connection: {},
    vscodeContext: collectVsCodeContext(),
    auth: { required: authRequired(), token: newAuthToken() },
    permissions: {
      profile: permissionProfile(),
      readOnly: permissionProfile() === 'readOnly',
      blockDangerousOperations: permissionProfile() !== 'fullAccess' && cfg().get('blockDangerousOperations') !== false,
      confirmBeforePush: !!cfg().get('confirmBeforePush'),
      allowDirectoryMutations: !!cfg().get('allowDirectoryMutations')
    },
    activeWorkspaceId: root ? makeId(root) : '',
    workspaces: root ? [{ id: makeId(root), name: path.basename(root), root, mode: 'workspace-write', reference: false, role: 'active' }] : [],
    commands: [
      { key: 'pnpm-lint', label: 'pnpm lint', command: 'pnpm lint', readOnly: true },
      { key: 'pnpm-test', label: 'pnpm test', command: 'pnpm test', readOnly: true },
      { key: 'dotnet-build-api', label: 'dotnet build backend/api', command: 'cd backend/api && dotnet build', readOnly: true },
      { key: 'flutter-analyze', label: 'flutter analyze app', command: 'cd frontend/app && flutter analyze', readOnly: true }
    ]
  };
}
function ensureConfig(ctx, forceCurrent=false, portOverride=null){
  const p = configPath(ctx);
  let data = readJson(p) || defaultConfig(ctx);
  data.version = 9;
  data.appVersion = VERSION;
  data.instanceId ||= `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
  data.server ||= {};
  data.server.port = Number(portOverride || data.server.port || configuredPort() || BASE_PORT);
  data.server.mcpPath = MCP_PATH;
  data.runtime ||= {};
  data.runtime.defaultCommandTimeoutMs = Number(cfg().get('defaultCommandTimeoutMs') || 180000);
  data.runtime.maxOutputChars = Number(cfg().get('maxOutputChars') || 120000);
  data.maintenance = maintenanceConfig();
  data.connection ||= {};
  data.vscodeContext = collectVsCodeContext();
  data.auth ||= {};
  data.auth.required = authRequired();
  data.auth.token ||= newAuthToken();
  data.permissions ||= {};
  data.permissions.profile = permissionProfile();
  data.permissions.readOnly = permissionProfile() === 'readOnly';
  data.permissions.blockDangerousOperations = permissionProfile() !== 'fullAccess' && cfg().get('blockDangerousOperations') !== false;
  data.permissions.confirmBeforePush = !!cfg().get('confirmBeforePush');
  data.permissions.allowDirectoryMutations = permissionProfile() === 'fullAccess' || !!cfg().get('allowDirectoryMutations');
  data.workspaces ||= [];
  data.commands ||= [];
  const root = currentRoot();
  if(root && (forceCurrent || cfg().get('autoUseCurrentWorkspace'))){
    syncCurrentWorkspace(data, root);
  }
  normalizeWorkspaceRoles(data);
  writeJson(p,data);
  selectedPort = Number(data.server.port || configuredPort() || BASE_PORT);
  return data;
}
function scheduleContextRefresh(ctx){
  if(contextWriteTimer) clearTimeout(contextWriteTimer);
  contextWriteTimer = setTimeout(()=>{
    contextWriteTimer = null;
    try { ensureConfig(ctx,false); refreshPanel(); } catch(e) { log(`VS Code context refresh failed: ${e.message || e}`); }
  }, 400);
}
function setStatus(text){ if(statusBar){ statusBar.text = text; statusBar.show(); } }
function shortText(text, max=12000){
  text = String(text ?? '');
  return text.length > max ? `${text.slice(0,max)}\n...[truncated ${text.length - max} chars]` : text;
}
function gitSync(root, args, max=12000){
  if(!root) return '';
  const r = spawnSync('git', args, {cwd:root, encoding:'utf8', windowsHide:true});
  if(r.error || r.status !== 0) return shortText((r.stderr || r.stdout || r.error?.message || '').trim(), max);
  return shortText((r.stdout || '').trim(), max);
}
function packageScripts(root){
  const pkg = readJson(path.join(root,'package.json'));
  if(!pkg?.scripts) return [];
  return Object.entries(pkg.scripts).slice(0,80).map(([name, command]) => `${name}: ${command}`);
}
function safeRootFiles(root, depth=3, max=260){
  const out = [];
  const skip = new Set(['.git','node_modules','.next','.dart_tool','dist','build','coverage','.cache','tmp','.vscode','.idea']);
  function walk(dir, level){
    if(out.length >= max || level > depth) return;
    let entries = [];
    try{ entries = fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)); }catch{ return; }
    for(const e of entries){
      if(out.length >= max) break;
      const full = path.join(dir,e.name);
      const rel = path.relative(root, full).replace(/\\/g,'/');
      if(!rel || isProtectedName(full) || skip.has(e.name)) continue;
      out.push(`${e.isDirectory() ? 'd' : 'f'} ${rel}`);
      if(e.isDirectory()) walk(full, level + 1);
    }
  }
  walk(root, 1);
  return out;
}
function readInstructionFile(root, name){
  const full = path.join(root, name);
  if(!fs.existsSync(full) || isProtectedName(full)) return '';
  try{
    const st = fs.statSync(full);
    if(!st.isFile() || st.size > 200000) return '';
    return shortText(fs.readFileSync(full,'utf8'), 30000);
  }catch{ return ''; }
}
function contextBundle(ctx){
  const root = currentRoot();
  if(!root) throw new Error('Open a VS Code project folder first.');
  const data = ensureConfig(ctx,false);
  const vscodeContext = collectVsCodeContext();
  const activeEditor = vscodeContext.activeEditor ? {...vscodeContext.activeEditor} : null;
  if(activeEditor && (String(activeEditor.path || '').includes('://') || path.isAbsolute(String(activeEditor.path || '')))){
    activeEditor.selectedText = '';
  } else if(activeEditor?.selectedText) {
    activeEditor.selectedText = shortText(activeEditor.selectedText, 4000);
  }
  const refs = (data.workspaces || []).filter(w => w.reference).map(w => `${w.name || w.id}: ${w.root}`);
  const diagnostics = (vscodeContext.diagnostics || []).slice(0,80).map(d => `${d.severity} ${d.path}:${d.range?.start?.line || 1} ${d.message}`);
  const instructions = ['AGENTS.md','CLAUDE.md'].map(name => ({name, text:readInstructionFile(root,name)})).filter(x => x.text);
  const sections = [
    `# DevMate Context Bundle`,
    `Generated: ${new Date().toISOString()}`,
    `Purpose: paste this into a ChatGPT model/session that cannot call the DevMate MCP tools. Use it for planning, review, and guidance. If live file edits are needed, reconnect DevMate and use MCP tools.`,
    `## Workspace\nRoot: ${root}\nDevMate: ${VERSION}\nPermission profile: ${data.permissions?.profile || 'fullAccess'}\nReferences:\n${refs.length ? refs.map(x=>`- ${x}`).join('\n') : '- none'}`,
    `## Git Status\n\`\`\`text\n${gitSync(root,['status','--short','--branch'],12000) || '(no git status)'}\n\`\`\``,
    `## Git Diff Stat\n\`\`\`text\n${gitSync(root,['diff','--stat'],12000) || '(no diff stat)'}\n\`\`\``,
    `## Package Scripts\n\`\`\`text\n${packageScripts(root).join('\n') || '(no package scripts found)'}\n\`\`\``,
    `## File Tree\n\`\`\`text\n${safeRootFiles(root).join('\n') || '(no files listed)'}\n\`\`\``,
    `## VS Code Context\n\`\`\`json\n${JSON.stringify({activeEditor, visibleEditors:vscodeContext.visibleEditors, diagnostics}, null, 2)}\n\`\`\``,
    ...instructions.map(x => `## ${x.name}\n\`\`\`markdown\n${x.text}\n\`\`\``),
    `## Suggested Instruction\nAct as my development planning assistant from this context. Keep recommendations concrete and scoped. If you need live file reads, edits, commands, tests, or Git operations, tell me to reconnect DevMate and use MCP tools.`
  ];
  return sections.join('\n\n');
}
async function copyContextBundle(ctx){
  try{
    const text = contextBundle(ctx);
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage(`DevMate context copied (${text.length} chars). Paste it into ChatGPT when MCP tools are unavailable.`);
  }catch(e){
    vscode.window.showErrorMessage(`Context copy failed: ${e.message || e}`);
  }
}

function httpRequestRaw(url, options={}, body=null, timeoutMs=4000){
  return new Promise(resolve=>{
    let u;
    try { u = new URL(url); } catch(e) { resolve({ok:false,error:`bad url: ${e.message}`}); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: options.method || 'GET', headers: options.headers || {}, timeout: timeoutMs }, res=>{
      let chunks=[];
      res.on('data', d=>chunks.push(Buffer.from(d)));
      res.on('end', ()=>{
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, headers: res.headers, body: text, json });
      });
    });
    req.on('error',e=>resolve({ok:false,error:e.message}));
    req.on('timeout',()=>{ req.destroy(); resolve({ok:false,error:'timeout'}); });
    if(body !== null) req.write(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    req.end();
  });
}
function httpGet(url, timeoutMs=1500){ return httpRequestRaw(url, {method:'GET'}, null, timeoutMs); }
async function postJson(url, payload, timeoutMs=5000){
  return httpRequestRaw(url, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'Accept':'application/json, text/event-stream' }
  }, JSON.stringify(payload), timeoutMs);
}
async function healthAt(port){ return httpGet(`http://127.0.0.1:${port}/control/health`,1200); }
function healthMatches(r, ctx){
  const cfgData = readJson(configPath(ctx));
  return !!(r.ok && r.json && r.json.name === 'devmate' && r.json.version === VERSION && (!cfgData?.instanceId || r.json.instanceId === cfgData.instanceId));
}
function isPortFree(port){
  return new Promise(resolve=>{
    const srv = net.createServer();
    srv.once('error',()=>resolve(false));
    srv.once('listening',()=>srv.close(()=>resolve(true)));
    srv.listen(port,'127.0.0.1');
  });
}
async function choosePort(ctx){
  const base = configuredPort() || BASE_PORT;
  for(let p=base; p<base+20; p++){
    const health = await healthAt(p);
    if(healthMatches(health, ctx)) return p;
    if(!health.ok && await isPortFree(p)) return p;
    log(`Port ${p} is busy or occupied by a different service; trying next port.`);
  }
  throw new Error(`No free port found from ${base} to ${base+19}. Close old gateway/ngrok/node processes and try again.`);
}
async function isCurrentGatewayUp(ctx){
  const data = ensureConfig(ctx,false);
  const r = await healthAt(Number(data.server.port || selectedPort));
  return healthMatches(r, ctx);
}
function spawnNode(script, env){
  const child = spawn(process.execPath,[script],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',...env}, windowsHide:true});
  child.stdout.on('data',d=>log(`[gateway] ${String(d).trimEnd()}`));
  child.stderr.on('data',d=>log(`[gateway:err] ${String(d).trimEnd()}`));
  child.on('error',e=>log(`Gateway process error: ${e.message}`));
  child.on('exit',(code,signal)=>{log(`Gateway exited code=${code} signal=${signal}`); gatewayProcess=null; setStatus('DevMate: stopped'); refreshPanel();});
  return child;
}
function stopStartCommand(){
  try{ if(startCommandProcess) startCommandProcess.kill(); }catch{}
  startCommandProcess = null;
}
function runDefaultStartCommand(){
  const command = String(cfg().get('defaultStartCommand') || '').trim();
  if(!command) return;
  if(startCommandProcess && !startCommandProcess.killed){
    log('Default start command is already running.');
    return;
  }
  const cwd = currentRoot();
  if(!cwd) return;
  log(`Starting default command: ${command}`);
  startCommandProcess = spawn(command, [], { cwd, shell: true, windowsHide: true });
  startCommandProcess.stdout?.on('data',d=>log(`[start] ${String(d).trimEnd()}`));
  startCommandProcess.stderr?.on('data',d=>log(`[start:err] ${String(d).trimEnd()}`));
  startCommandProcess.on('error',e=>log(`Default start command error: ${e.message}`));
  startCommandProcess.on('exit',(code,signal)=>{log(`Default start command exited code=${code} signal=${signal}`); startCommandProcess=null; refreshPanel();});
}
async function startGateway(ctx){
  if(!currentRoot()) throw new Error('Open a VS Code project folder first.');
  // If our exact current gateway is already up, reuse it.
  if(await isCurrentGatewayUp(ctx)){ log('Current gateway already listening.'); setStatus('DevMate: on'); runDefaultStartCommand(); return; }
  const p = await choosePort(ctx);
  ensureConfig(ctx,true,p);
  if(gatewayProcess){ try{ gatewayProcess.kill(); }catch{} gatewayProcess=null; }
  gatewayProcess = spawnNode(gatewayPath(ctx), { DEVMATE_CONFIG: configPath(ctx), DEVMATE_PUBLIC_HEALTH_DETAILS: cfg().get('publicHealthDetails') ? '1' : '0' });
  for(let i=0;i<40;i++){
    await new Promise(r=>setTimeout(r,250));
    const r = await healthAt(p);
    if(healthMatches(r, ctx)){ setStatus(`DevMate: on :${p}`); log(`Gateway ready on port ${p}.`); runDefaultStartCommand(); return; }
  }
  try{ if(gatewayProcess) gatewayProcess.kill(); }catch{}
  gatewayProcess = null;
  throw new Error('Gateway did not become ready. Open Show Logs for details.');
}
async function getNgrokTunnels(){
  const r = await httpGet('http://127.0.0.1:4040/api/tunnels',900);
  if(!r.ok || !r.json?.tunnels) return [];
  return r.json.tunnels || [];
}
async function deleteNgrokTunnel(t){
  if(!t?.name) return false;
  const r = await httpRequestRaw(`http://127.0.0.1:4040/api/tunnels/${encodeURIComponent(t.name)}`, {method:'DELETE'}, null, 2500);
  return r.ok || r.status === 204;
}
function tunnelPort(t){
  const addr = t?.config?.addr || t?.config?.addr_url || t?.addr || '';
  const m = String(addr).match(/:(\d+)(?:\/)?$/);
  return m ? Number(m[1]) : null;
}
async function stopNgrokTunnels(tunnels=[]){
  try{ if(ngrokProcess) ngrokProcess.kill(); }catch{}
  ngrokProcess=null; lastPublicUrl='';
  for(const t of tunnels){
    const ok = await deleteNgrokTunnel(t);
    log(ok ? `Stopped ngrok tunnel ${t.public_url || t.name}.` : `Could not stop ngrok tunnel ${t.public_url || t.name}; it may be owned by another process.`);
  }
}
async function getNgrokPublicUrlForPort(port){
  const tunnels = await getNgrokTunnels();
  const t = tunnels.find(x => x.public_url?.startsWith('https://') && tunnelPort(x) === port);
  return t?.public_url || '';
}
async function startNgrok(ctx){
  const data = ensureConfig(ctx,false);
  const p = Number(data.server.port || selectedPort);
  let existing = await getNgrokPublicUrlForPort(p);
  if(existing){ lastPublicUrl = existing; log(`Using existing ngrok tunnel for port ${p}: ${existing}`); return existing; }
  if(ngrokProcess && !ngrokProcess.killed){
    try{ ngrokProcess.kill(); log('Stopped previous DevMate ngrok process before starting current port.'); }catch{}
    ngrokProcess = null;
    lastPublicUrl = '';
  }
  const other = (await getNgrokTunnels()).find(x => x.public_url?.startsWith('https://'));
  if(other){
    log(`Found another ngrok tunnel ${other.public_url} -> port ${tunnelPort(other)}. Leaving it running and starting a DevMate tunnel for port ${p}.`);
  }
  const exe = ngrokCommand();
  const check = spawnSync(exe,['version'],{encoding:'utf8',windowsHide:true});
  if(check.error) throw new Error(`ngrok not found. Install and authenticate ngrok first. Error: ${check.error.message}`);
  ngrokProcess = spawn(exe,['http',String(p)],{windowsHide:true});
  ngrokProcess.stdout.on('data',d=>log(`[ngrok] ${String(d).trimEnd()}`));
  ngrokProcess.stderr.on('data',d=>log(`[ngrok:err] ${String(d).trimEnd()}`));
  ngrokProcess.on('exit',(code,signal)=>{log(`ngrok exited code=${code} signal=${signal}`); ngrokProcess=null; lastPublicUrl=''; refreshPanel();});
  for(let i=0;i<60;i++){
    await new Promise(r=>setTimeout(r,300));
    const url=await getNgrokPublicUrlForPort(p);
    if(url){ lastPublicUrl=url; log(`ngrok ready for port ${p}: ${url}`); return url; }
  }
  throw new Error('ngrok did not expose a public URL for the current gateway port. Open Show Logs for details.');
}
async function mcpHandshakeTest(baseUrl, ctx=globalContext){
  const mcp = mcpUrlFor(baseUrl, ctx);
  const init = await postJson(mcp, { jsonrpc:'2.0', id:1, method:'initialize', params:{ protocolVersion:'2025-03-26', capabilities:{}, clientInfo:{name:'devmate-preflight', version:VERSION} } }, 8000);
  const serverName = init.json?.result?.serverInfo?.name;
  if(!init.ok || serverName !== 'devmate'){
    throw new Error(`MCP initialize failed via ${redactUrl(mcp)}. Expected DevMate server, got ${serverName || 'none'}. HTTP=${init.status||'none'} error=${init.error||''} body=${String(init.body||'').slice(0,300)}`);
  }
  const tools = await postJson(mcp, { jsonrpc:'2.0', id:2, method:'tools/list', params:{} }, 8000);
  if(!tools.ok || !Array.isArray(tools.json?.result?.tools)){
    throw new Error(`MCP tools/list failed via ${redactUrl(mcp)}. HTTP=${tools.status||'none'} error=${tools.error||''} body=${String(tools.body||'').slice(0,300)}`);
  }
  return { mcp, toolCount: tools.json.result.tools.length, server: init.json.result.serverInfo };
}
async function quickStart(ctx){
  try{
    output.show(true);
    if(!currentRoot()) throw new Error('Open a VS Code project folder first.');
    await startGateway(ctx);
    const publicUrl = await startNgrok(ctx);
    log('Running public MCP preflight through ngrok before copying URL...');
    const test = await mcpHandshakeTest(publicUrl, ctx);
    const stamp = new Date().toISOString();
    if(cfg().get('autoCopyUrl')) await vscode.env.clipboard.writeText(test.mcp);
    updateConnectionSnapshot(ctx, {
      lastPreflightAt: stamp,
      lastCopiedAt: cfg().get('autoCopyUrl') ? stamp : undefined,
      lastPublicHost: publicHost(publicUrl),
      lastMcpPath: MCP_PATH,
      lastToolCount: test.toolCount,
      lastServerName: test.server?.name || 'devmate',
      lastError: '',
      lastErrorAt: null
    });
    setStatus('DevMate: ready');
    log(`Public MCP preflight OK: ${redactUrl(test.mcp)}, tools=${test.toolCount}`);
    vscode.window.showInformationMessage(cfg().get('autoCopyUrl') ? `Ready. ChatGPT MCP URL copied and verified: ${redactUrl(test.mcp)}` : `Ready. Verified MCP URL: ${redactUrl(test.mcp)}`);
    refreshPanel();
  }catch(e){ updateConnectionSnapshot(ctx,{lastError:String(e.message || e),lastErrorAt:new Date().toISOString()}); log(`ERROR: ${e.stack || e.message || e}`); vscode.window.showErrorMessage(`DevMate failed: ${e.message || e}`); }
}
async function stopAll(){
  if(globalContext){
    try{
      const data = ensureConfig(globalContext,false);
      const port = Number(data.server.port || selectedPort);
      const tunnels = (await getNgrokTunnels()).filter(t => tunnelPort(t) === port);
      if(tunnels.length) await stopNgrokTunnels(tunnels);
    }catch(e){ log(`Could not stop ngrok tunnel cleanly: ${e.message || e}`); }
  }
  try{ if(gatewayProcess) gatewayProcess.kill(); }catch{}
  try{ if(ngrokProcess) ngrokProcess.kill(); }catch{}
  stopStartCommand();
  gatewayProcess=null; ngrokProcess=null; lastPublicUrl=''; setStatus('DevMate: stopped'); refreshPanel();
}
async function copyUrl(){
  const data = ensureConfig(globalContext,false);
  const url = await getNgrokPublicUrlForPort(Number(data.server.port || selectedPort));
  if(!url) return vscode.window.showWarningMessage('No ngrok URL for current gateway port. Run One-click Start first.');
  try{
    const test = await mcpHandshakeTest(url, globalContext);
    const stamp = new Date().toISOString();
    await vscode.env.clipboard.writeText(test.mcp);
    updateConnectionSnapshot(globalContext, {
      lastPreflightAt: stamp,
      lastCopiedAt: stamp,
      lastPublicHost: publicHost(url),
      lastMcpPath: MCP_PATH,
      lastToolCount: test.toolCount,
      lastServerName: test.server?.name || 'devmate',
      lastError: '',
      lastErrorAt: null
    });
    vscode.window.showInformationMessage(`Copied verified MCP URL: ${redactUrl(test.mcp)}`);
  }catch(e){ updateConnectionSnapshot(globalContext,{lastError:String(e.message || e),lastErrorAt:new Date().toISOString()}); log(`MCP URL verification failed: ${e.stack || e.message || e}`); vscode.window.showErrorMessage(`MCP URL is not healthy: ${e.message || e}`); }
}
async function copyStarterPrompt(){
  const text = '使用 DevMate，完成这个开发任务。需要时可以读取、搜索、修改文件、运行命令和使用 Git；完成后用 task_report 总结结果。';
  await vscode.env.clipboard.writeText(text); vscode.window.showInformationMessage('Starter prompt copied.');
}
function parseGithubRepo(input){
  const text = String(input || '').trim();
  let match = text.match(/^https?:\/\/github\.com\/([^\/\s]+)\/([^\/\s#?]+?)(?:\.git)?(?:[\/#?].*)?$/i);
  if(!match) match = text.match(/^git@github\.com:([^\/\s]+)\/([^\/\s]+?)(?:\.git)?$/i);
  if(!match) return null;
  const owner = match[1].replace(/[^a-zA-Z0-9_.-]/g,'');
  const repo = match[2].replace(/[^a-zA-Z0-9_.-]/g,'');
  if(!owner || !repo) return null;
  return {
    owner,
    repo,
    name: `${owner}/${repo}`,
    idBase: `github-${owner}-${repo}`,
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
    dirName: `${owner}__${repo}`.replace(/[^a-zA-Z0-9_.-]/g,'-')
  };
}
function runGit(args, cwd, timeoutMs=180000){
  return new Promise(resolve=>{
    const child = spawn('git', args, { cwd, windowsHide:true });
    let stdout='', stderr='', done=false;
    const timer = setTimeout(()=>{
      if(done) return;
      done = true;
      try{ child.kill(); }catch{}
      resolve({exitCode:null,timedOut:true,stdout,stderr});
    }, timeoutMs);
    child.stdout?.on('data', d=>{ stdout += d.toString(); });
    child.stderr?.on('data', d=>{ stderr += d.toString(); });
    child.on('error', e=>{
      if(done) return;
      done = true;
      clearTimeout(timer);
      resolve({exitCode:null,error:e.message,stdout,stderr});
    });
    child.on('close', code=>{
      if(done) return;
      done = true;
      clearTimeout(timer);
      resolve({exitCode:code,timedOut:false,stdout,stderr});
    });
  });
}
function addReferenceWorkspace(ctx, root, name, idBase){
  const data = ensureConfig(ctx,false);
  const resolved = path.resolve(root);
  if(!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error(`Reference path is not a directory: ${resolved}`);
  if(data.workspaces.some(w => !w.reference && samePath(w.root, resolved))) throw new Error(`Reference path is already a writable workspace: ${resolved}`);
  const existing = data.workspaces.find(w => w.reference && samePath(w.root, resolved));
  if(existing){
    existing.name = name || path.basename(resolved);
    existing.root = resolved;
    existing.mode = 'readonly';
    existing.reference = true;
    existing.role = 'reference';
  } else {
    const id = uniqueWorkspaceId(data.workspaces, idBase || makeId(resolved));
    data.workspaces.push({id,name:name || path.basename(resolved),root:resolved,mode:'readonly',reference:true,role:'reference'});
  }
  normalizeWorkspaceRoles(data);
  writeJson(configPath(ctx), data);
  refreshPanel();
  return resolved;
}
async function addGithubReference(ctx, github){
  const baseDir = path.join(ctx.globalStorageUri.fsPath, 'references', 'github');
  ensureDir(baseDir);
  const target = path.join(baseDir, github.dirName);
  let result;
  if(fs.existsSync(path.join(target,'.git'))){
    log(`Updating GitHub reference ${github.name} in ${target}`);
    result = await runGit(['pull','--ff-only'], target);
  } else {
    if(fs.existsSync(target) && fs.readdirSync(target).length > 0) throw new Error(`GitHub reference target exists but is not a Git repository: ${target}`);
    log(`Cloning GitHub reference ${github.name} into ${target}`);
    result = await runGit(['clone','--depth','1',github.cloneUrl,target], baseDir);
  }
  if(result.exitCode !== 0) throw new Error(`git ${result.timedOut ? 'timed out' : 'failed'}: ${(result.stderr || result.error || result.stdout || '').trim()}`);
  addReferenceWorkspace(ctx, target, github.name, github.idBase);
  return target;
}
async function addReferenceInput(ctx, value){
  const input = String(value || '').trim().replace(/^["']|["']$/g,'');
  if(!input) return vscode.window.showWarningMessage('Enter a folder path or GitHub repository URL.');
  const github = parseGithubRepo(input);
  if(github){
    output.show(true);
    try{
      const target = await addGithubReference(ctx, github);
      vscode.window.showInformationMessage(`GitHub reference ready: ${github.name}`);
      log(`GitHub reference ready: ${target}`);
    }catch(e){
      log(`GitHub reference failed: ${e.stack || e.message || e}`);
      vscode.window.showErrorMessage(`GitHub reference failed: ${e.message || e}`);
    }
    return;
  }
  try{
    const root = path.isAbsolute(input) ? input : path.resolve(currentRoot() || process.cwd(), input);
    const resolved = addReferenceWorkspace(ctx, root, path.basename(root), makeId(root));
    vscode.window.showInformationMessage(`Reference added: ${resolved}`);
  }catch(e){
    vscode.window.showErrorMessage(`Reference add failed: ${e.message || e}`);
  }
}
async function addReferenceFromClipboard(ctx){
  const text = await vscode.env.clipboard.readText();
  await addReferenceInput(ctx, text);
}
async function addOpenFolderReferences(ctx){
  const folders = vscode.workspace.workspaceFolders || [];
  const activeRoot = currentRoot();
  const roots = folders.map(f => f.uri.fsPath).filter(root => root && !samePath(root, activeRoot));
  if(!roots.length) return vscode.window.showInformationMessage('No extra VS Code workspace folders to add as references.');
  let added = 0;
  const failed = [];
  for(const root of roots){
    try{
      addReferenceWorkspace(ctx, root, path.basename(root), makeId(root));
      added++;
    }catch(e){
      failed.push(`${root}: ${e.message || e}`);
    }
  }
  if(failed.length){
    output.show(true);
    failed.forEach(item => log(`Open folder reference skipped: ${item}`));
    vscode.window.showWarningMessage(`Added ${added} reference(s), skipped ${failed.length}. See DevMate logs.`);
  } else {
    vscode.window.showInformationMessage(`Added ${added} open folder reference(s).`);
  }
}
async function addReference(ctx){
  const uris = await vscode.window.showOpenDialog({canSelectFolders:true,canSelectFiles:false,canSelectMany:false,openLabel:'Add readonly reference project'});
  if(!uris?.[0]) return;
  try{
    const root = uris[0].fsPath;
    const resolved = addReferenceWorkspace(ctx, root, path.basename(root), makeId(root));
    vscode.window.showInformationMessage(`Reference added: ${resolved}`);
  }catch(e){
    vscode.window.showErrorMessage(`Reference add failed: ${e.message || e}`);
  }
}
async function removeReference(ctx, id){
  const data = ensureConfig(ctx,false);
  const target = (data.workspaces || []).find(w => w.reference && w.id === id);
  if(!target){
    vscode.window.showWarningMessage('Reference not found.');
    refreshPanel();
    return;
  }
  data.workspaces = (data.workspaces || []).filter(w => !(w.reference && w.id === id));
  normalizeWorkspaceRoles(data);
  writeJson(configPath(ctx), data);
  refreshPanel();
  vscode.window.showInformationMessage(`Reference removed: ${target.name || target.root || id}`);
}
async function saveReferencesJson(ctx, value){
  try{
    const text = String(value || '').trim();
    let parsed = text ? JSON.parse(text) : [];
    if(parsed && !Array.isArray(parsed) && Array.isArray(parsed.references)) parsed = parsed.references;
    if(!Array.isArray(parsed)) throw new Error('References JSON must be an array, or an object with a references array.');

    const data = ensureConfig(ctx,false);
    const nonReferences = (data.workspaces || []).filter(w => !w.reference);
    const usedIds = new Set(nonReferences.map(w => w.id).filter(Boolean));
    const existingRoots = new Set(nonReferences.map(w => w.root || '').filter(Boolean).map(pathKey));
    const nextReferences = [];
    const seenRoots = new Set();

    for(let i=0; i<parsed.length; i++){
      const item = parsed[i] || {};
      if(typeof item !== 'object' || Array.isArray(item)) throw new Error(`Reference ${i + 1} must be an object.`);
      const rawRoot = String(item.root || '').trim();
      if(!rawRoot) throw new Error(`Reference ${i + 1} is missing root.`);
      const root = path.resolve(path.isAbsolute(rawRoot) ? rawRoot : path.join(currentRoot() || process.cwd(), rawRoot));
      if(!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Reference path is not a directory: ${root}`);
      const rootKey = pathKey(root);
      if(existingRoots.has(rootKey)) throw new Error(`Reference path is already a writable workspace: ${root}`);
      if(seenRoots.has(rootKey)) throw new Error(`Duplicate reference path: ${root}`);
      seenRoots.add(rootKey);

      const baseId = String(item.id || makeId(root)).replace(/[^a-zA-Z0-9_-]+/g,'-').toLowerCase() || makeId(root);
      let id = baseId;
      let n = 2;
      while(usedIds.has(id)) id = `${baseId}-${n++}`;
      usedIds.add(id);
      const name = String(item.name || path.basename(root)).trim() || path.basename(root);
      nextReferences.push({id,name,root,mode:'readonly',reference:true,role:'reference'});
    }

    data.workspaces = [...nonReferences, ...nextReferences];
    normalizeWorkspaceRoles(data);
    writeJson(configPath(ctx), data);
    refreshPanel();
    vscode.window.showInformationMessage(`References saved: ${nextReferences.length}`);
  }catch(e){
    vscode.window.showErrorMessage(`References JSON invalid: ${e.message || e}`);
  }
}
async function doctor(ctx){
  const checks=[];
  const data=ensureConfig(ctx,false);
  checks.push(`Version: ${VERSION}`);
  checks.push(`VS Code workspace: ${currentRoot() || 'NONE'}`);
  checks.push(`Extension path: ${ctx.extensionPath}`);
  checks.push(`Config path: ${configPath(ctx)}`);
  checks.push(`Configured/current port: ${data.server.port}`);
  checks.push(`Node: ${process.execPath}`);
  const git=spawnSync('git',['--version'],{encoding:'utf8',windowsHide:true}); checks.push(`git: ${git.error ? 'MISSING' : git.stdout.trim()}`);
  const ng=spawnSync(ngrokCommand(),['version'],{encoding:'utf8',windowsHide:true}); checks.push(`ngrok: ${ng.error ? 'MISSING' : ng.stdout.trim().split(/\r?\n/)[0]}`);
  const h=await healthAt(Number(data.server.port||selectedPort)); checks.push(`Gateway health: ${healthMatches(h,ctx) ? 'OK' : `not current/failed (${h.status||h.error||'no response'})`}`);
  const url=await getNgrokPublicUrlForPort(Number(data.server.port||selectedPort)); checks.push(`ngrok url for current port: ${url || 'not running'}`);
  if(url){ try{ const test=await mcpHandshakeTest(url); checks.push(`public MCP preflight: OK tools=${test.toolCount}`); }catch(e){ checks.push(`public MCP preflight: FAILED ${e.message}`); } }
  output.show(true); checks.forEach(x=>log(`[doctor] ${x}`)); vscode.window.showInformationMessage('Doctor finished. See DevMate output.');
}

async function openSettings(){
  await vscode.commands.executeCommand('workbench.action.openSettings', 'DevMate');
}
async function setup(ctx){
  output.show(true);
  await doctor(ctx);
  const actions=[];
  if(!currentRoot()) actions.push('Open a project folder in VS Code.');
  const ng=spawnSync(ngrokCommand(),['version'],{encoding:'utf8',windowsHide:true});
  if(ng.error) actions.push('Install and login ngrok, then run DevMate: Start.');
  if(actions.length) vscode.window.showWarningMessage(`DevMate setup needs: ${actions.join(' ')}`);
  else vscode.window.showInformationMessage('DevMate setup looks ready. Run DevMate: Start.');
}

function panelHtml(ctx, webview){
  const data=ensureConfig(ctx,false); const root=currentRoot();
  const n = nonce();
  const mcpDisplay = lastPublicUrl ? redactUrl(mcpUrlFor(lastPublicUrl, ctx)) : 'not started';
  const references = (data.workspaces || []).filter(w => w.reference);
  const activeWorkspace = (data.workspaces || []).find(w => w.id === data.activeWorkspaceId) || (data.workspaces || []).find(w => !w.reference);
  const workspaceState = {
    active: activeWorkspace ? {id:activeWorkspace.id,name:activeWorkspace.name,root:activeWorkspace.root,mode:activeWorkspace.mode} : null,
    references: references.length
  };
  const referenceJson = JSON.stringify(references.map(w => ({id:w.id,name:w.name,root:w.root})), null, 2);
  const referenceList = references.length
    ? references.map(w => `<div class="ref-row"><div class="ref-main"><strong>${esc(w.name || w.id)}</strong><code>${esc(w.root || '')}</code></div><button class="secondary danger" data-cmd="removeReference" data-id="${esc(w.id)}">Remove</button></div>`).join('')
    : '<p class="muted">No readonly reference projects yet.</p>';
  return `<!doctype html><html><head>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
  <style>
    body{font-family:var(--vscode-font-family); color:var(--vscode-foreground); background:var(--vscode-editor-background); padding:20px; line-height:1.45;}
    h2{margin:0 0 12px; font-size:24px;}
    h3{margin:22px 0 8px; font-size:16px;}
    code{font-family:var(--vscode-editor-font-family); background:var(--vscode-textCodeBlock-background); padding:2px 4px; border-radius:4px;}
    button{border:1px solid var(--vscode-button-border, transparent); background:var(--vscode-button-background); color:var(--vscode-button-foreground); padding:5px 10px; border-radius:4px; cursor:pointer;}
    button:hover{background:var(--vscode-button-hoverBackground);}
    button.secondary{background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground);}
    button.secondary:hover{background:var(--vscode-button-secondaryHoverBackground);}
    button.danger{border-color:var(--vscode-inputValidation-errorBorder);}
    input,textarea{box-sizing:border-box; border:1px solid var(--vscode-input-border); background:var(--vscode-input-background); color:var(--vscode-input-foreground); border-radius:4px; padding:6px 8px;}
    textarea{width:100%; font-family:var(--vscode-editor-font-family); resize:vertical;}
    details{margin-top:14px; border-top:1px solid var(--vscode-panel-border); padding-top:12px;}
    summary{cursor:pointer; font-weight:600;}
    .muted{color:var(--vscode-descriptionForeground);}
    .section{border-top:1px solid var(--vscode-panel-border); padding-top:14px; margin-top:16px;}
    .toolbar{display:flex; flex-wrap:wrap; gap:8px; margin:10px 0;}
    .status-grid{display:grid; grid-template-columns:max-content minmax(0,1fr); gap:6px 12px; max-width:980px;}
    .input-row{display:flex; gap:8px; align-items:center; max-width:980px;}
    .input-row input{flex:1; min-width:220px;}
    .ref-list{max-width:980px; margin-top:10px;}
    .ref-row{display:flex; align-items:center; justify-content:space-between; gap:12px; border-top:1px solid var(--vscode-panel-border); padding:9px 0;}
    .ref-main{min-width:0; display:flex; flex-direction:column; gap:4px;}
    .ref-main code{display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
    .flow{margin-top:18px;}
  </style>
  </head><body>
  <h2>DevMate ${VERSION}</h2>
  <div class="status-grid">
    <b>Active project</b><code>${esc(root || 'Open a VS Code folder first')}</code>
    <b>MCP</b><code>${esc(mcpDisplay)}</code>
    <b>Local</b><code>127.0.0.1:${esc(data.server.port)}/mcp</code>
    <b>Auth</b><code>${esc(data.auth?.required ? 'token required' : 'disabled')}</code>
    <b>Permissions</b><code>${esc(data.permissions?.profile || 'fullAccess')}</code>
    <b>Last preflight</b><code>${esc(data.connection?.lastPreflightAt ? `${data.connection.lastPreflightAt} ${data.connection.lastPublicHost || ''}` : 'not recorded')}</code>
    <b>Start command</b><code>${esc(startCommandProcess ? 'running' : (String(cfg().get('defaultStartCommand') || '').trim() || 'not configured'))}</code>
  </div>
  <div class="toolbar">
    <button data-cmd="quickStart">Start</button>
    <button data-cmd="copyUrl">Copy URL</button>
    <button class="secondary" data-cmd="stop">Stop</button>
    <button class="secondary" data-cmd="doctor">Doctor</button>
    <button class="secondary" data-cmd="starter">Copy Prompt</button>
    <button class="secondary" data-cmd="copyContext">Copy Context</button>
    <button class="secondary" data-cmd="settings">Settings</button>
    <button class="secondary" data-cmd="logs">Logs</button>
  </div>
  <div class="section">
    <h3>References</h3>
    <div class="input-row">
      <input id="referenceInput" placeholder="Folder path or https://github.com/owner/repo">
      <button data-cmd="addReferenceInput">Add</button>
      <button class="secondary" data-cmd="addReferenceClipboard">From Clipboard</button>
      <button class="secondary" data-cmd="addReference">Browse</button>
      <button class="secondary" data-cmd="addOpenFolders">Open Folders</button>
    </div>
    <div class="ref-list">${referenceList}</div>
    <details>
      <summary>Advanced reference editing</summary>
      <p class="muted">Edit references as JSON only when bulk changes are faster than the buttons above.</p>
      <textarea id="referencesJson" rows="9">${esc(referenceJson)}</textarea>
      <div class="toolbar">
        <button data-cmd="saveReferencesJson">Save JSON</button>
        <button class="secondary danger" data-cmd="clearReferences">Clear All References</button>
      </div>
    </details>
  </div>
  <details>
    <summary>Workspace state</summary>
    <p class="muted">DevMate keeps one writable active workspace. Add other projects as readonly references.</p>
    <pre>${esc(JSON.stringify(workspaceState,null,2))}</pre>
  </details>
  <p class="flow muted">Daily flow: open project -> <b>Start</b> -> paste URL into ChatGPT App -> say “使用 DevMate，完成这个开发任务”。</p>
  <script nonce="${n}">
  const vscode=acquireVsCodeApi();
  document.addEventListener('click', event => {
    const button = event.target.closest('button[data-cmd]');
    if(!button) return;
    const message = {cmd: button.dataset.cmd};
    if(message.cmd === 'addReferenceInput') message.value = document.getElementById('referenceInput')?.value || '';
    if(message.cmd === 'saveReferencesJson') message.value = document.getElementById('referencesJson')?.value || '';
    if(message.cmd === 'removeReference') message.id = button.dataset.id || '';
    vscode.postMessage(message);
  });
  document.getElementById('referenceInput')?.addEventListener('keydown', event => {
    if(event.key === 'Enter') vscode.postMessage({cmd:'addReferenceInput', value:event.currentTarget.value || ''});
  });
  </script></body></html>`;
}
function refreshPanel(){ if(panel && globalContext) panel.webview.html=panelHtml(globalContext, panel.webview); }
function openPanel(ctx){
  if(panel){ panel.reveal(); refreshPanel(); return; }
  panel = vscode.window.createWebviewPanel('devMate','DevMate',vscode.ViewColumn.One,{enableScripts:true});
  panel.onDidDispose(()=>panel=null);
  panel.webview.onDidReceiveMessage(async m=>{
    if(m.cmd==='quickStart') await quickStart(ctx);
    if(m.cmd==='copyUrl') await copyUrl();
    if(m.cmd==='stop') await stopAll();
    if(m.cmd==='doctor') await doctor(ctx);
    if(m.cmd==='addReference') await addReference(ctx);
    if(m.cmd==='addReferenceInput') await addReferenceInput(ctx, m.value);
    if(m.cmd==='addReferenceClipboard') await addReferenceFromClipboard(ctx);
    if(m.cmd==='addOpenFolders') await addOpenFolderReferences(ctx);
    if(m.cmd==='removeReference') await removeReference(ctx, m.id);
    if(m.cmd==='saveReferencesJson') await saveReferencesJson(ctx, m.value);
    if(m.cmd==='clearReferences') await clearReferences(ctx);
    if(m.cmd==='starter') await copyStarterPrompt();
    if(m.cmd==='copyContext') await copyContextBundle(ctx);
    if(m.cmd==='logs') output.show(true);
    if(m.cmd==='settings') await openSettings();
  });
  refreshPanel();
}

async function clearReferences(ctx){
  const confirm = await vscode.window.showWarningMessage('Clear all reference projects from DevMate config?', {modal:true}, 'Clear References');
  if(confirm !== 'Clear References') return;
  const data = ensureConfig(ctx,false);
  data.workspaces = (data.workspaces || []).filter(w => !w.reference);
  normalizeWorkspaceRoles(data);
  writeJson(configPath(ctx), data);
  refreshPanel();
  vscode.window.showInformationMessage('Reference projects cleared.');
}
async function exportSource(ctx){
  const target = await vscode.window.showOpenDialog({canSelectFolders:true, canSelectFiles:false, canSelectMany:false, openLabel:'Export source here'});
  if(!target?.[0]) return;
  const stamp = new Date().toISOString().replace(/[:.]/g,'-');
  const outDir = path.join(target[0].fsPath, `devmate-source-${stamp}`);
  fs.mkdirSync(outDir, {recursive:true});
  const skipDirs = new Set(['.git','node_modules','tmp','.vscode']);
  function shouldSkip(src){ const name=path.basename(src); return skipDirs.has(name) || /\.(vsix|tgz|log)$/i.test(name) || /^npm-debug\.log/i.test(name) || /^yarn-(debug|error)\.log/i.test(name); }
  function cp(src,dst){ if(shouldSkip(src)) return; const st=fs.statSync(src); if(st.isDirectory()){ fs.mkdirSync(dst,{recursive:true}); for(const e of fs.readdirSync(src)) cp(path.join(src,e), path.join(dst,e)); } else fs.copyFileSync(src,dst); }
  cp(ctx.extensionPath, outDir);
  vscode.window.showInformationMessage(`Source exported: ${outDir}`);
}

function register(ctx, id, fn){ ctx.subscriptions.push(vscode.commands.registerCommand(id, fn)); }
function activate(context){
  globalContext=context;
  output = vscode.window.createOutputChannel('DevMate'); context.subscriptions.push(output);
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100); statusBar.command='devMate.open'; context.subscriptions.push(statusBar); setStatus('DevMate');
  ensureConfig(context,false);
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(()=>scheduleContextRefresh(context)));
  context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(()=>scheduleContextRefresh(context)));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(()=>scheduleContextRefresh(context)));
  context.subscriptions.push(vscode.languages.onDidChangeDiagnostics(()=>scheduleContextRefresh(context)));
  // Primary simple commands shown in the command palette.
  register(context,'devMate.start',()=>quickStart(context));
  register(context,'devMate.open',()=>openPanel(context));
  register(context,'devMate.stop',()=>stopAll());
  register(context,'devMate.restart',async()=>{await stopAll(); await quickStart(context);});
  register(context,'devMate.copyUrl',()=>copyUrl());
  register(context,'devMate.addReference',()=>addReference(context));
  register(context,'devMate.clearReferences',()=>clearReferences(context));
  register(context,'devMate.doctor',()=>doctor(context));
  register(context,'devMate.logs',()=>output.show(true));
  register(context,'devMate.exportSource',()=>exportSource(context));
  register(context,'devMate.setup',()=>setup(context));
  register(context,'devMate.copyPrompt',()=>copyStarterPrompt());
  register(context,'devMate.copyContextBundle',()=>copyContextBundle(context));
  register(context,'devMate.openSettings',()=>openSettings());

  log(`Activated DevMate ${VERSION}`);
}
function deactivate(){ if(contextWriteTimer) clearTimeout(contextWriteTimer); contextWriteTimer=null; return stopAll(); }
module.exports = { activate, deactivate };
