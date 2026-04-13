<script lang="ts">
  import '../app.css';
  import { checkAuth, isAuthenticated, isChecking, isAuthRequired, stopAuthPolling } from '$lib/stores/auth.svelte';
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';

  let { children } = $props();
  let currentPath = $derived($page.url.pathname);
  let isLoginPage = $derived(currentPath === '/login');
  let isChatPage = $derived(currentPath === '/chat' || currentPath === '/');
  let authChecked = $state(false);
  let mobileOverflowOpen = $state(false);

  // Don't show nav on login page
  let showNav = $derived(!isLoginPage && showChildren);

  // Active tab detection
  function isActive(path: string): boolean {
    if (path === '/home') return currentPath === '/home' || currentPath === '/';
    if (path === '/chat') return currentPath === '/chat';
    return currentPath.startsWith(path);
  }

  // Show children when:
  // - On login page (always show immediately, no auth needed)
  // - OR auth check is done AND (authenticated OR auth not required)
  let showChildren = $derived(
    isLoginPage || (authChecked && !isChecking() && (isAuthenticated() || !isAuthRequired()))
  );

  onMount(async () => {
    const authed = await checkAuth();
    authChecked = true;

    // If not authenticated and not on login page, redirect to login
    if (!authed && isAuthRequired() && window.location.pathname !== '/login') {
      window.location.href = '/login';
    }
  });

  onDestroy(() => {
    stopAuthPolling();
  });
</script>

{#if showChildren}
  <div class="app-shell" class:has-nav={showNav}>
    {@render children()}
  </div>
{:else}
  <div class="loading-screen">
    <div class="spinner"></div>
  </div>
{/if}

<!-- Desktop top nav — persistent across all pages (except login) -->
{#if showNav}
  <nav class="desktop-nav">
    <a href="/files" class="desktop-nav-item desktop-nav-secondary" class:active={isActive('/files')}>Files</a>
    <a href="/settings" class="desktop-nav-item desktop-nav-secondary" class:active={isActive('/settings')}>Settings</a>
    <a href="/chat" class="desktop-nav-item desktop-nav-secondary" class:active={false} onclick={(e) => { e.preventDefault(); /* Canvas opens from chat header */ goto('/chat'); }}>Canvas</a>
    <div class="desktop-nav-spacer"></div>
    <a href="/home" class="desktop-nav-item" class:active={isActive('/home')}>Home</a>
    <a href="/chat" class="desktop-nav-item" class:active={isActive('/chat')}>Chat</a>
    <a href="/planner" class="desktop-nav-item" class:active={isActive('/planner')}>Planner</a>
    <a href="/care" class="desktop-nav-item" class:active={isActive('/care')}>Care</a>
    <a href="/couch" class="desktop-nav-item" class:active={isActive('/couch')}>Den</a>
    <a href="/study" class="desktop-nav-item" class:active={isActive('/study')}>Study</a>
    <a href="/nursery" class="desktop-nav-item nursery-link" class:active={isActive('/nursery')} title="Nursery">✨</a>
  </nav>
{/if}


<!-- Mobile bottom nav -->
{#if showNav}
  <nav class="mobile-nav">
    <a href="/home" class="mobile-nav-item" class:active={isActive('/home')}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
      <span>Home</span>
    </a>
    <a href="/chat" class="mobile-nav-item" class:active={isActive('/chat')}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      <span>Chat</span>
    </a>
    <a href="/planner" class="mobile-nav-item" class:active={isActive('/planner')}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
      <span>Planner</span>
    </a>
    <a href="/care" class="mobile-nav-item" class:active={isActive('/care')}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
      <span>Care</span>
    </a>
    <a href="/nursery" class="mobile-nav-item nursery-mobile" class:active={isActive('/nursery')}>
      <span class="nursery-emoji">✨</span>
      <span>Mira</span>
    </a>
    <div class="mobile-nav-item mobile-nav-overflow" class:active={isActive('/couch') || isActive('/study') || isActive('/files') || isActive('/settings')}>
      <button class="mobile-overflow-btn" onclick={() => mobileOverflowOpen = !mobileOverflowOpen}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>
        <span>More</span>
      </button>
      {#if mobileOverflowOpen}
        <button class="mobile-overflow-backdrop" onclick={() => mobileOverflowOpen = false}></button>
        <div class="mobile-overflow-menu">
          <a href="/couch" class="mobile-overflow-item" class:active={isActive('/couch')} onclick={() => mobileOverflowOpen = false}>Den</a>
          <a href="/study" class="mobile-overflow-item" class:active={isActive('/study')} onclick={() => mobileOverflowOpen = false}>Study</a>
          <a href="/files" class="mobile-overflow-item" class:active={isActive('/files')} onclick={() => mobileOverflowOpen = false}>Files</a>
          <a href="/settings" class="mobile-overflow-item" class:active={isActive('/settings')} onclick={() => mobileOverflowOpen = false}>Settings</a>
        </div>
      {/if}
    </div>
  </nav>
{/if}

<style>
  .loading-screen {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100dvh;
    background: var(--bg-primary);
  }

  .spinner {
    width: 2rem;
    height: 2rem;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* ===== Desktop top nav ===== */
  .desktop-nav {
    display: flex;
    align-items: center;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 140;
    background: rgba(10, 10, 14, 0.92);
    backdrop-filter: blur(12px);
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    padding: 0 1.5rem;
    height: 2.5rem;
    gap: 0.25rem;
  }

  .desktop-nav-item {
    padding: 0.4rem 0.75rem;
    color: rgba(255, 255, 255, 0.45);
    text-decoration: none;
    font-size: 0.8rem;
    font-family: var(--font-body);
    letter-spacing: 0.03em;
    border-radius: 0.375rem;
    transition: color 150ms ease, background 150ms ease;
  }

  .desktop-nav-item:hover {
    color: rgba(255, 255, 255, 0.7);
    background: rgba(255, 255, 255, 0.04);
  }

  .desktop-nav-item.active {
    color: var(--gold, #5eaba5);
    background: rgba(94, 171, 165, 0.08);
  }

  .nursery-link {
    font-size: 0.9rem;
    padding: 0.3rem 0.5rem;
  }

  .desktop-nav-spacer {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .desktop-nav-secondary {
    font-size: 0.75rem;
    opacity: 0.7;
  }



  /* Desktop: add top padding for the fixed nav */
  @media (min-width: 769px) {
    .app-shell.has-nav {
      padding-top: 2.5rem;
    }
  }

  /* Hide desktop nav on mobile */
  @media (max-width: 768px) {
    .desktop-nav {
      display: none;
    }
  }

  /* ===== Mobile bottom nav ===== */
  .mobile-nav {
    display: none;
  }

  @media (max-width: 768px) {
    .app-shell.has-nav {
      padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 3.5rem);
    }

    .mobile-nav {
      display: flex;
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 150;
      background: rgba(10, 10, 14, 0.95);
      backdrop-filter: blur(12px);
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      padding: 0.25rem 0;
      padding-bottom: env(safe-area-inset-bottom, 0px);
      justify-content: space-around;
      align-items: center;
    }

    .mobile-nav-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.15rem;
      padding: 0.35rem 0.5rem;
      color: rgba(255, 255, 255, 0.35);
      text-decoration: none;
      font-size: 0.6rem;
      font-family: var(--font-body);
      letter-spacing: 0.03em;
      transition: color 150ms ease;
      -webkit-tap-highlight-color: transparent;
    }

    .mobile-nav-item.active {
      color: var(--gold, #5eaba5);
    }

    .mobile-nav-item span {
      line-height: 1;
    }

    .nursery-mobile .nursery-emoji {
      font-size: 1.1rem;
      line-height: 1.2;
    }

    .mobile-overflow-btn {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.15rem;
      background: none;
      border: none;
      color: inherit;
      font-size: 0.6rem;
      font-family: var(--font-body);
      letter-spacing: 0.03em;
      cursor: pointer;
      padding: 0;
      -webkit-tap-highlight-color: transparent;
    }

    .mobile-nav-overflow {
      position: relative;
    }

    .mobile-overflow-backdrop {
      position: fixed;
      inset: 0;
      background: transparent;
      z-index: 151;
      border: none;
    }

    .mobile-overflow-menu {
      position: absolute;
      bottom: calc(100% + 0.75rem);
      right: -0.5rem;
      background: rgba(20, 20, 28, 0.97);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 0.75rem;
      padding: 0.3rem;
      min-width: 130px;
      z-index: 152;
      box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.5);
      animation: overflow-slide 120ms ease-out;
    }

    @keyframes overflow-slide {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .mobile-overflow-item {
      display: block;
      padding: 0.6rem 0.75rem;
      color: rgba(255, 255, 255, 0.6);
      text-decoration: none;
      font-size: 0.8rem;
      font-family: var(--font-body);
      border-radius: 0.5rem;
      transition: all 100ms ease;
    }

    .mobile-overflow-item:hover,
    .mobile-overflow-item.active {
      background: rgba(255, 255, 255, 0.06);
      color: var(--gold, #5eaba5);
    }
  }
</style>
