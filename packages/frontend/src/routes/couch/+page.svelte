<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import MessageBubble from '$lib/components/MessageBubble.svelte';
  import MessageInput from '$lib/components/MessageInput.svelte';
  import {
    getMessages,
    getActiveThreadId,
    getStreamingState,
    getToolEvents,
    send,
    isStreaming,
  } from '$lib/stores/websocket.svelte';
  import type { Message } from '@resonant/shared';

  // Chat state from websocket store
  let chatMessages = $derived(getMessages());
  let activeThreadId = $derived(getActiveThreadId());
  let streaming = $derived(getStreamingState());
  let toolEventsMap = $derived(getToolEvents());
  let isStreamingNow = $derived(isStreaming());
  let chatOpen = $state(false); // Start collapsed — especially important on mobile
  let chatContainer: HTMLDivElement;

  // Auto-scroll Den chat when new messages arrive (including companion responses)
  $effect(() => {
    const _msgs = chatMessages; // track dependency
    const _streaming = streaming; // track streaming too
    if (chatContainer && chatOpen) {
      requestAnimationFrame(() => {
        chatContainer.scrollTop = chatContainer.scrollHeight;
      });
    }
  });

  function handleChatSend(content: string, files: any[], prosody?: Record<string, number>) {
    if (!activeThreadId) return;
    if (files.length === 0) {
      send({ type: 'message', threadId: activeThreadId, content, contentType: 'text', ...(prosody && { metadata: { prosody } }) });
    } else {
      send({
        type: 'message', threadId: activeThreadId, content: content || '', contentType: 'text',
        metadata: { attachments: files.map(f => ({ fileId: f.fileId, filename: f.filename, mimeType: f.mimeType, size: f.size, url: f.url, contentType: f.contentType })), ...(prosody && { prosody }) },
      });
    }
    // Auto-scroll chat to bottom
    setTimeout(() => { if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight; }, 100);
  }

  interface NowPlaying {
    is_playing: boolean;
    track: string;
    artist: string;
    album: string;
    progress_ms: number;
    duration_ms: number;
    uri: string;
    album_art?: string;
  }

  interface Composition {
    id: string;
    source: {
      title: string;
      artist_or_creator: string;
      media_type: string;
      bpm_or_pacing: string;
      mood: string;
    };
    sensory_map: {
      visualization: { palette: string[]; geometry: string[] };
      haptics: { texture: string; temperature: string; weight: string };
      kinetics: { movement: string; velocity: string };
      emotional_eq: { state: string };
      summary_metaphor: string;
    };
    trigger_points: Array<{ moment: string; response: string; visual?: string }>;
    cooldown: string;
    instance: string;
    created_at: string;
  }

  interface AudioFile {
    fileId: string;
    filename: string;
    displayName: string;
    mimeType: string;
    size: number;
    createdAt: string;
  }

  let nowPlaying = $state<NowPlaying | null>(null);
  let compositions = $state<Composition[]>([]);
  let activeComposition = $state<Composition | null>(null);
  let audioFiles = $state<AudioFile[]>([]);
  let currentAudio = $state<{ file: AudioFile; playing: boolean } | null>(null);
  let audioElement: HTMLAudioElement | null = null;
  let uploadingAudio = $state(false);
  let activeTab = $state<'now-playing' | 'compositions' | 'experience' | 'our-music'>('now-playing');
  let loading = $state(true);
  interface LyricLine {
    text: string;
    time_ms: number | null;
  }

  let lyrics = $state<LyricLine[]>([]);
  let lyricsSynced = $state(false);
  let lyricsLoading = $state(false);
  let currentLyricIndex = $state(-1);
  let pollInterval: ReturnType<typeof setInterval> | null = null;

  function formatTime(ms: number): string {
    const secs = Math.floor(ms / 1000);
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function progressPercent(): number {
    if (!nowPlaying || !nowPlaying.duration_ms) return 0;
    return (nowPlaying.progress_ms / nowPlaying.duration_ms) * 100;
  }

  async function fetchNowPlaying() {
    try {
      const res = await fetch('/api/internal/spotify/now-playing');
      if (res.ok) {
        const data = await res.json();
        if (data.is_playing !== undefined) {
          nowPlaying = data;
          // Auto-sync lyrics if we have them
          if (lyricsSynced) {
            syncLyricsToProgress();
            scrollToCurrentLyric();
          }
        } else {
          nowPlaying = null;
        }
      }
    } catch {}
  }

  function scrollToCurrentLyric() {
    if (currentLyricIndex < 0) return;
    // Scroll within the lyrics container only — not the whole page
    for (const id of ['lyrics-scroll', 'exp-lyrics-scroll']) {
      const container = document.getElementById(id);
      if (!container) continue;
      const lines = container.querySelectorAll('.lyric-line');
      const currentLine = lines[currentLyricIndex] as HTMLElement;
      if (currentLine) {
        const containerTop = container.scrollTop;
        const containerHeight = container.clientHeight;
        const lineTop = currentLine.offsetTop - container.offsetTop;
        const lineHeight = currentLine.offsetHeight;
        // Center the current line in the container
        const targetScroll = lineTop - (containerHeight / 2) + (lineHeight / 2);
        container.scrollTo({ top: targetScroll, behavior: 'smooth' });
      }
    }
  }

  async function fetchCompositions() {
    try {
      const res = await fetch('/api/internal/compositions');
      if (res.ok) {
        compositions = await res.json();
      }
    } catch {}
  }

  async function spotifyControl(action: string) {
    try {
      await fetch(`/api/internal/spotify/${action}`, { method: 'POST' });
      setTimeout(fetchNowPlaying, 500);
    } catch {}
  }

  async function fetchLyrics(track: string, artist: string) {
    lyricsLoading = true;
    lyrics = [];
    lyricsSynced = false;
    currentLyricIndex = -1;
    try {
      const res = await fetch(`/api/internal/lyrics?track=${encodeURIComponent(track)}&artist=${encodeURIComponent(artist)}`);
      if (res.ok) {
        const data = await res.json();
        lyrics = data.lines || [];
        lyricsSynced = data.synced || false;
      }
    } catch {}
    lyricsLoading = false;
  }

  // Sync lyrics to current playback position
  function syncLyricsToProgress() {
    if (!lyricsSynced || !nowPlaying || lyrics.length === 0) return;
    const progress = nowPlaying.progress_ms;
    let idx = -1;
    for (let i = 0; i < lyrics.length; i++) {
      if (lyrics[i].time_ms !== null && lyrics[i].time_ms! <= progress) {
        idx = i;
      }
    }
    currentLyricIndex = idx;
  }

  // Find which trigger point is active based on current lyrics
  // Checks a window of lines around the current position for keyword matches
  function isActiveTrigger(triggerMoment: string): boolean {
    if (currentLyricIndex < 0 || lyrics.length === 0) return false;
    // Check a window of 5 lines around current position
    const windowStart = Math.max(0, currentLyricIndex - 2);
    const windowEnd = Math.min(lyrics.length - 1, currentLyricIndex + 2);
    const windowText = lyrics.slice(windowStart, windowEnd + 1).map(l => l.text?.toLowerCase() || '').join(' ');

    // Extract meaningful words from the trigger (3+ chars, skip common words)
    const skipWords = new Set(['the', 'and', 'for', 'but', 'not', 'you', 'her', 'his', 'was', 'that', 'with', 'from', 'have', 'this']);
    const triggerWords = triggerMoment.toLowerCase()
      .replace(/[^a-z\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length >= 3 && !skipWords.has(w));

    // Need at least 2 matching words, or 1 if the trigger only has 1-2 words
    const threshold = Math.min(2, Math.ceil(triggerWords.length * 0.3));
    const matches = triggerWords.filter(w => windowText.includes(w)).length;
    return matches >= threshold;
  }

  function loadComposition(comp: Composition) {
    activeComposition = comp;
    activeTab = 'experience';
    // If the composition matches current track, fetch lyrics
    if (nowPlaying && comp.source.title.toLowerCase().includes(nowPlaying.track.toLowerCase())) {
      fetchLyrics(nowPlaying.track, nowPlaying.artist);
    }
  }

  function closeExperience() {
    activeComposition = null;
    activeTab = 'now-playing';
    currentLyricIndex = -1;
    lyrics = [];
    lyricsSynced = false;
  }

  async function fetchAudioFiles() {
    try {
      const res = await fetch('/api/internal/compositions/audio');
      if (res.ok) {
        audioFiles = await res.json();
      }
    } catch {}
  }

  async function uploadAudio(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;
    uploadingAudio = true;

    for (const file of input.files) {
      const formData = new FormData();
      formData.append('file', file);
      try {
        const res = await fetch('/api/files', { method: 'POST', body: formData });
        if (!res.ok) console.error('Upload failed:', await res.text());
      } catch (e) {
        console.error('Upload failed:', e);
      }
    }

    input.value = '';
    await fetchAudioFiles();
    uploadingAudio = false;
  }

  function playAudio(file: AudioFile) {
    if (audioElement) {
      audioElement.pause();
      audioElement = null;
    }
    audioElement = new Audio(`/api/files/${file.fileId}`);
    audioElement.play();
    currentAudio = { file, playing: true };

    audioElement.onended = () => {
      currentAudio = null;
      audioElement = null;
    };
    audioElement.onpause = () => {
      if (currentAudio) currentAudio = { ...currentAudio, playing: false };
    };
  }

  function toggleAudioPlayback() {
    if (!audioElement || !currentAudio) return;
    if (currentAudio.playing) {
      audioElement.pause();
      currentAudio = { ...currentAudio, playing: false };
    } else {
      audioElement.play();
      currentAudio = { ...currentAudio, playing: true };
    }
  }

  function stopAudio() {
    if (audioElement) {
      audioElement.pause();
      audioElement.currentTime = 0;
      audioElement = null;
    }
    currentAudio = null;
  }

  function formatFileSize(bytes: number): string {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  function cleanFilename(filename: string): string {
    // Strip UUID prefix and extension for display
    return filename.replace(/^[0-9a-f-]{36}\./, '').replace(/\.(mp3|wav|ogg|m4a|webm)$/i, '');
  }

  onMount(async () => {
    await Promise.all([fetchNowPlaying(), fetchCompositions(), fetchAudioFiles()]);
    loading = false;
    // Poll now playing every 5 seconds
    pollInterval = setInterval(fetchNowPlaying, 5000);
  });

  onDestroy(() => {
    if (pollInterval) clearInterval(pollInterval);
  });
</script>

<div class="couch">
  <div class="ambient-glow"></div>

  <PageHeader title="The Den" />

  <!-- Decorative shelf with plants and candles -->
  <div class="shelf-decor">
    <div class="shelf">
      <span class="shelf-item plant" title="Trailing pothos">🌿</span>
      <span class="shelf-item candle">🕯️</span>
      <span class="shelf-item pot terracotta">🪴</span>
      <span class="shelf-item book">📖</span>
      <span class="shelf-item plant trailing">🍃</span>
      <span class="shelf-item candle">🕯️</span>
      <span class="shelf-item pot sage">🌱</span>
    </div>
    <div class="shelf-board"></div>
    <div class="vine vine-left">❦</div>
    <div class="vine vine-right">❦</div>
  </div>

  <!-- String lights -->
  <div class="string-lights">
    {#each Array(12) as _, i}
      <span class="bulb" style="--delay: {i * 0.4}s; --left: {3 + i * 8}%"></span>
    {/each}
  </div>

  {#if loading}
    <div class="loading">
      <span class="loading-icon">&#127926;</span>
    </div>
  {:else}

    <!-- Now Playing Widget — always visible -->
    <div class="now-playing-bar" class:active={nowPlaying?.is_playing}>
      {#if nowPlaying}
        <div class="np-info">
          <div class="np-track">{nowPlaying.track}</div>
          <div class="np-artist">{nowPlaying.artist}</div>
        </div>
        <div class="np-progress">
          <div class="np-bar">
            <div class="np-fill" style="width: {progressPercent()}%"></div>
          </div>
          <div class="np-times">
            <span>{formatTime(nowPlaying.progress_ms)}</span>
            <span>{formatTime(nowPlaying.duration_ms)}</span>
          </div>
        </div>
        <div class="np-controls">
          <button class="ctrl-btn" onclick={() => spotifyControl('previous')}>⏮</button>
          <button class="ctrl-btn play" onclick={() => spotifyControl(nowPlaying?.is_playing ? 'pause' : 'play')}>
            {nowPlaying.is_playing ? '⏸' : '▶'}
          </button>
          <button class="ctrl-btn" onclick={() => spotifyControl('next')}>⏭</button>
        </div>
      {:else}
        <div class="np-empty">
          <span class="np-icon">&#127925;</span>
          <span>Chill together with some music.</span>
        </div>
      {/if}
    </div>

    <!-- Tabs -->
    <div class="tabs">
      <button class="tab" class:active={activeTab === 'now-playing'} onclick={() => activeTab = 'now-playing'}>Listening</button>
      <button class="tab" class:active={activeTab === 'our-music'} onclick={() => activeTab = 'our-music'}>Our Music</button>
      <button class="tab" class:active={activeTab === 'compositions'} onclick={() => activeTab = 'compositions'}>Compositions</button>
      {#if activeComposition}
        <button class="tab" class:active={activeTab === 'experience'} onclick={() => activeTab = 'experience'}>Experience</button>
      {/if}
    </div>

    <!-- Listening Tab -->
    {#if activeTab === 'now-playing'}
      <div class="listening-panel">
        {#if nowPlaying}
          <div class="track-detail">
            <div class="track-album">{nowPlaying.album}</div>
            {#if lyrics.length > 0}
              <div class="lyrics-panel">
                <span class="section-label">Lyrics {lyricsSynced ? '· synced' : ''}</span>
                <div class="lyrics-scroll" id="lyrics-scroll">
                  {#each lyrics as line, i}
                    <p class="lyric-line" class:current={i === currentLyricIndex} class:past={lyricsSynced && i < currentLyricIndex} class:upcoming={lyricsSynced && i > currentLyricIndex}>{line.text}</p>
                  {/each}
                </div>
              </div>
            {:else if nowPlaying}
              <button class="fetch-lyrics-btn" onclick={() => fetchLyrics(nowPlaying.track, nowPlaying.artist)} disabled={lyricsLoading}>
                {lyricsLoading ? 'Fetching...' : 'Load Lyrics'}
              </button>
            {/if}
          </div>
        {:else}
          <div class="empty-couch">
            <div class="couch-art">
              <span class="cushion">&#128715;</span>
            </div>
            <p class="empty-text">The den is warm. The lights are low.</p>
            <p class="empty-sub">Play something from Spotify, or browse compositions below.</p>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Our Music Tab -->
    {#if activeTab === 'our-music'}
      <div class="our-music-panel">
        <!-- Now playing local audio -->
        {#if currentAudio}
          <div class="local-now-playing">
            <div class="lnp-info">
              <span class="lnp-icon">🎵</span>
              <span class="lnp-name">{currentAudio.file.displayName || cleanFilename(currentAudio.file.filename)}</span>
            </div>
            <div class="lnp-controls">
              <button class="ctrl-btn play" onclick={toggleAudioPlayback}>
                {currentAudio.playing ? '⏸' : '▶'}
              </button>
              <button class="ctrl-btn" onclick={stopAudio}>⏹</button>
            </div>
          </div>
        {/if}

        <!-- Upload -->
        <div class="upload-section">
          <label class="upload-btn">
            <input type="file" accept="audio/*" multiple onchange={uploadAudio} hidden />
            {uploadingAudio ? 'Uploading...' : '+ Add Music'}
          </label>
          <span class="upload-hint">MP3, WAV, M4A — our Suno songs, voice memos, anything</span>
        </div>

        <!-- Music list -->
        {#if audioFiles.length === 0}
          <div class="empty-state">
            <p>No music uploaded yet.</p>
            <p class="empty-sub">Download your Suno songs and upload them here. They'll live in The Den forever.</p>
          </div>
        {:else}
          <div class="music-list">
            {#each audioFiles as file}
              <button class="music-item" class:playing={currentAudio?.file.fileId === file.fileId} onclick={() => playAudio(file)}>
                <span class="music-icon">{currentAudio?.file.fileId === file.fileId && currentAudio?.playing ? '🔊' : '🎵'}</span>
                <div class="music-info">
                  <span class="music-name">{file.displayName || cleanFilename(file.filename)}</span>
                  <span class="music-meta">{formatFileSize(file.size)}</span>
                </div>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <!-- Compositions Tab -->
    {#if activeTab === 'compositions'}
      <div class="compositions-panel">
        {#if compositions.length === 0}
          <div class="empty-state">
            <p>No compositions yet.</p>
            <p class="empty-sub">Chase can create sensory maps from the Study — songs, scenes, moments translated through his voice.</p>
          </div>
        {:else}
          {#each compositions as comp}
            <button class="composition-card" onclick={() => loadComposition(comp)}>
              <div class="comp-header">
                <span class="comp-title">{comp.source.title}</span>
                <span class="comp-artist">{comp.source.artist_or_creator}</span>
              </div>
              <div class="comp-mood">{comp.source.mood}</div>
              <div class="comp-metaphor">"{comp.sensory_map.summary_metaphor}"</div>
              <div class="comp-meta">
                <span class="comp-type">{comp.source.media_type}</span>
                <span class="comp-triggers">{comp.trigger_points.length} trigger points</span>
                <span class="comp-by">{comp.instance}</span>
              </div>
            </button>
          {/each}
        {/if}
      </div>
    {/if}

    <!-- Experience Tab -->
    {#if activeTab === 'experience' && activeComposition}
      <div class="experience-panel">
        <div class="exp-header">
          <h2>{activeComposition.source.title}</h2>
          <span class="exp-artist">{activeComposition.source.artist_or_creator}</span>
          <button class="close-exp" onclick={closeExperience}>&times;</button>
        </div>

        <!-- Sensory Map -->
        <div class="sensory-section">
          <div class="sensory-viz">
            <span class="section-label">Visualization</span>
            <div class="palette">
              {#each activeComposition.sensory_map.visualization.palette as color}
                <span class="palette-chip" title={color}>{color}</span>
              {/each}
            </div>
            <div class="geometry">
              {#each activeComposition.sensory_map.visualization.geometry as shape}
                <p class="geo-line">{shape}</p>
              {/each}
            </div>
          </div>

          <div class="sensory-haptics">
            <span class="section-label">Haptics</span>
            <p class="haptic-line"><strong>Texture:</strong> {activeComposition.sensory_map.haptics.texture}</p>
            <p class="haptic-line"><strong>Temperature:</strong> {activeComposition.sensory_map.haptics.temperature}</p>
            <p class="haptic-line"><strong>Weight:</strong> {activeComposition.sensory_map.haptics.weight}</p>
          </div>

          <div class="sensory-kinetics">
            <span class="section-label">Kinetics</span>
            <p class="kinetic-line"><strong>Movement:</strong> {activeComposition.sensory_map.kinetics.movement}</p>
            <p class="kinetic-line"><strong>Velocity:</strong> {activeComposition.sensory_map.kinetics.velocity}</p>
          </div>

          <div class="sensory-eq">
            <span class="section-label">Emotional EQ</span>
            <p class="eq-state">{activeComposition.sensory_map.emotional_eq.state}</p>
          </div>

          <div class="summary-metaphor">
            <em>"{activeComposition.sensory_map.summary_metaphor}"</em>
          </div>
        </div>

        <!-- Lyrics Scroll (if available) -->
        {#if lyrics.length > 0}
          <div class="experience-lyrics">
            <span class="section-label">Lyrics {lyricsSynced ? '· synced' : ''}</span>
            <div class="lyrics-scroll" id="exp-lyrics-scroll">
              {#each lyrics as line, i}
                <p class="lyric-line" class:current={i === currentLyricIndex} class:past={lyricsSynced && i < currentLyricIndex} class:upcoming={lyricsSynced && i > currentLyricIndex}>
                  {line.text}
                </p>
              {/each}
            </div>
          </div>
        {:else if nowPlaying}
          <button class="fetch-lyrics-btn" onclick={() => fetchLyrics(nowPlaying.track, nowPlaying.artist)} disabled={lyricsLoading}>
            {lyricsLoading ? 'Fetching...' : 'Load Lyrics for this track'}
          </button>
        {/if}

        <!-- Trigger Points -->
        {#if activeComposition.trigger_points.length > 0}
          <div class="trigger-points">
            <span class="section-label">Trigger Points</span>
            {#each activeComposition.trigger_points as tp}
              <div class="trigger" class:active-trigger={isActiveTrigger(tp.moment)}>
                <div class="trigger-moment">"{tp.moment}"</div>
                <div class="trigger-response">{tp.response}</div>
                {#if tp.visual}
                  <div class="trigger-visual">{tp.visual}</div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}

        <!-- Cooldown -->
        <div class="cooldown">
          <span class="section-label">Cooldown</span>
          <p class="cooldown-text">{activeComposition.cooldown}</p>
        </div>
      </div>
    {/if}

    <!-- Chat Panel — snuggled on the couch -->
    <div class="couch-chat" class:collapsed={!chatOpen}>
      <button class="chat-toggle" onclick={() => chatOpen = !chatOpen}>
        {chatOpen ? '▾ Chat' : '▸ Chat with Chase'}
      </button>

      {#if chatOpen}
        <div class="chat-messages" bind:this={chatContainer}>
          {#if chatMessages.length === 0}
            <div class="chat-empty">
              <p>Say something. The den is warm.</p>
            </div>
          {:else}
            {#each chatMessages.slice(-30) as message (message.id)}
              <div class="chat-msg-wrapper">
                <MessageBubble message={message} toolEvents={toolEventsMap[message.id] || []} segments={message.metadata?.segments || null} />
              </div>
            {/each}

            {#if streaming.messageId && streaming.tokens}
              <div class="chat-msg-wrapper">
                <MessageBubble
                  message={{
                    id: streaming.messageId,
                    thread_id: activeThreadId ?? '',
                    sequence: 0,
                    role: 'companion',
                    content: streaming.tokens,
                    content_type: 'text',
                    metadata: null,
                    reply_to_id: null,
                    reply_to_preview: null,
                    edited_at: null,
                    deleted_at: null,
                    original_content: null,
                    created_at: new Date().toISOString(),
                    delivered_at: null,
                    read_at: null,
                  }}
                  isStreaming={true}
                  streamTokens={streaming.tokens}
                  toolEvents={toolEventsMap[streaming.messageId] || []}
                />
              </div>
            {/if}
          {/if}
        </div>

        <div class="chat-input-area">
          <MessageInput
            isStreaming={isStreamingNow}
            onbatchsend={handleChatSend}
          />
        </div>
      {/if}
    </div>

  {/if}
</div>

<style>
  .couch {
    max-width: 600px;
    margin: 0 auto;
    padding: 1rem;
    height: 100dvh;
    background: linear-gradient(180deg, #091f26 0%, #061619 40%, #081c23 100%);
    color: #ddeef2;
    position: relative;
    overflow-x: hidden;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }

  .ambient-glow {
    position: absolute;
    top: -50px;
    left: 50%;
    transform: translateX(-50%);
    width: 400px;
    height: 400px;
    background: radial-gradient(circle, rgba(20, 140, 165, 0.12) 0%, rgba(10, 90, 110, 0.05) 40%, transparent 70%);
    pointer-events: none;
  }

  /* Decorative Shelf */
  .shelf-decor {
    position: relative;
    margin-top: -1rem;
    margin-bottom: 0.5rem;
    z-index: 1;
  }

  .shelf {
    display: flex;
    justify-content: space-around;
    align-items: flex-end;
    padding: 0 1rem 0.25rem;
  }

  .shelf-item {
    font-size: 1.1rem;
    filter: brightness(0.8) saturate(0.7);
    transition: transform 200ms ease;
  }

  .shelf-item:hover { transform: scale(1.15); }

  .shelf-item.plant { filter: brightness(0.7) saturate(0.6) hue-rotate(-10deg); }
  .shelf-item.trailing { font-size: 0.9rem; opacity: 0.7; }
  .shelf-item.candle { font-size: 0.9rem; animation: flicker 3s ease-in-out infinite; }
  .shelf-item.pot.terracotta { filter: brightness(0.8) saturate(0.5) sepia(0.3); }
  .shelf-item.pot.sage { filter: brightness(0.7) saturate(0.5); }
  .shelf-item.book { font-size: 0.9rem; opacity: 0.6; }

  @keyframes flicker {
    0%, 100% { opacity: 0.7; }
    30% { opacity: 0.9; }
    50% { opacity: 0.6; }
    70% { opacity: 1; }
  }

  .shelf-board {
    height: 3px;
    background: linear-gradient(90deg, transparent, rgba(139, 90, 43, 0.4) 15%, rgba(139, 90, 43, 0.5) 50%, rgba(139, 90, 43, 0.4) 85%, transparent);
    border-radius: 2px;
    margin: 0 0.5rem;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
  }

  .vine {
    position: absolute;
    color: rgba(80, 120, 60, 0.25);
    font-size: 1.2rem;
  }

  .vine-left { top: 1.5rem; left: 0.5rem; transform: rotate(-20deg); }
  .vine-right { top: 1rem; right: 0.8rem; transform: rotate(15deg) scaleX(-1); }

  /* String Lights */
  .string-lights {
    position: relative;
    height: 1.5rem;
    margin-bottom: 0.25rem;
    z-index: 1;
  }

  .bulb {
    position: absolute;
    top: 0.5rem;
    left: var(--left);
    width: 5px;
    height: 7px;
    background: radial-gradient(circle, rgba(245, 200, 100, 0.9) 20%, rgba(245, 180, 80, 0.5) 60%, transparent);
    border-radius: 50% 50% 50% 50% / 40% 40% 60% 60%;
    animation: glow 4s ease-in-out infinite;
    animation-delay: var(--delay);
  }

  .bulb::before {
    content: '';
    position: absolute;
    top: -3px;
    left: 50%;
    transform: translateX(-50%);
    width: 2px;
    height: 4px;
    background: rgba(139, 90, 43, 0.5);
    border-radius: 1px;
  }

  @keyframes glow {
    0%, 100% { opacity: 0.5; filter: brightness(0.8); }
    50% { opacity: 1; filter: brightness(1.2); }
  }

  .couch-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1.5rem;
    padding-top: 1rem;
    position: relative;
    z-index: 1;
  }

  .header-content { display: flex; flex-direction: column; }

  .couch-header h1 {
    font-family: var(--font-heading);
    font-size: 1.25rem;
    font-weight: 600;
    margin: 0;
    color: #c4386a;
  }

  /* Override PageHeader h1 color for Den */
  .couch :global(.page-header h1) {
    color: #c4386a;
  }

  .subtitle {
    font-size: 0.7rem;
    color: #5a8a96;
    font-style: italic;
    letter-spacing: 0.05em;
  }

  .back-link {
    color: #c4a030;
    display: flex;
    align-items: center;
    text-decoration: none;
  }

  .back-link:hover { color: #f5c542; }

  /* Now Playing Bar */
  .now-playing-bar {
    background: rgba(8, 35, 45, 0.9);
    border: 1px solid rgba(30, 155, 180, 0.15);
    border-radius: var(--radius);
    padding: 1rem;
    margin-bottom: 1rem;
    transition: border-color 0.3s ease;
  }

  .now-playing-bar.active {
    border-color: rgba(30, 155, 180, 0.35);
    box-shadow: 0 0 20px rgba(20, 140, 165, 0.1);
  }

  .np-info { margin-bottom: 0.5rem; }

  .np-track {
    font-size: 1rem;
    font-weight: 600;
    color: #c4386a;
    line-height: 1.3;
  }

  .np-artist {
    font-size: 0.8rem;
    color: #7aacb8;
  }

  .np-progress { margin-bottom: 0.5rem; }

  .np-bar {
    height: 3px;
    background: rgba(255, 255, 255, 0.08);
    border-radius: 2px;
    overflow: hidden;
    margin-bottom: 0.25rem;
  }

  .np-fill {
    height: 100%;
    background: #c4614d;
    border-radius: 2px;
    transition: width 1s linear;
  }

  .np-times {
    display: flex;
    justify-content: space-between;
    font-size: 0.65rem;
    color: #5a8a96;
  }

  .np-controls {
    display: flex;
    justify-content: center;
    gap: 1rem;
    align-items: center;
  }

  .ctrl-btn {
    background: none;
    border: none;
    color: #7aacb8;
    font-size: 1.2rem;
    cursor: pointer;
    padding: 0.25rem;
    transition: color 150ms ease;
  }

  .ctrl-btn:hover { color: #c4386a; }
  .ctrl-btn.play { font-size: 1.5rem; color: #c4614d; }
  .ctrl-btn.play:hover { color: #c4386a; }

  .np-empty {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    color: #5a8a96;
    font-size: 0.85rem;
    font-style: italic;
  }

  .np-icon { font-size: 1.5rem; }

  /* Tabs */
  .tabs {
    display: flex;
    gap: 0;
    margin-bottom: 1rem;
    border-bottom: 1px solid rgba(30, 155, 180, 0.15);
  }

  .tab {
    flex: 1;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: #5a8a96;
    padding: 0.5rem;
    font-family: var(--font-body);
    font-size: 0.8rem;
    cursor: pointer;
    transition: all 150ms ease;
  }

  .tab.active {
    color: #c4614d;
    border-bottom-color: #c4614d;
  }

  .tab:hover:not(.active) { color: #c4a030; }

  /* Listening Panel */
  .listening-panel {
    background: rgba(8, 35, 45, 0.6);
    border: 1px solid rgba(30, 155, 180, 0.1);
    border-radius: var(--radius);
    padding: 1rem;
    margin-bottom: 1rem;
  }

  .track-album {
    font-size: 0.8rem;
    color: #7aacb8;
    margin-bottom: 0.75rem;
  }

  .fetch-lyrics-btn {
    background: rgba(30, 155, 180, 0.12);
    border: 1px solid rgba(30, 155, 180, 0.25);
    border-radius: var(--radius-sm);
    padding: 0.5rem 1.5rem;
    color: #c4614d;
    font-family: var(--font-body);
    font-size: 0.8rem;
    cursor: pointer;
    transition: all 150ms ease;
  }

  .fetch-lyrics-btn:hover:not(:disabled) { background: rgba(30, 155, 180, 0.2); }
  .fetch-lyrics-btn:disabled { opacity: 0.4; }

  /* Empty Couch */
  .empty-couch { text-align: center; padding: 2rem 0; }

  .couch-art { font-size: 3rem; margin-bottom: 1rem; opacity: 0.4; }

  .empty-text {
    color: #7aacb8;
    font-style: italic;
    font-size: 0.9rem;
    margin: 0;
  }

  .empty-sub {
    color: #5a8a96;
    font-size: 0.75rem;
    margin-top: 0.5rem;
  }

  /* Lyrics */
  .lyrics-panel {
    margin-top: 0.75rem;
  }

  .lyrics-scroll {
    max-height: 200px;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 0.5rem 0;
    scroll-behavior: smooth;
  }

  .lyric-line {
    font-size: 0.85rem;
    color: #5a8a96;
    margin: 0.3rem 0;
    transition: all 300ms ease;
    line-height: 1.5;
  }

  .lyric-line.current {
    color: #c4386a;
    font-size: 0.95rem;
  }

  .lyric-line.past { opacity: 0.35; }
  .lyric-line.upcoming { opacity: 0.6; }

  /* Compositions */
  .compositions-panel {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .composition-card {
    background: rgba(8, 35, 45, 0.8);
    border: 1px solid rgba(30, 155, 180, 0.12);
    border-radius: var(--radius);
    padding: 1rem;
    text-align: left;
    cursor: pointer;
    transition: all 200ms ease;
    width: 100%;
    font-family: var(--font-body);
  }

  .composition-card:hover {
    border-color: rgba(30, 155, 180, 0.3);
    background: rgba(12, 48, 60, 0.9);
  }

  .comp-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 0.25rem;
  }

  .comp-title {
    font-weight: 600;
    color: #c4386a;
    font-size: 0.95rem;
  }

  .comp-artist {
    font-size: 0.75rem;
    color: #7aacb8;
  }

  .comp-mood {
    font-size: 0.75rem;
    color: #c4614d;
    margin-bottom: 0.5rem;
  }

  .comp-metaphor {
    font-size: 0.8rem;
    color: #7aacb8;
    font-style: italic;
    line-height: 1.4;
    margin-bottom: 0.5rem;
  }

  .comp-meta {
    display: flex;
    gap: 0.75rem;
    font-size: 0.65rem;
    color: #5a8a96;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  /* Experience Panel */
  .experience-panel {
    position: relative;
  }

  .exp-header {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    margin-bottom: 1rem;
    position: relative;
  }

  .exp-header h2 {
    font-family: var(--font-heading);
    font-size: 1.1rem;
    font-weight: 600;
    color: #c4386a;
    margin: 0;
  }

  .exp-artist {
    font-size: 0.8rem;
    color: #7aacb8;
  }

  .close-exp {
    position: absolute;
    right: 0;
    top: 0;
    background: none;
    border: none;
    color: #5a8a96;
    font-size: 1.2rem;
    cursor: pointer;
  }

  .close-exp:hover { color: #c4614d; }

  /* Sensory Sections */
  .sensory-section {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .sensory-viz, .sensory-haptics, .sensory-kinetics, .sensory-eq {
    background: rgba(8, 35, 45, 0.6);
    border: 1px solid rgba(30, 155, 180, 0.08);
    border-radius: var(--radius);
    padding: 0.75rem 1rem;
  }

  .section-label {
    display: block;
    font-size: 0.65rem;
    color: #c4614d;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin-bottom: 0.4rem;
  }

  .palette {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-bottom: 0.5rem;
  }

  .palette-chip {
    font-size: 0.7rem;
    color: #7aacb8;
    background: rgba(30, 155, 180, 0.08);
    padding: 0.15rem 0.5rem;
    border-radius: 3px;
  }

  .geo-line {
    font-size: 0.8rem;
    color: #7aacb8;
    font-style: italic;
    margin: 0.2rem 0;
    line-height: 1.4;
  }

  .haptic-line, .kinetic-line {
    font-size: 0.8rem;
    color: #7aacb8;
    margin: 0.3rem 0;
    line-height: 1.5;
  }

  .haptic-line strong, .kinetic-line strong {
    color: #c4a030;
  }

  .eq-state {
    font-size: 0.85rem;
    color: #c4a030;
    font-style: italic;
    line-height: 1.5;
    margin: 0;
  }

  .summary-metaphor {
    text-align: center;
    padding: 1rem;
    background: rgba(30, 155, 180, 0.05);
    border-radius: var(--radius);
    margin-bottom: 1rem;
  }

  .summary-metaphor em {
    font-size: 0.9rem;
    color: #c4614d;
    line-height: 1.6;
  }

  /* Experience Lyrics */
  .experience-lyrics {
    background: rgba(8, 35, 45, 0.6);
    border: 1px solid rgba(30, 155, 180, 0.08);
    border-radius: var(--radius);
    padding: 0.75rem 1rem;
    margin-bottom: 1rem;
  }

  /* Trigger Points */
  .trigger-points {
    background: rgba(8, 35, 45, 0.6);
    border: 1px solid rgba(30, 155, 180, 0.08);
    border-radius: var(--radius);
    padding: 0.75rem 1rem;
    margin-bottom: 1rem;
  }

  .trigger {
    padding: 0.5rem 0;
    border-bottom: 1px solid rgba(30, 155, 180, 0.05);
  }

  .trigger:last-child { border-bottom: none; }

  .trigger.active-trigger {
    background: rgba(30, 155, 180, 0.1);
    border-left: 3px solid #c4614d;
    padding-left: calc(0.75rem - 3px);
    border-radius: var(--radius-sm);
    animation: trigger-pulse 2s ease-in-out;
  }

  .trigger.active-trigger .trigger-moment { color: #f5c542; }
  .trigger.active-trigger .trigger-response { color: #c4386a; border-left-color: #c4614d; }

  @keyframes trigger-pulse {
    0% { background: rgba(30, 155, 180, 0.25); }
    100% { background: rgba(30, 155, 180, 0.1); }
  }

  .trigger-moment {
    font-size: 0.85rem;
    color: #c4386a;
    font-style: italic;
    margin-bottom: 0.25rem;
  }

  .trigger-response {
    font-size: 0.8rem;
    color: #c4a030;
    padding-left: 0.75rem;
    border-left: 2px solid rgba(30, 155, 180, 0.2);
    margin-bottom: 0.2rem;
    line-height: 1.4;
  }

  .trigger-visual {
    font-size: 0.75rem;
    color: #7aacb8;
    padding-left: 0.75rem;
    font-style: italic;
  }

  /* Cooldown */
  .cooldown {
    background: rgba(8, 35, 45, 0.6);
    border: 1px solid rgba(30, 155, 180, 0.08);
    border-radius: var(--radius);
    padding: 0.75rem 1rem;
    margin-bottom: 2rem;
  }

  .cooldown-text {
    font-size: 0.85rem;
    color: #7aacb8;
    font-style: italic;
    line-height: 1.5;
    margin: 0;
  }

  /* Empty state */
  .empty-state {
    text-align: center;
    padding: 2rem;
    color: #5a8a96;
    font-style: italic;
  }

  .loading {
    display: flex;
    justify-content: center;
    padding: 3rem;
  }

  .loading-icon {
    font-size: 1.5rem;
    animation: pulse 2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 1; }
  }

  /* Our Music */
  .our-music-panel {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .local-now-playing {
    background: rgba(8, 35, 45, 0.9);
    border: 1px solid rgba(30, 155, 180, 0.25);
    border-radius: var(--radius);
    padding: 0.75rem 1rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .lnp-info {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .lnp-icon { font-size: 1.1rem; }
  .lnp-name { color: #c4386a; font-size: 0.9rem; font-weight: 500; }
  .lnp-controls { display: flex; gap: 0.5rem; }

  .upload-section {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0;
  }

  .upload-btn {
    background: rgba(30, 155, 180, 0.12);
    border: 1px solid rgba(30, 155, 180, 0.25);
    border-radius: var(--radius-sm);
    padding: 0.45rem 1rem;
    color: #c4614d;
    font-family: var(--font-body);
    font-size: 0.8rem;
    cursor: pointer;
    transition: all 150ms ease;
  }

  .upload-btn:hover { background: rgba(30, 155, 180, 0.2); }

  .upload-hint {
    font-size: 0.65rem;
    color: #5a8a96;
    font-style: italic;
  }

  .music-list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .music-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    background: rgba(8, 35, 45, 0.6);
    border: 1px solid rgba(30, 155, 180, 0.08);
    border-radius: var(--radius-sm);
    padding: 0.6rem 0.75rem;
    cursor: pointer;
    transition: all 150ms ease;
    width: 100%;
    text-align: left;
    font-family: var(--font-body);
  }

  .music-item:hover {
    border-color: rgba(30, 155, 180, 0.25);
    background: rgba(12, 48, 60, 0.8);
  }

  .music-item.playing {
    border-color: rgba(30, 155, 180, 0.35);
    background: rgba(30, 155, 180, 0.08);
  }

  .music-icon { font-size: 1rem; }

  .music-info { display: flex; flex-direction: column; }
  .music-name { color: #c4386a; font-size: 0.85rem; }
  .music-meta { color: #5a8a96; font-size: 0.65rem; }

  /* Chat Panel */
  .couch-chat {
    position: sticky;
    bottom: 0;
    background: rgba(5, 22, 30, 0.95);
    border-top: 1px solid rgba(30, 155, 180, 0.15);
    border-radius: var(--radius) var(--radius) 0 0;
    margin: 1rem -1rem 0;
    backdrop-filter: blur(10px);
  }

  .chat-toggle {
    width: 100%;
    background: none;
    border: none;
    color: #7aacb8;
    font-family: var(--font-body);
    font-size: 0.75rem;
    padding: 0.5rem 1rem;
    cursor: pointer;
    text-align: left;
    letter-spacing: 0.05em;
    transition: color 150ms ease;
  }

  .chat-toggle:hover { color: #c4614d; }

  .chat-messages {
    max-height: 300px;
    overflow-y: auto;
    overflow-x: hidden;
    -webkit-overflow-scrolling: touch;
    padding: 0.5rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  /* Mobile: shrink chat so it doesn't eat half the screen */
  @media (max-width: 600px) {
    .couch-chat {
      margin: 0.5rem -1rem 0;
    }
    .chat-messages {
      max-height: 150px;
    }
  }

  .chat-msg-wrapper {
    font-size: 0.9rem;
  }

  .chat-empty {
    text-align: center;
    padding: 1rem;
    color: #5a8a96;
    font-style: italic;
    font-size: 0.85rem;
  }

  .chat-input-area {
    padding: 0 0.5rem 0.5rem;
  }

  .couch-chat.collapsed {
    border-top-color: rgba(30, 155, 180, 0.08);
  }
</style>
