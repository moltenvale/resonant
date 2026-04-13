<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';
  import OrchestratorPanel from '$lib/components/OrchestratorPanel.svelte';
  import SystemStatusPanel from '$lib/components/SystemStatusPanel.svelte';
  import McpActivityPanel from '$lib/components/McpActivityPanel.svelte';
  import SkillsPanel from '$lib/components/SkillsPanel.svelte';
  import NotificationsPanel from '$lib/components/NotificationsPanel.svelte';
  import DiscordPanel from '$lib/components/DiscordPanel.svelte';
  import SessionsPanel from '$lib/components/SessionsPanel.svelte';
  import PreferencesPanel from '$lib/components/PreferencesPanel.svelte';
  import {
    loadSettings,
    getSystemStatus,
    getOrchestratorTasks,
    getTriggers,
    isLoading,
  } from '$lib/stores/settings.svelte';
  import { send, getConnectionState } from '$lib/stores/websocket.svelte';

  let activeTab = $state<'preferences' | 'orchestrator' | 'system' | 'mcp' | 'skills' | 'notifications' | 'discord' | 'sessions'>('preferences');
  let systemStatus = $derived(getSystemStatus());
  let loading = $derived(isLoading());
  let connectionState = $derived(getConnectionState());
  let statusInterval: ReturnType<typeof setInterval> | null = null;

  // Request system status via WebSocket every 5 seconds
  function startStatusPolling() {
    // Request immediately
    if (connectionState === 'connected') {
      send({ type: 'request_status' });
    }

    statusInterval = setInterval(() => {
      if (connectionState === 'connected') {
        send({ type: 'request_status' });
      }
    }, 5000);
  }

  function stopStatusPolling() {
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
    }
  }

  onMount(async () => {
    await loadSettings();
    startStatusPolling();
  });

  onDestroy(() => {
    stopStatusPolling();
  });
</script>

<div class="settings-page">
  <PageHeader title="Settings" />

  <!-- Tabs -->
  <nav class="tabs">
    <button
      class="tab"
      class:active={activeTab === 'preferences'}
      onclick={() => activeTab = 'preferences'}
    >
      Preferences
    </button>
    <button
      class="tab"
      class:active={activeTab === 'orchestrator'}
      onclick={() => activeTab = 'orchestrator'}
    >
      Orchestrator
    </button>
    <button
      class="tab"
      class:active={activeTab === 'system'}
      onclick={() => activeTab = 'system'}
    >
      System
    </button>
    <button
      class="tab"
      class:active={activeTab === 'mcp'}
      onclick={() => activeTab = 'mcp'}
    >
      MCP Servers
    </button>
    <button
      class="tab"
      class:active={activeTab === 'skills'}
      onclick={() => activeTab = 'skills'}
    >
      Skills
    </button>
    <button
      class="tab"
      class:active={activeTab === 'notifications'}
      onclick={() => activeTab = 'notifications'}
    >
      Notifications
    </button>
    <button
      class="tab"
      class:active={activeTab === 'discord'}
      onclick={() => activeTab = 'discord'}
    >
      Discord
    </button>
    <button
      class="tab"
      class:active={activeTab === 'sessions'}
      onclick={() => activeTab = 'sessions'}
    >
      Sessions
    </button>
  </nav>

  <!-- Content -->
  <div class="settings-content">
    {#if loading}
      <div class="loading">Loading settings...</div>
    {:else if activeTab === 'preferences'}
      <PreferencesPanel />
    {:else if activeTab === 'orchestrator'}
      <OrchestratorPanel tasks={systemStatus?.orchestratorTasks ?? getOrchestratorTasks()} triggers={getTriggers()} />
    {:else if activeTab === 'system'}
      <SystemStatusPanel status={systemStatus} />
    {:else if activeTab === 'mcp'}
      <McpActivityPanel status={systemStatus} />
    {:else if activeTab === 'skills'}
      <SkillsPanel />
    {:else if activeTab === 'notifications'}
      <NotificationsPanel />
    {:else if activeTab === 'discord'}
      <DiscordPanel />
    {:else if activeTab === 'sessions'}
      <SessionsPanel />
    {/if}
  </div>
</div>

<style>
  .settings-page {
    display: flex;
    flex-direction: column;
    height: 100dvh;
    overflow: hidden;
  }

  .settings-header {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: calc(env(safe-area-inset-top, 0px) + 1rem) 1.5rem 1rem;
    background: var(--bg-secondary);
    box-shadow: 0 1px 0 0 var(--border);
    flex-shrink: 0;
  }

  .back-link {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    color: var(--text-muted);
    font-size: 0.875rem;
    text-decoration: none;
    border-radius: var(--radius-sm);
    padding: 0.375rem 0.625rem;
    transition: color var(--transition-fast), background var(--transition-fast);
  }

  .back-link:hover {
    color: var(--text-primary);
    background: var(--bg-hover);
    text-decoration: none;
  }

  .header-title {
    font-family: var(--font-heading);
    font-size: 1rem;
    font-weight: 600;
    color: var(--text-primary);
    letter-spacing: -0.01em;
  }

  .tabs {
    display: flex;
    gap: 0.25rem;
    padding: 0.5rem 1.5rem;
    background: var(--bg-secondary);
    box-shadow: 0 1px 0 0 var(--border);
    flex-shrink: 0;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .tabs::-webkit-scrollbar {
    display: none;
  }

  .tab {
    padding: 0.5rem 0.875rem;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--text-muted);
    border-radius: var(--radius-sm);
    border: none;
    transition: color var(--transition-fast), background var(--transition-fast);
    white-space: nowrap;
  }

  .tab:hover {
    color: var(--text-secondary);
    background: var(--bg-hover);
  }

  .tab.active {
    color: var(--text-primary);
    background: var(--bg-active);
  }

  .settings-content {
    flex: 1;
    overflow-y: auto;
    padding: 2rem;
    max-width: 48rem;
  }

  .loading {
    color: var(--text-muted);
    font-size: 0.875rem;
    text-align: center;
    padding: 3rem;
  }

  @media (max-width: 768px) {
    .settings-header {
      padding: calc(env(safe-area-inset-top, 0px) + 0.75rem) 0.75rem 0.75rem;
    }

    .settings-content {
      padding: 1rem;
    }

    .tab {
      padding: 0.75rem 1rem;
      font-size: 0.8125rem;
    }
  }
</style>
