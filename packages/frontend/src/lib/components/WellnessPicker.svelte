<script lang="ts">
  let { label, icon, options, onAdd }: {
    label: string;
    icon: string;
    options: string[];
    onAdd: (value: string, note?: string) => Promise<void> | void;
  } = $props();

  let open = $state(false);
  let selected = $state('');
  let noteText = $state('');
  let saving = $state(false);
  let showNote = $state(false);

  function select(option: string) {
    selected = selected === option ? '' : option;
  }

  async function handleAdd(withNote: boolean) {
    if (!selected) return;
    if (withNote && !showNote) {
      showNote = true;
      return;
    }
    saving = true;
    try {
      await onAdd(selected, showNote && noteText.trim() ? noteText.trim() : undefined);
    } catch (e) {
      console.error('Failed to save:', e);
    }
    saving = false;
    selected = '';
    noteText = '';
    showNote = false;
    open = false;
  }

  function close() {
    open = false;
    selected = '';
    noteText = '';
    showNote = false;
  }
</script>

<div class="wp-trigger">
  <button class="wp-add-btn" onclick={() => open = true}>
    <span class="wp-icon">{icon}</span>
    <span class="wp-label">+ {label}</span>
  </button>
</div>

{#if open}
  <div class="wp-overlay" role="dialog" aria-modal="true">
    <div class="wp-modal">
      <div class="wp-header">
        <h3>{icon} {label}</h3>
        <button class="wp-close" onclick={close}>✕</button>
      </div>

      <div class="wp-options">
        {#each options as option}
          <button
            class="wp-option"
            class:selected={selected === option}
            onclick={() => select(option)}
          >
            {option}
          </button>
        {/each}
      </div>

      {#if showNote}
        <div class="wp-note-area">
          <textarea
            class="wp-note-input"
            bind:value={noteText}
            placeholder="What's going on?..."
            rows="2"
            onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAdd(true); } }}
          ></textarea>
        </div>
      {/if}

      {#if selected}
        <div class="wp-actions">
          <span class="wp-selected-label">{saving ? 'Saving...' : selected}</span>
          <button class="wp-submit" onclick={() => handleAdd(false)} disabled={saving}>Add</button>
          <button class="wp-submit-note" onclick={() => handleAdd(true)} disabled={saving}>
            {showNote ? 'Add + Note' : '+ Note'}
          </button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .wp-trigger {
    display: flex;
  }

  .wp-add-btn {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    width: 100%;
    padding: 0.6rem 0.75rem;
    background: rgba(255, 255, 255, 0.03);
    border: 1px dashed rgba(255, 255, 255, 0.1);
    border-radius: 0.75rem;
    color: var(--gold, #5eaba5);
    font-family: var(--font-body);
    font-size: 0.8rem;
    cursor: pointer;
    transition: all 150ms ease;
  }

  .wp-add-btn:hover {
    background: rgba(255, 255, 255, 0.05);
    border-color: var(--gold, #5eaba5);
  }

  .wp-icon { font-size: 0.9rem; }
  .wp-label { opacity: 0.8; }

  /* Overlay */
  .wp-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.7);
    backdrop-filter: blur(4px);
    z-index: 200;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    animation: wp-fade 150ms ease;
  }

  @keyframes wp-fade {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .wp-modal {
    width: 100%;
    max-width: 420px;
    background: var(--bg-surface, #1f1f23);
    border-radius: 1.5rem 1.5rem 0 0;
    padding-bottom: env(safe-area-inset-bottom, 0px);
    animation: wp-slide 200ms ease;
    overflow: hidden;
  }

  @keyframes wp-slide {
    from { transform: translateY(100%); }
    to { transform: translateY(0); }
  }

  .wp-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1.25rem 0.5rem;
  }

  .wp-header h3 {
    margin: 0;
    font-family: var(--font-heading);
    font-size: 1rem;
    color: var(--text-primary, #e4e4e7);
  }

  .wp-close {
    background: none;
    border: none;
    color: var(--text-muted, #71717a);
    font-size: 1.2rem;
    cursor: pointer;
    padding: 0.25rem;
    line-height: 1;
  }

  /* Options grid */
  .wp-options {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    padding: 0.75rem 1.25rem;
  }

  .wp-option {
    padding: 0.5rem 0.9rem;
    border-radius: 2rem;
    border: 1px solid rgba(255, 255, 255, 0.1);
    background: rgba(255, 255, 255, 0.03);
    color: var(--text-secondary, #a1a1aa);
    font-family: var(--font-body);
    font-size: 0.8rem;
    cursor: pointer;
    transition: all 150ms ease;
    text-transform: capitalize;
  }

  .wp-option:hover {
    background: rgba(255, 255, 255, 0.06);
    border-color: rgba(255, 255, 255, 0.15);
  }

  .wp-option.selected {
    background: var(--gold, #5eaba5);
    color: #000;
    border-color: var(--gold, #5eaba5);
    font-weight: 600;
  }

  /* Note area */
  .wp-note-area {
    padding: 0 1.25rem 0.5rem;
  }

  .wp-note-input {
    width: 100%;
    background: var(--bg-input, #18181b);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 0.75rem;
    color: var(--text-primary, #e4e4e7);
    font-family: var(--font-body);
    font-size: 0.8rem;
    padding: 0.5rem 0.75rem;
    resize: none;
    outline: none;
  }

  .wp-note-input:focus { border-color: var(--gold, #5eaba5); }

  /* Actions */
  .wp-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1.25rem;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
  }

  .wp-selected-label {
    flex: 1;
    font-size: 0.8rem;
    color: var(--gold, #5eaba5);
    font-weight: 500;
    text-transform: capitalize;
  }

  .wp-submit, .wp-submit-note {
    padding: 0.45rem 0.9rem;
    border-radius: 2rem;
    border: none;
    font-family: var(--font-body);
    font-size: 0.8rem;
    cursor: pointer;
    transition: all 150ms ease;
  }

  .wp-submit {
    background: var(--gold, #5eaba5);
    color: #000;
    font-weight: 600;
  }

  .wp-submit-note {
    background: rgba(255, 255, 255, 0.06);
    color: var(--gold, #5eaba5);
    border: 1px solid rgba(94, 171, 165, 0.3);
  }

  .wp-submit:hover { opacity: 0.9; }
  .wp-submit-note:hover { background: rgba(94, 171, 165, 0.1); }
  .wp-submit:disabled, .wp-submit-note:disabled { opacity: 0.5; cursor: default; }
</style>
