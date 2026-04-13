<script lang="ts">
  let {
    onresult,
    onclose,
  } = $props<{
    onresult?: (result: { messageId: string; threadId: string }) => void;
    onclose?: () => void;
  }>();

  interface SearchHit {
    messageId: string;
    threadId: string;
    threadName: string;
    role: string;
    highlight: string;
    createdAt: string;
  }

  let query = $state('');
  let afterDate = $state('');
  let beforeDate = $state('');
  let showDateFilters = $state(false);
  let results = $state<SearchHit[]>([]);
  let total = $state(0);
  let loading = $state(false);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let inputEl: HTMLInputElement;

  function handleInput() {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (!query.trim()) {
      results = [];
      total = 0;
      return;
    }
    debounceTimer = setTimeout(() => doSearch(), 300);
  }

  async function doSearch() {
    const q = query.trim();
    if (!q) return;
    loading = true;
    try {
      let url = `/api/search?q=${encodeURIComponent(q)}&limit=30`;
      if (afterDate) url += `&after=${encodeURIComponent(afterDate)}`;
      if (beforeDate) url += `&before=${encodeURIComponent(beforeDate)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error('Search failed');
      const data = await res.json();
      results = data.results;
      total = data.total;
    } catch (err) {
      console.error('Search error:', err);
      results = [];
      total = 0;
    } finally {
      loading = false;
    }
  }

  function handleDateChange() {
    if (query.trim()) {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => doSearch(), 300);
    }
  }

  function handleResultClick(hit: SearchHit) {
    onresult?.({ messageId: hit.messageId, threadId: hit.threadId });
    onclose?.();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      onclose?.();
    }
  }

  function formatTime(ts: string): string {
    const d = new Date(ts);
    const now = new Date();
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    const diffDays = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return time;
    if (diffDays === 1) return `Yesterday ${time}`;
    if (diffDays < 7) return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${time}`;
    return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${time}`;
  }

  $effect(() => {
    inputEl?.focus();
  });
</script>

<div class="search-overlay" role="dialog" aria-label="Search messages">
  <button class="search-backdrop" onclick={() => onclose?.()} aria-label="Close search"></button>
  <div class="search-panel" onkeydown={handleKeydown}>
    <div class="search-header">
      <svg class="search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
      </svg>
      <input
        bind:this={inputEl}
        class="search-input"
        type="text"
        placeholder="Search messages..."
        bind:value={query}
        oninput={handleInput}
      />
      {#if loading}
        <span class="search-spinner"></span>
      {/if}
      <button class="search-filter-toggle" onclick={() => showDateFilters = !showDateFilters} aria-label="Toggle date filters" title="Filter by date">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
      </button>
      <button class="search-close" onclick={() => onclose?.()} aria-label="Close">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
      </button>
    </div>

    {#if showDateFilters}
      <div class="search-date-filters">
        <div class="date-field">
          <label for="search-after">From</label>
          <input id="search-after" type="datetime-local" bind:value={afterDate} onchange={handleDateChange} />
        </div>
        <div class="date-field">
          <label for="search-before">To</label>
          <input id="search-before" type="datetime-local" bind:value={beforeDate} onchange={handleDateChange} />
        </div>
        {#if afterDate || beforeDate}
          <button class="date-clear" onclick={() => { afterDate = ''; beforeDate = ''; handleDateChange(); }}>Clear</button>
        {/if}
      </div>
    {/if}

    {#if results.length > 0}
      <div class="search-results">
        {#if total > results.length}
          <div class="search-meta">{total} results found</div>
        {/if}
        {#each results as hit (hit.messageId)}
          <button class="search-result" onclick={() => handleResultClick(hit)}>
            <div class="result-header">
              <span class="result-role" class:companion={hit.role === 'companion'}>{hit.role === 'companion' ? 'Companion' : 'You'}</span>
              <span class="result-thread">{hit.threadName}</span>
              <span class="result-time">{formatTime(hit.createdAt)}</span>
            </div>
            <div class="result-highlight">{hit.highlight}</div>
          </button>
        {/each}
      </div>
    {:else if query.trim() && !loading}
      <div class="search-empty">No messages found</div>
    {/if}
  </div>
</div>

<style>
  .search-overlay {
    position: fixed;
    inset: 0;
    z-index: 200;
    display: flex;
    justify-content: center;
    padding-top: 10vh;
  }

  .search-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
  }

  .search-panel {
    position: relative;
    z-index: 201;
    width: 90%;
    max-width: 36rem;
    max-height: 70vh;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    animation: searchSlideIn 0.15s ease-out;
  }

  @keyframes searchSlideIn {
    from { opacity: 0; transform: translateY(-0.5rem); }
    to { opacity: 1; transform: translateY(0); }
  }

  .search-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.875rem 1rem;
    border-bottom: 1px solid var(--border);
  }

  .search-icon {
    flex-shrink: 0;
    color: var(--gold-dim);
  }

  .search-input {
    flex: 1;
    background: transparent;
    border: none;
    color: var(--text-primary);
    font-size: 1rem;
    outline: none;
  }

  .search-input::placeholder {
    color: var(--text-muted);
  }

  .search-close {
    flex-shrink: 0;
    padding: 0.25rem;
    color: var(--text-muted);
    border-radius: 0.25rem;
    transition: color 0.15s;
  }

  .search-close:hover {
    color: var(--text-primary);
  }

  .search-filter-toggle {
    flex-shrink: 0;
    padding: 0.25rem;
    color: var(--text-muted);
    border-radius: 0.25rem;
    transition: color 0.15s;
  }

  .search-filter-toggle:hover {
    color: var(--gold);
  }

  .search-date-filters {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }

  .date-field {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }

  .date-field label {
    font-size: 0.6875rem;
    color: var(--text-muted);
    letter-spacing: 0.04em;
    white-space: nowrap;
  }

  .date-field input[type="datetime-local"] {
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    border-radius: 0.25rem;
    color: var(--text-primary);
    font-size: 0.75rem;
    padding: 0.25rem 0.375rem;
    outline: none;
    font-family: var(--font-body);
    color-scheme: dark;
  }

  .date-field input[type="datetime-local"]:focus {
    border-color: var(--gold-dim);
  }

  @media (max-width: 600px) {
    .search-date-filters {
      flex-direction: column;
      gap: 0.5rem;
    }
    .date-field {
      width: 100%;
    }
    .date-field input[type="datetime-local"] {
      flex: 1;
    }
  }

  .date-clear {
    font-size: 0.6875rem;
    color: var(--gold-dim);
    padding: 0.25rem 0.5rem;
    border-radius: 0.25rem;
    transition: color 0.15s;
  }

  .date-clear:hover {
    color: var(--gold);
  }

  .search-spinner {
    width: 1rem;
    height: 1rem;
    border: 2px solid var(--gold-dim);
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
    flex-shrink: 0;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .search-results {
    flex: 1;
    overflow-y: auto;
    padding: 0.25rem 0;
  }

  .search-meta {
    padding: 0.375rem 1rem;
    font-size: 0.6875rem;
    color: var(--text-muted);
    letter-spacing: 0.04em;
  }

  .search-result {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    width: 100%;
    padding: 0.75rem 1rem;
    text-align: left;
    background: transparent;
    color: var(--text-primary);
    cursor: pointer;
    transition: background 0.15s;
  }

  .search-result:hover {
    background: var(--bg-tertiary);
  }

  .result-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.75rem;
  }

  .result-role {
    font-family: var(--font-heading);
    color: var(--mary-accent);
    letter-spacing: 0.04em;
  }

  .result-role.companion {
    color: var(--gold);
  }

  .result-thread {
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .result-time {
    margin-left: auto;
    color: var(--text-muted);
    font-size: 0.6875rem;
    white-space: nowrap;
  }

  .result-highlight {
    font-size: 0.875rem;
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    line-height: 1.4;
  }

  .search-empty {
    padding: 2rem 1rem;
    text-align: center;
    color: var(--text-muted);
    font-size: 0.875rem;
  }
</style>
