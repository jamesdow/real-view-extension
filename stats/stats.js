const DEFAULT_STATS = {
  statsInstalledAt: null,
  statsTotalScanned: 0,
  statsRealCount: 0,
  statsAiCount: 0,
  statsByDomain: {},
  statsByLayer: { metadata: 0, domainList: 0, visual: 0 },
  statsLongestRealStreak: 0,
};

const SHARE_URL = "https://userealview.com";
const MIN_DOMAIN_SAMPLE = 5; // hides noisy 1-2 image domains from the leaderboard
const MAX_DOMAIN_ROWS = 5;

function pluralize(n, word) {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}

function render(stats, corrections) {
  const total = stats.statsTotalScanned;
  const emptyState = document.getElementById("emptyState");
  const content = document.getElementById("statsContent");

  if (total <= 0) {
    emptyState.style.display = "";
    content.style.display = "none";
    return;
  }
  emptyState.style.display = "none";
  content.style.display = "";

  const aiPct = Math.round((stats.statsAiCount / total) * 100);
  const realPct = 100 - aiPct;

  const installedAt = stats.statsInstalledAt || Date.now();
  const days = Math.floor((Date.now() - installedAt) / 86400000);
  const dayLabel = days <= 0 ? "today" : `${pluralize(days, "day")} since install`;
  const rate = Math.round(total / Math.max(1, days));

  const installedDateStr = new Date(installedAt).toLocaleDateString(undefined, { month: "long", day: "numeric" });

  document.getElementById("eyebrow").textContent = days <= 0 ? `Installed ${installedDateStr}` : `${dayLabel} · ${installedDateStr}`;
  document.getElementById("headline").innerHTML = `<span class="pct">${aiPct}%</span> of what<br>you saw was AI.`;
  document.getElementById("heroSub").textContent = days <= 0
    ? "Every image Real View has checked today — and what it found."
    : `Every image Real View has checked in your first ${pluralize(days, "day")} — and what it found.`;

  document.getElementById("statTotal").textContent = total.toLocaleString();
  document.getElementById("statRate").textContent = days > 0 ? `~${rate}/day` : "";
  document.getElementById("statReal").textContent = stats.statsRealCount.toLocaleString();
  document.getElementById("statAi").textContent = stats.statsAiCount.toLocaleString();
  document.getElementById("statRealPct").textContent = `${realPct}%`;
  document.getElementById("statStreak").textContent = stats.statsLongestRealStreak.toLocaleString();
  document.getElementById("statCorrections").textContent = corrections.toLocaleString();

  // Domain leaderboard — only sites with enough samples to mean something, worst offenders first.
  const domainRows = document.getElementById("domainRows");
  const domainSection = document.getElementById("domainSection");
  const domains = Object.entries(stats.statsByDomain)
    .filter(([, d]) => d.total >= MIN_DOMAIN_SAMPLE)
    .map(([host, d]) => ({ host, pct: Math.round((d.ai / d.total) * 100) }))
    .sort((a, b) => b.pct - a.pct)
    .slice(0, MAX_DOMAIN_ROWS);

  if (!domains.length) {
    domainSection.style.display = "none";
  } else {
    domainSection.style.display = "";
    domainRows.innerHTML = domains
      .map(
        (d) => `
      <div class="domain-row">
        <span class="name">${d.host}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${d.pct}%"></div></div>
        <span class="pct tabular">${d.pct}%</span>
      </div>`
      )
      .join("");
  }

  // Detection-layer breakdown — shares of whatever's actually been recorded, not the raw counts.
  const layerBars = document.getElementById("layerBars");
  const layerSection = document.getElementById("layerSection");
  const layerTotal = stats.statsByLayer.metadata + stats.statsByLayer.domainList + stats.statsByLayer.visual;
  if (layerTotal <= 0) {
    layerSection.style.display = "none";
  } else {
    layerSection.style.display = "";
    const metaPct = Math.round((stats.statsByLayer.metadata / layerTotal) * 100);
    const domainPct = Math.round((stats.statsByLayer.domainList / layerTotal) * 100);
    const visualPct = Math.max(0, 100 - metaPct - domainPct);
    layerBars.innerHTML = `
      <div class="seg metadata tabular" style="flex:${metaPct || 0.001}">${metaPct}%</div>
      <div class="seg domain tabular" style="flex:${domainPct || 0.001}">${domainPct}%</div>
      <div class="seg visual tabular" style="flex:${visualPct || 0.001}">${visualPct}%</div>`;
  }

  // Share text — built from the real numbers above, not sample data.
  const shareText = `I've had Real View check ${total.toLocaleString()} images while I browsed — ${aiPct}% turned out to be AI. Flip one switch, see what's real:`;
  const fullText = `${shareText} ${SHARE_URL}`;
  document.getElementById("sharePreview").innerHTML = `${shareText} <span class="link">${SHARE_URL}</span>`;

  document.getElementById("shareX").href = "https://twitter.com/intent/tweet?text=" + encodeURIComponent(fullText);
  document.getElementById("shareBluesky").href = "https://bsky.app/intent/compose?text=" + encodeURIComponent(fullText);
  document.getElementById("shareReddit").href =
    "https://www.reddit.com/submit?url=" + encodeURIComponent(SHARE_URL) + "&title=" + encodeURIComponent(shareText);
  document.getElementById("shareLinkedin").href = "https://www.linkedin.com/sharing/share-offsite/?url=" + encodeURIComponent(SHARE_URL);
  document.getElementById("shareFacebook").href = "https://www.facebook.com/sharer/sharer.php?u=" + encodeURIComponent(SHARE_URL);

  const copyBtn = document.getElementById("shareCopy");
  copyBtn.onclick = () => {
    navigator.clipboard.writeText(fullText).then(() => {
      const original = copyBtn.textContent;
      copyBtn.textContent = "Copied!";
      setTimeout(() => { copyBtn.textContent = original; }, 1500);
    });
  };
}

function load() {
  chrome.storage.local.get(
    { ...DEFAULT_STATS, userFlaggedAi: [], userFlaggedReal: [] },
    (s) => {
      // Backfill for anyone who installed before this stats feature existed — treat "now" as
      // day zero for them rather than showing a broken/missing install date.
      if (!s.statsInstalledAt) {
        s.statsInstalledAt = Date.now();
        chrome.storage.local.set({ statsInstalledAt: s.statsInstalledAt });
      }
      render(s, s.userFlaggedAi.length + s.userFlaggedReal.length);
    }
  );
}

document.getElementById("resetBtn").addEventListener("click", () => {
  const confirmed = window.confirm("Reset all your Real View stats? This can't be undone — your settings and flagged images are unaffected.");
  if (!confirmed) return;
  chrome.storage.local.set(
    {
      statsInstalledAt: Date.now(),
      statsTotalScanned: 0,
      statsRealCount: 0,
      statsAiCount: 0,
      statsByDomain: {},
      statsByLayer: { metadata: 0, domainList: 0, visual: 0 },
      statsCurrentRealStreak: 0,
      statsLongestRealStreak: 0,
    },
    load
  );
});

load();
