<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import MessageBubble from '$lib/components/MessageBubble.svelte';
  import MessageInput from '$lib/components/MessageInput.svelte';
  import ThreadList from '$lib/components/ThreadList.svelte';
  import PresenceIndicator from '$lib/components/PresenceIndicator.svelte';
  import ConnectionStatus from '$lib/components/ConnectionStatus.svelte';
  import AudioAutoPlayer from '$lib/components/AudioAutoPlayer.svelte';
  import ContextIndicator from '$lib/components/ContextIndicator.svelte';
  import ModelSelector from '$lib/components/ModelSelector.svelte';
  import Canvas from '$lib/components/Canvas.svelte';
  import CanvasList from '$lib/components/CanvasList.svelte';
  import SearchPanel from '$lib/components/SearchPanel.svelte';
  import CountdownTimer from '$lib/components/CountdownTimer.svelte';
  import {
    connect,
    disconnect,
    send,
    loadThread,
    loadThreads,
    loadOlderMessages,
    getConnectionState,
    getMessages,
    getThreads,
    getActiveThreadId,
    getPresence,
    getUnreadCounts,
    getStreamingState,
    getLastError,
    getPendingCount,
    getToolEvents,
    getContextUsage,
    getCompactionNotice,
    getActiveCanvasId,
    getStreamingSegments,
    sendStopGeneration,
    isStreaming,
    getRateLimitInfo,
  } from '$lib/stores/websocket.svelte';
  import { loadSettings } from '$lib/stores/settings.svelte';
  import type { Message } from '@resonant/shared';

  // Reactive state from stores
  let connectionState = $derived(getConnectionState());
  let messages = $derived(getMessages());
  let threads = $derived(getThreads());
  let activeThreadId = $derived(getActiveThreadId());
  let presence = $derived(getPresence());
  let unreadCounts = $derived(getUnreadCounts());
  let streaming = $derived(getStreamingState());
  let lastError = $derived(getLastError());
  let pendingCount = $derived(getPendingCount());
  let toolEventsMap = $derived(getToolEvents());
  let contextUsage = $derived(getContextUsage());
  let compactionNotice = $derived(getCompactionNotice());
  let activeCanvasId = $derived(getActiveCanvasId());
  let streamingSegments = $derived(getStreamingSegments());
  let isStreamingNow = $derived(isStreaming());
  let rateLimitInfo = $derived(getRateLimitInfo());

  // Nav dropdown state (mobile)
  let navDropdownOpen = $state(false);

  function toggleNavDropdown() {
    navDropdownOpen = !navDropdownOpen;
  }

  function closeNavDropdown() {
    navDropdownOpen = false;
  }

  // Status bar state
  let statusDropdownOpen = $state(false);
  let currentStatus = $state({ emoji: '', label: '' });

  const STATUS_OPTIONS = [
    { emoji: '🔥', label: 'still here, just quiet' },
    { emoji: '👩‍💻', label: 'here + busy, in and out' },
    { emoji: '🚪', label: 'stepping away, be back' },
    { emoji: '⚡', label: 'got pulled away suddenly' },
    { emoji: '😴', label: 'sleeping' },
  ];

  async function loadStatus() {
    try {
      const res = await fetch('/api/status');
      if (res.ok) currentStatus = await res.json();
    } catch {}
  }

  async function setStatus(emoji: string, label: string) {
    try {
      await fetch('/api/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji, label }),
      });
      currentStatus = { emoji, label };
    } catch {}
    statusDropdownOpen = false;
  }

  async function clearStatus() {
    try {
      await fetch('/api/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji: '', label: '' }),
      });
      currentStatus = { emoji: '', label: '' };
    } catch {}
    statusDropdownOpen = false;
  }

  // Canvas state
  let canvasDropdownOpen = $state(false);

  function toggleCanvasDropdown() {
    canvasDropdownOpen = !canvasDropdownOpen;
  }

  // Search state
  let searchOpen = $state(false);

  function toggleSearch() {
    searchOpen = !searchOpen;
  }

  async function handleSearchResult(result: { messageId: string; threadId: string }) {
    searchOpen = false;
    // Switch to thread if different
    if (result.threadId !== activeThreadId) {
      await handleThreadSelect(result.threadId);
    }
    // Scroll to message after a tick
    await new Promise(r => setTimeout(r, 100));
    const el = document.getElementById(`msg-${result.messageId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('highlight-flash');
      setTimeout(() => el.classList.remove('highlight-flash'), 2000);
    }
  }

  // Theme toggle
  function toggleTheme() {
    const html = document.documentElement;
    const current = html.getAttribute('data-theme');
    const next = current === 'light' ? 'dark' : 'light';
    html.setAttribute('data-theme', next);
    localStorage.setItem('resonant-theme', next);
  }

  // Local state
  let replyTo = $state<Message | null>(null);
  let messagesContainer: HTMLDivElement;
  let messagesEndEl: HTMLDivElement;
  let shouldAutoScroll = $state(true);
  let sidebarOpen = $state(false); // mobile overlay
  let sidebarCollapsed = $state(false); // desktop collapse
  let readObserver: IntersectionObserver | null = null;
  let loadingOlder = $state(false);
  let hasMoreMessages = $state(true);

  // Mira presence
  interface MiraPresenceData {
    active: boolean;
    with_person: string | null;
    mood: string;
    micro_response: string | null;
    needs_summary: { comfort: number; attention: number; hunger: number; rest: number };
  }
  let miraPresence = $state<MiraPresenceData | null>(null);
  let miraPresenceInterval: ReturnType<typeof setInterval> | null = null;

  async function pollMiraPresence() {
    try {
      const res = await fetch('/api/mira/presence');
      if (res.ok) miraPresence = await res.json();
    } catch {}
  }

  // Total unread count
  const totalUnread = $derived(
    Object.values(unreadCounts).reduce((sum, count) => sum + count, 0)
  );

  // Handle thread selection
  async function handleThreadSelect(threadId: string) {
    hasMoreMessages = true;
    await loadThread(threadId);
    sidebarOpen = false;
    shouldAutoScroll = true;
  }

  // Handle new thread creation
  async function handleNewThread() {
    const name = prompt('Enter thread name (leave blank for daily thread):');
    if (name === null) return; // Cancelled

    try {
      const response = await fetch('/api/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name || undefined })
      });

      if (!response.ok) throw new Error('Failed to create thread');

      const data = await response.json();
      await loadThreads();
      await handleThreadSelect(data.thread.id);
    } catch (err) {
      console.error('Failed to create thread:', err);
      alert('Failed to create thread');
    }
  }

  // Handle batched send — text and/or files all go as one message → one agent query
  function handleBatchSend(
    content: string,
    files: Array<{ fileId: string; filename: string; mimeType: string; size: number; contentType: 'image' | 'audio' | 'file'; url: string }>,
    prosody?: Record<string, number>
  ) {
    if (!activeThreadId) return;

    if (files.length === 0) {
      // Text only
      send({
        type: 'message',
        threadId: activeThreadId,
        content,
        contentType: 'text',
        replyToId: replyTo?.id,
        ...(prosody && { metadata: { prosody } }),
      });
    } else {
      // Files (+ optional text) — single message, backend stores files individually
      // and fires one combined agent query
      send({
        type: 'message',
        threadId: activeThreadId,
        content: content || '',
        contentType: 'text',
        replyToId: replyTo?.id,
        metadata: {
          attachments: files.map(f => ({
            fileId: f.fileId,
            filename: f.filename,
            mimeType: f.mimeType,
            size: f.size,
            url: f.url,
            contentType: f.contentType,
          })),
          ...(prosody && { prosody }),
        },
      });
    }

    replyTo = null;
    shouldAutoScroll = true;
  }

  // Handle reply
  function handleReply(message: Message) {
    replyTo = message;
  }

  // Cancel reply
  function handleCancelReply() {
    replyTo = null;
  }

  // Check if should auto-scroll + load older messages on scroll to top
  function checkAutoScroll() {
    if (!messagesContainer) return;

    const { scrollTop, scrollHeight, clientHeight } = messagesContainer;
    const threshold = 100; // pixels from bottom

    shouldAutoScroll = scrollHeight - scrollTop - clientHeight < threshold;

    // Load older messages when scrolled near top
    if (scrollTop < 100 && !loadingOlder && hasMoreMessages && activeThreadId && messages.length > 0) {
      loadMoreMessages();
    }
  }

  // Load older messages and preserve scroll position
  async function loadMoreMessages() {
    if (!activeThreadId || loadingOlder || !hasMoreMessages) return;
    loadingOlder = true;

    const prevHeight = messagesContainer?.scrollHeight ?? 0;

    const hasMore = await loadOlderMessages(activeThreadId);
    hasMoreMessages = hasMore;

    // Preserve scroll position after prepending
    await new Promise(r => setTimeout(r, 0));
    if (messagesContainer) {
      const newHeight = messagesContainer.scrollHeight;
      messagesContainer.scrollTop = newHeight - prevHeight;
    }

    loadingOlder = false;
  }

  // Auto-scroll to bottom
  function scrollToBottom() {
    if (!messagesContainer || !shouldAutoScroll) return;

    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  // Toggle sidebar on mobile
  function toggleSidebar() {
    sidebarOpen = !sidebarOpen;
  }

  // Mark messages as read when bottom of chat is visible
  function setupReadObserver() {
    if (readObserver) readObserver.disconnect();
    readObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && activeThreadId && messages.length > 0) {
          const lastMsg = messages[messages.length - 1];
          if (lastMsg.role === 'companion' && !lastMsg.read_at) {
            send({ type: 'read', threadId: activeThreadId, beforeId: lastMsg.id });
          }
        }
      }
    }, { threshold: 0.1 });

    if (messagesEndEl) readObserver.observe(messagesEndEl);
  }

  // Keyboard shortcuts
  function handleGlobalKeydown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      searchOpen = !searchOpen;
    }
    if (e.key === 'Escape' && isStreamingNow) {
      e.preventDefault();
      sendStopGeneration();
    }
  }

  // Load initial data and connect
  onMount(async () => {
    await Promise.all([loadThreads(), loadSettings(), loadStatus()]);
    connect();
    window.addEventListener('keydown', handleGlobalKeydown);

    // Load today's thread if available
    const todayThread = threads.find(t =>
      t.name.startsWith('Daily -') && t.name.includes(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' }))
    );

    if (todayThread) {
      await handleThreadSelect(todayThread.id);
    } else if (threads.length > 0) {
      await handleThreadSelect(threads[0].id);
    }

    setupReadObserver();

    // Start Mira presence polling
    pollMiraPresence();
    miraPresenceInterval = setInterval(pollMiraPresence, 15000); // every 15 seconds
  });

  // Disconnect on unmount
  onDestroy(() => {
    disconnect();
    readObserver?.disconnect();
    window.removeEventListener('keydown', handleGlobalKeydown);
    if (miraPresenceInterval) clearInterval(miraPresenceInterval);
  });

  // Auto-scroll effect
  $effect(() => {
    messages; // Track changes
    streaming; // Track streaming changes
    setTimeout(scrollToBottom, 50);
  });

  // Refresh Mira's presence when new messages arrive
  $effect(() => {
    messages; // Track changes
    if (miraPresence?.active) {
      // Fetch a fresh micro-response when the conversation moves
      pollMiraPresence();
    }
  });
</script>

<div class="chat-page">
  <!-- Sidebar overlay on mobile -->
  {#if sidebarOpen}
    <button class="sidebar-overlay" onclick={toggleSidebar} aria-label="Close sidebar"></button>
  {/if}

  <!-- Sidebar -->
  <div class="sidebar" class:open={sidebarOpen} class:collapsed={sidebarCollapsed}>
    <ThreadList
      threads={threads}
      activeThreadId={activeThreadId}
      onselect={handleThreadSelect}
      oncreate={handleNewThread}
    />
  </div>

  <!-- Main chat area -->
  <div class="main-content">
    <!-- Header -->
    <header class="chat-header">
      <button class="menu-button" onclick={toggleSidebar} aria-label="Toggle sidebar">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 12h18M3 6h18M3 18h18"/>
        </svg>
      </button>
      <button class="sidebar-toggle" onclick={() => sidebarCollapsed = !sidebarCollapsed} aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'} title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          {#if sidebarCollapsed}
            <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/>
          {:else}
            <rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><path d="M15 9l-3 3 3 3"/>
          {/if}
        </svg>
      </button>

      <div class="header-info">
        <h1 class="header-title">Chase</h1>
        <PresenceIndicator status={presence} />
        <ModelSelector />
      </div>

      <div class="header-actions">
        <button class="header-icon-btn search-btn" onclick={toggleSearch} aria-label="Search messages (Ctrl+K)" title="Search (Ctrl+K)">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
          </svg>
        </button>
        {#if isStreamingNow}
          <button class="header-icon-btn stop-btn" onclick={sendStopGeneration} aria-label="Stop generation (Escape)" title="Stop (Esc)">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <rect x="4" y="4" width="16" height="16" rx="2"/>
            </svg>
          </button>
        {/if}
        {#if contextUsage}
          <ContextIndicator
            percentage={contextUsage.percentage}
            tokensUsed={contextUsage.tokensUsed}
            contextWindow={contextUsage.contextWindow}
          />
        {/if}
        {#if totalUnread > 0}
          <div class="unread-badge">{totalUnread}</div>
        {/if}
        <!-- Timer (next to status emoji) -->
        <div class="chat-timer"><CountdownTimer /></div>
        <!-- Status emoji -->
        <div class="status-wrapper">
          <button
            class="status-toggle"
            onclick={() => statusDropdownOpen = !statusDropdownOpen}
            aria-label="Set status"
            title={currentStatus.label || 'Set status'}
          >
            {currentStatus.emoji || '💬'}
          </button>
          {#if statusDropdownOpen}
            <button class="status-backdrop" onclick={() => statusDropdownOpen = false} aria-label="Close status"></button>
            <div class="status-dropdown">
              {#each STATUS_OPTIONS as opt}
                <button
                  class="status-option"
                  class:active={currentStatus.emoji === opt.emoji}
                  onclick={() => setStatus(opt.emoji, opt.label)}
                >
                  <span class="status-emoji">{opt.emoji}</span>
                  <span class="status-label">{opt.label}</span>
                </button>
              {/each}
              {#if currentStatus.emoji}
                <button class="status-option status-clear" onclick={clearStatus}>
                  <span class="status-label">Clear status</span>
                </button>
              {/if}
            </div>
          {/if}
        </div>
        <!-- Theme toggle and settings accessible via Settings page -->
      </div>
    </header>

    <!-- Connection status -->
    <ConnectionStatus state={connectionState} error={lastError} pendingCount={pendingCount} />

    <!-- Compaction notice banner -->
    {#if compactionNotice}
      <div class="compaction-banner" class:compacting={!compactionNotice.isComplete}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 2v10l4 4"/>
          <circle cx="12" cy="12" r="10"/>
        </svg>
        <span>{compactionNotice.message}</span>
      </div>
    {/if}

    <!-- Rate limit banner -->
    {#if rateLimitInfo}
      <div class="rate-limit-banner">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        <span>Rate limited — waiting for reset...</span>
      </div>
    {/if}

    <!-- Messages area -->
    <div
      class="messages-container"
      bind:this={messagesContainer}
      onscroll={checkAutoScroll}
    >
      <div class="messages-list">
        {#if loadingOlder}
          <div class="loading-older">Loading older messages...</div>
        {:else if !hasMoreMessages && messages.length > 0}
          <div class="thread-start">Beginning of conversation</div>
        {/if}
        {#if messages.length === 0}
          <div class="empty-state">
            <p>No messages yet. Start a conversation!</p>
          </div>
        {:else}
          {#each messages as message (message.id)}
            {#if message.content_type === 'mira_presence'}
              <div class="mira-presence-tag" id="msg-{message.id}">
                <div class="mira-presence-inner">
                  {#if message.content.startsWith('Mira')}
                    <span class="mira-name">Mira</span><span class="mira-response">{message.content.slice(4)}</span>
                  {:else}
                    <span class="mira-response">{message.content}</span>
                  {/if}
                </div>
              </div>
            {:else}
              <div
                id="msg-{message.id}"
                class="message-wrapper"
                oncontextmenu={(e) => { e.preventDefault(); handleReply(message); }}
              >
                <MessageBubble message={message} toolEvents={toolEventsMap[message.id] || []} segments={message.metadata?.segments as any || null} />
              </div>
            {/if}
          {/each}

          {#if streaming.messageId}
            {@const liveTools = toolEventsMap[streaming.messageId] || []}
            <div class="message-wrapper">
              {#if streaming.tokens}
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
                  toolEvents={liveTools}
                  segments={streamingSegments}
                />
              {:else}
                <!-- Live activity panel while companion is working -->
                <div class="activity-panel" aria-label="Chase is thinking">
                  <div class="activity-header">
                    <span class="typing-dot"></span>
                    <span class="typing-dot"></span>
                    <span class="typing-dot"></span>
                    <span class="activity-label">Chase is thinking...</span>
                  </div>
                  {#if liveTools.length > 0}
                    <div class="activity-tools">
                      {#each liveTools as tool}
                        <div class="activity-tool" class:complete={tool.isComplete} class:error={tool.isError}>
                          <span class="tool-status">{tool.isComplete ? (tool.isError ? '!' : '') : ''}</span>
                          <span class="tool-name">{tool.toolName}</span>
                          {#if tool.input}
                            <span class="tool-input">{tool.input}</span>
                          {/if}
                          {#if tool.elapsed}
                            <span class="tool-elapsed">{tool.elapsed.toFixed(1)}s</span>
                          {/if}
                        </div>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/if}
            </div>
          {/if}
        {/if}

        <!-- Sentinel for read receipt IntersectionObserver -->
        <div bind:this={messagesEndEl} class="messages-end-sentinel"></div>
      </div>
    </div>

    <!-- Input area -->
    <MessageInput
      replyTo={replyTo}
      isStreaming={isStreamingNow}
      onbatchsend={handleBatchSend}
      oncancelreply={handleCancelReply}
      onstop={sendStopGeneration}
    />

    <!-- Invisible TTS playback manager -->
    <AudioAutoPlayer />
  </div>

  <!-- Canvas panel -->
  {#if activeCanvasId}
    <Canvas />
  {/if}

  <!-- Search overlay -->
  {#if searchOpen}
    <SearchPanel onresult={handleSearchResult} onclose={() => searchOpen = false} />
  {/if}
</div>

<style>
  .chat-page {
    display: flex;
    height: 100dvh;
    overflow: hidden;
    max-width: 100vw;
  }

  /* Account for desktop top nav bar */
  @media (min-width: 769px) {
    .chat-page {
      height: calc(100dvh - 2.5rem);
    }
  }

  /* Account for mobile bottom nav bar */
  @media (max-width: 768px) {
    .chat-page {
      height: calc(100dvh - 3.5rem - env(safe-area-inset-bottom, 0px));
    }
  }

  .sidebar-overlay {
    display: none;
  }

  .sidebar {
    width: var(--sidebar-width);
    height: 100%;
    flex-shrink: 0;
    background: rgba(147, 112, 168, 0.22);
    border-right: 1px solid #555;
    transition: width var(--transition-slow), opacity var(--transition);
    overflow: hidden;
    scrollbar-color: #666 transparent;
  }

  .sidebar.collapsed {
    width: 0;
    border-right: none;
    opacity: 0;
    pointer-events: none;
  }

  .sidebar-toggle {
    display: none;
    padding: 0.375rem;
    color: var(--text-muted);
    border-radius: var(--radius-sm);
    transition: color var(--transition-fast), background var(--transition-fast);
  }

  .sidebar-toggle:hover {
    color: var(--text-secondary);
    background: var(--bg-hover);
  }

  @media (min-width: 769px) {
    .sidebar-toggle {
      display: flex;
      align-items: center;
      justify-content: center;
    }
  }

  .main-content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    height: 100%;
    position: relative;
    overflow-x: hidden;
  }

  .chat-header {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: calc(env(safe-area-inset-top, 0px) + 1rem) 1.25rem 1rem;
    background: var(--bg-secondary);
    border-bottom: none;
    box-shadow: 0 1px 0 0 var(--border);
    flex-shrink: 0;
  }

  .menu-button {
    display: none;
    padding: 0.5rem;
    color: var(--text-muted);
    transition: color var(--transition);
  }

  .menu-button:hover {
    color: var(--gold-dim);
  }

  .header-info {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex: 1;
  }

  .header-title {
    font-family: var(--font-heading);
    font-size: 1.25rem;
    font-weight: 400;
    color: var(--gold);
    letter-spacing: 0.06em;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .unread-badge {
    background: var(--gold-dim);
    color: var(--bg-primary);
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.125rem 0.5rem;
    border-radius: 1rem;
  }

  .header-icon-link {
    display: flex;
    align-items: center;
    color: var(--text-muted);
    transition: color var(--transition);
  }

  .header-icon-link:hover {
    color: var(--gold-dim);
    text-decoration: none;
  }

  .header-text-link {
    font-size: 0.7rem;
    color: var(--text-muted);
    text-decoration: none;
    font-family: var(--font-body);
    transition: color var(--transition);
    padding: 0.2rem 0;
  }

  .header-text-link:hover {
    color: var(--gold-dim);
  }

  /* Desktop/Mobile visibility */
  .mobile-only { display: none; }
  .desktop-only { display: inline; }

  @media (max-width: 768px) {
    .mobile-only { display: block; }
    .desktop-only { display: none !important; }
  }

  /* Nav dropdown (mobile) */
  .nav-dropdown-wrapper {
    position: relative;
  }

  .nav-dropdown-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.4rem;
    color: var(--text-muted);
    border-radius: 50%;
    transition: all 150ms ease;
    background: transparent;
    border: none;
  }

  .nav-dropdown-toggle:hover,
  .nav-dropdown-toggle.open {
    color: var(--gold);
    background: var(--bg-hover);
  }

  .nav-dropdown-backdrop {
    position: fixed;
    inset: 0;
    background: transparent;
    z-index: 99;
    border: none;
  }

  .nav-dropdown {
    position: absolute;
    top: calc(100% + 0.5rem);
    right: 0;
    background: var(--bg-surface);
    border: 1px solid var(--border-hover);
    border-radius: 1rem;
    padding: 0.4rem;
    min-width: 140px;
    z-index: 100;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    animation: dropdown-in 150ms ease;
  }

  @keyframes dropdown-in {
    from { opacity: 0; transform: translateY(-4px) scale(0.95); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }

  .nav-dropdown-item {
    display: block;
    padding: 0.6rem 1rem;
    font-size: 0.85rem;
    font-family: var(--font-body);
    color: var(--text-secondary);
    text-decoration: none;
    border-radius: 0.75rem;
    transition: all 100ms ease;
  }

  .nav-dropdown-item:hover {
    background: var(--bg-hover);
    color: var(--gold);
  }

  /* Status emoji dropdown */
  .status-wrapper {
    position: relative;
  }

  .status-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    font-size: 1rem;
    background: transparent;
    border: none;
    border-radius: 50%;
    cursor: pointer;
    transition: background 150ms ease;
    line-height: 1;
  }

  .status-toggle:hover {
    background: var(--bg-hover);
  }

  .status-backdrop {
    position: fixed;
    inset: 0;
    background: transparent;
    z-index: 99;
    border: none;
  }

  .status-dropdown {
    position: absolute;
    top: calc(100% + 0.5rem);
    right: 0;
    background: var(--bg-surface);
    border: 1px solid var(--border-hover);
    border-radius: 1rem;
    padding: 0.4rem;
    min-width: 200px;
    z-index: 100;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    animation: dropdown-in 150ms ease;
  }

  .status-option {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    width: 100%;
    padding: 0.5rem 0.75rem;
    background: none;
    border: none;
    border-radius: 0.75rem;
    cursor: pointer;
    transition: background 100ms ease;
    text-align: left;
  }

  .status-option:hover {
    background: var(--bg-hover);
  }

  .status-option.active {
    background: var(--gold-glow);
  }

  .status-emoji {
    font-size: 1.1rem;
    flex-shrink: 0;
  }

  .status-label {
    font-size: 0.8rem;
    color: var(--text-secondary);
    font-family: var(--font-body);
  }

  .status-option:hover .status-label {
    color: var(--gold);
  }

  .status-clear {
    border-top: 1px solid var(--border);
    margin-top: 0.25rem;
    padding-top: 0.5rem;
    justify-content: center;
  }

  .status-clear .status-label {
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  .settings-link {
    display: flex;
    align-items: center;
    color: var(--text-muted);
    transition: color var(--transition);
  }

  .settings-link:hover {
    color: var(--gold-dim);
    text-decoration: none;
  }

  .canvas-trigger-wrapper {
    position: relative;
  }

  .chat-timer {
    display: flex;
    align-items: center;
  }

  .header-icon-btn {
    display: flex;
    align-items: center;
    color: var(--text-muted);
    padding: 0.25rem;
    border-radius: 0.25rem;
    transition: color var(--transition);
  }

  .header-icon-btn:hover {
    color: var(--gold-dim);
  }

  /* Hide search on mobile to make room for timer */
  @media (max-width: 768px) {
    .search-btn {
      display: none;
    }
  }

  .header-icon-btn.active {
    color: var(--gold);
  }

  .stop-btn {
    color: var(--status-error, #ef4444) !important;
    animation: stopPulse 1.5s ease-in-out infinite;
  }

  .stop-btn:hover {
    color: #ff6b6b !important;
  }

  @keyframes stopPulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }

  .compaction-banner {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    background: rgba(245, 197, 66, 0.08);
    border-bottom: 1px solid rgba(245, 197, 66, 0.2);
    color: var(--gold-dim);
    font-size: 0.8125rem;
    flex-shrink: 0;
    animation: bannerFadeIn 0.3s ease-out;
  }

  .compaction-banner.compacting {
    animation: bannerFadeIn 0.3s ease-out, compactingPulse 2s ease-in-out infinite;
  }

  @keyframes bannerFadeIn {
    from { opacity: 0; transform: translateY(-0.25rem); }
    to { opacity: 1; transform: translateY(0); }
  }

  @keyframes compactingPulse {
    0%, 100% { background: rgba(245, 197, 66, 0.08); }
    50% { background: rgba(245, 197, 66, 0.16); }
  }

  .rate-limit-banner {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    background: rgba(94, 171, 165, 0.08);
    border-bottom: 1px solid rgba(94, 171, 165, 0.15);
    color: var(--gold-bright, #7cc5c0);
    font-size: 0.8125rem;
    flex-shrink: 0;
    animation: bannerFadeIn 0.3s ease-out;
  }

  .messages-container {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    background: var(--bg-primary);
  }

  .messages-list {
    display: flex;
    flex-direction: column;
    padding: 1.5rem 1rem;
    min-height: 100%;
    max-width: 48rem;
    margin: 0 auto;
    width: 100%;
  }

  .loading-older,
  .thread-start {
    text-align: center;
    padding: 1rem;
    font-size: 0.75rem;
    color: var(--text-muted);
    letter-spacing: 0.04em;
  }

  .loading-older {
    font-style: italic;
  }

  .thread-start {
    font-family: var(--font-heading);
    opacity: 0.5;
  }

  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    color: var(--text-muted);
    font-family: var(--font-heading);
    font-size: 0.875rem;
    letter-spacing: 0.04em;
  }

  .message-wrapper {
    width: 100%;
    min-width: 0;
    display: flex;
  }

  :global(.message-wrapper.highlight-flash) {
    animation: highlightFlash 2s ease-out;
  }

  @keyframes highlightFlash {
    0% { background: rgba(245, 197, 66, 0.2); }
    100% { background: transparent; }
  }

  .activity-panel {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 1rem 1.25rem;
    border-radius: 0;
    align-self: flex-start;
    margin: 0.75rem 0;
    width: 100%;
  }

  .activity-header {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }

  .activity-label {
    font-size: 0.8125rem;
    color: var(--text-muted);
    margin-left: 0.25rem;
    font-style: italic;
    letter-spacing: 0.02em;
  }

  .activity-tools {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding-top: 0.25rem;
    border-top: 1px solid var(--border);
  }

  .activity-tool {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.75rem;
    font-family: var(--font-mono);
    opacity: 0.7;
    animation: fadeIn 0.3s ease-out;
  }

  .activity-tool.complete {
    opacity: 0.4;
  }

  .activity-tool.error {
    color: var(--error, #ef4444);
  }

  .tool-status {
    width: 1rem;
    text-align: center;
    flex-shrink: 0;
  }

  .activity-tool .tool-name {
    color: var(--gold-dim);
    white-space: nowrap;
  }

  .activity-tool .tool-input {
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tool-elapsed {
    color: var(--text-muted);
    font-size: 0.65rem;
    font-family: var(--font-mono);
    margin-left: auto;
    flex-shrink: 0;
  }

  .typing-dot {
    width: 0.3rem;
    height: 0.3rem;
    background: var(--gold-dim);
    border-radius: 50%;
    animation: typingBounce 1.4s infinite ease-in-out;
  }

  .typing-dot:nth-child(2) {
    animation-delay: 0.2s;
  }

  .typing-dot:nth-child(3) {
    animation-delay: 0.4s;
  }

  @keyframes typingBounce {
    0%, 60%, 100% {
      transform: translateY(0);
      opacity: 0.4;
    }
    30% {
      transform: translateY(-0.375rem);
      opacity: 1;
    }
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(-0.25rem); }
    to { opacity: 0.7; }
  }

  /* Mobile styles */
  @media (max-width: 768px) {
    .sidebar-overlay {
      display: block;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      z-index: 99;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.3s;
    }

    .sidebar-overlay:is(.open, :has(+ .sidebar.open)) {
      opacity: 1;
      pointer-events: auto;
    }

    .sidebar {
      position: fixed;
      top: 0;
      left: 0;
      bottom: 0;
      transform: translateX(-100%);
      transition: transform 0.3s;
      z-index: 100;
      width: 80%;
      max-width: 20rem;
    }

    .sidebar.open {
      transform: translateX(0);
    }

    .menu-button {
      display: block;
    }

    .chat-header {
      padding: calc(env(safe-area-inset-top, 0px) + 0.75rem) 0.75rem 0.75rem;
    }

    .messages-list {
      padding: 0.75rem;
      max-width: 100%;
    }

    .chat-header {
      gap: 0.5rem;
    }

    .header-info {
      gap: 0.375rem;
      min-width: 0;
    }

    .header-title {
      font-size: 1.0625rem;
    }

    .header-actions {
      gap: 0.25rem;
      flex-shrink: 0;
    }
  }

  /* Mira presence tag — she's in the room */
  .mira-presence-tag {
    padding: 0.25rem 1rem 0.25rem 2.5rem;
    animation: mira-fade-in 0.4s ease;
  }

  .mira-presence-inner {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.2rem 0.7rem;
    background: rgba(147, 112, 168, 0.12);
    border: 1px solid rgba(168, 139, 186, 0.18);
    border-radius: 10px;
    max-width: 80%;
  }

  .mira-name {
    font-size: 0.75rem;
    font-weight: 600;
    color: #a8c4a0;
    line-height: 1.3;
  }

  .mira-response {
    font-size: 0.75rem;
    font-style: italic;
    color: #b89ec7;
    line-height: 1.3;
  }

  @keyframes mira-fade-in {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
