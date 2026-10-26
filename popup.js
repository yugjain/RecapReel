// Recap Reel — Popup Script
// Handles duration gating (disable 30m if <45m, disable 10m if <20m),
// inline Gemini API key saving, live status updates, and triggering/re-ranking reels.

const btn2 = document.getElementById('btn2');
const btn10 = document.getElementById('btn10');
const btn30 = document.getElementById('btn30');
const sub10 = document.getElementById('sub10');
const sub30 = document.getElementById('sub30');
const videoMeta = document.getElementById('videoMeta');
const statusBox = document.getElementById('statusBox');
const statusText = document.getElementById('statusText');
const rerankBtn = document.getElementById('rerankBtn');
const apiKeyInput = document.getElementById('apiKeyInput');
const saveKeyBtn = document.getElementById('saveKeyBtn');

const DEFAULT_API_KEY = '';

let currentTabId = null;
let currentVideoId = null;
let lastSelectedBudget = 120;
let isBusy = false;

function setStatusUI(phase, text, showRerank = false) {
  statusBox.classList.remove('error', 'playing');
  if (phase === 'error') statusBox.classList.add('error');
  if (phase === 'playing') statusBox.classList.add('playing');
  statusText.textContent = text;
  rerankBtn.style.display = showRerank ? 'inline' : 'none';
}

function applyDurationGates(durationSec) {
  if (!durationSec || durationSec <= 0) {
    videoMeta.textContent = '';
    return;
  }
  const mins = Math.round(durationSec / 60);
  videoMeta.textContent = `${mins} min video`;

  // Disable 10 min if video is under 20 min (1200s)
  if (durationSec < 1200) {
    btn10.disabled = true;
    sub10.textContent = 'Needs 20m+';
  } else {
    btn10.disabled = false;
    sub10.textContent = 'Deep dive';
  }

  // Disable 30 min if video is under 45 min (2700s)
  if (durationSec < 2700) {
    btn30.disabled = true;
    sub30.textContent = 'Needs 45m+';
  } else {
    btn30.disabled = false;
    sub30.textContent = 'Full synthesis';
  }
}

function highlightActiveTier(budgetSec) {
  [btn2, btn10, btn30].forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.budget) === Number(budgetSec));
  });
}

// Listen for real-time progress messages from content/background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'REEL_STATUS') {
    if (currentVideoId && msg.videoId && msg.videoId !== currentVideoId) return;
    if (msg.detail) {
      setStatusUI(msg.phase, msg.detail, msg.phase === 'playing' || msg.phase === 'cached');
    }
  }
});

async function initPopup() {
  // Load saved API key, defaulting to tested key if none is stored
  const stored = await chrome.storage.local.get(['geminiApiKey']);
  const effectiveKey = stored.geminiApiKey || DEFAULT_API_KEY;
  apiKeyInput.value = effectiveKey;
  if (!stored.geminiApiKey && DEFAULT_API_KEY) {
    await chrome.storage.local.set({ geminiApiKey: DEFAULT_API_KEY });
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.includes('youtube.com/watch')) {
    btn2.disabled = true;
    btn10.disabled = true;
    btn30.disabled = true;
    setStatusUI('error', 'Open a youtube.com/watch video first.');
    return;
  }

  currentTabId = tab.id;

  try {
    const info = await chrome.tabs.sendMessage(currentTabId, { type: 'GET_PAGE_INFO' });
    if (!info || !info.isWatchPage) {
      btn2.disabled = true;
      btn10.disabled = true;
      btn30.disabled = true;
      setStatusUI('error', 'Open a YouTube watch page first.');
      return;
    }

    currentVideoId = info.videoId;
    applyDurationGates(info.durationSec);

    if (info.activeTier) {
      lastSelectedBudget = info.activeTier;
      highlightActiveTier(info.activeTier);
    }

    if (info.status && info.status.detail) {
      setStatusUI(info.status.phase, info.status.detail, info.hasCache);
    } else if (info.hasCache) {
      setStatusUI('cached', 'Cached scores ready — instant playback.', true);
    }
  } catch {
    setStatusUI('error', 'Refresh the YouTube tab once to activate Recap Reel.');
  }
}

async function triggerTier(budgetSec, forceRefresh = false) {
  if (!currentTabId || isBusy) return;
  lastSelectedBudget = budgetSec;

  const keyVal = apiKeyInput.value.trim();
  if (!keyVal) {
    setStatusUI('error', 'Enter and save your Gemini API key below first.');
    apiKeyInput.focus();
    return;
  }
  await chrome.storage.local.set({ geminiApiKey: keyVal });

  isBusy = true;
  highlightActiveTier(budgetSec);
  setStatusUI('fetching', 'Fetching transcript…', false);

  try {
    const res = await chrome.tabs.sendMessage(currentTabId, {
      type: 'START_REEL',
      budgetSec,
      forceRefresh
    });

    if (!res || !res.ok) {
      setStatusUI('error', (res && res.error) || 'Failed to start Recap Reel.');
    } else {
      const mins = Math.max(1, Math.round(res.totalDurationSec / 60));
      const cacheTag = res.cached ? ' (cached)' : '';
      setStatusUI('playing', `Playing ${res.clipCount} clips (~${mins}m)${cacheTag}`, true);
    }
  } catch (err) {
    setStatusUI('error', err.message || 'Could not reach YouTube tab. Try refreshing the page.');
  } finally {
    isBusy = false;
  }
}

[btn2, btn10, btn30].forEach((btn) => {
  btn.addEventListener('click', () => {
    triggerTier(Number(btn.dataset.budget), false);
  });
});

rerankBtn.addEventListener('click', async () => {
  if (!currentVideoId || isBusy) return;
  await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE', videoId: currentVideoId });
  triggerTier(lastSelectedBudget, true);
});

saveKeyBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    setStatusUI('error', 'Please enter a valid Gemini API key.');
    return;
  }
  saveKeyBtn.disabled = true;
  saveKeyBtn.textContent = 'Checking…';
  await chrome.storage.local.set({ geminiApiKey: key });

  const res = await chrome.runtime.sendMessage({ type: 'TEST_API_KEY', apiKey: key });
  saveKeyBtn.disabled = false;
  saveKeyBtn.textContent = 'Save';

  if (res && res.ok) {
    setStatusUI('playing', 'API key verified and saved.');
  } else {
    setStatusUI('error', (res && res.error) || 'API key verification failed.');
  }
});

initPopup();
