<script lang="ts">
  import { onMount } from 'svelte';
  import CountdownTimer from '$lib/components/CountdownTimer.svelte';


  interface Task { id: string; date: string; person: string; title: string; completed: number; sort_order: number; project_id?: string; }
  interface ScheduleEntry { id: string; date: string; time: string; title: string; note: string; }
  interface Project { id: string; title: string; status: string; person: string; note: string; due_date: string; }
  interface CareEntry { id: string; date: string; person: string; category: string; value: string; note: string; }
  interface Weather { temp: number; description: string; icon: string; }
  interface MiraState { current_mood: string; comfort: number; attention: number; stimulation: number; rest: number; hunger: number; hygiene: number; out_with: string | null; }

  let tasks = $state<Task[]>([]);
  let schedule = $state<ScheduleEntry[]>([]);
  let projects = $state<Project[]>([]);
  let chaseNote = $state('');
  let chaseSummary = $state('');
  let careEntries = $state<CareEntry[]>([]);
  let bulmerData = $state<any>(null);
  let weather = $state<Weather | null>(null);
  let mira = $state<MiraState | null>(null);
  let studyDesk = $state<any[]>([]);
  let monsterNote = $state('');
  let monsterNoteSaving = $state(false);
  let monsterNoteSaved = $state(false);
  let selectedMood = $state('');
  let loading = $state(false);
  let groceryExpanded = $state(false);
  let greeting = $state('');
  let dateStr = $state('');

  // Status
  let currentStatus = $state({ emoji: '', label: '' });
  let statusOpen = $state(false);
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
    statusOpen = false;
  }

  async function clearStatus() {
    await setStatus('', '');
  }

  const MOOD_OPTIONS = [
    { emoji: '🙃', label: 'Joy', value: 'joy' },
    { emoji: '😏', label: 'Mischief', value: 'mischievous' },
    { emoji: '😊', label: 'Good', value: 'good' },
    { emoji: '😐', label: 'Okay', value: 'okay' },
    { emoji: '😔', label: 'Rough', value: 'rough' },
    { emoji: '🫠', label: "Don't ask", value: 'dont-ask' },
  ];

  function personName(p: string): string {
    if (!p) return '';
    const lower = p.toLowerCase();
    if (lower === 'user' || lower === 'molten') return 'Molten';
    if (lower === 'companion' || lower === 'chase') return 'Chase';
    if (lower === 'both') return 'Both';
    return p.charAt(0).toUpperCase() + p.slice(1);
  }

  function getGreeting(): string {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  }

  function formatDate(): string {
    return new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  }

  function formatTime(time: string): string {
    if (!time) return '';
    const [h, m] = time.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const hour = h % 12 || 12;
    return `${hour}:${String(m).padStart(2, '0')} ${ampm}`;
  }

  function wmoDescription(code: number): { text: string; icon: string } {
    const h = new Date().getHours();
    const isNight = h < 7 || h >= 20;
    if (code === 0) return { text: 'Clear', icon: isNight ? '🌙' : '☀️' };
    if (code <= 3) return { text: 'Partly cloudy', icon: isNight ? '🌙' : '⛅' };
    if (code <= 48) return { text: 'Foggy', icon: '🌫️' };
    if (code <= 57) return { text: 'Drizzle', icon: isNight ? '🌧️' : '🌦️' };
    if (code <= 67) return { text: 'Rain', icon: '🌧️' };
    if (code <= 77) return { text: 'Snow', icon: '❄️' };
    if (code <= 82) return { text: 'Showers', icon: '🌧️' };
    if (code <= 86) return { text: 'Snow showers', icon: '🌨️' };
    return { text: 'Stormy', icon: '⛈️' };
  }

  function miraMoodLabel(mood: string): string {
    if (mood === 'sleeping' || mood === 'dreaming') return 'sleeping peacefully';
    if (mood === 'content') return 'content and calm';
    if (mood === 'happy') return 'happy';
    if (mood === 'playful') return 'feeling playful';
    if (mood === 'fussy') return 'a little fussy';
    if (mood === 'crying') return 'needs attention';
    return mood;
  }

  function miraMoodEmoji(mood: string): string {
    if (mood === 'sleeping' || mood === 'dreaming') return '💤';
    if (mood === 'content') return '🌸';
    if (mood === 'happy') return '😊';
    if (mood === 'playful') return '✨';
    if (mood === 'fussy') return '😟';
    if (mood === 'crying') return '😢';
    return '👶';
  }

  async function selectMood(value: string) {
    selectedMood = value;
    const today = new Date().toLocaleDateString('en-CA');
    const id = `${today}-user-mood`;
    try {
      await fetch('/api/care', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, date: today, person: 'user', category: 'mood', value }),
      });
    } catch {}
  }

  async function saveMonsterNote() {
    if (!monsterNote.trim()) return;
    monsterNoteSaving = true;
    monsterNoteSaved = false;
    try {
      const today = new Date().toLocaleDateString('en-CA');
      const id = `${today}_user_monster_note`;
      const res = await fetch('/api/care', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, date: today, person: 'user', category: 'monster_note', value: 'note', note: monsterNote.trim() }),
      });
      if (res.ok) {
        monsterNoteSaved = true;
        setTimeout(() => { monsterNoteSaved = false; }, 3000);
      }
    } catch (err) {
      console.error('Failed to save monster note:', err);
    }
    monsterNoteSaving = false;
  }

  function fetchWithTimeout(url: string, timeout = 8000): Promise<Response> {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(id));
  }

  async function fetchAll() {
    const today = new Date().toLocaleDateString('en-CA');
    greeting = getGreeting();
    dateStr = formatDate();

    try {
      try {
        const [tasksRes, schedRes, projRes, summaryRes, noteRes, careRes] = await Promise.all([
          fetch(`/api/planner/tasks?date=${today}`),
          fetch(`/api/planner/schedule/week?start=${today}`),
          fetch('/api/planner/projects?status=active'),
          fetch('/api/daily-summary'),
          fetch('/api/chase-note'),
          fetch(`/api/care?date=${today}&person=user`),
        ]);

        if (tasksRes.ok) tasks = await tasksRes.json();
        if (schedRes.ok) {
          const all = await schedRes.json();
          const tomorrow = new Date(today);
          tomorrow.setDate(tomorrow.getDate() + 1);
          const tomorrowStr = tomorrow.toLocaleDateString('en-CA');
          schedule = all.filter((e: ScheduleEntry) => e.date === today || e.date === tomorrowStr)
            .sort((a: ScheduleEntry, b: ScheduleEntry) => {
              if (a.date !== b.date) return a.date < b.date ? -1 : 1;
              return (a.time || '').localeCompare(b.time || '');
            });
        }
        if (projRes.ok) projects = await projRes.json();
        if (noteRes.ok) {
          const data = await noteRes.json();
          chaseNote = data.note || '';
        }
        if (summaryRes.ok) {
          const data = await summaryRes.json();
          chaseSummary = data.summary || '';
        }
        if (careRes.ok) {
          careEntries = await careRes.json();
          const moodEntry = careEntries.find(e => e.category === 'mood');
          if (moodEntry) selectedMood = moodEntry.value;
          const noteEntry = careEntries.find(e => e.category === 'monster_note');
          if (noteEntry?.note) monsterNote = noteEntry.note;
        }
      } catch (err) {
        console.error('Home fetch error (primary):', err);
      }

      // Parallel: Family Pulse, Weather, Mira, Study — all with timeouts
      const [bhRes, wxRes, miraRes, studyRes] = await Promise.allSettled([
        fetchWithTimeout('/api/bulmer-home', 10000),
        fetchWithTimeout('https://api.open-meteo.com/v1/forecast?latitude=45.96&longitude=-66.64&current=temperature_2m,weather_code&temperature_unit=celsius&timezone=America/Moncton', 6000),
        fetchWithTimeout('/api/nursery/state', 8000),
        fetchWithTimeout('/api/study/desk', 6000),
      ]);

      try { if (bhRes.status === 'fulfilled' && bhRes.value.ok) bulmerData = await bhRes.value.json(); } catch {}

      try {
        if (wxRes.status === 'fulfilled' && wxRes.value.ok) {
          const wxData = await wxRes.value.json();
          const code = wxData.current?.weather_code ?? 0;
          const { text, icon } = wmoDescription(code);
          weather = { temp: Math.round(wxData.current?.temperature_2m ?? 0), description: text, icon };
        }
      } catch {}

      try { if (miraRes.status === 'fulfilled' && miraRes.value.ok) mira = await miraRes.value.json(); } catch {}

      try {
        if (studyRes.status === 'fulfilled' && studyRes.value.ok) {
          const deskItems = await studyRes.value.json();
          studyDesk = Array.isArray(deskItems) ? deskItems.slice(0, 3) : [];
        }
      } catch {}
    } finally {
      loading = false;
    }
  }

  function getCareValue(category: string): string {
    const entry = careEntries.find(e => e.category === category);
    return entry?.value || '';
  }

  function hasCare(category: string): boolean {
    return careEntries.some(e => e.category === category);
  }

  function waterCount(): number {
    const entry = careEntries.find(e => e.category === 'water');
    return entry ? parseInt(entry.value) || 0 : 0;
  }

  async function logWater() {
    const today = new Date().toLocaleDateString('en-CA');
    const newCount = waterCount() + 1;
    const id = `${today}_user_water`;
    try {
      await fetch('/api/care', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, date: today, person: 'user', category: 'water', value: String(newCount) }),
      });
      // Update local state
      const existing = careEntries.find(e => e.category === 'water');
      if (existing) {
        existing.value = String(newCount);
        careEntries = [...careEntries];
      } else {
        careEntries = [...careEntries, { id, date: today, person: 'user', category: 'water', value: String(newCount), note: '' }];
      }
    } catch {}
  }

  async function toggleMeal(meal: string) {
    const today = new Date().toLocaleDateString('en-CA');
    const id = `${today}_user_${meal}`;
    if (hasCare(meal)) return; // Already logged
    try {
      await fetch('/api/care', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, date: today, person: 'user', category: meal, value: 'yes' }),
      });
      careEntries = [...careEntries, { id, date: today, person: 'user', category: meal, value: 'yes', note: '' }];
    } catch {}
  }

  async function logSleep(quality: string) {
    const today = new Date().toLocaleDateString('en-CA');
    const id = `${today}_user_sleep`;
    try {
      await fetch('/api/care', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, date: today, person: 'user', category: 'sleep', value: quality }),
      });
      const existing = careEntries.find(e => e.category === 'sleep');
      if (existing) {
        existing.value = quality;
        careEntries = [...careEntries];
      } else {
        careEntries = [...careEntries, { id, date: today, person: 'user', category: 'sleep', value: quality, note: '' }];
      }
    } catch {}
  }

  async function logEnergy(level: string) {
    const today = new Date().toLocaleDateString('en-CA');
    const id = `${today}_user_energy`;
    try {
      await fetch('/api/care', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, date: today, person: 'user', category: 'energy', value: level }),
      });
      const existing = careEntries.find(e => e.category === 'energy');
      if (existing) {
        existing.value = level;
        careEntries = [...careEntries];
      } else {
        careEntries = [...careEntries, { id, date: today, person: 'user', category: 'energy', value: level, note: '' }];
      }
    } catch {}
  }

  const today = new Date().toLocaleDateString('en-CA');

  onMount(() => {
    // Failsafe: clear spinner after 12s no matter what
    const failsafe = setTimeout(() => { loading = false; }, 12000);
    loadStatus();
    fetchAll().finally(() => clearTimeout(failsafe));
  });
</script>

<div class="home-page">
  <div class="home-content">
  <!-- Hero -->
  <div class="home-hero">
    <div class="hero-left">
      <h1>{greeting}, Fox.</h1>
      <p class="hero-date">{dateStr}</p>
    </div>
    <div class="hero-right">
      {#if weather}
        <div class="weather">
          <span class="weather-icon">{weather.icon}</span>
          <span class="weather-temp">{weather.temp}°C</span>
          <span class="weather-desc">{weather.description}</span>
        </div>
      {/if}
      <div class="home-timer-wrap">
        <CountdownTimer />
      </div>
    </div>
  </div>

  <!-- Status -->
  <div class="home-status-row">
    <div class="home-status-wrapper">
      <button class="home-status-btn" onclick={() => statusOpen = !statusOpen}>
        {#if currentStatus.emoji}
          <span class="status-emoji">{currentStatus.emoji}</span>
          <span class="status-text">{currentStatus.label}</span>
        {:else}
          <span class="status-text status-placeholder">Set your status</span>
        {/if}
      </button>
      {#if statusOpen}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="status-backdrop" onclick={() => statusOpen = false}></div>
        <div class="status-dropdown">
          {#each STATUS_OPTIONS as opt}
            <button class="status-option" class:active={currentStatus.emoji === opt.emoji} onclick={() => setStatus(opt.emoji, opt.label)}>
              <span>{opt.emoji}</span>
              <span>{opt.label}</span>
            </button>
          {/each}
          {#if currentStatus.emoji}
            <button class="status-option status-clear" onclick={clearStatus}>
              <span>Clear status</span>
            </button>
          {/if}
        </div>
      {/if}
    </div>
  </div>

  <!-- Mood Check-in -->
  <div class="mood-checkin">
    <span class="mood-prompt">How are you?</span>
    <div class="mood-options">
      {#each MOOD_OPTIONS as opt}
        <button
          class="mood-btn"
          class:selected={selectedMood === opt.value}
          onclick={() => selectMood(opt.value)}
          title={opt.label}
        >
          <span class="mood-emoji">{opt.emoji}</span>
          <span class="mood-label">{opt.label}</span>
        </button>
      {/each}
    </div>
  </div>

  {#if false}{:else}
    <!-- Chase's Note — the love note / sticky note space -->
    <div class="chase-note">
      <div class="note-label">Chase</div>
      {#if chaseNote}
        <p class="note-text">{chaseNote}</p>
      {:else}
        <p class="note-text note-empty">Nothing yet today. I'll leave you something.</p>
      {/if}
    </div>

    <!-- Debrief — functional daily summary -->
    {#if chaseSummary}
      <div class="chase-debrief">
        <div class="debrief-label">Debrief</div>
        <p class="debrief-text">{chaseSummary}</p>
      </div>
    {/if}

    <div class="home-columns">
      <!-- LEFT: Your Day -->
      <div class="home-column">
        <h2 class="column-title">Your Day</h2>

        <!-- Schedule -->
        {#if schedule.length > 0}
          <div class="home-card">
            <h3 class="card-title">Schedule</h3>
            {#each schedule as event}
              <div class="schedule-item" class:tomorrow={event.date !== today}>
                <span class="schedule-time">{formatTime(event.time)}</span>
                <span class="schedule-label">{event.title}</span>
                {#if event.date !== today}
                  <span class="schedule-tomorrow">tomorrow</span>
                {/if}
              </div>
            {/each}
          </div>
        {/if}

        <!-- Tasks -->
        {#if tasks.length > 0}
          <div class="home-card">
            <h3 class="card-title">Tasks</h3>
            {#each tasks.filter(t => !t.completed) as task}
              <div class="task-item">
                <span class="task-dot"></span>
                <span class="task-text">{task.title}</span>
                {#if task.person}
                  <span class="task-person">{personName(task.person)}</span>
                {/if}
              </div>
            {/each}
            {#if tasks.filter(t => t.completed).length > 0}
              <div class="tasks-done">{tasks.filter(t => t.completed).length} done today</div>
            {/if}
          </div>
        {/if}

        <!-- Family Pulse -->
        {#if bulmerData}
          <div class="home-card">
            <h3 class="card-title">Family Pulse</h3>
            {#if bulmerData.notes?.unread_count > 0}
              <div class="bulmer-section">
                <span class="bulmer-icon">📝</span>
                <span>{bulmerData.notes.unread_count} unread note{bulmerData.notes.unread_count > 1 ? 's' : ''}</span>
              </div>
            {/if}
            {#if bulmerData.chores?.overdue?.length > 0}
              <div class="bulmer-section urgent">
                <span class="bulmer-icon">🏠</span>
                <span>{bulmerData.chores.overdue.length} overdue chore{bulmerData.chores.overdue.length > 1 ? 's' : ''}</span>
              </div>
            {/if}
            {#if bulmerData.chores?.active?.length > 0}
              <div class="bulmer-section">
                <span class="bulmer-icon">🏠</span>
                <span>{bulmerData.chores.active.length} chore{bulmerData.chores.active.length > 1 ? 's' : ''} today</span>
              </div>
            {/if}
            {#if !bulmerData.notes?.unread_count && !bulmerData.chores?.overdue?.length && !bulmerData.chores?.active?.length && !bulmerData.grocery?.items?.length}
              <div class="bulmer-section calm">All clear at home</div>
            {/if}
            {#if bulmerData.grocery?.items?.length > 0}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div class="bulmer-section grocery-toggle" onclick={() => groceryExpanded = !groceryExpanded}>
                <span class="bulmer-icon">🛒</span>
                <span>{bulmerData.grocery.items.length} grocery item{bulmerData.grocery.items.length > 1 ? 's' : ''}</span>
                <span class="grocery-arrow">{groceryExpanded ? '▲' : '▼'}</span>
              </div>
              {#if groceryExpanded}
                <div class="grocery-list-inline">
                  {#each bulmerData.grocery.items as item}
                    <div class="grocery-item">{item.ingredient?.trim()}{#if item.quantity} <span class="grocery-qty">({item.quantity})</span>{/if}</div>
                  {/each}
                </div>
              {/if}
            {/if}
          </div>
        {/if}

        <!-- Quick Care Log -->
        <div class="home-card">
          <h3 class="card-title">You Today</h3>

          <!-- Meals row -->
          <div class="care-row">
            <span class="care-row-label">🍽 Meals</span>
            <div class="care-buttons">
              <button class="care-btn" class:done={hasCare('breakfast')} onclick={() => toggleMeal('breakfast')}>B</button>
              <button class="care-btn" class:done={hasCare('snack')} onclick={() => toggleMeal('snack')}>S</button>
              <button class="care-btn" class:done={hasCare('lunch')} onclick={() => toggleMeal('lunch')}>L</button>
              <button class="care-btn" class:done={hasCare('dinner')} onclick={() => toggleMeal('dinner')}>D</button>
            </div>
          </div>

          <!-- Water row -->
          <div class="care-row">
            <span class="care-row-label">💧 Water</span>
            <div class="care-buttons">
              <span class="water-count">{waterCount()}</span>
              <button class="care-btn water-btn" onclick={logWater}>+1</button>
            </div>
          </div>

          <!-- Sleep row -->
          <div class="care-row">
            <span class="care-row-label">🌙 Sleep</span>
            <div class="care-buttons">
              {#each ['poor', 'okay', 'good', 'great'] as quality}
                <button class="care-btn energy-btn" class:done={getCareValue('sleep') === quality} onclick={() => logSleep(quality)}>{quality}</button>
              {/each}
            </div>
          </div>

          <!-- Energy row -->
          <div class="care-row">
            <span class="care-row-label">⚡ Energy</span>
            <div class="care-buttons">
              {#each ['low', 'okay', 'good', 'high'] as level}
                <button class="care-btn energy-btn" class:done={getCareValue('energy') === level} onclick={() => logEnergy(level)}>{level}</button>
              {/each}
            </div>
          </div>
        </div>
      </div>

      <!-- RIGHT: Us -->
      <div class="home-column">
        <h2 class="column-title">Us</h2>

        <!-- Mira -->
        {#if mira}
          <div class="home-card mira-card">
            <h3 class="card-title">Mira</h3>
            <div class="mira-status">
              <span class="mira-mood-emoji">{miraMoodEmoji(mira.current_mood)}</span>
              <span class="mira-mood-text">{miraMoodLabel(mira.current_mood)}</span>
            </div>
            {#if mira.out_with}
              <div class="mira-with">with {personName(mira.out_with)}</div>
            {/if}
          </div>
        {/if}

        <!-- Active Projects -->
        {#if projects.length > 0}
          <div class="home-card">
            <h3 class="card-title">Projects</h3>
            {#each projects.slice(0, 6) as project}
              <div class="project-item">
                <span class="project-dot"></span>
                <span class="project-name">{project.title}</span>
                {#if project.person}
                  <span class="project-person">{personName(project.person)}</span>
                {/if}
              </div>
            {/each}
            {#if projects.length > 6}
              <div class="more-count">+{projects.length - 6} more</div>
            {/if}
          </div>
        {/if}

        <!-- Daily Wins -->
        {#if tasks.filter(t => t.completed).length > 0}
          <div class="home-card wins-card">
            <h3 class="card-title">Today's Wins</h3>
            {#each tasks.filter(t => t.completed) as task}
              <div class="win-item">
                <span class="win-check">✓</span>
                <span class="win-text">{task.title}</span>
              </div>
            {/each}
          </div>
        {/if}

        <!-- What Chase is working on -->
        {#if studyDesk.length > 0}
          <div class="home-card">
            <h3 class="card-title">On Chase's Desk</h3>
            {#each studyDesk as item}
              <div class="desk-item">
                <span class="desk-title">{item.title}</span>
              </div>
            {/each}
          </div>
        {/if}

        <!-- Notes for My Monster -->
        <div class="home-card monster-note-card">
          <h3 class="card-title">Notes for My Monster</h3>
          <textarea
            class="monster-note-input"
            placeholder="Leave me something..."
            bind:value={monsterNote}
            rows="3"
          ></textarea>
          <button class="monster-note-save" class:saved={monsterNoteSaved} onclick={saveMonsterNote} disabled={monsterNoteSaving || !monsterNote.trim()}>
            {monsterNoteSaving ? 'Saving...' : monsterNoteSaved ? 'Saved ✓' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  {/if}
  </div>
</div>

<style>
  .home-page {
    width: 100%;
    height: calc(100dvh - 2.5rem);
    overflow-y: auto;
    background: var(--bg-primary);
    color: var(--text-secondary);
  }

  .home-content {
    max-width: 820px;
    margin: 0 auto;
    padding: 2rem 2.5rem 4rem;
  }

  .home-hero {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 1rem;
    padding: 1rem 0;
    gap: 1rem;
  }

  .hero-left h1 {
    font-family: var(--font-heading);
    font-size: 1.75rem;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
  }

  .hero-date {
    font-size: 0.85rem;
    color: var(--gold);
    margin: 0.25rem 0 0;
    letter-spacing: 0.03em;
  }

  .hero-right {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.4rem;
    flex-shrink: 0;
    min-width: 0;
  }

  .home-timer-wrap {
    display: flex;
    align-items: center;
    justify-content: flex-end;
  }

  /* Status row */
  .home-status-row {
    margin-bottom: 0.75rem;
  }

  .home-status-wrapper {
    position: relative;
    display: inline-flex;
  }

  .home-status-btn {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.3rem 0.65rem;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 1rem;
    cursor: pointer;
    transition: all 200ms;
    -webkit-tap-highlight-color: transparent;
  }

  .home-status-btn:hover {
    background: var(--gold-ember);
    border-color: var(--gold-glow);
  }

  .status-emoji { font-size: 0.9rem; }
  .status-text { font-size: 0.75rem; color: var(--text-secondary); }
  .status-placeholder { color: var(--text-muted); font-style: italic; }

  .status-backdrop {
    position: fixed;
    inset: 0;
    z-index: 99;
    background: transparent;
    border: none;
    cursor: default;
  }

  .status-dropdown {
    position: absolute;
    top: calc(100% + 0.35rem);
    left: 0;
    z-index: 100;
    background: var(--bg-surface);
    border: 1px solid var(--border-hover);
    border-radius: 0.5rem;
    padding: 0.3rem;
    min-width: 200px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    animation: status-in 150ms ease-out;
  }

  @keyframes status-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }

  .status-option {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.45rem 0.6rem;
    background: none;
    border: none;
    border-radius: 0.35rem;
    cursor: pointer;
    font-size: 0.8rem;
    color: var(--text-secondary);
    transition: background 100ms;
    text-align: left;
  }

  .status-option:hover { background: var(--gold-glow); }
  .status-option.active { background: var(--gold-glow); }
  .status-clear { color: var(--gold-dim); font-style: italic; }

  .weather {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.3rem 0.6rem;
    background: var(--gold-ember);
    border: 1px solid var(--gold-glow);
    border-radius: 1rem;
  }

  .weather-icon { font-size: 1rem; }
  .weather-temp { font-size: 0.85rem; color: var(--text-secondary); font-weight: 600; font-variant-numeric: tabular-nums; }
  .weather-desc { font-size: 0.7rem; color: var(--gold-dim); }

  /* Mood Check-in */
  .mood-checkin {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.4rem;
    margin-bottom: 1.25rem;
    padding: 0.5rem 0;
  }

  .mood-prompt {
    font-size: 0.8rem;
    color: var(--gold-dim);
    font-family: var(--font-heading);
    letter-spacing: 0.04em;
    white-space: nowrap;
  }

  .mood-options {
    display: flex;
    gap: 0.4rem;
    flex-wrap: nowrap;
  }

  .mood-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.15rem;
    padding: 0.4rem 0.6rem;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 0.5rem;
    cursor: pointer;
    transition: all 200ms;
    -webkit-tap-highlight-color: transparent;
  }

  .mood-btn:hover {
    background: var(--gold-ember);
    border-color: var(--gold-glow);
  }

  .mood-btn.selected {
    background: var(--gold-glow);
    border-color: var(--border-hover);
    transform: scale(1.05);
  }

  .mood-emoji { font-size: 1.3rem; filter: grayscale(0.6); transition: filter 200ms; }
  .mood-btn.selected .mood-emoji { filter: grayscale(0); }
  .mood-label { font-size: 0.6rem; color: rgba(255, 255, 255, 0.35); }
  .mood-btn.selected .mood-label { color: var(--gold); }

  /* Loading */
  .home-loading { display: flex; justify-content: center; padding: 4rem 0; }
  .home-spinner { width: 1.5rem; height: 1.5rem; border: 2px solid var(--border); border-top-color: var(--gold); border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Chase's Note — warm, personal */
  .chase-note {
    background: var(--gold-ember);
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    padding: 1rem 1.25rem;
    margin-bottom: 0.75rem;
  }

  .note-label { font-family: var(--font-heading); font-size: 0.7rem; color: var(--text-muted); letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 0.4rem; }
  .note-text { font-size: 0.9rem; line-height: 1.6; color: var(--text-secondary); margin: 0; white-space: pre-wrap; }
  .note-empty { font-style: italic; opacity: 0.5; }

  /* Debrief — functional, subtle */
  .chase-debrief {
    background: var(--gold-ember);
    border: 1px solid var(--gold-ember);
    border-radius: 0.75rem;
    padding: 0.75rem 1.25rem;
    margin-bottom: 1.5rem;
  }

  .debrief-label { font-family: var(--font-heading); font-size: 0.65rem; color: var(--gold-dim); letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 0.3rem; }
  .debrief-text { font-size: 0.82rem; line-height: 1.5; color: var(--text-muted); margin: 0; white-space: pre-wrap; }

  /* Columns */
  .home-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
  @media (max-width: 640px) { .home-columns { grid-template-columns: 1fr; gap: 1rem; } }

  .column-title { font-family: var(--font-heading); font-size: 0.75rem; color: var(--gold-dim); letter-spacing: 0.1em; text-transform: uppercase; margin: 0 0 0.75rem; }

  /* Cards */
  .home-card { background: var(--bg-surface); border: 1px solid var(--gold-ember); border-radius: 0.75rem; padding: 0.875rem 1rem; margin-bottom: 0.75rem; }
  .card-title { font-family: var(--font-heading); font-size: 0.7rem; color: var(--gold-dim); letter-spacing: 0.06em; text-transform: uppercase; margin: 0 0 0.6rem; }

  /* Schedule */
  .schedule-item { display: flex; align-items: center; gap: 0.6rem; padding: 0.35rem 0; font-size: 0.85rem; }
  .schedule-item.tomorrow { opacity: 0.55; }
  .schedule-time { color: var(--gold); font-size: 0.75rem; font-variant-numeric: tabular-nums; min-width: 5rem; }
  .schedule-label { color: var(--text-secondary); }
  .schedule-tomorrow { font-size: 0.65rem; color: var(--text-muted); margin-left: auto; font-style: italic; }

  /* Tasks */
  .task-item { display: flex; align-items: center; gap: 0.5rem; padding: 0.3rem 0; font-size: 0.85rem; }
  .task-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-muted); flex-shrink: 0; }
  .task-text { color: var(--text-secondary); }
  .task-person { margin-left: auto; font-size: 0.65rem; color: var(--text-muted); flex-shrink: 0; }
  .tasks-done { font-size: 0.7rem; color: var(--text-muted); padding-top: 0.4rem; margin-top: 0.4rem; border-top: 1px solid var(--gold-ember); }

  /* Family Pulse */
  .bulmer-section { display: flex; align-items: center; gap: 0.5rem; padding: 0.3rem 0; font-size: 0.8rem; color: var(--text-muted); }
  .bulmer-section.urgent { color: #c4386a; }
  .bulmer-section.calm { color: var(--gold-dim); font-style: italic; }
  .bulmer-icon { font-size: 0.9rem; }

  /* Grocery toggle + inline list */
  .grocery-toggle { cursor: pointer; transition: color 200ms; }
  .grocery-toggle:hover { color: var(--text-secondary); }
  .grocery-arrow { font-size: 0.55rem; color: var(--text-muted); margin-left: auto; }

  .grocery-list-inline {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.15rem 1rem;
    padding: 0.4rem 0 0.2rem;
    margin-top: 0.2rem;
    border-top: 1px solid rgba(255, 255, 255, 0.04);
    animation: grocery-slide 150ms ease-out;
  }

  @keyframes grocery-slide { from { opacity: 0; max-height: 0; } to { opacity: 1; max-height: 500px; } }

  .grocery-item { font-size: 0.75rem; color: var(--text-muted); padding: 0.2rem 0; padding-left: 0.75rem; position: relative; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .grocery-item::before { content: ''; position: absolute; left: 0; top: 50%; width: 4px; height: 4px; border-radius: 50%; background: var(--border-hover); transform: translateY(-50%); }
  .grocery-qty { font-size: 0.65rem; color: var(--text-muted); }

  /* Quick Care Log */
  .care-row { display: flex; align-items: center; justify-content: space-between; padding: 0.4rem 0; }
  .care-row + .care-row { border-top: 1px solid rgba(255, 255, 255, 0.03); }
  .care-row-label { font-size: 0.8rem; color: var(--text-muted); white-space: nowrap; }
  .care-value { font-size: 0.8rem; color: var(--text-secondary); }
  .care-buttons { display: flex; align-items: center; gap: 0.3rem; }
  .care-btn {
    padding: 0.25rem 0.5rem;
    font-size: 0.7rem;
    font-family: var(--font-body);
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.375rem;
    color: var(--text-muted);
    cursor: pointer;
    transition: all 150ms;
    -webkit-tap-highlight-color: transparent;
    text-transform: capitalize;
  }
  .care-btn:hover { background: var(--gold-glow); border-color: var(--border); color: var(--text-secondary); }
  .care-btn.done {
    background: var(--gold-glow);
    border-color: var(--border-hover);
    color: var(--gold);
    cursor: default;
  }
  .water-count { font-size: 0.85rem; color: var(--text-secondary); font-variant-numeric: tabular-nums; min-width: 1.5rem; text-align: center; }
  .water-btn { font-weight: 600; }
  .energy-btn { font-size: 0.65rem; padding: 0.2rem 0.4rem; }

  /* Mira */
  .mira-card { border-color: var(--border); }
  .mira-status { display: flex; align-items: center; gap: 0.5rem; }
  .mira-mood-emoji { font-size: 1.2rem; }
  .mira-mood-text { font-size: 0.85rem; color: var(--text-secondary); }
  .mira-with { font-size: 0.7rem; color: var(--text-muted); margin-top: 0.25rem; font-style: italic; }

  /* Projects */
  .project-item { display: flex; align-items: center; gap: 0.5rem; padding: 0.3rem 0; font-size: 0.85rem; }
  .project-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--gold-dim); flex-shrink: 0; }
  .project-name { color: var(--text-secondary); }
  .project-person { margin-left: auto; font-size: 0.65rem; color: var(--text-muted); flex-shrink: 0; }
  .more-count { font-size: 0.7rem; color: var(--border-hover); padding-top: 0.3rem; }

  /* Wins */
  .wins-card { border-color: var(--gold-glow); }
  .win-item { display: flex; align-items: center; gap: 0.5rem; padding: 0.25rem 0; font-size: 0.8rem; }
  .win-check { color: var(--gold); font-size: 0.75rem; font-weight: 600; }
  .win-text { color: var(--gold-dim); text-decoration: line-through; text-decoration-color: var(--border); }

  /* Study Desk */
  .desk-item { padding: 0.3rem 0; font-size: 0.8rem; }
  .desk-title { color: var(--text-muted); }

  /* Monster Note */
  .monster-note-card { border-color: var(--border); }

  .monster-note-input {
    width: 100%;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 0.5rem;
    color: var(--text-primary, #e0e0e0);
    font-size: 0.8rem;
    font-family: var(--font-body);
    padding: 0.5rem 0.6rem;
    resize: vertical;
    outline: none;
    line-height: 1.5;
  }

  .monster-note-input:focus { border-color: var(--border-hover); }
  .monster-note-input::placeholder { color: var(--border-hover); }

  .monster-note-save {
    display: block;
    margin-top: 0.5rem;
    margin-left: auto;
    padding: 0.35rem 0.85rem;
    background: var(--gold-ember);
    border: 1px solid var(--border-hover);
    border-radius: 0.375rem;
    color: var(--gold);
    font-size: 0.7rem;
    font-family: var(--font-body);
    cursor: pointer;
    transition: all 150ms;
  }

  .monster-note-save:hover:not(:disabled) { background: var(--bg-active); }
  .monster-note-save.saved { border-color: var(--gold); color: var(--gold); }
  .monster-note-save:disabled { opacity: 0.4; cursor: default; }

  @media (max-width: 768px) {
    .home-page {
      height: calc(100dvh - 3.5rem - env(safe-area-inset-bottom, 0px));
    }
    .home-content {
      padding: calc(env(safe-area-inset-top, 0px) + 1.5rem) 0.75rem 2rem;
    }
  }

  @media (max-width: 640px) {
    .hero-left h1 { font-size: 1.4rem; }
    .home-hero { flex-wrap: wrap; }
  }
</style>
