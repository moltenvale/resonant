<script lang="ts">
  import { tick } from 'svelte';

  let { open = $bindable(false), initialTime = '', onSave }: {
    open: boolean;
    initialTime?: string;
    onSave: (time: string) => void;
  } = $props();

  let hours = $state(12);
  let minutes = $state(0);
  let ampm = $state<'AM' | 'PM'>('AM');
  let hourCol: HTMLDivElement;
  let minCol: HTMLDivElement;

  const ITEM_H = 48;

  function parseInitialTime(timeStr: string) {
    if (!timeStr) {
      const now = new Date();
      hours = now.getHours() % 12 || 12;
      minutes = now.getMinutes();
      ampm = now.getHours() >= 12 ? 'PM' : 'AM';
      return;
    }
    const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (match) {
      hours = parseInt(match[1]);
      minutes = parseInt(match[2]);
      ampm = match[3].toUpperCase() as 'AM' | 'PM';
    }
  }

  function scrollToVal(col: HTMLDivElement, value: number) {
    if (!col) return;
    col.scrollTo({ top: value * ITEM_H, behavior: 'smooth' });
  }

  let scrollTimers: Record<string, ReturnType<typeof setTimeout>> = {};

  function snapScroll(col: HTMLDivElement, type: 'h' | 'm') {
    const val = Math.round(col.scrollTop / ITEM_H);
    if (type === 'h') {
      hours = Math.max(1, Math.min(12, val + 1));
    } else {
      minutes = Math.max(0, Math.min(59, val));
    }
  }

  function handleColScroll(col: HTMLDivElement, type: 'h' | 'm') {
    if (scrollTimers[type]) clearTimeout(scrollTimers[type]);
    scrollTimers[type] = setTimeout(() => {
      snapScroll(col, type);
      const val = type === 'h' ? hours - 1 : minutes;
      col.scrollTo({ top: val * ITEM_H, behavior: 'smooth' });
    }, 80);
  }

  function handleWheel(e: WheelEvent, col: HTMLDivElement, type: 'h' | 'm') {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 1 : -1;
    if (type === 'h') {
      hours = Math.max(1, Math.min(12, hours + delta));
      scrollToVal(col, hours - 1);
    } else {
      minutes = Math.max(0, Math.min(59, minutes + delta));
      scrollToVal(col, minutes);
    }
  }

  function clickItem(type: 'h' | 'm', val: number) {
    if (type === 'h') {
      hours = val;
      if (hourCol) scrollToVal(hourCol, val - 1);
    } else {
      minutes = val;
      if (minCol) scrollToVal(minCol, val);
    }
  }

  function initPicker() {
    requestAnimationFrame(() => {
      if (hourCol) hourCol.scrollTop = (hours - 1) * ITEM_H;
      if (minCol) minCol.scrollTop = minutes * ITEM_H;
    });
  }

  function save() {
    const h = hours;
    const m = String(minutes).padStart(2, '0');
    onSave(`${h}:${m} ${ampm}`);
    open = false;
  }

  $effect(() => {
    if (open) {
      parseInitialTime(initialTime);
      tick().then(initPicker);
    }
  });
</script>

{#if open}
  <div class="tp-overlay" role="dialog" aria-modal="true">
    <div class="tp-modal">
      <div class="tp-header">
        <h3>Set Time</h3>
        <button class="tp-close" onclick={() => open = false}>✕</button>
      </div>

      <div class="tp-picker">
        <!-- Hours -->
        <div
          class="tp-column"
          bind:this={hourCol}
          onscroll={() => handleColScroll(hourCol, 'h')}
          onwheel={(e) => handleWheel(e, hourCol, 'h')}
        >
          <div class="tp-spacer"></div>
          {#each Array(12) as _, i}
            <button
              class="tp-item"
              class:active={hours === i + 1}
              onclick={() => clickItem('h', i + 1)}
            >
              {i + 1}
            </button>
          {/each}
          <div class="tp-spacer"></div>
        </div>

        <span class="tp-colon">:</span>

        <!-- Minutes -->
        <div
          class="tp-column"
          bind:this={minCol}
          onscroll={() => handleColScroll(minCol, 'm')}
          onwheel={(e) => handleWheel(e, minCol, 'm')}
        >
          <div class="tp-spacer"></div>
          {#each Array(60) as _, i}
            <button
              class="tp-item"
              class:active={minutes === i}
              onclick={() => clickItem('m', i)}
            >
              {String(i).padStart(2, '0')}
            </button>
          {/each}
          <div class="tp-spacer"></div>
        </div>

        <!-- AM/PM toggle -->
        <div class="tp-ampm">
          <button class="tp-ampm-btn" class:active={ampm === 'AM'} onclick={() => ampm = 'AM'}>AM</button>
          <button class="tp-ampm-btn" class:active={ampm === 'PM'} onclick={() => ampm = 'PM'}>PM</button>
        </div>
      </div>

      <div class="tp-actions">
        <button class="tp-cancel" onclick={() => open = false}>Cancel</button>
        <button class="tp-save" onclick={save}>Set Time</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .tp-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.7);
    backdrop-filter: blur(4px);
    z-index: 250;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    animation: tp-fade 150ms ease;
  }

  @keyframes tp-fade {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .tp-modal {
    width: 100%;
    max-width: 340px;
    background: var(--bg-surface, #1f1f23);
    border-radius: 1.5rem;
    padding: 1.25rem;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  }

  .tp-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1rem;
  }

  .tp-header h3 {
    margin: 0;
    font-family: var(--font-heading);
    font-size: 1rem;
    color: var(--text-primary, #e4e4e7);
  }

  .tp-close {
    background: none;
    border: none;
    color: var(--text-muted, #71717a);
    font-size: 1.2rem;
    cursor: pointer;
    padding: 0.25rem;
    line-height: 1;
  }

  /* Picker columns */
  .tp-picker {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    height: 192px;
    position: relative;
  }

  /* Highlight band — narrow, matches planner style */
  .tp-picker::before {
    content: '';
    position: absolute;
    top: 50%;
    left: 1rem;
    right: 5.5rem; /* stop before AM/PM column */
    height: 44px;
    transform: translateY(-50%);
    background: rgba(94, 171, 165, 0.1);
    border-radius: 0.75rem;
    pointer-events: none;
    z-index: 1;
  }

  .tp-column {
    height: 192px;
    overflow-y: auto;
    scroll-snap-type: y mandatory;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    position: relative;
    z-index: 2;
    width: 60px;
  }

  .tp-column::-webkit-scrollbar { display: none; }

  .tp-spacer {
    height: 72px; /* (192 - 48) / 2 to center the active item */
    flex-shrink: 0;
  }

  .tp-item {
    height: 48px;
    display: flex;
    align-items: center;
    justify-content: center;
    scroll-snap-align: center;
    background: none;
    border: none;
    color: var(--text-muted, #71717a);
    font-family: var(--font-body);
    font-size: 1.2rem;
    cursor: pointer;
    width: 100%;
    transition: all 100ms ease;
    flex-shrink: 0;
  }

  .tp-item.active {
    color: var(--gold, #5eaba5);
    font-weight: 700;
    font-size: 1.4rem;
  }

  .tp-colon {
    font-size: 1.5rem;
    color: var(--gold, #5eaba5);
    font-weight: 700;
    padding-bottom: 2px;
    z-index: 2;
  }

  /* AM/PM — stacked, offset right like planner */
  .tp-ampm {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin-left: 0.75rem;
    z-index: 2;
    align-self: center;
  }

  .tp-ampm-btn {
    padding: 0.35rem 0.6rem;
    border-radius: 0.5rem;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: transparent;
    color: var(--text-muted, #71717a);
    font-family: var(--font-body);
    font-size: 0.75rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 150ms ease;
  }

  .tp-ampm-btn.active {
    background: var(--gold, #5eaba5);
    color: #000;
    border-color: var(--gold, #5eaba5);
  }

  /* Actions */
  .tp-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    margin-top: 1rem;
  }

  .tp-cancel {
    padding: 0.5rem 1rem;
    border-radius: 2rem;
    border: none;
    background: rgba(255, 255, 255, 0.06);
    color: var(--text-muted, #71717a);
    font-family: var(--font-body);
    font-size: 0.8rem;
    cursor: pointer;
  }

  .tp-save {
    padding: 0.5rem 1rem;
    border-radius: 2rem;
    border: none;
    background: var(--gold, #5eaba5);
    color: #000;
    font-family: var(--font-body);
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
  }

  .tp-cancel:hover { background: rgba(255, 255, 255, 0.1); }
  .tp-save:hover { opacity: 0.9; }
</style>
