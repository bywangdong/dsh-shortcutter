import test from 'node:test';
import assert from 'node:assert/strict';
import { indexSessionRows, sessionSearchRows } from '../src/session-search.js';

const fixtures = () => ({
  sessions: { phase: 'ready', ids: ['a', 'b', 'c', 'archived', 'child', 'blank', 'fork', 'missing'], byId: {
    a: { displayTitle: '中文输入法修复', updatedAt: 10, cwd: '/wrong/project' },
    b: { title: 'Browser keyboard navigation', updatedAt: 20, cwd: '/work/Browser/' },
    c: { displayTitle: '<img onerror=alert(1)>', updatedAt: 5 },
    archived: { displayTitle: 'Archived', updatedAt: 40 },
    child: { displayTitle: 'Child', origin: 'subagent', updatedAt: 50 },
    blank: { displayTitle: '新会话', blank: true, updatedAt: 60 },
    fork: { title: 'Fork', parentId: 'a', updatedAt: 1 },
    retained: { displayTitle: 'Retained subagent', updatedAt: 70 }
  } },
  workspaces: { phase: 'ready', items: [{ title: 'Shortcutter', sessionIds: ['a'], path: '/other' }], archivedSessionIds: ['archived'] }
});
test('only openable host-catalog sessions appear; real forks remain, blank and subagent rows do not',()=>{
  const {sessions,workspaces}=fixtures();
  assert.deepEqual(sessionSearchRows(sessions,workspaces).map(row=>row.id),['b','a','c','fork']);
  assert.equal(sessionSearchRows(sessions,workspaces,{current:'blank'})[0].id,'blank');
  sessions.projectionsBySession={a:{values:{subagentCatalog:[{id:'c'}]}}};
  assert.equal(sessionSearchRows(sessions,workspaces).some(row=>row.id==='c'),false);
});
test('Chinese, case, full-width letters, and multiple title/workspace terms match literal metadata',()=>{
  const {sessions,workspaces}=fixtures();
  const search=indexSessionRows(sessionSearchRows(sessions,workspaces));
  assert.deepEqual(search('  ＳＨＯＲＴＣＵＴＴＥＲ  中文 ').map(row=>row.id),['a']);
  assert.deepEqual(search('KEYBOARD').map(row=>row.id),['b']);
  assert.equal(search('wrong').length,0,'Workspace membership wins over the cwd fallback');
  assert.equal(search('navigation')[0].workspace,'Browser');
  assert.equal(search('[.*]').length,0,'Queries are not regular expressions');
  assert.equal(search('<img')[0].title,'<img onerror=alert(1)>','HTML remains text for React to escape');
});
test('fuzzy title and workspace matching ranks direct hits first and preserves recency on ties', () => {
  const rows = [
    { id: 'project', title: '会话搜索设置', workspace: 'ProxyTool' },
    { id: 'title', title: 'ProxyTool', workspace: 'work' },
    { id: 'prefix', title: 'pt notes', workspace: 'work' }
  ];
  const search = indexSessionRows(rows);
  assert.deepEqual(search('  '), rows);
  assert.deepEqual(search('pt').map(row => [row.id, row.workspaceMatch]), [['prefix', false], ['project', true], ['title', false]]);
  assert.deepEqual(search('搜设').map(row => row.id), ['project']);
  assert.deepEqual(search('搜设 pt').map(row => [row.id, row.workspaceMatch]), [['project', true]]);
});
test('recent visits lead, remaining rows use update time, and search never mutates stores',()=>{
  const {sessions,workspaces}=fixtures();
  const before=JSON.stringify({sessions,workspaces});
  const rows=sessionSearchRows(sessions,workspaces,{current:'c',history:['c','a','gone']});
  assert.deepEqual(rows.map(row=>row.id),['c','a','b','fork']);
  assert.equal(rows[0].current,true);assert.equal(rows[0].recent,true);assert.equal(rows[2].recent,false);
  assert.equal(JSON.stringify({sessions,workspaces}),before);
});
test('incomplete archive/catalog snapshots yield no unsafe early results, and live changes are respected',()=>{
  const {sessions,workspaces}=fixtures();
  assert.deepEqual(sessionSearchRows({...sessions,phase:'pending'},workspaces),[]);
  assert.deepEqual(sessionSearchRows(sessions,{...workspaces,phase:'pending'}),[]);
  workspaces.archivedSessionIds.push('a');
  assert.equal(indexSessionRows(sessionSearchRows(sessions,workspaces))('中文').length,0);
  sessions.byId.b={...sessions.byId.b,displayTitle:'Renamed'};
  assert.equal(indexSessionRows(sessionSearchRows(sessions,workspaces))('navigation').length,0);
});
