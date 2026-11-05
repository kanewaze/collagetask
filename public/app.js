// College Tasks - iPhone Reminders Style App
(function () {
  'use strict';

  // --- STATE ---
  let currentUser = null;
  let activeTab = 'my-tasks';
  let sseEventSource = null;
  let editingTaskId = null;
  let allFriendsCache = [];
  let allTasksCache = [];

  // --- COLOR PALETTE FOR SUBJECT BADGES ---
  const IOS_PALETTES = [
    { bg: 'rgba(0, 122, 255, 0.12)', text: '#007AFF', border: 'rgba(0, 122, 255, 0.25)' }, // Blue
    { bg: 'rgba(88, 86, 214, 0.12)', text: '#5856D6', border: 'rgba(88, 86, 214, 0.25)' }, // Indigo
    { bg: 'rgba(175, 82, 222, 0.12)', text: '#AF52DE', border: 'rgba(175, 82, 222, 0.25)' }, // Purple
    { bg: 'rgba(255, 45, 85, 0.12)', text: '#FF2D55', border: 'rgba(255, 45, 85, 0.25)' },  // Pink
    { bg: 'rgba(255, 59, 48, 0.12)', text: '#FF3B30', border: 'rgba(255, 59, 48, 0.25)' },  // Red
    { bg: 'rgba(255, 149, 0, 0.12)', text: '#FF9500', border: 'rgba(255, 149, 0, 0.25)' },  // Orange
    { bg: 'rgba(52, 199, 89, 0.12)', text: '#34C759', border: 'rgba(52, 199, 89, 0.25)' },  // Green
    { bg: 'rgba(48, 176, 199, 0.12)', text: '#30B0C7', border: 'rgba(48, 176, 199, 0.25)' }, // Teal
    { bg: 'rgba(50, 173, 230, 0.12)', text: '#32ADE6', border: 'rgba(50, 173, 230, 0.25)' }  // Cyan
  ];

  function getSubjectColor(subjectName) {
    if (!subjectName) return IOS_PALETTES[0];
    let hash = 0;
    for (let i = 0; i < subjectName.length; i++) {
      hash = subjectName.charCodeAt(i) + ((hash << 5) - hash);
    }
    const index = Math.abs(hash) % IOS_PALETTES.length;
    return IOS_PALETTES[index];
  }

  function getInitials(name) {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function getAvatarGradient(name) {
    let hash = 0;
    for (let i = 0; i < (name || '').length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const colors = [
      'linear-gradient(135deg, #007AFF, #5856D6)',
      'linear-gradient(135deg, #FF9500, #FF2D55)',
      'linear-gradient(135deg, #34C759, #30B0C7)',
      'linear-gradient(135deg, #AF52DE, #5856D6)',
      'linear-gradient(135deg, #FF3B30, #FF9500)',
      'linear-gradient(135deg, #32ADE6, #007AFF)'
    ];
    return colors[Math.abs(hash) % colors.length];
  }

  // --- DATE HELPERS ---
  function formatDateBadge(dateStr) {
    if (!dateStr) return null;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    // Parse YYYY-MM-DD
    const parts = dateStr.split('-');
    if (parts.length !== 3) return { text: dateStr, isOverdue: false, isToday: false };
    const taskDate = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));

    const diffDays = Math.round((taskDate - today) / (1000 * 60 * 60 * 24));

    if (diffDays < 0) {
      return { text: `Overdue (${Math.abs(diffDays)}d ago)`, isOverdue: true, isToday: false };
    } else if (diffDays === 0) {
      return { text: 'Today', isOverdue: false, isToday: true };
    } else if (diffDays === 1) {
      return { text: 'Tomorrow', isOverdue: false, isToday: false };
    } else if (diffDays < 7) {
      const options = { weekday: 'short' };
      return { text: taskDate.toLocaleDateString(undefined, options), isOverdue: false, isToday: false };
    } else {
      const options = { month: 'short', day: 'numeric' };
      return { text: taskDate.toLocaleDateString(undefined, options), isOverdue: false, isToday: false };
    }
  }

  function formatRelativeTime(dateString) {
    if (!dateString) return '';
    // Normalize SQLite format 'YYYY-MM-DD HH:MM:SS' to ISO 'YYYY-MM-DDTHH:MM:SSZ'
    let isoString = dateString;
    if (dateString.indexOf('T') === -1) {
      isoString = dateString.replace(' ', 'T') + 'Z';
    }
    const d = new Date(isoString);
    const now = new Date();
    const diffSec = Math.floor((now - d) / 1000);

    if (diffSec < 5) return 'Just now';
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // --- TOAST NOTIFICATIONS ---
  function showToast(message, icon = '🔔') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `<span class="toast-icon">${icon}</span> <span>${escapeHtml(message)}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('hiding');
      setTimeout(() => toast.remove(), 350);
    }, 3500);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // --- API HELPER ---
  async function api(path, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };
    if (currentUser && currentUser.id) {
      headers['x-user-id'] = String(currentUser.id);
    }
    const res = await fetch(path, { ...options, headers });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  // --- INITIALIZATION ---
  document.addEventListener('DOMContentLoaded', () => {
    initElements();
    initEventListeners();
    checkSavedSession();
  });

  // DOM Element References
  let elements = {};
  function initElements() {
    elements = {
      loginView: document.getElementById('loginView'),
      mainView: document.getElementById('mainView'),
      loginInput: document.getElementById('loginUsernameInput'),
      loginBtn: document.getElementById('loginSubmitBtn'),
      quickUsersSection: document.getElementById('quickUsersSection'),
      quickUsersChips: document.getElementById('quickUsersChips'),
      
      headerAvatar: document.getElementById('headerAvatar'),
      headerUsername: document.getElementById('headerUsername'),
      headerLogoutBtn: document.getElementById('headerLogoutBtn'),
      
      statDoneCount: document.getElementById('statDoneCount'),
      statPendingCount: document.getElementById('statPendingCount'),
      
      tabBtnMyTasks: document.getElementById('tabBtnMyTasks'),
      tabBtnFriends: document.getElementById('tabBtnFriends'),
      tabBtnActivity: document.getElementById('tabBtnActivity'),
      
      viewMyTasks: document.getElementById('viewMyTasks'),
      viewFriends: document.getElementById('viewFriends'),
      viewActivity: document.getElementById('viewActivity'),
      
      myTasksContainer: document.getElementById('myTasksContainer'),
      friendsContainer: document.getElementById('friendsContainer'),
      activityContainer: document.getElementById('activityContainer'),
      
      fabAddTask: document.getElementById('fabAddTask'),
      taskModalOverlay: document.getElementById('taskModalOverlay'),
      taskModalTitle: document.getElementById('taskModalTitle'),
      taskForm: document.getElementById('taskForm'),
      modalCloseBtn: document.getElementById('modalCloseBtn'),
      
      taskInputTitle: document.getElementById('taskInputTitle'),
      taskInputSubject: document.getElementById('taskInputSubject'),
      taskInputDueDate: document.getElementById('taskInputDueDate'),
      priorityOptions: document.querySelectorAll('.segmented-option')
    };
  }

  function initEventListeners() {
    // Login
    elements.loginBtn.addEventListener('click', handleLoginSubmit);
    elements.loginInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleLoginSubmit();
    });

    // Logout
    elements.headerLogoutBtn.addEventListener('click', handleLogout);

    // Tab navigation
    elements.tabBtnMyTasks.addEventListener('click', () => switchTab('my-tasks'));
    elements.tabBtnFriends.addEventListener('click', () => switchTab('friends'));
    elements.tabBtnActivity.addEventListener('click', () => switchTab('activity'));

    // Modal controls
    elements.fabAddTask.addEventListener('click', () => openTaskModal());
    elements.modalCloseBtn.addEventListener('click', closeTaskModal);
    elements.taskModalOverlay.addEventListener('click', (e) => {
      if (e.target === elements.taskModalOverlay) closeTaskModal();
    });

    // Priority segmented selector
    elements.priorityOptions.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        elements.priorityOptions.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // Task form submission
    elements.taskForm.addEventListener('submit', handleTaskFormSubmit);
  }

  // --- SESSION & SSE ---
  function checkSavedSession() {
    const saved = localStorage.getItem('college_tasks_user');
    if (saved) {
      try {
        currentUser = JSON.parse(saved);
        showMainApp();
      } catch {
        showLoginScreen();
      }
    } else {
      showLoginScreen();
    }
  }

  function showLoginScreen() {
    currentUser = null;
    if (sseEventSource) {
      sseEventSource.close();
      sseEventSource = null;
    }
    elements.loginView.classList.remove('hidden');
    elements.mainView.classList.add('hidden');
    elements.loginInput.value = '';
    loadExistingUsersForLogin();
  }

  async function loadExistingUsersForLogin() {
    try {
      const users = await api('/api/users');
      if (users && users.length > 0) {
        elements.quickUsersSection.classList.remove('hidden');
        elements.quickUsersChips.innerHTML = '';
        users.forEach(u => {
          const chip = document.createElement('div');
          chip.className = 'user-chip';
          chip.innerHTML = `
            <div class="chip-avatar" style="background: ${getAvatarGradient(u.username)}">
              ${getInitials(u.username)}
            </div>
            <span>${escapeHtml(u.username)}</span>
          `;
          chip.addEventListener('click', () => {
            elements.loginInput.value = u.username;
            handleLoginSubmit();
          });
          elements.quickUsersChips.appendChild(chip);
        });
      } else {
        elements.quickUsersSection.classList.add('hidden');
      }
    } catch (err) {
      console.warn('Could not load users for quick-select:', err);
    }
  }

  async function handleLoginSubmit() {
    const username = elements.loginInput.value.trim();
    if (!username) {
      elements.loginInput.focus();
      return;
    }

    try {
      elements.loginBtn.disabled = true;
      elements.loginBtn.textContent = 'Entering...';
      const user = await api('/api/users', {
        method: 'POST',
        body: JSON.stringify({ username })
      });

      currentUser = user;
      localStorage.setItem('college_tasks_user', JSON.stringify(user));
      showMainApp();
    } catch (err) {
      showToast(err.message || 'Login failed', '⚠️');
    } finally {
      elements.loginBtn.disabled = false;
      elements.loginBtn.innerHTML = '<span>Let\'s Go</span> <span>&rarr;</span>';
    }
  }

  function handleLogout() {
    localStorage.removeItem('college_tasks_user');
    showLoginScreen();
    showToast('Logged out successfully', '👋');
  }

  function showMainApp() {
    elements.loginView.classList.add('hidden');
    elements.mainView.classList.remove('hidden');

    // Setup Header
    elements.headerUsername.textContent = currentUser.username;
    elements.headerAvatar.textContent = getInitials(currentUser.username);
    elements.headerAvatar.style.background = getAvatarGradient(currentUser.username);

    // Setup SSE
    setupSSE();

    // Load active tab
    switchTab('my-tasks');
    refreshUserData();
  }

  function setupSSE() {
    if (sseEventSource) {
      sseEventSource.close();
    }
    sseEventSource = new EventSource('/api/events');

    sseEventSource.addEventListener('task_created', (e) => {
      const data = JSON.parse(e.data);
      if (data.actor !== currentUser.username) {
        showToast(data.message || 'New task created', '📝');
      }
      handleRealtimeUpdate();
    });

    sseEventSource.addEventListener('task_completed', (e) => {
      const data = JSON.parse(e.data);
      if (data.actor !== currentUser.username) {
        showToast(data.message || 'Task completed', '✅');
      }
      handleRealtimeUpdate();
    });

    sseEventSource.addEventListener('task_reopened', (e) => {
      const data = JSON.parse(e.data);
      if (data.actor !== currentUser.username) {
        showToast(data.message || 'Task reopened', '↩️');
      }
      handleRealtimeUpdate();
    });

    sseEventSource.addEventListener('task_deleted', (e) => {
      const data = JSON.parse(e.data);
      if (data.actor !== currentUser.username) {
        showToast(data.message || 'Task deleted', '🗑️');
      }
      handleRealtimeUpdate();
    });

    sseEventSource.addEventListener('task_updated', (e) => {
      const data = JSON.parse(e.data);
      if (data.actor !== currentUser.username) {
        showToast(data.message || 'Task updated', '✏️');
      }
      handleRealtimeUpdate();
    });

    sseEventSource.addEventListener('user_joined', (e) => {
      const data = JSON.parse(e.data);
      if (data.user && data.user.id !== currentUser.id) {
        showToast(`${data.user.username} joined!`, '👋');
        if (activeTab === 'friends') loadFriends();
      }
    });

    sseEventSource.onerror = () => {
      console.warn('SSE connection lost, reconnecting...');
    };
  }

  function handleRealtimeUpdate() {
    refreshUserData();
    if (activeTab === 'my-tasks') {
      loadMyTasks();
    } else if (activeTab === 'friends') {
      loadFriends();
    } else if (activeTab === 'activity') {
      loadActivity();
    }
  }

  // --- STATS REFRESH ---
  async function refreshUserData() {
    if (!currentUser) return;
    try {
      const stats = await api(`/api/users/${currentUser.id}/stats`);
      elements.statDoneCount.textContent = stats.completed || 0;
      elements.statPendingCount.textContent = stats.pending || 0;
    } catch (err) {
      console.error('Error refreshing stats:', err);
    }
  }

  // --- TAB NAVIGATION ---
  function switchTab(tabName) {
    activeTab = tabName;

    // Update buttons
    elements.tabBtnMyTasks.classList.toggle('active', tabName === 'my-tasks');
    elements.tabBtnFriends.classList.toggle('active', tabName === 'friends');
    elements.tabBtnActivity.classList.toggle('active', tabName === 'activity');

    // Update views
    elements.viewMyTasks.classList.toggle('active', tabName === 'my-tasks');
    elements.viewFriends.classList.toggle('active', tabName === 'friends');
    elements.viewActivity.classList.toggle('active', tabName === 'activity');

    // FAB button only shows on "My Tasks"
    elements.fabAddTask.style.display = tabName === 'my-tasks' ? 'flex' : 'none';

    // Fetch tab content
    if (tabName === 'my-tasks') {
      loadMyTasks();
    } else if (tabName === 'friends') {
      loadFriends();
    } else if (tabName === 'activity') {
      loadActivity();
    }
  }

  // --- MY TASKS TAB ---
  async function loadMyTasks() {
    if (!currentUser) return;
    try {
      const tasks = await api(`/api/tasks?userId=${currentUser.id}`);
      renderMyTasks(tasks);
    } catch (err) {
      console.error('Error loading my tasks:', err);
    }
  }

  function renderMyTasks(tasks) {
    const container = elements.myTasksContainer;
    container.innerHTML = '';

    if (!tasks || tasks.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <span class="empty-state-emoji">🎉</span>
          <div class="empty-state-title">No tasks yet!</div>
          <div class="empty-state-desc">Tap the + button below to add your first college assignment.</div>
        </div>
      `;
      return;
    }

    // Grouping: Today, This Week, Later, Completed
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const groups = {
      today: [],
      thisWeek: [],
      later: [],
      completed: []
    };

    tasks.forEach(task => {
      if (task.completed === 1) {
        groups.completed.push(task);
      } else if (!task.due_date) {
        groups.later.push(task);
      } else {
        const parts = task.due_date.split('-');
        const tDate = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
        const diffDays = Math.round((tDate - today) / (1000 * 60 * 60 * 24));

        if (diffDays <= 0) {
          groups.today.push(task);
        } else if (diffDays <= 7) {
          groups.thisWeek.push(task);
        } else {
          groups.later.push(task);
        }
      }
    });

    renderTaskSection(container, 'Today', groups.today);
    renderTaskSection(container, 'This Week', groups.thisWeek);
    renderTaskSection(container, 'Later', groups.later);
    renderTaskSection(container, 'Completed', groups.completed);
  }

  function renderTaskSection(container, title, items) {
    if (!items || items.length === 0) return;

    const groupWrapper = document.createElement('div');

    const headerWrap = document.createElement('div');
    headerWrap.className = 'section-title-wrap';
    headerWrap.innerHTML = `
      <span class="section-title">${title}</span>
      <span class="section-count">${items.length}</span>
    `;
    groupWrapper.appendChild(headerWrap);

    const cardGroup = document.createElement('div');
    cardGroup.className = 'task-card-group';

    items.forEach(task => {
      const row = createTaskRow(task);
      cardGroup.appendChild(row);
    });

    groupWrapper.appendChild(cardGroup);
    container.appendChild(groupWrapper);
  }

  function createTaskRow(task) {
    const item = document.createElement('div');
    item.className = `task-item ${task.completed === 1 ? 'completed' : ''}`;
    item.dataset.id = task.id;

    // Date badge
    const dateMeta = formatDateBadge(task.due_date);
    let dateHtml = '';
    if (dateMeta) {
      let pillClass = 'due-date-pill';
      if (dateMeta.isOverdue && !task.completed) pillClass += ' overdue';
      if (dateMeta.isToday && !task.completed) pillClass += ' today';
      dateHtml = `<span class="${pillClass}">📅 ${escapeHtml(dateMeta.text)}</span>`;
    }

    // Subject badge
    const colors = getSubjectColor(task.subject || 'General');
    const subjectHtml = task.subject ? `
      <span class="subject-badge" style="background: ${colors.bg}; color: ${colors.text}; border: 1px solid ${colors.border}">
        ${escapeHtml(task.subject)}
      </span>
    ` : '';

    // Priority dot
    const priority = task.priority || 'medium';
    const priorityHtml = `<div class="priority-dot ${priority}" title="${priority.toUpperCase()} priority"></div>`;

    item.innerHTML = `
      <button class="complete-circle" aria-label="Toggle completed">
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
          <path d="M2.5 7L5.5 10L11.5 4" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>

      <div class="task-content">
        <div class="task-title-row">
          <span class="task-title">${escapeHtml(task.title)}</span>
        </div>
        <div class="task-meta-row">
          ${subjectHtml}
          ${dateHtml}
        </div>
      </div>

      ${priorityHtml}

      <div class="task-actions">
        <button class="action-btn edit" title="Edit Task" aria-label="Edit">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
          </svg>
        </button>
        <button class="action-btn delete" title="Delete Task" aria-label="Delete">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </div>
    `;

    // Completion Toggle
    const circle = item.querySelector('.complete-circle');
    circle.addEventListener('click', async (e) => {
      e.stopPropagation();
      await toggleTask(task.id);
    });

    // Edit
    const editBtn = item.querySelector('.action-btn.edit');
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openTaskModal(task);
    });

    // Delete
    const deleteBtn = item.querySelector('.action-btn.delete');
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteTask(task.id);
    });

    return item;
  }

  async function toggleTask(taskId) {
    try {
      const updated = await api(`/api/tasks/${taskId}/toggle`, { method: 'PATCH' });
      refreshUserData();
      loadMyTasks();
      const statusText = updated.completed === 1 ? 'Task completed! 🎉' : 'Task marked pending';
      showToast(statusText, updated.completed === 1 ? '✅' : '↩️');
    } catch (err) {
      showToast(err.message || 'Failed to toggle task', '⚠️');
    }
  }

  async function deleteTask(taskId) {
    try {
      await api(`/api/tasks/${taskId}`, { method: 'DELETE' });
      refreshUserData();
      loadMyTasks();
      showToast('Task deleted', '🗑️');
    } catch (err) {
      showToast(err.message || 'Failed to delete task', '⚠️');
    }
  }

  // --- MODAL SHEET & FORMS ---
  function openTaskModal(task = null) {
    if (task) {
      editingTaskId = task.id;
      elements.taskModalTitle.textContent = 'Edit Task';
      elements.taskInputTitle.value = task.title || '';
      elements.taskInputSubject.value = task.subject || '';
      elements.taskInputDueDate.value = task.due_date || '';
      const priority = task.priority || 'medium';
      elements.priorityOptions.forEach(opt => {
        opt.classList.toggle('active', opt.dataset.priority === priority);
      });
    } else {
      editingTaskId = null;
      elements.taskModalTitle.textContent = 'New Task';
      elements.taskInputTitle.value = '';
      elements.taskInputSubject.value = '';
      
      // Default due date to today
      const todayStr = new Date().toISOString().split('T')[0];
      elements.taskInputDueDate.value = todayStr;
      
      elements.priorityOptions.forEach(opt => {
        opt.classList.toggle('active', opt.dataset.priority === 'medium');
      });
    }

    elements.taskModalOverlay.classList.add('open');
    setTimeout(() => elements.taskInputTitle.focus(), 150);
  }

  function closeTaskModal() {
    elements.taskModalOverlay.classList.remove('open');
    editingTaskId = null;
  }

  async function handleTaskFormSubmit(e) {
    e.preventDefault();
    const title = elements.taskInputTitle.value.trim();
    if (!title) {
      elements.taskInputTitle.focus();
      return;
    }

    const subject = elements.taskInputSubject.value.trim() || 'General';
    const dueDate = elements.taskInputDueDate.value || null;

    let priority = 'medium';
    elements.priorityOptions.forEach(opt => {
      if (opt.classList.contains('active')) {
        priority = opt.dataset.priority;
      }
    });

    try {
      if (editingTaskId) {
        await api(`/api/tasks/${editingTaskId}`, {
          method: 'PUT',
          body: JSON.stringify({ title, subject, dueDate, priority })
        });
        showToast('Task updated!', '✏️');
      } else {
        await api('/api/tasks', {
          method: 'POST',
          body: JSON.stringify({
            userId: currentUser.id,
            title,
            subject,
            dueDate,
            priority
          })
        });
        showToast('Task added!', '✨');
      }

      closeTaskModal();
      refreshUserData();
      loadMyTasks();
    } catch (err) {
      showToast(err.message || 'Error saving task', '⚠️');
    }
  }

  // --- FRIENDS TAB ---
  async function loadFriends() {
    const container = elements.friendsContainer;
    try {
      const [users, allTasks] = await Promise.all([
        api('/api/users'),
        api('/api/tasks')
      ]);

      const friends = users.filter(u => u.id !== currentUser.id);

      if (friends.length === 0) {
        container.innerHTML = `
          <div class="empty-state">
            <span class="empty-state-emoji">👥</span>
            <div class="empty-state-title">No friends yet</div>
            <div class="empty-state-desc">Open another browser tab and login with a friend's name to test collaborative tracking!</div>
          </div>
        `;
        return;
      }

      container.innerHTML = '';
      const listWrap = document.createElement('div');
      listWrap.className = 'friends-list';

      friends.forEach(friend => {
        const friendTasks = allTasks.filter(t => t.user_id === friend.id);
        const total = friendTasks.length;
        const completed = friendTasks.filter(t => t.completed === 1).length;
        const pct = total === 0 ? 0 : Math.round((completed / total) * 100);

        const card = document.createElement('div');
        card.className = 'friend-card';

        // Check if recently active (last 10 mins)
        card.innerHTML = `
          <div class="friend-card-header">
            <div class="friend-identity">
              <div class="friend-avatar-wrap">
                <div class="avatar" style="width: 40px; height: 40px; font-size: 15px; background: ${getAvatarGradient(friend.username)}">
                  ${getInitials(friend.username)}
                </div>
                <div class="online-dot" title="Active"></div>
              </div>
              <div>
                <div class="friend-name">${escapeHtml(friend.username)}</div>
                <div style="font-size: 11px; color: var(--ios-secondary-label)">
                  ${total === 0 ? 'No tasks' : `${completed} of ${total} completed`}
                </div>
              </div>
            </div>

            <div class="friend-completion-text">
              ${pct}%
            </div>
          </div>

          <div class="friend-progress-wrap">
            <div class="friend-progress-bar-bg">
              <div class="friend-progress-bar-fill" style="width: ${pct}%"></div>
            </div>
          </div>

          <div class="friend-tasks-dropdown">
            ${friendTasks.length === 0 ? 
              '<div style="font-size: 12px; color: var(--ios-secondary-label); text-align: center; padding: 6px 0;">No tasks created yet</div>' :
              friendTasks.map(t => `
                <div class="friend-task-row">
                  <div class="friend-task-left">
                    <span class="friend-check-mini ${t.completed === 1 ? 'completed' : ''}">
                      ${t.completed === 1 ? '✓' : ''}
                    </span>
                    <span style="${t.completed === 1 ? 'text-decoration: line-through; color: var(--ios-secondary-label);' : ''}">
                      ${escapeHtml(t.title)}
                    </span>
                  </div>
                  <span style="font-size: 11px; color: var(--ios-secondary-label);">
                    ${escapeHtml(t.subject || 'General')}
                  </span>
                </div>
              `).join('')
            }
          </div>
        `;

        // Tap to toggle expanded view
        card.addEventListener('click', () => {
          card.classList.toggle('expanded');
        });

        listWrap.appendChild(card);
      });

      container.appendChild(listWrap);
    } catch (err) {
      console.error('Error loading friends:', err);
    }
  }

  // --- ACTIVITY TAB ---
  async function loadActivity() {
    const container = elements.activityContainer;
    try {
      const logs = await api('/api/logs?limit=50');
      if (!logs || logs.length === 0) {
        container.innerHTML = `
          <div class="empty-state">
            <span class="empty-state-emoji">⏳</span>
            <div class="empty-state-title">No activity yet</div>
            <div class="empty-state-desc">Actions like adding or completing tasks will show here.</div>
          </div>
        `;
        return;
      }

      container.innerHTML = '';
      const timeline = document.createElement('div');
      timeline.className = 'activity-timeline';

      logs.forEach(log => {
        const item = createActivityItem(log);
        timeline.appendChild(item);
      });

      container.appendChild(timeline);
    } catch (err) {
      console.error('Error loading activity logs:', err);
    }
  }

  function createActivityItem(log) {
    const card = document.createElement('div');
    card.className = 'activity-card';

    let iconClass = 'created';
    let iconSymbol = '➕';
    let actionDesc = 'did something';

    let details = {};
    try {
      if (log.details) {
        details = typeof log.details === 'string' ? JSON.parse(log.details) : log.details;
      }
    } catch {
      details = {};
    }

    const taskTitle = details.title || (details.after && details.after.title) || 'a task';

    switch (log.action) {
      case 'task_created':
        iconClass = 'created';
        iconSymbol = '➕';
        actionDesc = `added <strong>'${escapeHtml(taskTitle)}'</strong>`;
        break;
      case 'task_completed':
        iconClass = 'completed';
        iconSymbol = '✓';
        actionDesc = `completed <strong>'${escapeHtml(taskTitle)}'</strong>`;
        break;
      case 'task_reopened':
        iconClass = 'reopened';
        iconSymbol = '↩️';
        actionDesc = `reopened <strong>'${escapeHtml(taskTitle)}'</strong>`;
        break;
      case 'task_deleted':
        iconClass = 'deleted';
        iconSymbol = '🗑️';
        actionDesc = `deleted <strong>'${escapeHtml(taskTitle)}'</strong>`;
        break;
      case 'task_updated':
        iconClass = 'updated';
        iconSymbol = '✏️';
        actionDesc = `updated <strong>'${escapeHtml(taskTitle)}'</strong>`;
        break;
      case 'user_registered':
        iconClass = 'login';
        iconSymbol = '🎉';
        actionDesc = `joined College Tasks`;
        break;
      case 'login':
        iconClass = 'login';
        iconSymbol = '👋';
        actionDesc = `logged in`;
        break;
      default:
        actionDesc = escapeHtml(log.action);
    }

    card.innerHTML = `
      <div class="activity-icon ${iconClass}">
        ${iconSymbol}
      </div>
      <div class="activity-content">
        <div class="activity-title">
          <strong>${escapeHtml(log.username || 'Someone')}</strong> ${actionDesc}
        </div>
        <div class="activity-time">
          ${formatRelativeTime(log.timestamp)}
        </div>
      </div>
    `;

    return card;
  }

})();
