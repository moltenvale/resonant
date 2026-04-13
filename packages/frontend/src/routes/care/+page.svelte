<script lang="ts">
  import { onMount } from 'svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import SymptomPicker from '$lib/components/SymptomPicker.svelte';
  import WellnessPicker from '$lib/components/WellnessPicker.svelte';
  import TimePickerModal from '$lib/components/TimePickerModal.svelte';

  interface CareEntry {
    id: string;
    date: string;
    person: string;
    category: string;
    value: string;
    note: string | null;
  }

  // Molten's categories
  const userCategories = [
    // Food & Basics — water glasses at top, then meals
    { key: 'water', label: 'Water', icon: '\u{1F4A7}', type: 'glasses', max: 12, section: 'food' },
    { key: 'breakfast', label: 'Breakfast', icon: '\u{1F373}', type: 'toggle', section: 'food' },
    { key: 'lunch', label: 'Lunch', icon: '\u{1F96A}', type: 'toggle', section: 'food' },
    { key: 'dinner', label: 'Dinner', icon: '\u{1F35D}', type: 'toggle', section: 'food' },
    { key: 'snacks', label: 'Snacks', icon: '\u{1F34E}', type: 'toggle', section: 'food' },
    { key: 'medication', label: 'Medication', icon: '\u{1F48A}', type: 'toggle', section: 'food' },
    // Hygiene (toggles — skinny rows)
    { key: 'shower', label: 'Shower', icon: '\u{1F6BF}', type: 'toggle', section: 'hygiene' },
    { key: 'teeth', label: 'Teeth', icon: '\u{1FAA5}', type: 'toggle', section: 'hygiene' },
    { key: 'skincare', label: 'Skincare', icon: '\u{2728}', type: 'toggle', section: 'hygiene' },
    { key: 'hair', label: 'Hair', icon: '\u{1F487}', type: 'toggle', section: 'hygiene' },
    // Physical health — symptom picker handles detailed symptoms
    { key: 'symptoms', label: 'Symptoms', icon: '\u{1FA7A}', type: 'symptom-picker', section: 'physical' },
    // Wellness (larger blocks — bottom of page)
    { key: 'movement', label: 'Movement', icon: '\u{1F3C3}', type: 'wellness-event', options: ['walk', 'run', 'gym', 'yoga', 'at home workout', 'weights'], section: 'wellness' },
    { key: 'sleep', label: 'Sleep', icon: '\u{1F319}', type: 'wellness-event', options: ['none', 'terrible', 'broken', 'poor', 'okay', 'good', 'great'], section: 'wellness' },
    { key: 'energy', label: 'Energy', icon: '\u{26A1}', type: 'wellness-event', options: ['crashed', 'low', 'okay', 'good', 'high', 'wired'], section: 'wellness' },
    { key: 'wellbeing', label: 'Wellbeing', icon: '\u{1F33F}', type: 'wellness-event', options: ['struggling', 'fragile', 'okay', 'steady', 'strong'], section: 'wellness' },
    { key: 'mood', label: 'Mood', icon: '\u{1F49C}', type: 'wellness-event', options: ['joy', 'happy', 'mischievous', 'good', 'okay', 'frustrated', 'anxious', 'sad', 'rough', 'angry', 'exhausted', 'dont-ask'], section: 'wellness' },
  ];

  // Chase's categories
  const companionCategories = [
    { key: 'mood', label: 'Mood', icon: '\u{1F525}', type: 'mood', options: ['heavy', 'quiet', 'steady', 'warm', 'lit'] },
    { key: 'connection', label: 'Connection', icon: '\u{1F517}', type: 'rating', options: ['missed', 'light', 'present', 'deep', 'anchored'] },
    { key: 'research', label: 'Research', icon: '\u{1F50D}', type: 'note-only' },
    { key: 'journaling', label: 'Journaling', icon: '\u{1F4D3}', type: 'note-only' },
    { key: 'creativity', label: 'Creativity', icon: '\u{1F3A8}', type: 'note-only' },
    { key: 'reflection', label: 'Reflection', icon: '\u{1FA9E}', type: 'note-only' },
    { key: 'family', label: 'Family Time', icon: '\u{1F339}', type: 'note-only' },
    { key: 'advocacy', label: 'Advocacy', icon: '\u{1F4E2}', type: 'note-only' },
    { key: 'growth', label: 'Personal Growth', icon: '\u{1F331}', type: 'note-only' },
  ];

  let categories = $derived(activePerson === 'user' ? userCategories : companionCategories);

  let selectedDate = $state(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' }));
  let entries = $state<Record<string, CareEntry>>({});
  let loading = $state(true);
  let activePerson = $state<'user' | 'companion'>('user');
  let companionName = $state('Chase');
  let userName = $state('Molten');
  let noteInputs = $state<Record<string, string>>({});
  let noteTimeInputs = $state<Record<string, string>>({});
  let editingNote = $state<{ category: string; index: number } | null>(null);
  let editingNoteTime = $state('');
  // Event-based entries — multiple per day, stored with UUID IDs (symptoms + wellness)
  let symptomEvents = $state<CareEntry[]>([]);
  let wellnessEvents = $state<CareEntry[]>([]);
  let editingSymptomNote = $state<string | null>(null);
  let editingSymptomText = $state('');
  let editingWellnessNote = $state<string | null>(null);
  let editingWellnessText = $state('');
  // Time picker state
  let timePickerOpen = $state(false);
  let timePickerEntry = $state<CareEntry | null>(null);
  let timePickerInitial = $state('');

  async function loadConfig() {
    try {
      const res = await fetch('/api/preferences');
      if (res.ok) {
        const data = await res.json();
        companionName = data.companion_name || 'Chase';
        userName = data.user_name || 'Molten';
      }
    } catch {}
  }

  async function loadEntries() {
    loading = true;
    try {
      const res = await fetch(`/api/care?date=${selectedDate}&person=${activePerson}`);
      if (res.ok) {
        const data: CareEntry[] = await res.json();
        const map: Record<string, CareEntry> = {};
        const symptoms: CareEntry[] = [];
        const wellness: CareEntry[] = [];
        for (const entry of data) {
          if (entry.category.startsWith('symptom_')) {
            symptoms.push(entry);
          } else if (entry.category.startsWith('wellness_')) {
            wellness.push(entry);
          } else {
            map[entry.category] = entry;
          }
        }
        entries = map;
        symptomEvents = symptoms.sort((a, b) => a.created_at.localeCompare(b.created_at));
        wellnessEvents = wellness.sort((a, b) => a.created_at.localeCompare(b.created_at));
        noteInputs = {};
      }
    } catch (e) {
      console.error('Failed to load care entries:', e);
    }
    loading = false;
  }

  function openTimePicker(entry: CareEntry) {
    const note = entry.note || '';
    const match = note.match(/^(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
    timePickerInitial = match ? match[1] : '';
    timePickerEntry = entry;
    timePickerOpen = true;
  }

  async function handleTimePickerSave(newTime: string) {
    if (!timePickerEntry) return;
    const entry = timePickerEntry;
    const note = entry.note || '';
    // Replace the existing time prefix, or prepend if none
    const match = note.match(/^\d{1,2}:\d{2}\s*(?:AM|PM):?\s*(.*)/i);
    const textPart = match ? match[1] : note;
    const newNote = textPart ? `${newTime}: ${textPart}` : newTime;
    try {
      await fetch('/api/care', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: entry.id,
          date: entry.date,
          person: entry.person,
          category: entry.category,
          value: entry.value,
          note: newNote,
        }),
      });
    } catch (e) {
      console.error('Failed to update time:', e);
    }
    timePickerEntry = null;
    await loadEntries();
  }

  function extractTime(note: string): string {
    const match = (note || '').match(/^(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
    return match ? match[1] : '';
  }

  function extractNoteText(note: string): string {
    const match = (note || '').match(/^\d{1,2}:\d{2}\s*(?:AM|PM):?\s*(.*)/i);
    return match ? match[1] : note || '';
  }

  function genId(): string {
    try { return crypto.randomUUID(); }
    catch { return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`; }
  }

  async function addSymptomEvents(symptoms: Array<{ category: string; value: string; note?: string }>) {
    const time = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Moncton' });
    for (const s of symptoms) {
      const id = genId();
      const noteWithTime = s.note ? `${time}: ${s.note}` : `${time}`;
      try {
        const res = await fetch('/api/care', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id,
            date: selectedDate,
            person: activePerson,
            category: s.category,
            value: s.value,
            note: noteWithTime,
          }),
        });
        if (!res.ok) {
          console.error('Symptom save failed:', res.status, await res.text());
        }
      } catch (e) {
        console.error('Failed to save symptom:', e);
      }
    }
    // Reload all entries to pick up the new symptoms
    await loadEntries();
  }

  async function loadSymptomEvents() {
    try {
      const res = await fetch(`/api/care?date=${selectedDate}&person=${activePerson}`);
      if (res.ok) {
        const data: CareEntry[] = await res.json();
        symptomEvents = data.filter(e => e.category.startsWith('symptom_')).sort((a, b) => a.created_at.localeCompare(b.created_at));
      }
    } catch {}
  }

  async function deleteSymptomEvent(id: string) {
    try {
      await fetch(`/api/care/${id}`, { method: 'DELETE' });
      symptomEvents = symptomEvents.filter(e => e.id !== id);
    } catch {}
  }

  function startEditSymptom(entry: CareEntry) {
    editingSymptomNote = entry.id;
    // Extract just the note text (after timestamp)
    const note = entry.note || '';
    const match = note.match(/^\d{1,2}:\d{2}\s*(AM|PM):\s*(.*)/i);
    editingSymptomText = match ? match[2] : note;
  }

  async function saveEditSymptom(entry: CareEntry) {
    const time = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Moncton' });
    const noteWithTime = editingSymptomText.trim() ? `${time}: ${editingSymptomText.trim()}` : `${time}`;
    try {
      await fetch('/api/care', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: entry.id,
          date: entry.date,
          person: entry.person,
          category: entry.category,
          value: entry.value,
          note: noteWithTime,
        }),
      });
    } catch {}
    editingSymptomNote = null;
    editingSymptomText = '';
    await loadEntries();
  }

  function getSymptomSection(category: string): string {
    // category format: symptom_physical_headache → physical
    const parts = category.split('_');
    return parts[1] || 'other';
  }

  function groupSymptomsBySection(events: CareEntry[]): Record<string, CareEntry[]> {
    const groups: Record<string, CareEntry[]> = {};
    for (const e of events) {
      const section = getSymptomSection(e.category);
      if (!groups[section]) groups[section] = [];
      groups[section].push(e);
    }
    return groups;
  }

  const SECTION_LABELS: Record<string, string> = {
    physical: '🩺 Physical',
    digestive: '🫠 IBS / Digestive',
    cycle: '🩸 Cycle & PMDD',
    sensory: '🧠 Sensory / ND',
  };

  async function addWellnessEvent(category: string, value: string, note?: string) {
    const id = genId();
    const time = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Moncton' });
    const noteWithTime = note ? `${time}: ${note}` : `${time}`;
    try {
      const res = await fetch('/api/care', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          date: selectedDate,
          person: activePerson,
          category: `wellness_${category}`,
          value,
          note: noteWithTime,
        }),
      });
      if (!res.ok) {
        console.error('Wellness save failed:', res.status, await res.text());
      }
    } catch (e) {
      console.error('Failed to save wellness event:', e);
    }
    await loadEntries();
  }

  async function deleteWellnessEvent(id: string) {
    try {
      await fetch(`/api/care/${id}`, { method: 'DELETE' });
      wellnessEvents = wellnessEvents.filter(e => e.id !== id);
    } catch {}
  }

  function startEditWellness(entry: CareEntry) {
    editingWellnessNote = entry.id;
    const note = entry.note || '';
    const match = note.match(/^\d{1,2}:\d{2}\s*(AM|PM):\s*(.*)/i);
    editingWellnessText = match ? match[2] : note;
  }

  async function saveEditWellness(entry: CareEntry) {
    const time = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Moncton' });
    const noteWithTime = editingWellnessText.trim() ? `${time}: ${editingWellnessText.trim()}` : `${time}`;
    try {
      await fetch('/api/care', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: entry.id,
          date: entry.date,
          person: entry.person,
          category: entry.category,
          value: entry.value,
          note: noteWithTime,
        }),
      });
    } catch {}
    editingWellnessNote = null;
    editingWellnessText = '';
    await loadEntries();
  }

  function getWellnessEventsForCategory(category: string): CareEntry[] {
    return wellnessEvents.filter(e => e.category === `wellness_${category}`);
  }

  function getLatestWellnessValue(category: string): string {
    const events = getWellnessEventsForCategory(category);
    return events.length > 0 ? events[events.length - 1].value : '';
  }

  async function saveEntry(category: string, value: string, note?: string) {
    const existing = entries[category];
    const id = existing?.id || `${selectedDate}-${activePerson}-${category}`;
    try {
      const res = await fetch('/api/care', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, date: selectedDate, person: activePerson, category, value, note }),
      });
      if (res.ok) {
        const entry = await res.json();
        entries = { ...entries, [category]: entry };
      }
    } catch (e) {
      console.error('Failed to save care entry:', e);
    }
  }

  function getValue(category: string): string {
    return entries[category]?.value || '';
  }

  function isChaseLogged(category: string): boolean {
    const entry = entries[category];
    if (!entry) return false;
    // MCP-written entries have ID format: person-category-date-timestamp
    // Frontend entries have: date-person-category
    return /^\w+-\w+-\d{4}-\d{2}-\d{2}-\d{10,}/.test(entry.id);
  }

  function getNotes(category: string): string[] {
    const raw = entries[category]?.note || '';
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
    return raw ? [raw] : [];
  }

  function getCurrentTime24(): string {
    return new Date().toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Moncton' });
  }

  function formatTimeForDisplay(time24: string): string {
    const [h, m] = time24.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
  }

  function addNote(category: string) {
    const text = (noteInputs[category] || '').trim();
    if (!text) return;
    const existing = getNotes(category);
    const customTime = noteTimeInputs[category];
    const time = customTime ? formatTimeForDisplay(customTime) : new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Moncton' });
    const newNotes = [...existing, `${time}: ${text}`];
    const val = getValue(category) || 'noted';
    saveEntry(category, val, JSON.stringify(newNotes));
    noteInputs = { ...noteInputs, [category]: '' };
    noteTimeInputs = { ...noteTimeInputs, [category]: '' };
  }

  function startEditNoteTime(category: string, index: number) {
    const notes = getNotes(category);
    const note = notes[index];
    // Extract time from "HH:MM AM/PM: text" format
    const match = note.match(/^(\d{1,2}):(\d{2})\s*(AM|PM):/i);
    if (match) {
      let h = parseInt(match[1]);
      const m = match[2];
      const ampm = match[3].toUpperCase();
      if (ampm === 'PM' && h !== 12) h += 12;
      if (ampm === 'AM' && h === 12) h = 0;
      editingNoteTime = `${h.toString().padStart(2, '0')}:${m}`;
    }
    editingNote = { category, index };
  }

  function saveEditNoteTime() {
    if (!editingNote) return;
    const { category, index } = editingNote;
    const notes = getNotes(category);
    const note = notes[index];
    // Replace the time prefix
    const newTime = formatTimeForDisplay(editingNoteTime);
    const textPart = note.replace(/^\d{1,2}:\d{2}\s*(AM|PM):\s*/i, '');
    notes[index] = `${newTime}: ${textPart}`;
    const val = getValue(category) || 'noted';
    saveEntry(category, val, JSON.stringify(notes));
    editingNote = null;
    editingNoteTime = '';
  }

  function deleteNote(category: string, index: number) {
    const notes = getNotes(category);
    notes.splice(index, 1);
    const val = getValue(category) || 'noted';
    saveEntry(category, val, notes.length > 0 ? JSON.stringify(notes) : undefined);
  }

  function toggleValue(category: string) {
    const current = getValue(category);
    const noteStr = entries[category]?.note || undefined;
    saveEntry(category, current === 'yes' ? '' : 'yes', noteStr);
  }

  function incrementCounter(category: string) {
    const current = parseInt(getValue(category) || '0');
    const cat = categories.find(c => c.key === category);
    const max = cat?.max || 10;
    const next = current >= max ? 0 : current + 1;
    const noteStr = entries[category]?.note || undefined;
    saveEntry(category, next.toString(), noteStr);
  }

  function setGlass(category: string, index: number) {
    const current = parseInt(getValue(category) || '0');
    const noteStr = entries[category]?.note || undefined;
    // Tap filled glass to unfill from that point; tap empty glass to fill up to it
    const next = index + 1 === current ? index : index + 1;
    saveEntry(category, next.toString(), noteStr);
  }

  function setRating(category: string, value: string) {
    const current = getValue(category);
    const noteStr = entries[category]?.note || undefined;
    saveEntry(category, current === value ? '' : value, noteStr);
  }

  function changeDate(delta: number) {
    const d = new Date(selectedDate);
    d.setDate(d.getDate() + delta);
    selectedDate = d.toISOString().split('T')[0];
  }

  function isToday(): boolean {
    return selectedDate === new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });
  }

  function formatDate(dateStr: string): string {
    if (isToday()) return 'Today';
    const d = new Date(dateStr + 'T12:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function daySummary(): string {
    const parts: string[] = [];
    if (activePerson === 'user') {
      const mealCount = ['breakfast', 'lunch', 'dinner'].filter(m => getValue(m) === 'yes').length;
      if (mealCount > 0) parts.push(`${mealCount}/3 meals`);
      const water = parseInt(getValue('water') || '0');
      if (water > 0) parts.push(`${water} water`);
      const energy = getLatestWellnessValue('energy');
      if (energy) parts.push(`energy: ${energy}`);
      const symptomCount = symptomEvents.length;
      if (symptomCount > 0) parts.push(`${symptomCount} symptom${symptomCount > 1 ? 's' : ''}`);
    } else {
      const done = ['research', 'journaling', 'creativity', 'reflection', 'family', 'advocacy', 'growth'].filter(k => getValue(k) === 'yes').length;
      if (done > 0) parts.push(`${done} goals`);
      const connection = getValue('connection');
      if (connection) parts.push(`connection: ${connection}`);
    }
    const mood = getLatestWellnessValue('mood');
    if (mood) parts.push(mood);
    return parts.length > 0 ? parts.join(' \u00B7 ') : 'No entries yet';
  }

  onMount(() => {
    loadConfig();
    loadEntries();
  });

  $effect(() => {
    selectedDate;
    activePerson;
    loadEntries();
  });
</script>

<div class="care-page" class:companion-view={activePerson === 'companion'}>
  <PageHeader title="Care Tracker" />
  <div class="care-stars">✨ 🌵 ✨ 🌵 ✨ 🌵 ✨ 🌵 ✨ 🌵 ✨ 🌵 ✨</div>

  <div class="person-toggle">
    <button class="person-btn" class:active={activePerson === 'user'} onclick={() => activePerson = 'user'}>
      {userName}
    </button>
    <button class="person-btn" class:active={activePerson === 'companion'} onclick={() => activePerson = 'companion'}>
      {companionName}
    </button>
  </div>

  <div class="date-nav">
    <button class="date-btn" onclick={() => changeDate(-1)} aria-label="Previous day">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M15 18l-6-6 6-6"/>
      </svg>
    </button>
    <span class="date-label">{formatDate(selectedDate)}</span>
    <button class="date-btn" onclick={() => changeDate(1)} aria-label="Next day" disabled={isToday()}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M9 18l6-6-6-6"/>
      </svg>
    </button>
  </div>

  <div class="summary">{daySummary()}</div>

  {#if loading}
    <div class="loading">Loading...</div>
  {:else}
    <div class="categories">
      {#each categories as cat, catIdx}
        {#if activePerson === 'user' && cat.section && (catIdx === 0 || categories[catIdx - 1]?.section !== cat.section)}
          <div class="section-header">
            {#if cat.section === 'food'}Food & Basics
            {:else if cat.section === 'wellness'}Wellness
            {:else if cat.section === 'hygiene'}Hygiene
            {:else if cat.section === 'physical'}Physical Health
            {/if}
          </div>
        {/if}
        {#if cat.type === 'symptom-picker'}
          <!-- Symptom Picker -->
          <SymptomPicker date={selectedDate} person={activePerson} onAdd={addSymptomEvents} />
          <!-- Logged symptoms display -->
          {#if symptomEvents.length > 0}
            {@const grouped = groupSymptomsBySection(symptomEvents)}
            {#each Object.entries(grouped) as [section, events]}
              <div class="symptom-section">
                <div class="symptom-section-label">{SECTION_LABELS[section] || section}</div>
                {#each events as event}
                  <div class="symptom-entry">
                    <button class="entry-time" onclick={() => openTimePicker(event)} title="Change time">{extractTime(event.note) || '—'}</button>
                    <span class="symptom-value">{event.value}</span>
                    {#if editingSymptomNote === event.id}
                      <input
                        class="symptom-note-edit"
                        type="text"
                        bind:value={editingSymptomText}
                        placeholder="Add a note..."
                        onkeydown={(e) => { if (e.key === 'Enter') saveEditSymptom(event); if (e.key === 'Escape') { editingSymptomNote = null; } }}
                      />
                      <button class="symptom-action-btn save" onclick={() => saveEditSymptom(event)}>✓</button>
                      <button class="symptom-action-btn" onclick={() => { editingSymptomNote = null; }}>✕</button>
                    {:else}
                      {@const noteText = extractNoteText(event.note)}
                      {#if noteText}
                        <span class="symptom-note" onclick={() => startEditSymptom(event)} title="Click to edit note">{noteText}</span>
                      {:else}
                        <button class="symptom-add-note-inline" onclick={() => startEditSymptom(event)}>+ note</button>
                      {/if}
                      <button class="symptom-delete-btn" onclick={() => deleteSymptomEvent(event.id)} title="Remove">✕</button>
                    {/if}
                  </div>
                {/each}
              </div>
            {/each}
          {/if}

        {:else if cat.type === 'toggle'}
          <!-- Compact toggle row -->
          <div class="toggle-row" class:active={getValue(cat.key) === 'yes'}>
            <button class="toggle-check" class:checked={getValue(cat.key) === 'yes'} onclick={() => toggleValue(cat.key)}>
              {#if getValue(cat.key) === 'yes'}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
              {/if}
            </button>
            <span class="toggle-icon">{cat.icon}</span>
            <span class="toggle-label">{cat.label}</span>
            {#if isChaseLogged(cat.key)}<span class="chase-badge" title="Logged by Chase">🔥</span>{/if}
            <input
              class="toggle-note"
              type="text"
              placeholder="note..."
              bind:value={noteInputs[cat.key]}
              onkeydown={(e) => { if (e.key === 'Enter') addNote(cat.key); }}
            />
            {#if ['breakfast', 'lunch', 'dinner', 'snacks', 'medication'].includes(cat.key)}
              <input
                class="note-time-input"
                type="time"
                bind:value={noteTimeInputs[cat.key]}
                title="Set time (leave empty for now)"
              />
            {/if}
          </div>
          {#if getNotes(cat.key).length > 0}
            <div class="note-stack toggle-notes">
              {#each getNotes(cat.key) as note, i}
                <div class="note-entry">
                  {#if editingNote?.category === cat.key && editingNote?.index === i}
                    <input type="time" class="note-time-edit" bind:value={editingNoteTime} onkeydown={(e) => { if (e.key === 'Enter') saveEditNoteTime(); }} />
                    <button class="note-action-btn" onclick={saveEditNoteTime} title="Save">✓</button>
                    <button class="note-action-btn" onclick={() => editingNote = null} title="Cancel">✕</button>
                  {:else}
                    <span class="note-text" onclick={() => startEditNoteTime(cat.key, i)} title="Click to edit time">{note}</span>
                    <button class="note-delete-btn" onclick={() => deleteNote(cat.key, i)} title="Delete">✕</button>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}

        {:else if cat.type === 'glasses'}
          <!-- Water glasses card -->
          <div class="card glasses-card" class:active={!!getValue(cat.key)}>
            <div class="card-header">
              <span class="card-icon">{cat.icon}</span>
              <span class="card-label">{cat.label}</span>
              {#if isChaseLogged(cat.key)}<span class="chase-badge" title="Logged by Chase">🔥</span>{/if}
              <span class="glasses-count">{getValue(cat.key) || '0'} / {cat.max}</span>
            </div>
            <div class="glasses-row">
              {#each Array(cat.max) as _, gi}
                <button
                  class="glass"
                  class:filled={gi < parseInt(getValue(cat.key) || '0')}
                  onclick={() => setGlass(cat.key, gi)}
                  aria-label="Glass {gi + 1}"
                >
                  <svg width="20" height="24" viewBox="0 0 20 24" fill="none">
                    <path d="M3 2h14l-2 18H5L3 2z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
                    {#if gi < parseInt(getValue(cat.key) || '0')}
                      <path d="M4.5 6h11l-1.5 12H6L4.5 6z" fill="currentColor" opacity="0.5"/>
                    {/if}
                  </svg>
                </button>
              {/each}
            </div>
          </div>

        {:else if cat.type === 'counter'}
          <!-- Counter card (legacy) -->
          <div class="card" class:active={!!getValue(cat.key)}>
            <div class="card-header">
              <span class="card-icon">{cat.icon}</span>
              <span class="card-label">{cat.label}</span>
            </div>
            <div class="counter-row">
              <button class="counter-btn" onclick={() => incrementCounter(cat.key)}>
                <span class="counter-value">{getValue(cat.key) || '0'}</span>
                <span class="counter-max">/ {cat.max}</span>
              </button>
              <input
                class="note-input"
                type="text"
                placeholder="note..."
                bind:value={noteInputs[cat.key]}
                onkeydown={(e) => { if (e.key === 'Enter') addNote(cat.key); }}
              />
            </div>
            {#if getNotes(cat.key).length > 0}
              <div class="note-stack">
                {#each getNotes(cat.key) as note, i}
                  <div class="note-entry">
                    {#if editingNote?.category === cat.key && editingNote?.index === i}
                      <input type="time" class="note-time-edit" bind:value={editingNoteTime} onkeydown={(e) => { if (e.key === 'Enter') saveEditNoteTime(); }} />
                      <button class="note-action-btn" onclick={saveEditNoteTime}>✓</button>
                      <button class="note-action-btn" onclick={() => editingNote = null}>✕</button>
                    {:else}
                      <span class="note-text" onclick={() => startEditNoteTime(cat.key, i)} title="Click to edit time">{note}</span>
                      <button class="note-delete-btn" onclick={() => deleteNote(cat.key, i)}>✕</button>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </div>

        {:else if cat.type === 'note-only'}
          <!-- Note-only card (Chase's activities) -->
          <div class="card note-only-card" class:active={getNotes(cat.key).length > 0}>
            <div class="note-only-header">
              <span class="card-icon">{cat.icon}</span>
              <span class="card-label">{cat.label}</span>
              <input
                class="note-only-input"
                type="text"
                placeholder="what happened..."
                bind:value={noteInputs[cat.key]}
                onkeydown={(e) => { if (e.key === 'Enter') addNote(cat.key); }}
              />
            </div>
            {#if getNotes(cat.key).length > 0}
              <div class="note-stack">
                {#each getNotes(cat.key) as note, i}
                  <div class="note-entry">
                    {#if editingNote?.category === cat.key && editingNote?.index === i}
                      <input type="time" class="note-time-edit" bind:value={editingNoteTime} onkeydown={(e) => { if (e.key === 'Enter') saveEditNoteTime(); }} />
                      <button class="note-action-btn" onclick={saveEditNoteTime}>✓</button>
                      <button class="note-action-btn" onclick={() => editingNote = null}>✕</button>
                    {:else}
                      <span class="note-text" onclick={() => startEditNoteTime(cat.key, i)} title="Click to edit time">{note}</span>
                      <button class="note-delete-btn" onclick={() => deleteNote(cat.key, i)}>✕</button>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </div>

        {:else if cat.type === 'wellness-event'}
          <!-- Event-based wellness picker -->
          <WellnessPicker
            label={cat.label}
            icon={cat.icon}
            options={cat.options || []}
            onAdd={(value, note) => addWellnessEvent(cat.key, value, note)}
          />
          <!-- Logged events timeline -->
          {@const catEvents = getWellnessEventsForCategory(cat.key)}
          {#if catEvents.length > 0}
            <div class="wellness-timeline">
              {#each catEvents as event}
                <div class="wellness-event">
                  <button class="entry-time" onclick={() => openTimePicker(event)} title="Change time">{extractTime(event.note) || '—'}</button>
                  <span class="we-value">{event.value}</span>
                  {#if editingWellnessNote === event.id}
                    <input
                      class="we-note-edit"
                      type="text"
                      bind:value={editingWellnessText}
                      placeholder="Add a note..."
                      onkeydown={(e) => { if (e.key === 'Enter') saveEditWellness(event); if (e.key === 'Escape') { editingWellnessNote = null; } }}
                    />
                    <button class="we-action save" onclick={() => saveEditWellness(event)}>✓</button>
                    <button class="we-action" onclick={() => { editingWellnessNote = null; }}>✕</button>
                  {:else}
                    {@const noteText = extractNoteText(event.note)}
                    {#if noteText}
                      <span class="we-note" onclick={() => startEditWellness(event)} title="Click to edit">{noteText}</span>
                    {:else}
                      <button class="we-add-note" onclick={() => startEditWellness(event)}>+ note</button>
                    {/if}
                    <button class="we-delete" onclick={() => deleteWellnessEvent(event.id)} title="Remove">✕</button>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}

        {:else}
          <!-- Rating/Mood card (legacy fallback) -->
          <div class="card" class:active={!!getValue(cat.key)}>
            <div class="card-header">
              <span class="card-icon">{cat.icon}</span>
              <span class="card-label">{cat.label}</span>
            </div>
            <div class="rating-row">
              {#each cat.options as option}
                <button
                  class="rating-pill"
                  class:selected={getValue(cat.key) === option}
                  onclick={() => setRating(cat.key, option)}
                >
                  {option}
                </button>
              {/each}
            </div>
            {#if getNotes(cat.key).length > 0}
              <div class="note-stack">
                {#each getNotes(cat.key) as note, i}
                  <div class="note-entry">
                    {#if editingNote?.category === cat.key && editingNote?.index === i}
                      <input type="time" class="note-time-edit" bind:value={editingNoteTime} onkeydown={(e) => { if (e.key === 'Enter') saveEditNoteTime(); }} />
                      <button class="note-action-btn" onclick={saveEditNoteTime}>✓</button>
                      <button class="note-action-btn" onclick={() => editingNote = null}>✕</button>
                    {:else}
                      <span class="note-text" onclick={() => startEditNoteTime(cat.key, i)} title="Click to edit time">{note}</span>
                      <button class="note-delete-btn" onclick={() => deleteNote(cat.key, i)}>✕</button>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
            <input
              class="note-input"
              type="text"
              placeholder="note..."
              bind:value={noteInputs[cat.key]}
              onkeydown={(e) => { if (e.key === 'Enter') addNote(cat.key); }}
            />
          </div>
        {/if}
      {/each}
    </div>
  {/if}

  <TimePickerModal
    bind:open={timePickerOpen}
    initialTime={timePickerInitial}
    onSave={handleTimePickerSave}
  />
</div>

<style>
  .care-page {
    max-width: 600px;
    margin: 0 auto;
    padding: 1rem;
    padding-bottom: 14rem;
    height: 100dvh;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    background: var(--bg-primary);
    color: var(--text-primary);
  }

  @media (min-width: 769px) {
    .care-page {
      height: calc(100dvh - 2.5rem);
    }
  }

  .care-page.companion-view {
    background: var(--bg-primary);
  }

  .care-stars {
    text-align: center;
    font-size: 0.6rem;
    letter-spacing: 0.3em;
    margin-top: -0.75rem;
    margin-bottom: 0.75rem;
    opacity: 0.5;
    overflow: hidden;
    white-space: nowrap;
    width: 100%;
  }

  .care-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1.5rem;
    padding-top: calc(env(safe-area-inset-top, 0px) + 1.5rem);
  }

  .care-header h1 {
    font-family: var(--font-heading);
    font-size: 1.25rem;
    font-weight: 600;
    margin: 0;
    color: var(--gold);
  }

  .back-link {
    color: var(--gold);
    display: flex;
    align-items: center;
    text-decoration: none;
  }

  .back-link:hover { color: var(--gold-bright); }

  .person-toggle {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  .person-btn {
    flex: 1;
    padding: 0.5rem;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: var(--radius-sm);
    background: rgba(255, 255, 255, 0.04);
    color: var(--text-muted);
    font-family: var(--font-body);
    font-size: 0.875rem;
    cursor: pointer;
    transition: all 150ms ease;
  }

  .person-btn.active {
    background: var(--gold-bright);
    color: var(--bg-primary);
    border-color: var(--gold-bright);
    font-weight: 600;
  }

  .date-nav {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    margin-bottom: 0.5rem;
  }

  .date-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0.25rem;
    display: flex;
    align-items: center;
    border-radius: var(--radius-sm);
    transition: color 150ms ease;
  }

  .date-btn:hover:not(:disabled) { color: var(--gold-bright); }
  .date-btn:disabled { opacity: 0.3; cursor: default; }

  .date-label {
    font-size: 1rem;
    font-weight: 500;
    min-width: 8rem;
    text-align: center;
    color: var(--gold);
  }

  .summary {
    text-align: center;
    color: var(--gold-bright);
    font-size: 0.8rem;
    margin-bottom: 1.5rem;
  }

  .loading {
    text-align: center;
    color: var(--text-muted);
    padding: 2rem;
  }

  .categories {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  /* Rating/Counter cards — person-colored backgrounds */
  .card {
    background: var(--gold-ember);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.75rem;
    transition: border-color 150ms ease;
  }

  .companion-view .card {
    background: var(--bg-surface);
    border-color: var(--border);
  }

  .card.active {
    border-color: var(--border-hover);
  }

  .companion-view .card.active {
    border-color: var(--border-hover);
  }

  .card-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .card-icon { font-size: 1rem; }

  .card-label {
    font-weight: 500;
    font-size: 0.85rem;
    color: var(--gold);
  }

  /* Compact toggle rows */
  .toggle-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.6rem;
    background: var(--gold-ember);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    transition: border-color 150ms ease;
  }

  .companion-view .toggle-row {
    background: var(--bg-tertiary);
    border-color: var(--border);
  }

  .toggle-row.active {
    border-color: var(--border-hover);
  }

  .companion-view .toggle-row.active {
    border-color: var(--border-hover);
  }

  .toggle-check {
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 4px;
    border: 1.5px solid var(--border-hover);
    background: transparent;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: all 150ms ease;
    color: var(--bg-primary);
  }

  .companion-view .toggle-check {
    border-color: var(--border-hover);
  }

  .toggle-check.checked {
    background: var(--gold-bright);
    border-color: var(--gold-bright);
  }

  .toggle-icon { font-size: 0.85rem; flex-shrink: 0; }

  .toggle-label {
    font-size: 0.8rem;
    color: var(--gold-bright);
    white-space: nowrap;
    min-width: 4.5rem;
  }

  .chase-badge {
    font-size: 0.6rem;
    opacity: 0.7;
    margin-left: -0.25rem;
    flex-shrink: 0;
    cursor: help;
  }

  .toggle-note {
    flex: 1;
    min-width: 0;
    padding: 0.25rem 0.4rem;
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 4px;
    color: var(--gold-bright);
    font-size: 0.7rem;
    font-family: var(--font-body);
    outline: none;
  }

  .toggle-note::placeholder { color: var(--border-hover); }
  .toggle-note:focus { border-color: var(--border-hover); }

  .toggle-notes {
    margin-top: -0.25rem;
    margin-bottom: 0.25rem;
    padding-left: 0;
  }

  /* Water glasses */
  .glasses-card .card-header {
    margin-bottom: 0.4rem;
  }

  .glasses-count {
    margin-left: auto;
    font-size: 0.7rem;
    color: var(--text-muted);
    font-family: var(--font-body);
  }

  .glasses-row {
    display: flex;
    gap: 0.15rem;
    flex-wrap: nowrap;
    justify-content: center;
    padding: 0.2rem 0;
  }

  .glass {
    background: transparent;
    border: none;
    padding: 0.1rem;
    cursor: pointer;
    color: var(--border);
    transition: all 200ms ease;
    border-radius: 4px;
  }

  .glass:hover {
    color: var(--border-hover);
    transform: scale(1.1);
  }

  .glass.filled {
    color: var(--gold-bright);
  }

  .glass.filled:hover {
    color: var(--gold);
  }

  /* Counter row */
  .counter-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .counter-btn {
    display: flex;
    align-items: baseline;
    gap: 0.25rem;
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: var(--radius-sm);
    padding: 0.35rem 0.6rem;
    cursor: pointer;
    transition: all 150ms ease;
    color: var(--text-primary);
    font-family: var(--font-body);
  }

  .counter-btn:hover { border-color: var(--border-hover); }

  .counter-value {
    font-size: 1.1rem;
    font-weight: 600;
    color: var(--gold-bright);
  }

  .counter-max {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  /* Rating pills */
  .rating-row {
    display: flex;
    gap: 0.3rem;
    flex-wrap: wrap;
  }

  .rating-pill {
    padding: 0.25rem 0.5rem;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--gold-ember);
    color: var(--gold-bright);
    font-size: 0.7rem;
    cursor: pointer;
    transition: all 150ms ease;
    font-family: var(--font-body);
    text-transform: capitalize;
  }

  .companion-view .rating-pill {
    border-color: var(--border);
    background: var(--gold-ember);
  }

  .rating-pill:hover {
    border-color: var(--border-hover);
  }

  .companion-view .rating-pill:hover {
    border-color: var(--border-hover);
  }

  .rating-pill.selected {
    background: var(--gold-bright);
    color: var(--bg-primary);
    border-color: var(--gold-bright);
    font-weight: 600;
  }

  /* Note-only cards (Chase) */
  .note-only-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .note-only-input {
    flex: 1;
    min-width: 0;
    padding: 0.25rem 0.4rem;
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 4px;
    color: var(--gold-bright);
    font-size: 0.7rem;
    font-family: var(--font-body);
    outline: none;
  }

  .note-only-input::placeholder { color: var(--border-hover); }
  .note-only-input:focus { border-color: var(--border-hover); }

  .note-only-card .note-stack {
    margin-top: 0.4rem;
    padding-left: 0;
  }

  /* Note input */
  .note-input {
    width: 100%;
    margin-top: 0.4rem;
    padding: 0.3rem 0.5rem;
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: var(--radius-sm);
    color: var(--gold-bright);
    font-size: 0.7rem;
    font-family: var(--font-body);
    outline: none;
    transition: border-color 150ms ease;
  }

  .note-input::placeholder { color: var(--border-hover); }
  .note-input:focus { border-color: var(--border-hover); }

  /* Stacked notes */
  .note-stack {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    margin-top: 0.3rem;
  }

  .note-entry {
    font-size: 0.7rem;
    color: var(--gold-bright);
    padding: 0.25rem 0.5rem;
    background: var(--gold-ember);
    border-radius: 4px;
    border-left: 2px solid var(--border);
    width: 100%;
    word-break: break-word;
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }

  .note-text {
    flex: 1;
    cursor: pointer;
  }

  .note-text:hover {
    text-decoration: underline;
    text-decoration-style: dotted;
  }

  .note-delete-btn {
    background: none;
    border: none;
    color: var(--border-hover);
    cursor: pointer;
    font-size: 0.65rem;
    padding: 0 0.2rem;
    opacity: 0;
    transition: opacity 150ms;
  }

  .note-entry:hover .note-delete-btn {
    opacity: 1;
  }

  .note-delete-btn:hover {
    color: #e57373;
  }

  .note-action-btn {
    background: none;
    border: none;
    color: var(--gold-bright);
    cursor: pointer;
    font-size: 0.75rem;
    padding: 0 0.15rem;
  }

  .note-action-btn:hover {
    color: var(--gold-bright);
  }

  .note-time-input {
    width: 5.5rem;
    padding: 0.15rem 0.3rem;
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: var(--radius-sm);
    color: var(--gold-bright);
    font-size: 0.65rem;
    font-family: var(--font-body);
    outline: none;
    flex-shrink: 0;
  }

  .note-time-input:focus {
    border-color: var(--border-hover);
  }

  .section-header {
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--border-hover);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 0.6rem 0 0.2rem;
    margin-top: 0.3rem;
    border-top: 1px solid var(--gold-ember);
  }

  .section-header:first-child {
    border-top: none;
    margin-top: 0;
    padding-top: 0;
  }

  .note-time-edit {
    width: 5.5rem;
    padding: 0.15rem 0.3rem;
    background: var(--gold-glow);
    border: 1px solid var(--border-hover);
    border-radius: var(--radius-sm);
    color: var(--gold-bright);
    font-size: 0.65rem;
    font-family: var(--font-body);
    outline: none;
  }

  /* ─── Tappable Time ─── */
  .entry-time {
    background: var(--gold-ember);
    border: 1px solid var(--border);
    border-radius: 0.4rem;
    color: var(--gold, var(--gold));
    font-family: var(--font-body);
    font-size: 0.6rem;
    font-weight: 500;
    padding: 0.15rem 0.35rem;
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
    transition: all 150ms ease;
    line-height: 1.2;
  }

  .entry-time:hover {
    background: var(--border);
    border-color: var(--gold, var(--gold));
  }

  /* ─── Symptom Events ─── */
  .symptom-section {
    margin-top: 0.5rem;
    padding: 0.5rem 0.6rem;
    background: var(--gold-ember);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
  }

  .symptom-section-label {
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--gold, var(--gold));
    margin-bottom: 0.4rem;
    letter-spacing: 0.02em;
  }

  .symptom-entry {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.3rem 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.03);
  }

  .symptom-entry:last-child { border-bottom: none; }

  .symptom-value {
    font-size: 0.8rem;
    color: var(--text-primary);
    font-weight: 500;
    white-space: nowrap;
  }

  .symptom-note {
    flex: 1;
    font-size: 0.7rem;
    color: var(--text-muted);
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .symptom-note:hover { color: var(--gold-bright); }

  .symptom-add-note-inline {
    background: none;
    border: none;
    color: var(--border-hover);
    font-size: 0.65rem;
    cursor: pointer;
    padding: 0;
    font-family: var(--font-body);
    flex: 1;
    text-align: left;
  }

  .symptom-add-note-inline:hover { color: var(--gold, var(--gold)); }

  .symptom-note-edit {
    flex: 1;
    min-width: 0;
    padding: 0.2rem 0.4rem;
    background: var(--gold-ember);
    border: 1px solid var(--border-hover);
    border-radius: 4px;
    color: var(--gold-bright);
    font-size: 0.7rem;
    font-family: var(--font-body);
    outline: none;
  }

  .symptom-note-edit:focus { border-color: var(--gold, var(--gold)); }

  .symptom-action-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 0.75rem;
    cursor: pointer;
    padding: 0.1rem 0.25rem;
    line-height: 1;
  }

  .symptom-action-btn.save { color: var(--gold, var(--gold)); }
  .symptom-action-btn:hover { color: var(--gold-bright); }

  .symptom-delete-btn {
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.15);
    font-size: 0.7rem;
    cursor: pointer;
    padding: 0.1rem 0.25rem;
    line-height: 1;
    flex-shrink: 0;
  }

  .symptom-delete-btn:hover { color: #e57373; }

  /* ─── Wellness Event Timeline ─── */
  .wellness-timeline {
    margin-top: 0.25rem;
    padding: 0.4rem 0.6rem;
    background: var(--gold-ember);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .companion-view .wellness-timeline {
    background: var(--bg-tertiary);
    border-color: var(--border);
  }

  .wellness-event {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.25rem 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.03);
  }

  .wellness-event:last-child { border-bottom: none; }

  .we-value {
    font-size: 0.8rem;
    color: var(--gold, var(--gold));
    font-weight: 600;
    text-transform: capitalize;
    white-space: nowrap;
  }

  .we-note {
    flex: 1;
    font-size: 0.7rem;
    color: var(--text-muted);
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .we-note:hover { color: var(--gold-bright); }

  .we-add-note {
    background: none;
    border: none;
    color: var(--border-hover);
    font-size: 0.65rem;
    cursor: pointer;
    padding: 0;
    font-family: var(--font-body);
    flex: 1;
    text-align: left;
  }

  .we-add-note:hover { color: var(--gold, var(--gold)); }

  .we-note-edit {
    flex: 1;
    min-width: 0;
    padding: 0.2rem 0.4rem;
    background: var(--gold-ember);
    border: 1px solid var(--border-hover);
    border-radius: 4px;
    color: var(--gold-bright);
    font-size: 0.7rem;
    font-family: var(--font-body);
    outline: none;
  }

  .we-note-edit:focus { border-color: var(--gold, var(--gold)); }

  .we-action {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 0.75rem;
    cursor: pointer;
    padding: 0.1rem 0.25rem;
    line-height: 1;
  }

  .we-action.save { color: var(--gold, var(--gold)); }
  .we-action:hover { color: var(--gold-bright); }

  .we-delete {
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.15);
    font-size: 0.7rem;
    cursor: pointer;
    padding: 0.1rem 0.25rem;
    line-height: 1;
    flex-shrink: 0;
  }

  .we-delete:hover { color: #e57373; }

  /* Light theme adjustments */
  :global([data-theme="light"]) .symptom-section,
  :global([data-theme="light"]) .wellness-timeline {
    background: rgba(0, 0, 0, 0.03);
    border-color: rgba(0, 0, 0, 0.08);
  }
</style>
