import test from 'node:test';
import assert from 'node:assert/strict';
import { COPY_URL_ID, defaultConfig, validateConfig, readConfig, resolveSequence, tokenFromGesture, cycleIndex, normalizeSequence, normalizeHttpUrl, formatCopiedUrlToast } from '../src/core.js';
const v5Config=()=>{
  const c=defaultConfig();c.version=5;delete c.bindings.searchSessions;
  return c;
};
const v4Config=()=>{
  const c=v5Config();c.version=4;
  c.bindings.newSession='n';c.bindings.newBrowser='B';c.bindings.newTerminal='T';
  c.bindings.nextTab=']';c.bindings.previousTab='[';c.bindings.plugins='g p';
  return c;
};
const v3Config=()=>{
  const c=v4Config();c.version=3;
  c.bindings.previous='g a';
  delete c.bindings.plugins;delete c.bindings.schedules;
  return c;
};
const v2Config=()=>{
  const c=v3Config();c.version=2;
  c.bindings.nextTab='g t';c.bindings.previousTab='g T';
  return c;
};
const legacyConfig=()=>{
  const c=v2Config();c.version=1;
  delete c.bindings.newBrowser;delete c.bindings.newTerminal;delete c.bindings.closeTab;
  c.bindings.settings='Space s';c.bindings.autoNav='Space n';c.bindings.help='Space ?';
  return c;
};
test('f is added to every older schema without stealing custom keys or rewriting stored preferences',()=>{
  for(const make of [legacyConfig,v2Config,v3Config,v4Config,v5Config]) {
    const old=make();old.autoNavigate=false;old.bindings.enter='a';
    const raw=JSON.stringify(old),loaded=readConfig(raw);
    assert.equal(loaded.config.bindings.searchSessions,'f');
    assert.equal(loaded.config.bindings.enter,'a');assert.equal(loaded.config.autoNavigate,false);
    assert.equal(JSON.stringify(old),raw);
    old.bindings.files='f';
    const conflict=validateConfig(old);
    assert.equal(conflict.config.bindings.files,'f');assert.equal(conflict.config.bindings.searchSessions,'');
    assert.match(conflict.notice,/搜索会话/);
  }
});
test('session search can be reassigned or disabled, and a broken current schema is not repaired',()=>{
  const c=defaultConfig();
  assert.equal(resolveSequence(c.bindings,'','f').command,'searchSessions');
  c.bindings.searchSessions='g f';
  assert.equal(resolveSequence(validateConfig(c).config.bindings,'g','f').command,'searchSessions');
  c.bindings.searchSessions='';assert.equal(validateConfig(c).config.bindings.searchSessions,'');
  c.bindings.searchSessions='b';assert.match(validateConfig(c).error,/同时分配/);
  delete c.bindings.searchSessions;assert.match(validateConfig(c).error,/搜索会话缺少/);
});
test('invalid suffix cancels without executing the same standalone key',()=>{
  assert.deepEqual(resolveSequence(defaultConfig().bindings,'g','i'),{consume:true,prefix:'',command:undefined});
  assert.deepEqual(resolveSequence(defaultConfig().bindings,'n','w'),{consume:true,prefix:'',command:undefined});
});
test('escape is one layer at a time',()=>{
  assert.deepEqual(resolveSequence({},'g','Escape'),{consume:true,prefix:'',dismiss:false});
  assert.deepEqual(resolveSequence({},'n','Escape'),{consume:true,prefix:'',dismiss:false});
  assert.equal(resolveSequence({},'','Escape').dismiss,true);
});
test('prefixes and case-sensitive fullscreen binding survive configuration',()=>{
  const c=defaultConfig();assert.ok(validateConfig(c).config);
  assert.equal(resolveSequence(c.bindings,'','R').command,'fullscreen');
  assert.equal(resolveSequence(c.bindings,'','r').command,'right');
  assert.equal(resolveSequence(c.bindings,'g','b').command,'previous');
  assert.equal(resolveSequence(c.bindings,'g','e').command,'plugins');
  assert.equal(resolveSequence(c.bindings,'g','a').command,'schedules');
  assert.equal(tokenFromGesture({code:'Slash',shift:true}),'?');
});
test('duplicates and prefix shadowing are rejected before settings are saved',()=>{
  const c=defaultConfig();c.bindings.enter='t';assert.match(validateConfig(c).error,/同时分配/);
  c.bindings.enter='g';assert.match(validateConfig(c).error,/保留/);
  c.bindings.enter='n';assert.match(validateConfig(c).error,/保留/);
});
test('malformed and future settings do not silently overwrite stored preferences',()=>{
  assert.ok(readConfig('{').error);assert.ok(readConfig(JSON.stringify({...defaultConfig(),version:7})).error);
  assert.equal(readConfig(null).config.autoNavigate,true);
});
test('legacy autoHints is retired without losing custom bindings or automatic-navigation choice',()=>{
  const legacy={...legacyConfig(),autoNavigate:false,autoHints:true};
  legacy.bindings.enter='a';legacy.bindings.previous='g p';
  const loaded=readConfig(JSON.stringify(legacy));
  assert.equal(loaded.config.autoNavigate,false);
  assert.equal(loaded.config.bindings.enter,'a');assert.equal(loaded.config.bindings.previous,'g p');
  assert.equal('autoHints' in loaded.config,false);
  assert.deepEqual(readConfig(JSON.stringify(loaded.config)).config,loaded.config);
});
test('custom sequences and explicit unbinding work',()=>{
  const c=defaultConfig();c.bindings.enter='a';c.bindings.plugins='';c.bindings.previous='g p';c.bindings.files='';
  const v=validateConfig(c);assert.ok(v.config);
  assert.equal(resolveSequence(v.config.bindings,'','a').command,'enter');
  assert.equal(resolveSequence(v.config.bindings,'g','p').command,'previous');
  assert.equal(resolveSequence(v.config.bindings,'','e').consume,false);
  assert.equal(cycleIndex(3,0,-1),2);assert.equal(cycleIndex(0,-1,1),-1);
});
test('n prefix creates sessions and tools, single keys toggle tools, g navigates and Space is unclaimed',()=>{
  const {bindings}=defaultConfig();
  assert.deepEqual(resolveSequence(bindings,'','n'),{consume:true,prefix:'n'});
  assert.equal(resolveSequence(bindings,'n','c').command,'newSession');
  assert.equal(resolveSequence(bindings,'n','b').command,'newBrowser');
  assert.equal(resolveSequence(bindings,'n','t').command,'newTerminal');
  assert.equal(resolveSequence(bindings,'','B').consume,false);
  assert.equal(resolveSequence(bindings,'','T').consume,false);
  assert.equal(resolveSequence(bindings,'','b').command,'browser');
  assert.equal(resolveSequence(bindings,'','t').command,'terminal');
  assert.equal(resolveSequence(bindings,'','e').command,'files');
  assert.equal(resolveSequence(bindings,'','w').command,'closeTab');
  assert.equal(resolveSequence(bindings,'','W').consume,false);
  assert.equal(resolveSequence(bindings,'g','s').command,'settings');
  assert.equal(resolveSequence(bindings,'','Space').consume,false);
  assert.equal(resolveSequence(bindings,'','?').toggleHints,true);
  assert.equal(resolveSequence(bindings,'g','n').command,undefined);
  assert.equal(resolveSequence(bindings,'','N').consume,false);
});
test('older settings gain new-session without resetting preferences or rewriting input',()=>{
  const legacy=legacyConfig();delete legacy.bindings.newSession;
  legacy.autoNavigate=false;legacy.bindings.enter='a';legacy.bindings.files='';
  const raw=JSON.stringify(legacy),loaded=readConfig(raw);
  assert.equal(loaded.config.bindings.newSession,'n c');
  assert.equal(loaded.config.autoNavigate,false);
  for(const [id,key] of Object.entries(legacy.bindings))if(!['settings','autoNav','help','nextTab','previousTab','previous','newBrowser','newTerminal'].includes(id))assert.equal(loaded.config.bindings[id],key);
  assert.equal(loaded.config.bindings.previous,'g b');
  assert.equal(loaded.config.bindings.plugins,'g e');
  assert.equal(loaded.config.bindings.schedules,'g a');
  assert.equal(loaded.config.bindings.settings,'g s');
  assert.equal(JSON.stringify(legacy),raw);
});
test('new-session migration retires a custom single-key n with a notice and preserves explicit unbinding',()=>{
  const legacy=legacyConfig();delete legacy.bindings.newSession;legacy.bindings.enter=' n ';
  const result=readConfig(JSON.stringify(legacy));
  const loaded=result.config;
  assert.equal(loaded.bindings.enter,'');assert.equal(loaded.bindings.newSession,'');
  assert.match(result.notice,/原 n 已改为新建前缀/);
  assert.deepEqual(resolveSequence(loaded.bindings,'','n'),{consume:true,prefix:'n'});
  assert.equal(readConfig(JSON.stringify(loaded)).config.bindings.newSession,'');
  loaded.bindings.newSession='g n';
  assert.equal(readConfig(JSON.stringify(loaded)).config.bindings.newSession,'g n');
  assert.equal(resolveSequence(loaded.bindings,'g','n').command,'newSession');
});
test('new command migration does not accept other missing or malformed bindings',()=>{
  const legacy=legacyConfig();delete legacy.bindings.newSession;delete legacy.bindings.enter;
  assert.ok(validateConfig(legacy).error);
  const invalid=defaultConfig();invalid.bindings.newSession=null;
  assert.ok(validateConfig(invalid).error);
});
test('default v1 settings migrate without mutating stored input and are stable after saving',()=>{
  const legacy=legacyConfig(),raw=JSON.stringify(legacy),loaded=readConfig(raw);
  assert.deepEqual(loaded.config,defaultConfig());assert.equal(JSON.stringify(legacy),raw);
  assert.deepEqual(readConfig(JSON.stringify(loaded.config)).config,loaded.config);
  assert.equal('autoNav' in loaded.config.bindings,false);assert.equal('help' in loaded.config.bindings,false);
});
test('migration preserves custom g s, B and T instead of stealing them for new defaults',()=>{
  const c=legacyConfig();c.bindings.previous='g s';c.bindings.files='B';c.bindings.enter='T';
  const result=validateConfig(c),b=result.config.bindings;
  assert.equal(b.previous,'g s');assert.equal(b.files,'B');assert.equal(b.enter,'T');
  assert.equal(b.settings,'');assert.equal(b.newBrowser,'');assert.equal(b.newTerminal,'');
  assert.match(result.notice,/暂未绑定/);
});
test('custom and disabled settings bindings survive, retired Space customs become unbound with a notice',()=>{
  const c=legacyConfig();c.bindings.settings='g q';c.bindings.files='Space e';c.bindings.terminal='';
  const result=validateConfig(c);
  assert.equal(result.config.bindings.settings,'g q');assert.equal(result.config.bindings.files,'');
  assert.equal(result.config.bindings.terminal,'');assert.match(result.notice,/原 Space 组合已取消/);
  c.bindings.settings='';assert.equal(validateConfig(c).config.bindings.settings,'');
});
test('v2 rejects Space combinations, missing commands and malformed legacy configurations',()=>{
  const c=v2Config();c.bindings.settings='Space s';assert.ok(validateConfig(c).error);
  c.bindings.settings='g s';delete c.bindings.newBrowser;assert.ok(validateConfig(c).error);
  const old=legacyConfig();old.bindings.files='t';assert.ok(validateConfig(old).error);
  old.bindings.files='e';old.bindings.help=null;assert.ok(validateConfig(old).error);
});
test('older v2 preferences gain w without changing existing keys or stored input',()=>{
  const old=v2Config();delete old.bindings.closeTab;old.bindings.files='f';old.autoNavigate=false;
  const raw=JSON.stringify(old),result=readConfig(raw);
  assert.equal(result.config.bindings.closeTab,'w');assert.equal(result.config.autoNavigate,false);
  for(const [id,key] of Object.entries(old.bindings))if(!['nextTab','previousTab','previous','newSession','newBrowser','newTerminal'].includes(id))assert.equal(result.config.bindings[id],key);
  assert.equal(result.config.bindings.previous,'g b');
  assert.equal(JSON.stringify(old),raw);
});
test('v1 and v2 migration preserve custom w, disabled close and a custom close sequence',()=>{
  for(const old of [legacyConfig(),v2Config()]) {
    delete old.bindings.closeTab;old.bindings.files=' w ';
    const result=validateConfig(old);assert.equal(result.config.bindings.files,'w');
    assert.equal(result.config.bindings.closeTab,'');assert.match(result.notice,/暂未绑定/);
  }
  const config=defaultConfig();config.bindings.closeTab='';
  assert.equal(validateConfig(config).config.bindings.closeTab,'');
  config.bindings.closeTab='g w';
  assert.equal(resolveSequence(validateConfig(config).config.bindings,'g','w').command,'closeTab');
  config.bindings.closeTab=null;assert.ok(validateConfig(config).error);
});
test('Tab, Shift+Tab and g 1..9 switch tools directly and retire the old default sequences',()=>{
  const {bindings}=defaultConfig();
  assert.deepEqual(resolveSequence(bindings,'',tokenFromGesture({code:'Tab',shift:false})),{consume:true,prefix:'',command:'nextTab'});
  assert.deepEqual(resolveSequence(bindings,'',tokenFromGesture({code:'Tab',shift:true})),{consume:true,prefix:'',command:'previousTab'});
  for(let d=1;d<=9;d++) {
    assert.deepEqual(resolveSequence(bindings,'g',tokenFromGesture({code:`Digit${d}`,shift:false})),{consume:true,prefix:'',tabIndex:d-1});
    assert.deepEqual(resolveSequence(bindings,'n',String(d)),{consume:true,prefix:'',command:undefined});
  }
  assert.deepEqual(resolveSequence(bindings,'g',tokenFromGesture({code:'Digit0',shift:false})),{consume:true,prefix:'',command:undefined});
  const custom={...bindings,files:'g 1'};
  assert.deepEqual(resolveSequence(custom,'g','1'),{consume:true,prefix:'',command:'files'});
  assert.deepEqual(resolveSequence(custom,'g','2'),{consume:true,prefix:'',tabIndex:1});
  for(const code of ['BracketLeft','BracketRight']) {
    const token=tokenFromGesture({code,shift:true});
    assert.equal(token,'');assert.equal(resolveSequence(bindings,'',token).consume,false);
  }
  for(const key of ['t','T'])assert.equal(resolveSequence(bindings,'g',key).command,undefined);
  assert.equal(cycleIndex(4,3,1),0);assert.equal(cycleIndex(4,0,-1),3);
  assert.equal(cycleIndex(1,0,1),0);assert.equal(cycleIndex(1,0,-1),0);
});
test('v2 default tab keys migrate once without rewriting storage or resetting other preferences',()=>{
  const old=v2Config();old.autoNavigate=false;old.bindings.enter='a';old.bindings.files='';
  const raw=JSON.stringify(old),loaded=readConfig(raw);
  assert.equal(loaded.config.version,6);assert.equal(loaded.config.autoNavigate,false);
  assert.equal(loaded.config.bindings.nextTab,'Tab');assert.equal(loaded.config.bindings.previousTab,'Shift+Tab');
  assert.equal(loaded.config.bindings.enter,'a');assert.equal(loaded.config.bindings.files,'');
  assert.equal(JSON.stringify(old),raw);
  const saved=loaded.config;saved.bindings.nextTab='g t';saved.bindings.previousTab='g T';
  assert.deepEqual(readConfig(JSON.stringify(saved)).config,saved);
});
test('legacy custom or disabled tab bindings survive alongside newly migrated defaults',()=>{
  for(const make of [legacyConfig,v2Config]) {
    const old=make();old.bindings.nextTab='x';old.bindings.previousTab='';
    let loaded=validateConfig(old).config;
    assert.equal(loaded.bindings.nextTab,'x');assert.equal(loaded.bindings.previousTab,'');
    old.bindings.previousTab='g T';loaded=validateConfig(old).config;
    assert.equal(loaded.bindings.nextTab,'x');assert.equal(loaded.bindings.previousTab,'Shift+Tab');
    old.bindings.previousTab='g t';
    assert.equal(validateConfig(old).config.bindings.previousTab,'g t');
  }
});
test('bracket and Tab configuration supports reassignment, prefix suffixes and normal conflict validation',()=>{
  const c=defaultConfig();c.bindings.nextTab='';c.bindings.files=']';c.bindings.previousTab='g [';
  const result=validateConfig(c);assert.ok(result.config);
  assert.equal(resolveSequence(result.config.bindings,'',']').command,'files');
  assert.equal(resolveSequence(result.config.bindings,'g','[').command,'previousTab');
  assert.equal(normalizeSequence('⇧ Tab'),'Shift+Tab');
  assert.equal(normalizeSequence('shift + tab'),'Shift+Tab');
  assert.equal(normalizeSequence('tab'),'Tab');
  c.bindings.nextTab=']';assert.match(validateConfig(c).error,/同时分配/);
  for(const key of ['[]','{','}','g []']) {
    const invalid=defaultConfig();invalid.bindings.nextTab=key;assert.ok(validateConfig(invalid).error);
  }
});
test('migration validates old data before replacing tab defaults and never repairs a corrupt v3, v4 or v5',()=>{
  const invalid=v2Config();invalid.bindings.files='g t';const raw=JSON.stringify(invalid);
  assert.ok(readConfig(raw).error);assert.equal(JSON.stringify(invalid),raw);
  invalid.bindings.files='[';assert.ok(validateConfig(invalid).error);
  const brokenV3=v3Config();delete brokenV3.bindings.closeTab;assert.ok(validateConfig(brokenV3).error);
  const dupV3=v3Config();dupV3.bindings.files='g a';assert.ok(validateConfig(dupV3).error);
  const brokenV4=v4Config();delete brokenV4.bindings.plugins;assert.ok(validateConfig(brokenV4).error);
  for(const missing of ['closeTab','plugins','schedules']) {
    const current=defaultConfig();delete current.bindings[missing];assert.ok(validateConfig(current).error);
  }
});
test('v3 and v4 migrate cleanly to current defaults and allow deliberate reassignment',()=>{
  for(const make of [v3Config,v4Config]) {
    const old=make();old.autoNavigate=false;
    const raw=JSON.stringify(old),loaded=readConfig(raw);
    assert.equal(loaded.notice,undefined);assert.equal(loaded.config.version,6);assert.equal(loaded.config.autoNavigate,false);
    assert.equal(loaded.config.bindings.newSession,'n c');
    assert.equal(loaded.config.bindings.newBrowser,'n b');
    assert.equal(loaded.config.bindings.newTerminal,'n t');
    assert.equal(loaded.config.bindings.nextTab,'Tab');
    assert.equal(loaded.config.bindings.previousTab,'Shift+Tab');
    assert.equal(loaded.config.bindings.previous,'g b');
    assert.equal(loaded.config.bindings.plugins,'g e');
    assert.equal(loaded.config.bindings.schedules,'g a');
    assert.equal(JSON.stringify(old),raw);
  }
  const saved=defaultConfig();saved.bindings.plugins='g p';saved.bindings.newBrowser='B';saved.bindings.nextTab=']';
  assert.deepEqual(readConfig(JSON.stringify(saved)).config,saved);
});
test('v1–v4 migration preserves custom g e, g a, g b, g p and explicit unbinding with clear notices',()=>{
  for(const make of [legacyConfig,v2Config,v3Config]) {
    const customE=make();customE.bindings.files='g e';
    const r1=validateConfig(customE);
    assert.equal(r1.config.bindings.files,'g e');assert.equal(r1.config.bindings.plugins,'');
    assert.equal(r1.config.bindings.previous,'g b');assert.equal(r1.config.bindings.schedules,'g a');
    assert.match(r1.notice,/g e 已有自定义用途/);

    const customA=make();customA.bindings.previous='';customA.bindings.files='g a';
    const r2=validateConfig(customA);
    assert.equal(r2.config.bindings.previous,'');assert.equal(r2.config.bindings.files,'g a');
    assert.equal(r2.config.bindings.plugins,'g e');assert.equal(r2.config.bindings.schedules,'');
    assert.match(r2.notice,/g a 已有自定义用途/);

    const customB=make();customB.bindings.files='g b';
    const r3=validateConfig(customB);
    assert.equal(r3.config.bindings.files,'g b');assert.equal(r3.config.bindings.previous,'');
    assert.equal(r3.config.bindings.plugins,'g e');assert.equal(r3.config.bindings.schedules,'g a');
    assert.match(r3.notice,/g b 已有自定义用途/);
  }
  const customV4=v4Config();
  customV4.bindings.files='g e';customV4.bindings.newBrowser='x';customV4.bindings.nextTab='';
  const r4=validateConfig(customV4);
  assert.equal(r4.config.bindings.files,'g e');assert.equal(r4.config.bindings.plugins,'');
  assert.equal(r4.config.bindings.newBrowser,'x');assert.equal(r4.config.bindings.nextTab,'');
  assert.equal(r4.config.bindings.previousTab,'Shift+Tab');
  assert.match(r4.notice,/g e 已有自定义用途/);
});
test('Chinese IME full-width punctuation normalizes cleanly in binding configuration',()=>{
  const c=defaultConfig();
  c.bindings.previousTab='【';
  c.bindings.nextTab='】';
  c.bindings.files='g 「';
  c.bindings.previous='g ？';
  const r=validateConfig(c);
  assert.ok(r.config);
  assert.equal(r.config.bindings.previousTab,'[');
  assert.equal(r.config.bindings.nextTab,']');
  assert.equal(r.config.bindings.files,'g [');
  assert.equal(r.config.bindings.previous,'g ?');
  const reserved=defaultConfig();reserved.bindings.files='？';
  assert.match(validateConfig(reserved).error,/保留/);
});
test('browser URL normalization and copied toast formatting handle HTTP(S) and ignore non-web addresses',()=>{
  assert.equal(COPY_URL_ID,'shortcutter.copyUrl');
  assert.equal(normalizeHttpUrl('https://github.com/bywangdong/dsh-shortcutter'),'https://github.com/bywangdong/dsh-shortcutter');
  assert.equal(normalizeHttpUrl(' http://localhost:3000/path?a=1 '),'http://localhost:3000/path?a=1');
  assert.equal(normalizeHttpUrl('about:blank#lease-1'),'');
  assert.equal(normalizeHttpUrl('javascript:alert(1)'),'');
  assert.equal(normalizeHttpUrl('file:///Users/nick/test.html'),'');
  assert.equal(normalizeHttpUrl('draft'),'');
  assert.equal(normalizeHttpUrl(''),'');
  assert.equal(formatCopiedUrlToast('https://github.com/bywangdong/dsh-shortcutter'),'已复制网址 · github.com');
  assert.equal(formatCopiedUrlToast('http://localhost:3000/app'),'已复制网址 · localhost:3000');
  assert.equal(formatCopiedUrlToast('not-a-url'),'已复制当前网址');
});
