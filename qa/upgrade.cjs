const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process'),{chromium}=require('playwright'),net=require('node:net');
const here=__dirname, runtime=path.resolve('runtime'), payload=path.resolve('previous-package/update-payload');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'luma-upgrade-'));
const exe=path.join(runtime,'Luma Island.exe'),version=process.env.APP_VERSION;
const desktopEnv={...process.env};
// The GitHub runner's parent is PowerShell 7. An Explorer-launched desktop
// application does not inherit that shell's PS7-only module search path.
for(const key of Object.keys(desktopEnv))if(key.toLowerCase()==='psmodulepath')delete desktopEnv[key];
const sha=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
async function waitFor(read,limit) {
  const end=Date.now()+limit;
  while(Date.now()<end){const result=await read();if(result)return result;await new Promise(resolve=>setTimeout(resolve,400));}
  throw Error('Timed out waiting for the signed application handoff');
}
function json(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}}
let old,browser,healthyPid,releaseIssue='',oldStderr='';
async function run(){
  assert.equal(process.platform,'win32');
  const ps=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
  const command="$ErrorActionPreference='Stop'; (Get-Command Get-FileHash).Source";
  const check=spawnSync(ps,['-NoProfile','-NonInteractive','-Command',command],{env:desktopEnv,encoding:'utf8'});
  assert.equal(check.status,0,check.stderr);console.log('Desktop PowerShell module',check.stdout.trim());
  const base=require('./baseline.json'), stock=fs.readFileSync(path.join(runtime,'electron.exe'));
  assert.equal(sha(stock),base.stock);
  for(const piece of base.patches)Buffer.from(piece.data,'base64').copy(stock,piece.offset);
  assert.equal(sha(stock),base.previous);fs.writeFileSync(exe,stock);
  if(!fs.existsSync(path.join(runtime,'LICENSE.electron.txt')))fs.copyFileSync(path.join(runtime,'LICENSE'),path.join(runtime,'LICENSE.electron.txt'));
  fs.mkdirSync(path.join(runtime,'resources/native'),{recursive:true});
  for(const [name,target] of [['app.asar','resources/app.asar'],['Island.Native.exe','resources/native/Island.Native.exe']]){
    fs.copyFileSync(path.join(payload,name),path.join(runtime,target));
  }
  const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));
  fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({theme:'sage',updateCheckOnLaunch:false,hoverExpand:false,reducedMotion:true}));
  // A main-process Node inspector can keep Electron alive at app.quit().
  // Only attach to the renderer of an otherwise normal Windows launch.
  old=spawn(exe,['--user-data-dir='+profile,'--disable-gpu','--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port],{env:desktopEnv,stdio:['ignore','ignore','pipe']});
  old.stderr.on('data',data=>{oldStderr=(oldStderr+data.toString()).slice(-2000);});
  old.on('exit',(code,signal)=>console.log('Previous process exit',code,signal));
  const url='http://127.0.0.1:'+port;
  await waitFor(async()=>{try{return(await fetch(url+'/json/version')).ok;}catch{return false;}},35000);
  browser=await chromium.connectOverCDP(url);
  const page=await waitFor(()=>browser.contexts()[0]?.pages().find(p=>p.url().includes('/renderer/index.html')),35000);
  await page.waitForSelector('#version-badge',{state:'attached'});
  const state=await page.evaluate(()=>window.island.init());
  assert.equal(state.version,'1.6.0');assert.equal(state.settings.theme,'sage');
  page.on('console',msg=>{
    const s=msg.text();
    if(s.startsWith('LUMA-STAGE ')){
      console.log(s);
      const ev=JSON.parse(s.slice(11));
      if(ev.status==='error'||ev.status==='available'&&ev.failed)releaseIssue=ev.message;
    }
  });
  await page.evaluate(()=>{
    let began=false,last='';
    window.island.on('updater',v=>{
      if(v.status==='downloading')began=true;
      if(last!==v.status){last=v.status;console.log('LUMA-STAGE '+JSON.stringify({status:v.status,message:v.message,failed:began&&v.status==='available'}));}
    });
  });
  await page.evaluate(async()=>{await window.island.settings({theme:'ocean',resourceMode:'eco',hoverExpand:false});await window.island.pin(true);});
  await page.locator('[data-tab=settings]').click();
  await page.locator('[data-settings-tab=more]').click();
  await page.locator('#update-check').click();
  await page.waitForFunction(v=>updateViewState.status==='available'&&updateViewState.availableVersion===v,version,{timeout:65000});
  await page.locator('#update-install').click();
  let lastSnapshot='';
  const handoff=await waitFor(()=>{
    if(releaseIssue)throw Error(releaseIssue);
    const active=json(path.join(profile,'active-version.json'));
    const updates=path.join(profile,'updates');if(!fs.existsSync(updates))return;
    for(const dir of fs.readdirSync(updates)){
      const stage=path.join(profile,'updates',dir),status=json(path.join(stage,'handoff.json'));
      const snapshot=JSON.stringify({files:fs.readdirSync(stage).sort(),status:status?.status,active:active?.envelope?.payload?.version});
      if(snapshot!==lastSnapshot){lastSnapshot=snapshot;console.log('Handoff files',snapshot);}
      if(status?.status==='rolled-back'||status?.status==='error')throw Error(JSON.stringify(status));
      if(active?.envelope?.payload?.version===version&&status?.status==='started'&&json(path.join(stage,'healthy.json'))?.version===version)return {active,status};
    }
  },155000);
  healthyPid=handoff.status.pid;
  console.log('Windows handoff started; health receipt verified');
  assert.equal(json(path.join(profile,'settings.json')).theme,'ocean');
  assert.equal(sha(fs.readFileSync(handoff.active.exePath)),handoff.active.envelope.payload.target.exeSha256);
  assert.equal(sha(fs.readFileSync(exe)),base.previous);
  // This is the child started in the disposable runner profile. Close it before
  // starting the independent UI exercise with its own profile.
  process.kill(healthyPid);healthyPid=null;old=null;
  const result=spawnSync(process.execPath,[path.join(here,'electron.atelier.cjs')],{stdio:'inherit',env:{
    ...desktopEnv,LUMA_TEST_EXECUTABLE:handoff.active.exePath,LUMA_TEST_REPORT:path.resolve('ui-170.json'),
  }});
  assert.equal(result.status,0);assert.equal(json('ui-170.json').result,'passed');
  console.log(JSON.stringify({result:'passed',sourceVersion:'1.6.0',version,platform:process.platform,
    previousExePreserved:true,handoff:'started',settingsPreserved:true,productionWindow:true,
    featureChecks:json('ui-170.json').checks.length}));
}
run().catch(e=>{console.error(e,oldStderr);process.exitCode=1;}).finally(async()=>{
  if(healthyPid)try{process.kill(healthyPid);}catch{}
  if(browser?.isConnected())await browser.close().catch(()=>{});
  if(old&&old.exitCode===null)old.kill();
});
