window.__ModuleLoader__.load({
  id: "dsh-shortcutter",
  factory(require) {
    const React = require("react");
    const { createPortal } = require("react-dom");
    const { closeTopModal } = require("@deepseek-ai/dsh-client-ui-primitives");
    const h = React.createElement;
    /* BUILD_CORE */
    /* BUILD_NAVIGATION */
    /* BUILD_TOOLS */
    /* BUILD_TOOL_NAVIGATION */
    /* BUILD_SESSION_SEARCH */
    /* BUILD_CSS */
    const inject = ["slots", "shortcuts", "layout", "sidebarRight", "conversation", "sessions", "workspaces", "uiWorkspace", "webTerminals"];
    // which-key timing. Passive entry (mouse, blur, window focus, handoffs) is
    // silent; only an explicit keyboard return that is followed by a pause
    // previews the keys. A quick follow-up key cancels the preview entirely.
    const HINT_DELAY_MS = 450;
    const HINT_VISIBLE_MS = 2000;
    const HINT_RESUME_MS = 800;
    const PREFIX_TIMEOUT_MS = 4000;
    const NOTICE_MS = 4200;
    const TOAST_MS = 1600;
    const DEFAULT_RETURN_BINDING = { code: "Escape", modifiers: ["alt"] };
    const DEFAULT_COPY_URL_BINDING = { code: "KeyC", modifiers: ["primary", "shift"] };
    const pendingLabels = new Map([["approval", "待审批"], ["plan-review", "待审方案"], ["question", "待回答"]]);
    const RETURN_PRESETS = [
      { key: "default", label: "⌥ Esc（默认）", reset: true, binding: DEFAULT_RETURN_BINDING },
      { key: "control", label: "⌃ Esc", reset: false, binding: { code: "Escape", modifiers: ["control"] } }
    ];
    const normalizeModifier = modifier => modifier === "primary" ? "meta" : modifier;
    const sameBinding = (a, b) => !!a && !!b && a.code === b.code && a.secondCode === b.secondCode
      && (a.modifiers?.length || 0) === (b.modifiers?.length || 0)
      && (a.modifiers || []).map(normalizeModifier).every(m => (b.modifiers || []).map(normalizeModifier).includes(m));

    function apply(ctx) {
      let anchor, scopeAnchor, root, layer, alive = true, revision = 0, serial = 0, pending, pendingTimer;
      let navigationObserver, navigationScope = null, manualNavigation = false, handledEscape = false, altGraph = false;
      let navigating = false, hints = false, prefix = "", area = "conversation", target;
      let entryHint = false, hintDelayTimer, hintTimer, hintDeadline = 0, hintRemaining = 0, hoverPoint;
      let prefixShown = false, prefixToken = 0, prefixShowTimer, prefixExpireTimer;
      let firstNavigation = true, seenSession = false, inputReset = 0, resetTimer;
      let lastSession, previousSession, notice = "", noticeCompact = false, noticeTimer, returnElement;
      let searchRequest, searchDialog, sessionStatus, sessionHistory = [];
      let raw = null, storageError = "", config = defaultConfig(), stopRecording = () => {};
      const listeners = new Set();
      const toolHistory = createToolTabHistory();
      try {
        raw = localStorage.getItem(STORAGE_KEY);
        const loaded = readConfig(raw);
        if (loaded.config) { config = loaded.config; storageError = loaded.notice || ""; }
        else storageError = loaded.error;
      } catch { storageError = "无法读取本机设置，本次使用默认键位。"; }
      let published;
      const publish = (force = false) => {
        if (!alive) return;
        const active = ctx.sidebarRight.active();
        // Targets are fresh host objects: compare their occurrence and navigation
        // identity, not the wrapper. A pending view commit can explicitly wake us.
        const next = [navigating, hints, entryHint, prefix, prefixShown, area, activePanel(), navigationScope, pending, notice, noticeCompact,
          config, raw, storageError, searchRequest, mounted(), active?.id, active?.kind, active?.contentId,
          ctx.sidebarRight.isExpanded(), target?.sessionId, target?.paneId, target?.host,
          target?.tabId, target?.occurrence, target?.navigationRevision];
        if (!force && published && next.every((value, index) => value === published[index])) return;
        published = next;
        revision++; for (const fn of listeners) fn();
      };
      const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
      // Cancels both a scheduled preview and a visible one.
      const clearHint = () => {
        clearTimeout(hintDelayTimer); clearTimeout(hintTimer);
        hintDelayTimer = hintTimer = hoverPoint = undefined;
        entryHint = false; hintRemaining = 0;
      };
      const runHintTimer = ms => {
        clearTimeout(hintTimer);
        hintDeadline = performance.now() + ms;
        hintTimer = setTimeout(() => { hintTimer = hoverPoint = undefined; entryHint = false; publish(); }, ms);
      };
      const pauseHint = () => {
        if (!entryHint || hintTimer === undefined) return;
        hintRemaining = Math.max(0, hintDeadline - performance.now());
        clearTimeout(hintTimer); hintTimer = undefined;
      };
      const resumeHint = () => {
        if (entryHint && hintTimer === undefined) runHintTimer(Math.max(hintRemaining, HINT_RESUME_MS));
      };
      // Explicit keyboard return only. A visible preview just restarts its
      // reading time; otherwise wait for a pause so quick sequences stay quiet.
      const scheduleHint = () => {
        if (entryHint) { runHintTimer(HINT_VISIBLE_MS); return; }
        clearHint();
        hintDelayTimer = setTimeout(() => {
          hintDelayTimer = undefined;
          if (!alive || !navigating || prefix || hints) return;
          entryHint = true; runHintTimer(HINT_VISIBLE_MS); publish();
        }, HINT_DELAY_MS);
      };
      // g waits for its second key. Show its menu only after a pause (or at once
      // when help is already visible), and abandon a forgotten prefix.
      const enterPrefix = (key, immediate) => {
        const token = ++prefixToken;
        prefix = key; prefixShown = immediate;
        clearTimeout(prefixShowTimer); clearTimeout(prefixExpireTimer);
        if (!immediate) prefixShowTimer = setTimeout(() => {
          if (alive && token === prefixToken && prefix) { prefixShown = true; publish(); }
        }, HINT_DELAY_MS);
        prefixExpireTimer = setTimeout(() => {
          if (alive && token === prefixToken && prefix) { prefix = ""; prefixShown = false; publish(); }
        }, PREFIX_TIMEOUT_MS);
      };
      const clearPrefixTimers = () => { prefixToken++; clearTimeout(prefixShowTimer); clearTimeout(prefixExpireTimer); };
      const mounted = () => ctx.sidebarRight.mounted.getSnapshot();
      const activePanel = () => ctx.layout.panelInfo?.getSnapshot()?.activePanelId || null;
      const tabs = () => ctx.sidebarRight.openTabs.getSnapshot().filter(t => t.sessionId === mounted());
      const own = element => !!element && (!!root?.contains(element) || !!layer?.contains(element) || !!searchDialog?.contains(element));
      const visible = el => !!el?.isConnected && !!el.getClientRects().length && getComputedStyle(el).visibility !== "hidden";
      const orderedTabs = () => orderToolTabs(tabs(), [...document.querySelectorAll('[role="tab"][data-dockkit-tab]')]
        .filter(el => visible(el) && el.closest("[data-sidebar-right-session]")?.getAttribute("data-sidebar-right-session") === mounted())
        .map(el => el.getAttribute("data-dockkit-tab")));
      const rememberActiveTool = () => {
        if (ctx.sidebarRight.isExpanded()) toolHistory.remember(mounted(), ctx.sidebarRight.active()?.id, tabs());
      };
      const navigationContext = options => readNavigationContext(document, { enabled: config.autoNavigate || manualNavigation, ...options });
      // Read layout geometry only. The indicator belongs to our overlay; no
      // classes, styles, listeners or focus handlers are added to host panels.
      const columns = () => {
        const frame = root?.closest("[data-shell-overlay]")?.parentElement;
        const right = frame?.querySelector(":scope > [data-rightbar-col]");
        const conversation = right?.previousElementSibling;
        const sidebar = conversation?.previousElementSibling;
        return { frame, right, conversation, sidebar };
      };
      const returnRow = () => ctx.shortcuts.catalog.getSnapshot().find(row => row.id === RETURN_ID);
      const copyUrlRow = () => ctx.shortcuts.catalog.getSnapshot().find(row => row.id === COPY_URL_ID);
      const returnUsable = row => !!row?.binding && !row.issue && !row.conflicts?.length;
      const returnLabel = () => { const row = returnRow(); return returnUsable(row) ? row.keys.join(" ") : "未绑定"; };
      const tell = (text, compact = false) => {
        notice = text; noticeCompact = compact; clearTimeout(noticeTimer); publish();
        noticeTimer = setTimeout(() => { notice = ""; noticeCompact = false; publish(); }, compact ? TOAST_MS : NOTICE_MS);
      };
      const cancelPending = () => {
        clearTimeout(pendingTimer);
        if (!pending) return;
        pending = undefined; publish();
      };
      const rememberArea = element => {
        const focused = ctx.sidebarRight.focusedTarget(element);
        if (focused) {
          toolHistory.remember(focused.sessionId, focused.tabId, tabs());
          target = focused;
          area = tabs().find(t => t.tabId === focused.tabId)?.kind || "right";
        } else if (!own(element) && element instanceof Element) {
          const layout = columns();
          if (layout.sidebar?.contains(element)) { area = "sidebar"; target = undefined; }
          else if (layout.conversation?.contains(element)) { area = "conversation"; target = undefined; }
        }
      };
      const focusScopeAnchor = scope => (scope
        ? (scopeAnchor?.isConnected && scope.contains(scopeAnchor) ? scopeAnchor : scope)
        : anchor);
      const take = (token, infer = false, nativeWebviewTarget = null, hint = false) => {
        if (!alive || !anchor || (token !== undefined && pending?.id !== token)) return;
        const context = navigationContext({ nativeWebviewTarget });
        if (["menu", "modal", "inactive", "composition"].includes(context.reason)) { cancelPending(); return; }
        if (infer) rememberArea(document.activeElement);
        if (!own(document.activeElement) && visible(document.activeElement)) returnElement = document.activeElement;
        cancelPending(); prefix = ""; hints = false;
        manualNavigation = true;
        // The native shortcut service has verified the foreground window and
        // embedding owner. Bring keyboard ownership back to the outer document
        // once; focusing the anchor alone can leave input in the native guest.
        if (nativeWebviewTarget && !document.hasFocus()) {
          firstNavigation = false;
          window.focus();
        }
        focusScopeAnchor(context.scope).focus({ preventScroll: true });
        navigationObserver?.refresh();
        if (navigating) firstNavigation = false;
        // Native WebView focus can settle on a later event; the delayed preview
        // checks navigation again and never changes focus itself.
        if (hint) scheduleHint();
        publish();
      };
      const handleEscape = (targetEl, { prevent, stop }) => {
        if (!(targetEl instanceof Element) || targetEl !== document.activeElement) return false;
        if (targetEl.classList?.contains("sc-capture")) return false;
        if (isNavigationContent(targetEl) || targetEl.closest('[data-approval-key], iframe, webview, .xterm, [inert]')) return false;
        const context = navigationObserver?.refresh() || navigationContext();
        if (["menu", "modal", "inactive", "composition"].includes(context.reason)) return false;
        if (!context.scope && [...document.querySelectorAll('[data-session-panel="overlay"]')].some(visible)) return false;
        if (context.scope) {
          if (context.reason === "input") {
            prevent(); stop();
            inputReset++; take(undefined, false, null, true);
            return true;
          }
          if (context.navigating && (prefix || hints || entryHint)) {
            prevent(); stop();
            inputReset++; prefix = ""; hints = false; clearHint(); clearPrefixTimers();
            if (own(targetEl)) focusScopeAnchor(context.scope).focus({ preventScroll: true });
            publish();
            return true;
          }
          return false;
        }
        if (!context.navigating) {
          if (context.reason === "input") {
            prevent();
            inputReset++; take(undefined, true, null, true);
            return true;
          }
          const layout = columns();
          const from = layout.sidebar?.contains(targetEl) ? "sidebar"
            : layout.conversation?.contains(targetEl) ? "conversation"
            : targetEl === document.body && ["sidebar", "conversation"].includes(area) ? area : undefined;
          if (!from) return false;
          prevent();
          inputReset++; area = from; target = undefined; take(undefined, false, null, true);
          return true;
        }
        // In main-shell navigation mode, Escape dismisses prefixes/hints and is
        // always consumed so DSH's conversation double-Escape never aborts a turn.
        prevent();
        inputReset++; clearHint();
        prefix = ""; clearPrefixTimers(); hints = false;
        if (own(targetEl)) anchor?.focus({ preventScroll: true });
        publish();
        return true;
      };
      const requestNavigation = (toolTarget, force = false, extra = {}) => {
        cancelPending();
        if ((!toolTarget && !config.autoNavigate && !force) || !document.hasFocus()) return;
        pending = { id: ++serial, session: mounted(), toolTarget, origin: document.activeElement, ...extra };
        // A timeout only abandons the request. It never takes focus or retries.
        pendingTimer = setTimeout(() => {
          if (pending) { cancelPending(); tell("内容仍在准备中，可按回到快捷模式快捷键继续。"); }
        }, 5000);
        publish();
      };
      const requestInput = (enter, toolTarget, extra = {}) => {
        cancelPending();
        if (!document.hasFocus()) return;
        const id = ++serial;
        pending = { id, session: mounted(), toolTarget, enter, origin: document.activeElement, ...extra };
        pendingTimer = setTimeout(() => {
          if (pending?.id === id) { cancelPending(); tell("内容仍在准备中，请点击输入区域进入。"); }
        }, 5000);
        publish();
      };
      const inPaneTarget = (captured, el) => {
        if (!captured?.tabId || !visible(el) || el.closest("[data-sidebar-right-tab]")?.dataset.sidebarRightTab !== captured.tabId) return false;
        const owner = ctx.sidebarRight.focusedTarget(el);
        return owner?.sessionId === captured.sessionId && owner.paneId === captured.paneId && owner.occurrence === captured.occurrence;
      };
      const browserAddress = captured => [...document.querySelectorAll("[data-sidebar-right-tab] form input")]
        .find(el => inPaneTarget(captured, el) && isNavigationInput(el));
      const visibleBrowserContainers = sessionId => {
        const browserIds = new Set(tabs().filter(t => t.kind === "browser").map(t => t.tabId));
        const byTab = new Map();
        for (const el of document.querySelectorAll("[data-sidebar-right-tab], [data-dockkit-content]")) {
          const tabId = el.dataset.sidebarRightTab || el.dataset.dockkitContent;
          if (!tabId || !browserIds.has(tabId) || !visible(el)) continue;
          const ownerSession = ctx.sidebarRight.focusedTarget(el)?.sessionId
            ?? el.closest("[data-sidebar-right-session]")?.getAttribute("data-sidebar-right-session");
          if (ownerSession !== sessionId) continue;
          if (!byTab.has(tabId) || el.hasAttribute("data-dockkit-content")) byTab.set(tabId, el);
        }
        return [...byTab.entries()].map(([tabId, el]) => ({ tabId, el }));
      };
      const resolveBrowserContainer = input => {
        const sessionId = mounted();
        if (!sessionId || activePanel()) return null;
        const containers = visibleBrowserContainers(sessionId);
        if (!containers.length) return null;
        const origin = input?.target instanceof Element ? input.target : document.activeElement;
        const focused = origin && ctx.sidebarRight.focusedTarget(origin);
        if (focused?.sessionId === sessionId) {
          const hit = containers.find(c => c.tabId === focused.tabId);
          if (hit) return hit.el;
        }
        if (area === "browser" && target?.sessionId === sessionId) {
          const hit = containers.find(c => c.tabId === target.tabId);
          if (hit) return hit.el;
        }
        const activeTab = ctx.sidebarRight.active();
        if (activeTab?.kind === "browser") {
          const hit = containers.find(c => c.tabId === activeTab.id);
          if (hit) return hit.el;
        }
        const visibleTabs = containers.map(c => ({ sessionId, tabId: c.tabId, kind: "browser" }));
        const recent = toolHistory.find(sessionId, "browser", visibleTabs);
        return containers.find(c => c.tabId === recent?.tabId)?.el || containers[0].el;
      };
      const readBrowserUrl = container => {
        const webview = container.querySelector("webview[data-sidebar-browser-frame]");
        if (typeof webview?.getURL === "function") {
          try {
            const url = normalizeHttpUrl(webview.getURL());
            if (url) return url;
          } catch {}
        }
        const addressInput = [...container.querySelectorAll("form input")].find(el => isNavigationInput(el));
        const draftUrl = normalizeHttpUrl(addressInput?.value);
        if (draftUrl) return draftUrl;
        const iframe = container.querySelector("iframe[data-sidebar-browser-frame]");
        const iframeUrl = normalizeHttpUrl(iframe?.getAttribute("src"));
        if (iframeUrl) return iframeUrl;
        return [...container.querySelectorAll("section p")].map(el => normalizeHttpUrl(el.textContent)).find(Boolean) || "";
      };
      // Preserve focus and selection inside <webview> or composer when async Clipboard API rejects.
      const writeClipboard = async text => {
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
          }
        } catch {}
        let copied = false;
        const onCopy = event => {
          if (!event.clipboardData) return;
          event.clipboardData.setData("text/plain", text);
          event.preventDefault();
          event.stopImmediatePropagation();
          copied = true;
        };
        document.addEventListener("copy", onCopy, true);
        try {
          return document.execCommand("copy") || copied;
        } catch {
          return false;
        } finally {
          document.removeEventListener("copy", onCopy, true);
        }
      };
      const copyBrowserUrl = async input => {
        const container = resolveBrowserContainer(input);
        if (!container) { tell("当前没有打开的浏览器。", true); return; }
        const url = readBrowserUrl(container);
        if (!url) { tell("当前浏览器还没有可复制的网址。", true); return; }
        const ok = await writeClipboard(url);
        if (!alive) return;
        if (ok) tell(formatCopiedUrlToast(url), true);
        else tell("无法写入剪贴板，请手动复制地址栏。");
      };
      const saveConfig = (candidate, expected) => {
        const result = validateConfig(candidate);
        if (result.error) return result.error;
        try {
          if (localStorage.getItem(STORAGE_KEY) !== expected) return "设置已在其他窗口更改，请重新打开设置后再保存。";
          const next = JSON.stringify(result.config);
          localStorage.setItem(STORAGE_KEY, next);
          raw = next; config = result.config; storageError = ""; prefix = "";
          if (!config.autoNavigate) cancelPending();
          navigationObserver?.refresh();
          publish();
        } catch { return "保存失败，原有设置仍然有效。"; }
      };
      const currentTarget = () => target && ctx.sidebarRight.isTargetCurrent(target) ? target : ctx.sidebarRight.commandTarget(null);
      const openTool = (kind, create = false, revealed = false) => {
        if (!mounted()) throw new Error("先打开一个会话，再打开工具面板。");
        rememberActiveTool();
        const tool = kind === "browser" || kind === "terminal";
        const active = ctx.sidebarRight.active();
        if (!create && !revealed && ctx.sidebarRight.isExpanded() && active?.kind === kind) {
          cancelPending();
          ctx.sidebarRight.toggleExpanded();
          area = "conversation"; target = undefined;
          requestNavigation(undefined, true);
          return;
        }
        // A tool key recalls the current/recent tab (creating only when none
        // exists) and collapses the dock when pressed again on the visible kind.
        const existing = !create && toolHistory.find(mounted(), kind, orderedTabs(), active?.id);
        if (existing) {
          if (existing.tabId !== active?.id) ctx.sidebarRight.focus(existing.tabId);
          if (!ctx.sidebarRight.isExpanded()) ctx.sidebarRight.toggleExpanded();
        } else ctx.sidebarRight.openTab(kind, {});
        area = kind; target = ctx.sidebarRight.commandTarget(null);
        rememberActiveTool();
        if (tool && (!target?.tabId || ctx.sidebarRight.active()?.kind !== kind)) throw new Error("工具尚未准备好，请点击标签进入。");
        if (create && kind === "browser") {
          const input = browserAddress(target);
          if (input) {
            cancelPending(); manualNavigation = false;
            input.focus({ preventScroll: true }); input.select?.();
            navigationObserver?.refresh(); publish();
            return;
          }
          requestInput("browser", target);
          return;
        }
        if (create && kind === "terminal") {
          requestInput("terminal", target);
          return;
        }
        requestNavigation(tool ? target : undefined, true);
      };
      const closeTool = () => {
        cancelPending();
        const result = closeNavigationTool(ctx.sidebarRight, { sessionId: mounted(), area, scope: navigationScope, target });
        if (result !== "closed") throw new Error(result === "stale" ? "当前标签已变化，请重新选择后关闭。" : "先切到要关闭的工具标签。");
        const next = ctx.sidebarRight.active();
        const expanded = ctx.sidebarRight.isExpanded();
        area = expanded && next ? next.kind : "conversation";
        target = expanded && next ? ctx.sidebarRight.commandTarget(null) : undefined;
        rememberActiveTool();
        // Closing is already an explicit navigation action. Keep that mode
        // even when automatic navigation is disabled in the user's settings.
        requestNavigation(undefined, true);
      };
      const enterContent = () => {
        cancelPending(); prefix = "";
        if (navigationScope) {
          const input = [...navigationScope.querySelectorAll('input, textarea, select, [contenteditable], [role="textbox"], [role="searchbox"], [role="combobox"]')]
            .find(element => visible(element) && !element.disabled && isNavigationInput(element));
          if (!input) return;
          input.focus({ preventScroll: true });
        } else if (area === "conversation" && activePanel()) {
          const input = [...(columns().conversation?.querySelectorAll('input, textarea, select, [contenteditable], [role="textbox"], [role="searchbox"], [role="combobox"]') || [])]
            .find(element => visible(element) && !element.disabled && isNavigationInput(element));
          if (!input) throw new Error("当前页面没有可直接输入的区域。");
          input.focus({ preventScroll: true });
        } else if (area === "conversation") {
          const sessionId = mounted();
          const binding = sessionId && ctx.sessions.binding(sessionId);
          if (!binding) throw new Error("当前还没有可输入的对话。");
          ctx.conversation.input.for(binding.ctx).focus();
        } else {
          if (area === "sidebar") throw new Error("左侧栏请点击内容进入，按 Esc 回到快捷模式。");
          const captured = currentTarget();
          if (!captured || !ctx.sidebarRight.isTargetCurrent(captured)) throw new Error("当前面板已变化，请重新选择。");
          // DSH has no public focus facade for these two components. This narrow
          // adapter only focuses an existing visible node; it never handles its keys.
          const inPane = el => inPaneTarget(captured, el);
          const selectors = area === "terminal" ? [".xterm textarea"]
            : area === "browser" ? ["[data-sidebar-browser-frame]", "[data-dockkit-pane] input"] : [];
          let element;
          for (const selector of selectors) {
            element = [...document.querySelectorAll(selector)].find(inPane);
            if (element) break;
          }
          if (!element) throw new Error("这个区域请点击内容进入；回到快捷模式快捷键仍然可用。");
          element.focus({ preventScroll: true });
        }
        manualNavigation = false;
        navigationObserver?.refresh();
        publish();
        if (navigating) throw new Error("内容尚未准备好，请稍后再试或点击进入。");
      };
      const openSettings = () => {
        // sidebar.settings is a single slot. Its active shell owns the shared dialog store.
        const store = ctx.slots.entriesOfSlot("sidebar.settings")[0]?.store;
        const actions = store?.create?.()?.actions;
        if (typeof actions?.open !== "function") throw new Error("DSH 设置尚未准备好，请稍后重试。");
        cancelPending();
        actions.open();
      };
      const openGlobalPanel = panelId => {
        cancelPending();
        try { ctx.layout.selectPanel(panelId); }
        catch { throw new Error(panelId === "plugins" ? "插件页面当前不可用。" : "定时任务页面当前不可用。"); }
        area = "conversation"; target = undefined;
        requestNavigation(undefined, true);
      };
      const openPluginSettings = () => {
        cancelPending();
        const nav = ctx.get?.("pluginNavigation");
        if (typeof nav?.openBundle === "function") {
          nav.openBundle("dsh-shortcutter");
          area = "conversation"; target = undefined;
          requestNavigation(undefined, true);
          return;
        }
        openGlobalPanel("plugins");
      };
      const revealSession = message => {
        const prev = activePanel();
        if (prev) ctx.layout.selectPanel(null);
        if (!mounted()) {
          if (prev) ctx.layout.selectPanel(prev);
          throw new Error(message);
        }
        return prev;
      };
      const openSessionSearch = () => {
        cancelPending(); clearPrefixTimers();
        if (searchRequest) { searchDialog?.querySelector("input")?.focus(); return; }
        searchRequest = { id: ++serial, origin: document.activeElement, area, target, session: mounted(), panel: activePanel() };
        publish();
      };
      const closeSessionSearch = (restore = true) => {
        const saved = searchRequest;
        if (!saved) return;
        searchRequest = undefined;
        searchDialog?.close();
        if (restore && alive && document.hasFocus()) {
          const sameSurface = saved.session === mounted() && saved.panel === activePanel();
          area = sameSurface ? saved.area : "conversation";
          target = sameSurface && saved.target && ctx.sidebarRight.isTargetCurrent(saved.target) ? saved.target : undefined;
          manualNavigation = true;
          (sameSurface && visible(saved.origin) ? saved.origin : anchor)?.focus({ preventScroll: true });
        }
        navigationObserver?.refresh(); publish();
      };
      const run = id => {
        if (!alive) return;
        // A command consumes the guide. Its asynchronous tab/session/focus
        // handoff stays quiet, because passive navigation never previews keys.
        try {
          prefix = ""; hints = false; clearHint();
          // Leaving settings is explicit navigation, through the host's public
          // modal close helper; ordinary mode changes never close a layer.
          const fromModal = !!navigationScope;
          if (navigationScope && !["enter", "settings", "closeTab"].includes(id)) closeTopModal(document);
          if (id === "enter") enterContent();
          else if (id === "searchSessions") openSessionSearch();
          else if (id === "closeTab") {
            if (navigationScope) {
              cancelPending(); closeTopModal(document); requestNavigation(undefined, true);
            } else if (activePanel()) {
              cancelPending(); ctx.layout.selectPanel(null);
              area = "conversation"; target = undefined; requestNavigation(undefined, true);
            } else closeTool();
          }
          else if (id === "newSession") {
            const prevSession = mounted();
            const reusableBlank = !!prevSession && !!ctx.sessions.list?.getSnapshot?.()?.byId?.[prevSession]?.blank;
            area = "conversation"; target = undefined;
            requestInput("conversation", undefined, { awaitSessionChange: !!prevSession && !reusableBlank });
            ctx.uiWorkspace.startSession();
          }
          else if (id === "sidebar") {
            const opening = columns().frame?.hasAttribute("data-sidebar-collapsed");
            ctx.layout.toggleSidebar(); area = opening ? "sidebar" : "conversation"; target = undefined; requestNavigation();
          }
          else if (id === "conversation") {
            const fullscreen = [...document.querySelectorAll('[data-sidebar-right-panel="fullscreen"]')]
              .some(el => visible(el) && el.getAttribute("data-sidebar-right-session") === mounted());
            const captured = currentTarget();
            if (fullscreen && ctx.sidebarRight.isExpanded() && captured) ctx.sidebarRight.toggleFullscreen(captured);
            ctx.layout.selectPanel(null); area = "conversation"; target = undefined; requestNavigation();
          }
          else if (id === "plugins" || id === "schedules") openGlobalPanel(id);
          else if (id === "right") {
            revealSession("先打开一个会话。");
            ctx.sidebarRight.toggleExpanded();
            area = ctx.sidebarRight.isExpanded() ? ctx.sidebarRight.active()?.kind || "right" : "conversation";
            target = ctx.sidebarRight.commandTarget(null); requestNavigation();
          } else if (["files", "browser", "terminal"].includes(id)) {
            const fromPanel = revealSession("先打开一个会话，再打开工具面板。");
            openTool(id, false, fromModal || !!fromPanel);
          } else if (id === "newBrowser" || id === "newTerminal") {
            revealSession("先打开一个会话，再打开工具面板。");
            openTool(id === "newBrowser" ? "browser" : "terminal", true);
          } else if (id === "fullscreen") {
            const prev = revealSession("先打开一个会话。");
            let captured = currentTarget();
            if (captured?.host === "float") {
              if (prev) ctx.layout.selectPanel(prev);
              throw new Error("悬浮面板暂不支持放大或恢复。");
            }
            const opening = !ctx.sidebarRight.isExpanded();
            if (opening) {
              ctx.sidebarRight.toggleExpanded();
              // Expansion commits the pane and may seed its first guide tab.
              captured = ctx.sidebarRight.commandTarget(null);
            }
            if (!captured || !ctx.sidebarRight.isTargetCurrent(captured)) throw new Error("当前面板已变化，请重新选择。");
            // Reopening can already be fullscreen (remembered mode or a narrow
            // window). Toggling again would restore or even collapse it.
            const openedFullscreen = opening && [...document.querySelectorAll('[data-sidebar-right-panel="fullscreen"]')]
              .some(el => el.getAttribute("data-sidebar-right-session") === mounted());
            if (!openedFullscreen) ctx.sidebarRight.toggleFullscreen(captured);
            const expanded = ctx.sidebarRight.isExpanded();
            area = expanded ? tabs().find(t => t.tabId === captured.tabId)?.kind || "right" : "conversation";
            target = expanded ? captured : undefined; requestNavigation(target, true);
          } else if (id === "previous") {
            if (!previousSession) throw new Error("还没有上一个会话。");
            area = "conversation"; target = undefined;
            ctx.uiWorkspace.openSession(previousSession); requestNavigation();
          } else if (id === "nextTab" || id === "previousTab") {
            const prev = activePanel();
            if (prev) ctx.layout.selectPanel(null);
            const list = orderedTabs();
            if (list.length < 2) {
              if (prev) ctx.layout.selectPanel(prev);
              throw new Error("当前会话只有一个工具标签。");
            }
            const next = list[cycleIndex(list.length, list.findIndex(t => t.tabId === ctx.sidebarRight.active()?.id), id === "nextTab" ? 1 : -1)];
            ctx.sidebarRight.focus(next.tabId);
            if (!ctx.sidebarRight.isExpanded()) ctx.sidebarRight.toggleExpanded();
            rememberActiveTool();
            area = next.kind; target = ctx.sidebarRight.commandTarget(null); requestNavigation(target, true);
          } else if (id.startsWith("tab:")) {
            const index = Number(id.slice(4));
            const prev = revealSession("先打开一个会话，再切换工具标签。");
            const list = orderedTabs();
            const chosen = list[index];
            if (!chosen) {
              if (prev) ctx.layout.selectPanel(prev);
              throw new Error(list.length ? `当前只有 ${list.length} 个工具标签。` : "当前会话还没有打开的工具标签。");
            }
            if (chosen.tabId !== ctx.sidebarRight.active()?.id) ctx.sidebarRight.focus(chosen.tabId);
            if (!ctx.sidebarRight.isExpanded()) ctx.sidebarRight.toggleExpanded();
            rememberActiveTool();
            area = chosen.kind; target = ctx.sidebarRight.commandTarget(null); requestNavigation(target, true);
          } else if (id === "settings") openSettings();
          else if (id === "pluginSettings") openPluginSettings();
          publish();
        } catch (error) {
          const text = error instanceof Error
            ? (/no session surface is mounted/.test(error.message) ? "已回到当前会话，请再按一次打开工具。" : error.message)
            : "操作未完成，请使用原有界面重试。";
          tell(text);
        }
      };
      const formatKeyCap = key => key === "Space" ? "space" : key === "Shift+Tab" ? "⇧ Tab" : key;
      const keyCaps = sequence => sequence ? sequence.split(" ").map((key, i) => h("kbd", { key: i }, formatKeyCap(key))) : h("span", { className: "sc-muted" }, "未绑定");
      const areas = { sidebar: "左侧栏", conversation: "对话", terminal: "终端", browser: "浏览器", files: "文件", right: "工具面板" };
      const panelTitles = { plugins: "插件", schedules: "定时任务" };
      const surfaceArea = () => navigationScope ? "settings" : area === "conversation" && activePanel() ? activePanel() : area;
      const surfaceLabel = () => navigationScope ? "设置" : area === "conversation" && activePanel() ? panelTitles[activePanel()] || "页面" : areas[area] || "工具面板";

      function SessionSearch({ request }) {
        const list = React.useSyncExternalStore(fn => ctx.sessions.list.subscribe(fn), () => ctx.sessions.list.getSnapshot());
        const workspaces = React.useSyncExternalStore(fn => ctx.workspaces.list.subscribe(fn), () => ctx.workspaces.list.getSnapshot());
        const store = sessionStatus;
        const statuses = React.useSyncExternalStore(React.useCallback(fn => store?.subscribe(fn) ?? (() => {}), [store]), () => store?.getSnapshot());
        const readingReady = React.useSyncExternalStore(React.useCallback(fn => store?.readingReady.subscribe(fn) ?? (() => {}), [store]), () => store?.readingReady.getSnapshot() ?? false);
        const [query, setQuery] = React.useState("");
        const [filter, setFilter] = React.useState("all");
        const [selectedId, setSelectedId] = React.useState();
        const [message, setMessage] = React.useState("");
        const dialogRef = React.useRef(null), inputRef = React.useRef(null), closeRef = React.useRef(null), composing = React.useRef(false);
        const current = mounted() || lastSession;
        const search = React.useMemo(() => indexSessionRows(sessionSearchRows(list, workspaces, { current, history: sessionHistory })), [list, workspaces, current, sessionHistory]);
        const hits = React.useMemo(() => search(query), [search, query]);
        const activeFilter = store && (filter !== "unread" || readingReady) ? filter : "all";
        const matches = activeFilter === "all" ? hits : hits.filter(row => {
          const status = statuses?.get(row.id);
          return activeFilter === "pending" ? !!status?.pendingInteraction : readingReady && status?.completionUnread;
        });
        const rows = matches.slice(0, 100);
        const selected = rows.find(row => row.id === selectedId) || rows[0];
        const loading = list.phase !== "ready" || workspaces.phase !== "ready";
        const close = () => { if (searchRequest === request) closeSessionSearch(); };
        React.useLayoutEffect(() => {
          const dialog = dialogRef.current;
          searchDialog = dialog;
          dialog.showModal();
          inputRef.current.focus({ preventScroll: true });
          navigationObserver?.refresh();
          return () => {
            dialog.close();
            if (searchDialog === dialog) searchDialog = undefined;
          };
        }, []);
        React.useEffect(() => {
          dialogRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
        }, [selected?.id]);
        const choose = id => {
          // Recheck the authoritative lists at activation: a row can be archived
          // or removed between rendering and the user's Enter/click.
          const exists = sessionSearchRows(ctx.sessions.list.getSnapshot(), ctx.workspaces.list.getSnapshot(), { current }).some(row => row.id === id);
          if (!exists) { setMessage("这个会话已不可用，请选择其他会话。"); return; }
          closeSessionSearch(false);
          area = "conversation"; target = undefined;
          requestNavigation(undefined, true, { selectSession: id, awaitSessionChange: mounted() !== id });
          try { ctx.uiWorkspace.openSession(id); }
          catch { cancelPending(); take(); tell("会话打开失败，请重试。"); }
          publish();
        };
        const onKeyDown = event => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing.current
            || event.metaKey || event.ctrlKey || event.altKey) return;
          if (event.key === "Tab") {
            event.preventDefault(); event.stopPropagation();
            const controls = [inputRef.current, dialogRef.current.querySelector('input[type="radio"]:checked'), closeRef.current].filter(Boolean);
            const index = controls.indexOf(event.target);
            controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length].focus({ preventScroll: true });
            return;
          }
          if (event.shiftKey) return;
          if (event.key === "Escape") {
            event.preventDefault(); event.stopPropagation(); close();
          } else if ((event.target === inputRef.current || event.target.type === "radio") && ["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) {
            event.preventDefault(); event.stopPropagation();
            if (event.key === "Enter") { if (!event.repeat && selected) choose(selected.id); }
            else if (rows.length) {
              inputRef.current.focus({ preventScroll: true });
              const index = rows.findIndex(row => row.id === selected?.id);
              setSelectedId(rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))].id);
            }
          }
        };
        return createPortal(h("dialog", { ref: dialogRef, className: "sc-root sc-dialog sc-session-search", "aria-label": "搜索会话", "aria-modal": true,
          onKeyDown, onClose: close,
          onCancel: event => { event.preventDefault(); if (!composing.current) close(); },
          onClick: event => {
            if (event.target !== event.currentTarget) return;
            const rect = event.currentTarget.getBoundingClientRect();
            if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
          } },
          h("header", { className: "sc-search-header" },
            h("input", { ref: inputRef, type: "text", role: "combobox", "aria-label": "搜索会话名称或工作区", "aria-autocomplete": "list", "aria-expanded": true,
              "aria-controls": "sc-session-results", "aria-activedescendant": selected ? `sc-session-result-${selected.id}` : undefined,
              placeholder: "搜索会话名称或工作区…", value: query, autoComplete: "off", spellCheck: false,
              onCompositionStart: () => { composing.current = true; }, onCompositionEnd: () => { composing.current = false; },
              onChange: event => { setQuery(event.target.value); setSelectedId(undefined); setMessage(""); } }),
            h("button", { ref: closeRef, type: "button", "aria-label": "关闭搜索", onClick: close }, "×")),
          store && h("div", { className: "sc-search-filters", role: "radiogroup", "aria-label": "按会话状态筛选" },
            [["all", "全部"], ["pending", "待处理"], ["unread", "未读"]].map(([value, label]) =>
              h("label", { key: value, title: value === "unread" && !readingReady ? "当前无法读取未读状态" : undefined },
                h("input", { type: "radio", name: "sc-session-filter", value, checked: activeFilter === value, disabled: value === "unread" && !readingReady,
                onChange: () => { setFilter(value); setSelectedId(undefined); setMessage(""); } }), h("span", null, label)))),
          h("p", { className: "sc-search-status", role: "status" }, message || (loading ? "正在加载会话…" : matches.length
            ? `${query.trim() ? "搜索结果" : "最近访问优先"} · ${matches.length} 个会话${matches.length > rows.length ? "，显示前 100 个，请输入关键词缩小范围" : ""}`
            : query.trim() ? "没有匹配的会话，试试其他关键词。" : activeFilter === "pending" ? "没有待处理的会话。" : activeFilter === "unread" ? "没有未读会话。" : "暂无可搜索的会话。")),
          h("div", { id: "sc-session-results", className: "sc-search-results", role: "listbox", "aria-label": "会话搜索结果", "aria-busy": loading },
            rows.map(row => {
              const status = statuses?.get(row.id);
              const pending = status?.pendingInteraction;
              return h("button", { key: row.id, id: `sc-session-result-${row.id}`, type: "button", className: "sc-search-result", role: "option",
              "data-sc-workspace-match": row.workspaceMatch,
              "aria-selected": row.id === selected?.id, tabIndex: -1, title: `${row.title}\n${row.workspace}`, onPointerDown: event => event.preventDefault(), onClick: () => choose(row.id) },
              h("span", { className: "sc-search-text" }, h("strong", null, row.title), h("small", null, row.workspace)),
              pending && h("span", { className: "sc-search-pending" }, pendingLabels.get(pending.kind) || "待处理"),
              readingReady && status?.completionUnread && h("span", { className: "sc-search-unread" }, "未读"),
              h("span", { className: "sc-muted" }, row.current ? "当前" : row.recent ? "最近访问" : ""));
            })),
          h("footer", { className: "sc-search-footer" }, h("span", null, keyCaps("↑ ↓"), " 选择"), h("span", null, keyCaps("Enter"), " 打开"), h("span", null, keyCaps("Esc"), " 返回"))), document.body);
      }

      function FocusCue() {
        const [cue, setCue] = React.useState(null);
        React.useEffect(() => {
          let frameId = 0, stopped = false, observed = [];
          const update = next => setCue(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
          const measure = () => {
            frameId = 0;
            if (stopped) return;
            if (!navigating || document.hidden || !document.hasFocus()) {
              resize.disconnect(); observed = []; update(null); return;
            }
            const layout = columns(), scope = navigationScope, right = !scope && !["conversation", "sidebar"].includes(area);
            let element = scope || layout[area];
            const captured = right && currentTarget();
            if (captured && ctx.sidebarRight.isExpanded()) {
              element = [...document.querySelectorAll("[data-dockkit-pane]")].find(el =>
                el.getAttribute("data-dockkit-pane") === captured.paneId
                && el.closest("[data-sidebar-right-session]")?.getAttribute("data-sidebar-right-session") === captured.sessionId);
            }
            const nextObserved = [...new Set([layout.frame, layout.sidebar, layout.conversation, layout.right, element].filter(Boolean))];
            if (nextObserved.length !== observed.length || nextObserved.some((el, i) => el !== observed[i])) {
              resize.disconnect(); observed = nextObserved; observed.forEach(el => resize.observe(el));
            }
            if (!navigating || document.hidden || !document.hasFocus() || !visible(element)
              || (right && !ctx.sidebarRight.isExpanded())
              || (!scope && !right && layout.frame?.hasAttribute("data-rightbar-fullscreen"))
              || (!scope && area === "sidebar" && layout.frame?.hasAttribute("data-sidebar-collapsed"))) { update(null); return; }
            const rect = element.getBoundingClientRect();
            const left = Math.max(0, rect.left), top = Math.max(0, rect.top), width = Math.min(innerWidth, rect.right) - left;
            if (width < 48 || rect.bottom <= top || top >= innerHeight) { update(null); return; }
            // The quiet corner. Where the panel meets the window's rounded
            // corner, sit 1.5px further in; when host chrome (a tab pill or
            // button) starts right beside the usual spot, tuck into the corner.
            const crowded = [[14, 14], [8, 14], [14, 8]].some(([dx, dy]) =>
              document.elementFromPoint(left + dx, top + dy)?.closest?.('[role="tab"], button, a[href], input, [role="button"]'));
            const inset = left <= 0.5 && top <= 0.5 ? 7.5 : crowded ? 3 : 6;
            const cueArea = surfaceArea();
            update({ key: `${mounted() || activePanel() || ""}:${scope ? "settings" : right ? captured?.paneId : cueArea}`, area: cueArea, left, top, width, inset });
          };
          const schedule = () => { if (!stopped && !frameId) frameId = requestAnimationFrame(measure); };
          const resize = new ResizeObserver(schedule);
          const markers = 'dialog, [aria-modal="true"], [data-dockkit-pane], [data-sidebar-right-panel], [data-rightbar-col]';
          const mutations = new MutationObserver(records => {
            if (records.some(record => !own(record.target) && (record.type === "attributes"
              || [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element && !own(node)
                && (node.matches(markers) || node.querySelector(markers)))))) schedule();
          });
          mutations.observe(document.body, { subtree: true, childList: true, attributes: true,
            attributeFilter: ["open", "aria-modal", "data-sidebar-collapsed", "data-rightbar-fullscreen", "data-sidebar-right-open", "data-sidebar-right-panel"] });
          const off = subscribe(schedule);
          window.addEventListener("resize", schedule);
          window.addEventListener("focus", schedule);
          window.addEventListener("blur", schedule);
          document.addEventListener("visibilitychange", schedule);
          schedule();
          return () => {
            stopped = true; cancelAnimationFrame(frameId); resize.disconnect(); mutations.disconnect(); off();
            window.removeEventListener("resize", schedule); window.removeEventListener("focus", schedule); window.removeEventListener("blur", schedule);
            document.removeEventListener("visibilitychange", schedule);
          };
        }, []);
        return navigating && cue && h("div", { key: cue.key, className: "sc-focus-cue", "aria-hidden": true, "data-sc-focus-area": cue.area,
          style: { left: cue.left, top: cue.top, width: cue.width, height: Math.max(12, cue.inset + 5), "--sc-cue-inset": `${cue.inset}px` } });
      }

      function TabBadges() {
        const [badges, setBadges] = React.useState([]);
        React.useLayoutEffect(() => {
          let frameId = 0, stopped = false;
          const syncBadges = () => {
            frameId = 0;
            if (stopped) return;
            if (!navigating || prefix !== "g" || navigationScope || activePanel() || !ctx.sidebarRight.isExpanded() || document.hidden || !document.hasFocus()) {
              setBadges(prev => prev.length ? [] : prev);
              return;
            }
            const session = mounted();
            const tabEls = [...document.querySelectorAll('[role="tab"][data-dockkit-tab]')]
              .filter(el => visible(el) && el.closest("[data-sidebar-right-session]")?.getAttribute("data-sidebar-right-session") === session);
            const byId = new Map(tabEls.map(el => [el.getAttribute("data-dockkit-tab"), el]));
            const next = orderToolTabs(tabs(), [...byId.keys()]).slice(0, 9).map((tab, index) => {
              const digit = String(index + 1);
              if (COMMANDS.some(c => config.bindings[c.id] === `g ${digit}`)) return null;
              const el = byId.get(tab.tabId);
              if (!el) return null;
              const rect = el.getBoundingClientRect();
              if (rect.width <= 0 || rect.height <= 0) return null;
              return { key: tab.tabId, digit, left: Math.round(Math.max(2, rect.left + 2)), top: Math.round(Math.max(2, rect.top - 5)) };
            }).filter(Boolean);
            setBadges(prev => JSON.stringify(prev) === JSON.stringify(next) ? prev : next);
          };
          const schedule = () => { if (!stopped && !frameId) frameId = requestAnimationFrame(syncBadges); };
          const tabMutations = new MutationObserver(records => {
            if (records.some(record => !own(record.target))) schedule();
          });
          tabMutations.observe(document.body, { subtree: true, childList: true, attributes: true,
            attributeFilter: ["aria-selected", "data-sidebar-right-open", "data-rightbar-fullscreen"] });
          const off = subscribe(schedule);
          window.addEventListener("resize", schedule);
          document.addEventListener("scroll", schedule, true);
          syncBadges();
          return () => {
            stopped = true; cancelAnimationFrame(frameId); tabMutations.disconnect(); off();
            window.removeEventListener("resize", schedule);
            document.removeEventListener("scroll", schedule, true);
          };
        }, []);
        return badges.length > 0 && h("div", { className: "sc-tab-badges", "aria-hidden": true },
          badges.map(b => h("kbd", { key: b.key, className: "sc-tab-badge", "data-sc-tab-badge": b.digit,
            style: { left: b.left, top: b.top } }, b.digit)));
      }

      function Preferences(props) {
        React.useSyncExternalStore(subscribe, () => revision);
        React.useSyncExternalStore(fn => ctx.shortcuts.catalog.subscribe(fn), () => ctx.shortcuts.catalog.getSnapshot());
        const [draft, setDraft] = React.useState(() => structuredClone(config));
        const [expected, setExpected] = React.useState(raw);
        const [message, setMessage] = React.useState(storageError);
        const [recording, setRecording] = React.useState(false);
        const [candidate, setCandidate] = React.useState();
        const [nativeMessage, setNativeMessage] = React.useState("");
        const [busy, setBusy] = React.useState(false);
        const capture = React.useRef(null), heldBinding = React.useRef(), recordingToken = React.useRef(0), nativeRevision = React.useRef();
        const preferencesLive = React.useRef(false), savingNative = React.useRef(false);
        React.useEffect(() => {
          preferencesLive.current = true;
          let live = true;
          const stop = () => {
            heldBinding.current = undefined;
            recordingToken.current++;
            if (live) setRecording(false);
            return ctx.shortcuts.recording(false).catch(() => {});
          };
          stopRecording = stop;
          return () => { live = false; preferencesLive.current = false; stop(); stopRecording = () => {}; };
        }, []);
        React.useEffect(() => { if (recording) capture.current?.focus(); }, [recording]);
        if (props?.view === "summary") return null;
        const start = async () => {
          const token = ++recordingToken.current;
          setNativeMessage(""); setCandidate(undefined);
          nativeRevision.current = ctx.shortcuts.config.getSnapshot().revision;
          try {
            await ctx.shortcuts.recording(true);
            if (token !== recordingToken.current || !alive) { await ctx.shortcuts.recording(false); return; }
            setRecording(true);
          } catch { setNativeMessage("当前无法录制快捷键，原有快捷键保持有效。"); }
        };
        const describeNative = binding => {
          try {
            const described = ctx.shortcuts.describeBinding(binding);
            const conflicts = described.conflicts.filter(other => other !== RETURN_ID);
            if (described.issue || conflicts.length) {
              setNativeMessage(conflicts.length ? "这个组合已被 DSH 占用，请换一个。" : "这个组合不能用于回到快捷模式。");
              return;
            }
            return described;
          } catch { setNativeMessage("无法识别这个组合，请换一个。"); }
        };
        const finishRecording = binding => {
          heldBinding.current = undefined;
          const described = describeNative(binding);
          if (described) { setCandidate(described); setNativeMessage(""); stopRecording(); }
        };
        const record = event => {
          if (!recording) return;
          event.preventDefault(); event.stopPropagation();
          if (event.repeat || event.isComposing || event.nativeEvent?.isComposing || /^(Meta|Control|Shift|Alt)/.test(event.code)) return;
          if ((event.key === "Escape" || event.code === "Escape") && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
            stopRecording(); setNativeMessage("已取消录制"); return;
          }
          if (!event.metaKey && !event.ctrlKey && !event.altKey) { setNativeMessage("请搭配 ⌘、Ctrl 或 Option，避免占用日常打字单键。"); return; }
          const modifiers = [];
          if (event.metaKey) modifiers.push("primary");
          if (event.ctrlKey) modifiers.push("control");
          if (event.altKey) modifiers.push("alt");
          if (event.shiftKey) modifiers.push("shift");
          const held = heldBinding.current;
          if (held && held.code !== event.code && sameBinding(held, { code: held.code, modifiers }))
            finishRecording({ ...held, secondCode: event.code });
          else heldBinding.current = { code: event.code, modifiers };
        };
        const release = event => {
          const held = heldBinding.current;
          if (held && (event.code === held.code || /^(Meta|Control|Shift|Alt)/.test(event.code))) {
            event.preventDefault(); event.stopPropagation(); finishRecording(held);
          }
        };
        const applyNative = async (operation, freshRevision = false) => {
          if (savingNative.current) return;
          const expectedRevision = freshRevision ? ctx.shortcuts.config.getSnapshot().revision : nativeRevision.current;
          savingNative.current = true;
          setBusy(true); setNativeMessage("");
          try {
            await stopRecording();
            if (!alive || !preferencesLive.current) return;
            const result = await ctx.shortcuts.edit(operation, expectedRevision);
            if (!alive || !preferencesLive.current) return;
            if (result.status === "saved") { setCandidate(undefined); setNativeMessage("已保存，下次启动仍然有效。"); }
            else setNativeMessage(result.status === "stale" ? "快捷键配置已变化，请重试。" : result.status === "conflict" ? "这个组合与其他快捷键冲突，原有键位保持有效。" : "保存失败，原有键位保持有效。");
          } catch {
            if (alive && preferencesLive.current) setNativeMessage("保存失败，原有键位保持有效。");
          } finally {
            savingNative.current = false;
            if (alive && preferencesLive.current) setBusy(false);
          }
        };
        const selectPreset = async preset => {
          if (savingNative.current) return;
          await stopRecording();
          setCandidate(undefined);
          if (!preset.reset && !describeNative(preset.binding)) return;
          await applyNative(preset.reset ? { type: "reset", id: RETURN_ID } : { type: "set", id: RETURN_ID, binding: preset.binding }, true);
        };
        const save = () => {
          const error = saveConfig(draft, expected);
          if (error) setMessage(error);
          else { setExpected(raw); setDraft(structuredClone(config)); setMessage("快捷键设置已保存"); }
        };
        const row = returnRow();
        const state = !row ? "未注册" : !row.binding ? "" : row.conflicts?.length ? "与其他快捷键冲突，未启用" : row.issue ? "不可用" : "";
        const copyRow = copyUrlRow();
        const copyState = !copyRow ? "未注册" : !copyRow.binding ? "" : copyRow.conflicts?.length ? "与其他快捷键冲突，未启用" : copyRow.issue ? "不可用" : "";
        const matchedPreset = row?.binding && RETURN_PRESETS.find(preset => sameBinding(row.binding, preset.binding))?.key;
        const commandEscape = !row?.binding?.secondCode && row?.binding?.code === "Escape" && row.binding.modifiers?.length === 1 && ["meta", "primary"].includes(row.binding.modifiers[0]);
        const groups = ["区域", "操作", "跳转"];
        return h("section", { className: "sc-preferences", "aria-label": "Shortcutter 设置" },
          h("div", { className: "sc-settings-body" },
            h("section", { className: "sc-preference-section" },
              h("h3", null, "回到快捷模式"),
              h("p", null, "对话、侧栏与页面内按 Esc；终端与网页使用下方组合键。"),
              h("div", { className: "sc-native-row" },
                h("span", { className: "sc-native-key", "data-sc-return": RETURN_ID }, row?.binding ? row.keys.join(" ") : "未绑定"),
                RETURN_PRESETS.map(preset => h("button", { type: "button", key: preset.key, "aria-pressed": !recording && !candidate && matchedPreset === preset.key, onClick: () => selectPreset(preset), disabled: busy || !row }, preset.label)),
                h("button", { type: "button", "aria-pressed": recording || !!candidate || (!!row?.binding && !matchedPreset), onClick: start, disabled: busy || recording || !row }, "自定义…"),
                state && h("span", { className: "sc-muted" }, state)),
              commandEscape && h("p", { className: "sc-muted", "data-sc-system-note": "" },
                "⌘ Esc 若被 macOS“游戏叠层”拦截，可在系统设置 → 键盘快捷键 → 调度中心里取消勾选“游戏叠层”，或改用 ⌥ Esc / ⌃ Esc。"),
              recording && h("input", { ref: capture, className: "sc-capture", readOnly: true, value: "", placeholder: "按下组合键 · Esc 取消", "aria-label": "录制回到快捷模式快捷键",
                onKeyDown: record, onKeyUp: release, onBlur: () => { heldBinding.current = undefined; } }),
              candidate && h("div", { className: "sc-native-row" },
                h("span", null, "新组合：", candidate.keys.join(" ")),
                h("button", { type: "button", disabled: busy, onClick: () => candidate && applyNative({ type: "set", id: RETURN_ID, binding: candidate.binding }) }, "保存组合"),
                h("button", { type: "button", disabled: busy, onClick: () => { setCandidate(undefined); setNativeMessage(""); } }, "取消")),
              h("p", { className: "sc-status", role: "status" }, nativeMessage)),
            h("section", { className: "sc-preference-section" },
              h("h3", null, "复制浏览器网址"),
              h("p", null, "在网页内、地址栏或对话输入时直接复制当前打开的浏览器网址，不改变焦点（可在 DSH 快捷键设置中修改）。"),
              h("div", { className: "sc-native-row" },
                h("span", { className: "sc-native-key", "data-sc-copy-url": COPY_URL_ID }, copyRow?.binding ? copyRow.keys.join(" ") : "未绑定"),
                copyState && h("span", { className: "sc-muted" }, copyState))),
            h("section", { className: "sc-preference-section" },
              h("h3", null, "触发方式"),
              h("label", { className: "sc-check" },
                h("input", { type: "checkbox", checked: draft.autoNavigate, onChange: e => setDraft({ ...draft, autoNavigate: e.target.checked }) }),
                h("span", null, "默认开启快捷模式（点击输入框打字时自动退出，失焦后恢复）"))),
            h("section", { className: "sc-preference-section" },
              h("div", { className: "sc-section-heading" },
                h("div", null,
                  h("h3", null, "快捷按键"),
                  h("p", null, "支持单键、Tab / Shift+Tab，或 g / n 加一个键；g、n、? 固定保留，留空取消绑定。")),
                h("button", { type: "button", onClick: () => setDraft({ ...draft, bindings: defaultConfig().bindings }) }, "恢复默认键位")),
              h("div", { className: "sc-binding-groups" }, groups.map(group => h("div", { className: "sc-binding-group", key: group },
                h("div", { className: "sc-group-title" }, group),
                h("div", { className: "sc-binding-grid" }, COMMANDS.filter(c => c.group === group).map(command => h("label", { className: "sc-binding-row", key: command.id },
                  h("span", null, command.label),
                  h("input", { "aria-label": command.label, value: draft.bindings[command.id], placeholder: "未绑定", maxLength: 16, spellCheck: false, autoCapitalize: "off", autoComplete: "off", onChange: e => setDraft({ ...draft, bindings: { ...draft.bindings, [command.id]: e.target.value } }) }))))
              ))))),
          h("footer", { className: "sc-preferences-footer" }, h("p", { role: "status", className: "sc-status" }, message), h("button", { type: "button", className: "sc-primary", onClick: save, disabled: !!recording || busy }, "保存设置")));
      }

      function Panel() {
        React.useSyncExternalStore(subscribe, () => revision);
        React.useSyncExternalStore(fn => ctx.shortcuts.catalog.subscribe(fn), () => ctx.shortcuts.catalog.getSnapshot());
        const token = pending?.id, sessionId = mounted(), currentTab = ctx.sidebarRight.active();
        const terminalTab = pending && currentTab?.kind === "terminal" && ctx.sidebarRight.isExpanded() ? currentTab : undefined;
        const model = React.useMemo(() => terminalTab && ctx.webTerminals.view(sessionId, terminalTab.id, terminalTab.contentId), [sessionId, terminalTab?.id, terminalTab?.contentId]);
        const state = React.useSyncExternalStore(fn => model ? model.state.subscribe(fn) : () => {}, () => model?.state.getSnapshot());
        const session = pending && sessionId ? ctx.sessions.binding(sessionId)?.session : undefined;
        const subscribeSession = React.useCallback(fn => session ? session.subscribe(fn) : () => {}, [session]);
        const openState = React.useSyncExternalStore(subscribeSession, () => session?.getSnapshot().openState);
        const [committed, setCommitted] = React.useState();
        React.useEffect(() => {
          if (!pending || pending.id !== token) return;
          if (pending.awaitSessionChange) {
            if (mounted() && (pending.selectSession ? mounted() === pending.selectSession : mounted() !== pending.session)) {
              pending = { ...pending, session: mounted(), awaitSessionChange: false };
            } else return;
          }
          if (pending.session !== mounted()) {
            if (pending.enter === "conversation" && mounted()) pending = { ...pending, session: mounted() };
            else { cancelPending(); return; }
          }
          if (pending.enter === "browser") {
            const context = navigationContext();
            if (!pending.toolTarget || !ctx.sidebarRight.isTargetCurrent(pending.toolTarget)
              || currentTab?.id !== pending.toolTarget.tabId
              || context.scope || ["menu", "modal", "inactive", "composition"].includes(context.reason)) {
              cancelPending(); return;
            }
            const input = browserAddress(pending.toolTarget);
            if (!input) return;
            cancelPending(); manualNavigation = false;
            input.focus({ preventScroll: true }); input.select?.();
            navigationObserver?.refresh(); publish();
            return;
          }
          if (pending.toolTarget) {
            const context = navigationContext(), focused = ctx.sidebarRight.focusedTarget(context.active);
            // Retained terminal state can be writable before its lazy view has
            // mounted. Wait for that view, then a commit, so its own autofocus
            // finishes before this single return-to-navigation handoff.
            const contentReady = !model || [...document.querySelectorAll('.xterm textarea')].some(element => {
              const owner = ctx.sidebarRight.focusedTarget(element);
              return visible(element) && owner?.sessionId === pending.session
                && owner?.tabId === pending.toolTarget.tabId && owner?.occurrence === pending.toolTarget.occurrence;
            });
            const status = toolHandoffStatus({ request: pending.toolTarget, sessionId: mounted(), activeTabId: currentTab?.id,
              current: ctx.sidebarRight.isTargetCurrent(pending.toolTarget), reason: context.reason,
              ownsFocus: focused?.tabId === pending.toolTarget.tabId && focused?.sessionId === pending.session,
              idleFocus: context.active === document.body || own(context.active), originFocus: context.active === pending.origin,
              editingHeader: isNavigationInput(context.active) && !!context.active.closest('[data-dockkit-strip], [data-dockkit-float-grip]'),
              contentReady,
              terminalState: model ? state || { writable: false } : undefined });
            if (status === "cancel" || context.scope) { cancelPending(); return; }
            if (status === "wait") return;
          }
          if (pending.enter === "terminal") {
            if (model && !state?.writable) {
              if (["closed", "failed"].includes(state?.phase) || state?.info?.state === "exited") cancelPending();
              return;
            }
            if (committed !== token) { setCommitted(token); return; }
            const textarea = [...document.querySelectorAll(".xterm textarea")].find(el => inPaneTarget(pending.toolTarget, el));
            if (!textarea) return;
            cancelPending(); manualNavigation = false;
            textarea.focus({ preventScroll: true });
            navigationObserver?.refresh(); publish();
            return;
          }
          if (pending.enter === "conversation") {
            if (!sessionId) return;
            if (openState === "error") { take(token); return; }
            if (openState && openState !== "open") return;
            const context = navigationContext();
            if (context.scope || ["menu", "modal", "inactive", "composition"].includes(context.reason)) { cancelPending(); return; }
            const binding = ctx.sessions.binding(sessionId);
            if (!binding) return;
            if (committed !== token) { setCommitted(token); return; }
            cancelPending(); manualNavigation = false;
            ctx.conversation.input.for(binding.ctx).focus();
            navigationObserver?.refresh(); publish();
            return;
          }
          if (sessionId && openState !== "open" && openState !== "error") return;
          if (model && !state?.writable && !["closed", "failed"].includes(state?.phase) && state?.info?.state !== "exited") return;
          // Wait for public readiness and one additional plugin-owned React commit.
          // There is no host focus-ready contract; never chase subsequent focus.
          if (committed !== token) { setCommitted(token); return; }
          take(token);
        }, [token, sessionId, currentTab?.id, openState, state?.writable, state?.phase, state?.info?.state, committed, revision]);
        const available = returnUsable(returnRow());
        const items = COMMANDS.filter(c => {
          const key = config.bindings[c.id];
          return prefix ? key.startsWith(prefix + " ") : key && !key.includes(" ");
        });
        const gTabCount = prefix === "g" && !navigationScope && !activePanel() ? Math.min(9, tabs().length) : 0;
        const keepFocus = event => { if (event.pointerType !== "touch") event.preventDefault(); };
        // A preview that appears under a resting cursor must still expire. Only
        // real movement inside it (or keyboard focus) pauses its reading time.
        const hoverMove = event => {
          const point = `${event.clientX},${event.clientY}`;
          if (hoverPoint !== undefined && hoverPoint !== point) pauseHint();
          hoverPoint = point;
        };
        // The host marks body portals no-drag, which is inherited even by a
        // pointer-transparent cue. Reset only our wrapper; interactive panels
        // explicitly opt out of dragging in our CSS.
        const overlay = h("div", { className: "sc-root", style: { WebkitAppRegion: "initial" }, ref: el => { layer = el; } },
          navigationScope && h("div", { className: "sc-anchor", tabIndex: -1, "aria-hidden": true, ref: el => { scopeAnchor = el; } }),
          h(FocusCue),
          navigating && prefix === "g" && !navigationScope && !activePanel() && h(TabBadges),
          navigating && (hints || (prefix && prefixShown) || entryHint) && h("section", { className: "sc-panel", "aria-label": "快捷模式提示",
            onPointerMove: hoverMove, onFocusCapture: pauseHint,
            onPointerLeave: event => { hoverPoint = undefined; if (!event.currentTarget.contains(document.activeElement)) resumeHint(); },
            onBlurCapture: event => { if (!event.currentTarget.contains(event.relatedTarget) && !event.currentTarget.matches(":hover")) resumeHint(); } },
            h("header", { className: "sc-panel-header" }, h("span", { className: "sc-panel-title" }, h("span", { className: "sc-dot", "aria-hidden": true }), prefix === "g" ? "跳转" : prefix === "n" ? "新建" : "快捷"), h("span", { className: "sc-muted" }, surfaceLabel()),
              h("button", { type: "button", className: "sc-icon-button", "aria-label": "Shortcutter 设置", title: "Shortcutter 设置", onPointerDown: keepFocus, onClick: () => run("pluginSettings") }, "⚙")),
            h("div", { className: "sc-grid" },
              items.map(c => h("button", { type: "button", className: "sc-key-row", key: c.id, "data-sc-command": c.id, onPointerDown: keepFocus, onClick: () => run(c.id) }, h("span", { className: "sc-keys" }, keyCaps(prefix ? config.bindings[c.id].split(" ")[1] : config.bindings[c.id])), h("span", null, c.id === "closeTab" ? (navigationScope ? "关闭设置" : activePanel() ? "关闭当前页面" : "关闭当前工具标签") : c.label))),
              gTabCount > 0 && h("button", { type: "button", className: "sc-key-row", key: "tab-digits", "data-sc-command": "tab:0", onPointerDown: keepFocus, onClick: () => run("tab:0") }, h("span", { className: "sc-keys" }, keyCaps(gTabCount > 1 ? `1-${gTabCount}` : "1")), h("span", null, "切换工具标签"))),
            !prefix && h("div", { className: "sc-prefix-row" }, [ ["n", "新建"], ["g", "跳转"] ].map(([key, label]) => h("button", { type: "button", key, onPointerDown: keepFocus, onClick: () => { clearHint(); enterPrefix(key, true); hints = false; focusScopeAnchor(navigationScope).focus({ preventScroll: true }); publish(); } }, h("span", { className: "sc-keys" }, keyCaps(key)), label, h("span", { className: "sc-chevron", "aria-hidden": true }, "›")))),
            h("footer", { className: "sc-panel-footer" }, h("span", null, prefix === "n" ? "新建后直接进入输入" : prefix ? "依次按键" : navigationScope ? "设置内 Esc 回到快捷模式或关闭" : area === "sidebar" ? "侧栏内 Esc 回到快捷模式" : area === "conversation" ? (activePanel() ? "页内 Esc 回到快捷模式" : "对话内 Esc 回到快捷模式") : `${returnLabel()} 回到快捷模式`), h("span", null, "esc ", prefix ? "返回" : "收起"))),
          notice && h("div", { role: "status", className: "sc-notice", "data-sc-compact": noticeCompact ? "" : undefined }, notice));
        return h("div", { className: "sc-root", ref: el => { root = el; }, "data-sc-navigation": navigating ? "true" : "false", "data-sc-area": surfaceArea(), "data-sc-prefix": prefix },
          h("div", { id: "sc-navigation-anchor", ref: el => { anchor = el; }, className: "sc-anchor", tabIndex: -1, role: "group", "aria-label": `快捷模式，按 ? 显示快捷键，${config.bindings.enter || "点击"}进入内容` }),
          // shell.overlay is below fullscreen tools (20 vs 40). Keep our anchor
          // in that slot for layout ownership, but paint our pointer-transparent
          // cues and on-demand help outside its stacking context. Settings still
          // need their own modal top layer.
          createPortal(overlay, navigationScope || document.body),
          searchRequest && h(SessionSearch, { key: searchRequest.id, request: searchRequest }),
          !navigating && !available && h("button", { type: "button", className: "sc-peek", onClick: () => take(undefined, true, null, true) }, "回到快捷模式"));
      }

      // Older hosts keep the metadata switcher when the status service is absent.
      ctx.inject(["uiSession", "uiSession.sessionStatus"], scope => {
        scope.effect(() => {
          sessionStatus = scope.uiSession.sessionStatus;
          publish(true);
          return () => { sessionStatus = undefined; publish(true); };
        }, "shortcutter.session-status");
      });
      ctx.effect(() => {
        const style = document.createElement("style"); style.dataset.shortcutter = ""; style.textContent = STYLE; document.head.append(style);
        return () => style.remove();
      }, "shortcutter.style");
      ctx.effect(() => ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "shortcutter", order: 999 }, Panel)), "shortcutter.overlay");
      ctx.effect(() => ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
        name: "plugins.bundle.config", key: "dsh-shortcutter"
      }, Preferences)), "shortcutter.settings");
      ctx.effect(() => {
        const command = {
          id: RETURN_ID, label: () => "Shortcutter · 回到快捷模式", aliases: [],
          defaults: { "desktop:macos": DEFAULT_RETURN_BINDING },
          regions: ["page", "editable", "terminal"], modals: ["settings"],
          resolve: input => {
            const nativeWebviewTarget = input?.source === "webview" ? input.target : null;
            return ["menu", "modal", "inactive", "composition"].includes(navigationContext({ nativeWebviewTarget }).reason)
              ? { status: "blocked", reason: "modal" }
              : { status: "handled", run: () => take(undefined, true, nativeWebviewTarget, true) };
          }
        };
        try { return ctx.shortcuts.register(command); }
        catch {
          // Another plugin may have claimed the default. Keep a visible entry and
          // let the user choose a free combination in the official registry.
          try { return ctx.shortcuts.register({ ...command, defaults: {} }); }
          catch { return () => {}; }
        }
      }, "shortcutter.return");
      ctx.effect(() => {
        const command = {
          id: COPY_URL_ID, label: () => "Shortcutter · 复制浏览器网址",
          aliases: ["copy url", "copy browser url", "复制网址", "复制浏览器网址"],
          defaults: { "desktop:macos": DEFAULT_COPY_URL_BINDING },
          regions: ["page", "editable", "terminal"], modals: [],
          resolve: input => {
            const nativeWebviewTarget = input?.source === "webview" ? input.target : null;
            const context = navigationContext({ nativeWebviewTarget });
            return context.scope || ["menu", "modal", "inactive", "composition"].includes(context.reason)
              ? { status: "blocked", reason: "modal" }
              : { status: "handled", run: () => { void copyBrowserUrl(input); } };
          }
        };
        try { return ctx.shortcuts.register(command); }
        catch {
          try { return ctx.shortcuts.register({ ...command, defaults: {} }); }
          catch { return () => {}; }
        }
      }, "shortcutter.copy-url");
      ctx.effect(() => ctx.shortcuts.observeFixedInput(input => {
        if (input.type === "reset") {
          // The host also resets on pointerdown/focusin. Let our own controls
          // finish those events, so the menu stays mounted until their click.
          const reset = ++inputReset;
          clearTimeout(resetTimer);
          resetTimer = setTimeout(() => {
            if (alive && reset === inputReset && (prefix || hints)) { prefix = ""; hints = false; publish(); }
          }, 0);
          return;
        }
        const { gesture: g, context: c } = input;
        if (handledEscape && g.code === "Escape") { handledEscape = false; return; }
        // Any real key during the pause after an explicit return means the user
        // already knows what to press: keep that sequence quiet.
        if (hintDelayTimer !== undefined && !/^(Shift|Control|Meta|Alt)/.test(g.code)) clearHint();
        if (c.target !== anchor && !own(c.target) && !g.meta && !g.control && !g.alt && !/^(Shift|Control|Meta|Alt)/.test(g.code)) {
          firstNavigation = false;
          if (pending) cancelPending();
        }
        // macOS Chinese IMEs report keyCode 229 (or leave host composition guards
        // set) on non-input surfaces while preserving physical event.code. Yield
        // to IME composition only inside actual editable/embedded targets.
        if (g.defaultPrevented || g.repeat || g.control || g.meta || g.alt || altGraph) return;
        const inEditableOrContent = isNavigationInput(c.target) || isNavigationContent(c.target);
        if (inEditableOrContent && g.composing) return;
        if (g.code === "Escape") {
          if (!g.shift) handleEscape(c.target, { prevent: () => input.consume(), stop: () => {} });
          return;
        }
        if (!navigating && inEditableOrContent) return;
        const context = navigationObserver?.refresh() || navigationContext();
        if (context.reason === "modal" && context.sidebarDrawer?.contains(c.target)
          && c.target === context.active && (config.autoNavigate || manualNavigation)
          && !inEditableOrContent && !nativeNavigationKey(c.target, g.code)) {
          // A drawer owns its keys. Only the user's sidebar toggle can close it here.
          const key = tokenFromGesture(g), binding = config.bindings.sidebar;
          if (key && binding === (prefix ? `${prefix} ${key}` : key)) {
            input.consume(); clearPrefixTimers(); run("sidebar");
          } else if (key && binding.startsWith(key + " ")) {
            input.consume(); enterPrefix(key, false);
          } else if (prefix) { prefix = ""; clearPrefixTimers(); }
          return;
        }
        if (["menu", "modal", "inactive", "composition"].includes(context.reason)) return;
        if (!context.navigating || c.target !== document.activeElement || nativeNavigationKey(c.target, g.code)) return;
        const result = resolveSequence(config.bindings, prefix, tokenFromGesture(g));
        if (!result.consume) return;
        // g opens its menu at once only when help was already on screen.
        const helpVisible = hints || entryHint || (!!prefix && prefixShown);
        inputReset++; input.consume(); clearHint();
        if (result.prefix) enterPrefix(result.prefix, helpVisible);
        else { prefix = ""; clearPrefixTimers(); }
        hints = result.toggleHints ? !hints : false;
        if (result.command) run(result.command);
        else if (result.tabIndex !== undefined) run(`tab:${result.tabIndex}`);
        publish();
      }), "shortcutter.local-keys");
      ctx.effect(() => {
        let mountedSession;
        const changed = () => {
          const id = mounted();
          if (!id && activePanel()) {
            mountedSession = undefined;
            if (!seenSession) { seenSession = true; area = "conversation"; target = undefined; requestNavigation(); }
            return;
          }
          if (seenSession && id === mountedSession) return;
          seenSession = true; mountedSession = id;
          if (lastSession && id && id !== lastSession) previousSession = lastSession;
          if (id) { lastSession = id; sessionHistory = [id, ...sessionHistory.filter(item => item !== id)].slice(0, 100); }
          if (pending?.selectSession && !id) return;
          if (pending?.selectSession === id && id) {
            pending = { ...pending, session: id, awaitSessionChange: false };
            area = "conversation"; target = undefined; publish();
          } else if (pending?.enter === "conversation" && id) {
            pending = { ...pending, session: id, awaitSessionChange: false };
            area = "conversation"; target = undefined;
            publish();
          } else if (!pending?.toolTarget || pending.session !== id) {
            area = "conversation"; target = undefined;
            requestNavigation();
          }
        };
        const off = ctx.sidebarRight.mounted.subscribe(changed); changed();
        return off;
      }, "shortcutter.session");
      ctx.effect(() => {
        if (!ctx.layout.panelInfo?.subscribe) return () => {};
        let lastPanel = activePanel();
        return ctx.layout.panelInfo.subscribe(() => {
          const panel = activePanel();
          if (panel === lastPanel) return;
          lastPanel = panel;
          area = "conversation"; target = undefined;
          if (!pending?.enter && !pending?.selectSession) requestNavigation();
          publish();
        });
      }, "shortcutter.panel");
      ctx.effect(() => {
        let timer, disposed = false, inventory;
        const read = () => {
          if (disposed) return;
          const nextInventory = ctx.sidebarRight.openTabs.getSnapshot();
          if (inventory !== nextInventory) {
            inventory = nextInventory; toolHistory.reconcile(inventory);
          }
          rememberActiveTool();
          if (!pending && !navigationContext().scope) rememberArea(document.activeElement);
          // Also lets a pending tool handoff observe its committed host pane.
          publish(!!pending);
        };
        const schedule = () => { clearTimeout(timer); timer = setTimeout(read, 0); };
        const markers = '[data-dockkit-tab], [data-dockkit-pane], [data-dockkit-float], [data-sidebar-right-tab]';
        const observer = new MutationObserver(records => {
          if (records.some(record => !own(record.target) && (record.type === "attributes"
            || pending?.toolTarget || [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element
              && (node.matches(markers) || node.querySelector(markers)))))) schedule();
        });
        observer.observe(document.body, { subtree: true, childList: true, attributes: true,
          attributeFilter: ["aria-selected", "data-dockkit-pane-active", "data-dockkit-float-active", "data-sidebar-right-open", "data-sidebar-right-tab"] });
        const focused = event => {
          const captured = ctx.sidebarRight.focusedTarget(event.target);
          if (captured) toolHistory.remember(captured.sessionId, captured.tabId, tabs());
          if (pending?.toolTarget && !own(event.target) && event.target !== pending.origin
            && event.target !== document.body && captured?.tabId !== pending.toolTarget.tabId) cancelPending();
          schedule();
        };
        const off = ctx.sidebarRight.openTabs.subscribe(schedule);
        const clicked = event => {
          if (pending || event.target.closest?.('[data-sidebar-right-session]')) schedule();
        };
        document.addEventListener("focusin", focused, true);
        document.addEventListener("click", clicked, true);
        read();
        return () => { disposed = true; clearTimeout(timer); observer.disconnect(); off();
          document.removeEventListener("focusin", focused, true); document.removeEventListener("click", clicked, true); };
      }, "shortcutter.tool-history");
      ctx.effect(() => {
        navigationObserver = observeNavigationContext(document, {
          read: navigationContext,
          ignore: own,
          changed: next => {
            if (own(next.active)) inputReset++;
            if (["input", "content"].includes(next.reason)) manualNavigation = false;
            if (!next.scope && !pending) rememberArea(next.active);
            if (!next.navigating || navigationScope !== next.scope) {
              prefix = ""; hints = false;
              // An explicit WebView return may briefly leave the outer document
              // inactive while its anchor already owns DOM focus. A real blur,
              // hidden document, input or overlay still cancels the entry hint.
              if (next.reason !== "inactive" || document.hidden || navigationScope !== next.scope) clearHint();
            }
            navigationScope = next.scope;
            navigating = next.navigating;
            publish();
          }
        });
        const pointer = event => {
          if (own(event.target)) { inputReset++; return; }
          firstNavigation = false;
          // Mouse use elsewhere is not a request for keyboard help: cancel a
          // scheduled preview and put away a visible one.
          cancelPending(); prefix = ""; hints = false; clearHint();
          const context = navigationContext();
          if (!context.scope && !["menu", "modal"].includes(context.reason)) {
            rememberArea(event.target);
            if (columns().right?.contains(event.target) && !ctx.sidebarRight.focusedTarget(event.target)) {
              area = ctx.sidebarRight.active()?.kind || "right";
              target = ctx.sidebarRight.commandTarget(null);
            }
          }
          publish();
        };
        // Runs on body bubble: after React/Lexical local popups (#root), before
        // SettingsRoot's document Escape close and DSH's window stop-shortcut.
        const bodyEscape = event => {
          if ((event.key !== "Escape" && event.code !== "Escape") || event.defaultPrevented
            || event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || altGraph) return;
          const targetEl = event.composedPath?.().find(node => node instanceof Element) || event.target;
          if ((isNavigationInput(targetEl) || isNavigationContent(targetEl)) && (event.isComposing || event.keyCode === 229)) return;
          if (hintDelayTimer !== undefined) clearHint();
          if (targetEl !== anchor && !own(targetEl)) {
            firstNavigation = false;
            if (pending) cancelPending();
          }
          if (handleEscape(targetEl, { prevent: () => event.preventDefault(), stop: () => event.stopPropagation() })) {
            handledEscape = true;
            queueMicrotask(() => { handledEscape = false; });
          }
        };
        const modalEscape = event => {
          if ((event.key !== "Escape" && event.code !== "Escape") || (event.target !== document && event.target !== document.documentElement)) return;
          const context = navigationObserver.refresh();
          if (!context.scope || !context.navigating || (!prefix && !hints && !entryHint)
            || event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || altGraph) return;
          event.preventDefault(); event.stopPropagation();
          inputReset++; prefix = ""; hints = false; clearHint(); clearPrefixTimers(); publish();
        };
        const trackModifier = event => { altGraph = !!event.getModifierState?.("AltGraph"); };
        const guardCompositionReset = event => {
          if (own(event.target) || (event.type === "compositionend" && navigating)) {
            queueMicrotask(() => { if (alive) inputReset++; });
          }
        };
        // The initial activation retains the existing one-shot handoff. Later
        // activation only observes the focused control; it never moves focus.
        const activate = () => { if (firstNavigation) requestNavigation(); else navigationObserver.refresh(); };
        const blur = () => {
          altGraph = false;
          cancelPending(); prefix = ""; hints = false; clearHint(); navigating = false; publish();
        };
        const storage = event => {
          if (event.key !== STORAGE_KEY || event.storageArea !== localStorage) return;
          raw = event.newValue;
          const loaded = readConfig(raw);
          if (loaded.config) { config = loaded.config; storageError = loaded.notice || ""; }
          else storageError = loaded.error;
          prefix = ""; hints = false; clearHint(); cancelPending(); navigationObserver.refresh(); publish();
        };
        const submitted = event => {
          const form = event.target;
          if (!(form instanceof HTMLFormElement) || !config.autoNavigate) return;
          const pane = form.closest("[data-dockkit-pane]");
          const captured = pane && ctx.sidebarRight.focusedTarget(form);
          if (!pane || !captured || tabs().find(t => t.tabId === captured.tabId)?.kind !== "browser") return;
          if (!form.contains(document.activeElement)) return;
          setTimeout(() => {
            if (!alive || !config.autoNavigate || !pane.isConnected) return;
            if (pane.querySelector('[role="alert"]') || !form.contains(document.activeElement)) return;
            if (ctx.sidebarRight.active()?.id !== captured.tabId) return;
            take(undefined, true);
          }, 0);
        };
        document.addEventListener("keydown", trackModifier, true);
        document.addEventListener("keyup", trackModifier, true);
        document.addEventListener("compositionstart", guardCompositionReset, true);
        document.addEventListener("compositionend", guardCompositionReset, true);
        document.addEventListener("submit", submitted);
        document.body.addEventListener("keydown", bodyEscape);
        document.addEventListener("keydown", modalEscape, true);
        document.addEventListener("pointerdown", pointer, true);
        const stopHeaderNavigation = observeToolHeaderNavigation(document, {
          enabled: () => config.autoNavigate,
          blocked: () => {
            const context = navigationObserver.refresh();
            return !!context.scope || ["menu", "modal", "inactive", "composition"].includes(context.reason);
          },
          headerFor: element => {
            const captured = ctx.sidebarRight.focusedTarget(element);
            return captured && navigationToolHeader(element, { sessionId: mounted(), kind: tabs().find(tab => tab.tabId === captured.tabId)?.kind });
          },
          capture: element => ctx.sidebarRight.focusedTarget(element),
          current: captured => !!captured.tabId && ctx.sidebarRight.active()?.id === captured.tabId && ctx.sidebarRight.isTargetCurrent(captured),
          navigate: captured => {
            target = captured;
            area = tabs().find(tab => tab.tabId === captured.tabId)?.kind || "right";
            toolHistory.remember(captured.sessionId, captured.tabId, tabs());
            requestNavigation(captured);
          }
        });
        window.addEventListener("focus", activate);
        window.addEventListener("blur", blur);
        window.addEventListener("storage", storage);
        return () => {
          alive = false; stopRecording(); stopHeaderNavigation(); navigationObserver.dispose();
          document.removeEventListener("keydown", trackModifier, true);
          document.removeEventListener("keyup", trackModifier, true);
          document.removeEventListener("compositionstart", guardCompositionReset, true);
          document.removeEventListener("compositionend", guardCompositionReset, true);
          document.removeEventListener("submit", submitted);
          document.body.removeEventListener("keydown", bodyEscape);
          document.removeEventListener("keydown", modalEscape, true); document.removeEventListener("pointerdown", pointer, true);
          window.removeEventListener("focus", activate); window.removeEventListener("blur", blur); window.removeEventListener("storage", storage);
          clearTimeout(pendingTimer); clearTimeout(noticeTimer); clearTimeout(resetTimer); clearHint(); clearPrefixTimers(); pending = undefined; listeners.clear();
          if (own(document.activeElement) && visible(returnElement)) returnElement.focus({ preventScroll: true });
        };
      }, "shortcutter.lifecycle");
    }
    return { inject, apply };
  }
});
