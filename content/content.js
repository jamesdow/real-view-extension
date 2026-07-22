(function () {
  const DEFAULTS = {
    hideAiImages: true, // false = show everything normally; true = filter AI images (switch ON)
    action: "blur",      // "blur" | "hide"
    deepScan: true,      // fetch image bytes and read embedded metadata
    tagReal: true,       // outline images from known-real sources
    customAiDomains: [],
    visualDetection: false, // on-device ML classifier — opt-in, large one-time download + CPU cost
  };

  let settings = { ...DEFAULTS };
  let flaggedCount = 0;
  // Infinite-scroll grids (Pinterest's masonry layout especially) destroy and recreate
  // <img> elements for pins you've already scrolled past — a fresh element has no
  // dataset.realview and isn't in `processed`, so without a src-based check the same
  // image gets reclassified and recounted every time it's remounted.
  const countedAiSrcs = new Set();
  const countedRealSrcs = new Set(); // same src-based dedup as countedAiSrcs, for the lifetime stats page
  let processed = new WeakSet();
  const queue = [];
  let inFlight = 0;
  const MAX_IN_FLIGHT = 4;

  // Visual classification is far more CPU-costly per image than a metadata fetch, so it gets
  // its own smaller-capacity queue, and only ever runs on images actually visible in the
  // viewport (via IntersectionObserver) rather than a page's whole off-screen backlog.
  const visualQueue = [];
  let visualInFlight = 0;
  const MAX_VISUAL_IN_FLIGHT = 2;
  const pendingVisualSrc = new WeakMap();
  const visualResultCache = new Map(); // src -> verdict, de-dupes repeated/duplicate images

  // Personal per-image overrides, set via the right-click "Flag as AI" / "Mark as real"
  // menu (background/background.js). Matched by exact URL — the seed for a future
  // shared/crowdsourced list, but for now just a way to fix a miss or a false positive
  // without waiting on a domain list to catch up.
  let userFlaggedAi = new Set();
  let userFlaggedReal = new Set();

  // Per-site pause (popup.js), independent of hideAiImages — this controls whether
  // Real View does ANYTHING here at all (scanning, fetching bytes, running the visual
  // model), not just whether it blurs what it finds. "I don't want it scanning every
  // site" needs a real off switch, not just a "don't hide what you find" switch.
  let disabledSites = [];

  // The marketing site scans itself too, since host_permissions is <all_urls> — its own
  // demo images then get genuinely classified by whatever's actually running (metadata,
  // domain list, visual model), which can contradict the demo's illustrative REAL/AI
  // badges. Exempt it outright rather than let the two disagree in front of a visitor.
  const SELF_HOSTNAMES = new Set([
    "localhost",
    "127.0.0.1",
    "REPLACE_WITH_DEPLOYED_DOMAIN", // update once the marketing site's real domain is live
  ]);

  function isActive() {
    return !disabledSites.includes(location.hostname) && !SELF_HOSTNAMES.has(location.hostname);
  }

  function loadSettings(cb) {
    chrome.storage.sync.get(DEFAULTS, (stored) => {
      settings = stored;
      RealViewDetector.setCustomAiDomains(stored.customAiDomains);
      chrome.storage.local.get(
        { refreshedAiBlocklist: [], userFlaggedAi: [], userFlaggedReal: [], disabledSites: [] },
        (local) => {
          RealViewDetector.setRefreshedAiDomains(local.refreshedAiBlocklist);
          userFlaggedAi = new Set(local.userFlaggedAi);
          userFlaggedReal = new Set(local.userFlaggedReal);
          disabledSites = local.disabledSites || [];
          cb && cb();
        }
      );
    });
  }

  function refreshImageState(img) {
    img.classList.remove("realview-ai-hidden", "realview-ai-blurred");
    if (!isActive() || img.dataset.realview !== "ai" || !settings.hideAiImages) return;
    img.classList.add(settings.action === "hide" ? "realview-ai-hidden" : "realview-ai-blurred");
  }

  function refreshAll() {
    document.querySelectorAll("img[data-realview]").forEach(refreshImageState);
  }

  // Small floating HUD so the user can see Real View is actively working through a page
  // (especially the visual classifier, which is slow enough per-image that without this
  // it just looks like images are randomly blurring one at a time for no visible reason).
  let hudEl = null;
  function ensureHud() {
    if (hudEl && document.documentElement.contains(hudEl)) return hudEl;
    hudEl = document.createElement("div");
    hudEl.id = "realview-hud";
    hudEl.innerHTML = '<span class="realview-hud-dot"></span><span class="realview-hud-text"></span>';
    (document.body || document.documentElement).appendChild(hudEl);
    return hudEl;
  }

  // While the visual model is still downloading/initializing, a queued image can sit "in
  // flight" for minutes — without this, the HUD would just say "checking 1 image…" that whole
  // time with no explanation, which reads exactly like the extension has hung (it hasn't).
  let modelStatus = { ready: false, pct: null };
  function refreshModelStatus() {
    chrome.storage.local.get(
      { visualDetectionBreadcrumbs: [], visualModelDownloadProgress: null },
      (local) => {
        const last = local.visualDetectionBreadcrumbs[local.visualDetectionBreadcrumbs.length - 1] || "";
        const p = local.visualModelDownloadProgress;
        modelStatus = {
          ready: last.includes("ready sent"),
          pct: p && p.total && !p.done ? Math.round((p.loaded / p.total) * 100) : null,
        };
        updateHud();
      }
    );
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.visualModelDownloadProgress || changes.visualDetectionBreadcrumbs)) {
      refreshModelStatus();
    }
  });
  refreshModelStatus();

  function updateHud() {
    const pending = queue.length + inFlight + visualQueue.length + visualInFlight;
    if (pending <= 0) {
      if (hudEl) hudEl.classList.remove("show");
      return;
    }
    const hud = ensureHud();
    const waitingOnModel = (visualQueue.length || visualInFlight) && !modelStatus.ready;
    hud.querySelector(".realview-hud-text").textContent = waitingOnModel
      ? modelStatus.pct != null
        ? `Real View: downloading AI model (${modelStatus.pct}%, first time only)…`
        : `Real View: preparing AI model (first time only)…`
      : `Real View: checking ${pending} image${pending === 1 ? "" : "s"}…`;
    hud.classList.add("show");
  }

  // On a single-page app (Pinterest, etc.) the same content script instance can outlive
  // several extension reloads during development — or a real extension update in
  // production — leaving its chrome.runtime connection dead ("Extension context
  // invalidated"). sendMessage throws synchronously in that case, so every call is
  // wrapped: a dead connection should never block the actual image-hiding behavior.
  function safeSendMessage(msg, cb) {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) return cb && cb(null);
        cb && cb(res);
      });
    } catch {
      cb && cb(null);
    }
  }

  // Lifetime stats for the stats page — keyed by which layer actually resolved the verdict
  // (set by the caller, not detector.js itself: "domainList" | "metadata" | "visual"). User
  // flag corrections carry no layer and are deliberately excluded — they're not something the
  // detection pipeline "caught", and are already tracked separately via userFlaggedAi/Real.
  function recordStat(kind, layer) {
    const domain = location.hostname;
    chrome.storage.local.get(
      {
        statsTotalScanned: 0,
        statsRealCount: 0,
        statsAiCount: 0,
        statsByDomain: {},
        statsByLayer: { metadata: 0, domainList: 0, visual: 0 },
        statsCurrentRealStreak: 0,
        statsLongestRealStreak: 0,
      },
      (s) => {
        s.statsTotalScanned++;
        const d = s.statsByDomain[domain] || { total: 0, ai: 0 };
        d.total++;
        if (kind === "ai") d.ai++;
        s.statsByDomain[domain] = d;

        if (kind === "real") {
          s.statsRealCount++;
          s.statsCurrentRealStreak++;
          if (s.statsCurrentRealStreak > s.statsLongestRealStreak) s.statsLongestRealStreak = s.statsCurrentRealStreak;
        } else {
          s.statsAiCount++;
          s.statsCurrentRealStreak = 0;
        }

        if (s.statsByLayer[layer] !== undefined) s.statsByLayer[layer]++;
        chrome.storage.local.set(s);
      }
    );
  }

  function applyVerdict(img, verdict) {
    if (img.dataset.realview) return; // already classified by another signal — don't double-count
    img.classList.remove("realview-scanning");
    img.dataset.realview = verdict.verdict;
    if (verdict.reason) img.title = `Real View: ${verdict.reason}`;

    if (verdict.verdict === "ai") {
      refreshImageState(img); // apply the visual effect first — a dead messaging channel must never block this
      const src = img.currentSrc || img.src;
      if (!src || !countedAiSrcs.has(src)) {
        if (src) countedAiSrcs.add(src);
        flaggedCount++;
        safeSendMessage({ type: "realview-flagged-count", count: flaggedCount });
        if (verdict.layer) recordStat("ai", verdict.layer);
      }
    } else if (verdict.verdict === "real") {
      if (settings.tagReal) img.classList.add("realview-real-tagged");
      const src = img.currentSrc || img.src;
      if (verdict.layer && (!src || !countedRealSrcs.has(src))) {
        if (src) countedRealSrcs.add(src);
        recordStat("real", verdict.layer);
      }
    }
  }

  // A user flag is an explicit correction — it should win even over an image scanImage()
  // already classified, so this bypasses applyVerdict's "already classified" guard.
  function applyUserFlagOverride(img, verdict, reason) {
    const wasAi = img.dataset.realview === "ai";
    img.classList.remove("realview-real-tagged");
    delete img.dataset.realview;
    applyVerdict(img, { verdict, reason });
    if (verdict !== "ai" && wasAi) refreshImageState(img); // clears blur/hide if flipped away from "ai"
  }

  function applyUserFlags() {
    document.querySelectorAll("img").forEach((img) => {
      const src = img.currentSrc || img.src;
      if (!src) return;
      if (userFlaggedAi.has(src)) applyUserFlagOverride(img, "ai", "You flagged this image as AI-generated");
      else if (userFlaggedReal.has(src)) applyUserFlagOverride(img, "real", "You marked this image as a real photo");
    });
  }

  function base64ToBytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function fetchBytesViaBackground(src) {
    return new Promise((resolve) => {
      safeSendMessage({ type: "realview-fetch-bytes", src }, (res) => {
        if (!res || !res.ok) return resolve(null);
        resolve(base64ToBytes(res.base64));
      });
    });
  }

  function pump() {
    updateHud();
    while (inFlight < MAX_IN_FLIGHT && queue.length) {
      const { img, src } = queue.shift();
      inFlight++;
      updateHud();
      fetchBytesViaBackground(src).then((bytes) => {
        inFlight--;
        const verdict = bytes ? RealViewDetector.scanBytes(bytes) : null;
        if (verdict) applyVerdict(img, { ...verdict, layer: "metadata" });
        else {
          let willContinue = false;
          if (settings.visualDetection) { queueVisualClassification(img, src); willContinue = true; }
          if (!willContinue) img.classList.remove("realview-scanning");
        }
        pump();
      });
    }
  }

  // The on-device visual classifier is far more CPU-costly per image than anything else in
  // this pipeline (real neural-net inference, not a domain check or a metadata scan), so it
  // only ever runs on images actually visible in the viewport — never a page's whole backlog
  // of off-screen thumbnails — and with its own much smaller concurrency cap.
  const visualObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        visualObserver.unobserve(entry.target);
        const src = pendingVisualSrc.get(entry.target);
        if (src) {
          pendingVisualSrc.delete(entry.target);
          visualQueue.push({ img: entry.target, src });
          pumpVisual();
        }
      }
    },
    { threshold: 0.1 }
  );

  function pumpVisual() {
    updateHud();
    while (visualInFlight < MAX_VISUAL_IN_FLIGHT && visualQueue.length) {
      const { img, src } = visualQueue.shift();
      visualInFlight++;
      updateHud();
      classifyVisual(src).then((verdict) => {
        visualInFlight--;
        if (verdict) applyVerdict(img, verdict);
        else img.classList.remove("realview-scanning");
        pumpVisual();
      });
    }
  }

  function classifyVisual(src) {
    if (visualResultCache.has(src)) return Promise.resolve(visualResultCache.get(src));
    return new Promise((resolve) => {
      safeSendMessage({ type: "realview-classify-visual", src }, (res) => {
        const verdict = res && res.verdict ? { verdict: res.verdict, reason: res.reason, layer: "visual" } : null;
        visualResultCache.set(src, verdict);
        resolve(verdict);
      });
    });
  }

  function queueVisualClassification(img, src) {
    if (visualResultCache.has(src)) {
      const verdict = visualResultCache.get(src);
      if (verdict) applyVerdict(img, verdict);
      else img.classList.remove("realview-scanning");
      return;
    }
    img.classList.add("realview-scanning");
    const rect = img.getBoundingClientRect();
    const inViewport = rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
    if (inViewport) {
      visualQueue.push({ img, src });
      pumpVisual();
    } else {
      pendingVisualSrc.set(img, src);
      visualObserver.observe(img);
    }
  }

  // Google Images (and similar result grids) route every thumbnail through their own
  // CDN, so <img src> never reveals the real host. Google embeds the true source page
  // in a data-lpage attribute on the tile wrapping each thumbnail — check that first.
  function getLandingPageUrl(img) {
    const tile = img.closest("[data-lpage]");
    return tile ? tile.dataset.lpage : null;
  }

  // Bing Images embeds a JSON blob (page URL + full-res image URL) directly on each
  // result's <a class="iusc"> wrapper — no network interception needed, unlike Pinterest.
  function getBingSourceUrl(img) {
    const tile = img.closest("a.iusc");
    if (!tile) return null;
    try {
      const data = JSON.parse(tile.getAttribute("m") || "");
      return data.purl || data.murl || null;
    } catch {
      return null;
    }
  }

  // DuckDuckGo Images proxies every thumbnail through external-content.duckduckgo.com,
  // but — unlike Google/Pinterest — the original image URL is right there in the proxy's
  // own query string, so no lookup of any kind is needed, just decoding it.
  function getDuckDuckGoSourceUrl(img) {
    const src = img.currentSrc || img.src;
    if (!src || !src.includes("external-content.duckduckgo.com")) return null;
    try {
      const encoded = new URL(src, location.href).searchParams.get("u");
      return encoded ? decodeURIComponent(encoded) : null;
    } catch {
      return null;
    }
  }

  function resolveSyncSourceUrl(img) {
    return getLandingPageUrl(img) || getBingSourceUrl(img) || getDuckDuckGoSourceUrl(img);
  }

  // Pinterest thumbnails all come from pinimg.com regardless of where the image actually
  // lives, but every pin object Pinterest's own JS handles carries the real destination in
  // a `link` field. content/pinterest-hook.js runs in the page's MAIN world (where it can
  // see Pinterest's own fetch calls) and posts newly-seen {pinId: {link, domain}} maps here.
  const isPinterest = /(^|\.)pinterest\.[a-z.]+$/.test(location.hostname);
  const pinterestPinData = {};
  const pendingPinImages = new Map(); // pinId -> Set<img>, waiting on data not seen yet

  function seedPinterestFromInitialProps() {
    const el = document.getElementById("__PWS_INITIAL_PROPS__");
    if (!el) return;
    try {
      const data = JSON.parse(el.textContent);
      const pins = data && data.initialReduxState && data.initialReduxState.pins;
      if (pins) mergePinterestPinData(pins);
    } catch {}
  }

  function mergePinterestPinData(pinsById) {
    for (const id in pinsById) {
      const p = pinsById[id];
      if (p && typeof p.link === "string") pinterestPinData[id] = p.link;
    }
    for (const [id, imgs] of pendingPinImages) {
      if (!(id in pinterestPinData)) continue;
      imgs.forEach((img) => {
        const verdict = RealViewDetector.classifyByDomain(pinterestPinData[id]);
        if (verdict) applyVerdict(img, { ...verdict, layer: "domainList" });
      });
      pendingPinImages.delete(id);
    }
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.source !== "realview-pinterest-pins") return;
    mergePinterestPinData(e.data.pins);
  });

  function getPinterestPinId(img) {
    const a = img.closest('a[href*="/pin/"]');
    if (!a) return null;
    const m = a.getAttribute("href").match(/\/pin\/(\d+)/);
    return m ? m[1] : null;
  }

  // Passively watching Pinterest's own network traffic (pinterest-hook.js) only learns a
  // pin's real destination if a fresh request for it happens to fire while we're watching —
  // pins Pinterest serves from its own client-side cache never trigger a new request, so
  // they'd otherwise sit unresolved forever. This actively resolves those by requesting the
  // pin's own public detail page (same page a user would see clicking it) and reading the
  // same embedded data. Capped and deduped so it only runs once per pin, a few at a time.
  const requestedPinIds = new Set();
  const pinResolveQueue = [];
  let pinResolveInFlight = 0;
  const MAX_PIN_RESOLVE_IN_FLIGHT = 3;

  function pumpPinResolve() {
    while (pinResolveInFlight < MAX_PIN_RESOLVE_IN_FLIGHT && pinResolveQueue.length) {
      const pinId = pinResolveQueue.shift();
      pinResolveInFlight++;
      safeSendMessage(
        { type: "realview-resolve-pinterest-pin", pinId, origin: location.origin },
        (res) => {
          pinResolveInFlight--;
          if (res && res.link) mergePinterestPinData({ [pinId]: { link: res.link } });
          pumpPinResolve();
        }
      );
    }
  }

  function requestPinResolve(pinId) {
    if (requestedPinIds.has(pinId)) return;
    requestedPinIds.add(pinId);
    pinResolveQueue.push(pinId);
    pumpPinResolve();
  }

  function scanImage(img) {
    if (!isActive()) return;
    if (processed.has(img)) return;
    const src = img.currentSrc || img.src;
    // Don't mark a still-lazy-loading image (data: URI placeholder, or no src yet) as
    // processed — it needs to be reconsidered once its real src actually arrives. Relying
    // solely on the MutationObserver's attribute-change handler to catch that swap isn't
    // reliable for every lazy-load implementation (e.g. Google Images), so leaving it
    // unmarked lets any later re-scan (any DOM mutation on the page triggers scanAll on
    // affected subtrees) pick it up once it has real content.
    if (!src || src.startsWith("data:")) return;
    processed.add(img);

    if (userFlaggedAi.has(src)) return applyVerdict(img, { verdict: "ai", reason: "You flagged this image as AI-generated" });
    if (userFlaggedReal.has(src)) return applyVerdict(img, { verdict: "real", reason: "You marked this image as a real photo" });

    const syncSource = resolveSyncSourceUrl(img);
    let domainVerdict = (syncSource && RealViewDetector.classifyByDomain(syncSource)) || RealViewDetector.classifyByDomain(src);

    if (!domainVerdict && isPinterest) {
      const pinId = getPinterestPinId(img);
      if (pinId && pinterestPinData[pinId]) {
        domainVerdict = RealViewDetector.classifyByDomain(pinterestPinData[pinId]);
      } else if (pinId) {
        if (!pendingPinImages.has(pinId)) pendingPinImages.set(pinId, new Set());
        pendingPinImages.get(pinId).add(img);
        requestPinResolve(pinId);
      }
    }

    if (domainVerdict) {
      applyVerdict(img, { ...domainVerdict, layer: "domainList" });
      return;
    }
    if (settings.deepScan) {
      img.classList.add("realview-scanning");
      queue.push({ img, src });
      pump();
    }
  }

  function scanAll(root) {
    root.querySelectorAll("img").forEach(scanImage);
  }

  document.addEventListener("click", (e) => {
    const img = e.target.closest("img.realview-ai-blurred");
    if (!img) return;
    e.preventDefault();
    e.stopPropagation();
    img.classList.toggle("realview-revealed");
  }, true);

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "attributes") {
        const img = m.target.tagName === "IMG" ? m.target : m.target.querySelector("img");
        if (img) { processed.delete(img); scanImage(img); }
        continue;
      }
      m.addedNodes.forEach((node) => {
        if (node.nodeType !== 1) return;
        if (node.tagName === "IMG") scanImage(node);
        else if (node.querySelectorAll) scanAll(node);
      });
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" && area !== "local") return;
    loadSettings(() => {
      refreshAll();
      applyUserFlags();
      // Reset dedup tracking before re-scanning — every image already on the page is in
      // `processed` from whatever pass ran under the OLD settings, so without this, scanImage()
      // would just no-op on all of them (line ~385) and a setting like turning on visual
      // detection would never actually apply to anything already loaded, only images added
      // afterward. A full page reload was the only thing that used to fix this, since that
      // starts with a genuinely fresh, empty `processed` set.
      processed = new WeakSet();
      scanAll(document);
    });
  });

  // Lets the popup show "N images here couldn't be checked" and nudge toward turning on
  // the visual model — a live DOM read, not tracked state, since it only needs to be
  // right at the moment someone opens the popup.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type !== "realview-get-page-stats") return;
    let ai = 0, real = 0, unresolved = 0, total = 0;
    document.querySelectorAll("img").forEach((img) => {
      const src = img.currentSrc || img.src;
      if (!src || src.startsWith("data:")) return;
      total++;
      if (img.dataset.realview === "ai") ai++;
      else if (img.dataset.realview === "real") real++;
      else unresolved++;
    });
    sendResponse({ total, ai, real, unresolved });
  });

  // Safety net for lazy-loaded images that never trigger a DOM mutation we'd catch (e.g. a
  // src attribute set only once, before insertion, with the browser's native `loading="lazy"`
  // simply deferring the fetch — no mutation ever fires). scanImage no longer marks a data:
  // URI placeholder as processed, so a scroll-triggered re-scan is cheap (a quick prefix check
  // per still-unresolved image) and picks these up once they've actually loaded.
  let scrollRescanTimer = null;
  window.addEventListener(
    "scroll",
    () => {
      clearTimeout(scrollRescanTimer);
      scrollRescanTimer = setTimeout(() => scanAll(document), 500);
    },
    { passive: true }
  );

  loadSettings(() => {
    if (isPinterest) seedPinterestFromInitialProps();
    scanAll(document);
    applyUserFlags();
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "data-lpage", "m"],
    });
  });

})();
