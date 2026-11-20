const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {_electron}=require('playwright');
const project=path.resolve(__dirname,'..');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'luma-atelier-'));
const report={platform:process.platform,checks:[]},errors=[];
let app,page;
async function launch(){
  const executable=process.env.LUMA_TEST_EXECUTABLE;
  const args=['--no-sandbox','--disable-dev-shm-usage','--user-data-dir='+profile];
  if(!executable)args.push(project);
  app=await _electron.launch({executablePath:executable||require('electron'),args});
  page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));
  await page.waitForSelector('#setting-dioramaWorld',{state:'attached'});
  await app.evaluate(({screen})=>{screen.getCursorScreenPoint=()=>({x:1,y:850});});
  await page.evaluate(()=>window.island.pin(true));
  await page.waitForFunction(()=>isOpen && !openingMotion && themes.midnight);
}
const el=id=>page.locator('#'+id);
const settings=async patch=>page.evaluate(patch=>window.island.settings(patch),patch);
const current=async()=>page.evaluate(async()=>(await window.island.init()).settings);
const note=message=>{report.checks.push(message);console.log('PASS '+message);};
async function nav(tab,pane){
  await page.locator('[data-tab='+tab+']').click();
  if(pane)await page.locator('[data-settings-tab='+pane+']').click();
}
async function preview(){
  return page.evaluate(()=>document.getElementById('diorama-preview').toDataURL());
}
async function surface(){
  return page.evaluate(()=>canvas.toDataURL());
}
async function run(){
  await launch();
  await settings({waves:false,glow:false,persistHistory:false,hoverExpand:false,reducedMotion:true,resourceMode:'eco'});
  await nav('settings','materials');
  await el('diorama-preview').scrollIntoViewIfNeeded();
  await page.waitForFunction(()=>dioramaInView && !!dioramaPreviewKey);
  const baseline=await surface();
  await el('setting-dioramaLight').selectOption('dusk');
  await el('setting-dioramaEnabled').check();
  await page.waitForFunction(()=>settings.dioramaEnabled && !surfaceDirty);
  assert.notEqual(await surface(),baseline);
  const renders=[];
  for(const world of ['alpine','harbor','orbit']){
    await el('setting-dioramaWorld').selectOption(world);
    await el('diorama-preview').scrollIntoViewIfNeeded();
    await page.waitForFunction(world=>dioramaPreviewKey.startsWith(world+'/')&&!surfaceDirty,world);
    renders.push(await preview());
  }
  assert.equal(new Set(renders).size,3);
  const savedSeed=(await current()).dioramaSeed;
  await el('diorama-roll').click();await el('diorama-preview').scrollIntoViewIfNeeded();
  await page.waitForFunction(seed=>settings.dioramaSeed!==seed && dioramaPreviewKey.includes('/'+settings.dioramaSeed+'/'),savedSeed);
  assert.notEqual(await preview(),renders[2]);
  await settings({dioramaSeed:savedSeed});
  await page.waitForFunction(seed=>dioramaPreviewKey.includes('/'+seed+'/'),savedSeed);
  assert.equal(await preview(),renders[2]);
  await page.evaluate(async()=>{await window.island.pin(false);await window.island.expand(false);});
  await page.waitForFunction(()=>!isOpen&&!surfaceDirty&&!frameRequest&&!frameTimeout);
  const frozen=await page.evaluate(()=>[lastDrawTime,ctx.getImageData(0,0,1,1).data[3]]);
  await page.waitForTimeout(400);
  assert.deepEqual(await page.evaluate(()=>[lastDrawTime,ctx.getImageData(0,0,1,1).data[3]]),frozen);
  assert.equal(frozen[1],0);
  note('three rendered scenes, deterministic seed, compact alpha and parked eco renderer');
  await page.evaluate(()=>window.island.pin(true));
  await nav('settings','waves');
  await el('setting-edgeType').selectOption('drawn');
  await el('drawn-board').scrollIntoViewIfNeeded();
  await page.waitForFunction(()=>drawnEditing());
  const initial=(await current()).drawnFrames,board=el('drawn-board');
  const box=await board.boundingBox();
  await page.mouse.move(box.x+box.width*.24,box.y+box.height*.8);
  await page.mouse.down();await page.mouse.move(box.x+box.width*.75,box.y+box.height*.28,{steps:15});await page.mouse.up();
  let drawing=(await current()).drawnFrames;
  assert.ok(drawing[0].filter((n,i)=>n!==initial[0][i]).length>=3);
  await el('drawn-undo').click();
  assert.deepEqual((await current()).drawnFrames,initial);
  await page.locator('[data-drawn-frame="1"]').click();
  await board.focus();await page.keyboard.press('End');
  await page.waitForFunction(()=>settings.drawnFrames[1].includes(100));
  await el('drawn-duplicate').click();
  drawing=(await current()).drawnFrames;assert.deepEqual(drawing[1],drawing[2]);
  await el('drawn-scrub').fill('16');
  const visibleKnots=await page.evaluate(()=>drawnKnotsAt(performance.now()));
  assert.notDeepEqual(visibleKnots,await page.evaluate(()=>EdgeShapes.contourKnots(settings.drawnFrames,0)));
  assert.equal(await el('drawn-play').isDisabled(),true);
  await settings({resourceMode:'balanced',reducedMotion:false,dioramaMotion:false});
  await el('drawn-play').click();const a=await page.evaluate(()=>drawnPhase(performance.now()));
  await page.waitForTimeout(130);assert.notEqual(await page.evaluate(()=>drawnPhase(performance.now())),a);
  await nav('home');
  await page.waitForFunction(()=>!drawnEditing() && !drawnPlaying && drawnAnimating());
  note('mouse stroke, undo, keyboard editing, frame duplication, scrubbing and animated silhouette');
  await nav('settings','appearance');
  await el('appearance-name').fill('Сцена');await el('appearance-save').click();
  await page.waitForFunction(()=>settings.appearanceProfiles.length===1);
  const profileSettings=(await current()).appearanceProfiles[0].settings;
  assert.deepEqual(profileSettings.drawnFrames,drawing);assert.equal(profileSettings.dioramaWorld,'orbit');
  await nav('clipboard');
  await el('bench-toggle').click();
  const first='Первая https://one.example/a',second='Вторая https://two.example/b';
  await app.evaluate(({clipboard},text)=>clipboard.writeText(text),first);
  await page.waitForFunction(text=>history.some(v=>v.text===text),first);
  const row=page.locator('.clip-item').filter({hasText:first});
  await row.getByRole('button',{name:'Добавить запись в монтажную'}).click();
  await app.evaluate(({BrowserWindow},text)=>BrowserWindow.getAllWindows()[0].webContents.send('ocr',{text,hasLink:true}),second);
  await el('bench-ocr').click();await el('bench-preset').selectOption('preset/1');await el('bench-load').click();
  assert.equal(await el('bench-result').inputValue(),'https://one.example/a\nhttps://two.example/b');
  await page.locator('#bench-sources li').nth(1).getByRole('button',{name:'Поднять фрагмент'}).click();
  await el('bench-step').selectOption('numbers');await el('bench-add-step').click();
  const expected='1. https://two.example/b\n2. https://one.example/a';
  assert.equal(await el('bench-result').inputValue(),expected);
  await el('bench-name').fill('Мои ссылки');await page.locator('#bench-save button').click();
  await page.waitForFunction(()=>settings.textRecipes.length===1);
  await el('bench-copy').click();
  assert.equal(await app.evaluate(({clipboard})=>clipboard.readText()),expected);
  await el('bench-step').selectOption('json');await el('bench-add-step').click();
  assert.equal(await el('bench-copy').isDisabled(),true);assert.match(await el('bench-status').textContent(),/Шаг 4/);
  assert.equal(await app.evaluate(({clipboard})=>clipboard.readText()),expected);
  note('history, OCR input, ordered operations, named recipe, guarded errors and OS clipboard');
  await app.close();app=null;await launch();
  const restored=await current();
  assert.deepEqual(restored.drawnFrames,drawing);assert.equal(restored.dioramaSeed,savedSeed);
  assert.deepEqual(restored.textRecipes,[{name:'Мои ссылки',separator:'line',steps:['links','unique','numbers']}]);
  await nav('clipboard');await el('bench-toggle').click();
  assert.equal(await page.locator('#bench-sources li:not(.bench-empty)').count(),0);
  await el('bench-preset').selectOption('saved/Мои ссылки');await el('bench-load').click();
  await el('bench-input').fill(second);await el('bench-append').click();
  assert.equal(await el('bench-result').inputValue(),'1. https://two.example/b');
  assert.deepEqual(errors,[]);note('settings and recipes survive restart, source text stays out of recipes');
  report.result='passed';
}
run().catch(e=>{report.result='failed';report.error=e.stack;process.exitCode=1;console.error(e);}).finally(async()=>{
  if(app)await app.close();
  const destination=process.env.LUMA_TEST_REPORT||path.join(project,'artifacts','update-'+require('../package.json').version,'atelier.json');
  fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,JSON.stringify(report,null,2));
  fs.rmSync(profile,{recursive:true,force:true,maxRetries:3});
});
