// The production plugin and production React run against this deliberately small
// public host contract. It never loads DSH accounts, storage or embedded tools.
export const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0}#frame{display:flex;height:800px}#sidebar{width:200px}#conversation{width:600px}#right{width:400px}
#log{height:600px;overflow:auto}[data-shell-overlay]{position:fixed;inset:0;z-index:20;pointer-events:none}
#frame[data-rightbar-fullscreen] [data-dockkit-pane]{position:fixed;inset:0;z-index:40;background:white}
#right[data-sidebar-right-open="false"] [data-dockkit-pane]{display:none}
/* Like DSH's body portal rule, native drag exclusion is inherited. */
body>:not(#frame){-webkit-app-region:no-drag}
</style><div id="frame"><aside id="sidebar">Sessions</aside><main id="conversation"><input id="composer" value="draft"><button id="ordinary">Ordinary button</button><div id="log"></div></main><aside id="right" data-rightbar-col data-sidebar-right-open="true"><div data-sidebar-right-session="s1" data-sidebar-right-panel="dock"><div data-dockkit-strip></div><div data-dockkit-pane="p1"></div></div></aside><div data-shell-overlay id="overlay"></div></div>`;

export function setup({ instrument = false, openState = 'open', nodes = 2000, autoFullscreen = false, legacySettingsSections = false,
  hasSessionStatus = true, toolMountDelay = 0,
  initialTabs = [{ sessionId: 's1', tabId: 'b1', kind: 'browser' }], activeTabId = initialTabs[0]?.tabId } = {}) {
  window.counts = {};
  window.count = key => { window.counts[key] = (window.counts[key] || 0) + 1; };
  if (instrument) {
    const original = document.querySelectorAll.bind(document);
    document.querySelectorAll = selector => { window.count('documentQueryAll'); return original(selector); };
  }
  const log = document.getElementById('log');
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < nodes; i++) {
    const line = document.createElement('p'); line.textContent = 'Existing output ' + i; fragment.append(line);
  }
  log.append(fragment);
  function store(value) {
    const listeners = new Set();
    return { getSnapshot: () => value, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
      set: next => { value = next; for (const fn of [...listeners]) fn(); }, listenerCount: () => listeners.size };
  }
  const session = store({ openState, running: false });
  const sessionList = store({ phase: 'ready', ids: ['s1', 's2', 's3'], byId: {
    s1: { id: 's1', displayTitle: '当前会话', blank: false, updatedAt: 1 },
    s2: { id: 's2', displayTitle: '中文输入法修复', blank: false, updatedAt: 3 },
    s3: { id: 's3', displayTitle: 'Browser keyboard navigation', blank: false, updatedAt: 2 }
  } });
  const workspaceList = store({ phase: 'ready', state: 'idle', archivedSessionIds: [], items: [
    { workspaceId: 'project', title: 'Shortcutter', path: '/project', sessionIds: ['s1', 's2'] }
  ] });
  const terminal = store({ writable: false, phase: 'opening' });
  const sessionStatus = Object.assign(store(new Map()), { readingReady: store(true) });
  const mounted = store('s1');
  const panelInfo = store({ activePanelId: null });
  const availablePanels = new Set(['plugins', 'schedules']);
  const openTabs = store(initialTabs);
  let selectedSession = 's1', currentId = activeTabId, expanded = true, fullscreen = false, occurrence = {}, navigationRevision = 0, serial = 1;
  const active = () => {
    const tab = openTabs.getSnapshot().find(t => t.sessionId === mounted.getSnapshot() && t.tabId === currentId);
    return tab && { id: tab.tabId, kind: tab.kind, contentId: tab.tabId };
  };
  const target = () => ({ sessionId: mounted.getSnapshot(), tabId: currentId, paneId: 'p1', host: 'dock', occurrence, navigationRevision });
  let Preferences, preferencesRoot, activeBundle = null;
  const registeredSlots = [];
  const renderGlobalPanel = () => {
    const panelId = panelInfo.getSnapshot().activePanelId;
    preferencesRoot?.unmount(); preferencesRoot = undefined;
    for (const child of document.getElementById('conversation').children) if (child.id !== 'global-panel') child.hidden = panelId !== null;
    document.getElementById('global-panel')?.remove();
    if (panelId !== null) {
      const el = document.createElement('section'); el.id = 'global-panel'; el.dataset.globalPanel = panelId;
      if (panelId === 'plugins' && activeBundle === 'dsh-shortcutter' && Preferences) {
        el.innerHTML = `<div data-plugin-detail="dsh-shortcutter"><div id="bundle-config"></div></div>`;
        document.getElementById('conversation').prepend(el);
        preferencesRoot = window.createRoot(el.querySelector('#bundle-config'));
        preferencesRoot.render(window.React.createElement(Preferences, { view: 'page' }));
      } else {
        el.innerHTML = `<input id="panel-search" value=""><button id="panel-button">${panelId}</button>`;
        document.getElementById('conversation').prepend(el);
      }
    }
  };
  const renderTool = () => {
    const host = document.querySelector('[data-sidebar-right-session]'); host.dataset.sidebarRightSession = mounted.getSnapshot() ?? '';
    const strip = host.querySelector('[data-dockkit-strip]');
    strip.replaceChildren(...openTabs.getSnapshot().filter(t => t.sessionId === mounted.getSnapshot()).map(tab => {
      const el = document.createElement('span'); el.role = 'tab'; el.dataset.dockkitTab = tab.tabId;
      el.setAttribute('aria-selected', String(tab.tabId === currentId)); el.textContent = tab.kind;
      return el;
    }));
    const pane = host.querySelector('[data-dockkit-pane]'); pane.dataset.sidebarRightTab = currentId ?? '';
    pane.innerHTML = !active() ? '' : active().kind === 'terminal' ? '<div class="xterm"></div>'
      : active().kind === 'files' ? '<div id="files-view">files</div>'
      : '<form id="browser-form"><input id="address" value="draft"><span id="toolbar-blank">toolbar</span></form>';
    pane.querySelector('#browser-form')?.addEventListener('submit', e => e.preventDefault());
  };
  const renderPresentation = () => {
    const shown = expanded && !!mounted.getSnapshot();
    document.getElementById('right').dataset.sidebarRightOpen = String(shown);
    document.getElementById('frame').toggleAttribute('data-rightbar-fullscreen', shown && (autoFullscreen || fullscreen));
    document.querySelector('[data-sidebar-right-panel]').dataset.sidebarRightPanel = shown && (autoFullscreen || fullscreen) ? 'fullscreen' : 'dock';
  };
  const selectPanel = id => {
    if (id !== null && !availablePanels.has(id)) throw new Error(`layout.selectPanel: main panel "${id}" is not registered`);
    if (id !== 'plugins') activeBundle = null;
    if (panelInfo.getSnapshot().activePanelId !== id) {
      panelInfo.set({ activePanelId: id });
      renderGlobalPanel();
    }
    const nextMounted = id === null ? selectedSession : undefined;
    if (mounted.getSnapshot() !== nextMounted) mounted.set(nextMounted);
    renderTool(); renderPresentation();
  };
  renderTool();
  renderPresentation();
  const cleanups = [], commands = new Map();
  const defaults = {
    'magic-shortcuts.navigate': { code: 'Escape', modifiers: ['alt'] },
    'shortcutter.copyUrl': { code: 'KeyC', modifiers: ['primary', 'shift'] }
  };
  const describe = binding => {
    binding = { ...binding, modifiers: binding.modifiers.map(m => m === 'primary' ? 'meta' : m) };
    // Like DSH's macOS presentation: ⌃ ⌥ ⇧ ⌘ order regardless of input order.
    const order = ['control', 'alt', 'shift', 'meta'];
    return { binding, keys: [...[...binding.modifiers].sort((a, b) => order.indexOf(a) - order.indexOf(b)).map(m => ({ meta: '⌘', shift: '⇧', alt: '⌥', control: '⌃' })[m]), binding.code === 'Escape' ? 'Esc' : binding.code === 'Semicolon' ? ';' : binding.code.replace('Key', '')] };
  };
  const catalog = store(Object.entries(defaults).map(([id, binding]) => ({ id, ...describe(binding), modified: false, issue: null, conflicts: [] })));
  const shortcutConfig = store({ revision: 0 });
  const native = { recording: false, edits: [], conflicts: [], result: undefined, throws: false };
  const workspace = {
    sessionRequested: false, openedSessions: [],
    startSession() { workspace.sessionRequested = true; },
    openSession(id) { workspace.openedSessions.push(id); selectedSession = id; selectPanel(null); }
  };
  const pluginNavigation = {
    openedBundles: [],
    openList() { activeBundle = null; if (panelInfo.getSnapshot().activePanelId !== 'plugins') selectPanel('plugins'); else renderGlobalPanel(); },
    openBundle(name) {
      pluginNavigation.openedBundles.push(name);
      activeBundle = name;
      if (panelInfo.getSnapshot().activePanelId !== 'plugins') selectPanel('plugins');
      else renderGlobalPanel();
    }
  };
  const openHostSettings = () => {
    let dialog = document.getElementById('host-settings');
    if (!dialog) {
      dialog = document.createElement('dialog'); dialog.id = 'host-settings'; dialog.dataset.shortcutModal = 'settings';
      dialog.innerHTML = '<button id="host-settings-ok">OK</button>';
      document.body.append(dialog);
    }
    if (!dialog.open) dialog.showModal();
  };
  const settingsShell = {
    children: { 'settings.trigger': { kind: 'single', scope: 'root' } },
    store: { create: () => ({ actions: { open: openHostSettings } }) }
  };
  // DSH 0.2.3 moved settings.section from the sidebar shell to settings.section.view.
  if (legacySettingsSections) settingsShell.children['settings.section'] = { kind: 'list', scope: 'root' };
  const sidebarRight = {
    mounted, openTabs, active, isExpanded: () => expanded, commandTarget: () => target(),
    isTargetCurrent: captured => captured.sessionId === mounted.getSnapshot() && captured.tabId === currentId
      && captured.occurrence === occurrence && captured.navigationRevision === navigationRevision,
    focusedTarget: element => element?.closest?.('[data-sidebar-right-session]') ? target() : undefined,
    focus(id) { currentId = id; occurrence = {}; navigationRevision++; renderTool(); },
    openTab(kind) {
      do { currentId = kind[0] + (++serial); } while (openTabs.getSnapshot().some(tab => tab.tabId === currentId));
      occurrence = {}; navigationRevision++;
      openTabs.set([...openTabs.getSnapshot(), { sessionId: mounted.getSnapshot(), tabId: currentId, kind }]);
      expanded = true;
      if (toolMountDelay) setTimeout(renderTool, toolMountDelay); else renderTool();
      renderPresentation();
    },
    toggleExpanded() {
      expanded = !expanded;
      // Like the host, the first expansion seeds a guide and commits it before
      // returning; reopening otherwise preserves the existing tab and content.
      if (expanded && !active()) sidebarRight.openTab('guide');
      renderPresentation();
    },
    toggleFullscreen(captured) {
      if (!sidebarRight.isTargetCurrent(captured) || captured.host === 'float' || !expanded) return;
      const wasFullscreen = autoFullscreen || fullscreen;
      if (wasFullscreen && autoFullscreen) expanded = false;
      fullscreen = !wasFullscreen; renderPresentation();
    },
    canCloseTarget: () => true,
    closeTarget(captured) {
      if (!sidebarRight.isTargetCurrent(captured)) return 'stale';
      const remaining = openTabs.getSnapshot().filter(t => t.tabId !== captured.tabId);
      currentId = remaining.at(-1)?.tabId; occurrence = {}; navigationRevision++;
      openTabs.set(remaining); renderTool(); return 'closed';
    }
  };
  const ctx = {
    effect(fn) { cleanups.push(fn()); },
    inject(names, fn) { if (hasSessionStatus && names.includes('uiSession.sessionStatus')) fn(ctx); },
    uiSession: { sessionStatus },
    get(name) { return name === 'pluginNavigation' ? pluginNavigation : undefined; },
    slots: {
      inject(_name, fn) { return fn(); },
      entriesOfSlot(name) {
        return name === 'sidebar.settings' ? [settingsShell] : [];
      },
      register(spec, Component) {
        registeredSlots.push(spec.key ? `${spec.name}:${spec.key}` : `${spec.name}:${spec.id}`);
        if (spec.name === 'plugins.bundle.config' && spec.key === 'dsh-shortcutter') {
          Preferences = Component;
          return () => { preferencesRoot?.unmount(); preferencesRoot = undefined; Preferences = undefined; };
        }
        if (spec.name === 'shell.overlay') {
          const root = window.createRoot(document.getElementById('overlay'));
          root.render(window.React.createElement(Component)); return () => root.unmount();
        }
        return () => {};
      }
    },
    shortcuts: { catalog, config: shortcutConfig,
      describeBinding(binding) {
        return { ...describe(binding), issue: null, conflicts: native.conflicts };
      },
      async edit(operation, revision) {
        native.edits.push({ operation, revision });
        if (native.throws) throw Error('Unavailable');
        if (native.result) return { status: native.result };
        if (revision !== shortcutConfig.getSnapshot().revision) return { status: 'stale' };
        const reset = operation.type === 'reset';
        const binding = reset ? defaults[operation.id] : operation.binding;
        catalog.set(catalog.getSnapshot().map(row => row.id === operation.id ? { ...row, ...describe(binding), modified: !reset } : row));
        shortcutConfig.set({ revision: revision + 1 });
        return { status: 'saved' };
      },
      register(command) { commands.set(command.id, command); return () => commands.delete(command.id); },
      observeFixedInput(fn) { window.fixedInput = fn; return () => { window.fixedInput = undefined; }; },
      recording(value) { native.recording = value; return Promise.resolve(); } },
    sidebarRight, sessions: { list: sessionList, binding: id => id ? { session, ctx: {} } : undefined }, workspaces: { list: workspaceList },
    conversation: { input: { for: () => ({ focus: () => document.getElementById('composer').focus() }) } },
    layout: { panelInfo, selectPanel, toggleSidebar() { document.getElementById('frame').toggleAttribute('data-sidebar-collapsed'); } },
    uiWorkspace: workspace, webTerminals: { view: () => ({ state: terminal }) }
  };
  window.__ModuleLoader__ = { load({ factory }) {
    const plugin = factory(name => name === 'react' ? window.React : name === 'react-dom' ? window.ReactDOM
      : { closeTopModal: () => document.querySelector('dialog[open]')?.close() });
    plugin.apply(ctx);
  } };
  const emitKey = gesture => {
    let consumed = false;
    window.fixedInput?.({ type: 'keydown', gesture: { code: 'KeyA', shift: false, control: false, alt: false, meta: false,
      repeat: false, composing: false, defaultPrevented: false, ...gesture },
      context: { target: document.activeElement, region: document.activeElement.closest?.('.xterm') ? 'terminal' : 'page' },
      consume() { consumed = true; } });
    return consumed;
  };
  // The host resets fixed-key sequences on pointer/focus activity before the
  // plugin observes the resulting navigation transition.
  for (const type of ['pointerdown', 'focusin']) {
    document.addEventListener(type, () => window.fixedInput?.({ type: 'reset' }), true);
  }
  window.fixture = {
    session, sessionList, workspaceList, sessionStatus, terminal, sidebarRight, panelInfo, availablePanels, layout: ctx.layout, emitKey, native, catalog, shortcutConfig, workspace, commands, registeredSlots, pluginNavigation,
    commitSession(id, openState = 'loading') {
      selectedSession = id; session.set({ openState, running: false }); selectPanel(null);
    },
    preferences() {
      pluginNavigation.openBundle('dsh-shortcutter');
    },
    navigate(context = {}, id = 'magic-shortcuts.navigate') { const result = commands.get(id).resolve(context); result.run?.(); return result.status; },
    invalidateTarget() { occurrence = {}; navigationRevision++; },
    mountTerminal(focus = false) {
      const input = document.createElement('textarea'); input.id = 'terminal-input';
      document.querySelector('.xterm').append(input); if (focus) input.focus();
    },
    click(id) {
      const element = document.getElementById(id);
      for (const type of ['pointerdown', 'pointerup']) element.dispatchEvent(new PointerEvent(type,
        { bubbles: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, clientX: 10, clientY: 10 }));
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, detail: 1, clientX: 10, clientY: 10 }));
    },
    dispose() { for (const fn of cleanups.reverse()) fn?.(); }
  };
}
