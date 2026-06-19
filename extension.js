const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const VERSION = '1.7.0';
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
function newAuthToken(){ return crypto.randomBytes(32).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function nonce(){ return crypto.randomBytes(16).toString('base64'); }
function authRequired(){ return cfg().get('requireAuthToken') !== false; }
function permissionProfile(){ const v = cfg().get('permissionProfile'); return ['readOnly','balanced','fullAccess'].includes(v) ? v : 'fullAccess'; }
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
  const active = editor ? {
    path: relToRoot(editor.document.uri.fsPath) || editor.document.uri.toString(),
    languageId: editor.document.languageId,
    lineCount: editor.document.lineCount,
    isDirty: editor.document.isDirty,
    selection: rangePublic(editor.selection),
    selectedText: (!isProtectedName(editor.document.uri.fsPath) && !editor.selection.isEmpty) ? editor.document.getText(editor.selection).slice(0,20000) : ''
  } : null;
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
function mcpUrlFor(baseUrl, ctx){
  const data = ctx ? ensureConfig(ctx,false) : null;
  const u = new URL(`${String(baseUrl).replace(/\/$/,'')}${MCP_PATH}`);
  if(authRequired() && data?.auth?.token) u.searchParams.set('token', data.auth.token);
  return u.toString();
}

function defaultConfig(ctx){
  const root = currentRoot();
  return {
    version: 5,
    appVersion: VERSION,
    instanceId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`,
    server: { port: configuredPort(), mcpPath: MCP_PATH },
    runtime: { defaultCommandTimeoutMs: Number(cfg().get('defaultCommandTimeoutMs') || 180000), maxOutputChars: Number(cfg().get('maxOutputChars') || 120000) },
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
  data.version = 5;
  data.appVersion = VERSION;
  data.instanceId ||= `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
  data.server ||= {};
  data.server.port = Number(portOverride || data.server.port || configuredPort() || BASE_PORT);
  data.server.mcpPath = MCP_PATH;
  data.runtime ||= {};
  data.runtime.defaultCommandTimeoutMs = Number(cfg().get('defaultCommandTimeoutMs') || 180000);
  data.runtime.maxOutputChars = Number(cfg().get('maxOutputChars') || 120000);
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
    const id = makeId(root);
    const existing = data.workspaces.find(w => w.id === id || path.resolve(w.root||'') === path.resolve(root));
    if(existing){
      existing.root = root; existing.name = path.basename(root); existing.mode = 'workspace-write'; existing.reference = false; existing.role = 'active'; data.activeWorkspaceId = existing.id;
    } else {
      data.workspaces.unshift({id, name:path.basename(root), root, mode:'workspace-write', reference:false, role:'active'}); data.activeWorkspaceId = id;
    }
  }
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
  gatewayProcess = spawnNode(gatewayPath(ctx), { AIWG_CONFIG: configPath(ctx), DEVMATE_PUBLIC_HEALTH_DETAILS: cfg().get('publicHealthDetails') ? '1' : '0' });
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
  if(!init.ok || !init.json?.result?.serverInfo?.name){
    throw new Error(`MCP initialize failed via ${redactUrl(mcp)}. HTTP=${init.status||'none'} error=${init.error||''} body=${String(init.body||'').slice(0,300)}`);
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
    if(cfg().get('autoCopyUrl')) await vscode.env.clipboard.writeText(test.mcp);
    setStatus('DevMate: ready');
    log(`Public MCP preflight OK: ${redactUrl(test.mcp)}, tools=${test.toolCount}`);
    vscode.window.showInformationMessage(cfg().get('autoCopyUrl') ? `Ready. ChatGPT MCP URL copied and verified: ${redactUrl(test.mcp)}` : `Ready. Verified MCP URL: ${redactUrl(test.mcp)}`);
    refreshPanel();
  }catch(e){ log(`ERROR: ${e.stack || e.message || e}`); vscode.window.showErrorMessage(`DevMate failed: ${e.message || e}`); }
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
    await vscode.env.clipboard.writeText(test.mcp);
    vscode.window.showInformationMessage(`Copied verified MCP URL: ${redactUrl(test.mcp)}`);
  }catch(e){ log(`MCP URL verification failed: ${e.stack || e.message || e}`); vscode.window.showErrorMessage(`MCP URL is not healthy: ${e.message || e}`); }
}
async function copyStarterPrompt(){
  const text = '使用 DevMate，完成这个开发任务。需要时可以读取、搜索、修改文件、运行命令和使用 Git；完成后用 task_report 总结结果。';
  await vscode.env.clipboard.writeText(text); vscode.window.showInformationMessage('Starter prompt copied.');
}
async function addReference(ctx){
  const uris = await vscode.window.showOpenDialog({canSelectFolders:true,canSelectFiles:false,canSelectMany:false,openLabel:'Add readonly reference project'});
  if(!uris?.[0]) return;
  const root = uris[0].fsPath; const data=ensureConfig(ctx,false); let id=makeId(root); let n=2; while(data.workspaces.some(w=>w.id===id)) id=`${makeId(root)}-${n++}`;
  data.workspaces.push({id,name:path.basename(root),root,mode:'readonly',reference:true,role:'reference'}); writeJson(configPath(ctx),data); refreshPanel(); vscode.window.showInformationMessage(`Reference added: ${root}`);
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
  return `<!doctype html><html><head>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
  </head><body style="font-family: var(--vscode-font-family); padding:16px;">
  <h2>DevMate ${VERSION}</h2>
  <p><b>Active project:</b><br><code>${esc(root || 'Open a VS Code folder first')}</code></p>
  <p><b>MCP:</b> <code>${esc(mcpDisplay)}</code><br><b>Local:</b> <code>127.0.0.1:${esc(data.server.port)}/mcp</code><br><b>Auth:</b> <code>${esc(data.auth?.required ? 'token required' : 'disabled')}</code><br><b>Permissions:</b> <code>${esc(data.permissions?.profile || 'fullAccess')}</code><br><b>Start command:</b> <code>${esc(startCommandProcess ? 'running' : (String(cfg().get('defaultStartCommand') || '').trim() || 'not configured'))}</code></p>
  <p><button data-cmd="quickStart">Start</button>
  <button data-cmd="copyUrl">Copy URL</button>
  <button data-cmd="stop">Stop</button>
  <button data-cmd="doctor">Doctor</button></p>
  <p><button data-cmd="addReference">Add Reference</button>
  <button data-cmd="starter">Copy Prompt</button>
  <button data-cmd="settings">Settings</button>
  <button data-cmd="logs">Logs</button></p>
  <h3>Workspaces</h3><pre>${esc(JSON.stringify(data.workspaces.map(w=>({id:w.id,name:w.name,role:w.role,mode:w.mode,root:w.root})),null,2))}</pre>
  <p>Daily flow: open project → <b>Start</b> → paste URL into ChatGPT App → say “使用 DevMate，完成这个开发任务”。</p>
  <script nonce="${n}">
  const vscode=acquireVsCodeApi();
  document.addEventListener('click', event => {
    const button = event.target.closest('button[data-cmd]');
    if(button) vscode.postMessage({cmd: button.dataset.cmd});
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
    if(m.cmd==='starter') await copyStarterPrompt();
    if(m.cmd==='logs') output.show(true);
    if(m.cmd==='settings') await openSettings();
  });
  refreshPanel();
}

async function clearReferences(ctx){
  const data = ensureConfig(ctx,false);
  data.workspaces = (data.workspaces || []).filter(w => !w.reference);
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
  function cp(src,dst){ const st=fs.statSync(src); if(st.isDirectory()){ fs.mkdirSync(dst,{recursive:true}); for(const e of fs.readdirSync(src)) cp(path.join(src,e), path.join(dst,e)); } else fs.copyFileSync(src,dst); }
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
  register(context,'devMate.openSettings',()=>openSettings());

  // Hidden compatibility aliases for older local builds.
  register(context,'devMate.quickStart',()=>quickStart(context));
  register(context,'devMate.oneClick',()=>quickStart(context));
  register(context,'devMate.openPanel',()=>openPanel(context));
  register(context,'devMate.openControlCenter',()=>openPanel(context));
  register(context,'devMate.copyMcpUrl',()=>copyUrl());
  register(context,'devMate.copyStarterPrompt',()=>copyStarterPrompt());
  register(context,'devMate.addReferenceWorkspace',()=>addReference(context));
  register(context,'devMate.showLogs',()=>output.show(true));
  register(context,'aiWorkspaceGateway.quickStart',()=>quickStart(context));
  register(context,'aiWorkspaceGateway.openPanel',()=>openPanel(context));
  register(context,'localAiGateway.quickStart',()=>quickStart(context));
  log(`Activated DevMate ${VERSION}`);
}
function deactivate(){ if(contextWriteTimer) clearTimeout(contextWriteTimer); contextWriteTimer=null; return stopAll(); }
module.exports = { activate, deactivate };
