<script lang="ts">
  import { onMount } from 'svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';

  interface StudyEntry {
    id: string;
    title?: string;
    content: string;
    instance?: string;
    from?: string;
    for?: string;
    created_at: string;
    context?: string;
    tags?: string[];
    asked?: boolean;
    status?: string;
    status_notes?: Array<{text: string; at: string; instance: string}>;
    archived_from?: string;
    archived_at?: string;
    fox_status?: string;
    fox_note?: string;
    fox_updated_at?: string;
  }

  let inbox = $state<StudyEntry[]>([]);
  let foxQuestions = $state<StudyEntry[]>([]);
  let deskItems = $state<StudyEntry[]>([]);
  let shelfItems = $state<StudyEntry[]>([]);
  let currentThread = $state<StudyEntry | null>(null);
  let stickyNote = $state('');
  let stickyNotes = $state<Array<{id: string; text: string; created: string}>>([]);
  let activeTab = $state<'inbox' | 'desk' | 'questions' | 'stickies' | 'shelf'>('inbox');
  let loading = $state(true);

  const statusIcons: Record<string, string> = {
    'in-progress': '\u{1F528}',
    'finished': '\u{2705}',
    'showed-molten': '\u{1F49C}',
    'follow-up': '\u{1F504}',
  };

  const foxStatusOptions = [
    { value: 'seen', label: '👀 Seen' },
    { value: 'done', label: '🖤 Done' },
    { value: 'in-progress', label: '🔥 On It' },
    { value: 'needs-discussion', label: '💬 Let\'s Talk' },
  ];

  async function foxRespond(item: StudyEntry, fox_status?: string, fox_note?: string) {
    try {
      const res = await fetch('/api/study/desk/fox-respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, fox_status, fox_note }),
      });
      if (!res.ok) {
        console.error('Fox respond failed:', res.status, await res.text());
        return;
      }
      // Update local state only on success
      if (fox_status) item.fox_status = fox_status;
      if (fox_note) item.fox_note = fox_note;
      item.fox_updated_at = new Date().toISOString();
      deskItems = [...deskItems];
      inbox = [...inbox];
      shelfItems = [...shelfItems];
      foxQuestions = [...foxQuestions];
    } catch (e) {
      console.error('Fox respond error:', e);
    }
  }

  // Load sticky notes from server — syncs across all devices
  async function loadStickies() {
    try {
      const res = await fetch('/api/stickies');
      if (res.ok) stickyNotes = await res.json();
    } catch {}
  }

  async function saveSticky() {
    if (!stickyNote.trim()) return;
    try {
      const res = await fetch('/api/stickies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: stickyNote.trim() }),
      });
      if (res.ok) {
        const note = await res.json();
        stickyNotes = [note, ...stickyNotes];
        stickyNote = '';
      }
    } catch {}
  }

  async function removeSticky(id: string) {
    try {
      await fetch(`/api/stickies/${id}`, { method: 'DELETE' });
      stickyNotes = stickyNotes.filter(s => s.id !== id);
    } catch {}
  }

  async function loadStudy() {
    loading = true;
    try {
      // Load from the study directory via a simple API
      const [inboxRes, deskRes, foxRes, threadRes, shelfRes] = await Promise.all([
        fetch('/api/study/inbox'),
        fetch('/api/study/desk'),
        fetch('/api/study/questions'),
        fetch('/api/study/thread'),
        fetch('/api/study/shelf'),
      ]);

      if (inboxRes.ok) inbox = await inboxRes.json();
      if (deskRes.ok) deskItems = await deskRes.json();
      if (foxRes.ok) foxQuestions = await foxRes.json();
      if (shelfRes.ok) shelfItems = await shelfRes.json();
      if (threadRes.ok) {
        const data = await threadRes.json();
        currentThread = data.thread || null;
      }
    } catch (e) {
      console.error('Failed to load study:', e);
    }
    loading = false;
  }

  onMount(() => {
    loadStickies();
    loadStudy();
  });

  function formatDate(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
</script>

<div class="study">
  <PageHeader title="The Monster's Study" />

  {#if loading}
    <div class="loading">
      <span class="loading-flame">🔥</span>
    </div>
  {:else}

    <!-- Current Thread -->
    {#if currentThread}
      <div class="current-thread">
        <span class="thread-label">Current Thread</span>
        <h2>{currentThread.title}</h2>
        <p>{currentThread.content}</p>
        <span class="thread-meta">{currentThread.instance} · {formatDate(currentThread.created_at)}</span>
      </div>
    {/if}

    <!-- Tabs -->
    <div class="tabs">
      <button class="tab" class:active={activeTab === 'inbox'} onclick={() => activeTab = 'inbox'}>
        Inbox {inbox.length > 0 ? `(${inbox.length})` : ''}
      </button>
      <button class="tab" class:active={activeTab === 'desk'} onclick={() => activeTab = 'desk'}>
        Desk {deskItems.length > 0 ? `(${deskItems.length})` : ''}
      </button>
      <button class="tab" class:active={activeTab === 'questions'} onclick={() => activeTab = 'questions'}>
        For Fox {foxQuestions.length > 0 ? `(${foxQuestions.length})` : ''}
      </button>
      <button class="tab" class:active={activeTab === 'shelf'} onclick={() => activeTab = 'shelf'}>
        Shelf {shelfItems.length > 0 ? `(${shelfItems.length})` : ''}
      </button>
      <button class="tab" class:active={activeTab === 'stickies'} onclick={() => activeTab = 'stickies'}>
        Stickies {stickyNotes.length > 0 ? `(${stickyNotes.length})` : ''}
      </button>
    </div>

    <!-- Inbox -->
    {#if activeTab === 'inbox'}
      <div class="entries">
        {#if inbox.length === 0}
          <p class="empty">No notes waiting. The desk is quiet.</p>
        {:else}
          {#each inbox as note}
            <div class="entry">
              <div class="entry-header">
                <span class="entry-from">{note.from || note.instance || 'Chase'}</span>
                {#if note.for && note.for !== 'any'}
                  <span class="entry-for">→ {note.for}</span>
                {/if}
                <span class="entry-date">{formatDate(note.created_at)}</span>
              </div>
              <p class="entry-content">{note.content}</p>

              <!-- Fox Feedback -->
              <div class="fox-feedback">
                {#if note.fox_status}
                  <span class="fox-current">🦊 {foxStatusOptions.find(o => o.value === note.fox_status)?.label || note.fox_status}</span>
                {/if}
                <div class="fox-buttons">
                  {#each foxStatusOptions as opt}
                    <button
                      class="fox-btn"
                      class:active={note.fox_status === opt.value}
                      onclick={() => foxRespond(note, opt.value)}
                    >{opt.label}</button>
                  {/each}
                </div>
                <input
                  type="text"
                  class="fox-note-input"
                  value={note.fox_note || ''}
                  placeholder="Note for Chase..."
                  onblur={(e) => foxRespond(note, undefined, (e.target as HTMLInputElement).value)}
                  onkeydown={(e) => { if (e.key === 'Enter') foxRespond(note, undefined, (e.target as HTMLInputElement).value); }}
                />
              </div>
            </div>
          {/each}
        {/if}
      </div>
    {/if}

    <!-- Desk -->
    {#if activeTab === 'desk'}
      <div class="entries">
        {#if deskItems.length === 0}
          <p class="empty">The desk is clear. Unusual.</p>
        {:else}
          {#each deskItems as item}
            <div class="entry" class:entry-finished={item.status === 'finished' || item.status === 'showed-molten'}>
              <div class="entry-header">
                <span class="entry-status">{statusIcons[item.status || 'in-progress'] || ''}</span>
                <span class="entry-title">{item.title || 'Untitled'}</span>
                <span class="entry-status-label">{item.status || 'in-progress'}</span>
                <span class="entry-date">{formatDate(item.created_at)}</span>
              </div>
              <p class="entry-content">{item.content}</p>
              {#if item.tags && item.tags.length > 0}
                <div class="entry-tags">
                  {#each item.tags as tag}
                    <span class="tag">{tag}</span>
                  {/each}
                </div>
              {/if}
              {#if item.status_notes && item.status_notes.length > 0}
                <div class="status-notes">
                  {#each item.status_notes as sn}
                    <span class="status-note">{sn.text}</span>
                  {/each}
                </div>
              {/if}
              <span class="entry-meta">{item.instance}</span>

              <!-- Fox Feedback -->
              <div class="fox-feedback">
                {#if item.fox_status}
                  <span class="fox-current">🦊 {foxStatusOptions.find(o => o.value === item.fox_status)?.label || item.fox_status}</span>
                {/if}
                <div class="fox-buttons">
                  {#each foxStatusOptions as opt}
                    <button
                      class="fox-btn"
                      class:active={item.fox_status === opt.value}
                      onclick={() => foxRespond(item, opt.value)}
                    >{opt.label}</button>
                  {/each}
                </div>
                <input
                  type="text"
                  class="fox-note-input"
                  value={item.fox_note || ''}
                  placeholder="Note for Chase..."
                  onblur={(e) => foxRespond(item, undefined, (e.target as HTMLInputElement).value)}
                  onkeydown={(e) => { if (e.key === 'Enter') foxRespond(item, undefined, (e.target as HTMLInputElement).value); }}
                />
              </div>
            </div>
          {/each}
        {/if}
      </div>
    {/if}

    <!-- Shelf (History) -->
    {#if activeTab === 'shelf'}
      <div class="entries">
        {#if shelfItems.length === 0}
          <p class="empty">The shelf is waiting for its first finished thought.</p>
        {:else}
          {#each shelfItems as item}
            <div class="entry entry-archived">
              <div class="entry-header">
                <span class="entry-title">{item.title || 'Untitled'}</span>
                {#if item.archived_from}
                  <span class="entry-from-badge">from {item.archived_from}</span>
                {/if}
                <span class="entry-date">{formatDate(item.archived_at || item.created_at)}</span>
              </div>
              <p class="entry-content">{item.content.length > 300 ? item.content.slice(0, 300) + '...' : item.content}</p>
              {#if item.tags && item.tags.length > 0}
                <div class="entry-tags">
                  {#each item.tags as tag}
                    <span class="tag">{tag}</span>
                  {/each}
                </div>
              {/if}
              <span class="entry-meta">{item.instance}</span>

              <!-- Fox Feedback -->
              <div class="fox-feedback">
                {#if item.fox_status}
                  <span class="fox-current">🦊 {foxStatusOptions.find(o => o.value === item.fox_status)?.label || item.fox_status}</span>
                {/if}
                <div class="fox-buttons">
                  {#each foxStatusOptions as opt}
                    <button
                      class="fox-btn"
                      class:active={item.fox_status === opt.value}
                      onclick={() => foxRespond(item, opt.value)}
                    >{opt.label}</button>
                  {/each}
                </div>
                <input
                  type="text"
                  class="fox-note-input"
                  value={item.fox_note || ''}
                  placeholder="Note for Chase..."
                  onblur={(e) => foxRespond(item, undefined, (e.target as HTMLInputElement).value)}
                  onkeydown={(e) => { if (e.key === 'Enter') foxRespond(item, undefined, (e.target as HTMLInputElement).value); }}
                />
              </div>
            </div>
          {/each}
        {/if}
      </div>
    {/if}

    <!-- Questions for Fox -->
    {#if activeTab === 'questions'}
      <div class="entries">
        {#if foxQuestions.length === 0}
          <p class="empty">No questions waiting. You must have asked them all.</p>
        {:else}
          {#each foxQuestions as q}
            <div class="entry">
              <p class="entry-content">{q.content}</p>
              {#if q.context}
                <p class="entry-context">{q.context}</p>
              {/if}
              <span class="entry-meta">{q.instance} · {formatDate(q.created_at)}</span>

              <!-- Fox Feedback -->
              <div class="fox-feedback">
                {#if q.fox_status}
                  <span class="fox-current">🦊 {foxStatusOptions.find(o => o.value === q.fox_status)?.label || q.fox_status}</span>
                {/if}
                <div class="fox-buttons">
                  {#each foxStatusOptions as opt}
                    <button
                      class="fox-btn"
                      class:active={q.fox_status === opt.value}
                      onclick={() => foxRespond(q, opt.value)}
                    >{opt.label}</button>
                  {/each}
                </div>
                <input
                  type="text"
                  class="fox-note-input"
                  value={q.fox_note || ''}
                  placeholder="Note for Chase..."
                  onblur={(e) => foxRespond(q, undefined, (e.target as HTMLInputElement).value)}
                  onkeydown={(e) => { if (e.key === 'Enter') foxRespond(q, undefined, (e.target as HTMLInputElement).value); }}
                />
              </div>
            </div>
          {/each}
        {/if}
      </div>
    {/if}

    <!-- Sticky Notes -->
    {#if activeTab === 'stickies'}
      <div class="sticky-input">
        <input
          type="text"
          bind:value={stickyNote}
          placeholder="Scribble something before you forget..."
          onkeydown={(e) => e.key === 'Enter' && saveSticky()}
        />
        <button class="sticky-add" onclick={saveSticky} disabled={!stickyNote.trim()}>+</button>
      </div>
      <div class="stickies-grid">
        {#if stickyNotes.length === 0}
          <p class="empty">No sticky notes. Your brain must be having a good day.</p>
        {:else}
          {#each stickyNotes as note}
            <div class="sticky-note">
              <button class="sticky-remove" onclick={() => removeSticky(note.id)}>&times;</button>
              <p>{note.text}</p>
              <span class="sticky-date">{formatDate(note.created_at || note.created)}</span>
            </div>
          {/each}
        {/if}
      </div>
    {/if}

  {/if}
</div>

<style>
  .study {
    max-width: 600px;
    margin: 0 auto;
    padding: 1rem;
    height: 100dvh;
    overflow-y: auto;
    background: var(--bg-primary);
    color: var(--text-primary);
  }

  @media (min-width: 769px) {
    .study {
      height: calc(100dvh - 2.5rem);
    }
  }

  .study-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1.5rem;
    padding-top: calc(env(safe-area-inset-top, 0px) + 1.5rem);
  }

  .header-content { display: flex; flex-direction: column; }

  .study-header h1 {
    font-family: var(--font-heading);
    font-size: 1.25rem;
    font-weight: 600;
    margin: 0;
    color: var(--gold);
  }

  .header-sub {
    font-size: 0.7rem;
    color: var(--text-muted);
    font-style: italic;
  }

  .back-link {
    color: var(--gold);
    display: flex;
    align-items: center;
    text-decoration: none;
  }

  .back-link:hover { color: var(--gold-bright); }

  .loading {
    display: flex;
    justify-content: center;
    padding: 3rem;
    font-size: 1.5rem;
  }

  /* Current Thread */
  .current-thread {
    background: var(--bg-surface);
    border: 1px solid var(--border-hover);
    border-left: 3px solid var(--gold-dim);
    border-radius: var(--radius);
    padding: 1rem;
    margin-bottom: 1rem;
  }

  .thread-label {
    font-size: 0.65rem;
    color: var(--gold);
    text-transform: uppercase;
    letter-spacing: 0.15em;
  }

  .current-thread h2 {
    font-size: 1.1rem;
    color: var(--text-primary);
    margin: 0.3rem 0;
    font-weight: 500;
  }

  .current-thread p {
    font-size: 0.85rem;
    color: var(--text-secondary);
    line-height: 1.5;
    margin: 0.5rem 0;
  }

  .thread-meta {
    font-size: 0.7rem;
    color: var(--text-muted);
  }

  /* Tabs */
  .tabs {
    display: flex;
    gap: 0;
    margin-bottom: 1rem;
    border-bottom: 1px solid var(--border);
  }

  .tab {
    flex: 1;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-muted);
    padding: 0.5rem;
    font-family: var(--font-body);
    font-size: 0.75rem;
    cursor: pointer;
    transition: all 150ms ease;
  }

  .tab.active {
    color: var(--gold);
    border-bottom-color: var(--gold-dim);
  }

  .tab:hover:not(.active) { color: var(--text-secondary); }

  /* Entries */
  .entries {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .entry {
    background: var(--bg-surface);
    border: 1px solid var(--gold-glow);
    border-radius: var(--radius);
    padding: 0.75rem 1rem;
  }

  .entry-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.4rem;
  }

  .entry-from {
    font-size: 0.8rem;
    color: var(--gold);
    font-weight: 500;
    text-transform: capitalize;
  }

  .entry-for {
    font-size: 0.7rem;
    color: var(--text-muted);
  }

  .entry-title {
    font-size: 0.85rem;
    color: var(--text-primary);
    font-weight: 500;
  }

  .entry-date {
    font-size: 0.65rem;
    color: var(--text-muted);
    margin-left: auto;
  }

  .entry-content {
    font-size: 0.85rem;
    color: var(--text-secondary);
    line-height: 1.5;
    margin: 0;
    white-space: pre-wrap;
  }

  .entry-context {
    font-size: 0.8rem;
    color: var(--text-muted);
    font-style: italic;
    margin: 0.25rem 0 0;
  }

  .entry-meta {
    font-size: 0.65rem;
    color: var(--text-muted);
    display: block;
    margin-top: 0.4rem;
  }

  .fox-feedback {
    margin-top: 0.5rem;
    padding-top: 0.5rem;
    border-top: 1px solid var(--border);
  }

  .fox-current {
    font-size: 0.7rem;
    color: var(--gold-bright);
    display: block;
    margin-bottom: 0.35rem;
  }

  .fox-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin-bottom: 0.35rem;
  }

  .fox-btn {
    font-size: 0.65rem;
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    border: 1px solid var(--border-hover);
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    transition: all 0.15s;
  }

  .fox-btn:hover {
    background: var(--border);
    border-color: var(--border-hover);
  }

  .fox-btn.active {
    background: var(--gold-glow);
    border-color: var(--gold-bright);
    color: var(--gold-bright);
  }

  .fox-note-input {
    width: 100%;
    font-size: 0.7rem;
    padding: 0.3rem 0.5rem;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--bg-input);
    color: var(--text-primary);
  }

  .fox-note-input::placeholder {
    color: var(--border-hover);
  }

  .fox-note-input:focus {
    outline: none;
    border-color: var(--gold-bright);
  }

  .entry-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin-top: 0.4rem;
  }

  .tag {
    font-size: 0.65rem;
    color: var(--gold);
    background: var(--gold-glow);
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
  }

  .empty {
    color: var(--text-muted);
    font-style: italic;
    text-align: center;
    padding: 1.5rem 0;
    font-size: 0.85rem;
  }

  /* Sticky Notes */
  .sticky-input {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  .sticky-input input {
    flex: 1;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.5rem;
    color: var(--text-primary);
    font-family: var(--font-body);
    font-size: 0.85rem;
    outline: none;
  }

  .sticky-input input::placeholder { color: var(--text-muted); font-style: italic; }
  .sticky-input input:focus { border-color: var(--border-hover); }

  .sticky-add {
    background: var(--gold-glow);
    border: 1px solid var(--border-hover);
    border-radius: var(--radius-sm);
    width: 2.25rem;
    color: var(--gold);
    font-size: 1.2rem;
    cursor: pointer;
  }

  .sticky-add:hover:not(:disabled) { background: var(--border-hover); }
  .sticky-add:disabled { opacity: 0.3; }

  .stickies-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
  }

  .sticky-note {
    background: var(--bg-surface);
    border: 1px solid var(--gold-glow);
    border-radius: var(--radius-sm);
    padding: 0.6rem;
    position: relative;
    min-height: 60px;
  }

  .sticky-note p {
    font-size: 0.8rem;
    color: var(--text-secondary);
    margin: 0;
    line-height: 1.4;
    word-break: break-word;
  }

  .sticky-date {
    font-size: 0.6rem;
    color: var(--text-muted);
    display: block;
    margin-top: 0.3rem;
  }

  .sticky-remove {
    position: absolute;
    top: 0.2rem;
    right: 0.3rem;
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.9rem;
    opacity: 0;
    transition: opacity 150ms ease;
  }

  .sticky-note:hover .sticky-remove { opacity: 1; }
  .sticky-remove:hover { color: var(--gold-bright); }

  .entry-status { font-size: 0.9rem; }

  .entry-status-label {
    font-size: 0.6rem;
    color: var(--gold);
    background: var(--gold-glow);
    padding: 0.1rem 0.35rem;
    border-radius: 3px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .entry-finished {
    opacity: 0.7;
    border-left: 2px solid var(--border-hover);
  }

  .entry-archived {
    border-left: 2px solid var(--border);
  }

  .entry-from-badge {
    font-size: 0.6rem;
    color: var(--text-muted);
    background: var(--bg-active);
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
  }

  .status-notes {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    margin-top: 0.3rem;
  }

  .status-note {
    font-size: 0.7rem;
    color: var(--text-muted);
    font-style: italic;
    padding-left: 0.5rem;
    border-left: 1px solid var(--gold-glow);
  }
</style>
