const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process'),{_electron}=require('playwright');
const here=__dirname, runtime=path.resolve('runtime'), payload=path.resolve('previous-package/update-payload');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'luma-upgrade-'));
const exe=path.join(runtime,'Luma Island.exe'),version=process.env.APP_VERSION;
const sha=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
async function waitFor(read,limit) {
  const end=Date.now()+limit;
  while(Date.now()<end){const result=read();if(result)return result;await new Promise(resolve=>setTimeout(resolve,400));}
  throw Error('Timed out waiting for the signed application handoff');
}
function json(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}}
let old,healthyPid;
async function run(){
  assert.equal(process.platform,'win32');
  const base=require('./baseline.json'), stock=fs.readFileSync(path.join(runtime,'electron.exe'));
  assert.equal(sha(stock),base.stock);
  for(const piece of base.patches)Buffer.from(piece.data,'base64').copy(stock,piece.offset);
  assert.equal(sha(stock),base.previous);fs.writeFileSync(exe,stock);
  if(!fs.existsSync(path.join(runtime,'LICENSE.electron.txt')))fs.copyFileSync(path.join(runtime,'LICENSE'),path.join(runtime,'LICENSE.electron.txt'));
  fs.mkdirSync(path.join(runtime,'resources/native'),{recursive:true});
  for(const [name,target] of [['app.asar','resources/app.asar'],['Island.Native.exe','resources/native/Island.Native.exe']]){
    fs.copyFileSync(path.join(payload,name),path.join(runtime,target));
  }
  old=await _electron.launch({executablePath:exe,args:['--user-data-dir='+profile,'--disable-gpu'],timeout:60000});
  const page=await old.firstWindow();
  await page.waitForSelector('#version-badge',{state:'attached'});
  assert.equal(await old.evaluate(({app})=>app.getVersion()),'1.6.0');
  assert.equal(path.resolve(await old.evaluate(({app})=>app.getPath('userData'))).toLowerCase(),path.resolve(profile).toLowerCase());
  await page.evaluate(async()=>{await window.island.settings({theme:'ocean',resourceMode:'eco',hoverExpand:false});await window.island.pin(true);});
  await page.locator('[data-tab=settings]').click();
  await page.locator('[data-settings-tab=more]').click();
  await page.locator('#update-check').click();
  await page.waitForFunction(v=>updateViewState.status==='available'&&updateViewState.availableVersion===v,version,{timeout:65000});
  await page.locator('#update-install').click();
  const handoff=await waitFor(()=>{
    const active=json(path.join(profile,'active-version.json'));
    if(!active||active.envelope?.payload?.version!==version)return;
    for(const dir of fs.readdirSync(path.join(profile,'updates'))){
      const stage=path.join(profile,'updates',dir),status=json(path.join(stage,'handoff.json'));
      if(status?.status==='rolled-back'||status?.status==='error')throw Error(JSON.stringify(status));
      if(status?.status==='started'&&json(path.join(stage,'healthy.json'))?.version===version)return {active,status};
    }
  },180000);
  healthyPid=handoff.status.pid;
  assert.equal(json(path.join(profile,'settings.json')).theme,'ocean');
  assert.equal(sha(fs.readFileSync(handoff.active.exePath)),handoff.active.envelope.payload.target.exeSha256);
  assert.equal(sha(fs.readFileSync(exe)),base.previous);
  // This is the child started in the disposable runner profile. Close it before
  // starting the independent UI exercise with its own profile.
  process.kill(healthyPid);healthyPid=null;old=null;
  const result=spawnSync(process.execPath,[path.join(here,'electron.atelier.cjs')],{stdio:'inherit',env:{
    ...process.env,LUMA_TEST_EXECUTABLE:handoff.active.exePath,LUMA_TEST_REPORT:path.resolve('ui-170.json'),
  }});
  assert.equal(result.status,0);assert.equal(json('ui-170.json').result,'passed');
  console.log(JSON.stringify({result:'passed',sourceVersion:'1.6.0',version,platform:process.platform,
    previousExePreserved:true,handoff:'started',settingsPreserved:true,productionWindow:true,
    featureChecks:json('ui-170.json').checks.length}));
}
run().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
  if(healthyPid)try{process.kill(healthyPid);}catch{}
  if(old)await old.close().catch(()=>{});
});
