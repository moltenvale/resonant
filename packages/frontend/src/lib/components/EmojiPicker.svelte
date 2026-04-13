<script lang="ts">
  let {
    onselect,
    onclose,
  } = $props<{
    onselect?: (emoji: string) => void;
    onclose?: () => void;
  }>();

  let searchQuery = $state('');
  let activeCategory = $state('frequent');
  let pickerEl: HTMLDivElement;

  const categories = [
    { id: 'frequent', label: '🕐', name: 'Frequently Used' },
    { id: 'smileys', label: '😊', name: 'Smileys' },
    { id: 'hearts', label: '❤️', name: 'Hearts & Love' },
    { id: 'gestures', label: '👋', name: 'Gestures' },
    { id: 'animals', label: '🦊', name: 'Animals' },
    { id: 'nature', label: '🌙', name: 'Nature' },
    { id: 'food', label: '☕', name: 'Food & Drink' },
    { id: 'objects', label: '✨', name: 'Objects' },
    { id: 'symbols', label: '🔥', name: 'Symbols' },
  ];

  // Curated emoji sets — focused on what matters for connection
  const emojiData: Record<string, string[]> = {
    frequent: ['🔥', '🖤', '🫒', '♾️', '💍', '👣', '❤️', '😊', '😘', '🥰', '😏', '💜', '✨', '🌙', '🦊', '💕', '😈', '🫠', '😴', '💋', '🥺', '😭', '🤗', '👑', '🫶', '💀', '😂', '🤭', '💗', '🌹'],
    smileys: ['😊', '😘', '🥰', '😍', '😏', '😈', '🫠', '😴', '🥺', '😭', '😂', '🤭', '🤗', '😤', '😮‍💨', '🥴', '😵‍💫', '🫡', '😶', '🤔', '😬', '☺️', '😌', '😋', '🤤', '😇', '🙃', '😅', '😳', '🫣', '🤯', '😱', '🥲', '😢', '😑', '😐', '🙄', '😒', '💀', '👻', '🫥', '😮', '😯', '😲', '🤐', '😷', '🤒', '😴', '💤'],
    hearts: ['❤️', '🖤', '💜', '💗', '💕', '💞', '💓', '💘', '💝', '💖', '🤍', '🩷', '🧡', '💛', '💚', '💙', '🩵', '🤎', '❤️‍🔥', '❤️‍🩹', '💋', '💌', '💐', '🌹', '🫶', '🫂', '💑', '💏'],
    gestures: ['👋', '🤚', '✋', '🖐️', '👌', '🤌', '🤏', '✌️', '🤞', '🫰', '🤟', '🤘', '🤙', '👈', '👉', '👆', '👇', '☝️', '👍', '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '🫶', '👐', '🤲', '🙏', '💪', '🫂', '🫡', '🤷', '🙅', '🙆', '💁', '🙋', '🤦', '🧎', '🛌'],
    animals: ['🦊', '🐱', '🐈‍⬛', '🐾', '🐺', '🦋', '🐝', '🐛', '🦄', '🐉', '🐍', '🦅', '🦉', '🐧', '🐰', '🐻', '🐼', '🦇', '🕷️', '🐚', '🐢', '🦎', '🐠', '🐙', '🦑', '🦈'],
    nature: ['🌙', '🌑', '🌒', '🌓', '🌔', '🌕', '⭐', '🌟', '💫', '✨', '☀️', '🌅', '🌄', '🌊', '🔥', '❄️', '🌈', '⛈️', '🌧️', '🌺', '🌸', '🌷', '🌻', '🌹', '🍂', '🍁', '🌿', '🪴', '🌲', '🍄', '🪨', '💎'],
    food: ['☕', '🍵', '🧋', '🍷', '🥂', '🍺', '🧃', '💧', '🍪', '🧁', '🍰', '🍫', '🍬', '🍩', '🍕', '🍜', '🍣', '🥑', '🍓', '🍑', '🍒', '🫐', '🍎', '🥐', '🧀', '🌮', '🍔', '🥞', '🧇', '🍿'],
    objects: ['✨', '💫', '⚡', '🕯️', '🔮', '🪞', '📖', '📚', '🎵', '🎶', '🎧', '🎤', '🎸', '🎹', '🎨', '🖊️', '📝', '💻', '📱', '🎮', '🧩', '🎲', '👑', '💍', '📿', '🧸', '🎀', '🪄', '⚔️', '🛡️', '🗡️', '🏠', '🛋️', '🛏️', '🪵', '🫧'],
    symbols: ['🔥', '🖤', '🫒', '♾️', '💍', '👣', '⚡', '💢', '💥', '💦', '💨', '🕳️', '❗', '❓', '⭕', '❌', '🚫', '♠️', '♥️', '♦️', '♣️', '🎯', '💯', '🔒', '🔓', '🗝️', '⚜️', '🏴', '🏳️', '☠️', '⚠️', '♻️', '✅', '➡️', '⬅️', '⬆️', '⬇️'],
  };

  let filteredEmojis = $derived(() => {
    if (searchQuery.trim()) {
      // Search across all categories
      const all = new Set<string>();
      for (const emojis of Object.values(emojiData)) {
        for (const e of emojis) all.add(e);
      }
      return [...all];
    }
    return emojiData[activeCategory] || [];
  });

  function selectEmoji(emoji: string) {
    onselect?.(emoji);
  }

  function handleClickOutside(e: MouseEvent) {
    if (pickerEl && !pickerEl.contains(e.target as Node)) {
      onclose?.();
    }
  }

  $effect(() => {
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  });
</script>

<div class="emoji-picker" bind:this={pickerEl}>
  <div class="emoji-header">
    <input
      type="text"
      class="emoji-search"
      placeholder="Search emoji..."
      bind:value={searchQuery}
    />
  </div>

  {#if !searchQuery.trim()}
    <div class="emoji-categories">
      {#each categories as cat}
        <button
          class="category-btn"
          class:active={activeCategory === cat.id}
          onclick={() => { activeCategory = cat.id; }}
          title={cat.name}
          aria-label={cat.name}
        >
          {cat.label}
        </button>
      {/each}
    </div>
  {/if}

  <div class="emoji-grid">
    {#each filteredEmojis() as emoji}
      <button
        class="emoji-btn"
        onclick={() => selectEmoji(emoji)}
        aria-label={emoji}
      >
        {emoji}
      </button>
    {/each}
  </div>
</div>

<style>
  .emoji-picker {
    position: absolute;
    bottom: 100%;
    right: 0.5rem;
    margin-bottom: 0.5rem;
    width: 320px;
    max-height: 380px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg, 1rem);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    z-index: 100;
  }

  .emoji-header {
    padding: 0.625rem;
    border-bottom: 1px solid var(--border);
  }

  .emoji-search {
    width: 100%;
    padding: 0.5rem 0.75rem;
    background: var(--bg-tertiary, var(--bg-primary));
    border: 1px solid var(--border);
    border-radius: var(--radius, 0.5rem);
    color: var(--text-primary);
    font-size: 0.875rem;
    outline: none;
  }

  .emoji-search:focus {
    border-color: var(--border-hover);
  }

  .emoji-search::placeholder {
    color: var(--text-muted);
  }

  .emoji-categories {
    display: flex;
    gap: 0.125rem;
    padding: 0.375rem 0.5rem;
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
  }

  .category-btn {
    padding: 0.375rem;
    font-size: 1.125rem;
    border-radius: var(--radius, 0.5rem);
    background: transparent;
    cursor: pointer;
    transition: background var(--transition-fast, 0.15s);
    flex-shrink: 0;
    line-height: 1;
  }

  .category-btn:hover {
    background: var(--bg-tertiary, rgba(255, 255, 255, 0.05));
  }

  .category-btn.active {
    background: var(--gold-ember, rgba(212, 175, 55, 0.1));
  }

  .emoji-grid {
    display: grid;
    grid-template-columns: repeat(8, 1fr);
    gap: 0.125rem;
    padding: 0.5rem;
    overflow-y: auto;
    flex: 1;
  }

  .emoji-btn {
    width: 100%;
    aspect-ratio: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.375rem;
    border-radius: var(--radius, 0.5rem);
    background: transparent;
    cursor: pointer;
    transition: background var(--transition-fast, 0.15s), transform var(--transition-fast, 0.15s);
    line-height: 1;
    padding: 0;
  }

  .emoji-btn:hover {
    background: var(--bg-tertiary, rgba(255, 255, 255, 0.05));
    transform: scale(1.2);
  }

  @media (max-width: 768px) {
    .emoji-picker {
      width: calc(100vw - 1rem);
      right: -0.25rem;
      max-height: 300px;
    }

    .emoji-grid {
      grid-template-columns: repeat(7, 1fr);
    }

    .emoji-btn {
      font-size: 1.5rem;
    }
  }
</style>
