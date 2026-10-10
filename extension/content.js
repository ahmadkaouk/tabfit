(() => {
  // Reinjection replaces this controller, including its timers and event listeners.
  globalThis.__tabfitFocusCleanup?.();
  const events = new AbortController();
  let disposed = false;
  let revision = 0;
  let timer;
  let refreshTimer;
  let endTimer;
  let host;
  let shadow;
  let lastFingerprint = "";
  let currentSession = null;
  let previousFocus;
  let guarded = [];
  let blockObserver;
  let mediaGuard;
  let checking = false;
  const runtimeAvailable = () => {
    try { return Boolean(chrome.runtime?.id); } catch { return false; }
  };
  const sessionActive = () => Boolean(currentSession && !currentSession.paused && currentSession.endsAt > Date.now());
  const send = async (type, extra = {}) => {
    const response = await chrome.runtime.sendMessage({ type, url: location.href, ...extra });
    if (!response?.ok) throw new Error(response?.error || "TabFit could not connect.");
    return response.data;
  };

  const css = `
    :host { all: initial !important; position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; display: block !important; color-scheme: light !important; }
    * { box-sizing: border-box; }
    .veil { position: fixed; inset: 0; display: grid; place-items: center; padding: 28px; background: #f7f7f2; color: #27382c; font: 15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
    .card { width: min(480px, 100%); text-align: center; }
    .brand { font-size: 14px; font-weight: 700; letter-spacing: -.3px; display: flex; align-items: center; justify-content: center; gap: 9px; }
    .mark { width: 24px; height: 24px; border: 7px solid #49644e; border-right-color: #b5c3a4; border-radius: 50%; display: inline-block; transform: rotate(-35deg); }
    .orbit { height: 100px; width: 100px; border: 1px solid #ced8c5; border-radius: 50%; margin: 42px auto 27px; display: grid; place-items: center; box-shadow: 0 0 0 15px #eef1e8,0 0 0 16px #dfe5d8; }
    .orbit .mark { height: 43px; width: 43px; border-width: 12px; }
    .eyebrow { text-transform: uppercase; letter-spacing: 2px; font-size: 10px; font-weight: 700; color: #748170; margin: 25px 0 12px; }
    h1 { font-family: Georgia,serif; font-size: clamp(30px,5vw,42px); line-height: 1.16; font-weight: 400; margin: 0 0 18px; letter-spacing: -1.2px; }
    p { margin: 0 0 22px; color: #6b7468; }
    .goal { background: #eef1e8; border: 1px solid #dfe5d7; border-radius: 14px; padding: 20px 23px; margin: 27px 0; text-align: left; overflow-wrap: anywhere; }
    .goal small { display: block; font-size: 10px; letter-spacing: 1.3px; text-transform: uppercase; color: #798571; margin-bottom: 6px; }
    .goal strong { font-size: 16px; font-weight: 500; }
    button { font: inherit; cursor: pointer; border-radius: 10px; padding: 12px 18px; font-size: 13px; border: 1px solid #d9dfd3; background: transparent; color: #43543f; }
    button:focus-visible { outline: 3px solid #92a676; outline-offset: 3px; }
    button:hover { filter: brightness(.95); }
    button:disabled { opacity: .55; cursor: wait; }
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .primary { background: #49644e; color: white; border-color: #49644e; }
    .link { border: 0; font-size: 12px; padding: 16px; color: #7e8877; }
    .foot { font-size: 11px; margin-top: 20px; color: #87907e; }
    .notice { position: fixed; top: 20px; right: 20px; max-width: min(360px,calc(100vw - 40px)); padding: 14px 18px; background: #f7f7f2; border: 1px solid #d8dfd1; border-radius: 14px; box-shadow: 0 6px 25px #15200d20; color: #4e6149; font: 12px/1.5 -apple-system,BlinkMacSystemFont,sans-serif; }
    .notice button { font-size: 11px; padding: 4px 9px; margin-top: 8px; }
    .error { color: #8e4735; font-size: 12px; margin-top: 12px; }
    @media(prefers-reduced-motion:no-preference) { .loading .orbit { animation: breathe 2s ease-in-out infinite; } @keyframes breathe { 50% { transform: scale(.94); opacity: .65; } } }
  `;

  function removeUI() {
    clearTimeout(endTimer);
    blockObserver?.disconnect();
    blockObserver = null;
    if (mediaGuard) document.removeEventListener("play", mediaGuard, true);
    mediaGuard = null;
    for (const [element, wasInert] of guarded) if (element.isConnected) element.inert = wasInert;
    guarded = [];
    host?.remove();
    host = shadow = null;
    checking = false;
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    previousFocus = null;
  }

  function reset() {
    revision++;
    clearTimeout(timer);
    clearTimeout(refreshTimer);
    currentSession = null;
    lastFingerprint = "";
    removeUI();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    reset();
    events.abort();
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch { /* Context already invalidated. */ }
    if (globalThis.__tabfitFocusCleanup === dispose) delete globalThis.__tabfitFocusCleanup;
  }
  globalThis.__tabfitFocusCleanup = dispose;

  function canDisplay() {
    if (disposed) return false;
    if (!runtimeAvailable()) { dispose(); return false; }
    if (!sessionActive()) { reset(); return false; }
    return true;
  }

  function guardUI() {
    // Notices and blocking screens both expire, even after a worker/extension reload.
    if (!canDisplay()) return;
    endTimer = setTimeout(guardUI, Math.max(1, Math.min(1000, currentSession.endsAt - Date.now())));
  }

  function mount(markup, modal = false) {
    removeUI();
    host = document.createElement("div");
    host.dataset.tabfitOverlay = "true";
    shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `<style>${css}</style>${markup}`;
    (document.body || document.documentElement).append(host);
    if (modal) {
      previousFocus = document.activeElement;
      const guard = () => {
        // Preserve each element's original inert state; restore it on every exit path.
        for (const container of [document.documentElement, document.body].filter(Boolean)) {
          for (const child of container.children) {
            if (child === host || child === document.body || child.tagName === "HEAD" || guarded.some(([el]) => el === child)) continue;
            guarded.push([child, child.inert]);
            child.inert = true;
          }
        }
      };
      guard();
      blockObserver = new MutationObserver(guard);
      blockObserver.observe(document.body || document.documentElement, { childList: true });
      mediaGuard = event => { if (event.target instanceof HTMLMediaElement) event.target.pause(); };
      document.addEventListener("play", mediaGuard, true);
      document.querySelectorAll("video,audio").forEach(media => media.pause());
      shadow.addEventListener("keydown", event => {
        if (event.key !== "Tab") return;
        const buttons = [...shadow.querySelectorAll("button:not(:disabled)")];
        if (!buttons.length) return;
        if (event.shiftKey && shadow.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1).focus(); }
        if (!event.shiftKey && shadow.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0].focus(); }
      });
      shadow.querySelector("button")?.focus({ preventScroll: true });
    } else {
      host.style.setProperty("pointer-events", "none", "important");
      shadow.querySelector(".notice").style.pointerEvents = "auto";
    }
    guardUI();
  }

  function notice(text, retry = false) {
    if (!canDisplay()) return;
    mount(`<div class="notice" role="status"><span></span><br><button>Dismiss</button>${retry ? " <button data-retry>Try again</button>" : ""}</div>`);
    shadow.querySelector("span").textContent = text;
    shadow.querySelector("button").onclick = removeUI;
    shadow.querySelector("[data-retry]")?.addEventListener("click", () => schedule(true));
  }

  function showChecking(isPdf = false) {
    if (!canDisplay()) return;
    mount(`<div class="veil loading" role="dialog" aria-modal="true" aria-label="Checking page relevance"><div class="card"><div class="brand"><i class="mark"></i>TabFit</div><div class="orbit"><i class="mark"></i></div><h1>A moment for intention.</h1><p>Checking this page against your focus.</p><button class="link" data-end>End focus session</button></div></div>`, true);
    checking = true;
    if (isPdf) shadow.querySelector("p").textContent = "Reading this PDF and checking it against your focus.";
    shadow.querySelector("[data-end]").onclick = endSession;
  }

  async function endSession() {
    const sessionId = currentSession?.id;
    try { await send("END_SESSION", { sessionId }); if (currentSession?.id === sessionId) reset(); }
    catch {
      if (currentSession?.id === sessionId) notice("Could not end the session. Open TabFit in the toolbar to try again.", true);
    }
  }

  function showBlock() {
    if (!canDisplay()) return;
    mount(`<div class="veil" role="dialog" aria-modal="true" aria-labelledby="tabfit-title"><div class="card"><div class="brand"><i class="mark"></i>TabFit</div><div class="orbit"><i class="mark"></i></div><div class="eyebrow">A gentle course correction</div><h1 id="tabfit-title">Come back to your focus.</h1><p><span data-host></span> looks unrelated to your task.</p><div class="goal"><small>You made time for</small><strong></strong></div><div class="actions"><button class="primary" data-back>Go back</button><button data-allow>Allow this page</button></div><button class="link" data-end>End focus session</button><p class="foot">Jev can make mistakes. Your judgment comes first.</p><div class="error" role="alert"></div></div></div>`, true);
    shadow.querySelector("[data-host]").textContent = location.hostname.replace(/^www\./, "");
    shadow.querySelector("strong").textContent = currentSession.goal;
    const back = shadow.querySelector("[data-back]");
    if (history.length <= 1) { back.textContent = "Leave this page"; back.onclick = () => location.assign("about:blank"); }
    else back.onclick = () => history.back();
    shadow.querySelector("[data-end]").onclick = endSession;
    shadow.querySelector("[data-allow]").onclick = async event => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await send("ALLOW_PAGE", { sessionId: currentSession.id });
        revision++;
        removeUI();
      } catch (error) {
        button.disabled = false;
        if (shadow) shadow.querySelector(".error").textContent = error.message;
      }
    };
  }

  function snapshot() {
    // Never inspect form controls or editable regions. Prefer main content over navigation.
    const root = document.querySelector("main, [role='main'], article") || document.body;
    const parts = [];
    let length = 0;
    let visited = 0;
    if (root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const el = node.parentElement;
          if (!el || el.closest("script,style,noscript,template,input,textarea,select,button,form,[contenteditable]:not([contenteditable='false']),[hidden],[aria-hidden='true'],[data-tabfit-overlay],nav,header,footer")) return NodeFilter.FILTER_REJECT;
          if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
          const style = getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || !el.getClientRects().length) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      let node;
      while (length < 4000 && visited++ < 2000 && (node = walker.nextNode())) {
        const text = node.textContent.replace(/\s+/g, " ").trim().slice(0, 4000 - length);
        if (text) { parts.push(text); length += text.length + 1; }
      }
    }
    const isPdf = document.contentType === "application/pdf" || (!parts.length &&
      (/\.pdf$/i.test(new URL(location.href).pathname) || Boolean(document.querySelector('embed[type="application/pdf"],object[type="application/pdf"]'))));
    return { kind: isPdf ? "pdf" : "html", title: document.title.slice(0, 200),
      description: (document.querySelector('meta[name="description"]')?.content || "").slice(0, 350),
      text: parts.join(" ").slice(0, 4000) };
  }

  async function inspect(force) {
    if (disposed) return;
    if (!runtimeAvailable()) { dispose(); return; }
    if (document.visibilityState !== "visible" || !document.body) return;
    const mine = ++revision;
    const url = location.href;
    const fresh = () => !disposed && mine === revision && location.href === url && document.visibilityState === "visible";
    clearTimeout(refreshTimer);
    try {
      const context = await send("CONTEXT");
      if (!fresh()) return;
      if (context.status !== "active") { reset(); return; }
      currentSession = context.session;
      if (!canDisplay()) return;
      const page = snapshot();
      const fingerprint = JSON.stringify([currentSession.id, url, page]);
      if (!force && fingerprint === lastFingerprint) return;
      lastFingerprint = fingerprint;
      showChecking(page.kind === "pdf");
      const watchdog = setTimeout(() => {
        if (fresh() && checking) { revision++; lastFingerprint = ""; notice("The check took too long. This page is still accessible.", true); }
      }, page.kind === "pdf" ? 30000 : 16000);
      let result;
      try { result = await send("CHECK_PAGE", { page, sessionId: currentSession.id }); }
      finally { clearTimeout(watchdog); }
      if (!fresh()) return;
      if (!canDisplay()) return;
      if (result.status === "block") showBlock();
      else if (result.status === "uncertain") notice("Jev isn't sure this is off task, so this page stays accessible.");
      else if (result.status === "unreadable") { lastFingerprint = ""; notice(result.message, true); }
      else if (result.status === "error") { lastFingerprint = ""; notice(result.message, true); }
      else if (result.status === "idle" || result.status === "excluded") reset();
      else removeUI();
    } catch (error) {
      // A disconnected script cannot know whether a session is still running.
      // Quietly clear stale state; confirmed gateway failures use result.status above.
      if (!runtimeAvailable()) dispose();
      else if (fresh()) reset();
    } finally {
      if (fresh() && sessionActive()) refreshTimer = setTimeout(() => schedule(false), 30000);
    }
  }

  function schedule(force = true) {
    if (disposed) return;
    if (!runtimeAvailable()) { dispose(); return; }
    if (currentSession && !sessionActive()) reset();
    clearTimeout(timer);
    clearTimeout(refreshTimer);
    // Cancel stale in-flight results immediately, before the debounce elapses.
    revision++;
    if (checking) removeUI();
    timer = setTimeout(() => inspect(force), 450);
  }

  function onMessage(message) {
    if (message.type === "INSPECT") schedule(true);
    if (message.type === "RESET") reset();
  }
  if (!runtimeAvailable()) { dispose(); return; }
  chrome.runtime.onMessage.addListener(onMessage);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") schedule(true);
    else { revision++; clearTimeout(timer); clearTimeout(refreshTimer); if (checking) removeUI(); }
  }, { signal: events.signal });
  window.addEventListener("pageshow", () => schedule(true), { signal: events.signal });
  window.addEventListener("popstate", () => schedule(true), { signal: events.signal });
  window.addEventListener("hashchange", () => schedule(true), { signal: events.signal });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => schedule(true), { once: true, signal: events.signal });
  else schedule(true);
})();
