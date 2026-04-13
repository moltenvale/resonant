<script lang="ts">
  import { onMount } from 'svelte';
  import PageHeader from '$lib/components/PageHeader.svelte';

  interface Task {
    id: string;
    date: string;
    person: string;
    title: string;
    completed: number;
    sort_order: number;
    created_at: string;
    updated_at: string;
  }

  interface ScheduleEntry {
    id: string;
    date: string;
    time: string;
    title: string;
    note: string | null;
    sort_order: number;
    created_at: string;
    updated_at: string;
  }

  interface Project {
    id: string;
    title: string;
    person: string;
    status: string;
    note: string | null;
    sort_order: number;
    created_at: string;
    updated_at: string;
  }

  // Use local date, not UTC — prevents day-ahead bug after 9pm Atlantic
  let selectedDate = $state(new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' }));

  // Data
  let weekSchedule = $state<ScheduleEntry[]>([]);
  let weekTasks = $state<Record<string, Task[]>>({});
  let dayTasks = $state<Task[]>([]);
  let daySchedule = $state<ScheduleEntry[]>([]);
  let projects = $state<Project[]>([]);
  let loading = $state(true);

  // Form state
  let newTaskTitle = $state('');
  let newTaskPerson = $state<'user' | 'companion'>('user');
  let newScheduleTime = $state('');
  let newScheduleTitle = $state('');
  let newProjectTitle = $state('');
  let newProjectPerson = $state<'user' | 'companion' | 'both'>('both');
  let newProjectNote = $state('');
  let newProjectDueDate = $state('');
  let showAddTask = $state(false);
  let showAddSchedule = $state(false);
  let showAddProject = $state(false);

  // Banner add schedule modal
  let bannerAddDay = $state<string | null>(null);
  let bannerTime = $state('');
  let bannerTitle = $state('');
  let bannerPerson = $state<'molten' | 'chase' | ''>('');

  // Schedule entry menu/edit
  let scheduleMenuId = $state<string | null>(null);
  let editingScheduleId = $state<string | null>(null);
  let editScheduleTime = $state('');
  let editScheduleTitle = $state('');

  // Names
  let companionName = $state('Chase');
  let userName = $state('Molten');

  function getWeekStart(dateStr: string): string {
    const d = new Date(dateStr + 'T12:00:00');
    const day = d.getDay(); // 0=Sunday
    d.setDate(d.getDate() - day); // Sunday start
    return d.toISOString().split('T')[0];
  }

  function getWeekDays(startDate: string): string[] {
    const days: string[] = [];
    const d = new Date(startDate + 'T12:00:00');
    for (let i = 0; i < 7; i++) {
      days.push(d.toISOString().split('T')[0]);
      d.setDate(d.getDate() + 1);
    }
    return days;
  }

  let weekStart = $derived(getWeekStart(selectedDate));
  let weekDays = $derived(getWeekDays(weekStart));
  let today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Moncton' });

  function formatDayName(dateStr: string): string {
    const d = new Date(dateStr + 'T12:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'short' });
  }

  function formatDayNum(dateStr: string): string {
    const d = new Date(dateStr + 'T12:00:00');
    return d.getDate().toString();
  }

  function formatMonth(dateStr: string): string {
    const d = new Date(dateStr + 'T12:00:00');
    return d.toLocaleDateString('en-US', { month: 'short' });
  }

  function formatFullDate(dateStr: string): string {
    if (dateStr === today) return 'Today';
    const d = new Date(dateStr + 'T12:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  }

  function formatTime12(time24: string): string {
    if (!time24 || !time24.includes(':')) return time24 || '';
    const [h, m] = time24.split(':').map(Number);
    if (isNaN(h) || isNaN(m)) return time24;
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
  }

  function personLabel(person: string): string {
    if (person === 'user') return userName;
    if (person === 'companion') return companionName;
    return 'Both';
  }

  // Data loading
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

  async function loadWeekData() {
    loading = true;
    try {
      const [schedRes, gcalWeekRes, ...taskResults] = await Promise.all([
        fetch(`/api/planner/schedule/week?start=${weekStart}`),
        fetch(`/api/planner/gcal/week?start=${weekStart}`),
        ...weekDays.map(d => fetch(`/api/planner/tasks?date=${d}`)),
      ]);
      const sched = schedRes.ok ? await schedRes.json() : [];
      const gcalWeek = gcalWeekRes.ok ? await gcalWeekRes.json() : [];
      weekSchedule = [...sched, ...gcalWeek].sort((a: any, b: any) => (a.time || '').localeCompare(b.time || ''));
      const tasksMap: Record<string, Task[]> = {};
      for (let i = 0; i < weekDays.length; i++) {
        if (taskResults[i].ok) {
          tasksMap[weekDays[i]] = await taskResults[i].json();
        }
      }
      weekTasks = tasksMap;
    } catch (e) {
      console.error('Failed to load week data:', e);
    }
    loading = false;
  }

  async function loadDayData() {
    loading = true;
    try {
      const [tasksRes, schedRes, projRes, gcalRes] = await Promise.all([
        fetch(`/api/planner/tasks?date=${selectedDate}`),
        fetch(`/api/planner/schedule?date=${selectedDate}`),
        fetch('/api/planner/projects?status=active'),
        fetch(`/api/planner/gcal?date=${selectedDate}`),
      ]);
      if (tasksRes.ok) dayTasks = await tasksRes.json();
      if (schedRes.ok) {
        const sched = await schedRes.json();
        const gcalEvents = gcalRes.ok ? await gcalRes.json() : [];
        daySchedule = [...sched, ...gcalEvents].sort((a: any, b: any) => (a.time || '').localeCompare(b.time || ''));
      } else {
        if (gcalRes.ok) daySchedule = await gcalRes.json();
      }
      if (projRes.ok) projects = await projRes.json();
    } catch (e) {
      console.error('Failed to load day data:', e);
    }
    loading = false;
  }

  async function loadData() {
    await Promise.all([loadWeekData(), loadDayData()]);
  }

  // Actions
  async function addTask() {
    if (!newTaskTitle.trim()) return;
    try {
      const res = await fetch('/api/planner/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: selectedDate, person: newTaskPerson, title: newTaskTitle.trim() }),
      });
      if (res.ok) {
        newTaskTitle = '';
        showAddTask = false;
        await loadDayData();
      }
    } catch (e) {
      console.error('Failed to add task:', e);
    }
  }

  async function toggleTask(task: Task) {
    try {
      await fetch(`/api/planner/tasks/${task.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed: task.completed ? 0 : 1 }),
      });
      await loadDayData();
    } catch (e) {
      console.error('Failed to toggle task:', e);
    }
  }

  async function deleteTask(id: string) {
    try {
      await fetch(`/api/planner/tasks/${id}`, { method: 'DELETE' });
      await loadDayData();
    } catch (e) {
      console.error('Failed to delete task:', e);
    }
  }

  async function addScheduleEntry() {
    if (!newScheduleTime || !newScheduleTitle.trim()) return;
    try {
      const res = await fetch('/api/planner/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: selectedDate, time: newScheduleTime, title: newScheduleTitle.trim() }),
      });
      if (res.ok) {
        newScheduleTime = '';
        newScheduleTitle = '';
        showAddSchedule = false;
        await loadDayData();
      }
    } catch (e) {
      console.error('Failed to add schedule entry:', e);
    }
  }

  async function deleteScheduleEntry(id: string) {
    try {
      await fetch(`/api/planner/schedule/${id}`, { method: 'DELETE' });
      scheduleMenuId = null;
      await loadData();
    } catch (e) {
      console.error('Failed to delete schedule entry:', e);
    }
  }

  function startEditSchedule(entry: ScheduleEntry) {
    editingScheduleId = entry.id;
    editScheduleTime = entry.time;
    editScheduleTitle = entry.title;
    scheduleMenuId = null;
  }

  async function saveEditSchedule() {
    if (!editingScheduleId || !editScheduleTime || !editScheduleTitle.trim()) return;
    try {
      await fetch(`/api/planner/schedule/${editingScheduleId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ time: editScheduleTime, title: editScheduleTitle.trim() }),
      });
      editingScheduleId = null;
      await loadData();
    } catch (e) {
      console.error('Failed to update schedule entry:', e);
    }
  }

  async function addProject() {
    if (!newProjectTitle.trim()) return;
    try {
      const res = await fetch('/api/planner/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newProjectTitle.trim(), person: newProjectPerson, note: newProjectNote.trim() || undefined, due_date: newProjectDueDate || undefined }),
      });
      if (res.ok) {
        newProjectTitle = '';
        newProjectNote = '';
        newProjectDueDate = '';
        showAddProject = false;
        await loadDayData();
      }
    } catch (e) {
      console.error('Failed to add project:', e);
    }
  }

  async function archiveProject(id: string) {
    try {
      await fetch(`/api/planner/projects/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'archived' }),
      });
      await loadDayData();
    } catch (e) {
      console.error('Failed to archive project:', e);
    }
  }

  async function deleteProject(id: string) {
    try {
      await fetch(`/api/planner/projects/${id}`, { method: 'DELETE' });
      await loadDayData();
    } catch (e) {
      console.error('Failed to delete project:', e);
    }
  }

  async function addBannerSchedule() {
    if (!bannerTime || !bannerTitle.trim() || !bannerAddDay) return;
    const note = bannerPerson ? (bannerPerson === 'molten' ? userName : companionName) : '';
    try {
      const res = await fetch('/api/planner/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: bannerAddDay, time: bannerTime, title: bannerTitle.trim(), note: note || undefined }),
      });
      if (res.ok) {
        bannerAddDay = null;
        bannerTime = '';
        bannerTitle = '';
        bannerPerson = '';
        await loadWeekData();
        await loadDayData();
      }
    } catch (e) {
      console.error('Failed to add schedule entry:', e);
    }
  }

  function selectDay(dateStr: string) {
    selectedDate = dateStr;
  }

  function changeWeek(delta: number) {
    const d = new Date(weekStart + 'T12:00:00');
    d.setDate(d.getDate() + delta * 7);
    selectedDate = d.toISOString().split('T')[0];
  }

  function getScheduleForDay(dateStr: string): ScheduleEntry[] {
    return weekSchedule.filter(e => e.date === dateStr);
  }

  function getTaskSummary(dateStr: string): { done: number; total: number } {
    const tasks = weekTasks[dateStr] || [];
    return { done: tasks.filter(t => t.completed).length, total: tasks.length };
  }

  onMount(() => {
    loadConfig();
    loadData();
  });

  $effect(() => {
    weekStart;
    loadWeekData();
  });

  $effect(() => {
    selectedDate;
    loadDayData();
  });
</script>

<div class="planner-page">
  <PageHeader title="Planner" />

  <!-- Week nav arrows + mini week bar -->
  <div class="week-nav">
    <button class="nav-btn" onclick={() => changeWeek(-1)}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M15 18l-6-6 6-6"/>
      </svg>
    </button>
    <div class="mini-week">
      {#each weekDays as day}
        <button
          class="mini-day"
          class:is-today={day === today}
          class:is-selected={day === selectedDate}
          onclick={() => selectDay(day)}
        >
          <span class="mini-day-name">{formatDayName(day)}</span>
          <span class="mini-day-num">{formatDayNum(day)}</span>
        </button>
      {/each}
    </div>
    <button class="nav-btn" onclick={() => changeWeek(1)}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M9 18l6-6-6-6"/>
      </svg>
    </button>
  </div>

  <!-- Week overview — stacked full-width day banners -->
  <div class="week-stack">
    {#each weekDays as day}
      {@const summary = getTaskSummary(day)}
      {@const sched = getScheduleForDay(day)}
      <div class="day-banner-wrap">
        <button class="day-banner" class:is-today={day === today} class:is-selected={day === selectedDate} onclick={() => { selectDay(day); bannerAddDay = bannerAddDay === day ? null : day; }}>
          <div class="banner-left">
            <span class="banner-day">{formatDayName(day)}</span>
            <span class="banner-num">{formatDayNum(day)}</span>
            {#if summary.total > 0}
              <span class="banner-tasks">{summary.done}/{summary.total}</span>
            {/if}
          </div>
          {#if sched.length > 0}
            <div class="banner-sched">
              {#each sched as entry}
                {#if editingScheduleId === entry.id}
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <div class="banner-edit-inline" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
                    <input type="time" bind:value={editScheduleTime} class="banner-input banner-time-sm" />
                    <input type="text" bind:value={editScheduleTitle} class="banner-input banner-title-sm"
                      onkeydown={(e) => { if (e.key === 'Enter') saveEditSchedule(); if (e.key === 'Escape') editingScheduleId = null; }} />
                    <button class="inline-save" onclick={saveEditSchedule}>✓</button>
                    <button class="inline-cancel" onclick={() => editingScheduleId = null}>✕</button>
                  </div>
                {:else}
                  <span class="banner-event-wrap">
                    <button class="banner-event-btn" onclick={(e) => { e.stopPropagation(); if (!entry.source) scheduleMenuId = scheduleMenuId === entry.id ? null : entry.id; }}>
                      {formatTime12(entry.time)} {entry.title}
                    </button>
                    {#if scheduleMenuId === entry.id}
                      <!-- svelte-ignore a11y_no_static_element_interactions -->
                      <div class="schedule-menu" onclick={(e) => e.stopPropagation()}>
                        <button class="schedule-menu-btn" onclick={() => startEditSchedule(entry)}>Edit</button>
                        <button class="schedule-menu-btn danger" onclick={() => deleteScheduleEntry(entry.id)}>Delete</button>
                      </div>
                    {/if}
                  </span>
                {/if}
              {/each}
            </div>
          {/if}
        </button>
        <button class="banner-add-btn" onclick={(e) => { e.stopPropagation(); bannerAddDay = bannerAddDay === day ? null : day; }} title="Add schedule entry">+</button>
      </div>
      {#if bannerAddDay === day}
        <div class="banner-add-form">
          <div class="banner-form-row">
            <input type="time" bind:value={bannerTime} class="banner-input banner-time" />
            <input type="text" bind:value={bannerTitle} placeholder="What's happening..." class="banner-input banner-title"
              onkeydown={(e) => { if (e.key === 'Enter') addBannerSchedule(); }} />
          </div>
          <div class="banner-form-row">
            <div class="person-toggle-small">
              <button class="ptog" class:active={bannerPerson === 'molten'} onclick={() => bannerPerson = bannerPerson === 'molten' ? '' : 'molten'}>{userName}</button>
              <button class="ptog" class:active={bannerPerson === 'chase'} onclick={() => bannerPerson = bannerPerson === 'chase' ? '' : 'chase'}>{companionName}</button>
            </div>
            <button class="save-btn banner-save" onclick={addBannerSchedule}>Add</button>
          </div>
        </div>
      {/if}
    {/each}
  </div>

  <!-- Selected day: Tasks + Projects -->
  <div class="day-sections">
    <div class="selected-date-label">{formatFullDate(selectedDate)}</div>

    <!-- Tasks -->
    <section class="section">
      <div class="section-header">
        <h2>Tasks</h2>
        <button class="add-btn" onclick={() => showAddTask = !showAddTask}>+</button>
      </div>

      {#if showAddTask}
        <div class="add-form">
          <div class="person-toggle-small">
            <button class="ptog" class:active={newTaskPerson === 'user'} onclick={() => newTaskPerson = 'user'}>{userName}</button>
            <button class="ptog" class:active={newTaskPerson === 'companion'} onclick={() => newTaskPerson = 'companion'}>{companionName}</button>
          </div>
          <input type="text" bind:value={newTaskTitle} placeholder="Task title..." class="text-input"
            onkeydown={(e) => { if (e.key === 'Enter') addTask(); }} />
          <button class="save-btn" onclick={addTask}>Add</button>
        </div>
      {/if}

      {#if dayTasks.length === 0}
        <div class="empty-state">No tasks yet</div>
      {:else}
        <div class="tasks-list">
          {#each dayTasks as task}
            <div class="task-item" class:completed={!!task.completed}>
              <button class="checkbox" class:checked={!!task.completed} onclick={() => toggleTask(task)}>
                {#if task.completed}
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                {/if}
              </button>
              <div class="task-content">
                <span class="task-title">{task.title}</span>
                <span class="task-person">{personLabel(task.person)}</span>
              </div>
              <button class="delete-btn" onclick={() => deleteTask(task.id)} aria-label="Delete">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
              </button>
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <!-- Projects -->
    <section class="section">
      <div class="section-header">
        <h2>Projects</h2>
        <button class="add-btn" onclick={() => showAddProject = !showAddProject}>+</button>
      </div>

      {#if showAddProject}
        <div class="add-form">
          <div class="person-toggle-small">
            <button class="ptog" class:active={newProjectPerson === 'user'} onclick={() => newProjectPerson = 'user'}>{userName}</button>
            <button class="ptog" class:active={newProjectPerson === 'companion'} onclick={() => newProjectPerson = 'companion'}>{companionName}</button>
            <button class="ptog" class:active={newProjectPerson === 'both'} onclick={() => newProjectPerson = 'both'}>Both</button>
          </div>
          <input type="text" bind:value={newProjectTitle} placeholder="Project name..." class="text-input"
            onkeydown={(e) => { if (e.key === 'Enter') addProject(); }} />
          <input type="text" bind:value={newProjectNote} placeholder="Note (optional)..." class="text-input" />
          <div style="display:flex;align-items:center;gap:8px">
            <label style="color:var(--text-secondary);font-size:0.8rem;white-space:nowrap">Due date</label>
            <input type="date" bind:value={newProjectDueDate} class="text-input" style="flex:1" />
          </div>
          <button class="save-btn" onclick={addProject}>Add</button>
        </div>
      {/if}

      {#if projects.length === 0}
        <div class="empty-state">No active projects</div>
      {:else}
        <div class="projects-list">
          {#each projects as project}
            <div class="project-item">
              <div class="project-content">
                <div class="project-title-row">
                  <span class="project-title">{project.title}</span>
                  <span class="project-person-tag">{personLabel(project.person)}</span>
                </div>
                {#if project.note}
                  <div class="project-note">{project.note}</div>
                {/if}
                <div class="project-meta">
                  <span>Created {new Date(project.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                  {#if project.due_date}
                    {@const due = new Date(project.due_date + 'T00:00:00')}
                    {@const now = new Date()}
                    {@const daysLeft = Math.ceil((due.getTime() - now.getTime()) / 86400000)}
                    <span class="due-date" class:overdue={daysLeft < 0} class:urgent={daysLeft >= 0 && daysLeft <= 3}>
                      Due {due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      {#if daysLeft < 0}(overdue){:else if daysLeft === 0}(today){:else if daysLeft <= 3}({daysLeft}d left){/if}
                    </span>
                  {/if}
                </div>
              </div>
              <div class="project-actions">
                <button class="archive-btn" onclick={() => archiveProject(project.id)} title="Archive">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                </button>
                <button class="delete-btn" onclick={() => deleteProject(project.id)} aria-label="Delete">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M18 6L6 18M6 6l12 12"/>
                  </svg>
                </button>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </section>
  </div>
</div>

<style>
  .planner-page {
    max-width: 600px;
    margin: 0 auto;
    padding: 1rem;
    height: 100dvh;
    overflow-y: auto;
    background: var(--bg-primary);
    color: var(--text-primary);
  }

  @media (min-width: 769px) {
    .planner-page {
      height: calc(100dvh - 2.5rem);
    }
  }

  .planner-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1.5rem;
    padding-top: calc(env(safe-area-inset-top, 0px) + 1.5rem);
  }

  .planner-header h1 {
    font-family: var(--font-heading);
    font-size: 1.25rem;
    font-weight: 600;
    margin: 0;
    color: var(--gold);
  }

  .back-link, .back-btn {
    color: var(--gold);
    display: flex;
    align-items: center;
    text-decoration: none;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
  }

  .back-link:hover, .back-btn:hover {
    color: var(--gold-bright);
  }

  .loading {
    text-align: center;
    color: var(--text-muted);
    padding: 2rem;
  }

  /* Week nav */
  .week-nav {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    margin-bottom: 0.75rem;
  }

  .nav-btn {
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.25rem;
    display: flex;
    align-items: center;
    border-radius: var(--radius-sm);
    transition: color var(--transition);
    flex-shrink: 0;
  }

  /* Week stack — full-width day banners */
  .week-stack {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-bottom: 1.25rem;
  }

  .day-banner {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.5rem 0.75rem;
    background: var(--gold-ember);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    cursor: pointer;
    transition: all 150ms ease;
    text-align: left;
    width: 100%;
  }

  .day-banner:hover {
    background: var(--gold-glow);
    border-color: var(--border-hover);
  }

  .day-banner.is-today {
    border-color: var(--border-hover);
  }

  .day-banner.is-selected {
    background: var(--border);
    border-color: var(--gold-dim);
  }

  .day-banner-wrap {
    display: flex;
    align-items: stretch;
    gap: 0;
  }

  .day-banner-wrap .day-banner {
    flex: 1;
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }

  .banner-add-btn {
    width: 2rem;
    background: var(--gold-ember);
    border: 1px solid var(--border);
    border-left: none;
    border-radius: 0 0.5rem 0.5rem 0;
    color: var(--text-muted);
    font-size: 1.1rem;
    cursor: pointer;
    transition: all 150ms ease;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .banner-add-btn:hover {
    background: var(--gold-glow);
    color: var(--gold);
  }

  .banner-add-form {
    background: var(--gold-ember);
    border: 1px solid var(--border-hover);
    border-radius: 0.5rem;
    padding: 0.5rem 0.6rem;
    margin-top: 0.15rem;
    margin-bottom: 0.15rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    width: 100%;
    box-sizing: border-box;
    overflow: hidden;
  }

  .banner-form-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .banner-input {
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: 0.35rem;
    color: var(--text-primary);
    padding: 0.3rem 0.5rem;
    font-size: 0.8rem;
  }

  .banner-time {
    width: 6.5rem;
    flex-shrink: 0;
  }

  .banner-title {
    flex: 1;
    min-width: 0;
  }

  .banner-save {
    padding: 0.3rem 0.75rem;
    font-size: 0.75rem;
    margin-left: auto;
  }

  /* Schedule list in day detail */
  .schedule-list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .schedule-item-wrap {
    position: relative;
  }

  .schedule-item {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    width: 100%;
    padding: 0.5rem 0.6rem;
    background: var(--gold-ember);
    border: 1px solid var(--gold-glow);
    border-radius: 0.4rem;
    cursor: pointer;
    text-align: left;
    transition: all 150ms ease;
  }

  .schedule-item:hover {
    background: var(--gold-glow);
    border-color: var(--border-hover);
  }

  .schedule-time {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--gold);
    white-space: nowrap;
    min-width: 5rem;
  }

  .schedule-title {
    font-size: 0.85rem;
    color: var(--text-primary);
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .schedule-note {
    font-size: 0.7rem;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .schedule-gcal-tag {
    font-size: 0.6rem;
    color: var(--gold);
    background: var(--gold-glow);
    padding: 0.1rem 0.35rem;
    border-radius: 3px;
    flex-shrink: 0;
  }

  .schedule-menu {
    position: absolute;
    right: 0.5rem;
    top: calc(100% + 0.2rem);
    background: var(--bg-surface);
    border: 1px solid var(--border-hover);
    border-radius: 0.4rem;
    overflow: hidden;
    z-index: 10;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  }

  .schedule-menu-btn {
    display: block;
    width: 100%;
    padding: 0.5rem 1rem;
    background: none;
    border: none;
    color: var(--text-primary);
    font-size: 0.8rem;
    cursor: pointer;
    text-align: left;
    white-space: nowrap;
  }

  .schedule-menu-btn:hover {
    background: var(--bg-active);
  }

  .schedule-menu-btn.danger:hover {
    background: rgba(196, 56, 106, 0.15);
    color: #c4386a;
  }

  .schedule-edit-form {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.4rem;
    background: var(--gold-ember);
    border: 1px solid var(--border-hover);
    border-radius: 0.4rem;
  }

  .cancel-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.9rem;
    padding: 0.2rem 0.4rem;
  }

  .cancel-btn:hover { color: #c4386a; }

  .banner-left {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    min-width: 7rem;
    flex-shrink: 0;
  }

  .banner-day {
    font-size: 0.7rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.03em;
    width: 2rem;
  }

  .banner-num {
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--text-primary);
    width: 1.5rem;
  }

  .day-banner.is-today .banner-num {
    color: var(--gold);
  }

  .banner-tasks {
    font-size: 0.65rem;
    color: var(--text-muted);
    background: var(--gold-glow);
    padding: 0.1rem 0.35rem;
    border-radius: 4px;
  }

  .banner-sched {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    min-width: 0;
  }

  .banner-event {
    font-size: 0.65rem;
    color: var(--gold);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .banner-event-wrap {
    position: relative;
  }

  .banner-event-btn {
    font-size: 0.65rem;
    color: var(--gold);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    background: none;
    border: none;
    padding: 0.1rem 0.25rem;
    border-radius: 3px;
    cursor: pointer;
    text-align: left;
    max-width: 100%;
  }

  .banner-event-btn:hover {
    background: var(--gold-glow);
  }

  .banner-edit-inline {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .banner-time-sm {
    width: 5rem;
    font-size: 0.65rem;
    padding: 0.15rem 0.3rem;
  }

  .banner-title-sm {
    flex: 1;
    min-width: 0;
    font-size: 0.65rem;
    padding: 0.15rem 0.3rem;
  }

  .inline-save, .inline-cancel {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.75rem;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
  }

  .inline-save { color: var(--gold); }
  .inline-save:hover { background: var(--bg-active); }
  .inline-cancel { color: var(--text-muted); }
  .inline-cancel:hover { color: #c4386a; }

  .selected-date-label {
    font-size: 0.85rem;
    font-weight: 500;
    color: var(--gold);
    margin-bottom: 0.75rem;
  }

  /* Day sections */
  .day-sections {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .section {
    background: var(--gold-ember);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1rem;
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
  }

  .section-header h2 {
    font-family: var(--font-heading);
    font-size: 1rem;
    font-weight: 600;
    margin: 0;
    color: var(--gold);
  }

  .add-btn {
    width: 1.75rem;
    height: 1.75rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg-surface);
    color: var(--accent);
    font-size: 1.1rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all var(--transition);
  }

  .add-btn:hover {
    border-color: var(--accent-muted);
    background: var(--accent);
    color: var(--bg-primary);
  }

  .empty-state {
    color: var(--text-muted);
    font-size: 0.8rem;
    text-align: center;
    padding: 0.75rem 0;
  }

  /* Add forms */
  .add-form {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
    padding: 0.75rem;
    background: var(--bg-surface);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
  }

  .text-input {
    width: 100%;
    padding: 0.5rem 0.625rem;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 0.85rem;
    font-family: var(--font-body);
    outline: none;
    transition: border-color var(--transition);
  }

  .text-input::placeholder {
    color: var(--text-muted);
  }

  .text-input:focus {
    border-color: var(--accent-muted);
  }

  .time-input {
    padding: 0.5rem 0.625rem;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 0.85rem;
    font-family: var(--font-body);
    outline: none;
    width: auto;
  }

  .time-input:focus {
    border-color: var(--accent-muted);
  }

  .person-toggle-small {
    display: flex;
    gap: 0.375rem;
  }

  .ptog {
    padding: 0.25rem 0.5rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--bg-secondary);
    color: var(--text-secondary);
    font-size: 0.75rem;
    cursor: pointer;
    transition: all var(--transition);
    font-family: var(--font-body);
  }

  .ptog.active {
    background: var(--accent);
    color: var(--bg-primary);
    border-color: var(--accent);
    font-weight: 600;
  }

  .save-btn {
    align-self: flex-end;
    padding: 0.375rem 0.875rem;
    background: var(--accent);
    color: var(--bg-primary);
    border: none;
    border-radius: var(--radius-sm);
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    transition: background var(--transition);
    font-family: var(--font-body);
  }

  .save-btn:hover {
    background: var(--accent-hover);
  }

  /* Schedule list */
  .schedule-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .schedule-item {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--border);
  }

  .schedule-item:last-child {
    border-bottom: none;
  }

  .schedule-time {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--accent);
    min-width: 5rem;
    white-space: nowrap;
  }

  .schedule-title {
    font-size: 0.85rem;
    flex: 1;
  }

  .schedule-note {
    font-size: 0.7rem;
    color: var(--text-muted);
  }

  /* Tasks list */
  .tasks-list {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .task-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0;
    transition: opacity var(--transition);
  }

  .task-item.completed {
    opacity: 0.5;
  }

  .checkbox {
    width: 1.375rem;
    height: 1.375rem;
    border-radius: var(--radius-sm);
    border: 1.5px solid var(--border);
    background: var(--bg-surface);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all var(--transition);
    flex-shrink: 0;
    color: var(--bg-primary);
  }

  .checkbox.checked {
    background: var(--accent);
    border-color: var(--accent);
  }

  .task-content {
    flex: 1;
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    min-width: 0;
  }

  .task-title {
    font-size: 0.85rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--gold);
  }

  .completed .task-title {
    text-decoration: line-through;
    color: var(--text-muted);
  }

  .task-person {
    font-size: 0.65rem;
    color: var(--text-muted);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .delete-btn {
    color: var(--text-muted);
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.25rem;
    display: flex;
    align-items: center;
    border-radius: var(--radius-sm);
    transition: color var(--transition);
    flex-shrink: 0;
    opacity: 0;
    transition: opacity var(--transition), color var(--transition);
  }

  .task-item:hover .delete-btn,
  .schedule-item:hover .delete-btn,
  .project-item:hover .delete-btn {
    opacity: 1;
  }

  .delete-btn:hover {
    color: #ef4444;
  }

  /* Projects */
  .projects-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .project-item {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--border);
  }

  .project-item:last-child {
    border-bottom: none;
  }

  .project-content {
    flex: 1;
    min-width: 0;
  }

  .project-title-row {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }

  .project-title {
    font-size: 0.85rem;
    font-weight: 500;
    color: var(--gold);
  }

  .project-person-tag {
    font-size: 0.6rem;
    padding: 0.125rem 0.375rem;
    border-radius: 999px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    color: var(--text-muted);
    white-space: nowrap;
  }

  .project-note {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin-top: 0.25rem;
  }

  .project-meta {
    display: flex;
    gap: 0.75rem;
    font-size: 0.7rem;
    color: var(--text-muted);
    margin-top: 0.25rem;
    opacity: 0.7;
  }
  .project-meta .due-date {
    opacity: 1;
  }
  .project-meta .due-date.urgent {
    color: #e8a040;
  }
  .project-meta .due-date.overdue {
    color: #e05555;
  }

  .project-actions {
    display: flex;
    gap: 0.25rem;
    flex-shrink: 0;
    opacity: 0;
    transition: opacity var(--transition);
  }

  .project-item:hover .project-actions {
    opacity: 1;
  }

  .archive-btn {
    color: var(--accent);
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.25rem;
    display: flex;
    align-items: center;
    border-radius: var(--radius-sm);
    transition: color var(--transition);
  }

  .archive-btn:hover {
    color: var(--accent-hover);
  }

  /* Mini week nav */
  .mini-week {
    display: flex;
    gap: 0.25rem;
    justify-content: space-between;
    flex: 1;
  }

  .mini-day {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.15rem;
    padding: 0.4rem 0.25rem;
    background: transparent;
    border: 1.5px solid transparent;
    border-radius: 0.75rem;
    cursor: pointer;
    transition: all 150ms ease;
  }

  .mini-day:hover {
    background: var(--gold-ember);
  }

  .mini-day.is-today .mini-day-num {
    color: var(--gold);
    font-weight: 700;
  }

  .mini-day.is-selected {
    background: var(--bg-active);
    border-color: var(--gold-dim);
  }

  .mini-day-name {
    font-size: 0.6rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .mini-day-num {
    font-size: 0.95rem;
    font-weight: 500;
    color: var(--text-primary);
  }

  /* Day schedule preview (compact) */
  .day-schedule-preview {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-bottom: 1rem;
    padding: 0.6rem 0.75rem;
    background: var(--gold-ember);
    border-radius: var(--radius-sm);
    border-left: 2px solid var(--gold-dim);
  }

  .schedule-preview-item {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .schedule-preview-time {
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--gold);
    min-width: 4.5rem;
    white-space: nowrap;
  }

  .schedule-preview-title {
    font-size: 0.75rem;
    color: var(--gold);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Nav buttons color update */
  .nav-btn {
    color: var(--text-muted);
  }
  .nav-btn:hover {
    color: var(--gold);
  }
  .week-label {
    color: var(--text-primary);
  }
  .day-name {
    color: var(--text-muted);
  }
  .day-num {
    color: var(--text-primary);
  }
  .day-sched-more {
    color: var(--text-muted);
  }
  .loading {
    color: var(--text-muted);
  }
  .empty-state {
    color: var(--text-muted);
  }
  .task-person {
    color: var(--text-muted);
  }
  .delete-btn {
    color: var(--text-muted);
  }
  .project-note {
    color: var(--text-muted);
  }
  .project-person-tag {
    color: var(--text-muted);
    background: var(--gold-ember);
    border-color: var(--border);
  }
  .checkbox {
    border-color: var(--border-hover);
    background: var(--gold-ember);
  }
  .checkbox.checked {
    background: var(--gold);
    border-color: var(--gold);
  }
  .add-btn {
    border-color: var(--border-hover);
    background: var(--gold-ember);
    color: var(--gold);
  }
  .add-btn:hover {
    background: var(--gold-dim);
    border-color: var(--gold-dim);
    color: #fff;
  }
  .ptog {
    border-color: var(--border-hover);
    background: var(--gold-ember);
    color: var(--text-muted);
  }
  .ptog.active {
    background: var(--gold);
    border-color: var(--gold);
    color: var(--bg-primary);
  }
  .save-btn {
    background: var(--gold);
    color: var(--bg-primary);
  }
  .save-btn:hover {
    background: var(--gold-bright);
  }
  .add-form {
    background: var(--gold-ember);
    border-color: var(--border);
  }
  .text-input {
    background: var(--bg-input);
    border-color: var(--border);
    color: var(--text-primary);
  }
  .text-input:focus {
    border-color: var(--gold-dim);
  }
  .text-input::placeholder {
    color: var(--text-muted);
  }
  .time-input {
    background: var(--bg-input);
    border-color: var(--border);
    color: var(--text-primary);
  }
  .time-input:focus {
    border-color: var(--gold-dim);
  }
  .schedule-item {
    border-bottom-color: var(--border);
  }
  .schedule-time {
    color: var(--gold);
  }
  .project-item {
    border-bottom-color: var(--border);
  }
  .archive-btn {
    color: var(--gold);
  }

  /* Mobile adjustments */
  @media (max-width: 480px) {
    .delete-btn, .project-actions {
      opacity: 1;
    }
  }
</style>
