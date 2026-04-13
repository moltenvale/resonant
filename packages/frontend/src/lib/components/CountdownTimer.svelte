<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';

  interface Timer {
    id: string;
    label: string;
    duration_seconds: number;
    started_at: string;
    remaining_seconds: number;
    ends_at: string;
    created_by: string;
  }

  let timers = $state<Timer[]>([]);
  let showCreate = $state(false);
  let newLabel = $state('');
  let newMinutes = $state('');
  let pickerHours = $state(0);
  let pickerMinutes = $state(5);
  let pickerSeconds = $state(0);
  let hourCol: HTMLDivElement;
  let minCol: HTMLDivElement;
  let secCol: HTMLDivElement;
  let tickInterval: ReturnType<typeof setInterval> | null = null;
  let completedTimer = $state<string | null>(null);
  let warningTimer = $state<string | null>(null);
  let overlayEl: HTMLDivElement;
  let sparkleEl: HTMLDivElement;

  function formatTime(seconds: number): string {
    if (seconds <= 0) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  let knownTimerIds = new Set<string>();

  async function fetchTimers() {
    try {
      const res = await fetch('/api/countdown');
      if (res.ok) {
        const data = await res.json();
        // Detect completed timers (were known but no longer in active list)
        const newIds = new Set(data.timers.map((t: Timer) => t.id));
        for (const oldId of knownTimerIds) {
          if (!newIds.has(oldId) && !completedTimer) {
            // A timer we knew about is gone — it completed
            const gone = timers.find(t => t.id === oldId);
            if (gone) {
              completedTimer = gone.label;
              setTimeout(() => completedTimer = null, 8000);
            }
          }
        }
        knownTimerIds = newIds;
        timers = data.timers;
      }
    } catch {}
  }

  async function createTimer() {
    const label = newLabel.trim() || 'Timer';
    const totalSeconds = (pickerHours * 3600) + (pickerMinutes * 60) + pickerSeconds;
    if (totalSeconds <= 0) return;

    try {
      await fetch('/api/countdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, duration_seconds: totalSeconds, created_by: 'user' }),
      });
      newLabel = '';
      pickerHours = 0;
      pickerMinutes = 5;
      pickerSeconds = 0;
      showCreate = false;
      await fetchTimers();
    } catch {}
  }

  const ITEM_H = 44;

  function scrollToVal(col: HTMLDivElement, value: number) {
    if (!col) return;
    col.scrollTo({ top: value * ITEM_H, behavior: 'smooth' });
  }

  function snapScroll(col: HTMLDivElement, type: 'h' | 'm' | 's') {
    const val = Math.round(col.scrollTop / ITEM_H);
    const max = type === 'h' ? 23 : 59;
    const clamped = Math.max(0, Math.min(max, val));
    if (type === 'h') pickerHours = clamped;
    else if (type === 'm') pickerMinutes = clamped;
    else pickerSeconds = clamped;
  }

  // Debounced scroll handler — snaps after scrolling stops
  let scrollTimers: Record<string, ReturnType<typeof setTimeout>> = {};
  function handleColScroll(col: HTMLDivElement, type: 'h' | 'm' | 's') {
    if (scrollTimers[type]) clearTimeout(scrollTimers[type]);
    scrollTimers[type] = setTimeout(() => {
      snapScroll(col, type);
      // Snap position
      const val = type === 'h' ? pickerHours : type === 'm' ? pickerMinutes : pickerSeconds;
      col.scrollTo({ top: val * ITEM_H, behavior: 'smooth' });
    }, 80);
  }

  function clickItem(col: HTMLDivElement, type: 'h' | 'm' | 's', val: number) {
    if (type === 'h') pickerHours = val;
    else if (type === 'm') pickerMinutes = val;
    else pickerSeconds = val;
    scrollToVal(col, val);
  }

  // Mouse wheel on desktop
  function handleWheel(e: WheelEvent, col: HTMLDivElement, type: 'h' | 'm' | 's') {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 1 : -1;
    const max = type === 'h' ? 23 : 59;
    let current = type === 'h' ? pickerHours : type === 'm' ? pickerMinutes : pickerSeconds;
    const next = Math.max(0, Math.min(max, current + delta));
    if (type === 'h') pickerHours = next;
    else if (type === 'm') pickerMinutes = next;
    else pickerSeconds = next;
    scrollToVal(col, next);
  }

  function initPicker() {
    requestAnimationFrame(() => {
      // Use instant scroll on init (no animation)
      if (hourCol) { hourCol.scrollTop = pickerHours * ITEM_H; }
      if (minCol) { minCol.scrollTop = pickerMinutes * ITEM_H; }
      if (secCol) { secCol.scrollTop = pickerSeconds * ITEM_H; }
    });
  }

  function setPreset(h: number, m: number, s: number) {
    pickerHours = h; pickerMinutes = m; pickerSeconds = s;
    requestAnimationFrame(() => {
      if (hourCol) scrollToVal(hourCol, h);
      if (minCol) scrollToVal(minCol, m);
      if (secCol) scrollToVal(secCol, s);
    });
  }

  async function cancelTimer(id: string) {
    try {
      await fetch(`/api/countdown/${id}`, { method: 'DELETE' });
      timers = timers.filter(t => t.id !== id);
    } catch {}
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') createTimer();
    if (e.key === 'Escape') showCreate = false;
  }

  // Tick down every second — detect completion here
  function startTicking() {
    if (tickInterval) return;
    tickInterval = setInterval(() => {
      let anyCompleted = false;
      timers = timers.map(t => {
        const newRemaining = t.remaining_seconds - 1;
        if (newRemaining <= 0 && t.remaining_seconds > 0) {
          // This timer just hit zero — trigger explosion
          completedTimer = t.label;
          setTimeout(() => completedTimer = null, 8000);
          anyCompleted = true;
        }
        return { ...t, remaining_seconds: Math.max(0, newRemaining) };
      });
      // Remove completed timers after a beat
      if (anyCompleted) {
        setTimeout(() => {
          timers = timers.filter(t => t.remaining_seconds > 0);
        }, 500);
      }
    }, 1000);
  }

  // Listen for WebSocket events
  function handleWsMessage(event: MessageEvent) {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'countdown_started') {
        fetchTimers();
      } else if (data.type === 'countdown_completed') {
        timers = timers.filter(t => t.id !== data.timer.id);
        completedTimer = data.timer.label;
        // Play a sound
        try { new Audio('data:audio/wav;base64,UklGRl9vT19teleWQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YU' + 'tvT19' + 'AAAA').play(); } catch {}
        setTimeout(() => completedTimer = null, 8000);
      } else if (data.type === 'countdown_warning') {
        warningTimer = `${data.timer.label} — 1 minute left!`;
        setTimeout(() => warningTimer = null, 10000);
      } else if (data.type === 'countdown_cancelled') {
        timers = timers.filter(t => t.id !== data.timerId);
      }
    } catch {}
  }

  let pollInterval: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    fetchTimers();
    startTicking();
    pollInterval = setInterval(fetchTimers, 5000);
  });

  const isBrowser = typeof document !== 'undefined';

  onDestroy(() => {
    if (tickInterval) clearInterval(tickInterval);
    if (pollInterval) clearInterval(pollInterval);
    if (isBrowser) {
      if (overlayEl?.parentNode === document.body) document.body.removeChild(overlayEl);
      if (sparkleEl?.parentNode === document.body) document.body.removeChild(sparkleEl);
    }
  });

  // Portal overlays to body so they escape any parent stacking context
  $effect(() => {
    if (!isBrowser) return;
    if (showCreate && overlayEl && overlayEl.parentNode !== document.body) {
      document.body.appendChild(overlayEl);
      tick().then(initPicker);
    }
    if (!showCreate && overlayEl?.parentNode === document.body) {
      document.body.removeChild(overlayEl);
    }
  });

  $effect(() => {
    if (!isBrowser) return;
    if (completedTimer && sparkleEl && sparkleEl.parentNode !== document.body) {
      document.body.appendChild(sparkleEl);
    }
    if (!completedTimer && sparkleEl?.parentNode === document.body) {
      document.body.removeChild(sparkleEl);
    }
  });


</script>

<!-- Active timer bar — fixed position, below header -->
{#if timers.length > 0 || completedTimer || warningTimer}
  <div class="countdown-top-bar">
    {#each timers as timer (timer.id)}
      <div class="timer-pill" class:urgent={timer.remaining_seconds <= 60}>
        <span class="timer-label">{timer.label}</span>
        <span class="timer-time">{formatTime(timer.remaining_seconds)}</span>
        <button class="timer-cancel" onclick={() => cancelTimer(timer.id)} title="Cancel">×</button>
      </div>
    {/each}
    {#if completedTimer}
      <div class="timer-pill completed blink">
        <span class="timer-label">{completedTimer}</span>
      </div>
    {/if}
    {#if warningTimer}
      <div class="timer-pill warning">
        <span class="timer-label">{warningTimer}</span>
      </div>
    {/if}
    <button class="timer-add-inline" onclick={() => showCreate = !showCreate} title="New timer">+</button>
  </div>
{/if}

<!-- Sparkle cascade when timer completes — high z-index to go over everything -->
{#if completedTimer}
  <div class="sparkle-overlay-global" bind:this={sparkleEl}>
    {#each Array(40) as _, i}
      <div
        class="sparkle-g"
        style="left: {Math.random() * 100}%; animation-delay: {Math.random() * 2}s; animation-duration: {3.5 + Math.random() * 2.5}s; font-size: {0.7 + Math.random() * 1.4}rem; opacity: {0.4 + Math.random() * 0.6};"
      >✨</div>
    {/each}
  </div>
{/if}

{#if showCreate}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="timer-overlay" bind:this={overlayEl} onclick={() => showCreate = false} onkeydown={(e) => { if (e.key === 'Escape') showCreate = false; }}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="timer-picker-modal" onclick={(e) => e.stopPropagation()}>
      <input class="timer-label-input" type="text" placeholder="Label..." bind:value={newLabel} onkeydown={handleKeydown} />
      <div class="picker-columns">
        <div class="picker-col-wrap">
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="picker-col" bind:this={hourCol} onscroll={() => handleColScroll(hourCol, 'h')} onwheel={(e) => handleWheel(e, hourCol, 'h')}>
            <div class="picker-pad"></div>
            {#each Array(24) as _, i}
              <button class="picker-item" class:selected={pickerHours === i} onclick={() => clickItem(hourCol, 'h', i)}>{String(i).padStart(2, '0')}</button>
            {/each}
            <div class="picker-pad"></div>
          </div>
          <div class="picker-unit">hr</div>
        </div>
        <div class="picker-sep">:</div>
        <div class="picker-col-wrap">
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="picker-col" bind:this={minCol} onscroll={() => handleColScroll(minCol, 'm')} onwheel={(e) => handleWheel(e, minCol, 'm')}>
            <div class="picker-pad"></div>
            {#each Array(60) as _, i}
              <button class="picker-item" class:selected={pickerMinutes === i} onclick={() => clickItem(minCol, 'm', i)}>{String(i).padStart(2, '0')}</button>
            {/each}
            <div class="picker-pad"></div>
          </div>
          <div class="picker-unit">min</div>
        </div>
        <div class="picker-sep">:</div>
        <div class="picker-col-wrap">
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="picker-col" bind:this={secCol} onscroll={() => handleColScroll(secCol, 's')} onwheel={(e) => handleWheel(e, secCol, 's')}>
            <div class="picker-pad"></div>
            {#each Array(60) as _, i}
              <button class="picker-item" class:selected={pickerSeconds === i} onclick={() => clickItem(secCol, 's', i)}>{String(i).padStart(2, '0')}</button>
            {/each}
            <div class="picker-pad"></div>
          </div>
          <div class="picker-unit">sec</div>
        </div>
        <div class="picker-highlight"></div>
      </div>
      <div class="picker-presets">
        <button class="preset-btn" onclick={() => setPreset(0, 1, 0)}>1m</button>
        <button class="preset-btn" onclick={() => setPreset(0, 5, 0)}>5m</button>
        <button class="preset-btn" onclick={() => setPreset(0, 10, 0)}>10m</button>
        <button class="preset-btn" onclick={() => setPreset(0, 15, 0)}>15m</button>
        <button class="preset-btn" onclick={() => setPreset(0, 30, 0)}>30m</button>
        <button class="preset-btn" onclick={() => setPreset(1, 0, 0)}>1h</button>
      </div>
      <div class="picker-actions">
        <button class="picker-cancel" onclick={() => showCreate = false}>Cancel</button>
        <button class="picker-start" onclick={createTimer}>Start</button>
      </div>
    </div>
  </div>
  {@const _ = initPicker()}
{/if}

<button class="timer-add-btn" class:has-timers={timers.length > 0} onclick={() => showCreate = !showCreate} title="Set timer">
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
  </svg>
</button>

<style>
  .countdown-top-bar {
    position: fixed;
    top: calc(env(safe-area-inset-top, 0px) + 48px);
    left: 0;
    right: 0;
    display: flex;
    gap: 0.4rem;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    padding: 0.35rem 1rem;
    background: rgba(9, 9, 11, 0.92);
    backdrop-filter: blur(8px);
    border-bottom: 1px solid rgba(94, 171, 165, 0.15);
    z-index: 150;
    animation: bar-slide-in 200ms ease;
  }

  /* Mobile: inline next to the clock button, not a fixed banner */
  @media (max-width: 768px) {
    .countdown-top-bar {
      position: static;
      background: none;
      backdrop-filter: none;
      border-bottom: none;
      padding: 0;
      gap: 0.25rem;
      justify-content: flex-start;
      flex-wrap: nowrap;
      animation: none;
    }

    .timer-pill {
      font-size: 0.6rem;
      padding: 0.15rem 0.4rem;
      gap: 0.2rem;
    }

    .timer-add-inline {
      display: none;
    }
  }

  @keyframes bar-slide-in {
    from { opacity: 0; transform: translateY(-8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .timer-pill {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.2rem 0.5rem;
    background: rgba(94, 171, 165, 0.12);
    border: 1px solid rgba(94, 171, 165, 0.25);
    border-radius: 1rem;
    font-size: 0.7rem;
    font-family: var(--font-body);
    animation: pill-in 200ms ease-out;
  }

  .timer-pill.urgent {
    background: rgba(196, 56, 106, 0.15);
    border-color: rgba(196, 56, 106, 0.35);
    animation: pulse-urgent 1s ease-in-out infinite;
  }

  .timer-pill.completed {
    background: rgba(94, 171, 165, 0.2);
    border-color: rgba(94, 171, 165, 0.4);
    animation: pill-complete 400ms ease-out;
  }

  .timer-pill.warning {
    background: rgba(230, 180, 60, 0.15);
    border-color: rgba(230, 180, 60, 0.35);
    animation: pulse-urgent 1s ease-in-out infinite;
  }

  @keyframes pill-in {
    from { opacity: 0; transform: scale(0.9); }
    to { opacity: 1; transform: scale(1); }
  }

  @keyframes pill-complete {
    0% { transform: scale(1); }
    50% { transform: scale(1.05); }
    100% { transform: scale(1); }
  }

  @keyframes pulse-urgent {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.7; }
  }

  .timer-label {
    color: var(--text-secondary);
    max-width: 8rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .timer-time {
    color: var(--gold, #5eaba5);
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  .timer-cancel {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 0.85rem;
    cursor: pointer;
    padding: 0 0.15rem;
    line-height: 1;
    opacity: 0.5;
    transition: opacity 100ms;
  }

  .timer-cancel:hover { opacity: 1; }

  .timer-add-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    color: var(--text-muted);
    opacity: 0.4;
    cursor: pointer;
    padding: 0.2rem;
    border-radius: 50%;
    transition: all 150ms;
  }

  .timer-add-btn:hover { opacity: 0.8; color: var(--gold, #5eaba5); }
  .timer-add-btn.has-timers { opacity: 0.6; }

  /* Timer picker modal */
  :global(.timer-overlay) {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    width: 100vw;
    height: 100vh;
    background: rgba(0, 0, 0, 0.6);
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    animation: timer-fade-in 150ms ease-out;
  }

  @keyframes timer-fade-in { from { opacity: 0; } to { opacity: 1; } }

  :global(.timer-picker-modal) {
    background: #1a1025;
    border: 1px solid rgba(160, 120, 180, 0.25);
    border-radius: 1rem;
    padding: 1.25rem;
    width: min(320px, 90vw);
    display: flex;
    flex-direction: column;
    gap: 1rem;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  }

  :global(.timer-label-input) {
    background: rgba(20, 15, 30, 0.6);
    border: 1px solid rgba(160, 120, 180, 0.2);
    border-radius: 0.5rem;
    color: #e0dce4;
    font-size: 0.9rem;
    padding: 0.5rem 0.75rem;
    outline: none;
    text-align: center;
    width: 100%;
    box-sizing: border-box;
  }

  :global(.timer-label-input:focus) { border-color: rgba(94, 171, 165, 0.4); }
  :global(.timer-label-input::placeholder) { color: rgba(160, 140, 170, 0.4); }

  :global(.picker-columns) {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0;
    position: relative;
    overflow: hidden;
  }

  :global(.picker-col-wrap) {
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  :global(.picker-col) {
    height: calc(44px * 5);
    overflow-y: auto;
    scroll-snap-type: y mandatory;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    min-width: 4rem;
    mask-image: linear-gradient(to bottom, transparent, black 30%, black 70%, transparent);
    -webkit-mask-image: linear-gradient(to bottom, transparent, black 30%, black 70%, transparent);
  }

  :global(.picker-col::-webkit-scrollbar) { display: none; }

  :global(.picker-pad) {
    height: calc(44px * 2);
    flex-shrink: 0;
  }

  :global(.picker-item) {
    height: 44px;
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.4rem;
    font-weight: 400;
    color: rgba(160, 140, 170, 0.4);
    font-variant-numeric: tabular-nums;
    scroll-snap-align: center;
    transition: color 150ms, font-weight 150ms, font-size 150ms;
    user-select: none;
    cursor: pointer;
    flex-shrink: 0;
    background: none;
    border: none;
    padding: 0;
  }

  :global(.picker-item:hover) {
    color: rgba(160, 140, 170, 0.7);
  }

  :global(.picker-item.selected) {
    color: #e0dce4;
    font-weight: 600;
    font-size: 1.6rem;
  }

  :global(.picker-highlight) {
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    transform: translateY(-50%);
    height: 44px;
    border-top: 1px solid rgba(160, 120, 180, 0.2);
    border-bottom: 1px solid rgba(160, 120, 180, 0.2);
    pointer-events: none;
    margin-top: -12px;
  }


  :global(.picker-unit) {
    font-size: 0.6rem;
    color: rgba(160, 140, 170, 0.5);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-top: 0.15rem;
  }

  :global(.picker-sep) {
    font-size: 1.5rem;
    color: rgba(160, 140, 170, 0.3);
    font-weight: 300;
    padding-bottom: 1.2rem;
    align-self: center;
  }

  :global(.picker-presets) {
    display: flex;
    justify-content: center;
    gap: 0.35rem;
    flex-wrap: wrap;
  }

  :global(.preset-btn) {
    background: rgba(180, 160, 200, 0.08);
    border: 1px solid rgba(160, 120, 180, 0.15);
    border-radius: 0.4rem;
    color: #9a8aaa;
    font-size: 0.75rem;
    padding: 0.3rem 0.6rem;
    cursor: pointer;
    transition: all 100ms;
  }

  :global(.preset-btn:hover) { background: rgba(94, 171, 165, 0.12); color: #5eaba5; border-color: rgba(94, 171, 165, 0.25); }

  :global(.picker-actions) {
    display: flex;
    gap: 0.5rem;
  }

  :global(.picker-cancel) {
    flex: 1;
    background: rgba(180, 160, 200, 0.08);
    border: 1px solid rgba(160, 120, 180, 0.15);
    border-radius: 0.5rem;
    color: #9a8aaa;
    font-size: 0.85rem;
    padding: 0.5rem;
    cursor: pointer;
    transition: all 100ms;
  }

  :global(.picker-cancel:hover) { background: rgba(180, 160, 200, 0.15); }

  :global(.picker-start) {
    flex: 1;
    background: rgba(94, 171, 165, 0.15);
    border: 1px solid rgba(94, 171, 165, 0.3);
    border-radius: 0.5rem;
    color: #5eaba5;
    font-size: 0.85rem;
    font-weight: 500;
    padding: 0.5rem;
    cursor: pointer;
    transition: all 100ms;
  }

  :global(.picker-start:hover) { background: rgba(94, 171, 165, 0.25); }

  .timer-add-inline {
    background: none;
    border: 1px solid rgba(94, 171, 165, 0.2);
    border-radius: 50%;
    color: rgba(94, 171, 165, 0.6);
    width: 1.25rem;
    height: 1.25rem;
    font-size: 0.85rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 100ms;
    margin-left: 0.25rem;
    flex-shrink: 0;
  }

  .timer-add-inline:hover { color: #5eaba5; border-color: rgba(94, 171, 165, 0.4); }

  /* Sparkle cascade overlay — portaled to body via global styles */
  :global(.sparkle-overlay-global) {
    position: fixed;
    inset: 0;
    z-index: 99999;
    pointer-events: none;
    overflow: hidden;
    animation: sparkle-overlay-fade 7s ease-out forwards;
  }

  :global(.sparkle-g) {
    position: absolute;
    top: -2rem;
    animation: sparkle-g-fall linear forwards, sparkle-g-twinkle 0.4s ease-in-out infinite alternate;
  }

  /* Keep original scoped versions too for backwards compat */
  .sparkle-overlay {
    position: fixed;
    inset: 0;
    z-index: 99999;
    pointer-events: none;
    overflow: hidden;
    animation: overlay-fade 7s ease-out forwards;
  }

  .sparkle {
    position: absolute;
    top: -2rem;
    animation: sparkle-fall linear forwards, sparkle-twinkle 0.4s ease-in-out infinite alternate;
  }

  @keyframes sparkle-fall {
    0% {
      transform: translateY(0) rotate(0deg) scale(0.3);
      opacity: 0;
    }
    10% {
      opacity: 1;
      transform: translateY(5vh) rotate(20deg) scale(1);
    }
    50% {
      opacity: 0.9;
      transform: translateY(50vh) rotate(-15deg) scale(0.9);
    }
    100% {
      opacity: 0;
      transform: translateY(105vh) rotate(40deg) scale(0.4);
    }
  }

  @keyframes sparkle-twinkle {
    from { filter: brightness(1); }
    to { filter: brightness(1.6); }
  }

  @keyframes overlay-fade {
    0% { opacity: 1; }
    80% { opacity: 1; }
    100% { opacity: 0; }
  }

  @keyframes sparkle-overlay-fade {
    0% { opacity: 1; }
    80% { opacity: 1; }
    100% { opacity: 0; }
  }

  @keyframes sparkle-g-fall {
    0% { transform: translateY(0) rotate(0deg) scale(0.3); opacity: 0; }
    10% { opacity: 1; transform: translateY(5vh) rotate(20deg) scale(1); }
    50% { opacity: 0.9; transform: translateY(50vh) rotate(-15deg) scale(0.9); }
    100% { opacity: 0; transform: translateY(105vh) rotate(40deg) scale(0.4); }
  }

  @keyframes sparkle-g-twinkle {
    from { filter: brightness(1); }
    to { filter: brightness(1.6); }
  }

  /* Blinking completed label in the header bar */
  .timer-pill.blink {
    animation: header-blink 0.6s ease-in-out 6 alternate;
  }

  @keyframes header-blink {
    from { opacity: 1; }
    to { opacity: 0.3; }
  }
</style>
