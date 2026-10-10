import { digest, remainingTime, sanitizePage } from "./core.js";

// Chrome persists only this small state in storage.session: no page excerpts or raw URLs.
export class FocusSession {
  constructor({ state, classify, preparePage = async page => page, save = async () => {}, now = Date.now }) {
    this.state = state ?? { session: null, cache: {}, overrides: {}, lastDecision: null };
    this.classify = classify;
    this.preparePage = preparePage;
    this.save = save;
    this.now = now;
    this.epoch = 0;
    this.pending = new Map();
    this.tabJobs = new Map();
    this.cooldownUntil = 0;
  }

  active() {
    const s = this.state.session;
    return Boolean(s && !s.paused && remainingTime(s, this.now()) > 0);
  }

  async persist() { await this.save(structuredClone(this.state)); }

  async start(goal, minutes) {
    goal = typeof goal === "string" ? goal.trim() : "";
    if (goal.length < 3 || goal.length > 600) throw new Error("Describe your task in 3–600 characters.");
    if (![25, 50, 90].includes(minutes)) throw new Error("Choose a 25, 50 or 90 minute session.");
    this.epoch++;
    this.cooldownUntil = 0;
    this.state = {
      session: { id: crypto.randomUUID(), goal, startedAt: this.now(), endsAt: this.now() + minutes * 60000,
        durationMs: minutes * 60000, remainingMs: minutes * 60000, paused: false, checked: 0, blocked: 0 },
      cache: {}, overrides: {}, lastDecision: null,
    };
    await this.persist();
    return this.state.session;
  }

  async end() {
    this.epoch++;
    this.state = { session: null, cache: {}, overrides: {}, lastDecision: null };
    await this.persist();
  }

  async pause() {
    if (!this.active()) return;
    this.epoch++;
    this.state.session.remainingMs = remainingTime(this.state.session, this.now());
    this.state.session.paused = true;
    await this.persist();
  }

  async resume() {
    if (!this.state.session?.paused) return;
    this.epoch++;
    this.state.session.endsAt = this.now() + this.state.session.remainingMs;
    this.state.session.paused = false;
    await this.persist();
  }

  invalidate(tabId) { this.tabJobs.delete(tabId); }

  async override(url, sessionId) {
    const epoch = this.epoch;
    const key = await digest(url);
    if (!this.active() || epoch !== this.epoch || this.state.session.id !== sessionId) return { status: "idle" };
    this.state.overrides[key] = true;
    const keys = Object.keys(this.state.overrides);
    if (keys.length > 300) delete this.state.overrides[keys[0]];
    await this.persist();
    return { status: "overridden" };
  }

  async check({ tabId, url, page, sessionId, isCurrent = async () => true }) {
    if (!this.active() || sessionId !== this.state.session.id) return { status: "idle" };
    const epoch = this.epoch;
    const s = this.state.session;
    const job = Symbol();
    this.tabJobs.set(tabId, job);
    const valid = () => this.epoch === epoch && this.active() && this.tabJobs.get(tabId) === job;
    const current = async () => valid() && await isCurrent() && valid();
    const urlKey = await digest(url);
    sanitizePage(page); // Reject unsupported addresses before any extraction.
    if (!await current()) return { status: "idle" };
    if (this.state.overrides[urlKey]) return { status: "overridden" };
    try {
      const prepared = await this.preparePage({ ...page, url });
      if (!await current()) return { status: "idle" };
      if (this.state.overrides[urlKey]) return { status: "overridden" };
      if (prepared.status === "unreadable") {
        this.state.lastDecision = { status: "unreadable", host: new URL(url).hostname, at: this.now() };
        await this.persist();
        return await current() ? prepared : { status: "idle" };
      }
      const safePage = sanitizePage(prepared);
      const cacheKey = await digest(JSON.stringify([s.id, urlKey, safePage]));
      const cached = this.state.cache[cacheKey];
      if (cached && cached.expiresAt > this.now()) return cached.decision;
      if (this.cooldownUntil > this.now()) return { status: "error", message: "Jev is unavailable. Pages stay accessible; retry shortly." };
      // Multiple tabs showing the same content share a request.
      if (!this.pending.has(cacheKey)) {
        const request = Promise.resolve().then(() => this.classify(s.goal, safePage));
        this.pending.set(cacheKey, request);
        request.finally(() => this.pending.delete(cacheKey)).catch(() => {});
      }
      const decision = await this.pending.get(cacheKey);
      if (!await current()) return { status: "idle" };
      if (this.state.overrides[urlKey]) return { status: "overridden" };
      if (!["allow", "block", "uncertain"].includes(decision?.status)) throw new Error("Invalid decision received.");
      if (!this.state.cache[cacheKey]) {
        s.checked++;
        if (decision.status === "block") s.blocked++;
      }
      this.state.cache[cacheKey] = { decision, expiresAt: this.now() + 5 * 60000 };
      const keys = Object.keys(this.state.cache);
      if (keys.length > 100) delete this.state.cache[keys[0]];
      this.state.lastDecision = { status: decision.status, host: new URL(url).hostname, at: this.now() };
      await this.persist();
      return await current() ? decision : { status: "idle" };
    } catch (error) {
      if (!await current()) return { status: "idle" };
      this.cooldownUntil = this.now() + 30000;
      this.state.lastDecision = { status: "error", host: new URL(url).hostname, at: this.now() };
      await this.persist();
      return { status: "error", message: error.message || "Jev is unavailable. This page is still accessible." };
    }
  }
}
