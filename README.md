# 🎬 Recap Reel

> **Play long YouTube videos as an AI-curated highlight reel by automatically seeking through the most important moments directly in YouTube — no downloading, editing, or wait times.**

Built with Vanilla JavaScript (Manifest V3) and powered by Google Gemini API.

---

## ✨ Features

- **⚡ Zero-Wait Seeking**: Never download gigabytes of video. Recap Reel uses YouTube's native player and automatically skips between the high-signal segments.
- **⏱️ Three Nested Tiers**:
  - `2 min` – The top-tier highlights and punchlines.
  - `10 min` – Core arguments, key facts, and deep dives.
  - `30 min` – Comprehensive overview for 1-3 hour podcasts.
  - *(Smart duration guards automatically disable larger tiers for shorter videos).*
- **🧠 Sentence-Snapped & Merged**: Automatically detects sentence boundaries so clips never cut off mid-sentence. Highlights within 3 seconds of each other are merged seamlessly.
- **🏷️ AI Clip Labels**: Floating player overlay displays a 6–10 word label summarizing what the upcoming highlight is about.
- **💾 Instant Local Cache**: Scoring is cached per `videoId` in Chrome storage. Switching tiers or revisiting a video requires zero API calls.
- **🛡️ Player Controls**: `Skip clip`, `Watch this part fully`, or `Exit reel` at any moment. Automatically pauses when YouTube ads appear and resumes when they finish.

---

## 🚀 Quick Setup (For Friends & Collaborators)

### Step 1: Get a Free Gemini API Key (Takes 30 seconds)
Recap Reel runs completely on your own free Gemini API key:
1. Go to [Google AI Studio (API Keys)](https://aistudio.google.com/app/apikey).
2. Sign in with your Google account and click **Create API key**.
3. Copy your key (starts with `AIzaSy...`). *No credit card or billing is required on the free tier.*

---

### Step 2: Install into Google Chrome (or Brave / Edge / Arc)
1. Clone or download this repository:
   ```bash
   git clone https://github.com/yugjain/RecapReel.git
   ```
   *(Or download the ZIP file and extract it)*.
2. In Google Chrome, navigate to `chrome://extensions`.
3. In the top-right corner, turn on **Developer mode**.
4. Click **Load unpacked** in the top-left corner.
5. Select this folder (`RecapReel`).
6. Click the extension puzzle icon in your Chrome toolbar and **Pin** 📌 **Recap Reel** for easy access.

---

### Step 3: Watch Your First Highlight Reel
1. Open any YouTube video with English subtitles or auto-captions (e.g. any podcast, interview, or tutorial on `https://www.youtube.com/watch?v=...`).
2. Click the **Recap Reel** icon in your browser toolbar.
3. Paste your Gemini API key in the key field and click **Save Key**.
4. Click **2 min**, **10 min**, or **30 min**.
5. Sit back and enjoy the highlight reel!

---

## 🎮 Overlay Controls

While a reel is playing, a native dark HUD overlay appears over the player:
- **Skip Clip** (`⏭`): Instantly jump forward to the next highlight clip.
- **Watch Fully** (`👁`): Pause highlight jumping and let this section play out normally.
- **Exit Reel** (`✕`): Return to normal standard YouTube playback.
- **Manual Seek**: Scrubbing the video timeline automatically hands back control to you.

---

## 🛠️ Architecture & Tech Stack

- **Chrome Extension Manifest V3**: 100% vanilla JavaScript, no heavy frameworks or external bundlers.
- **Model**: `gemini-2.5-flash` via Google Generative Language API with strict JSON schema outputs.
- **Chunked Processing**: Long transcripts (>30 mins) are split into sequential batches to stay safely within free-tier rate limits.
- **Transcript Extraction**: Reads the native YouTube `captionTracks` or falls back to the DOM searchable transcript renderer.

---

## ❓ Troubleshooting & FAQ

<details>
<summary><strong>"No English transcript found for this video"</strong></summary>
Recap Reel requires captions to analyze content. Verify that the YouTube video has English captions (either manual or auto-generated) available in YouTube's subtitle settings.
</details>

<details>
<summary><strong>"Rate limit reached (429)"</strong></summary>
Google AI Studio's free tier has a generous limit (15 requests/minute). If you encounter this on an extremely long video (3+ hours), wait 30 seconds and click the duration tier again.
</details>

<details>
<summary><strong>How do I re-rank a video if I want fresh clips?</strong></summary>
Open the extension popup and click the <strong>Re-rank video</strong> link at the bottom of the popup.
</details>

---

## 📄 License
MIT License. Feel free to use, customize, and share!
