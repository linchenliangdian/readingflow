/* Finite tag migration and native transaction checks in a disposable profile. */
const expectedProfile=__EXPECTED_PROFILE__, expectedData=__EXPECTED_DATA__, resultPath=__RESULT_PATH__, stages=__PACKAGE_STAGES__;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function runSmokeTest(){
  const result={status:'running',scenario:'untagged-native-notes',checks:[],startedAt:new Date().toISOString()};
  let safe=false;
  const check=(name,condition,detail=null)=>{result.checks.push({name,passed:!!condition,detail});if(!condition)throw new Error('Failed: '+name);};
  async function waitFor(test,label){const until=Date.now()+30000;while(Date.now()<until){const value=await test();if(value)return value;await delay(100);}throw new Error('Timeout: '+label);}
  async function lifecycle(action,methods){
    const owner=Zotero.Plugins._addonObserver,wrapped=[],calls=[];
    for(const method of methods){const original=owner[method],wrapper=function(addon,...args){const value=original.call(this,addon,...args);if(addon.id==='reading-flow@local'){const call={done:false,error:null};calls.push(call);Promise.resolve(value).then(()=>call.done=true,error=>{call.done=true;call.error=error;});}return value;};owner[method]=wrapper;wrapped.push({method,original,wrapper});}
    try{await action();await waitFor(()=>calls.length&&calls.every(call=>call.done),'native lifecycle');const failed=calls.find(call=>call.error);if(failed)throw failed.error;}finally{for(const {method,original,wrapper}of wrapped)if(owner[method]===wrapper)owner[method]=original;}
  }
  async function install(stage){const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');const before=Zotero.ReadingFlow;const installation=await AddonManager.getInstallForFile(Zotero.File.pathToFile(stage.path));check(stage.version+' package accepted',!installation.error);await lifecycle(()=>installation.install(),['onInstalled','onEnabling']);const addon=await AddonManager.getAddonByID('reading-flow@local');const api=await waitFor(()=>Zotero.ReadingFlow&&Zotero.ReadingFlow!==before&&Zotero.ReadingFlow,'updated API');check(stage.version+' active',addon.isActive&&addon.version===stage.version);return {addon,api};}
  async function open(api,item,host){const handle=await api.openItem(item.id,host);await waitFor(()=>handle.editor.getCurrentInstance(),'native editor');await handle.editor.getCurrentInstance()._initPromise;return handle;}
  async function article(title){const item=new Zotero.Item('journalArticle');item.libraryID=Zotero.Libraries.userLibraryID;item.setField('title',title);await item.saveTx();return item;}
  try{
    await Zotero.initializationPromise;
    check('verified isolated profile and data',PathUtils.normalize(Zotero.Profile.dir)===PathUtils.normalize(expectedProfile)&&PathUtils.normalize(Zotero.DataDirectory.dir)===PathUtils.normalize(expectedData));safe=true;
    const host=await waitFor(()=>Zotero.getMainWindow(),'main window');await waitFor(()=>host.ZoteroPane?.itemsView&&host.ZoteroPane.collectionsView?.itemTreeView,'bound trees');await host.ZoteroPane.itemsView.waitForLoad();
    const a=await article('Synthetic existing tagged reading note'),b=await article('Synthetic new untagged reading note'),c=await article('Synthetic binding failure note');
    await host.ZoteroPane.selectItems([a.id],{noWindowRestore:true});const old=await install(stages[0]);let handle=await open(old.api,a,host);const note=handle.note;
    check('old version actually creates both legacy labels',note.hasTag('Reading Flow')&&note.hasTag('Reading Flow · sidebar'));
    const instance=handle.editor.getCurrentInstance(),frame=instance._iframeWindow.wrappedJSObject||instance._iframeWindow;instance._postMessage({action:'insertHTML',pos:-1,html:'<p>Original reading prose stays intact.</p>'});
    await waitFor(()=>frame.getDataSync(false)?.html?.includes('Original reading prose stays intact.'),'native prose insertion');await instance._save(JSON.parse(JSON.stringify(frame.getDataSync(false))));
    note.addTag('Personal research',1);await note.saveTx();const originalHTML=note.getNote();
    const state=handle.getState();state.pyramid.text='Existing reasoning remains linked';await handle.toolsWindow.ReadingFlowApp.loadConfig({...handle.config,initialState:state});await handle.config.bridge.flushState(state);
    const updated=await install(stages[1]);handle=await open(updated.api,a,host);await note.loadDataType('tags');
    check('upgrade removes only the two automatic labels',!note.hasTag('Reading Flow')&&!note.hasTag('Reading Flow · sidebar')&&note.getTags().length===1&&note.getTags()[0].tag==='Personal research'&&note.getTags()[0].type===1);
    check('upgrade preserves the exact prose note, body, and pyramid',handle.note.id===note.id&&note.getNote()===originalHTML&&handle.getState().pyramid.text==='Existing reasoning remains linked',{sameNote:handle.note.id===note.id,sameBody:note.getNote()===originalHTML,pyramid:handle.getState().pyramid.text});
    const fresh=await open(updated.api,b,host);await fresh.note.loadDataType('tags');check('new reading notes have no automatic tags',fresh.note.getTags().length===0);
    const cache=PathUtils.join(expectedData,'reading-flow',c.libraryID+'-'+c.key+'.json'),blocked=cache+'.tmp';await IOUtils.makeDirectory(blocked,{ignoreExisting:false});
    let failed=false;try{await updated.api.openItem(c.id,host);}catch(_){failed=true;}
    await c.reload(['childItems'],true);check('native draft failure rolls back the newly created untagged note',failed&&c.getNotes().length===0&&!await IOUtils.exists(cache));
    await IOUtils.remove(blocked);const retried=await open(updated.api,c,host);await c.reload(['childItems'],true);check('retry creates one untagged note with a durable key',c.getNotes().length===1&&retried.note.getTags().length===0&&JSON.parse(await IOUtils.readUTF8(cache)).noteKey===retried.note.key);
    await lifecycle(()=>updated.addon.disable(),['onDisabled']);await lifecycle(()=>updated.addon.enable(),['onEnabling']);const active=await waitFor(()=>Zotero.ReadingFlow,'re-enabled API');handle=await open(active,a,host);
    check('reopening without legacy tags retains the same note and personal label',handle.note.id===note.id&&note.getNote()===originalHTML&&note.getTags().length===1&&note.getTags()[0].tag==='Personal research');
    result.fixture={oldNoteKey:note.key,oldHTML:originalHTML,newNoteKey:fresh.note.key,retryNoteKey:retried.note.key};result.status='passed';
  }catch(error){result.status='failed';result.error={message:error.message||String(error),stack:error.stack||null};Zotero.logError(error);}
  finally{result.finishedAt=new Date().toISOString();await IOUtils.writeUTF8(resultPath,JSON.stringify(result,null,2),{tmpPath:resultPath+'.tmp'});delete Zotero.__readingFlowSmokePromise;delete Zotero.__readingFlowSmokeSandbox;if(safe)Services.startup.quit(Components.interfaces.nsIAppStartup.eAttemptQuit);}
}
