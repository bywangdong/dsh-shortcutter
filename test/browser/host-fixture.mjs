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

export function setup({ instrument = false, openState = 'open', nodes = 2000, autoFullscreen = false,
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
  const terminal = store({ writable: false, phase: 'opening' });
  const mounted = store('s1');
  const openTabs = store(initialTabs);
  let currentId = activeTabId, expanded = true, fullscreen = false, occurrence = {}, navigationRevision = 0, serial = 1;
  const active = () => {
    const tab = openTabs.getSnapshot().find(t => t.sessionId === mounted.getSnapshot() && t.tabId === currentId);
    return tab && { id: tab.tabId, kind: tab.kind, contentId: tab.tabId };
  };
  const target = () => ({ sessionId: mounted.getSnapshot(), tabId: currentId, paneId: 'p1', host: 'dock', occurrence, navigationRevision });
  const renderTool = () => {
    const host = document.querySelector('[data-sidebar-right-session]'); host.dataset.sidebarRightSession = mounted.getSnapshot();
    const strip = host.querySelector('[data-dockkit-strip]');
    strip.replaceChildren(...openTabs.getSnapshot().filter(t => t.sessionId === mounted.getSnapshot()).map(tab => {
      const el = document.createElement('span'); el.role = 'tab'; el.dataset.dockkitTab = tab.tabId;
      el.setAttribute('aria-selected', String(tab.tabId === currentId)); el.textContent = tab.kind;
      return el;
    }));
    const pane = host.querySelector('[data-dockkit-pane]'); pane.dataset.sidebarRightTab = currentId ?? '';
    pane.innerHTML = !active() ? '' : active().kind === 'terminal' ? '<div class="xterm"></div>' : '<form><input id="address" value="draft"><span id="toolbar-blank">toolbar</span></form>';
  };
  const renderPresentation = () => {
    document.getElementById('right').dataset.sidebarRightOpen = String(expanded);
    document.getElementById('frame').toggleAttribute('data-rightbar-fullscreen', expanded && (autoFullscreen || fullscreen));
    document.querySelector('[data-sidebar-right-panel]').dataset.sidebarRightPanel = autoFullscreen || fullscreen ? 'fullscreen' : 'dock';
  };
  renderTool();
  renderPresentation();
  const cleanups = [], commands = new Map();
  const defaults = {
    'magic-shortcuts.navigate': { code: 'Escape', modifiers: ['meta'] },
    'shortcutter.navigate.alternate': { code: 'Semicolon', modifiers: ['meta', 'shift'] }
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
  const workspace = { sessionRequested: false, startSession() { workspace.sessionRequested = true; } };
  let Preferences, preferencesRoot;
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
      expanded = true; renderTool(); renderPresentation();
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
    slots: {
      inject(_name, fn) { return fn(); },
      register(spec, Component) {
        if (spec.name === 'settings.section') {
          Preferences = Component;
          return () => { preferencesRoot?.unmount(); Preferences = undefined; };
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
    sidebarRight, sessions: { binding: () => ({ session, ctx: {} }) },
    conversation: { input: { for: () => ({ focus: () => document.getElementById('composer').focus() }) } },
    layout: { selectPanel() {}, toggleSidebar() { document.getElementById('frame').toggleAttribute('data-sidebar-collapsed'); } },
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
    session, terminal, sidebarRight, emitKey, native, catalog, shortcutConfig, workspace, commands,
    commitSession(id, openState = 'loading') {
      session.set({ openState, running: false }); mounted.set(id); renderTool();
    },
    preferences() {
      const dialog = document.createElement('dialog'); dialog.id = 'preferences'; dialog.dataset.shortcutModal = 'settings';
      document.body.append(dialog); dialog.showModal(); preferencesRoot = window.createRoot(dialog);
      preferencesRoot.render(window.React.createElement(Preferences));
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
