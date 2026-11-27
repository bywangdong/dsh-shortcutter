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
  await check('f searches real session metadata without switching until Enter, then returns to Shortcut Mode', async page => {
    await ready(page);
    await key(page, 'KeyF'); await page.getByRole('combobox').waitFor();
    assert.equal(await page.getByRole('dialog', { name: '搜索会话' }).count(), 1);
    assert.equal(await page.getByRole('combobox').evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('radio', { name: '全部' }).evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('button', { name: '关闭搜索' }).evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('combobox').evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.getByRole('button', { name: '关闭搜索' }).evaluate(el => el === document.activeElement), true);
    assert.equal(await page.getByRole('option').count(), 3);
    assert.deepEqual(await page.evaluate(() => window.fixture.workspace.openedSessions), []);
    await page.getByRole('combobox').fill('中文');
    assert.equal(await page.getByRole('option').count(), 1);
    await page.keyboard.press('Enter'); await ready(page);
    assert.deepEqual(await page.evaluate(() => window.fixture.workspace.openedSessions), ['s2']);
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await page.locator('#composer').inputValue(), 'draft');
    assert.equal(await page.evaluate(() => window.fixture.sessionList.listenerCount()), 0);
    assert.equal(await page.evaluate(() => window.fixture.workspaceList.listenerCount()), 0);
  });
  await check('live status filters are keyboard accessible and only opening a result changes the session', async page => {
    await ready(page);
    await page.evaluate(() => window.fixture.sessionStatus.set(new Map([
      ['s2', { pendingInteraction: { kind: 'approval' }, completionUnread: true }],
      ['s3', { pendingInteraction: { kind: 'question' } }]
    ])));
    await key(page, 'KeyF'); await page.getByRole('combobox').waitFor();
    await page.keyboard.press('Tab'); await page.keyboard.press('ArrowRight');
    assert.equal(await page.getByRole('radio', { name: '待处理' }).isChecked(), true);
    assert.equal(await page.getByRole('option').count(), 2);
    assert.match(await page.getByRole('option').first().textContent(), /待审批.*未读/);
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.getByRole('option').count(), 1);
    await page.evaluate(() => window.fixture.sessionStatus.set(new Map()));
    await page.getByText('没有未读会话。').waitFor();
    await page.evaluate(() => window.fixture.sessionStatus.readingReady.set(false));
    assert.equal(await page.getByRole('radio', { name: '未读' }).isDisabled(), true);
    assert.equal(await page.getByRole('radio', { name: '全部' }).isChecked(), true);
    assert.deepEqual(await page.evaluate(() => window.fixture.workspace.openedSessions), []);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.fixture.sessionStatus.listenerCount()), 0);
  });
  await check('fuzzy search works without a status service on older hosts', async page => {
    await ready(page); await key(page, 'KeyF');
    await page.getByRole('combobox').fill('中修');
    assert.equal(await page.getByRole('option').count(), 1);
    assert.equal(await page.getByRole('radio').count(), 0);
  }, { hasSessionStatus: false });
  await check('creating a second browser tab waits for its own address bar', async page => {
    await ready(page); await key(page, 'KeyN'); await key(page, 'KeyB');
    await page.waitForFunction(() => document.activeElement.id === 'address' && document.activeElement.closest('[data-sidebar-right-tab]').dataset.sidebarRightTab !== 'b1');
    await page.keyboard.type('example');
    assert.equal(await page.locator('#address').inputValue(), 'example');
  }, { toolMountDelay: 100 });
  await check('the host dismisses its conversation overlay on the first Escape', async page => {
    await ready(page); await page.evaluate(() => {
      const panel = document.createElement('aside'); panel.dataset.sessionPanel = 'overlay'; panel.textContent = 'Session panel'; document.body.append(panel);
      document.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.defaultPrevented) panel.remove(); }, { once: true });
    });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('[data-session-panel="overlay"]').count(), 0);
  });
  await check('only the configured sidebar toggle runs inside the drawer, outside editable controls', async page => {
    await ready(page);
    await page.evaluate(() => {
      window.fixture.preferences();
    });
    await page.getByLabel('切换侧栏', { exact: true }).fill('n s');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.evaluate(() => {
      window.fixture.layout.selectPanel(null);
      const drawer = document.createElement('div');
      drawer.setAttribute('role', 'dialog'); drawer.setAttribute('aria-modal', 'true'); drawer.dataset.shortcutModal = 'sidebar';
      drawer.innerHTML = '<button id="drawer-toggle">Toggle</button><input id="drawer-search">';
      document.body.append(drawer);
      window.fixture.layout.toggleSidebar = () => drawer.remove();
      drawer.querySelector('input').focus();
    });
    assert.equal(await key(page, 'KeyN'), false, 'the drawer search owns typing');
    await page.locator('#drawer-toggle').focus();
    assert.equal(await key(page, 'KeyS'), false);
    assert.equal(await key(page, 'KeyF'), false);
    assert.equal(await key(page, 'KeyN'), true);
    assert.equal(await key(page, 'KeyS'), true);
    assert.equal(await page.locator('[data-shortcut-modal="sidebar"]').count(), 0);
  });
  await check('session search supports arrows, clicks, empty results, and Esc restores the originating tool', async page => {
    await ready(page); await key(page, 'KeyB'); await ready(page);
    await key(page, 'KeyB'); await ready(page);
    await key(page, 'KeyF'); await page.getByRole('combobox').waitFor();
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('[aria-selected="true"][role="option"]').getAttribute('id'), 'sc-session-result-s2');
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.locator('[aria-selected="true"][role="option"]').getAttribute('id'), 'sc-session-result-s1');
    await page.getByRole('combobox').fill('does not exist');
    assert.equal(await page.getByRole('option').count(), 0);
    await page.keyboard.press('Enter');
    assert.equal(await page.getByRole('dialog').count(), 1);
    await page.keyboard.press('Escape'); await ready(page);
    assert.equal(await page.evaluate(() => window.pluginState().area), 'browser');
    assert.deepEqual(await page.evaluate(() => window.fixture.workspace.openedSessions), []);
    await key(page, 'KeyF'); await page.getByRole('combobox').fill('BROWSER');
    await page.getByRole('option').click(); await ready(page);
    assert.deepEqual(await page.evaluate(() => window.fixture.workspace.openedSessions), ['s3']);
  });
  await check('Chinese IME input and confirmation stay inside search, and ordinary typing never triggers f', async page => {
    await ready(page); await page.locator('#composer').focus(); await settle(page);
    assert.equal(await key(page, 'KeyF'), false);
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.keyboard.press('Escape'); await ready(page);
    await key(page, 'KeyF', { composing: true });
    await page.getByRole('combobox').fill('中文');
    await page.getByRole('combobox').evaluate(input => {
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      for (const key of ['Enter', 'Escape']) input.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true, isComposing: true, keyCode: 229 }));
    });
    assert.equal(await page.getByRole('dialog').count(), 1);
    assert.deepEqual(await page.evaluate(() => window.fixture.workspace.openedSessions), []);
    await page.getByRole('combobox').evaluate(input => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
    await page.keyboard.press('Enter'); await ready(page);
    assert.deepEqual(await page.evaluate(() => window.fixture.workspace.openedSessions), ['s2']);
  });
  await check('live renames, archives and deletions update results while selection follows session identity', async page => {
    await ready(page); await key(page, 'KeyF'); await page.getByRole('combobox').fill('Shortcutter');
    await page.keyboard.press('ArrowDown');
    await page.evaluate(() => {
      const f = window.fixture, list = f.sessionList.getSnapshot();
      f.sessionList.set({ ...list, byId: { ...list.byId, s2: { ...list.byId.s2, displayTitle: '<script>中文修复</script>', updatedAt: 100 } } });
    });
    await settle(page);
    assert.equal(await page.locator('[aria-selected="true"][role="option"]').getAttribute('id'), 'sc-session-result-s2');
    assert.ok((await page.getByRole('option').allTextContents()).some(text => text.includes('<script>')));
    assert.equal(await page.locator('.sc-search-results script').count(), 0);
    await page.evaluate(() => {
      const f = window.fixture;
      f.workspaceList.set({ ...f.workspaceList.getSnapshot(), archivedSessionIds: ['s2'] });
    }); await settle(page);
    assert.equal(await page.getByRole('option').count(), 1);
    await page.evaluate(() => window.fixture.sessionList.set({ phase: 'ready', ids: [], byId: {} })); await settle(page);
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => window.fixture.workspace.openedSessions), []);
    assert.equal(await page.getByRole('combobox').getAttribute('aria-activedescendant'), null);
    await page.keyboard.press('Escape'); await ready(page);
  });
  await check('f opens from global pages and waits for the selected session even with automatic navigation disabled', async page => {
    await ready(page);
    await page.evaluate(() => {
      const bindings = { sidebar: 's', conversation: 'c', right: 'r', files: 'e', browser: 'b', terminal: 't', enter: 'i',
        newSession: 'n c', newBrowser: 'n b', newTerminal: 'n t', closeTab: 'w', fullscreen: 'R', previous: 'g b',
        nextTab: 'Tab', previousTab: 'Shift+Tab', plugins: 'g e', schedules: 'g a', settings: 'g s' };
      const value = JSON.stringify({ version: 5, autoNavigate: false, bindings });
      localStorage.setItem('dsh.magic-shortcuts.v1', value);
      window.dispatchEvent(new StorageEvent('storage', { key: 'dsh.magic-shortcuts.v1', newValue: value, storageArea: localStorage }));
      window.fixture.navigate();
    }); await ready(page);
    await key(page, 'KeyG'); await key(page, 'KeyE'); await ready(page);
    await key(page, 'KeyF'); await page.getByRole('combobox').fill('中文');
    await page.evaluate(() => {
      window.fixture.workspace.openSession = id => {
        window.fixture.workspace.openedSessions.push(id);
        setTimeout(() => window.fixture.commitSession(id, 'open'), 100);
      };
    });
    await page.keyboard.press('Enter');
    await ready(page);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.mounted.getSnapshot()), 's2');
    assert.equal(await page.evaluate(() => window.fixture.panelInfo.getSnapshot().activePanelId), null);
    assert.deepEqual(await page.evaluate(() => window.fixture.workspace.openedSessions), ['s2']);
  });
  await check('search waits for archive metadata, then supports backdrop dismissal and clean plugin disposal', async page => {
    await ready(page);
    await page.evaluate(() => window.fixture.workspaceList.set({ phase: 'pending', items: [], archivedSessionIds: [] }));
    await key(page, 'KeyF'); await page.getByRole('combobox').waitFor();
    assert.equal(await page.getByRole('option').count(), 0);
    assert.match(await page.locator('.sc-search-status').textContent(), /正在加载/);
    await page.evaluate(() => window.fixture.workspaceList.set({ phase: 'ready', items: [], archivedSessionIds: ['s2'] }));
    await settle(page); assert.equal(await page.getByRole('option').count(), 2);
    await page.mouse.click(5, 5); await ready(page);
    assert.equal(await page.getByRole('dialog').count(), 0);
    await key(page, 'KeyF'); await page.getByRole('combobox').waitFor();
    await page.evaluate(() => window.fixture.dispose()); await settle(page);
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await page.evaluate(() => window.fixture.sessionList.listenerCount()), 0);
    assert.equal(await page.evaluate(() => window.fixture.workspaceList.listenerCount()), 0);
  });
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
  await check('Escape returns to navigation even while conversation is running and suppresses host double-Escape stop', async page => {
    await ready(page);
    await page.evaluate(() => {
      window.stopAttempts = 0;
      window.popupOpen = true;
      document.getElementById('composer').addEventListener('keydown', e => {
        if (e.key === 'Escape' && window.popupOpen) { window.popupOpen = false; e.preventDefault(); }
      });
      window.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !e.defaultPrevented && window.fixture.session.getSnapshot().running) window.stopAttempts++;
      });
      window.fixture.session.set({ openState: 'open', running: true });
    });
    await page.locator('#composer').focus(); await settle(page);
    // First Escape closes local composer popup (/ or @ menu) without leaving input.
    await page.keyboard.press('Escape'); await settle(page);
    assert.equal(await page.evaluate(() => window.popupOpen), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'composer');
    assert.equal(await page.evaluate(() => window.pluginState().navigating), false);
    // Second Escape returns to navigation even while running, without triggering stop.
    await page.keyboard.press('Escape'); await ready(page);
    assert.equal(await page.evaluate(() => window.pluginState().navigating), true);
    assert.equal(await page.locator('#composer').inputValue(), 'draft');
    await page.keyboard.press('Escape'); await settle(page);
    await page.locator('#ordinary').focus(); await settle(page);
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await settle(page);
    assert.equal(await page.evaluate(() => window.stopAttempts), 0);

    // Fixed-input delivery and browser address input follow the same Escape rule.
    await page.locator('#composer').focus(); await settle(page);
    assert.equal(await key(page, 'Escape'), true); await ready(page);
    await page.locator('#address').focus(); await settle(page);
    await page.keyboard.press('Escape'); await ready(page);
    assert.equal(await page.evaluate(() => window.pluginState().area), 'browser');
    assert.equal(await page.locator('#address').inputValue(), 'draft');
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
    await page.keyboard.press('Escape'); await settle(page);
    assert.equal(await page.evaluate(() => document.getElementById('settings').open), true, 'Escape in settings input exits input before closing modal');
    assert.equal(await page.evaluate(() => window.pluginState().navigating), true);
    await page.locator('#settings-button').focus(); await key(page, 'Slash', { shift: true }); await settle(page); assert.equal(await page.locator('#settings .sc-panel').count(), 1);
    await page.keyboard.press('Escape'); await settle(page); assert.equal(await page.locator('#settings .sc-panel').count(), 0);
    assert.equal(await page.evaluate(() => document.getElementById('settings').open), true);
    await page.evaluate(() => { const dialog = document.createElement('dialog'); dialog.id = 'confirm'; dialog.textContent = 'confirm'; document.body.append(dialog); dialog.showModal(); }); await settle(page);
    assert.equal(await key(page, 'KeyG'), false);
    await page.evaluate(() => { document.getElementById('confirm').close(); document.getElementById('settings').close(); }); await settle(page);

    // Also verify DSH SettingsRoot-style non-focusable div[role="dialog"] + document Escape close.
    await page.evaluate(() => {
      const panel = document.createElement('div');
      panel.id = 'div-settings'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true');
      panel.dataset.shortcutModal = 'settings';
      panel.innerHTML = '<input id="div-settings-input" value="q">';
      const onKey = e => { if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); panel.remove(); } };
      document.addEventListener('keydown', onKey);
      document.body.append(panel);
    }); await settle(page);
    await page.locator('#div-settings-input').focus(); await settle(page);
    assert.equal(await page.evaluate(() => window.pluginState().navigating), false);
    await page.keyboard.press('Escape'); await settle(page);
    assert.equal(await page.locator('#div-settings').count(), 1, 'First Escape leaves input into Settings navigation');
    assert.equal(await page.evaluate(() => window.pluginState().navigating), true);
    await page.keyboard.press('Escape'); await settle(page);
    assert.equal(await page.locator('#div-settings').count(), 0, 'Second Escape closes Settings via host handler');
  });
  await check('composition target removal recovers navigation without a compositionend', async page => {
    await ready(page); await page.locator('#composer').focus();
    await page.evaluate(() => { const el = document.getElementById('composer'); el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); el.remove(); }); await settle(page);
    assert.equal(await page.evaluate(() => window.pluginState().navigating), true); assert.equal(await key(page, 'KeyG'), true);
  });
  await check('b creates a browser when this session has none, returns from address autofocus to navigation, and toggles on repeat', async page => {
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
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.isExpanded()), false);
    assert.equal(await page.evaluate(() => window.pluginState().area), 'conversation');
    await key(page, 'KeyB'); await ready(page);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.isExpanded()), true);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.active().id), current.id);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.openTabs.getSnapshot().length), 2);
    assert.equal(await page.evaluate(() => window.pluginState().navigating), true);
    assert.equal(await page.locator('#address').inputValue(), 'draft');
  }, { initialTabs: [{ sessionId: 's2', tabId: 'foreign-browser', kind: 'browser' }], activeTabId: null });
  await check('b, t and e toggle collapse when already visible and switch directly when another kind is active', async page => {
    await ready(page);
    await page.evaluate(() => { window.originalAddress = document.getElementById('address'); window.originalAddress.value = 'keep this address'; });
    // b1 is already visible: first b collapses, second b reopens b1 without losing content or other tabs.
    await key(page, 'KeyB'); await ready(page);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.isExpanded()), false);
    assert.equal(await page.evaluate(() => window.pluginState().area), 'conversation');
    await key(page, 'KeyB'); await ready(page);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.isExpanded()), true);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.active().id), 'b1');
    assert.equal(await page.evaluate(() => document.getElementById('address') === window.originalAddress), true);
    assert.equal(await page.locator('#address').inputValue(), 'keep this address');
    // Switching from browser to files keeps dock expanded; pressing e again collapses it.
    await key(page, 'KeyE'); await ready(page);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.isExpanded()), true);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.active().kind), 'files');
    await key(page, 'KeyE'); await ready(page);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.isExpanded()), false);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.openTabs.getSnapshot().length), 3);
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
  await check('n b creates a separate browser, focuses and selects #address, and returns to navigation on valid URL submit', async page => {
    await ready(page);
    const ids = new Set(['b1']);
    for (let i = 0; i < 2; i++) {
      assert.equal(await key(page, 'KeyN'), true);
      assert.equal(await key(page, 'KeyB'), true);
      await settle(page);
      const id = await page.evaluate(() => window.fixture.sidebarRight.active().id);
      assert.equal(ids.has(id), false); ids.add(id);
      const focusState = await page.evaluate(() => {
        const el = document.activeElement;
        return { id: el?.id, start: el?.selectionStart, end: el?.selectionEnd, len: el?.value?.length };
      });
      assert.deepEqual(focusState, { id: 'address', start: 0, end: 5, len: 5 });
      assert.equal(await page.evaluate(() => window.pluginState().navigating), false);
      // Typing w inside #address never closes the tab.
      assert.equal(await key(page, 'KeyW'), false);
      // Invalid URL submit ([role="alert"] rendered) keeps focus in #address.
      await page.evaluate(() => {
        const alert = document.createElement('div'); alert.id = 'url-alert'; alert.setAttribute('role', 'alert'); alert.textContent = 'invalid';
        document.querySelector('[data-dockkit-pane]').append(alert);
        document.getElementById('browser-form').requestSubmit();
      });
      await settle(page);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'address');
      assert.equal(await page.evaluate(() => window.pluginState().navigating), false);
      // Valid URL submit removes alert and returns cleanly to browser Shortcut Mode.
      await page.evaluate(() => {
        document.getElementById('url-alert').remove();
        document.getElementById('browser-form').requestSubmit();
      });
      await ready(page);
      assert.equal(await page.evaluate(() => window.pluginState().area), 'browser');
      assert.equal(await page.evaluate(() => window.fixture.sidebarRight.active().id), id);
    }
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.openTabs.getSnapshot().length), 3);
  });
  for (const autofocus of [false, true]) await check(`first t waits for the terminal view and keeps subsequent commands in navigation (autofocus=${autofocus})`, async page => {
    await ready(page); await key(page, 'KeyT'); await settle(page);
    assert.ok(await page.evaluate(() => window.pluginState().pending));
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
  await check('first t followed by fullscreen still waits for delayed terminal autofocus', async page => {
    await ready(page); await key(page, 'KeyT'); await settle(page);
    await key(page, 'KeyR', { shift: true }); await settle(page);
    await page.evaluate(() => window.fixture.terminal.set({ writable: true, phase: 'connected' })); await settle(page);
    assert.ok(await page.evaluate(() => window.pluginState().pending), 'Fullscreen must preserve the wait for the terminal view');
    await page.evaluate(() => window.fixture.mountTerminal(true)); await ready(page);
    assert.equal(await page.evaluate(() => document.getElementById('frame').hasAttribute('data-rightbar-fullscreen')), true);
    assert.equal(await page.evaluate(() => window.pluginState().navigating), true);
  });
  await check('n t creates a new terminal and focuses #terminal-input once writable, while t toggles without losing input', async page => {
    await ready(page);
    for (let i = 0; i < 2; i++) {
      const previous = await page.evaluate(() => window.fixture.sidebarRight.active().id);
      await page.evaluate(() => window.fixture.terminal.set({ writable: false, phase: 'opening' }));
      await key(page, 'KeyN'); await key(page, 'KeyT'); await settle(page);
      assert.ok(await page.evaluate(() => window.pluginState().pending));
      await page.evaluate(() => { window.fixture.terminal.set({ writable: true, phase: 'connected' }); window.fixture.mountTerminal(false); });
      await page.waitForFunction(() => document.activeElement?.id === 'terminal-input', null, { timeout: 2500 });
      assert.equal(await page.evaluate(() => window.pluginState().navigating), false);
      const current = await page.evaluate(() => window.fixture.sidebarRight.active().id);
      assert.notEqual(current, previous);
      await page.evaluate(() => { window.originalTerminal = document.getElementById('terminal-input'); window.originalTerminal.value = 'unsent command'; });
      await page.evaluate(() => window.fixture.navigate()); await ready(page);
      // Pressing t once collapses, pressing t again reopens the same terminal with its draft intact.
      await key(page, 'KeyT'); await ready(page);
      assert.equal(await page.evaluate(() => window.fixture.sidebarRight.isExpanded()), false);
      await key(page, 'KeyT'); await ready(page);
      assert.equal(await page.evaluate(() => window.fixture.sidebarRight.isExpanded()), true);
      assert.equal(await page.evaluate(() => window.fixture.sidebarRight.active().id), current);
      assert.equal(await page.evaluate(() => document.getElementById('terminal-input') === window.originalTerminal), true);
      assert.equal(await page.locator('#terminal-input').inputValue(), 'unsent command');
    }
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.openTabs.getSnapshot().filter(t => t.kind === 'terminal').length), 2);
  });
  await check('n c creates or reuses a session and focuses #composer directly once open', async page => {
    await ready(page);
    // 1. Blank-session reuse (current session s1 is already blank): focuses #composer directly.
    await page.evaluate(() => window.fixture.sessionList.set({ byId: { s1: { blank: true } } }));
    await key(page, 'KeyN'); await key(page, 'KeyC');
    await page.waitForFunction(() => document.activeElement?.id === 'composer', null, { timeout: 2500 });
    assert.equal(await page.evaluate(() => window.fixture.workspace.sessionRequested), true);
    assert.equal(await page.evaluate(() => window.pluginState().navigating), false);
    await key(page, 'Escape'); await ready(page);
    // 2. Async new session mount (non-blank s1 -> s2 with loading -> open): waits for s2 open, then focuses #composer.
    await page.evaluate(() => { window.fixture.sessionList.set({ byId: { s1: { blank: false } } }); window.fixture.workspace.sessionRequested = false; });
    await key(page, 'KeyN'); await key(page, 'KeyC'); await settle(page);
    await page.evaluate(() => window.fixture.commitSession('s2', 'loading')); await settle(page);
    assert.notEqual(await page.evaluate(() => document.activeElement?.id), 'composer');
    await page.evaluate(() => window.fixture.session.set({ openState: 'open', running: false }));
    await page.waitForFunction(() => document.activeElement?.id === 'composer', null, { timeout: 2500 });
    assert.equal(await page.evaluate(() => window.pluginState().navigating), false);
  });
  await check('typing in a different input cancels a pending tool handoff', async page => {
    await ready(page); await key(page, 'KeyN'); await key(page, 'KeyT'); await settle(page);
    await page.evaluate(() => { window.fixture.click('composer'); document.getElementById('composer').focus(); });
    await page.evaluate(() => { window.fixture.terminal.set({ writable: true, phase: 'connected' }); window.fixture.mountTerminal(); }); await settle(page);
    assert.equal(await page.evaluate(() => window.pluginState().pending), undefined);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'composer');
  });
  await check('stale tool occurrence cannot complete a pending handoff', async page => {
    await ready(page); await key(page, 'KeyN'); await key(page, 'KeyT'); await settle(page);
    await page.evaluate(() => { window.fixture.invalidateTarget(); window.fixture.terminal.set({ writable: true, phase: 'connected' }); window.fixture.mountTerminal(); }); await settle(page);
    assert.equal(await page.evaluate(() => window.pluginState().pending), undefined);
  });
  await check('Tab, Shift+Tab and g 1..9 badges switch tools cleanly while preserving native Tab inside modals and panels', async page => {
    await ready(page);
    await key(page, 'KeyN'); await key(page, 'KeyB'); await settle(page);
    await key(page, 'Escape'); await ready(page);
    const second = await page.evaluate(() => window.fixture.sidebarRight.active().id); assert.notEqual(second, 'b1');
    await key(page, 'KeyE'); await ready(page);
    const third = await page.evaluate(() => window.fixture.sidebarRight.active().id);
    // Clean tab strip normally: zero badges and zero host tab mutations.
    assert.equal(await page.locator('.sc-tab-badge').count(), 0);
    // Pressing g immediately shows badges 1, 2, 3 over visible tabs even before sc-panel delay.
    await key(page, 'KeyG'); await settle(page);
    assert.deepEqual(await page.locator('.sc-tab-badge').allInnerTexts(), ['1', '2', '3']);
    // Pressing 2 jumps to second tab and clears badges immediately.
    await key(page, 'Digit2'); await ready(page);
    assert.equal(await page.locator('.sc-tab-badge').count(), 0);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.active().id), second);
    // Tab and Shift+Tab cycle forward and backward.
    assert.equal(await key(page, 'Tab'), true); await ready(page);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.active().id), third);
    assert.equal(await key(page, 'Tab', { shift: true }), true); await ready(page);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.active().id), second);
    // Inside .sc-panel or dialog, Tab is left to native focus traversal.
    await key(page, 'Slash', { shift: true }); await settle(page);
    await page.locator('.sc-panel button').first().focus();
    assert.equal(await key(page, 'Tab'), false);
    await key(page, 'Escape'); await ready(page);
    await key(page, 'KeyW'); await ready(page);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.active().id), third);
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
  const PRIMARY = 'magic-shortcuts.navigate';
  const returnKey = page => page.locator(`[data-sc-return="${PRIMARY}"]`);
  const bindingOf = page => page.evaluate(id => window.fixture.catalog.getSnapshot().find(row => row.id === id).binding, PRIMARY);
  const recordReturn = async (page, combo) => {
    await page.getByRole('button', { name: '自定义…', exact: true }).click();
    await page.getByLabel('录制回到快捷模式快捷键').press(combo); await settle(page);
  };
  const nativeStatus = page => page.locator('.sc-preference-section .sc-status').first().innerText();
  await check('⌥ Esc is the single default return shortcut, with one-click ⌃ Esc switch and no primary/alternate split', async page => {
    await ready(page);
    assert.deepEqual(await page.evaluate(() => [...window.fixture.commands.keys()]), [PRIMARY, 'shortcutter.copyUrl']);
    await page.locator('#composer').focus(); await settle(page);
    assert.equal(await page.evaluate(() => window.pluginState().navigating), false);
    assert.equal(await page.evaluate(() => window.fixture.navigate()), 'handled'); await ready(page);
    await page.evaluate(() => window.fixture.preferences());
    assert.equal(await returnKey(page).innerText(), '⌥ Esc');
    assert.equal(await page.getByRole('button', { name: '⌥ Esc（默认）', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByRole('button', { name: '⌃ Esc', exact: true }).getAttribute('aria-pressed'), 'false');
    assert.equal(await page.getByRole('button', { name: '自定义…', exact: true }).getAttribute('aria-pressed'), 'false');
    assert.equal(await page.getByText('主快捷键').count(), 0);
    assert.equal(await page.getByText('备用快捷键').count(), 0);
    assert.equal(await page.getByText('⌘ J').count(), 0, 'The old ⌘ J default is gone');
    assert.equal(await page.locator('[data-sc-system-note]').count(), 0, 'No Game Overlay warning unless ⌘ Esc is chosen');
  });
  await check('return shortcut switches between ⌥ Esc, ⌃ Esc and custom binding in one row', async page => {
    await page.evaluate(() => window.fixture.preferences());
    await page.getByRole('button', { name: '⌃ Esc', exact: true }).click(); await settle(page);
    assert.deepEqual(await bindingOf(page), { code: 'Escape', modifiers: ['control'] });
    assert.equal(await returnKey(page).innerText(), '⌃ Esc');
    assert.equal(await page.getByRole('button', { name: '⌃ Esc', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByRole('button', { name: '⌥ Esc（默认）', exact: true }).getAttribute('aria-pressed'), 'false');
    await recordReturn(page, 'Meta+Shift+KeyK');
    assert.equal(await page.getByRole('button', { name: '自定义…', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: '保存组合', exact: true }).click(); await settle(page);
    assert.deepEqual(await bindingOf(page), { code: 'KeyK', modifiers: ['meta', 'shift'] });
    assert.equal(await page.getByRole('button', { name: '自定义…', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: '⌥ Esc（默认）', exact: true }).click(); await settle(page);
    assert.equal(await returnKey(page).innerText(), '⌥ Esc');
    assert.equal(await page.getByRole('button', { name: '⌥ Esc（默认）', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await page.evaluate(() => window.fixture.native.edits.map(e => [e.operation.type, e.operation.id])),
      [['set', PRIMARY], ['set', PRIMARY], ['reset', PRIMARY]]);
  });
  await check('modified Escape records and saves; ⌘ Esc shows Game Overlay note; bare Escape cancels', async page => {
    await page.evaluate(() => window.fixture.preferences());
    await recordReturn(page, 'Meta+Escape');
    await page.getByRole('button', { name: '保存组合', exact: true }).click(); await settle(page);
    assert.equal(await page.locator('[data-sc-system-note]').count(), 1, 'Game Overlay guidance appears when plain ⌘ Esc is chosen');
    await recordReturn(page, 'Shift+Meta+Escape');
    await page.getByRole('button', { name: '保存组合', exact: true }).click(); await settle(page);
    assert.deepEqual(await bindingOf(page), { code: 'Escape', modifiers: ['meta', 'shift'] });
    assert.equal(await page.locator('[data-sc-system-note]').count(), 0, 'Guidance is specific to plain ⌘ Esc');
    await recordReturn(page, 'Escape');
    assert.equal(await page.getByLabel('录制回到快捷模式快捷键').count(), 0);
    assert.equal(await page.evaluate(() => window.fixture.native.recording), false);
    assert.equal(await page.evaluate(() => window.fixture.native.edits.length), 2);
  });
  await check('Shift semicolon recording uses its physical code even when key is colon', async page => {
    await page.evaluate(() => window.fixture.preferences());
    await page.getByRole('button', { name: '自定义…', exact: true }).click();
    await page.getByLabel('录制回到快捷模式快捷键').dispatchEvent('keydown', { key: ':', code: 'Semicolon', metaKey: true, shiftKey: true });
    await page.getByLabel('录制回到快捷模式快捷键').dispatchEvent('keyup', { key: ':', code: 'Semicolon', metaKey: true, shiftKey: true });
    await page.getByRole('button', { name: '保存组合', exact: true }).click(); await settle(page);
    assert.deepEqual(await bindingOf(page), { code: 'Semicolon', modifiers: ['meta', 'shift'] });
  });
  await check('two held physical keys are recorded and never indicated as a single-key preset', async page => {
    await page.evaluate(() => window.fixture.preferences());
    await page.getByRole('button', { name: '自定义…', exact: true }).click();
    await page.getByLabel('录制回到快捷模式快捷键').focus();
    await page.keyboard.down('Alt'); await page.keyboard.down('Escape'); await page.keyboard.press('j');
    await page.keyboard.up('Escape'); await page.keyboard.up('Alt');
    await page.getByRole('button', { name: '保存组合', exact: true }).click(); await settle(page);
    assert.deepEqual(await bindingOf(page), { code: 'Escape', secondCode: 'KeyJ', modifiers: ['alt'] });
    assert.equal(await page.getByRole('button', { name: '⌥ Esc（默认）', exact: true }).getAttribute('aria-pressed'), 'false');
    assert.equal(await page.getByRole('button', { name: '自定义…', exact: true }).getAttribute('aria-pressed'), 'true');
  });
  await check('conflicts, concurrent edits and save failures preserve the current shortcut and allow retry', async page => {
    await page.evaluate(() => window.fixture.preferences());
    await page.evaluate(() => { window.fixture.native.conflicts = ['another-command']; });
    await page.getByRole('button', { name: '⌃ Esc', exact: true }).click(); await settle(page);
    assert.match(await nativeStatus(page), /已被 DSH 占用/);
    assert.equal(await returnKey(page).innerText(), '⌥ Esc');
    await recordReturn(page, 'Meta+KeyK');
    assert.match(await nativeStatus(page), /已被 DSH 占用/);
    assert.equal(await page.getByRole('button', { name: '保存组合', exact: true }).count(), 0);
    await page.getByLabel('录制回到快捷模式快捷键').press('Escape'); await settle(page);
    assert.equal(await page.evaluate(() => window.fixture.native.edits.length), 0);
    await page.evaluate(() => { window.fixture.native.conflicts = ['magic-shortcuts.navigate']; });
    for (const result of ['conflict', 'stale', 'failed', 'throw']) {
      await page.evaluate(result => { window.fixture.native.result = result === 'throw' ? undefined : result; window.fixture.native.throws = result === 'throw'; }, result);
      await recordReturn(page, 'Meta+KeyK');
      await page.getByRole('button', { name: '保存组合', exact: true }).click(); await settle(page);
      assert.equal(await returnKey(page).innerText(), '⌥ Esc', result);
      assert.equal(await page.getByRole('button', { name: '自定义…', exact: true }).isEnabled(), true);
    }
    await page.evaluate(() => { window.fixture.native.result = undefined; window.fixture.native.throws = false; });
    await recordReturn(page, 'Meta+KeyK');
    await page.getByRole('button', { name: '保存组合', exact: true }).click(); await settle(page);
    assert.equal(await returnKey(page).innerText(), '⌘ K');
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
  await check('switching to the ⌃ Esc preset previews the same way', async page => {
    await ready(page);
    await page.evaluate(() => window.fixture.preferences());
    await page.getByRole('button', { name: '⌃ Esc', exact: true }).click(); await settle(page);
    await page.evaluate(() => window.fixture.layout.selectPanel(null)); await ready(page);
    await freezeClock(page);
    await page.locator('#composer').focus(); await advance(page, 50);
    assert.equal(await page.evaluate(() => window.fixture.navigate()), 'handled');
    await advance(page, 100); assert.equal(await page.locator('.sc-panel').count(), 0);
    await advance(page, 400); assert.equal(await page.locator('.sc-panel').count(), 1);
    assert.match(await page.locator('.sc-panel-footer').innerText(), /Esc/);
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
    for (const [code, extra] of [['KeyB', {}], ['KeyC', {}], ['KeyR', {}], ['KeyR', {}], ['KeyS', {}], ['KeyS', {}], ['KeyE', {}], ['Tab', {}], ['Tab', { shift: true }], ['KeyR', { shift: true }], ['KeyR', { shift: true }], ['KeyW', {}]]) {
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
  }, { initialTabs: [{ sessionId: 's1', tabId: 'b1', kind: 'browser' }, { sessionId: 's1', tabId: 'b2', kind: 'browser' }, { sessionId: 's1', tabId: 'f1', kind: 'files' }] });
  await check('a delayed terminal handoff stays quiet after its shortcut, then explicit return still previews help', async page => {
    await ready(page); await freezeClock(page);
    await key(page, 'KeyT'); await advance(page, 100);
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
    await key(page, 'KeyN'); await key(page, 'KeyC'); await advance(page, 100);
    assert.equal(await page.evaluate(() => window.fixture.workspace.sessionRequested), true);
    await advance(page, 500);
    await page.evaluate(() => window.fixture.commitSession('s2')); await advance(page, 100);
    await page.evaluate(() => window.fixture.session.set({ openState: 'open', running: false }));
    await advance(page, 100);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'composer');
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
  await check('g e and g a open Plugins and Schedules, focus search with i, return on Esc, and close on w or c', async page => {
    await ready(page);
    await key(page, 'KeyG'); await key(page, 'KeyE'); await ready(page); await settle(page);
    assert.equal(await page.evaluate(() => window.fixture.panelInfo.getSnapshot().activePanelId), 'plugins');
    assert.equal(await page.locator('.sc-focus-cue[data-sc-focus-area="plugins"]').count(), 1);
    await key(page, 'Slash', { shift: true }); await settle(page);
    assert.equal(await page.locator('.sc-panel-header .sc-muted').innerText(), '插件');
    assert.match(await page.locator('[data-sc-command="closeTab"]').innerText(), /关闭当前页面/);
    await key(page, 'KeyI'); await settle(page);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'panel-search');
    assert.equal(await page.evaluate(() => window.pluginState().navigating), false);
    assert.equal(await key(page, 'Escape'), true); await ready(page); await settle(page);
    assert.equal(await page.evaluate(() => window.fixture.panelInfo.getSnapshot().activePanelId), 'plugins');
    await key(page, 'KeyG'); await key(page, 'KeyA'); await ready(page); await settle(page);
    assert.equal(await page.evaluate(() => window.fixture.panelInfo.getSnapshot().activePanelId), 'schedules');
    assert.equal(await page.locator('.sc-focus-cue[data-sc-focus-area="schedules"]').count(), 1);
    await key(page, 'KeyW'); await ready(page); await settle(page);
    assert.equal(await page.evaluate(() => window.fixture.panelInfo.getSnapshot().activePanelId), null);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.mounted.getSnapshot()), 's1');
    assert.equal(await page.locator('.sc-focus-cue[data-sc-focus-area="conversation"]').count(), 1);
    await key(page, 'KeyG'); await key(page, 'KeyE'); await ready(page);
    await key(page, 'KeyC'); await ready(page);
    assert.equal(await page.evaluate(() => window.fixture.panelInfo.getSnapshot().activePanelId), null);
  });
  await check('g s also opens Settings on hosts where the sidebar shell owns settings.section', async page => {
    await ready(page);
    await key(page, 'KeyG'); await key(page, 'KeyS');
    await page.locator('#host-settings[open]').waitFor();
  }, { legacySettingsSections: true });
  await check('w closes DSH Settings without touching background tools, and g b preserves session history across global pages', async page => {
    await ready(page);
    await key(page, 'KeyG'); await key(page, 'KeyS'); await settle(page);
    assert.equal(await page.evaluate(() => document.getElementById('host-settings')?.open), true);
    assert.equal(await page.locator('#host-settings .sc-preferences').count(), 0, 'DSH Settings no longer mounts Shortcutter section');
    await key(page, 'Slash', { shift: true }); await settle(page);
    assert.match(await page.locator('[data-sc-command="closeTab"]').innerText(), /关闭设置/);
    await key(page, 'KeyW'); await ready(page);
    assert.equal(await page.evaluate(() => document.getElementById('host-settings')?.open), false);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.openTabs.getSnapshot().length), 1);

    await page.evaluate(() => { window.fixture.commitSession('s2', 'open'); }); await ready(page);
    await key(page, 'KeyG'); await key(page, 'KeyE'); await ready(page);
    await key(page, 'KeyW'); await ready(page);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.mounted.getSnapshot()), 's2');
    await key(page, 'KeyG'); await key(page, 'KeyB'); await ready(page);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.mounted.getSnapshot()), 's1');
    await key(page, 'KeyG'); await key(page, 'KeyA'); await ready(page);
    await key(page, 'KeyG'); await key(page, 'KeyB'); await ready(page);
    assert.equal(await page.evaluate(() => window.fixture.panelInfo.getSnapshot().activePanelId), null);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.mounted.getSnapshot()), 's2');
  });
  await check('Shortcutter settings live in Plugins bundle config, open from panel gear, and support Esc/w navigation', async page => {
    await ready(page);
    const slots = await page.evaluate(() => window.fixture.registeredSlots);
    assert.equal(slots.includes('plugins.bundle.config:dsh-shortcutter'), true);
    assert.equal(slots.some(s => s.startsWith('settings.section')), false);

    await key(page, 'Slash', { shift: true }); await settle(page);
    assert.equal(await page.locator('.sc-panel-title').innerText(), '快捷');
    assert.equal(await page.locator('.sc-panel .sc-icon-button').getAttribute('aria-label'), 'Shortcutter 设置');
    await page.locator('.sc-panel .sc-icon-button').click(); await ready(page); await settle(page);
    assert.deepEqual(await page.evaluate(() => window.fixture.pluginNavigation.openedBundles), ['dsh-shortcutter']);
    assert.equal(await page.evaluate(() => window.fixture.panelInfo.getSnapshot().activePanelId), 'plugins');
    assert.equal(await page.locator('[data-plugin-detail="dsh-shortcutter"] .sc-preferences').count(), 1);
    assert.equal(await page.locator('.sc-preferences h2').count(), 0, 'No redundant h2 inside bundle config');
    assert.equal(await page.locator('.sc-binding-group').count(), 3);

    await page.getByLabel('切换侧栏').focus(); await settle(page);
    assert.equal(await page.evaluate(() => window.pluginState().navigating), false);
    await page.keyboard.press('Escape'); await ready(page);
    assert.equal(await page.evaluate(() => window.fixture.panelInfo.getSnapshot().activePanelId), 'plugins');
    await key(page, 'KeyW'); await ready(page);
    assert.equal(await page.evaluate(() => window.fixture.panelInfo.getSnapshot().activePanelId), null);
  });
  await check('tool keys from global pages return to the session workbench in one step without collapsing and keep layout when unavailable', async page => {
    await ready(page);
    await key(page, 'KeyN'); await key(page, 'KeyB'); await settle(page);
    await key(page, 'Escape'); await ready(page);
    const second = await page.evaluate(() => window.fixture.sidebarRight.active().id);
    await key(page, 'KeyG'); await key(page, 'KeyE'); await ready(page);
    await key(page, 'Tab', { shift: true }); await ready(page);
    assert.equal(await page.evaluate(() => window.fixture.panelInfo.getSnapshot().activePanelId), null);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.active().id), 'b1');

    // Pressing b on Schedules reveals b1 (kept expanded, NOT collapsed!).
    await key(page, 'KeyG'); await key(page, 'KeyA'); await ready(page);
    await key(page, 'KeyB'); await ready(page);
    assert.equal(await page.evaluate(() => window.fixture.panelInfo.getSnapshot().activePanelId), null);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.isExpanded()), true);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.active().id), 'b1');
    assert.equal(second !== 'b1', true);

    await page.evaluate(() => { window.fixture.availablePanels.delete('schedules'); });
    await key(page, 'KeyG'); await key(page, 'KeyA'); await settle(page);
    assert.equal(await page.locator('.sc-notice').textContent(), '定时任务页面当前不可用。');

    await page.evaluate(() => { window.fixture.commitSession(undefined, 'open'); }); await ready(page);
    await key(page, 'KeyG'); await key(page, 'KeyE'); await ready(page);
    await key(page, 'KeyB'); await settle(page);
    assert.equal(await page.evaluate(() => window.fixture.panelInfo.getSnapshot().activePanelId), 'plugins');
    assert.equal(await page.locator('.sc-notice').textContent(), '先打开一个会话，再打开工具面板。');
  });
  await check('Chinese IME composing/229 keys work in navigation mode while still protecting IME composition in inputs', async page => {
    await ready(page);
    // Simulate host compositionend reset hook like DSH installKeyboard.
    await page.evaluate(() => {
      for (const type of ['compositionstart', 'compositionend']) {
        document.addEventListener(type, () => window.fixedInput?.({ type: 'reset' }), true);
      }
    });

    // 1. n/g prefixes, Tab/Shift+Tab, digits and punctuation all work when host reports composing: true (keyCode 229 / WeType / SCIM).
    assert.equal(await key(page, 'KeyN', { composing: true }), true);
    assert.equal(await key(page, 'KeyB', { composing: true }), true); await settle(page);
    const createdId = await page.evaluate(() => window.fixture.sidebarRight.active().id);
    assert.notEqual(createdId, 'b1');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'address');
    await page.keyboard.press('Escape'); await ready(page);
    assert.equal(await key(page, 'Tab', { shift: true, composing: true }), true); await ready(page);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.active().id), 'b1');
    assert.equal(await key(page, 'KeyG', { composing: true }), true);
    assert.equal(await key(page, 'Digit2', { composing: true }), true); await ready(page);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.active().id), createdId);

    // Passive default navigation (focus on ordinary button rather than anchor) also works with composing: true.
    await page.locator('#ordinary').focus(); await settle(page);
    assert.equal(await page.evaluate(() => window.pluginState().navigating), true);
    assert.equal(await key(page, 'Slash', { shift: true, composing: true }), true); await settle(page);
    assert.equal(await page.locator('.sc-panel').count(), 1);

    // Escape in navigation mode cancels help even if IME reports key='Process', keyCode=229 or composing=true.
    await page.evaluate(() => {
      document.getElementById('ordinary').dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', code: 'Escape', keyCode: 229, bubbles: true, cancelable: true }));
    }); await settle(page);
    assert.equal(await page.locator('.sc-panel').count(), 0);

    // Spurious compositionstart/compositionend on the navigation anchor or delayed compositionend must not wipe g prefix.
    await page.locator('#sc-navigation-anchor').focus(); await settle(page);
    assert.equal(await key(page, 'KeyG', { composing: true }), true);
    await page.evaluate(() => {
      const anchor = document.getElementById('sc-navigation-anchor');
      anchor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      anchor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      document.getElementById('composer').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    }); await settle(page);
    assert.equal(await page.evaluate(() => window.pluginState().prefix), 'g');
    assert.equal(await key(page, 'KeyE', { composing: true }), true); await ready(page);
    assert.equal(await page.evaluate(() => window.fixture.panelInfo.getSnapshot().activePanelId), 'plugins');
    assert.equal(await key(page, 'KeyC', { composing: true }), true); await ready(page);
    assert.equal(await page.evaluate(() => window.fixture.panelInfo.getSnapshot().activePanelId), null);

    // 2. Inside #composer, active Chinese IME composition still owns keys and the 1st Escape; 2nd Escape returns to navigation.
    await page.locator('#composer').focus(); await settle(page);
    await page.evaluate(() => {
      document.getElementById('composer').dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    }); await settle(page);
    assert.equal(await key(page, 'KeyB', { composing: true }), false);
    assert.equal(await key(page, 'Escape', { composing: true }), false);
    await page.evaluate(() => {
      document.getElementById('composer').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
    }); await settle(page);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'composer', '1st Escape during IME composition stays in composer');
    assert.equal(await page.evaluate(() => window.pluginState().navigating), false);

    // IME finishes cancelling preedit; 2nd Escape returns to navigation, even if host fixedInput still had stale composing: true.
    await page.evaluate(() => {
      document.getElementById('composer').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    }); await settle(page);
    await page.keyboard.press('Escape'); await ready(page);
    assert.equal(await page.evaluate(() => window.pluginState().navigating), true);
    assert.equal(await key(page, 'KeyS', { composing: true }), true); await settle(page);
    assert.equal(await page.evaluate(() => document.getElementById('frame').hasAttribute('data-sidebar-collapsed')), true);

    // 3. AltGraph modifier remains ignored even when g.alt is false and g.composing is true.
    await page.evaluate(() => {
      const ev = new KeyboardEvent('keydown', { key: 'ß', code: 'KeyS', bubbles: true, modifierAltGraph: true });
      document.dispatchEvent(ev);
    });
    assert.equal(await key(page, 'KeyS', { composing: true }), false);
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keyup', { key: 'AltGraph', code: 'AltRight', bubbles: true })));
    assert.equal(await key(page, 'KeyS', { composing: true }), true); await settle(page);
    assert.equal(await page.evaluate(() => document.getElementById('frame').hasAttribute('data-sidebar-collapsed')), false);

    // 4. Settings binding inputs accept Chinese full-width brackets under Chinese IME.
    await page.evaluate(() => window.fixture.preferences()); await settle(page);
    await page.getByLabel('上一个工具标签').fill('【');
    await page.getByLabel('下一个工具标签').fill('】');
    await page.getByRole('button', { name: '保存设置', exact: true }).click(); await settle(page);
    assert.equal(await page.getByLabel('上一个工具标签').inputValue(), '[');
    assert.equal(await page.getByLabel('下一个工具标签').inputValue(), ']');
  });
  await check('Shift+Cmd+C copies browser URL from focused webview without stealing focus and falls back past about:blank', async page => {
    await unfocusedWebview(page);
    await freezeClock(page);
    await page.evaluate(() => {
      document.getElementById('address').value = 'https://fallback.example/path';
      window.testWebview.getURL = () => 'https://github.com/bywangdong/dsh-shortcutter';
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: () => Promise.reject(new DOMException('Document is not focused.', 'NotAllowedError')) }
      });
      window.copiedPayloads = [];
      document.execCommand = command => {
        if (command !== 'copy') return false;
        const data = new DataTransfer();
        const setData = data.setData.bind(data);
        data.setData = (type, value) => {
          if (type === 'text/plain') window.copiedPayloads.push(value);
          return setData(type, value);
        };
        const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data });
        document.dispatchEvent(event);
        return true;
      };
      document.getElementById('frame').setAttribute('data-rightbar-fullscreen', '');
      document.querySelector('[data-sidebar-right-panel]').dataset.sidebarRightPanel = 'fullscreen';
    });
    assert.equal(await page.evaluate(() => window.fixture.navigate({ source: 'webview', target: window.testWebview }, 'shortcutter.copyUrl')), 'handled');
    await advance(page, 20);
    assert.deepEqual(await page.evaluate(() => window.copiedPayloads), ['https://github.com/bywangdong/dsh-shortcutter']);
    assert.equal(await page.evaluate(() => window.outerFocusCalls), 0);
    assert.equal(await page.evaluate(() => document.activeElement === window.testWebview), true);
    assert.equal(await page.locator('.sc-notice[data-sc-compact]').textContent(), '已复制网址 · github.com');
    const aboveFullscreen = await page.locator('.sc-notice[data-sc-compact]').evaluate(el => getComputedStyle(el).zIndex);
    assert.equal(aboveFullscreen, '100');
    await advance(page, 1650);
    assert.equal(await page.locator('.sc-notice').count(), 0);

    await page.evaluate(() => { window.testWebview.getURL = () => 'about:blank#lease-123'; });
    assert.equal(await page.evaluate(() => window.fixture.navigate({ source: 'webview', target: window.testWebview }, 'shortcutter.copyUrl')), 'handled');
    await advance(page, 20);
    assert.deepEqual(await page.evaluate(() => window.copiedPayloads.at(-1)), 'https://fallback.example/path');
    assert.equal(await page.locator('.sc-notice[data-sc-compact]').textContent(), '已复制网址 · fallback.example');
  });
  await check('Shift+Cmd+C copies visible browser URL while typing in composer without disturbing selection', async page => {
    await ready(page);
    await page.evaluate(() => {
      document.getElementById('address').value = 'https://docs.example.org/guide?page=2';
      window.asyncCopied = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: text => { window.asyncCopied.push(text); return Promise.resolve(); } }
      });
      const composer = document.getElementById('composer');
      composer.focus();
      composer.setSelectionRange(1, 4);
    });
    await settle(page);
    assert.equal(await page.evaluate(() => window.fixture.navigate({ target: document.getElementById('composer') }, 'shortcutter.copyUrl')), 'handled');
    await settle(page);
    assert.deepEqual(await page.evaluate(() => window.asyncCopied), ['https://docs.example.org/guide?page=2']);
    assert.deepEqual(await page.evaluate(() => {
      const composer = document.getElementById('composer');
      return {
        id: document.activeElement?.id,
        value: composer.value,
        start: composer.selectionStart,
        end: composer.selectionEnd,
        navigating: window.pluginState().navigating
      };
    }), { id: 'composer', value: 'draft', start: 1, end: 4, navigating: false });
    assert.equal(await page.locator('.sc-notice[data-sc-compact]').textContent(), '已复制网址 · docs.example.org');
  });
  await check('Shift+Cmd+C handles collapsed panel, non-browser tabs, blank pages, blocked overlays, and settings display', async page => {
    await ready(page);
    await page.evaluate(() => {
      window.asyncCopied = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: text => { window.asyncCopied.push(text); return Promise.resolve(); } }
      });
      document.getElementById('address').value = 'draft';
    });
    assert.equal(await page.evaluate(() => window.fixture.navigate({}, 'shortcutter.copyUrl')), 'handled');
    await settle(page);
    assert.equal(await page.locator('.sc-notice[data-sc-compact]').textContent(), '当前浏览器还没有可复制的网址。');
    assert.deepEqual(await page.evaluate(() => window.asyncCopied), []);

    await page.evaluate(() => { document.getElementById('address').value = 'https://hidden.example.com'; });
    await key(page, 'KeyE'); await ready(page);
    assert.equal(await page.evaluate(() => window.fixture.navigate({}, 'shortcutter.copyUrl')), 'handled');
    await settle(page);
    assert.equal(await page.locator('.sc-notice[data-sc-compact]').textContent(), '当前没有打开的浏览器。');

    await key(page, 'KeyB'); await ready(page);
    await key(page, 'KeyB'); await ready(page);
    assert.equal(await page.evaluate(() => window.fixture.sidebarRight.isExpanded()), false);
    assert.equal(await page.evaluate(() => window.fixture.navigate({}, 'shortcutter.copyUrl')), 'handled');
    await settle(page);
    assert.equal(await page.locator('.sc-notice[data-sc-compact]').textContent(), '当前没有打开的浏览器。');
    assert.deepEqual(await page.evaluate(() => window.asyncCopied), []);

    // Blocking conditions: SessionSearch dialog, menu, hidden document, and unverified webview.
    await key(page, 'KeyF'); await page.getByRole('combobox').waitFor();
    assert.equal(await page.evaluate(() => window.fixture.navigate({}, 'shortcutter.copyUrl')), 'blocked');
    await page.keyboard.press('Escape'); await ready(page);

    await page.evaluate(() => { const menu = document.createElement('div'); menu.id = 'copy-menu'; menu.role = 'menu'; document.body.append(menu); });
    await settle(page);
    assert.equal(await page.evaluate(() => window.fixture.navigate({}, 'shortcutter.copyUrl')), 'blocked');
    await page.evaluate(() => document.getElementById('copy-menu').remove());

    await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, value: true }));
    assert.equal(await page.evaluate(() => window.fixture.navigate({}, 'shortcutter.copyUrl')), 'blocked');
    await page.evaluate(() => { delete document.hidden; });

    await page.evaluate(() => window.fixture.preferences()); await settle(page);
    assert.equal(await page.locator('[data-sc-copy-url="shortcutter.copyUrl"]').innerText(), '⇧ ⌘ C');
  }, { initialTabs: [{ sessionId: 's1', tabId: 'b1', kind: 'browser' }, { sessionId: 's1', tabId: 'f1', kind: 'files' }] });
  return { passed: results.filter(result => result.pass).length, total: results.length, results };
}
