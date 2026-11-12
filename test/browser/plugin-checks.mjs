import assert from 'node:assert/strict';

export async function pluginChecks(createPage) {
  const results = [];
  const settle = page => page.waitForTimeout(60);
  const ready = page => page.waitForFunction(() => window.pluginState().pending === undefined && document.activeElement.id === 'sc-navigation-anchor', null, { timeout: 2500 });
  const key = (page, code, extra = {}) => page.evaluate(({ code, extra }) => window.fixture.emitKey({ code, ...extra }), { code, extra });
  const freezeClock = async page => {
    await page.clock.install();
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
  };
  const advance = async (page, ms) => { await page.clock.runFor(ms); await settle(page); };
  const unfocusedWebview = async page => {
    await ready(page);
    await page.evaluate(() => {
      const view = document.createElement('webview');
      view.dataset.sidebarBrowserFrame = ''; view.tabIndex = 0;
      view.style.cssText = 'display:block;width:200px;height:80px';
      document.querySelector('[data-dockkit-pane]').append(view); view.focus();
      window.testWebview = view; window.outerFocused = false; window.outerFocusCalls = 0;
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => window.outerFocused });
      window.focus = () => {
        window.outerFocusCalls++;
        setTimeout(() => { window.outerFocused = true; window.dispatchEvent(new Event('focus')); }, 0);
      };
      window.dispatchEvent(new Event('blur'));
    });
    await settle(page);
  };
  async function check(name, run, options = {}) {
    const page = await createPage(options);
    try { await run(page); results.push({ name, pass: true }); }
    catch (error) { results.push({ name, pass: false, error: String(error) }); }
    finally { await page.close(); }
  }
  await check('initial ready session takes navigation once quietly and releases the session subscription', async page => {
    await ready(page);
    await page.waitForTimeout(600);
    assert.equal(await page.locator('.sc-panel').count(), 0, 'App start is passive navigation');
    assert.equal(await page.evaluate(() => window.fixture.session.listenerCount()), 0);
    await page.locator('#composer').focus(); await settle(page);
    await page.evaluate(() => window.fixture.session.set({ openState: 'open', running: true })); await settle(page);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'composer');
  });
  await check('cold session waits for openState, ignores unrelated updates, then completes the handoff', async page => {
    assert.ok(await page.evaluate(() => window.pluginState().pending));
    assert.equal(await page.evaluate(() => window.fixture.session.listenerCount()), 1);
    await page.evaluate(async () => {
      window.counts = {};
      for (let i = 0; i < 10; i++) { window.fixture.session.set({ openState: 'loading', running: false, loadingOlder: !!(i % 2) }); await new Promise(resolve => setTimeout(resolve, 5)); }
    }); await settle(page);
    assert.equal(await page.evaluate(() => window.counts.panelRender || 0), 0);
    await page.evaluate(() => window.fixture.session.set({ openState: 'open', running: false })); await ready(page);
    assert.equal(await page.evaluate(() => window.fixture.session.listenerCount()), 0);
  }, { openState: 'loading' });
  await check('session error readiness also completes the one-shot handoff', async page => {
    await page.evaluate(() => window.fixture.session.set({ openState: 'error', running: false })); await ready(page);
  }, { openState: 'loading' });
  await check('input, repeat, composing, modified and already-handled keys preserve the draft without scans', async page => {
    await ready(page); await page.locator('#composer').focus(); await settle(page);
    const result = await page.evaluate(() => {
      const input = document.getElementById('composer'); input.setSelectionRange(1, 3); window.counts = {};
      const consumed = [{}, { repeat: true }, { composing: true }, { meta: true }, { control: true }, { alt: true }, { defaultPrevented: true }]
        .map(flags => window.fixture.emitKey({ code: 'KeyG', ...flags }));
      return { consumed, reads: window.counts.navigationRead || 0, text: input.value, start: input.selectionStart, end: input.selectionEnd };
    });
    assert.deepEqual(result, { consumed: Array(7).fill(false), reads: 0, text: 'draft', start: 1, end: 3 });
  });
  await check('unclaimed Escape returns from the conversation input and previews help only after a pause', async page => {
    await ready(page); await freezeClock(page); await page.locator('#composer').focus(); await advance(page, 50);
    assert.equal(await key(page, 'Escape'), true); await advance(page, 100); await ready(page);
    assert.equal(await page.locator('.sc-panel').count(), 0);
    await advance(page, 400);
    assert.equal(await page.locator('.sc-panel').count(), 1);
  });
  await check('running conversation retains the native double-Escape path', async page => {
    await ready(page); await page.locator('#composer').focus();
    await page.evaluate(() => window.fixture.session.set({ openState: 'open', running: true })); await settle(page);
    assert.equal(await key(page, 'Escape'), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'composer');
  });
  await check('g prefix waits before showing, help toggles at once and Escape cancels both', async page => {
    await ready(page); await freezeClock(page);
    assert.equal(await key(page, 'KeyG'), true); await advance(page, 100);
    assert.equal(await page.evaluate(() => window.pluginState().prefix), 'g');
    assert.equal(await page.locator('.sc-panel').count(), 0, 'A quick g sequence never flashes the menu');
    await advance(page, 400);
    assert.equal(await page.locator('.sc-panel').count(), 1);
    await key(page, 'Escape'); await advance(page, 20); assert.equal(await page.locator('.sc-panel').count(), 0);
    await key(page, 'Slash', { shift: true }); await advance(page, 20); assert.equal(await page.locator('.sc-panel').count(), 1);
    await key(page, 'KeyG'); await advance(page, 20);
    assert.equal(await page.locator('.sc-panel').count(), 1, 'Visible help switches to the g menu at once');
    assert.equal(await page.evaluate(() => window.pluginState().prefix), 'g');
    await key(page, 'Escape'); await advance(page, 20); assert.equal(await page.locator('.sc-panel').count(), 0);
  });
  await check('menu insertion suspends keys without focus movement and removal resumes navigation', async page => {
    await ready(page);
    await page.evaluate(() => { const menu = document.createElement('div'); menu.id = 'menu'; menu.role = 'menu'; menu.textContent = 'native'; document.body.append(menu); }); await settle(page);
    assert.equal(await key(page, 'KeyG'), false); assert.equal(await page.evaluate(() => window.pluginState().navigating), false);
    await page.evaluate(() => document.getElementById('menu').remove()); await settle(page);
    assert.equal(await key(page, 'KeyG'), true);
  });
  await check('settings and nested native modal retain their navigation boundaries', async page => {
    await ready(page);
    await page.evaluate(() => { const dialog = document.createElement('dialog'); dialog.id = 'settings'; dialog.dataset.shortcutModal = 'settings'; dialog.innerHTML = '<button id="settings-button">OK</button><input id="settings-input">'; document.body.append(dialog); dialog.showModal(); }); await settle(page);
    assert.equal(await page.evaluate(() => window.pluginState().navigating), true);
    await page.locator('#settings-input').focus(); await settle(page); assert.equal(await key(page, 'KeyG'), false);
    await page.locator('#settings-button').focus(); await key(page, 'Slash', { shift: true }); await settle(page); assert.equal(await page.locator('#settings .sc-panel').count(), 1);
    await page.keyboard.press('Escape'); await settle(page); assert.equal(await page.locator('#settings .sc-panel').count(), 0);
    assert.equal(await page.evaluate(() => document.getElementById('settings').open), true);
    await page.evaluate(() => { const dialog = document.createElement('dialog'); dialog.id = 'confirm'; dialog.textContent = 'confirm'; document.body.append(dialog); dialog.showModal(); }); await settle(page);
    assert.equal(await key(page, 'KeyG'), false);
  });
  await check('composition target removal recovers navigation without a compositionend', async page => {
    await ready(page); await page.locator('#composer').focus();
    await page.evaluate(() => { const el = document.getElementById('composer'); el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); el.remove(); }); await settle(page);
    assert.equal(await page.evaluate(() => window.pluginState().navigating), true); assert.equal(await key(page, 'KeyG'), true);
  });
  await check('b creates a browser when this session has none and returns from address autofocus to navigation', async page => {
    await ready(page);
    await page.evaluate(() => {
      const open = window.fixture.sidebarRight.openTab;
      window.fixture.sidebarRight.openTab = kind => { open(kind); document.getElementById('address')?.focus(); };
    });
    assert.equal(await key(page, 'KeyB'), true); await ready(page);
    const current = await page.evaluate(() => window.fixture.sidebarRight.active());
    assert.equal(current.kind, 'browser'); assert.notEqual(current.id, 'foreign-browser');
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.openTabs.getSnapshot().filter(t => t.sessionId === 's1').length), 1);
    await key(page, 'KeyB'); await ready(page);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.active().id), current.id);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.openTabs.getSnapshot().length), 2);
    assert.equal(await page.evaluate(() => window.pluginState().navigating), true);
    assert.equal(await page.locator('#address').inputValue(), 'draft');
  }, { initialTabs: [{ sessionId: 's2', tabId: 'foreign-browser', kind: 'browser' }], activeTabId: null });
  await check('repeated b keeps the current browser, its content and all other tabs', async page => {
    await ready(page);
    await page.evaluate(() => { window.originalAddress = document.getElementById('address'); window.originalAddress.value = 'keep this address'; });
    for (let i = 0; i < 3; i++) { await key(page, 'KeyB'); await ready(page); }
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.active().id), 'b1');
    assert.equal(await page.evaluate(() => document.getElementById('address') === window.originalAddress), true);
    assert.equal(await page.locator('#address').inputValue(), 'keep this address');
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.openTabs.getSnapshot().length), 2);
  }, { initialTabs: [{ sessionId: 's1', tabId: 'b1', kind: 'browser' }, { sessionId: 's1', tabId: 'b2', kind: 'browser' }] });
  await check('b recalls the most recently selected browser from another tool and a collapsed panel', async page => {
    await ready(page);
    await page.evaluate(() => window.fixture.sidebarRight.focus('b2')); await settle(page);
    await page.evaluate(() => window.fixture.sidebarRight.focus('f1')); await settle(page);
    await key(page, 'KeyB'); await ready(page);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.active().id), 'b2');
    await key(page, 'KeyC'); await ready(page);
    await page.evaluate(() => window.fixture.sidebarRight.toggleExpanded()); await settle(page);
    await key(page, 'KeyB'); await ready(page);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.active().id), 'b2');
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.isExpanded()), true);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.openTabs.getSnapshot().length), 3);
  }, { initialTabs: [{ sessionId: 's1', tabId: 'b1', kind: 'browser' }, { sessionId: 's1', tabId: 'b2', kind: 'browser' }, { sessionId: 's1', tabId: 'f1', kind: 'files' }] });
  await check('Shift+B always creates a separate browser while b reuses it in navigation', async page => {
    await ready(page);
    const ids = new Set(['b1']);
    for (let i = 0; i < 2; i++) {
      await key(page, 'KeyB', { shift: true }); await ready(page);
      const id = await page.evaluate(() => window.fixture.sidebarRight.active().id);
      assert.equal(ids.has(id), false); ids.add(id);
      await key(page, 'KeyB'); await ready(page);
      assert.equal(await page.evaluate(() => window.fixture.sidebarRight.active().id), id);
    }
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.openTabs.getSnapshot().length), 3);
  });
  for (const shift of [false, true]) for (const autofocus of [false, true]) await check(`${shift ? 'Shift+T' : 'first t'} waits for the terminal view and keeps subsequent commands in navigation (autofocus=${autofocus})`, async page => {
    await ready(page); await key(page, 'KeyT', { shift }); await settle(page);
    assert.ok(await page.evaluate(() => window.pluginState().pending));
    await key(page, 'KeyT'); await settle(page);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.openTabs.getSnapshot().filter(t => t.kind === 'terminal').length), 1);
    await page.evaluate(() => window.fixture.terminal.set({ writable: true, phase: 'connected' })); await settle(page);
    assert.ok(await page.evaluate(() => window.pluginState().pending), 'Writable model alone must not complete');
    await page.evaluate(autofocus => window.fixture.mountTerminal(autofocus), autofocus); await ready(page);
    await key(page, 'KeyR', { shift: true }); await settle(page);
    assert.equal(await page.evaluate(() => document.getElementById('frame').hasAttribute('data-rightbar-fullscreen')), true, 'Shift+R remains available after terminal creation');
    assert.equal(await page.evaluate(() => window.pluginState().navigating), true);
    await key(page, 'KeyI'); await settle(page);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'terminal-input');
    assert.equal(await key(page, 'KeyT'), false);
    assert.equal(await key(page, 'Escape'), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'terminal-input');
  });
  for (const shift of [false, true]) await check(`${shift ? 'Shift+T' : 'first t'} followed by fullscreen still waits for delayed terminal autofocus`, async page => {
    await ready(page); await key(page, 'KeyT', { shift }); await settle(page);
    await key(page, 'KeyR', { shift: true }); await settle(page);
    await page.evaluate(() => window.fixture.terminal.set({ writable: true, phase: 'connected' })); await settle(page);
    assert.ok(await page.evaluate(() => window.pluginState().pending), 'Fullscreen must preserve the wait for the terminal view');
    await page.evaluate(() => window.fixture.mountTerminal(true)); await ready(page);
    assert.equal(await page.evaluate(() => document.getElementById('frame').hasAttribute('data-rightbar-fullscreen')), true);
    assert.equal(await page.evaluate(() => window.pluginState().navigating), true);
  });
  await check('t retains the selected terminal and Shift+T creates another without entering input', async page => {
    await ready(page);
    for (let i = 0; i < 2; i++) {
      const previous = await page.evaluate(() => window.fixture.sidebarRight.active().id);
      await key(page, 'KeyT', { shift: true }); await settle(page);
      await page.evaluate(() => { window.fixture.terminal.set({ writable: true, phase: 'connected' }); window.fixture.mountTerminal(true); }); await ready(page);
      const current = await page.evaluate(() => window.fixture.sidebarRight.active().id);
      assert.notEqual(current, previous);
      await page.evaluate(() => { window.originalTerminal = document.getElementById('terminal-input'); window.originalTerminal.value = 'unsent command'; });
      for (let j = 0; j < 3; j++) { await key(page, 'KeyT'); await ready(page); }
      assert.equal(await page.evaluate(() => window.fixture.sidebarRight.active().id), current);
      assert.equal(await page.evaluate(() => document.getElementById('terminal-input') === window.originalTerminal), true);
      assert.equal(await page.locator('#terminal-input').inputValue(), 'unsent command');
    }
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.openTabs.getSnapshot().filter(t => t.kind === 'terminal').length), 2);
  });
  await check('typing in a different input cancels a pending tool handoff', async page => {
    await ready(page); await key(page, 'KeyT', { shift: true }); await settle(page);
    await page.evaluate(() => { window.fixture.click('composer'); document.getElementById('composer').focus(); });
    await page.evaluate(() => { window.fixture.terminal.set({ writable: true, phase: 'connected' }); window.fixture.mountTerminal(); }); await settle(page);
    assert.equal(await page.evaluate(() => window.pluginState().pending), undefined);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'composer');
  });
  await check('stale tool occurrence cannot complete a pending handoff', async page => {
    await ready(page); await key(page, 'KeyT', { shift: true }); await settle(page);
    await page.evaluate(() => { window.fixture.invalidateTarget(); window.fixture.terminal.set({ writable: true, phase: 'connected' }); window.fixture.mountTerminal(); }); await settle(page);
    assert.equal(await page.evaluate(() => window.pluginState().pending), undefined);
  });
  await check('bracket tab switch and close keep navigation on the remaining current tool', async page => {
    await ready(page); await key(page, 'KeyB', { shift: true }); await ready(page);
    const second = await page.evaluate(() => window.fixture.sidebarRight.active().id); assert.notEqual(second, 'b1');
    await key(page, 'BracketLeft'); await ready(page); assert.equal(await page.evaluate(() => window.fixture.sidebarRight.active().id), 'b1');
    await key(page, 'BracketRight'); await ready(page); assert.equal(await page.evaluate(() => window.fixture.sidebarRight.active().id), second);
    await key(page, 'KeyW'); await ready(page); assert.equal(await page.evaluate(() => window.fixture.sidebarRight.active().id), 'b1');
  });
  await check('disabled auto-navigation can still be entered explicitly', async page => {
    await ready(page); await page.locator('#composer').focus(); await settle(page);
    await page.evaluate(() => {
      const bindings = { sidebar: 's', conversation: 'c', right: 'r', files: 'e', browser: 'b', terminal: 't', enter: 'i', newSession: 'n', newBrowser: 'B', newTerminal: 'T', closeTab: 'w', fullscreen: 'R', previous: 'g a', nextTab: ']', previousTab: '[', settings: 'g s' };
      const value = JSON.stringify({ version: 3, autoNavigate: false, bindings });
      localStorage.setItem('dsh.magic-shortcuts.v1', value);
      window.dispatchEvent(new StorageEvent('storage', { key: 'dsh.magic-shortcuts.v1', newValue: value, storageArea: localStorage }));
      document.getElementById('ordinary').focus();
    }); await settle(page);
    assert.equal(await key(page, 'KeyG'), false);
    assert.equal(await page.locator('.sc-panel').count(), 0);
    await page.evaluate(() => window.fixture.navigate()); await ready(page); assert.equal(await key(page, 'KeyG'), true);
  });
  await check('no-op clicks do not re-render, while entering a different area still updates the cue', async page => {
    await ready(page); await key(page, 'Escape'); await page.locator('#ordinary').focus(); await settle(page);
    await page.evaluate(() => { window.counts = {}; window.fixture.click('ordinary'); }); await settle(page);
    assert.equal(await page.evaluate(() => window.counts.publish || 0), 0);
    await page.evaluate(() => window.fixture.click('sidebar')); await settle(page);
    assert.equal(await page.evaluate(() => window.pluginState().area), 'sidebar');
    assert.equal(await page.locator('[data-sc-focus-area="sidebar"]').count(), 1);
  });
  await check('dispose removes observers, subscriptions and scheduled work', async page => {
    await ready(page); await page.evaluate(() => window.fixture.dispose()); await settle(page);
    await page.evaluate(() => { window.counts = {}; document.getElementById('log').append(document.createElement('p')); window.fixture.session.set({ openState: 'open', running: true }); window.fixture.click('ordinary'); }); await settle(page);
    assert.deepEqual(await page.evaluate(() => ({ ...window.counts })), {});
    assert.equal(await page.evaluate(() => window.fixture.session.listenerCount()), 0);
  });
  const PRIMARY = 'magic-shortcuts.navigate', ALTERNATE = 'shortcutter.navigate.alternate';
  const returnKey = (page, id) => page.locator(`[data-sc-return="${id}"]`);
  const bindingOf = (page, id) => page.evaluate(id => window.fixture.catalog.getSnapshot().find(row => row.id === id).binding, id);
  const recordReturn = async (page, slot, combo) => {
    await page.getByRole('button', { name: `更改${slot}`, exact: true }).click();
    await page.getByLabel('录制返回导航快捷键').press(combo); await settle(page);
  };
  const nativeStatus = page => page.locator('.sc-preference-section .sc-status').first().innerText();
  await check('⌘ Esc and ⇧⌘; are both bound by default and either one returns to navigation', async page => {
    await ready(page);
    assert.deepEqual(await page.evaluate(() => [...window.fixture.commands.keys()].sort()), [PRIMARY, ALTERNATE].sort());
    for (const id of [PRIMARY, ALTERNATE]) {
      await page.locator('#composer').focus(); await settle(page);
      assert.equal(await page.evaluate(() => window.pluginState().navigating), false);
      assert.equal(await page.evaluate(id => window.fixture.navigate({}, id), id), 'handled'); await ready(page);
    }
    await page.evaluate(() => window.fixture.preferences());
    assert.equal(await returnKey(page, PRIMARY).innerText(), '⌘ Esc');
    assert.equal(await returnKey(page, ALTERNATE).innerText(), '⇧ ⌘ ;');
    assert.equal(await page.getByText('⌘ J').count(), 0, 'The old ⌘ J default is gone');
    assert.equal(await page.locator('[data-sc-system-note]').count(), 1, 'Game Overlay guidance appears for ⌘ Esc');
  });
  await check('each return slot records, saves and restores only its own binding', async page => {
    await page.evaluate(() => window.fixture.preferences());
    await recordReturn(page, '备用快捷键', 'Meta+Shift+KeyK');
    await page.getByRole('button', { name: '保存组合', exact: true }).click(); await settle(page);
    assert.deepEqual(await bindingOf(page, ALTERNATE), { code: 'KeyK', modifiers: ['meta', 'shift'] });
    assert.deepEqual(await bindingOf(page, PRIMARY), { code: 'Escape', modifiers: ['meta'] });
    await page.getByRole('button', { name: '恢复 ⇧ ⌘ ;', exact: true }).click(); await settle(page);
    assert.equal(await returnKey(page, ALTERNATE).innerText(), '⇧ ⌘ ;');
    assert.deepEqual(await page.evaluate(() => window.fixture.native.edits.map(e => [e.operation.type, e.operation.id])),
      [['set', ALTERNATE], ['reset', ALTERNATE]]);
  });
  await check('modified Escape records and saves; bare Escape cancels without changing the binding', async page => {
    await page.evaluate(() => window.fixture.preferences());
    await recordReturn(page, '主快捷键', 'Shift+Meta+Escape');
    await page.getByRole('button', { name: '保存组合', exact: true }).click(); await settle(page);
    assert.deepEqual(await bindingOf(page, PRIMARY), { code: 'Escape', modifiers: ['meta', 'shift'] });
    assert.equal(await page.locator('[data-sc-system-note]').count(), 0, 'Guidance is specific to plain ⌘ Esc');
    await recordReturn(page, '主快捷键', 'Escape');
    assert.equal(await page.getByLabel('录制返回导航快捷键').count(), 0);
    assert.equal(await page.evaluate(() => window.fixture.native.recording), false);
    assert.equal(await page.evaluate(() => window.fixture.native.edits.length), 1);
  });
  await check('Shift semicolon recording uses its physical code even when key is colon', async page => {
    await page.evaluate(() => window.fixture.preferences());
    await page.getByRole('button', { name: '更改主快捷键', exact: true }).click();
    await page.getByLabel('录制返回导航快捷键').dispatchEvent('keydown', { key: ':', code: 'Semicolon', metaKey: true, shiftKey: true });
    await page.getByRole('button', { name: '保存组合', exact: true }).click(); await settle(page);
    assert.deepEqual(await bindingOf(page, PRIMARY), { code: 'Semicolon', modifiers: ['meta', 'shift'] });
  });
  await check('conflicts, concurrent edits and save failures preserve the current shortcut and allow retry', async page => {
    await page.evaluate(() => window.fixture.preferences());
    await page.evaluate(() => { window.fixture.native.conflicts = ['another-command']; });
    await recordReturn(page, '主快捷键', 'Meta+KeyK');
    assert.match(await nativeStatus(page), /已被 DSH 占用/);
    await page.evaluate(id => { window.fixture.native.conflicts = [id]; }, ALTERNATE);
    await page.getByLabel('录制返回导航快捷键').press('Meta+KeyK'); await settle(page);
    assert.match(await nativeStatus(page), /另一个返回导航快捷键/);
    assert.equal(await page.getByRole('button', { name: '保存组合', exact: true }).count(), 0);
    await page.getByLabel('录制返回导航快捷键').press('Escape'); await settle(page);
    assert.equal(await page.evaluate(() => window.fixture.native.edits.length), 0);
    await page.evaluate(() => { window.fixture.native.conflicts = ['magic-shortcuts.navigate']; });
    for (const result of ['conflict', 'stale', 'failed', 'throw']) {
      await page.evaluate(result => { window.fixture.native.result = result === 'throw' ? undefined : result; window.fixture.native.throws = result === 'throw'; }, result);
      await recordReturn(page, '主快捷键', 'Meta+KeyK');
      await page.getByRole('button', { name: '保存组合', exact: true }).click(); await settle(page);
      assert.equal(await returnKey(page, PRIMARY).innerText(), '⌘ Esc', result);
      assert.equal(await page.getByRole('button', { name: '更改主快捷键', exact: true }).isEnabled(), true);
    }
    await page.evaluate(() => { window.fixture.native.result = undefined; window.fixture.native.throws = false; });
    await recordReturn(page, '主快捷键', 'Meta+KeyK');
    await page.getByRole('button', { name: '保存组合', exact: true }).click(); await settle(page);
    assert.equal(await returnKey(page, PRIMARY).innerText(), '⌘ K');
  });
  await check('verified native WebView return restores outer focus once when the document reports inactive', async page => {
    await unfocusedWebview(page);
    assert.equal(await page.evaluate(() => window.pluginState().navigating), false);
    assert.equal(await page.evaluate(() => window.fixture.navigate()), 'blocked');
    assert.equal(await page.evaluate(() => window.outerFocusCalls), 0);
    assert.equal(await page.evaluate(() => window.fixture.navigate({ source: 'webview', target: window.testWebview })), 'handled');
    await settle(page);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'sc-navigation-anchor');
    assert.equal(await page.evaluate(() => window.pluginState().navigating), true);
    assert.equal(await page.evaluate(() => window.pluginState().area), 'browser');
    assert.equal(await page.evaluate(() => window.outerFocusCalls), 1);
    await page.waitForTimeout(600);
    assert.equal(await page.locator('.sc-panel').count(), 1, 'Delayed preview survives the native focus handoff');
    await settle(page);
    assert.equal(await page.evaluate(() => window.outerFocusCalls), 1);
  });
  await check('WebView focus exception still blocks menus, modals, hidden documents and unverified owners', async page => {
    await unfocusedWebview(page);
    for (const source of [undefined, 'keyboard', 'menu', 'iframe']) {
      assert.equal(await page.evaluate(source => window.fixture.navigate({ source, target: window.testWebview }), source), 'blocked');
    }
    assert.equal(await page.evaluate(() => window.fixture.navigate({ source: 'webview', target: document.body })), 'blocked');
    for (const role of ['menu', 'dialog']) {
      await page.evaluate(role => { const el = document.createElement('div'); el.id = 'blocking-overlay'; el.role = role; el.setAttribute('aria-modal', 'true'); el.textContent = 'Overlay'; document.body.append(el); }, role);
      assert.equal(await page.evaluate(() => window.fixture.navigate({ source: 'webview', target: window.testWebview })), 'blocked');
      await page.evaluate(() => document.getElementById('blocking-overlay').remove());
    }
    await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, value: true }));
    assert.equal(await page.evaluate(() => window.fixture.navigate({ source: 'webview', target: window.testWebview })), 'blocked');
    await page.evaluate(() => { delete document.hidden; window.testWebview.style.visibility = 'hidden'; });
    assert.equal(await page.evaluate(() => window.fixture.navigate({ source: 'webview', target: window.testWebview })), 'blocked');
    assert.equal(await page.evaluate(() => window.outerFocusCalls), 0);
  });
  await check('Shift+R opens a collapsed panel directly in fullscreen and restores it without replacing content', async page => {
    await ready(page);
    await page.evaluate(() => { window.originalAddress = document.getElementById('address'); window.originalAddress.value = 'keep this address'; });
    await key(page, 'KeyR'); await ready(page);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.isExpanded()), false);
    await key(page, 'KeyR', { shift: true }); await ready(page);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.isExpanded()), true);
    assert.equal(await page.evaluate(() => document.getElementById('frame').hasAttribute('data-rightbar-fullscreen')), true);
    assert.equal(await page.evaluate(() => window.pluginState().area), 'browser');
    assert.equal(await page.locator('.sc-notice').count(), 0);
    await key(page, 'KeyR', { shift: true }); await ready(page);
    assert.equal(await page.evaluate(() => document.getElementById('frame').hasAttribute('data-rightbar-fullscreen')), false);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.isExpanded()), true);
    assert.equal(await page.evaluate(() => document.getElementById('address') === window.originalAddress), true);
    assert.equal(await page.locator('#address').inputValue(), 'keep this address');
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.openTabs.getSnapshot().length), 1);
  });
  await check('Shift+R preserves a collapsed panel\'s remembered fullscreen mode when reopening', async page => {
    await ready(page); await key(page, 'KeyR', { shift: true }); await ready(page);
    await key(page, 'KeyR'); await ready(page);
    await key(page, 'KeyR', { shift: true }); await ready(page);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.isExpanded()), true);
    assert.equal(await page.evaluate(() => document.getElementById('frame').hasAttribute('data-rightbar-fullscreen')), true);
    assert.equal(await page.locator('.sc-notice').count(), 0);
  });
  await check('Shift+R opens an empty panel using the guide target created by expansion', async page => {
    await ready(page); await key(page, 'KeyR'); await ready(page);
    await key(page, 'KeyR', { shift: true }); await ready(page);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.active().kind), 'guide');
    assert.equal(await page.evaluate(() => document.getElementById('frame').hasAttribute('data-rightbar-fullscreen')), true);
    assert.equal(await page.locator('.sc-notice').count(), 0);
  }, { initialTabs: [] });
  await check('Shift+R opens an automatically fullscreen narrow panel and the next press returns to conversation', async page => {
    await ready(page); await key(page, 'KeyR'); await ready(page);
    await key(page, 'KeyR', { shift: true }); await ready(page);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.isExpanded()), true);
    assert.equal(await page.evaluate(() => document.getElementById('frame').hasAttribute('data-rightbar-fullscreen')), true);
    await key(page, 'KeyR', { shift: true }); await ready(page);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.isExpanded()), false);
    assert.equal(await page.evaluate(() => window.pluginState().area), 'conversation');
    assert.equal(await page.locator('.sc-notice').count(), 0);
  }, { autoFullscreen: true });
  await check('Shift+R from a collapsed terminal waits for its view and delayed autofocus', async page => {
    await page.evaluate(() => { window.fixture.terminal.set({ writable: true, phase: 'connected' }); window.fixture.mountTerminal(); });
    await ready(page); await key(page, 'KeyR'); await ready(page);
    await page.evaluate(() => document.getElementById('terminal-input').remove());
    await key(page, 'KeyR', { shift: true }); await settle(page);
    assert.ok(await page.evaluate(() => window.pluginState().pending));
    await page.evaluate(() => window.fixture.mountTerminal(true)); await ready(page);
    assert.equal(await page.evaluate(() => document.getElementById('frame').hasAttribute('data-rightbar-fullscreen')), true);
    assert.equal(await page.evaluate(() => window.pluginState().area), 'terminal');
    assert.equal(await page.locator('.sc-notice').count(), 0);
  }, { initialTabs: [{ sessionId: 's1', tabId: 't1', kind: 'terminal' }] });
  await check('Shift+R without a session reports the missing session without changing layout', async page => {
    await ready(page);
    await page.evaluate(() => window.fixture.commitSession(undefined, 'open')); await ready(page);
    await key(page, 'KeyR', { shift: true }); await settle(page);
    assert.equal(await page.locator('.sc-notice').textContent(), '先打开一个会话。');
    assert.equal(await page.evaluate(() => document.getElementById('frame').hasAttribute('data-rightbar-fullscreen')), false);
  });
  await check('Shift+R on a floating target explains the actual host limitation without opening the dock', async page => {
    await ready(page);
    await page.evaluate(() => {
      const target = window.fixture.sidebarRight.commandTarget();
      window.fixture.sidebarRight.toggleExpanded();
      window.fixture.sidebarRight.commandTarget = () => ({ ...target, host: 'float' });
    }); await settle(page);
    await key(page, 'KeyR', { shift: true }); await settle(page);
    assert.equal(await page.locator('.sc-notice').textContent(), '悬浮面板暂不支持放大或恢复。');
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.isExpanded()), false);
  });
  await check('fullscreen cue and help paint above the host panel without intercepting content or changing host layers', async page => {
    await ready(page); await key(page, 'KeyB'); await ready(page);
    await key(page, 'KeyR', { shift: true }); await ready(page); await settle(page);
    assert.equal(await page.locator('[data-sidebar-right-panel="fullscreen"]').count(), 1);
    assert.equal(await page.locator('.sc-focus-cue[data-sc-focus-area="browser"]').count(), 1);
    const layering = await page.evaluate(() => {
      const cue = document.querySelector('.sc-focus-cue'), r = cue.getBoundingClientRect();
      const underlying = document.elementFromPoint(r.left + 8, r.top + 8);
      // Opt in to hit testing only for this probe: visibility alone cannot detect
      // a cue painted behind an opaque fullscreen pane in another stacking context.
      cue.style.pointerEvents = 'auto';
      const abovePanel = document.elementFromPoint(r.left + 8, r.top + 8) === cue;
      cue.style.removeProperty('pointer-events');
      return { abovePanel, transparent: !underlying.closest('.sc-root'),
        appRegion: getComputedStyle(cue).webkitAppRegion,
        shellZ: getComputedStyle(document.getElementById('overlay')).zIndex,
        paneZ: getComputedStyle(document.querySelector('[data-dockkit-pane]')).zIndex };
    });
    assert.deepEqual(layering, { abovePanel: true, transparent: true, appRegion: 'none', shellZ: '20', paneZ: '40' });
    await key(page, 'Slash', { shift: true }); await settle(page);
    assert.equal(await page.locator('.sc-panel').evaluate(panel => getComputedStyle(panel).webkitAppRegion), 'no-drag');
    assert.equal(await page.locator('.sc-panel').evaluate(panel => {
      const r = panel.getBoundingClientRect();
      return panel.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
    }), true);
    await key(page, 'Escape'); await settle(page);
    await page.evaluate(() => window.fixture.dispose()); await settle(page);
    assert.equal(await page.locator('.sc-root, .sc-focus-cue, .sc-panel').count(), 0);
  });
  await check('fullscreen cue follows input, return, resize and restore without leaving a stale marker', async page => {
    await ready(page); await key(page, 'KeyB'); await ready(page);
    await key(page, 'KeyR', { shift: true }); await ready(page); await settle(page);
    assert.equal((await page.locator('.sc-focus-cue').boundingBox()).x, 0);
    await page.locator('#address').focus(); await settle(page);
    assert.equal(await page.locator('.sc-focus-cue').count(), 0);
    await page.evaluate(() => window.fixture.navigate()); await ready(page); await settle(page);
    assert.equal(await page.locator('.sc-focus-cue').count(), 1);
    await page.setViewportSize({ width: 1100, height: 700 }); await settle(page);
    assert.equal((await page.locator('.sc-focus-cue').boundingBox()).width, 1100);
    await key(page, 'KeyR', { shift: true }); await ready(page); await settle(page);
    assert.equal((await page.locator('.sc-focus-cue').boundingBox()).x,
      (await page.locator('[data-dockkit-pane]').boundingBox()).x);
    assert.equal(await page.locator('.sc-focus-cue').count(), 1);
    await page.locator('#composer').focus(); await settle(page);
    assert.equal(await page.locator('.sc-focus-cue').count(), 0);
  });
  await check('explicit return previews help only after a pause, then expires without moving focus or leaving navigation', async page => {
    await ready(page); await freezeClock(page);
    assert.equal(await page.locator('.sc-panel').count(), 0);
    await page.locator('#composer').focus(); await advance(page, 50);
    assert.equal(await page.evaluate(() => window.fixture.navigate()), 'handled');
    await advance(page, 100);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'sc-navigation-anchor');
    assert.equal(await page.locator('.sc-panel').count(), 0, 'No flash right after the return key');
    await advance(page, 400);
    assert.equal(await page.locator('.sc-panel').count(), 1);
    await advance(page, 1800);
    assert.equal(await page.locator('.sc-panel').count(), 1);
    await advance(page, 300);
    assert.equal(await page.locator('.sc-panel').count(), 0);
    assert.equal(await page.evaluate(() => window.pluginState().navigating), true);
    assert.equal(await page.locator('.sc-focus-cue').count(), 1);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'sc-navigation-anchor');
    assert.equal(await page.locator('#composer').inputValue(), 'draft');
  });
  await check('the alternate return previews the same way', async page => {
    await ready(page); await freezeClock(page);
    await page.locator('#composer').focus(); await advance(page, 50);
    assert.equal(await page.evaluate(id => window.fixture.navigate({}, id), ALTERNATE), 'handled');
    await advance(page, 100); assert.equal(await page.locator('.sc-panel').count(), 0);
    await advance(page, 400); assert.equal(await page.locator('.sc-panel').count(), 1);
  });
  await check('keys pressed during the pause keep a quick return sequence completely quiet', async page => {
    await ready(page); await freezeClock(page);
    for (const sequence of [[['KeyC', {}]], [['KeyG', {}], ['KeyA', {}]], [['KeyB', {}]]]) {
      await page.locator('#composer').focus(); await advance(page, 50);
      await page.evaluate(() => window.fixture.navigate()); await advance(page, 100);
      for (const [code, extra] of sequence) { assert.equal(await key(page, code, extra), true); await advance(page, 100); }
      await ready(page);
      for (let i = 0; i < 6; i++) { await advance(page, 500); assert.equal(await page.locator('.sc-panel').count(), 0, sequence.map(([code]) => code).join(' ')); }
    }
  });
  await check('passive entry stays quiet: blank clicks, buttons, input blur, area clicks, tool headers, menus and window focus', async page => {
    await ready(page); await freezeClock(page);
    const quiet = async label => {
      for (let i = 0; i < 4; i++) { await advance(page, 500); assert.equal(await page.locator('.sc-panel').count(), 0, label); }
      assert.equal(await page.evaluate(() => window.pluginState().navigating), true, label);
    };
    for (const entry of ['blank', 'button', 'blur']) {
      await page.locator('#composer').focus(); await advance(page, 50);
      if (entry === 'blank') await page.locator('#log').click({ position: { x: 100, y: 100 } });
      else if (entry === 'button') await page.locator('#ordinary').click();
      else await page.locator('#composer').evaluate(input => input.blur());
      await quiet(entry);
      assert.equal(await page.locator('#composer').inputValue(), 'draft');
    }
    for (const [id, area] of [['sidebar', 'sidebar'], ['log', 'conversation']]) {
      await page.locator(`#${id}`).click({ position: { x: 90, y: 90 } }); await advance(page, 100);
      assert.equal(await page.evaluate(() => window.pluginState().area), area);
      await quiet(area);
    }
    await page.locator('#address').focus(); await advance(page, 50);
    await page.locator('#toolbar-blank').click(); await advance(page, 100); await ready(page);
    assert.equal(await page.evaluate(() => window.pluginState().area), 'browser');
    await quiet('tool header');
    await page.evaluate(() => { const menu = document.createElement('div'); menu.id = 'menu'; menu.role = 'menu'; menu.textContent = 'menu'; document.body.append(menu); });
    await advance(page, 50); await page.evaluate(() => document.getElementById('menu').remove());
    await quiet('menu closed');
    await page.evaluate(() => { Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false }); window.dispatchEvent(new Event('blur')); });
    await advance(page, 50);
    await page.evaluate(() => { delete document.hasFocus; window.dispatchEvent(new Event('focus')); });
    await quiet('window focus');
  });
  await check('native guest focus returning to the app stays quiet', async page => {
    await unfocusedWebview(page); await freezeClock(page);
    await page.evaluate(() => { window.outerFocused = true; window.testWebview.blur(); window.dispatchEvent(new Event('focus')); });
    await advance(page, 3000);
    assert.equal(await page.locator('.sc-panel').count(), 0);
    assert.equal(await page.evaluate(() => window.outerFocusCalls), 0);
  });
  await check('navigation actions consume entry and manual help without reopening it at a different target', async page => {
    await ready(page); await freezeClock(page);
    for (const [code, extra] of [['KeyB', {}], ['KeyC', {}], ['KeyR', {}], ['KeyR', {}], ['KeyS', {}], ['KeyS', {}], ['KeyE', {}], ['KeyB', { shift: true }], ['BracketLeft', {}], ['BracketRight', {}], ['KeyR', { shift: true }], ['KeyR', { shift: true }], ['KeyW', {}]]) {
      await page.evaluate(() => window.fixture.navigate()); await advance(page, 500);
      assert.equal(await page.locator('.sc-panel').count(), 1, `entry help before ${code}`);
      assert.equal(await key(page, code, extra), true); await advance(page, 100);
      assert.equal(await page.locator('.sc-panel').count(), 0, code);
      await page.evaluate(() => window.fixture.navigate()); await advance(page, 20);
      await key(page, 'Slash', { shift: true }); await advance(page, 20);
      assert.equal(await page.locator('.sc-panel').count(), 1, `manual help before ${code}`);
      assert.equal(await key(page, code, extra), true); await advance(page, 100);
      assert.equal(await page.locator('.sc-panel').count(), 0, code);
      await advance(page, 3000); assert.equal(await page.locator('.sc-panel').count(), 0, code);
    }
  });
  await check('a delayed terminal handoff stays quiet after its shortcut, then explicit return still previews help', async page => {
    await ready(page); await freezeClock(page);
    await key(page, 'KeyT', { shift: true }); await advance(page, 100);
    assert.ok(await page.evaluate(() => window.pluginState().pending));
    await advance(page, 1500);
    await page.evaluate(() => { window.fixture.terminal.set({ writable: true, phase: 'connected' }); window.fixture.mountTerminal(true); });
    await advance(page, 100); await ready(page);
    await advance(page, 3000); assert.equal(await page.locator('.sc-panel').count(), 0);
    await page.evaluate(() => window.fixture.navigate()); await advance(page, 500);
    assert.equal(await page.locator('.sc-panel').count(), 1);
  });
  await check('a new-session command stays quiet through a later session mount and readiness event', async page => {
    await ready(page); await freezeClock(page);
    await key(page, 'KeyN'); await advance(page, 100);
    assert.equal(await page.evaluate(() => window.fixture.workspace.sessionRequested), true);
    await advance(page, 500);
    await page.evaluate(() => window.fixture.commitSession('s2')); await advance(page, 100);
    await page.evaluate(() => window.fixture.session.set({ openState: 'open', running: false }));
    await advance(page, 100); await ready(page);
    await advance(page, 3000); assert.equal(await page.locator('.sc-panel').count(), 0);
  });
  await check('a scheduled preview is cancelled by a click elsewhere, entering an input, window blur and disposal', async page => {
    await ready(page); await freezeClock(page);
    for (const scene of ['click', 'input', 'blur']) {
      await page.evaluate(() => window.fixture.navigate()); await advance(page, 100);
      await page.evaluate(scene => {
        if (scene === 'click') window.fixture.click('sidebar');
        else if (scene === 'input') document.getElementById('composer').focus();
        else { Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false }); window.dispatchEvent(new Event('blur')); }
      }, scene);
      await advance(page, 3000); assert.equal(await page.locator('.sc-panel').count(), 0, scene);
      await page.evaluate(() => { delete document.hasFocus; window.dispatchEvent(new Event('focus')); document.getElementById('ordinary').focus(); });
      await advance(page, 100);
    }
    await page.evaluate(() => window.fixture.navigate()); await advance(page, 500);
    assert.equal(await page.locator('.sc-panel').count(), 1);
    await page.locator('#log').click({ position: { x: 100, y: 100 } }); await advance(page, 50);
    assert.equal(await page.locator('.sc-panel').count(), 0, 'Clicking elsewhere puts a visible preview away');
    await page.evaluate(() => { window.fixture.navigate(); window.fixture.dispose(); window.counts = {}; });
    await advance(page, 5000);
    assert.equal(await page.locator('.sc-panel').count(), 0);
    assert.deepEqual(await page.evaluate(() => ({ ...window.counts })), {});
  });
  await check('another explicit return keeps a visible preview and restarts its reading time', async page => {
    await ready(page); await freezeClock(page);
    await page.evaluate(() => window.fixture.navigate()); await advance(page, 500);
    assert.equal(await page.locator('.sc-panel').count(), 1);
    await advance(page, 1500);
    await page.evaluate(() => window.fixture.navigate()); await advance(page, 20);
    assert.equal(await page.locator('.sc-panel').count(), 1, 'No flicker on a repeated return');
    await advance(page, 1800); assert.equal(await page.locator('.sc-panel').count(), 1);
    await advance(page, 300); assert.equal(await page.locator('.sc-panel').count(), 0);
  });
  await check('a resting cursor cannot hold the preview; real pointer movement or keyboard focus pauses it', async page => {
    await ready(page); await freezeClock(page);
    await page.evaluate(() => window.fixture.navigate()); await advance(page, 500);
    const box = await page.locator('.sc-panel').boundingBox();
    await advance(page, 2000); assert.equal(await page.locator('.sc-panel').count(), 0);
    await page.mouse.move(box.x + 20, box.y + 20);
    await page.evaluate(() => window.fixture.navigate()); await advance(page, 500);
    assert.equal(await page.locator('.sc-panel').count(), 1);
    await page.locator('.sc-panel').dispatchEvent('pointermove', { clientX: box.x + 20, clientY: box.y + 20 });
    await advance(page, 2100);
    assert.equal(await page.locator('.sc-panel').count(), 0, 'Stationary cursor under the preview');
    await page.evaluate(() => window.fixture.navigate()); await advance(page, 500);
    await advance(page, 1000);
    await page.mouse.move(box.x + 30, box.y + 30, { steps: 3 }); await advance(page, 5000);
    assert.equal(await page.locator('.sc-panel').count(), 1, 'Moving inside pauses');
    await page.mouse.move(5, 5, { steps: 2 }); await advance(page, 900);
    assert.equal(await page.locator('.sc-panel').count(), 1);
    await advance(page, 200);
    assert.equal(await page.locator('.sc-panel').count(), 0, 'Leaving resumes the remaining time');
    await page.evaluate(() => window.fixture.navigate()); await advance(page, 500);
    await page.locator('.sc-panel button').first().focus(); await advance(page, 5000);
    assert.equal(await page.locator('.sc-panel').count(), 1, 'Keyboard focus pauses');
    await page.locator('#sc-navigation-anchor').focus(); await advance(page, 2100);
    assert.equal(await page.locator('.sc-panel').count(), 0);
    assert.equal(await page.evaluate(() => window.pluginState().navigating), true);
  });
  await check('manual help persists while a forgotten g prefix expires on its own', async page => {
    await ready(page); await freezeClock(page);
    await key(page, 'Slash', { shift: true }); await advance(page, 5000);
    assert.equal(await page.locator('.sc-panel').count(), 1);
    await key(page, 'Escape'); await advance(page, 50);
    assert.equal(await page.locator('.sc-panel').count(), 0);
    await key(page, 'KeyG'); await advance(page, 3800);
    assert.equal(await page.evaluate(() => window.pluginState().prefix), 'g');
    assert.equal(await page.locator('.sc-panel').count(), 1);
    await advance(page, 300);
    assert.equal(await page.evaluate(() => window.pluginState().prefix), '');
    assert.equal(await page.locator('.sc-panel').count(), 0);
    assert.equal(await page.evaluate(() => window.pluginState().navigating), true);
    await key(page, 'KeyC'); await advance(page, 50);
    assert.equal(await page.evaluate(() => window.pluginState().area), 'conversation', 'Next key is an ordinary command again');
  });
  await check('an entry preview ends with navigation (input, menu, background) and does not return passively', async page => {
    await ready(page); await freezeClock(page);
    for (const scene of ['input', 'menu', 'background']) {
      await page.evaluate(() => window.fixture.navigate()); await advance(page, 500);
      assert.equal(await page.locator('.sc-panel').count(), 1);
      await page.evaluate(scene => {
        if (scene === 'input') document.getElementById('composer').focus();
        else if (scene === 'menu') { const menu = document.createElement('div'); menu.id = 'native-menu'; menu.role = 'menu'; menu.textContent = 'Menu'; document.body.append(menu); }
        else {
          Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
          window.dispatchEvent(new Event('blur'));
        }
      }, scene);
      await advance(page, 50);
      assert.equal(await page.locator('.sc-panel').count(), 0);
      await page.evaluate(() => { delete document.hasFocus; document.getElementById('native-menu')?.remove(); document.getElementById('ordinary').focus(); window.dispatchEvent(new Event('focus')); });
      await advance(page, 3000);
      assert.equal(await page.locator('.sc-panel').count(), 0, scene);
      assert.equal(await page.evaluate(() => window.pluginState().navigating), true);
    }
  });
  return { passed: results.filter(result => result.pass).length, total: results.length, results };
}
