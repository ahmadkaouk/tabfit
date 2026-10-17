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

  const MARK = `<svg class="mark" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M1.5 20.5c2 0 3.5-1 3.5-3V8a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v9.5c0 2 1.5 3 3.5 3z"/></svg>`;
  const SANS = "TabFit Instrument Sans";
  const MONO = "TabFit JetBrains Mono";
  const pad = value => String(value).padStart(2, "0");
  const css = `
    :host { all: initial !important; position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; display: block !important; color-scheme: light dark !important; }
    * { box-sizing: border-box; }
    .veil, .notice, .chip { --bg: #ffffff; --surface: #f4f5f8; --surface-hover: #eceef3; --line: #e6e8ee; --ink: #0e1220; --muted: #646b7c; --faint: #a0a6b3;
      --accent: #2f5bff; --accent-track: #e3e9ff; --on-accent: #ffffff; --warn: #d97706; --bad: #dc2626; --bad-soft: #fdecec; --bad-ink: #b42318;
      --sans: '${SANS}',ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; --mono: '${MONO}',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
      font: 15px/1.5 var(--sans); -webkit-font-smoothing: antialiased; color: var(--ink); }
    @media (prefers-color-scheme: dark) { .veil, .notice, .chip { --bg: #0e1118; --surface: #171b25; --surface-hover: #1f2430; --line: #222735; --ink: #eceef4; --muted: #959cab; --faint: #5f6677;
      --accent: #3f63ff; --accent-track: #1d2546; --on-accent: #ffffff; --warn: #fbbf24; --bad: #f87171; --bad-soft: rgb(248 113 113 / .12); --bad-ink: #fca5a5; } }
    .mark { flex-shrink: 0; color: var(--accent); }
    .mark path { fill: currentColor; }
    .brand { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 600; letter-spacing: -.01em; color: var(--ink); }
    .veil { position: fixed; inset: 0; overflow: auto; display: flex; flex-direction: column; padding: 0 28px 24px; background: var(--bg); outline: none; }
    .top { flex-shrink: 0; height: 60px; margin: 0 -28px; padding: 0 28px; display: flex; align-items: center; justify-content: space-between; gap: 16px; border-bottom: 1px solid var(--line); font-size: 14px; color: var(--muted); }
    .top [data-host] { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .card { width: min(520px, 100%); margin: auto; padding: 48px 0; display: flex; flex-direction: column; align-items: flex-start; }
    .pill { height: 26px; padding: 0 10px; display: inline-flex; align-items: center; gap: 7px; border-radius: 13px; background: var(--bad-soft); color: var(--bad-ink); font-size: 13px; font-weight: 600; }
    .pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--bad); }
    h1 { margin: 16px 0 0; font: 600 clamp(36px, 5vw, 52px)/1.05 var(--sans); letter-spacing: -.03em; text-wrap: balance; }
    p { margin: 12px 0 0; font-size: 16px; color: var(--muted); }
    .focus { width: 100%; margin-top: 28px; padding: 16px 18px; background: var(--surface); border-radius: 14px; overflow-wrap: anywhere; }
    .label { font-size: 13px; font-weight: 500; color: var(--muted); }
    .focus strong { display: block; margin-top: 2px; font-size: 17px; line-height: 1.4; font-weight: 600; }
    .progress { margin-top: 16px; height: 6px; overflow: hidden; border-radius: 3px; background: var(--accent-track); }
    .progress i { display: block; height: 100%; border-radius: inherit; background: var(--accent); }
    .time { margin-top: 8px; display: flex; justify-content: space-between; gap: 16px; font-size: 13px; color: var(--muted); }
    .time b { font: 500 13px var(--mono); color: var(--ink); font-variant-numeric: tabular-nums; }
    .time b span { margin: 0 -.12em; }
    button { height: 42px; padding: 0 18px; font: 600 14px var(--sans); cursor: pointer; border: 0; border-radius: 10px; background: transparent; color: var(--ink); transition: background .12s, opacity .12s, color .12s; }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    button:disabled { opacity: .55; cursor: wait; }
    .primary { background: var(--accent); color: var(--on-accent); }
    .primary:hover { opacity: .9; }
    .secondary { background: var(--surface); }
    .secondary:hover { background: var(--surface-hover); }
    .quiet { margin-left: auto; padding: 0 12px; color: var(--muted); }
    .quiet:hover { color: var(--ink); background: var(--surface); }
    .actions { width: 100%; margin-top: 16px; display: flex; flex-wrap: wrap; gap: 8px; }
    .error { margin-top: 12px; font-size: 14px; color: var(--bad); }
    .error:empty { display: none; }
    .foot { margin: 0; font-size: 13px; color: var(--muted); }
    .chip { position: fixed; top: 20px; right: 20px; height: 34px; padding: 0 14px 0 12px; display: flex; align-items: center; gap: 9px; background: var(--bg); border: 1px solid var(--line); border-radius: 17px; box-shadow: 0 10px 28px -12px rgb(14 18 32 / .3); font-size: 13px; font-weight: 500; color: var(--ink); animation: appear 0s .4s both; }
    .spinner { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--accent-track); border-top-color: var(--accent); }
    @keyframes appear { from { visibility: hidden; } }
    .notice { position: fixed; top: 20px; right: 20px; width: 340px; max-width: calc(100vw - 40px); padding: 14px 16px 16px; background: var(--bg); border: 1px solid var(--line); border-radius: 14px; box-shadow: 0 18px 44px -14px rgb(14 18 32 / .32); font-size: 14px; line-height: 1.5; }
    .notice .brand { font-size: 13px; }
    .notice .mark { width: 15px; height: 15px; }
    .notice [data-text] { display: block; margin-top: 8px; }
    .notice-actions { margin-top: 14px; display: flex; gap: 8px; }
    .notice button { height: 32px; padding: 0 12px; font-size: 13px; border-radius: 8px; }
    @media (prefers-reduced-motion: no-preference) {
      .card { animation: enter .28s cubic-bezier(.2,.7,.3,1) both; }
      .notice { animation: fade .2s ease both; }
      .chip { animation: fade .2s ease .4s both; }
      .spinner { animation: spin .8s linear infinite; }
      @keyframes enter { from { opacity: 0; transform: translateY(6px); } }
      @keyframes fade { from { opacity: 0; } }
      @keyframes spin { to { transform: rotate(1turn); } }
    }
  `;

  function loadFont() {
    // @font-face is ignored inside shadow roots, so the bundled face is registered on the document.
    if (globalThis.__tabfitFont) return;
    globalThis.__tabfitFont = send("FONT").then(faces => Promise.all(faces.map(({ family, weight, data, unicodeRange }) => {
      const face = new FontFace(family, Uint8Array.from(atob(data), char => char.charCodeAt(0)), { weight, unicodeRange });
      document.fonts.add(face);
      return face.loaded;
    }))).catch(() => { globalThis.__tabfitFont = null; });
  }

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
    const time = shadow?.querySelector("[data-time]");
    if (time) {
      const ms = currentSession.endsAt - Date.now();
      const seconds = Math.ceil(ms / 1000);
      // A separate colon lets CSS close the gap a monospace colon leaves.
      time.replaceChildren(pad(Math.floor(seconds / 60)), Object.assign(document.createElement("span"), { textContent: ":" }), pad(seconds % 60));
      shadow.querySelector("[data-fill]").style.width = `${Math.max(0, Math.min(100, ms / currentSession.durationMs * 100))}%`;
      shadow.querySelector("[data-total]").textContent = `${Math.round(currentSession.durationMs / 60000)} min session`;
    }
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
        const index = buttons.indexOf(shadow.activeElement);
        if (event.shiftKey ? index <= 0 : index === -1 || index === buttons.length - 1) {
          event.preventDefault();
          (event.shiftKey ? buttons.at(-1) : buttons[0]).focus();
        }
      });
      // Focus the dialog itself: no stray focus ring, and Enter can't trigger "End session".
      shadow.querySelector(".veil").focus({ preventScroll: true });
    } else {
      host.style.setProperty("pointer-events", "none", "important");
      const card = shadow.querySelector(".notice");
      if (card) card.style.pointerEvents = "auto";
    }
    guardUI();
  }

  function notice(text, retry = false) {
    if (!canDisplay()) return;
    mount(`<div class="notice" role="status"><span class="brand">${MARK}TabFit</span><span data-text></span><div class="notice-actions"><button class="secondary" data-dismiss>Dismiss</button>${retry ? `<button class="primary" data-retry>Try again</button>` : ""}</div></div>`);
    shadow.querySelector("[data-text]").textContent = text;
    shadow.querySelector("[data-dismiss]").onclick = removeUI;
    shadow.querySelector("[data-retry]")?.addEventListener("click", () => schedule(true));
  }

  function showChecking(isPdf = false) {
    if (!canDisplay()) return;
    // Checks never cover the page. The chip only becomes visible when a check is slow.
    mount(`<div class="chip" role="status"><span class="spinner" aria-hidden="true"></span>${isPdf ? "Reading PDF" : "Checking page"}</div>`);
    checking = true;
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
    mount(`<div class="veil" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="tabfit-title"><div class="top"><div class="brand">${MARK}TabFit</div><span data-host></span></div><div class="card"><span class="pill">Off task</span><h1 id="tabfit-title">Stay on track.</h1><p>This page looks unrelated to what you’re working on.</p><div class="focus"><span class="label">Your focus</span><strong data-goal></strong><div class="progress" aria-hidden="true"><i data-fill></i></div><div class="time"><span><b data-time></b> left</span><span data-total></span></div></div><div class="actions"><button class="primary" data-back>Go back</button><button class="secondary" data-allow>Allow this page</button><button class="quiet" data-end>End session</button></div><div class="error" role="alert"></div></div><p class="foot">Jev can make mistakes. Your judgment comes first.</p></div>`, true);
    shadow.querySelector("[data-host]").textContent = location.hostname.replace(/^www\./, "");
    shadow.querySelector("[data-goal]").textContent = currentSession.goal;
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
      loadFont();
      const page = snapshot();
      const fingerprint = JSON.stringify([currentSession.id, url, page]);
      if (!force && fingerprint === lastFingerprint) return;
      lastFingerprint = fingerprint;
      // A block screen stays in place while its page is re-checked.
      const blocking = Boolean(shadow?.querySelector(".veil"));
      if (!blocking) showChecking(page.kind === "pdf");
      const watchdog = setTimeout(() => {
        if (fresh() && checking) { revision++; lastFingerprint = ""; notice("The check took too long. This page is still accessible.", true); }
      }, page.kind === "pdf" ? 30000 : 16000);
      let result;
      try { result = await send("CHECK_PAGE", { page, sessionId: currentSession.id }); }
      finally { clearTimeout(watchdog); }
      if (!fresh()) return;
      if (!canDisplay()) return;
      if (result.status === "block") { if (!shadow?.querySelector(".veil")) showBlock(); }
      else if (result.status === "uncertain") notice("Jev isn't sure this is off task, so this page stays accessible.");
      else if (result.status === "unreadable") { lastFingerprint = ""; notice(result.message, true); }
      else if (result.status === "error") { lastFingerprint = ""; notice(result.message, true); }
      else if (result.status === "idle" || result.status === "excluded") reset();
      else removeUI();
    } catch (error) {
      // A disconnected script cannot know whether a session is still running.
      // Quietly clear stale state; confirmed API failures use result.status above.
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
