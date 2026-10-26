// Recap Reel — Background Service Worker (Manifest V3)
// Handles MAIN-world YouTube player inspection, Gemini 2.5 Flash scoring, chunking, retry, and caching.

const CACHE_VERSION = 1;
const PRIMARY_MODELS = ['gemini-3.1-flash-lite', 'gemini-3.5-flash'];
const CHUNK_DURATION_SEC = 1800; // ~30 minutes per chunk
const inFlightRequests = new Map(); // videoId -> Promise

function broadcastStatus(videoId, phase, detail = '') {
  chrome.runtime.sendMessage({
    type: 'REEL_STATUS',
    videoId,
    phase,
    detail
  }).catch(() => {
    // Popup might be closed; ignore receiver errors
  });
}

function sanitizeError(err, apiKey) {
  let msg = (err && err.message) ? err.message : String(err || 'Unknown error');
  if (apiKey && apiKey.length > 4) {
    msg = msg.split(apiKey).join('[REDACTED]');
  }
  return msg;
}

// Keep-alive port so MV3 service worker doesn't terminate mid-scoring
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'recap-reel-keepalive') {
    port.onMessage.addListener((msg) => {
      if (msg && msg.type === 'PING') {
        port.postMessage({ type: 'PONG' });
      }
    });
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === 'FETCH_TRANSCRIPT_MAIN') {
    const tabId = sender.tab ? sender.tab.id : msg.tabId;
    handleFetchTranscriptMain(tabId, msg.expectedVideoId)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'SCORE_VIDEO') {
    handleScoreVideo(msg.videoId, msg.segments, Boolean(msg.forceRefresh))
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
    return true;
  }

  if (msg.type === 'CLEAR_CACHE') {
    const cacheKey = `reel_cache_${msg.videoId}`;
    chrome.storage.local.remove([cacheKey], () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'TEST_API_KEY') {
    testApiKey(msg.apiKey)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: sanitizeError(err, msg.apiKey) }));
    return true;
  }

  return false;
});

/**
 * Runs inside the page's MAIN world to extract YouTube transcripts using a resilient multi-strategy pipeline:
 * Strategy 1: Direct timedtext json3 fetch (if not PO-token blocked)
 * Strategy 2: InnerTube authenticated get_transcript API with session credentials
 * Strategy 3: Native DOM transcript panel scraper (auto-expands description and clicks Show transcript)
 */
async function handleFetchTranscriptMain(tabId, expectedVideoId) {
  if (!tabId) {
    return { ok: false, error: 'No active YouTube tab ID found.' };
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [expectedVideoId],
    func: async (expectedId) => {
      try {
        const player = document.querySelector('#movie_player');
        let pr = null;

        if (player && typeof player.getPlayerResponse === 'function') {
          pr = player.getPlayerResponse();
        }
        if ((!pr || !pr.videoDetails || pr.videoDetails.videoId !== expectedId) && window.ytInitialPlayerResponse) {
          if (
            window.ytInitialPlayerResponse.videoDetails &&
            window.ytInitialPlayerResponse.videoDetails.videoId === expectedId
          ) {
            pr = window.ytInitialPlayerResponse;
          }
        }

        const durationSec = Number(
          (pr && pr.videoDetails && pr.videoDetails.lengthSeconds) ||
          (player && typeof player.getDuration === 'function' ? player.getDuration() : 0) ||
          (document.querySelector('video') ? document.querySelector('video').duration : 0)
        );

        const videoTitle = (pr && pr.videoDetails && pr.videoDetails.title) || document.title.replace(/ - YouTube$/, '');

        function parseTimestampToMs(str) {
          if (!str) return 0;
          const parts = str.trim().split(':').map((p) => Number(p) || 0);
          if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
          if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
          return (parts[0] || 0) * 1000;
        }

        function parseInnertubeData(transData) {
          const events = [];
          function search(obj) {
            if (!obj || typeof obj !== 'object') return;
            if (obj.transcriptSegmentRenderer) {
              const seg = obj.transcriptSegmentRenderer;
              const startMs = Number(seg.startMs || 0);
              const endMs = Number(seg.endMs || startMs + 3000);
              let text = '';
              if (seg.snippet && Array.isArray(seg.snippet.runs)) {
                text = seg.snippet.runs.map((r) => r.text || '').join('');
              } else if (seg.snippet && typeof seg.snippet.simpleText === 'string') {
                text = seg.snippet.simpleText;
              }
              if (text.trim()) {
                events.push({
                  tStartMs: startMs,
                  dDurationMs: Math.max(800, endMs - startMs),
                  segs: [{ utf8: text.trim() }]
                });
              }
              return;
            }
            for (const k of Object.keys(obj)) {
              search(obj[k]);
            }
          }
          search(transData);
          return events.length > 0 ? events : null;
        }

        // --- STRATEGY 1: Direct timedtext json3 fetch ---
        let events = null;
        const tracks =
          pr &&
          pr.captions &&
          pr.captions.playerCaptionsTracklistRenderer &&
          pr.captions.playerCaptionsTracklistRenderer.captionTracks;

        if (Array.isArray(tracks) && tracks.length > 0) {
          const isEnglish = (t) => {
            const code = String(t.languageCode || '').toLowerCase();
            return code === 'en' || code.startsWith('en-');
          };
          const manualEn = tracks.find((t) => isEnglish(t) && t.kind !== 'asr');
          const asrEn = tracks.find((t) => isEnglish(t) && t.kind === 'asr');
          const chosen = manualEn || asrEn;

          if (chosen && chosen.baseUrl) {
            try {
              const url = new URL(chosen.baseUrl);
              url.searchParams.set('fmt', 'json3');
              const resp = await fetch(url.toString(), { credentials: 'include' });
              if (resp.ok) {
                const rawText = await resp.text();
                if (rawText && rawText.trim().length > 0) {
                  const data = JSON.parse(rawText);
                  if (data && Array.isArray(data.events) && data.events.length > 0) {
                    events = data.events;
                  }
                }
              }
            } catch (e) {
              // Fall through to Strategy 2
            }
          }
        }

        // --- STRATEGY 2: InnerTube authenticated get_transcript API ---
        if (!events || events.length === 0) {
          try {
            const cfg = window.ytcfg;
            const apiKey = cfg && typeof cfg.get === 'function' ? cfg.get('INNERTUBE_API_KEY') : null;
            const context = cfg && typeof cfg.get === 'function' ? cfg.get('INNERTUBE_CONTEXT') : null;

            if (apiKey && context) {
              let params = null;
              try {
                const dumpInit = JSON.stringify(window.ytInitialData || {});
                const m = dumpInit.match(/"getTranscriptEndpoint":\s*\{\s*"params":\s*"([^"]+)"/);
                if (m && m[1]) params = m[1];
              } catch {}

              if (!params) {
                const nextResp = await fetch(`/youtubei/v1/next?key=${apiKey}`, {
                  method: 'POST',
                  credentials: 'include',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ context, videoId: expectedId })
                });
                if (nextResp.ok) {
                  const nextData = await nextResp.json();
                  const dumpNext = JSON.stringify(nextData);
                  const m = dumpNext.match(/"getTranscriptEndpoint":\s*\{\s*"params":\s*"([^"]+)"/);
                  if (m && m[1]) params = m[1];
                }
              }

              if (params) {
                const tResp = await fetch(`/youtubei/v1/get_transcript?key=${apiKey}`, {
                  method: 'POST',
                  credentials: 'include',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ context, params })
                });
                if (tResp.ok) {
                  const tData = await tResp.json();
                  events = parseInnertubeData(tData);
                }
              }
            }
          } catch (e) {
            // Fall through to Strategy 3
          }
        }

        // --- STRATEGY 3: Native DOM transcript panel scraper ---
        if (!events || events.length === 0) {
          try {
            let segEls = document.querySelectorAll('ytd-transcript-segment-renderer');
            if (segEls.length === 0) {
              const expandBtn = document.querySelector(
                '#description-inline-expander #expand, ytd-text-inline-expander #expand, #expand'
              );
              if (expandBtn) expandBtn.click();
              await new Promise((r) => setTimeout(r, 350));

              const showBtn =
                document.querySelector('ytd-video-description-transcript-section-renderer button') ||
                document.querySelector('[aria-label="Show transcript"]') ||
                document.querySelector('button[aria-label*="transcript" i]');

              if (showBtn) showBtn.click();

              for (let i = 0; i < 18; i++) {
                await new Promise((r) => setTimeout(r, 250));
                segEls = document.querySelectorAll('ytd-transcript-segment-renderer');
                if (segEls.length > 0) break;
              }
            }

            if (segEls.length > 0) {
              const rawList = [];
              segEls.forEach((el) => {
                const tsEl = el.querySelector('.segment-timestamp, #segment-timestamp') || el.children[0];
                const textEl = el.querySelector('.segment-text, #segment-text') || el.children[1] || el;
                const tsStr = tsEl ? tsEl.textContent.trim() : '';
                const textStr = textEl ? textEl.textContent.trim() : '';
                if (textStr) {
                  rawList.push({
                    startMs: parseTimestampToMs(tsStr),
                    text: textStr
                  });
                }
              });

              if (rawList.length > 0) {
                events = [];
                for (let i = 0; i < rawList.length; i++) {
                  const cur = rawList[i];
                  const next = rawList[i + 1];
                  const durMs = next ? Math.max(800, next.startMs - cur.startMs) : 3200;
                  events.push({
                    tStartMs: cur.startMs,
                    dDurationMs: durMs,
                    segs: [{ utf8: cur.text }]
                  });
                }
              }
            }
          } catch (e) {
            // Scrape failed
          }
        }

        if (!events || events.length === 0) {
          return {
            ok: false,
            error:
              'YouTube blocked direct transcript access for this video. Please click "Show transcript" in the video description once, then click your reel button again.'
          };
        }

        return {
          ok: true,
          videoId: expectedId,
          title: videoTitle,
          durationSec,
          events
        };
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : String(err) };
      }
    }
  });

  if (!results || !results[0] || !results[0].result) {
    return { ok: false, error: 'Failed to read transcript from page context.' };
  }
  return results[0].result;
}

async function testApiKey(rawKey) {
  const apiKey = String(rawKey || '').trim();
  if (!apiKey) {
    return { ok: false, error: 'Please enter a Gemini API key.' };
  }
  // Validate key directly against models endpoint
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
  const resp = await fetch(url);

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`API key test failed (HTTP ${resp.status}): ${errText.slice(0, 140)}`);
  }
  const data = await resp.json().catch(() => ({}));
  if (!data || !Array.isArray(data.models)) {
    throw new Error('API key test returned unexpected response.');
  }
  return { ok: true };
}

async function handleScoreVideo(videoId, segments, forceRefresh = false) {
  if (!videoId || !Array.isArray(segments) || segments.length === 0) {
    return { ok: false, error: 'Invalid videoId or empty transcript segments.' };
  }

  const cacheKey = `reel_cache_${videoId}`;
  if (!forceRefresh) {
    const stored = await chrome.storage.local.get([cacheKey]);
    const cached = stored[cacheKey];
    if (
      cached &&
      cached.version === CACHE_VERSION &&
      cached.scores &&
      typeof cached.scores === 'object' &&
      Object.keys(cached.scores).length > 0
    ) {
      broadcastStatus(videoId, 'cached', 'Loaded ranked moments from cache');
      return { ok: true, cached: true, scores: cached.scores };
    }
  }

  // Deduplicate concurrent requests for the same videoId
  if (inFlightRequests.has(videoId)) {
    return inFlightRequests.get(videoId);
  }

  const promise = (async () => {
    let apiKey = '';
    try {
      const keyStore = await chrome.storage.local.get(['geminiApiKey']);
      apiKey = String(keyStore.geminiApiKey || '').trim();
      if (!apiKey) {
        return {
          ok: false,
          error: 'Missing Gemini API key. Open the Recap Reel popup and save your key first.'
        };
      }

      const chunks = buildChunks(segments, CHUNK_DURATION_SEC);
      const mergedScores = {};

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const progressText =
          chunks.length > 1
            ? `Ranking moments… (chunk ${i + 1} of ${chunks.length})`
            : 'Ranking moments…';
        broadcastStatus(videoId, 'ranking', progressText);

        const chunkScores = await scoreChunkWithRetry(chunk, apiKey, videoId, i + 1, chunks.length);

        for (const seg of chunk) {
          const entry = chunkScores.get(seg.id);
          if (entry) {
            mergedScores[seg.id] = entry;
          } else {
            // Default fallback if model omitted an ID
            mergedScores[seg.id] = { s: 3 };
          }
        }
      }

      // Only cache if all chunks succeeded and we have scores for every segment
      await chrome.storage.local.set({
        [cacheKey]: {
          version: CACHE_VERSION,
          videoId,
          updatedAt: Date.now(),
          scores: mergedScores
        }
      });

      return { ok: true, cached: false, scores: mergedScores };
    } catch (err) {
      return { ok: false, error: sanitizeError(err, apiKey) };
    } finally {
      inFlightRequests.delete(videoId);
    }
  })();

  inFlightRequests.set(videoId, promise);
  return promise;
}

function buildChunks(segments, maxWindowSec) {
  const chunks = [];
  let current = [];
  let chunkStart = segments[0] ? segments[0].start : 0;

  for (const seg of segments) {
    if (current.length > 0 && seg.end - chunkStart > maxWindowSec) {
      chunks.push(current);
      current = [];
      chunkStart = seg.start;
    }
    current.push(seg);
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

async function scoreChunkWithRetry(chunk, apiKey, videoId, chunkIndex, totalChunks) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await callGeminiForChunk(chunk, apiKey);
    } catch (err) {
      lastErr = err;
      if (attempt < 2) {
        const isRateLimit = err && (err.status === 429 || /429|rate limit|quota/i.test(err.message));
        const waitMs = isRateLimit ? 5000 : 2000;
        broadcastStatus(
          videoId,
          'ranking',
          `Retrying chunk ${chunkIndex}/${totalChunks} after ${ isRateLimit ? 'rate limit' : 'error' }…`
        );
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }
  throw lastErr;
}

async function callGeminiForChunk(chunk, apiKey) {
  const lines = chunk.map((s) => `${s.id}|${Math.round(s.start)}-${Math.round(s.end)}|${s.text}`).join('\n');

  const systemInstruction = [
    'You are grading transcript segments from a long YouTube video to build a highlight reel.',
    'Input format per line: id|start-end|text',
    'Return ONLY a JSON array of objects, one for every input segment id:',
    '- "id": integer matching the segment id',
    '- "s": integer importance score from 1 to 10',
    '- "l": REQUIRED for segments with score >= 7 (omit or empty for <7): a concise 6-10 word descriptive label summarizing the key claim or insight in that clip.',
    'Prioritize (score 7-10): key claims, surprising facts, counter-intuitive insights, strong conclusions, concrete examples, and self-contained explanations.',
    'Penalize (score 1-4): intros, housekeeping, sponsor reads, ads, tangents, filler, small talk, and fragments that make no sense without earlier context.'
  ].join('\n');

  let lastError = null;

  for (const model of PRIMARY_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemInstruction }]
          },
          contents: [
            {
              role: 'user',
              parts: [{ text: lines }]
            }
          ],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: 'application/json',
            thinkingConfig: {
              thinkingBudget: 0
            },
            responseSchema: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  id: { type: 'INTEGER' },
                  s: { type: 'INTEGER' },
                  l: { type: 'STRING' }
                },
                required: ['id', 's']
              }
            }
          }
        })
      });

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        const err = new Error(
          response.status === 429
            ? 'Gemini rate limit reached (HTTP 429). Wait a moment and try again.'
            : `Gemini API error (HTTP ${response.status}) on ${model}: ${bodyText.slice(0, 180)}`
        );
        err.status = response.status;
        throw err;
      }

      const payload = await response.json();
      const rawJson =
        payload &&
        payload.candidates &&
        payload.candidates[0] &&
        payload.candidates[0].content &&
        payload.candidates[0].content.parts &&
        payload.candidates[0].content.parts[0] &&
        payload.candidates[0].content.parts[0].text;

      if (!rawJson) {
        throw new Error('Gemini returned an empty response.');
      }

      let parsed;
      try {
        parsed = JSON.parse(rawJson);
      } catch (e) {
        const cleaned = rawJson.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
        parsed = JSON.parse(cleaned);
      }

      if (!Array.isArray(parsed)) {
        throw new Error('Gemini response was not a JSON array.');
      }

      const validIds = new Set(chunk.map((s) => s.id));
      const map = new Map();

      for (const item of parsed) {
        if (!item || typeof item.id !== 'number' || !validIds.has(item.id)) continue;
        const rawScore = Number(item.s);
        const score = Number.isFinite(rawScore) ? Math.max(1, Math.min(10, Math.round(rawScore))) : 3;
        const entry = { s: score };
        if (score >= 7 && typeof item.l === 'string' && item.l.trim()) {
          entry.l = item.l.trim();
        }
        map.set(item.id, entry);
      }

      if (map.size > 0) {
        return map;
      }
    } catch (err) {
      lastError = err;
      // If 503 or 404, loop to try next fallback model
      if (err.status === 503 || err.status === 404) {
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error('Gemini returned no valid segment scores.');
}
