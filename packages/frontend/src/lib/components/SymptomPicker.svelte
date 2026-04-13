<script lang="ts">
  import { onMount } from 'svelte';

  let { date, person = 'user', onAdd }: {
    date: string;
    person?: string;
    onAdd: (symptoms: Array<{ category: string; value: string; note?: string }>) => Promise<void> | void;
  } = $props();

  let saving = $state(false);

  let open = $state(false);
  let activeTab = $state('physical');
  let selected = $state<Set<string>>(new Set());
  let noteMode = $state(false);
  let notes = $state<Record<string, string>>({});
  let currentNoteKey = $state('');
  let noteText = $state('');
  let notePopup = $state(false);

  const SYMPTOM_CATEGORIES: Record<string, { label: string; icon: string; items: Array<{ key: string; label: string }> }> = {
    physical: {
      label: 'Physical',
      icon: '🩺',
      items: [
        { key: 'headache', label: 'Headache' },
        { key: 'migraine', label: 'Migraine' },
        { key: 'neck_pain', label: 'Neck Pain / Stiffness' },
        { key: 'shoulder_pain', label: 'Shoulder Pain / Stiffness' },
        { key: 'back_pain', label: 'Back Pain' },
        { key: 'muscle_tension', label: 'Muscle Tension / Pain' },
        { key: 'joint_pain', label: 'Joint Pain / Stiffness' },
        { key: 'chest_tightness', label: 'Chest Tightness / Panic' },
        { key: 'jaw_tmj', label: 'Jaw Clenching / TMJ' },
        { key: 'fatigue', label: 'Fatigue (beyond tired)' },
        { key: 'nausea', label: 'Nausea' },
        { key: 'dizziness', label: 'Dizziness / Lightheadedness' },
        { key: 'eye_strain', label: 'Eye Strain / Pressure' },
        { key: 'stomach_pain', label: 'Stomach Pain / Cramping' },
      ],
    },
    digestive: {
      label: 'IBS / Digestive',
      icon: '🫠',
      items: [
        { key: 'bloating', label: 'Bloating' },
        { key: 'cramping', label: 'Cramping' },
        { key: 'dig_nausea', label: 'Nausea' },
        { key: 'acid_reflux', label: 'Acid Reflux' },
        { key: 'food_reaction', label: 'Food Sensitivity Reaction' },
        { key: 'appetite_increase', label: 'Appetite Increase' },
        { key: 'appetite_decrease', label: 'Appetite Decrease' },
        { key: 'too_easy', label: '💩 Too Easy' },
        { key: 'too_hard', label: '💩 Too Hard' },
        { key: 'diarrhea', label: 'Diarrhea' },
        { key: 'constipation', label: 'Constipation' },
      ],
    },
    cycle: {
      label: 'Cycle & PMDD',
      icon: '🩸',
      items: [
        // Flow
        { key: 'flow_spotting', label: '◦ Spotting' },
        { key: 'flow_light', label: '◦ Light Flow' },
        { key: 'flow_moderate', label: '◦ Moderate Flow' },
        { key: 'flow_heavy', label: '◦ Heavy Flow' },
        // Symptoms
        { key: 'cramps', label: 'Cramps' },
        { key: 'cycle_back_pain', label: 'Back Pain' },
        { key: 'pelvic_pain', label: 'Pelvic Pain' },
        { key: 'breast_tenderness', label: 'Breast Tenderness' },
        { key: 'cycle_bloating', label: 'Bloating' },
        { key: 'cycle_appetite', label: 'Appetite Changes' },
        { key: 'temp_sensitivity', label: 'Temperature Sensitivity' },
        { key: 'chills', label: 'Chills' },
        { key: 'hot_flashes', label: 'Hot Flashes' },
        { key: 'night_sweats', label: 'Night Sweats' },
        { key: 'brain_fog', label: 'Brain Fog' },
        { key: 'dissociation', label: 'Dissociation' },
        { key: 'emotional_flooding', label: 'Emotional Flooding' },
        { key: 'irritability', label: 'Irritability / Rage' },
        { key: 'rejection_sensitivity', label: 'Rejection Sensitivity Spike' },
        { key: 'weepiness', label: 'Weepiness' },
        { key: 'anxiety_spike', label: 'Anxiety Spike' },
        { key: 'mood_changes', label: 'Mood Changes' },
        { key: 'memory_lapse', label: 'Memory Lapse' },
        { key: 'cycle_fatigue', label: 'Fatigue' },
        { key: 'sleep_disruption', label: 'Sleep Disruption' },
        { key: 'skin_sensitivity', label: 'Skin Sensitivity' },
        { key: 'dry_skin', label: 'Dry Skin' },
        { key: 'acne', label: 'Acne / Breakouts' },
        { key: 'bladder_incontinence', label: 'Bladder Incontinence' },
        { key: 'dryness', label: 'Dryness' },
        { key: 'cycle_nausea', label: 'Nausea' },
        { key: 'cycle_constipation', label: 'Constipation' },
        { key: 'cycle_diarrhea', label: 'Diarrhea' },
      ],
    },
    sensory: {
      label: 'Sensory / ND',
      icon: '🧠',
      items: [
        { key: 'sensory_overload', label: 'Sensory Overload' },
        { key: 'light_sensitivity', label: 'Light Sensitivity' },
        { key: 'sound_sensitivity', label: 'Sound Sensitivity' },
        { key: 'smell_sensitivity', label: 'Smell Sensitivity' },
        { key: 'texture_sensitivity', label: 'Texture Sensitivity' },
        { key: 'overstimulation', label: 'Overstimulation' },
        { key: 'understimulation', label: 'Understimulation' },
        { key: 'low_tolerance', label: 'Low Tolerance Window' },
        { key: 'interoception', label: 'Interoception Issues' },
        { key: 'anxious_stimming', label: 'Anxious Stimming' },
        { key: 'harmful_stimming', label: 'Harmful Stimming' },
      ],
    },
  };

  const tabs = Object.keys(SYMPTOM_CATEGORIES);

  function toggle(key: string) {
    const next = new Set(selected);
    if (next.has(key)) {
      next.delete(key);
      delete notes[key];
    } else {
      next.add(key);
    }
    selected = next;
  }

  async function handleAdd(withNote: boolean) {
    if (selected.size === 0) return;
    if (withNote) {
      // Start note flow — go through each selected item
      noteMode = true;
      const keys = [...selected];
      currentNoteKey = keys[0];
      noteText = notes[currentNoteKey] || '';
      notePopup = true;
    } else {
      await submitAll();
    }
  }

  async function saveNote() {
    if (noteText.trim()) {
      notes = { ...notes, [currentNoteKey]: noteText.trim() };
    }
    // Move to next selected item that hasn't been noted
    const keys = [...selected];
    const currentIdx = keys.indexOf(currentNoteKey);
    const nextIdx = currentIdx + 1;
    if (nextIdx < keys.length) {
      currentNoteKey = keys[nextIdx];
      noteText = notes[currentNoteKey] || '';
    } else {
      // All done
      notePopup = false;
      await submitAll();
    }
  }

  async function skipNote() {
    const keys = [...selected];
    const currentIdx = keys.indexOf(currentNoteKey);
    const nextIdx = currentIdx + 1;
    if (nextIdx < keys.length) {
      currentNoteKey = keys[nextIdx];
      noteText = notes[currentNoteKey] || '';
    } else {
      notePopup = false;
      await submitAll();
    }
  }

  async function submitAll() {
    const symptoms: Array<{ category: string; value: string; note?: string }> = [];
    for (const key of selected) {
      // Find which category tab this belongs to
      let sectionKey = '';
      let label = key;
      for (const [tabKey, cat] of Object.entries(SYMPTOM_CATEGORIES)) {
        const found = cat.items.find(i => i.key === key);
        if (found) {
          sectionKey = tabKey;
          label = found.label;
          break;
        }
      }
      symptoms.push({
        category: `symptom_${sectionKey}_${key}`,
        value: label,
        note: notes[key],
      });
    }
    saving = true;
    try {
      await onAdd(symptoms);
    } catch (e) {
      console.error('Failed to save symptoms:', e);
    }
    saving = false;
    // Reset
    selected = new Set();
    notes = {};
    noteMode = false;
    notePopup = false;
    noteText = '';
    open = false;
  }

  function getCurrentNoteLabel(): string {
    for (const cat of Object.values(SYMPTOM_CATEGORIES)) {
      const found = cat.items.find(i => i.key === currentNoteKey);
      if (found) return found.label;
    }
    return currentNoteKey;
  }

  function close() {
    open = false;
    selected = new Set();
    notes = {};
    noteMode = false;
    notePopup = false;
  }
</script>

<div class="symptom-picker-trigger">
  <button class="add-symptom-btn" onclick={() => open = true}>
    + Add Symptom
  </button>
</div>

{#if open}
  <div class="sp-overlay" role="dialog" aria-modal="true">
    <div class="sp-modal">
      <div class="sp-header">
        <h3>Log Symptoms</h3>
        <button class="sp-close" onclick={close}>✕</button>
      </div>

      <!-- Category tabs -->
      <div class="sp-tabs">
        {#each tabs as tab}
          <button
            class="sp-tab"
            class:active={activeTab === tab}
            onclick={() => activeTab = tab}
          >
            <span class="sp-tab-icon">{SYMPTOM_CATEGORIES[tab].icon}</span>
            <span class="sp-tab-label">{SYMPTOM_CATEGORIES[tab].label}</span>
          </button>
        {/each}
      </div>

      <!-- Symptom list -->
      <div class="sp-list">
        {#each SYMPTOM_CATEGORIES[activeTab].items as item}
          <button
            class="sp-item"
            class:selected={selected.has(item.key)}
            onclick={() => toggle(item.key)}
          >
            <span class="sp-check">
              {#if selected.has(item.key)}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
              {/if}
            </span>
            <span class="sp-item-label">{item.label}</span>
            {#if notes[item.key]}
              <span class="sp-has-note">📝</span>
            {/if}
          </button>
        {/each}
      </div>

      <!-- Selected count + actions -->
      {#if selected.size > 0}
        <div class="sp-actions">
          <span class="sp-count">{saving ? 'Saving...' : `${selected.size} selected`}</span>
          <button class="sp-add-btn" onclick={() => handleAdd(false)} disabled={saving}>Add</button>
          <button class="sp-add-note-btn" onclick={() => handleAdd(true)} disabled={saving}>Add + Note</button>
        </div>
      {/if}
    </div>

    <!-- Note popup -->
    {#if notePopup}
      <div class="sp-note-overlay">
        <div class="sp-note-modal">
          <h4>{getCurrentNoteLabel()}</h4>
          <textarea
            class="sp-note-input"
            bind:value={noteText}
            placeholder="Optional note..."
            rows="3"
            onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveNote(); } }}
          ></textarea>
          <div class="sp-note-actions">
            <button class="sp-skip-btn" onclick={skipNote}>Skip</button>
            <button class="sp-save-note-btn" onclick={saveNote}>
              {noteText.trim() ? 'Save Note' : 'Skip'}
            </button>
          </div>
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .symptom-picker-trigger {
    display: flex;
    justify-content: center;
    padding: 0.5rem 0;
  }

  .add-symptom-btn {
    background: rgba(255, 255, 255, 0.04);
    border: 1px dashed rgba(255, 255, 255, 0.15);
    border-radius: 1rem;
    color: var(--gold, #5eaba5);
    font-family: var(--font-body);
    font-size: 0.85rem;
    padding: 0.6rem 1.5rem;
    cursor: pointer;
    transition: all 150ms ease;
  }

  .add-symptom-btn:hover {
    background: rgba(255, 255, 255, 0.06);
    border-color: var(--gold, #5eaba5);
  }

  /* Overlay */
  .sp-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.7);
    backdrop-filter: blur(4px);
    z-index: 200;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    animation: sp-fade-in 150ms ease;
  }

  @keyframes sp-fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .sp-modal {
    width: 100%;
    max-width: 480px;
    max-height: 75dvh;
    background: var(--bg-surface, #1f1f23);
    border-radius: 1.5rem 1.5rem 0 0;
    display: flex;
    flex-direction: column;
    animation: sp-slide-up 200ms ease;
    overflow: hidden;
  }

  @keyframes sp-slide-up {
    from { transform: translateY(100%); }
    to { transform: translateY(0); }
  }

  .sp-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1.25rem 0.5rem;
  }

  .sp-header h3 {
    margin: 0;
    font-family: var(--font-heading);
    font-size: 1.1rem;
    color: var(--text-primary, #e4e4e7);
  }

  .sp-close {
    background: none;
    border: none;
    color: var(--text-muted, #71717a);
    font-size: 1.2rem;
    cursor: pointer;
    padding: 0.25rem;
    line-height: 1;
  }

  /* Tabs */
  .sp-tabs {
    display: flex;
    gap: 0.25rem;
    padding: 0.5rem 1rem;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }

  .sp-tabs::-webkit-scrollbar { display: none; }

  .sp-tab {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.4rem 0.75rem;
    border-radius: 2rem;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: transparent;
    color: var(--text-secondary, #a1a1aa);
    font-family: var(--font-body);
    font-size: 0.75rem;
    cursor: pointer;
    white-space: nowrap;
    transition: all 150ms ease;
    flex-shrink: 0;
  }

  .sp-tab.active {
    background: rgba(94, 171, 165, 0.15);
    border-color: var(--gold, #5eaba5);
    color: var(--gold, #5eaba5);
  }

  .sp-tab-icon { font-size: 0.85rem; }

  /* List */
  .sp-list {
    flex: 1;
    overflow-y: auto;
    padding: 0.25rem 1rem 0.5rem;
    -webkit-overflow-scrolling: touch;
  }

  .sp-item {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    width: 100%;
    padding: 0.65rem 0.5rem;
    background: none;
    border: none;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    color: var(--text-secondary, #a1a1aa);
    font-family: var(--font-body);
    font-size: 0.85rem;
    cursor: pointer;
    text-align: left;
    transition: all 100ms ease;
  }

  .sp-item:hover {
    background: rgba(255, 255, 255, 0.03);
  }

  .sp-item.selected {
    color: var(--gold, #5eaba5);
  }

  .sp-check {
    width: 1.25rem;
    height: 1.25rem;
    border-radius: 0.4rem;
    border: 1.5px solid rgba(255, 255, 255, 0.15);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: all 100ms ease;
  }

  .sp-item.selected .sp-check {
    background: var(--gold, #5eaba5);
    border-color: var(--gold, #5eaba5);
    color: #000;
  }

  .sp-item-label { flex: 1; }

  .sp-has-note {
    font-size: 0.7rem;
    opacity: 0.6;
  }

  /* Actions bar */
  .sp-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
    background: var(--bg-surface, #1f1f23);
  }

  .sp-count {
    font-size: 0.75rem;
    color: var(--text-muted, #71717a);
    flex: 1;
  }

  .sp-add-btn, .sp-add-note-btn {
    padding: 0.5rem 1rem;
    border-radius: 2rem;
    border: none;
    font-family: var(--font-body);
    font-size: 0.8rem;
    cursor: pointer;
    transition: all 150ms ease;
  }

  .sp-add-btn {
    background: var(--gold, #5eaba5);
    color: #000;
    font-weight: 600;
  }

  .sp-add-note-btn {
    background: rgba(255, 255, 255, 0.06);
    color: var(--gold, #5eaba5);
    border: 1px solid rgba(94, 171, 165, 0.3);
  }

  .sp-add-btn:hover { opacity: 0.9; }
  .sp-add-note-btn:hover { background: rgba(94, 171, 165, 0.1); }

  /* Note popup */
  .sp-note-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 210;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
  }

  .sp-note-modal {
    width: 100%;
    max-width: 360px;
    background: var(--bg-surface, #1f1f23);
    border-radius: 1.25rem;
    padding: 1.25rem;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  }

  .sp-note-modal h4 {
    margin: 0 0 0.75rem;
    font-family: var(--font-heading);
    font-size: 0.95rem;
    color: var(--gold, #5eaba5);
  }

  .sp-note-input {
    width: 100%;
    background: var(--bg-input, #18181b);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 0.75rem;
    color: var(--text-primary, #e4e4e7);
    font-family: var(--font-body);
    font-size: 0.85rem;
    padding: 0.6rem 0.75rem;
    resize: none;
    outline: none;
  }

  .sp-note-input:focus {
    border-color: var(--gold, #5eaba5);
  }

  .sp-note-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    margin-top: 0.75rem;
  }

  .sp-skip-btn {
    padding: 0.4rem 1rem;
    border-radius: 2rem;
    border: none;
    background: rgba(255, 255, 255, 0.06);
    color: var(--text-muted, #71717a);
    font-family: var(--font-body);
    font-size: 0.8rem;
    cursor: pointer;
  }

  .sp-save-note-btn {
    padding: 0.4rem 1rem;
    border-radius: 2rem;
    border: none;
    background: var(--gold, #5eaba5);
    color: #000;
    font-family: var(--font-body);
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
  }

  /* Safe area for bottom sheet on iOS */
  .sp-modal {
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
</style>
