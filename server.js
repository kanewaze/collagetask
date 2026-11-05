const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Server-Sent Events (SSE) clients
const sseClients = new Set();

function broadcastEvent(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.res.write(payload);
    } catch (err) {
      console.error('Error broadcasting to client:', err.message);
      sseClients.delete(client);
    }
  }
}

// SSE Keep-alive heartbeat every 25 seconds
setInterval(() => {
  for (const client of sseClients) {
    try {
      client.res.write(': ping\n\n');
    } catch {
      sseClients.delete(client);
    }
  }
}, 25000);

// SSE Stream endpoint
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write(': connected\n\n');

  const client = { id: Date.now() + Math.random(), res };
  sseClients.add(client);

  req.on('close', () => {
    sseClients.delete(client);
  });
});

// Helper to extract user info from headers or body
function getActingUser(req) {
  const headerId = req.headers['x-user-id'];
  const bodyId = req.body && req.body.userId;
  const queryId = req.query && req.query.userId;
  const uid = headerId || bodyId || queryId;
  if (!uid) return null;
  return db.getUserById(Number(uid));
}

// --- USERS API ---

// List all users
app.get('/api/users', (req, res) => {
  try {
    const users = db.getAllUsers();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create/Login user
app.post('/api/users', (req, res) => {
  try {
    const { username } = req.body;
    if (!username || !username.trim()) {
      return res.status(400).json({ error: 'Username is required' });
    }
    const user = db.loginOrCreateUser(username);

    broadcastEvent('user_joined', {
      user: { id: user.id, username: user.username },
      message: `${user.username} logged in`
    });

    res.json({ id: user.id, username: user.username, created_at: user.created_at, last_seen: user.last_seen });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// User stats
app.get('/api/users/:id/stats', (req, res) => {
  try {
    const userId = Number(req.params.id);
    const user = db.getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    const stats = db.getUserStats(userId);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- TASKS API ---

// Get tasks (all or by userId)
app.get('/api/tasks', (req, res) => {
  try {
    const { userId } = req.query;
    let tasks;
    if (userId) {
      tasks = db.getTasksByUserId(Number(userId));
    } else {
      tasks = db.getAllTasks();
    }
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create task
app.post('/api/tasks', (req, res) => {
  try {
    const { userId, title, subject, dueDate, priority } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Task title is required' });
    }
    const user = db.getUserById(Number(userId));
    if (!user) {
      return res.status(404).json({ error: 'User does not exist' });
    }

    const task = db.createTask({
      userId: Number(userId),
      title,
      subject,
      dueDate,
      priority
    });

    db.logAudit({
      userId: user.id,
      username: user.username,
      action: 'task_created',
      entityType: 'task',
      entityId: task.id,
      details: { title: task.title, subject: task.subject, priority: task.priority, dueDate: task.due_date }
    });

    broadcastEvent('task_created', {
      task,
      actor: user.username,
      message: `${user.username} created '${task.title}'`
    });

    res.status(201).json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle complete/incomplete
app.patch('/api/tasks/:id/toggle', (req, res) => {
  try {
    const taskId = Number(req.params.id);
    const existing = db.getTaskById(taskId);
    if (!existing) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const updated = db.toggleTask(taskId);
    const action = updated.completed === 1 ? 'task_completed' : 'task_reopened';

    // Identify who toggled it
    const actor = getActingUser(req) || { id: updated.user_id, username: updated.username };

    db.logAudit({
      userId: actor.id,
      username: actor.username,
      action,
      entityType: 'task',
      entityId: updated.id,
      details: { title: updated.title, completed: updated.completed }
    });

    broadcastEvent(action, {
      task: updated,
      actor: actor.username,
      message: `${actor.username} ${updated.completed === 1 ? 'completed' : 'reopened'} '${updated.title}'`
    });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete task
app.delete('/api/tasks/:id', (req, res) => {
  try {
    const taskId = Number(req.params.id);
    const existing = db.getTaskById(taskId);
    if (!existing) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const actor = getActingUser(req);
    // If actor is provided, ensure owner matches
    if (actor && actor.id !== existing.user_id) {
      return res.status(403).json({ error: 'Only the task owner can delete this task' });
    }

    const deleted = db.deleteTask(taskId);
    const actorName = actor ? actor.username : existing.username;

    db.logAudit({
      userId: actor ? actor.id : existing.user_id,
      username: actorName,
      action: 'task_deleted',
      entityType: 'task',
      entityId: taskId,
      details: { title: existing.title }
    });

    broadcastEvent('task_deleted', {
      taskId,
      actor: actorName,
      message: `${actorName} deleted '${existing.title}'`
    });

    res.json({ message: 'Task deleted successfully', task: existing });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update task
app.put('/api/tasks/:id', (req, res) => {
  try {
    const taskId = Number(req.params.id);
    const existing = db.getTaskById(taskId);
    if (!existing) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const actor = getActingUser(req);
    if (actor && actor.id !== existing.user_id) {
      return res.status(403).json({ error: 'Only the task owner can edit this task' });
    }

    const { title, subject, dueDate, priority } = req.body;
    const updated = db.updateTask({
      id: taskId,
      title,
      subject,
      dueDate,
      priority
    });

    const actorName = actor ? actor.username : updated.username;

    db.logAudit({
      userId: actor ? actor.id : updated.user_id,
      username: actorName,
      action: 'task_updated',
      entityType: 'task',
      entityId: updated.id,
      details: { before: existing, after: updated }
    });

    broadcastEvent('task_updated', {
      task: updated,
      actor: actorName,
      message: `${actorName} updated '${updated.title}'`
    });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- AUDIT LOG API ---
app.get('/api/logs', (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const logs = db.getRecentLogs(limit);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fallback to index.html for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`🎓 College Tasks Server running on http://localhost:${PORT}`);
  console.log(`📊 Database: college_tasks.db`);
  console.log(`✅ Ready!`);
});
