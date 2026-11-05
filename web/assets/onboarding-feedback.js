(() => {
  "use strict";
  const keys = ["enter_workspace", "create_folder", "upload_file", "preview_file", "create_mcp_key", "mcp_tool_call"];
  const FULL_DURATION = 15000, MAX_PARTICLES = 420;
  const starPoints = Array.from({ length: 10 }, (_, index) => {
    const angle = index * Math.PI / 5 - Math.PI / 2, radius = index % 2 ? 0.45 : 1;
    return [Math.cos(angle) * radius, Math.sin(angle) * radius];
  });
  function create() {
    const seen = new Set(), queued = new Set(), media = window.matchMedia("(prefers-reduced-motion: reduce)");
    let baseline = false, previousAllComplete = false, fullObserved = false, pendingFull = false, showingFull = false;
    let disposed = false, batchTimer = null, expiry = null, frame = null, canvas = null, notice = null, particles = [], started = 0, effectHost = null, effectVersion = 0;
    function clearEffect() {
      effectVersion++;
      if (frame !== null) cancelAnimationFrame(frame);
      if (expiry !== null) clearTimeout(expiry);
      frame = expiry = null; particles = [];
      effectHost?.removeEventListener?.("close", clearEffect); effectHost = null;
      canvas?.remove(); notice?.remove(); canvas = notice = null;
    }
    function clearPending() {
      if (batchTimer !== null) clearTimeout(batchTimer);
      batchTimer = null; queued.clear(); pendingFull = false;
    }
    function updateNotice(completed) {
      notice.textContent = showingFull ? I18n.t("onboardingUnlocked") : completed.length === 1
        ? I18n.t("onboardingTaskCongratulations", { task: I18n.t("onboarding_" + completed[0]) })
        : I18n.t("onboardingTasksCongratulations", { count: completed.length });
    }
    let showing = [];
    const unsubscribe = I18n.subscribe(() => { if (notice) updateNotice(showing); });
    function celebrate(completed, full = false) {
      if (disposed || document.hidden || !completed.length) return;
      // 全部完成优先替换单任务场次，近邻单任务只合并通知。
      if (notice && !full) { showing = [...new Set([...showing, ...completed])]; updateNotice(showing); return; }
      if (full) clearEffect();
      showing = completed; showingFull = full;
      const version = effectVersion, duration = full ? FULL_DURATION : 2600;
      const dialogs = [...document.querySelectorAll?.("dialog[open]") || []];
      const host = dialogs[dialogs.length - 1] || document.fullscreenElement || document.body;
      notice = document.createElement("div");
      notice.className = "onboarding-task-notice";
      notice.setAttribute("role", "status"); notice.setAttribute("aria-live", "polite"); notice.setAttribute("aria-atomic", "true");
      effectHost = host; host.addEventListener?.("close", clearEffect);
      host.append(notice); updateNotice(completed);
      expiry = setTimeout(clearEffect, full ? FULL_DURATION : 3000);
      if (media.matches) return;
      canvas = document.createElement("canvas"); canvas.className = "onboarding-confetti";
      canvas.setAttribute("aria-hidden", "true");
      host.append(canvas);
      const ctx = canvas.getContext("2d");
      if (!ctx) { canvas.remove(); canvas = null; return; }
      const width = Math.max(1, window.innerWidth), height = Math.max(1, window.innerHeight), ratio = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); ctx.scale(ratio, ratio);
      const tokens = getComputedStyle(document.documentElement);
      const colors = ["--color-primary", "--color-success", "--color-warning", "--color-text-primary"].map((name) => tokens.getPropertyValue(name).trim());
      function burst() {
        for (const side of [0, 1]) for (let i = 0; i < 65; i++) {
          const angle = ((side ? 120 : 60) + (Math.random() - 0.5) * (full ? 70 : 55)) * Math.PI / 180;
          const speed = Math.min(width, height) * (0.7 + Math.random() * (full ? 0.75 : 0.55));
          particles.push({ x: side * width, y: height * (full ? 0.45 + Math.random() * 0.45 : 0.6), vx: Math.cos(angle) * speed, vy: -Math.sin(angle) * speed,
            size: (full ? 6 : 4) + Math.random() * (full ? 6 : 5), rotation: Math.random() * Math.PI, spin: (Math.random() - 0.5) * 12,
            color: colors[i % colors.length], shape: full ? i % 3 : 0 });
        }
        if (full) for (const origin of [0.2, 0.5, 0.8]) {
          const x = width * origin, y = height * (0.15 + Math.random() * 0.3);
          for (let i = 0; i < 30; i++) {
            const angle = (i / 30 * Math.PI * 2) + Math.random() * 0.12;
            const speed = Math.min(width, height) * (0.2 + Math.random() * 0.5);
            particles.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
              size: 6 + Math.random() * 6, rotation: Math.random() * Math.PI, spin: (Math.random() - 0.5) * 12,
              color: colors[i % colors.length], shape: i % 3 });
          }
        }
        if (particles.length > MAX_PARTICLES) particles.splice(0, particles.length - MAX_PARTICLES);
      }
      burst();
      started = performance.now(); let previous = started, nextBurst = 500;
      function draw(now) {
        if (version !== effectVersion || disposed) return;
        frame = null;
        if (document.hidden || media.matches) { clearEffect(); return; }
        const elapsed = now - started, dt = Math.min(0.04, Math.max(0, now - previous) / 1000); previous = now;
        ctx.clearRect(0, 0, width, height);
        if (elapsed >= duration) { canvas.remove(); canvas = null; particles = []; return; }
        if (full && elapsed >= nextBurst && elapsed < duration - 1200) { burst(); nextBurst = elapsed + 500; }
        ctx.globalAlpha = Math.min(1, (duration - elapsed) / 700);
        particles = particles.filter((p) => p.y < height + 80 && p.x > -200 && p.x < width + 200);
        for (const p of particles) {
          p.vx *= Math.pow(full ? 0.985 : 0.96, dt * 60); p.vy += height * (full ? 0.6 : 0.75) * dt;
          p.x += p.vx * dt; p.y += p.vy * dt; p.rotation += p.spin * dt;
          ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rotation); ctx.fillStyle = p.color;
          if (p.shape === 1) { ctx.beginPath(); ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2); ctx.fill(); }
          else if (p.shape === 2) {
            ctx.beginPath(); starPoints.forEach(([x, y], index) => { if (index) ctx.lineTo(x * p.size, y * p.size); else ctx.moveTo(x * p.size, y * p.size); }); ctx.closePath(); ctx.fill();
          } else ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.65 * Math.cos(p.rotation));
          ctx.restore();
        }
        frame = requestAnimationFrame(draw);
      }
      frame = requestAnimationFrame(draw);
    }
    function flush() {
      batchTimer = null;
      if (document.hidden || disposed) return;
      const full = pendingFull, completed = full ? keys : [...queued];
      queued.clear(); pendingFull = false; celebrate(completed, full);
    }
    function onVisibility() {
      if (document.hidden) { if (batchTimer !== null) clearTimeout(batchTimer); batchTimer = null; clearEffect(); }
      else if (pendingFull || queued.size) flush();
    }
    function onMotion() { if (media.matches && canvas) { effectVersion++; if (frame !== null) cancelAnimationFrame(frame); frame = null; canvas.remove(); canvas = null; particles = []; } }
    const api = {
      accept(value) {
        if (disposed || value?.version !== 1 || typeof value.enabled !== "boolean" || !Array.isArray(value.tasks) ||
          value.tasks.length !== keys.length || value.totalCount !== keys.length || new Set(value.tasks.map((task) => task?.key)).size !== keys.length ||
          !value.tasks.every((task) => keys.includes(task?.key) && typeof task.completed === "boolean") ||
          value.completedCount !== value.tasks.filter((task) => task.completed).length || value.allComplete !== (value.completedCount === keys.length)) return;
        const fullTransition = baseline && !previousAllComplete && value.allComplete && !fullObserved && value.enabled;
        previousAllComplete = value.allComplete;
        if (value.allComplete) fullObserved = true;
        for (const task of value.tasks) {
          if (!task.completed || seen.has(task.key)) continue;
          seen.add(task.key);
          if (baseline && value.enabled && !fullTransition) queued.add(task.key);
        }
        baseline = true;
        if (!value.enabled) { clearPending(); clearEffect(); return; }
        if (fullTransition) {
          clearPending(); clearEffect(); pendingFull = true;
          if (!document.hidden) flush();
          return;
        }
        if (queued.size && batchTimer === null && !document.hidden) batchTimer = setTimeout(flush, 120);
      },
      destroy() {
        if (disposed) return;
        disposed = true; clearPending(); clearEffect(); unsubscribe();
        document.removeEventListener("visibilitychange", onVisibility); media.removeEventListener("change", onMotion); window.removeEventListener("pagehide", api.destroy);
      },
    };
    document.addEventListener("visibilitychange", onVisibility); media.addEventListener("change", onMotion); window.addEventListener("pagehide", api.destroy);
    return api;
  }
  let standalone = null;
  async function connect(page, user) {
    if (page.embedded || user?.role === "admin") return null;
    if (standalone) return standalone;
    const feedback = create(); let pending = null, again = false, disposed = false;
    async function refresh() {
      if (disposed) return;
      if (pending) { again = true; return pending; }
      pending = (async () => {
        do {
          again = false;
          try { const value = await API("onboarding"); if (!disposed) feedback.accept(value); }
          catch (error) { if (!disposed) console.warn("Onboarding feedback unavailable", error); }
        } while (again && !disposed);
      })().finally(() => { pending = null; });
      return pending;
    }
    standalone = { refresh };
    window.addEventListener("focus", refresh);
    window.addEventListener("pagehide", () => { disposed = true; window.removeEventListener("focus", refresh); standalone = null; }, { once: true });
    await refresh(); return standalone;
  }
  window.OnboardingFeedback = { create, connect, refresh: () => standalone?.refresh() };
})();
