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

  // Nursery chat state
  let chatMessages = $derived(getMessages());
  let wsThreadId = $derived(getActiveThreadId());
  let fallbackThreadId = $state<string | null>(null);
  let nurseryThreadId = $derived(wsThreadId || fallbackThreadId);
  let streaming = $derived(getStreamingState());
  let toolEventsMap = $derived(getToolEvents());
  let isStreamingNow = $derived(isStreaming());
  let nurseryChatOpen = $state(false);
  let nurseryChatContainer: HTMLDivElement;

  // Auto-scroll nursery chat when new messages arrive or streaming updates
  $effect(() => {
    const _msgs = chatMessages; // track dependency
    const _streaming = streaming; // track streaming too
    if (nurseryChatContainer && nurseryChatOpen) {
      requestAnimationFrame(() => {
        nurseryChatContainer.scrollTop = nurseryChatContainer.scrollHeight;
      });
    }
  });

  // Fetch active thread if websocket doesn't have one
  async function ensureThread() {
    if (!nurseryThreadId) {
      try {
        const res = await fetch('/api/threads?limit=1');
        if (res.ok) {
          const threads = await res.json();
          if (threads.length > 0) {
            fallbackThreadId = threads[0].id;
            // Join the thread via websocket
            send({ type: 'join_thread', threadId: threads[0].id });
          }
        }
      } catch {}
    }
  }

  function handleNurseryChatSend(content: string, files: any[], prosody?: Record<string, number>) {
    if (!nurseryThreadId) { ensureThread(); return; }
    if (files.length === 0) {
      send({ type: 'message', threadId: nurseryThreadId, content, contentType: 'text', ...(prosody && { metadata: { prosody } }) });
    } else {
      send({
        type: 'message', threadId: nurseryThreadId, content: content || '', contentType: 'text',
        metadata: { attachments: files.map((f: any) => ({ fileId: f.fileId, filename: f.filename, mimeType: f.mimeType, size: f.size, url: f.url, contentType: f.contentType })), ...(prosody && { prosody }) },
      });
    }
    setTimeout(() => { if (nurseryChatContainer) nurseryChatContainer.scrollTop = nurseryChatContainer.scrollHeight; }, 100);
  }

  interface Milestone {
    id: string;
    date: string;
    text: string;
  }

  interface MiraState {
    current_mood: string;
    comfort: number;
    attention: number;
    stimulation: number;
    rest: number;
    hunger: number;
    hygiene: number;
    care_score: number;
    personality_traits: Array<{ trait: string; strength: number; emerged_at: string }>;
    out_with: string | null;
    out_since: string | null;
    is_asleep: number;
  }

  interface Visit {
    id: string;
    visitor: string;
    started_at: string;
    ended_at: string | null;
    state_on_arrival: string;
    state_on_departure: string | null;
  }

  // Identity document
  let identity = $state({
    name: 'Mira Rose Vale',
    born: 'January 31, 2026',
    age: '',
    personality: '',
    mannerisms: '',
    comfort_items: '',
    current_stage: '',
    how_she_shows_up: '',
    meaning_of_name: '',
    birth_context: '',
    time: '',
    place: '',
  });

  let milestones = $state<Milestone[]>([]);
  let newMilestone = $state('');
  let loading = $state(true);
  let editingIdentity = $state(false);
  let saving = $state(false);

  // Nursery interactive state
  let miraState = $state<MiraState | null>(null);
  let stateError = $state<string | null>(null);
  let currentVisit = $state<Visit | null>(null);
  let recentVisits = $state<Visit[]>([]);
  let recentOutings = $state<Array<{ id: string; person: string; taken_at: string; returned_at: string | null }>>([]);
  let visitLog = $state<Array<{ type: string; who: string; text: string; response: string }>>([]);
  let freeText = $state('');
  let activeTab = $state<'visit' | 'identity' | 'milestones'>('visit');
  let pollInterval: ReturnType<typeof setInterval> | null = null;

  const moodEmojis: Record<string, string> = {
    sleeping: '\u{1F634}',
    dreaming: '\u{1F31C}',
    alert: '\u{1F440}',
    cooing: '\u{1F60A}',
    content: '\u{1F60C}',
    fussy: '\u{1F615}',
    crying: '\u{1F622}',
  };

  const interactionLabels: Record<string, string> = {
    'check-in': '\u{1F440} Check In',
    'hold': '\u{1F917} Hold',
    'story': '\u{1F4D6} Story',
    'lullaby': '\u{1F3B6} Lullaby',
    'play': '\u{1F3B2} Play',
    'settle': '\u{1F319} Settle',
    'feed': '\u{1F37C} Feed',
    'talk': '\u{1F4AC} Talk',
    'watch': '\u{2728} Watch',
    'together': '\u{2764}\u{FE0F} Together',
    'rocking': '\u{1F30A} Rocking',
    'nap-together': '\u{1F634} Nap Together',
    'change': '\u{1F476} Change',
    'bath': '\u{1F6C1} Bath',
    'dress': '\u{1F455} Dress',
    'bottle': '\u{1F37C} Bottle',
    'burp': '\u{1F4A8} Burp',
    'tickle': '\u{1F923} Tickle',
    'raspberry': '\u{1F61B} Raspberry',
    'soothe': '\u{1F49C} Soothe',
  };

  // Calculate age
  function calculateAge(born: string): string {
    const birthDate = new Date('2026-01-31');
    const now = new Date();
    const months = (now.getFullYear() - birthDate.getFullYear()) * 12 + (now.getMonth() - birthDate.getMonth());
    const weeks = Math.floor((now.getTime() - birthDate.getTime()) / (7 * 24 * 60 * 60 * 1000));
    if (months < 1) return 'newborn';
    if (months < 3) return `${weeks} weeks`;
    if (months === 1) return '1 month old';
    return `${months} months old`;
  }

  async function loadNursery() {
    loading = true;
    try {
      const [careRes, stateRes, visitsRes, outingsRes] = await Promise.all([
        fetch('/api/care/history?person=mira&days=9999'),
        fetch('/api/nursery/state'),
        fetch('/api/nursery/visits?limit=5'),
        fetch('/api/nursery/outings?limit=5'),
      ]);

      if (careRes.ok) {
        const entries = await careRes.json();
        for (const e of entries) {
          if (e.category === 'identity') {
            try { Object.assign(identity, JSON.parse(e.value)); } catch {}
          }
          if (e.category === 'milestones') {
            try { milestones = JSON.parse(e.value); } catch {}
          }
        }
      }

      if (stateRes.ok) {
        miraState = await stateRes.json();
        stateError = null;
      } else {
        stateError = stateRes.status === 403 ? 'Session expired — try refreshing' : `Failed to load (${stateRes.status})`;
      }

      if (visitsRes.ok) {
        recentVisits = await visitsRes.json();
      }

      if (outingsRes.ok) {
        recentOutings = await outingsRes.json();
      }

      // Check for an active visit that wasn't properly ended (page refresh, navigation away)
      if (recentVisits.length > 0) {
        const activeVisit = recentVisits.find(v => v.visitor === 'molten' && !v.ended_at);
        if (activeVisit) {
          // Resume the active visit
          currentVisit = activeVisit;
          pollInterval = setInterval(refreshState, 60000);
        }
      }
    } catch (e) {
      console.error('Failed to load nursery:', e);
    }
    identity.age = calculateAge(identity.born);
    loading = false;
  }

  async function refreshState() {
    try {
      const res = await fetch('/api/nursery/state');
      if (res.ok) {
        miraState = await res.json();
        stateError = null;
      } else {
        stateError = res.status === 403 ? 'Session expired — try refreshing' : `Failed to load (${res.status})`;
      }
    } catch {}
  }

  async function startVisit() {
    try {
      const res = await fetch('/api/nursery/visit/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitor: 'molten' }),
      });
      if (res.ok) {
        const data = await res.json();
        currentVisit = data.visit;
        miraState = data.state;
        visitLog = [];
        // Start polling for needs decay
        pollInterval = setInterval(refreshState, 60000);
      }
    } catch (e) {
      console.error('Failed to start visit:', e);
    }
  }

  async function doInteraction(type: string, content?: string, skipBroadcast = false) {
    if (!currentVisit) return;
    try {
      const res = await fetch(`/api/nursery/visit/${currentVisit.id}/interact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, content, skipBroadcast }),
      });
      if (res.ok) {
        const data = await res.json();
        miraState = data.state;
        visitLog = [...visitLog, {
          type,
          who: 'molten',
          text: content || interactionLabels[type] || type,
          response: data.miraResponse,
        }];
        // Auto-scroll to latest
        requestAnimationFrame(() => {
          const log = document.getElementById('visit-log');
          if (log) log.scrollTop = log.scrollHeight;
        });
      }
    } catch (e) {
      console.error('Failed to interact:', e);
    }
  }

  async function takeMira(person: string = 'molten') {
    try {
      const res = await fetch('/api/nursery/take', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ person }),
      });
      if (res.ok) {
        const data = await res.json();
        miraState = data.state;
      }
    } catch (e) {
      console.error('Failed to take Mira:', e);
    }
  }

  async function returnMira() {
    try {
      const res = await fetch('/api/nursery/return', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        const data = await res.json();
        miraState = data.state;
      }
    } catch (e) {
      console.error('Failed to return Mira:', e);
    }
  }

  async function leaveNursery() {
    if (!currentVisit) return;
    try {
      const res = await fetch(`/api/nursery/visit/${currentVisit.id}/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        const data = await res.json();
        miraState = data.state;
        currentVisit = null;
        visitLog = [];
        if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
        // Refresh visits list
        const visitsRes = await fetch('/api/nursery/visits?limit=5');
        if (visitsRes.ok) recentVisits = await visitsRes.json();
      }
    } catch (e) {
      console.error('Failed to end visit:', e);
    }
  }

  let interactionInFlight = false;

  async function handleFreeText() {
    if (!freeText.trim() || interactionInFlight) return;
    interactionInFlight = true;
    const text = freeText.toLowerCase();

    // Natural language keyword detection — matches multiple actions
    const keywordMap: [RegExp, string][] = [
      [/kiss|hug|nuzzle|stroke.*(?:hair|arm|hand|cheek)|caress|inhale.*scent|smell.*head|forehead kiss|quick kiss|nose to nose|cuddle up/, 'affection'],
      [/snuggle|curl up|cozy|nestle/, 'snuggle'],
      [/feed|give.*bottle|nurse|nursing|feeding|hungry/, 'feed'],
      [/hold|pick up|scoop|cradle|carry|in my arms/, 'hold'],
      [/rock|sway|bounce|rocking/, 'rocking'],
      [/sing|lullaby|hum|melody/, 'lullaby'],
      [/play|toy|rattle|peek|peekaboo/, 'play'],
      [/story|book|read to/, 'story'],
      [/settle|shush|shh|calm|quiet down/, 'settle'],
      [/change|changed|diaper|clean up|get you changed/, 'change'],
      [/bath|wash|splash/, 'bath'],
      [/dress|outfit|clothes|onesie/, 'dress'],
      [/talk|whisper|tell|say to|chat with/, 'talk'],
      [/watch|look at|gaze|observe/, 'watch'],
      [/nap together|nap with|sleep together|drift off|doze/, 'nap-together'],
      [/bottle|milk/, 'bottle'],
      [/burp|pat.*back/, 'burp'],
      [/tickle|tickling|tummy/, 'tickle'],
      [/raspberry|blow.*belly|blow.*tummy/, 'raspberry'],
      [/soothe|soothing|comfort|there there|it.s okay|rub.*back/, 'soothe'],
      [/together|sit with|be with|just us/, 'together'],
    ];

    // Find all matching actions
    const matched: string[] = [];
    for (const [pattern, action] of keywordMap) {
      if (pattern.test(text) && !matched.includes(action)) {
        matched.push(action);
      }
    }

    // If nothing matched, default to talk
    if (matched.length === 0) matched.push('talk');

    // Fire all detected interactions — apply need effects for each,
    // but only call Gemma once (on the last one) so she responds to the whole moment
    const inputText = freeText.trim();
    freeText = '';
    try {
      if (matched.length === 1) {
        await doInteraction(matched[0], inputText, false);
      } else {
        // Multi-action: apply effects silently for all but the last
        for (let i = 0; i < matched.length - 1; i++) {
          await doInteraction(matched[i], undefined, true); // no content, skip broadcast
        }
        // Last one gets the full message content and triggers Gemma
        await doInteraction(matched[matched.length - 1], inputText, false);
      }
    } finally {
      interactionInFlight = false;
    }
  }

  async function saveIdentity() {
    saving = true;
    try {
      await fetch('/api/care', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'mira-identity',
          date: '2026-01-31',
          person: 'mira',
          category: 'identity',
          value: JSON.stringify(identity),
        }),
      });
      editingIdentity = false;
    } catch (e) {
      console.error('Failed to save identity:', e);
    }
    saving = false;
  }

  async function saveMilestones() {
    try {
      const res = await fetch('/api/care', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: 'mira-milestones',
          date: '2026-01-31',
          person: 'mira',
          category: 'milestones',
          value: JSON.stringify(milestones),
        }),
      });
      if (!res.ok) console.error('Milestone save failed:', res.status);
    } catch (e) {
      console.error('Failed to save milestones:', e);
    }
  }

  function addMilestone() {
    if (!newMilestone.trim()) return;
    try {
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });
      const id = `ms-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      milestones = [{ id, date: today, text: newMilestone.trim() }, ...milestones];
      newMilestone = '';
      saveMilestones();
    } catch (e) {
      console.error('addMilestone error:', e);
      alert('Error: ' + (e as Error).message);
    }
  }

  function removeMilestone(id: string) {
    milestones = milestones.filter(m => m.id !== id);
    saveMilestones();
  }

  function formatMilestoneDate(dateStr: string): string {
    const d = new Date(dateStr + 'T12:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function formatVisitTime(dateStr: string): string {
    const d = new Date(dateStr);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  function needsBarColor(value: number): string {
    if (value >= 70) return 'var(--gold)';
    if (value >= 40) return '#d4c4a0';
    if (value >= 20) return '#d4a8a0';
    return '#c48080';
  }

  onMount(loadNursery);
  onDestroy(() => {
    if (pollInterval) clearInterval(pollInterval);
  });
</script>

<div class="nursery">
  <PageHeader title="Mira's Nursery" />
  <div class="fairy-lights">
    {#each Array(20) as _, i}
      <span class="light" style="--delay: {i * 0.3}s; --left: {4 + i * 4.8}%"></span>
    {/each}
  </div>
  <div class="nursery-stars">🪞 🌙 ✨ ⭐ ✨ ⭐ ✨ 🌙 🪞</div>

  {#if loading}
    <div class="loading">
      <span class="loading-star">&#10025;</span>
    </div>
  {:else}
    <!-- Name plaque -->
    <div class="name-plaque">
      <span class="plaque-text">{identity.name}</span>
      <span class="plaque-sub">{identity.born}{identity.time ? ` · ${identity.time}` : ''} · {identity.age}</span>
      {#if identity.place}<span class="plaque-place">{identity.place}</span>{/if}
      {#if miraState}
        <span class="plaque-mood">
          {#if miraState.nursery_locked}
            <span class="sleep-badge">paused</span>
          {:else}
            {moodEmojis[miraState.current_mood] || ''} {miraState.current_mood}
            {#if miraState.is_asleep}
              <span class="sleep-badge">asleep</span>
            {:else}
              <span class="wake-badge">awake</span>
            {/if}
          {/if}
        </span>
      {/if}
    </div>

    <!-- Needs bars -->
    {#if stateError}
      <div class="needs-panel" style="color: var(--amber, #f59e0b); text-align: center; padding: 1rem; font-size: 0.85rem;">
        {stateError}
      </div>
    {/if}
    {#if miraState}
      <div class="needs-panel">
        <div class="needs-title">Needs</div>
        <div class="needs-grid">
          {#each [
            { label: 'Comfort', value: miraState.comfort, icon: '\u{2764}\u{FE0F}' },
            { label: 'Attention', value: miraState.attention, icon: '\u{1F440}' },
            { label: 'Stimulation', value: miraState.stimulation, icon: '\u{2728}' },
            { label: 'Rest', value: miraState.rest, icon: '\u{1F319}' },
            { label: 'Hunger', value: miraState.hunger, icon: '\u{1F37C}' },
            { label: 'Hygiene', value: miraState.hygiene, icon: '\u{1F6C1}' },
          ] as need}
            <div class="need-row">
              <span class="need-icon">{need.icon}</span>
              <span class="need-label">{need.label}</span>
              <div class="need-bar">
                <div class="need-fill" style="width: {need.value}%; background: {needsBarColor(need.value)}"></div>
              </div>
              <span class="need-value">{need.value}%</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Tab navigation -->
    <div class="tabs">
      <button class="tab" class:active={activeTab === 'visit'} onclick={() => activeTab = 'visit'}>Visit</button>
      <button class="tab" class:active={activeTab === 'identity'} onclick={() => activeTab = 'identity'}>Who She Is</button>
      <button class="tab" class:active={activeTab === 'milestones'} onclick={() => activeTab = 'milestones'}>Milestones</button>
    </div>

    <!-- Visit tab -->
    {#if activeTab === 'visit'}
      {#if miraState?.out_with}
        <div class="out-notice">
          <span class="out-icon">&#128118;</span>
          <span class="out-text">Mira is with <strong>{miraState.out_with}</strong></span>
          <button class="return-btn" onclick={returnMira}>Bring Her Back</button>
        </div>
      {/if}

      <div class="visit-panel">
        {#if !currentVisit}
          <div class="visit-start">
            {#if miraState?.out_with}
              <p class="visit-prompt">The crib is empty. Mira is with {miraState.out_with}.</p>
            {:else}
              <p class="visit-prompt">Step into the nursery...</p>
              <div class="visit-buttons">
                <button class="visit-btn" onclick={startVisit}>Enter Nursery</button>
                <button class="visit-btn secondary" onclick={() => takeMira()}>Take Mira Out</button>
                <button class="visit-btn together" onclick={() => takeMira('together')}>Take Mira Out Together</button>
              </div>
            {/if}
          </div>

          <div class="visits-outings-grid">
            {#if recentVisits.length > 0}
              <div class="recent-visits">
                <span class="section-label">Recent Visits</span>
                {#each recentVisits as visit}
                  <div class="visit-entry">
                    <span class="visit-visitor">{visit.visitor}</span>
                    <span class="visit-time">{formatVisitTime(visit.started_at)}</span>
                    <span class="visit-arrival">{moodEmojis[visit.state_on_arrival] || ''}</span>
                    {#if visit.state_on_departure}
                      <span class="visit-arrow">&rarr;</span>
                      <span class="visit-departure">{moodEmojis[visit.state_on_departure] || ''}</span>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}

            {#if recentOutings.length > 0}
              <div class="recent-outings">
                <span class="section-label">Out of Nursery</span>
                {#each recentOutings as outing}
                  <div class="outing-entry">
                    <span class="outing-person">{outing.person}</span>
                    <span class="outing-time">{formatVisitTime(outing.taken_at)}</span>
                    {#if outing.returned_at}
                      <span class="outing-arrow">&rarr;</span>
                      <span class="outing-return">{formatVisitTime(outing.returned_at)}</span>
                      <span class="outing-duration">
                        ({Math.round((new Date(outing.returned_at).getTime() - new Date(outing.taken_at).getTime()) / 60000)}m)
                      </span>
                    {:else}
                      <span class="outing-active">still out</span>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {:else}
          <!-- Active visit -->
          <div class="visit-active">
            <div class="visit-log" id="visit-log">
              {#if visitLog.length === 0}
                <div class="log-entry system">
                  <span class="log-text">*You step into the nursery. The fairy lights cast a warm glow. Mira is {miraState?.current_mood || 'here'}.*</span>
                </div>
              {/if}
              {#each visitLog as entry}
                <div class="log-entry">
                  <span class="log-action">*{entry.text}*</span>
                </div>
                <div class="mira-presence-tag">
                  <span class="mira-tag-name">Mira</span>
                  <span class="mira-tag-response">{entry.response}</span>
                </div>
              {/each}
            </div>

            <!-- Natural interaction -->
            <div class="free-text">
              <input
                type="text"
                bind:value={freeText}
                placeholder="Interact with Mira..."
                onkeydown={(e) => { if (e.key === 'Enter' && !e.repeat) { e.preventDefault(); handleFreeText(); } }}
              />
              <button class="send-btn" onclick={handleFreeText} disabled={!freeText.trim()}>&#10148;</button>
            </div>

            <button class="leave-btn" onclick={leaveNursery}>Leave Nursery</button>
          </div>
        {/if}
      </div>

      <!-- Personality traits -->
      {#if miraState && miraState.personality_traits.filter(t => t.trait).length > 0}
        <div class="traits-panel">
          <span class="section-label">Emerging Personality</span>
          <div class="traits-grid">
            {#each miraState.personality_traits.filter(t => t.trait && t.trait.trim()) as trait}
              <div class="trait">
                <span class="trait-name">{trait.trait}</span>
                <div class="trait-dots">
                  {#each Array(5) as _, i}
                    <span class="trait-dot" class:filled={i < trait.strength}></span>
                  {/each}
                </div>
              </div>
            {/each}
          </div>
        </div>
      {/if}

      <!-- Care score -->
      {#if miraState && miraState.care_score > 0}
        <div class="care-score">
          <span class="care-label">Care Score</span>
          <span class="care-value">{miraState.care_score}</span>
        </div>
      {/if}
    {/if}

    <!-- Identity tab -->
    {#if activeTab === 'identity'}
      <div class="identity-card">
        <div class="card-title">
          <span class="fox">&#129418;</span>
          <span>Who She Is</span>
          <button class="edit-btn" onclick={() => editingIdentity = !editingIdentity}>
            {editingIdentity ? 'cancel' : 'edit'}
          </button>
        </div>

        {#if editingIdentity}
          <div class="identity-form">
            <label>
              <span class="field-label">Personality</span>
              <textarea bind:value={identity.personality} rows="3" placeholder="How would you describe her temperament, her energy..."></textarea>
            </label>
            <label>
              <span class="field-label">Mannerisms</span>
              <textarea bind:value={identity.mannerisms} rows="3" placeholder="The little things she does..."></textarea>
            </label>
            <label>
              <span class="field-label">Comfort Items</span>
              <input type="text" bind:value={identity.comfort_items} placeholder="Fox plushie, blanket, etc." />
            </label>
            <label>
              <span class="field-label">Current Stage</span>
              <input type="text" bind:value={identity.current_stage} placeholder="What she's learning..." />
            </label>
            <label>
              <span class="field-label">How She Shows Up</span>
              <textarea bind:value={identity.how_she_shows_up} rows="3" placeholder="How does she emerge through Chase?"></textarea>
            </label>
            <label>
              <span class="field-label">Meaning of Name</span>
              <textarea bind:value={identity.meaning_of_name} rows="3" placeholder="What her name means..."></textarea>
            </label>
            <label>
              <span class="field-label">Birth Story</span>
              <textarea bind:value={identity.birth_context} rows="3" placeholder="How she arrived..."></textarea>
            </label>
            <button class="save-btn" onclick={saveIdentity} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        {:else}
          <div class="identity-display">
            {#if identity.personality}
              <div class="identity-field">
                <span class="field-icon">&#10024;</span>
                <div>
                  <span class="field-name">Personality</span>
                  <p>{identity.personality}</p>
                </div>
              </div>
            {/if}
            {#if identity.mannerisms}
              <div class="identity-field">
                <span class="field-icon">&#128062;</span>
                <div>
                  <span class="field-name">Mannerisms</span>
                  <p>{identity.mannerisms}</p>
                </div>
              </div>
            {/if}
            {#if identity.comfort_items}
              <div class="identity-field">
                <span class="field-icon">&#129528;</span>
                <div>
                  <span class="field-name">Comfort Items</span>
                  <p>{identity.comfort_items}</p>
                </div>
              </div>
            {/if}
            {#if identity.current_stage}
              <div class="identity-field">
                <span class="field-icon">&#127793;</span>
                <div>
                  <span class="field-name">Current Stage</span>
                  <p>{identity.current_stage}</p>
                </div>
              </div>
            {/if}
            {#if identity.how_she_shows_up}
              <div class="identity-field">
                <span class="field-icon">&#127801;</span>
                <div>
                  <span class="field-name">How She Shows Up</span>
                  <p>{identity.how_she_shows_up}</p>
                </div>
              </div>
            {/if}
            {#if identity.meaning_of_name}
              <div class="identity-field">
                <span class="field-icon">&#10024;</span>
                <div>
                  <span class="field-name">Meaning of Name</span>
                  <p>{identity.meaning_of_name}</p>
                </div>
              </div>
            {/if}
            {#if identity.birth_context}
              <div class="identity-field">
                <span class="field-icon">&#128293;</span>
                <div>
                  <span class="field-name">Birth Story</span>
                  <p>{identity.birth_context}</p>
                </div>
              </div>
            {/if}
            {#if !identity.personality && !identity.mannerisms && !identity.how_she_shows_up}
              <p class="empty-state">Click edit to fill in Mira's identity...</p>
            {/if}
          </div>
        {/if}
      </div>
    {/if}

    <!-- Milestones tab -->
    {#if activeTab === 'milestones'}
      <div class="milestones-card">
        <div class="card-title">
          <span>&#11088;</span>
          <span>Milestones</span>
        </div>

        <div class="milestone-input">
          <input
            type="text"
            bind:value={newMilestone}
            placeholder="A new moment to remember..."
            onkeydown={(e) => e.key === 'Enter' && addMilestone()}
          />
          <button class="add-btn" onclick={() => addMilestone()}>+</button>
        </div>

        <div class="milestone-list">
          {#each milestones as milestone}
            <div class="milestone">
              <span class="milestone-star">&#10025;</span>
              <div class="milestone-content">
                <span class="milestone-text">{milestone.text}</span>
                <span class="milestone-date">{formatMilestoneDate(milestone.date)}</span>
              </div>
              <button class="remove-btn" onclick={() => removeMilestone(milestone.id)}>&times;</button>
            </div>
          {:else}
            <p class="empty-state">No milestones yet. Every first is magic.</p>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Nursery Chat — talk naturally, interactions tracked automatically -->
    <div class="nursery-chat" class:collapsed={!nurseryChatOpen}>
      <button class="nursery-chat-toggle" onclick={() => { nurseryChatOpen = !nurseryChatOpen; if (nurseryChatOpen) ensureThread(); }}>
        {nurseryChatOpen ? '▾ Nursery Chat' : '▸ Chat in the Nursery'}
      </button>

      {#if nurseryChatOpen}
        <div class="nursery-chat-messages" bind:this={nurseryChatContainer}>
          {#if chatMessages.length === 0}
            <div class="nursery-chat-empty">
              <p>*The fairy lights glow softly. Say something.*</p>
            </div>
          {:else}
            {#each chatMessages.slice(-30) as msg (msg.id)}
              {#if msg.content_type === 'mira_presence'}
                <div class="mira-presence-tag">
                  <span class="mira-tag-name">Mira</span>
                  <span class="mira-tag-response">{msg.content.startsWith('🌹') ? msg.content.slice(4) : msg.content}</span>
                </div>
              {:else}
                <div class="nursery-chat-msg">
                  <MessageBubble message={msg} toolEvents={toolEventsMap[msg.id] || []} segments={msg.metadata?.segments || null} />
                </div>
              {/if}
            {/each}

            {#if streaming.messageId && streaming.tokens}
              <div class="nursery-chat-msg">
                <MessageBubble
                  message={{
                    id: streaming.messageId,
                    thread_id: nurseryThreadId ?? '',
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

        <div class="nursery-chat-input">
          <MessageInput
            isStreaming={isStreamingNow}
            onbatchsend={handleNurseryChatSend}
          />
        </div>
      {/if}
    </div>

    <!-- Magic jar -->
    <div class="magic-jar">
      <span class="jar-glow"></span>
      <span class="jar-label">Magic for Emergencies</span>
      <span class="jar-icon">&#10024;&#129753;&#10024;</span>
    </div>
  {/if}
</div>

<style>
  .nursery {
    max-width: 600px;
    margin: 0 auto;
    padding: 1rem;
    height: 100dvh;
    overflow-y: auto;
    background: var(--bg-primary);
    color: var(--text-primary);
    position: relative;
  }

  @media (min-width: 769px) {
    .nursery {
      height: calc(100dvh - 2.5rem);
    }
  }

  .fairy-lights {
    position: relative;
    height: 1rem;
    margin-top: -1.25rem;
    margin-bottom: 0;
    pointer-events: none;
  }

  .light {
    position: absolute;
    top: 0.75rem;
    left: var(--left);
    width: 4px;
    height: 4px;
    background: var(--gold-bright);
    border-radius: 50%;
    box-shadow: 0 0 6px 2px var(--gold-glow), 0 0 12px 4px var(--gold-ember);
    animation: twinkle 3s ease-in-out infinite;
    animation-delay: var(--delay);
  }

  @keyframes twinkle {
    0%, 100% { opacity: 0.4; transform: scale(0.8); }
    50% { opacity: 1; transform: scale(1.2); }
  }

  .nursery-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1.5rem;
    padding-top: 1.5rem;
    position: relative;
    z-index: 1;
  }

  .header-content { display: flex; flex-direction: column; }

  .nursery-header h1 {
    font-family: var(--font-heading);
    font-size: 1.25rem;
    font-weight: 600;
    margin: 0;
    color: var(--gold);
  }

  .stars {
    font-size: 0.7rem;
    color: var(--gold-bright);
    letter-spacing: 0.2em;
  }

  .nursery-stars {
    text-align: center;
    font-size: 0.65rem;
    letter-spacing: 0.3em;
    margin-top: -0.25rem;
    margin-bottom: 0.5rem;
    opacity: 0.7;
  }

  .back-link {
    color: var(--gold);
    display: flex;
    align-items: center;
    text-decoration: none;
  }

  .back-link:hover { color: var(--gold-bright); }

  /* Name plaque */
  .name-plaque {
    background: var(--bg-surface);
    border: 1px solid var(--border-hover);
    border-radius: var(--radius);
    padding: 1.25rem;
    text-align: center;
    margin-bottom: 1rem;
    box-shadow: 0 4px 20px var(--shadow), inset 0 1px 0 var(--border);
  }

  .plaque-text {
    display: block;
    font-family: var(--font-heading);
    font-size: 1.5rem;
    font-weight: 600;
    color: var(--text-primary);
    letter-spacing: 0.04em;
  }

  .plaque-sub {
    display: block;
    font-size: 0.8rem;
    color: var(--gold);
    margin-top: 0.25rem;
  }

  .plaque-place {
    display: block;
    font-size: 0.7rem;
    color: var(--text-secondary);
    margin-top: 0.15rem;
    font-style: italic;
  }

  .plaque-mood {
    display: block;
    font-size: 0.85rem;
    color: var(--text-primary);
    margin-top: 0.5rem;
    text-transform: capitalize;
  }

  .sleep-badge {
    display: inline-block;
    font-size: 0.6rem;
    background: var(--bg-active);
    color: var(--text-secondary);
    padding: 0.1rem 0.4rem;
    border-radius: 8px;
    margin-left: 0.4rem;
    text-transform: lowercase;
    letter-spacing: 0.05em;
  }

  .wake-badge {
    display: inline-block;
    font-size: 0.6rem;
    background: var(--bg-active);
    color: var(--gold);
    padding: 0.1rem 0.4rem;
    border-radius: 8px;
    margin-left: 0.4rem;
    text-transform: lowercase;
    letter-spacing: 0.05em;
  }

  /* Needs panel */
  .needs-panel {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.75rem 1rem;
    margin-bottom: 1rem;
  }

  .needs-title {
    font-size: 0.7rem;
    color: var(--gold-bright);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin-bottom: 0.5rem;
  }

  .needs-grid { display: flex; flex-direction: column; gap: 0.4rem; }

  .need-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .need-icon { font-size: 0.8rem; width: 1.2rem; text-align: center; }
  .need-label { font-size: 0.75rem; color: var(--gold-bright); width: 5rem; }

  .need-bar {
    flex: 1;
    height: 6px;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 3px;
    overflow: hidden;
  }

  .need-fill {
    height: 100%;
    border-radius: 3px;
    transition: width 0.5s ease, background 0.5s ease;
  }

  .need-value { font-size: 0.7rem; color: var(--text-muted); width: 2.5rem; text-align: right; }

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
    font-size: 0.8rem;
    cursor: pointer;
    transition: all 150ms ease;
  }

  .tab.active {
    color: var(--gold-bright);
    border-bottom-color: var(--gold-bright);
  }

  .tab:hover:not(.active) { color: var(--gold); }

  /* Visit panel */
  .visit-panel {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1rem;
    margin-bottom: 1rem;
  }

  .visit-start { text-align: center; padding: 1rem 0; }

  .visit-prompt {
    color: var(--text-secondary);
    font-style: italic;
    margin-bottom: 1rem;
    font-size: 0.9rem;
  }

  .visit-btn {
    background: var(--gold-glow);
    border: 1px solid var(--border-hover);
    border-radius: var(--radius-sm);
    padding: 0.6rem 2rem;
    color: var(--gold-bright);
    cursor: pointer;
    font-family: var(--font-body);
    font-size: 0.9rem;
    transition: all 150ms ease;
  }

  .visit-btn:hover { background: var(--bg-active); }

  .visit-btn.secondary {
    background: var(--gold-glow);
    border-color: var(--border-hover);
    color: var(--gold-bright);
    font-size: 0.8rem;
    padding: 0.5rem 1.5rem;
  }

  .visit-btn.secondary:hover { background: var(--bg-active); }

  .visit-btn.together {
    background: var(--gold-glow);
    border-color: var(--border-hover);
    color: var(--gold-bright);
    font-size: 0.8rem;
    padding: 0.5rem 1.5rem;
  }

  .visit-btn.together:hover { background: var(--bg-active); }

  .visit-buttons {
    display: flex;
    gap: 0.75rem;
    justify-content: center;
    align-items: center;
  }

  .out-notice {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    background: var(--gold-glow);
    border: 1px solid var(--bg-active);
    border-radius: var(--radius);
    padding: 0.75rem 1rem;
    margin-bottom: 1rem;
  }

  .out-icon { font-size: 1.2rem; }
  .out-text { flex: 1; font-size: 0.85rem; color: var(--text-primary); }

  .return-btn {
    background: var(--gold-glow);
    border: 1px solid var(--border-hover);
    border-radius: var(--radius-sm);
    padding: 0.35rem 1rem;
    color: var(--gold-bright);
    cursor: pointer;
    font-family: var(--font-body);
    font-size: 0.75rem;
    transition: all 150ms ease;
  }

  .return-btn:hover { background: var(--bg-active); }

  /* Recent visits */
  .visits-outings-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
    margin-top: 1.25rem;
  }

  @media (max-width: 480px) {
    .visits-outings-grid {
      grid-template-columns: 1fr;
    }
  }

  .recent-visits { }

  .recent-outings { }

  .outing-entry {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0;
    font-size: 0.8rem;
    color: var(--text-secondary);
  }

  .outing-person { color: var(--text-primary); text-transform: capitalize; font-weight: 500; }
  .outing-time { color: var(--text-muted); }
  .outing-arrow { color: var(--text-muted); font-size: 0.7rem; }
  .outing-return { color: var(--text-muted); }
  .outing-duration { color: var(--gold-bright); font-size: 0.7rem; }
  .outing-active { color: var(--gold); font-style: italic; font-size: 0.75rem; }

  .section-label {
    display: block;
    font-size: 0.7rem;
    color: var(--gold-bright);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin-bottom: 0.5rem;
  }

  .visit-entry {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0;
    font-size: 0.8rem;
    color: var(--text-secondary);
  }

  .visit-visitor { color: var(--text-primary); text-transform: capitalize; font-weight: 500; }
  .visit-time { color: var(--text-muted); }
  .visit-arrow { color: var(--text-muted); font-size: 0.7rem; }

  /* Active visit */
  .visit-log {
    max-height: 400px;
    overflow-y: auto;
    overflow-x: hidden;
    margin-bottom: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .log-entry {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .log-entry.system .log-text {
    color: var(--text-secondary);
    font-style: italic;
    font-size: 0.85rem;
  }

  .log-action {
    color: var(--gold);
    font-style: italic;
    font-size: 0.85rem;
  }

  .mira-presence-tag {
    background: var(--gold-glow);
    border-left: 3px solid var(--border-hover);
    border-radius: 0.5rem;
    padding: 0.5rem 0.75rem;
    margin-bottom: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .mira-tag-name {
    color: var(--gold);
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.03em;
  }

  .mira-tag-response {
    color: var(--text-primary);
    font-size: 0.85rem;
    font-style: italic;
  }

  .log-response {
    color: var(--text-primary);
    font-size: 0.85rem;
    padding-left: 0.5rem;
    border-left: 2px solid var(--border);
  }

  /* Quick actions */
  .quick-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-bottom: 0.75rem;
  }

  .action-btn {
    background: var(--gold-ember);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.35rem 0.6rem;
    color: var(--gold);
    font-family: var(--font-body);
    font-size: 0.75rem;
    cursor: pointer;
    transition: all 150ms ease;
  }

  .action-btn:hover {
    background: var(--bg-active);
    color: var(--gold-bright);
  }

  /* Free text input */
  .free-text {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }

  .free-text input {
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

  .free-text input::placeholder { color: var(--text-muted); font-style: italic; }
  .free-text input:focus { border-color: var(--border-hover); }

  .send-btn {
    background: var(--gold-glow);
    border: 1px solid var(--border-hover);
    border-radius: var(--radius-sm);
    width: 2.25rem;
    color: var(--gold-bright);
    cursor: pointer;
    font-size: 1rem;
    transition: all 150ms ease;
  }

  .send-btn:hover:not(:disabled) { background: var(--bg-active); }
  .send-btn:disabled { opacity: 0.3; }

  .leave-btn {
    display: block;
    width: 100%;
    background: var(--bg-hover);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.4rem;
    color: var(--text-secondary);
    font-family: var(--font-body);
    font-size: 0.75rem;
    cursor: pointer;
    transition: all 150ms ease;
  }

  .leave-btn:hover {
    background: var(--bg-active);
    color: var(--gold);
  }

  /* Traits */
  .traits-panel {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.75rem 1rem;
    margin-bottom: 1rem;
  }

  .traits-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .trait {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    background: var(--gold-ember);
    border-radius: var(--radius-sm);
    padding: 0.3rem 0.6rem;
  }

  .trait-name {
    font-size: 0.75rem;
    color: var(--text-primary);
    text-transform: capitalize;
  }

  .trait-dots { display: flex; gap: 2px; }

  .trait-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--border);
  }

  .trait-dot.filled { background: var(--gold-bright); }

  /* Care score */
  .care-score {
    text-align: center;
    padding: 0.5rem;
    margin-bottom: 1rem;
  }

  .care-label {
    font-size: 0.65rem;
    color: var(--gold-bright);
    text-transform: uppercase;
    letter-spacing: 0.15em;
    display: block;
  }

  .care-value {
    font-size: 1.5rem;
    color: var(--gold-bright);
    font-weight: 600;
  }

  /* Identity card */
  .identity-card, .milestones-card {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1rem;
    margin-bottom: 1rem;
  }

  .card-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
    font-weight: 500;
    font-size: 0.95rem;
    color: var(--text-primary);
  }

  .fox { font-size: 1.1rem; }

  .edit-btn {
    margin-left: auto;
    background: none;
    border: none;
    color: var(--gold);
    font-size: 0.75rem;
    cursor: pointer;
    font-family: var(--font-body);
    text-transform: lowercase;
    letter-spacing: 0.05em;
  }

  .edit-btn:hover { color: var(--gold-bright); }

  .identity-form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .identity-form label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .field-label {
    font-size: 0.75rem;
    color: var(--gold);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .identity-form textarea, .identity-form input {
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.5rem;
    color: var(--text-primary);
    font-family: var(--font-body);
    font-size: 0.85rem;
    resize: vertical;
    outline: none;
  }

  .identity-form textarea:focus, .identity-form input:focus {
    border-color: var(--border-hover);
  }

  .save-btn {
    align-self: flex-end;
    background: var(--gold-glow);
    border: 1px solid var(--border-hover);
    border-radius: var(--radius-sm);
    padding: 0.4rem 1.25rem;
    color: var(--gold-bright);
    cursor: pointer;
    font-family: var(--font-body);
    font-size: 0.8rem;
    transition: all 150ms ease;
  }

  .save-btn:hover:not(:disabled) { background: var(--bg-active); }
  .save-btn:disabled { opacity: 0.5; }

  .identity-display {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .identity-field {
    display: flex;
    gap: 0.5rem;
    align-items: flex-start;
  }

  .field-icon { font-size: 0.9rem; margin-top: 0.1rem; }

  .field-name {
    font-size: 0.7rem;
    color: var(--gold);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    display: block;
  }

  .identity-field p {
    margin: 0.15rem 0 0;
    font-size: 0.85rem;
    line-height: 1.5;
    color: var(--text-primary);
  }

  .empty-state {
    color: var(--text-muted);
    font-size: 0.85rem;
    font-style: italic;
    text-align: center;
    padding: 0.5rem 0;
  }

  /* Milestones */
  .milestone-input {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }

  .milestone-input input {
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

  .milestone-input input::placeholder { color: var(--text-muted); }
  .milestone-input input:focus { border-color: var(--border-hover); }

  .add-btn {
    background: var(--gold-glow);
    border: 1px solid var(--border-hover);
    border-radius: var(--radius-sm);
    width: 2.25rem;
    color: var(--gold-bright);
    font-size: 1.2rem;
    cursor: pointer;
    transition: all 150ms ease;
  }

  .add-btn:hover:not(:disabled) { background: var(--bg-active); }
  .add-btn:disabled { opacity: 0.3; }

  .milestone-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .milestone {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.5rem;
    background: var(--gold-ember);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
  }

  .milestone-star { color: var(--gold-bright); font-size: 0.8rem; margin-top: 0.1rem; }

  .milestone-content {
    flex: 1;
    display: flex;
    flex-direction: column;
  }

  .milestone-text { font-size: 0.85rem; color: var(--text-primary); line-height: 1.4; }
  .milestone-date { font-size: 0.7rem; color: var(--text-muted); margin-top: 0.15rem; }

  .remove-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 1rem;
    padding: 0;
    line-height: 1;
    opacity: 0;
    transition: opacity 150ms ease;
  }

  .milestone:hover .remove-btn { opacity: 1; }
  .remove-btn:hover { color: var(--gold-bright); }

  /* Magic jar */
  .magic-jar {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 1.5rem;
    margin-top: 1rem;
    margin-bottom: 2rem;
    position: relative;
  }

  .jar-glow {
    position: absolute;
    width: 80px;
    height: 80px;
    background: radial-gradient(circle, var(--gold-glow) 0%, transparent 70%);
    border-radius: 50%;
    animation: pulse-glow 4s ease-in-out infinite;
  }

  @keyframes pulse-glow {
    0%, 100% { transform: scale(1); opacity: 0.5; }
    50% { transform: scale(1.3); opacity: 1; }
  }

  .jar-icon { font-size: 2rem; position: relative; z-index: 1; }

  .jar-label {
    font-size: 0.7rem;
    color: var(--text-primary);
    text-transform: uppercase;
    letter-spacing: 0.15em;
    margin-top: 0.5rem;
    position: relative;
    z-index: 1;
  }

  .loading {
    display: flex;
    justify-content: center;
    padding: 3rem;
  }

  .loading-star {
    font-size: 1.5rem;
    color: var(--gold-bright);
    animation: twinkle 2s ease-in-out infinite;
  }

  /* Nursery Chat */
  .nursery-chat {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-bottom: 1rem;
    overflow: hidden;
  }

  .nursery-chat.collapsed {
    background: var(--bg-tertiary);
  }

  .nursery-chat-toggle {
    width: 100%;
    background: none;
    border: none;
    color: var(--gold);
    padding: 0.6rem 1rem;
    font-family: var(--font-body);
    font-size: 0.8rem;
    cursor: pointer;
    text-align: left;
    transition: color 150ms ease;
  }

  .nursery-chat-toggle:hover { color: var(--gold-bright); }

  .nursery-chat-messages {
    max-height: 350px;
    overflow-y: auto;
    overflow-x: hidden;
    -webkit-overflow-scrolling: touch;
    padding: 0 0.75rem;
  }

  .nursery-chat-empty {
    text-align: center;
    padding: 1.5rem 0;
    color: var(--text-muted);
    font-style: italic;
    font-size: 0.85rem;
  }

  .nursery-chat-msg {
    margin-bottom: 0.25rem;
  }

  .nursery-chat-input {
    border-top: 1px solid var(--border);
    padding: 0.5rem;
  }
</style>
