// Recap Reel — Content Script
// Handles sentence-level transcript segmentation, nested tier clip selection,
// YouTube <video> playback driving, overlay UI, ad pausing, manual seek detection, and SPA navigation.

(() => {
  if (window.__recapReelInjected) return;
  window.__recapReelInjected = true;

  const PADDING_SEC = 0.5;
  const MERGE_GAP_SEC = 3.0;
  const MAX_SEGMENT_SEC = 24.0;
  const MIN_CLIP_SEC = 3.0;
  const SEEK_TOLERANCE_SEC = 1.6;

  let activeReel = null; // Holds state when a reel is playing
  let lastVideoId = getVideoIdFromUrl();
  let currentStatus = { phase: 'idle', detail: '' };

  function getVideoIdFromUrl(urlStr = location.href) {
    try {
      const u = new URL(urlStr);
      if (u.pathname === '/watch') {
        return u.searchParams.get('v') || null;
      }
      return null;
    } catch {
      return null;
    }
  }

  function getVideoElement() {
    return document.querySelector('#movie_player video.html5-main-video') || document.querySelector('video');
  }

  function getPlayerContainer() {
    return document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
  }

  function isAdPlaying() {
    const player = getPlayerContainer();
    if (!player) return false;
    return player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting');
  }

  function setStatus(phase, detail = '') {
    currentStatus = { phase, detail };
    chrome.runtime.sendMessage({
      type: 'REEL_STATUS',
      videoId: getVideoIdFromUrl(),
      phase,
      detail
    }).catch(() => {});
  }

  // Forward background status updates to local state
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;

    if (msg.type === 'GET_PAGE_INFO') {
      getPageInfo().then(sendResponse);
      return true;
    }

    if (msg.type === 'START_REEL') {
      startReelFlow(Number(msg.budgetSec), Boolean(msg.forceRefresh))
        .then(sendResponse)
        .catch((err) => {
          const errMsg = err && err.message ? err.message : String(err);
          setStatus('error', errMsg);
          sendResponse({ ok: false, error: errMsg });
        });
      return true;
    }

    if (msg.type === 'STOP_REEL') {
      stopReel('Exited Recap Reel');
      sendResponse({ ok: true });
      return true;
    }

    return false;
  });

  async function getPageInfo() {
    const videoId = getVideoIdFromUrl();
    if (!videoId) {
      return { isWatchPage: false };
    }
    const video = getVideoElement();
    let durationSec = video && Number.isFinite(video.duration) ? video.duration : 0;

    const cacheKey = `reel_cache_${videoId}`;
    const stored = await chrome.storage.local.get([cacheKey]);
    const hasCache = Boolean(stored[cacheKey] && stored[cacheKey].scores);

    return {
      isWatchPage: true,
      videoId,
      durationSec,
      hasCache,
      activeTier: activeReel ? activeReel.budgetSec : null,
      status: currentStatus
    };
  }

  /**
   * Step 2 & 3: Fetch English json3 transcript via MAIN world and merge into sentence-level segments
   * {id, start, end, text}
   */
  async function fetchAndSegmentTranscript(videoId) {
    setStatus('fetching', 'Fetching transcript…');
    const res = await chrome.runtime.sendMessage({
      type: 'FETCH_TRANSCRIPT_MAIN',
      expectedVideoId: videoId
    });

    if (!res || !res.ok) {
      throw new Error((res && res.error) || 'No English transcript found for this video.');
    }

    const segments = buildSentenceSegments(res.events, res.durationSec);
    if (segments.length === 0) {
      throw new Error('Transcript contains no usable spoken text.');
    }

    return {
      segments,
      durationSec: res.durationSec || (segments[segments.length - 1]?.end ?? 0),
      title: res.title
    };
  }

  /**
   * Converts raw YouTube json3 timedtext events into clean sentence-level segments:
   * { id, start, end, text }
   * Ensures every segment starts and ends at a natural boundary or pause so we never cut mid-sentence.
   */
  function buildSentenceSegments(events, videoDurationSec = 0) {
    // 1. Extract atomic pieces from json3 events
    const pieces = [];
    for (const ev of events) {
      if (!ev || !Array.isArray(ev.segs)) continue;
      const evStartSec = Number(ev.tStartMs || 0) / 1000;
      const evDurSec = Number(ev.dDurationMs || 3000) / 1000;
      const text = ev.segs
        .map((s) => (s && s.utf8 ? s.utf8 : ''))
        .join('')
        .replace(/\s+/g, ' ')
        .trim();

      if (!text || /^\[.*\]$/.test(text) || /^♪+$/.test(text)) continue;

      pieces.push({
        start: evStartSec,
        end: evStartSec + evDurSec,
        text
      });
    }

    if (pieces.length === 0) return [];

    // 2. Clamp overlapping end timestamps from caption display durations so piece[i].end <= piece[i+1].start
    for (let i = 0; i < pieces.length - 1; i++) {
      if (pieces[i].end > pieces[i + 1].start) {
        pieces[i].end = pieces[i + 1].start;
      }
      if (pieces[i].end <= pieces[i].start) {
        pieces[i].end = pieces[i].start + 0.5;
      }
    }

    // 3. Merge pieces into sentence-level segments
    const segments = [];
    let curStart = pieces[0].start;
    let curEnd = pieces[0].end;
    let curWords = [pieces[0].text];

    const flush = () => {
      const joined = curWords.join(' ').replace(/\s+/g, ' ').trim();
      if (joined) {
        const clampedEnd = videoDurationSec > 0 ? Math.min(curEnd, videoDurationSec) : curEnd;
        segments.push({
          id: segments.length + 1,
          start: Number(curStart.toFixed(2)),
          end: Number(Math.max(curStart + 0.8, clampedEnd).toFixed(2)),
          text: joined
        });
      }
    };

    for (let i = 1; i < pieces.length; i++) {
      const prev = pieces[i - 1];
      const p = pieces[i];
      const gap = p.start - prev.end;
      const curDuration = prev.end - curStart;
      const endsWithSentencePunct = /[.!?]["']?$/.test(prev.text);
      const endsWithClausePunct = /[,;:—–-]$/.test(prev.text);

      const shouldSplit =
        (endsWithSentencePunct && curDuration >= 2.5) ||
        gap >= 1.25 ||
        (curDuration >= 16 && (endsWithSentencePunct || endsWithClausePunct || gap >= 0.45)) ||
        curDuration >= MAX_SEGMENT_SEC;

      if (shouldSplit) {
        flush();
        curStart = p.start;
        curEnd = p.end;
        curWords = [p.text];
      } else {
        curEnd = p.end;
        curWords.push(p.text);
      }
    }
    flush();

    return segments;
  }

  /**
   * Step 5 & 6:
   * - Rank once (score desc, then chronological tie-breaker) so 2-min ⊂ 10-min ⊂ 30-min (nested tiers).
   * - Select by score until the time budget is filled.
   * - Snap clip start/end to sentence boundaries with 0.5s padding (clamped so adjacent unrelated sentences aren't clipped).
   * - Merge adjacent or near-adjacent segments (<3s gap) into one clip, then sort chronologically.
   */
  function buildReelClips(segments, scoresMap, budgetSec, videoDurationSec = 0) {
    const annotated = segments.map((seg, idx) => {
      const entry = scoresMap[seg.id] || scoresMap[String(seg.id)] || { s: 3 };
      const score = Number(entry.s) || 3;
      const label = entry.l ? String(entry.l).trim() : '';
      const prevEnd = idx > 0 ? segments[idx - 1].end : 0;
      const nextStart =
        idx < segments.length - 1
          ? segments[idx + 1].start
          : videoDurationSec > 0
          ? videoDurationSec
          : seg.end + PADDING_SEC;

      // Apply 0.5s padding around sentence boundaries, clamped safely
      const paddedStart = Math.max(0, Math.max(prevEnd - 0.1, seg.start - PADDING_SEC));
      const paddedEnd = Math.min(
        videoDurationSec > 0 ? videoDurationSec : Infinity,
        Math.min(nextStart + 0.1, seg.end + PADDING_SEC)
      );

      return {
        ...seg,
        score,
        label,
        paddedStart: Number(paddedStart.toFixed(2)),
        paddedEnd: Number(Math.max(paddedStart + 1.0, paddedEnd).toFixed(2))
      };
    });

    // Global deterministic ranking: highest score first; tie-break by earlier timestamp
    const ranked = [...annotated].sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.start - b.start;
    });

    // Greedily fill the tier budget (guarantees 2m ⊂ 10m ⊂ 30m because ranked order is identical)
    const selected = [];
    let accumulatedSec = 0;

    for (const seg of ranked) {
      const segDur = Math.max(1, seg.paddedEnd - seg.paddedStart);
      if (selected.length === 0 || accumulatedSec + segDur <= budgetSec * 1.08) {
        selected.push(seg);
        accumulatedSec += segDur;
      }
      if (accumulatedSec >= budgetSec) break;
    }

    // Sort selected segments chronologically
    selected.sort((a, b) => a.paddedStart - b.paddedStart);

    // Merge adjacent or near-adjacent segments (<3s gap) into a single seamless clip
    const mergedClips = [];
    for (const seg of selected) {
      const last = mergedClips[mergedClips.length - 1];
      if (last && seg.paddedStart - last.end < MERGE_GAP_SEC) {
        last.end = Math.max(last.end, seg.paddedEnd);
        last.segmentIds.push(seg.id);
        if (seg.score > last.bestScore || (!last.label && seg.label)) {
          if (seg.label) last.label = seg.label;
          if (seg.score > last.bestScore) {
            last.bestScore = seg.score;
            last.primaryText = seg.text;
          }
        }
      } else {
        mergedClips.push({
          start: seg.paddedStart,
          end: Math.max(seg.paddedStart + MIN_CLIP_SEC, seg.paddedEnd),
          bestScore: seg.score,
          label: seg.label || '',
          primaryText: seg.text,
          segmentIds: [seg.id]
        });
      }
    }

    // Ensure every clip has a clean 6-10 word label even if fallback <7 was included to fill budget
    for (const clip of mergedClips) {
      if (!clip.label) {
        const words = clip.primaryText
          .replace(/[^\w\s'-]/g, '')
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 8);
        clip.label = words.join(' ') + (words.length >= 8 ? '…' : '');
      }
    }

    return mergedClips;
  }

  async function startReelFlow(budgetSec, forceRefresh = false) {
    const videoId = getVideoIdFromUrl();
    if (!videoId) {
      throw new Error('Please open a YouTube watch page first.');
    }

    const video = getVideoElement();
    if (!video) {
      throw new Error('Could not find the YouTube video player on this page.');
    }

    // Stop any existing reel before building new one
    if (activeReel) {
      teardownActiveReel();
    }

    // Open keep-alive port so service worker stays awake while scoring
    const keepAlivePort = chrome.runtime.connect({ name: 'recap-reel-keepalive' });
    const pingTimer = setInterval(() => {
      try {
        keepAlivePort.postMessage({ type: 'PING' });
      } catch {
        clearInterval(pingTimer);
      }
    }, 15000);

    try {
      const { segments, durationSec } = await fetchAndSegmentTranscript(videoId);

      setStatus('ranking', 'Ranking moments…');
      const scoreRes = await chrome.runtime.sendMessage({
        type: 'SCORE_VIDEO',
        videoId,
        segments,
        forceRefresh
      });

      if (!scoreRes || !scoreRes.ok) {
        throw new Error((scoreRes && scoreRes.error) || 'Failed to rank transcript moments.');
      }

      // Verify user didn't navigate away while waiting
      if (getVideoIdFromUrl() !== videoId) {
        return { ok: false, error: 'Navigation occurred during ranking.' };
      }

      const clips = buildReelClips(segments, scoreRes.scores, budgetSec, durationSec);
      if (clips.length === 0) {
        throw new Error('No highlight clips could be generated for this video.');
      }

      launchPlayback(videoId, budgetSec, clips);
      setStatus('playing', `Playing ${Math.round(budgetSec / 60)} min Recap Reel (${clips.length} clips)`);

      return {
        ok: true,
        cached: Boolean(scoreRes.cached),
        clipCount: clips.length,
        totalDurationSec: Math.round(clips.reduce((acc, c) => acc + (c.end - c.start), 0))
      };
    } finally {
      clearInterval(pingTimer);
      try {
        keepAlivePort.disconnect();
      } catch {}
    }
  }

  /**
   * Drives the page's <video> element and renders the overlay inside #movie_player
   */
  function launchPlayback(videoId, budgetSec, clips) {
    const video = getVideoElement();
    const playerContainer = getPlayerContainer();
    if (!video || !playerContainer) {
      throw new Error('YouTube video player not found.');
    }

    const state = {
      videoId,
      budgetSec,
      clips,
      currentIndex: 0,
      video,
      playerContainer,
      expectedSeekTarget: null,
      expectedSeekUntil: 0,
      pausedForAd: false,
      overlayEl: null,
      onTimeUpdate: null,
      onSeeking: null
    };

    activeReel = state;

    // Build Overlay DOM
    const overlay = createOverlayDom(state);
    state.overlayEl = overlay;
    playerContainer.appendChild(overlay);

    state.onTimeUpdate = () => {
      if (activeReel !== state) return;

      // Pause reel transitions while an ad is playing
      if (isAdPlaying()) {
        state.pausedForAd = true;
        overlay.classList.add('rr-ad-hidden');
        return;
      }

      if (state.pausedForAd) {
        state.pausedForAd = false;
        overlay.classList.remove('rr-ad-hidden');
        // Re-seek to current clip start if the ad reset currentTime
        const curClip = state.clips[state.currentIndex];
        if (curClip && (video.currentTime < curClip.start - 1 || video.currentTime > curClip.end + 1)) {
          seekToClip(state, state.currentIndex);
          return;
        }
      }

      const clip = state.clips[state.currentIndex];
      if (!clip) return;

      updateOverlayProgress(state);

      if (video.currentTime >= clip.end - 0.2) {
        if (state.currentIndex < state.clips.length - 1) {
          seekToClip(state, state.currentIndex + 1);
        } else {
          // End of the last clip
          video.pause();
          showToast('Recap Reel finished');
          teardownActiveReel();
          setStatus('idle', 'Recap Reel finished');
        }
      }
    };

    state.onSeeking = () => {
      if (activeReel !== state) return;
      if (isAdPlaying()) return;

      const now = performance.now();
      if (
        state.expectedSeekTarget !== null &&
        now <= state.expectedSeekUntil &&
        Math.abs(video.currentTime - state.expectedSeekTarget) <= SEEK_TOLERANCE_SEC
      ) {
        return; // Programmatic seek initiated by Recap Reel
      }

      // User manually dragged the scrubber -> exit reel mode gracefully
      stopReel('Reel ended — you took control');
    };

    video.addEventListener('timeupdate', state.onTimeUpdate);
    video.addEventListener('seeking', state.onSeeking);

    // Start at Clip 1
    seekToClip(state, 0);
    video.play().catch(() => {});
  }

  function seekToClip(state, index) {
    if (!state || index < 0 || index >= state.clips.length) return;
    state.currentIndex = index;
    const clip = state.clips[index];
    state.expectedSeekTarget = clip.start;
    state.expectedSeekUntil = performance.now() + 1800;
    state.video.currentTime = clip.start;
    if (state.video.paused) {
      state.video.play().catch(() => {});
    }
    updateOverlayUI(state);
  }

  function formatTime(sec) {
    const s = Math.max(0, Math.floor(sec));
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const rem = s % 60;
    if (hrs > 0) {
      return `${hrs}:${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
    }
    return `${mins}:${String(rem).padStart(2, '0')}`;
  }

  function createOverlayDom(state) {
    const existing = document.getElementById('recap-reel-overlay');
    if (existing) existing.remove();

    const wrap = document.createElement('div');
    wrap.id = 'recap-reel-overlay';
    wrap.className = 'rr-overlay';

    // Stop clicks on overlay from toggling YouTube play/pause underneath
    wrap.addEventListener('click', (e) => e.stopPropagation());
    wrap.addEventListener('dblclick', (e) => e.stopPropagation());

    const totalReelSec = state.clips.reduce((acc, c) => acc + (c.end - c.start), 0);

    // Segmented progress bar
    const bar = document.createElement('div');
    bar.className = 'rr-segments-bar';

    state.clips.forEach((clip, idx) => {
      const dur = Math.max(1, clip.end - clip.start);
      const segEl = document.createElement('button');
      segEl.type = 'button';
      segEl.className = 'rr-seg-block';
      segEl.style.flexGrow = String(dur.toFixed(1));
      segEl.title = `Clip ${idx + 1} (${formatTime(clip.start)}): ${clip.label}`;

      const fill = document.createElement('div');
      fill.className = 'rr-seg-fill';
      segEl.appendChild(fill);

      segEl.addEventListener('click', (e) => {
        e.stopPropagation();
        seekToClip(state, idx);
      });

      bar.appendChild(segEl);
    });

    // Main row: badge + clip counter + label + controls
    const row = document.createElement('div');
    row.className = 'rr-main-row';

    const left = document.createElement('div');
    left.className = 'rr-left';

    const badge = document.createElement('span');
    badge.className = 'rr-badge';
    badge.textContent = `RECAP • ${Math.round(totalReelSec / 60) || 1}M`;

    const counter = document.createElement('span');
    counter.className = 'rr-counter';

    const label = document.createElement('span');
    label.className = 'rr-label';

    left.appendChild(badge);
    left.appendChild(counter);
    left.appendChild(label);

    const actions = document.createElement('div');
    actions.className = 'rr-actions';

    const skipBtn = document.createElement('button');
    skipBtn.type = 'button';
    skipBtn.className = 'rr-btn';
    skipBtn.textContent = 'Skip clip ⏭';
    skipBtn.addEventListener('click', () => {
      if (state.currentIndex < state.clips.length - 1) {
        seekToClip(state, state.currentIndex + 1);
      } else {
        stopReel('Recap Reel finished');
      }
    });

    const watchFullBtn = document.createElement('button');
    watchFullBtn.type = 'button';
    watchFullBtn.className = 'rr-btn rr-btn-accent';
    watchFullBtn.textContent = 'Watch this part fully';
    watchFullBtn.addEventListener('click', () => {
      stopReel('Continuing full video from here');
    });

    const exitBtn = document.createElement('button');
    exitBtn.type = 'button';
    exitBtn.className = 'rr-btn rr-btn-ghost';
    exitBtn.textContent = '✕';
    exitBtn.title = 'Exit Recap Reel';
    exitBtn.addEventListener('click', () => {
      stopReel('Exited Recap Reel');
    });

    actions.appendChild(skipBtn);
    actions.appendChild(watchFullBtn);
    actions.appendChild(exitBtn);

    row.appendChild(left);
    row.appendChild(actions);

    wrap.appendChild(bar);
    wrap.appendChild(row);

    return wrap;
  }

  function updateOverlayUI(state) {
    if (!state || !state.overlayEl) return;
    const clip = state.clips[state.currentIndex];
    if (!clip) return;

    const counterEl = state.overlayEl.querySelector('.rr-counter');
    const labelEl = state.overlayEl.querySelector('.rr-label');

    if (counterEl) {
      counterEl.textContent = `${state.currentIndex + 1}/${state.clips.length} (${formatTime(clip.start)})`;
    }
    if (labelEl) {
      labelEl.textContent = clip.label;
    }

    const blocks = state.overlayEl.querySelectorAll('.rr-seg-block');
    blocks.forEach((b, idx) => {
      b.classList.toggle('rr-seg-active', idx === state.currentIndex);
      b.classList.toggle('rr-seg-done', idx < state.currentIndex);
      const fill = b.querySelector('.rr-seg-fill');
      if (fill) {
        if (idx < state.currentIndex) {
          fill.style.width = '100%';
        } else if (idx > state.currentIndex) {
          fill.style.width = '0%';
        }
      }
    });

    updateOverlayProgress(state);
  }

  function updateOverlayProgress(state) {
    if (!state || !state.overlayEl) return;
    const clip = state.clips[state.currentIndex];
    if (!clip) return;
    const blocks = state.overlayEl.querySelectorAll('.rr-seg-block');
    const activeBlock = blocks[state.currentIndex];
    if (!activeBlock) return;
    const fill = activeBlock.querySelector('.rr-seg-fill');
    if (!fill) return;

    const dur = Math.max(0.5, clip.end - clip.start);
    const pct = Math.max(0, Math.min(100, ((state.video.currentTime - clip.start) / dur) * 100));
    fill.style.width = `${pct.toFixed(1)}%`;
  }

  function teardownActiveReel() {
    if (!activeReel) return;
    const { video, onTimeUpdate, onSeeking, overlayEl } = activeReel;
    if (video && onTimeUpdate) video.removeEventListener('timeupdate', onTimeUpdate);
    if (video && onSeeking) video.removeEventListener('seeking', onSeeking);
    if (overlayEl && overlayEl.parentNode) overlayEl.remove();
    activeReel = null;
  }

  function stopReel(toastMessage = '') {
    teardownActiveReel();
    setStatus('idle', '');
    if (toastMessage) {
      showToast(toastMessage);
    }
  }

  function showToast(text) {
    const container = getPlayerContainer();
    if (!container) return;

    const existing = container.querySelector('.rr-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'rr-toast';
    toast.textContent = text;
    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('rr-toast-hide');
      setTimeout(() => toast.remove(), 350);
    }, 2400);
  }

  // Handle YouTube's SPA navigation (yt-navigate-finish)
  window.addEventListener('yt-navigate-finish', () => {
    const newId = getVideoIdFromUrl();
    if (activeReel && newId !== activeReel.videoId) {
      teardownActiveReel();
      setStatus('idle', '');
    }
    lastVideoId = newId;
  });
})();
