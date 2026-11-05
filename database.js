const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'college_tasks.db');
const db = new Database(dbPath);

// Enable pragmas
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    subject TEXT,
    due_date TEXT,
    priority TEXT DEFAULT 'medium',
    completed INTEGER DEFAULT 0,
    completed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    username TEXT,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id INTEGER,
    details TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// User queries
const stmtFindUserByUsername = db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)');
const stmtFindUserById = db.prepare('SELECT * FROM users WHERE id = ?');
const stmtCreateUser = db.prepare('INSERT INTO users (username) VALUES (?)');
const stmtUpdateLastSeen = db.prepare('UPDATE users SET last_seen = CURRENT_TIMESTAMP WHERE id = ?');
const stmtGetAllUsers = db.prepare('SELECT * FROM users ORDER BY username COLLATE NOCASE ASC');

// Task queries
const stmtGetAllTasks = db.prepare(`
  SELECT t.*, u.username 
  FROM tasks t 
  JOIN users u ON t.user_id = u.id 
  ORDER BY t.completed ASC, t.due_date ASC, t.created_at DESC
`);

const stmtGetTasksByUserId = db.prepare(`
  SELECT t.*, u.username 
  FROM tasks t 
  JOIN users u ON t.user_id = u.id 
  WHERE t.user_id = ? 
  ORDER BY t.completed ASC, t.due_date ASC, t.created_at DESC
`);

const stmtGetTaskById = db.prepare(`
  SELECT t.*, u.username 
  FROM tasks t 
  JOIN users u ON t.user_id = u.id 
  WHERE t.id = ?
`);

const stmtCreateTask = db.prepare(`
  INSERT INTO tasks (user_id, title, subject, due_date, priority)
  VALUES (@userId, @title, @subject, @dueDate, @priority)
`);

const stmtToggleTask = db.prepare(`
  UPDATE tasks 
  SET completed = CASE WHEN completed = 1 THEN 0 ELSE 1 END,
      completed_at = CASE WHEN completed = 1 THEN NULL ELSE CURRENT_TIMESTAMP END,
      updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
`);

const stmtDeleteTask = db.prepare('DELETE FROM tasks WHERE id = ?');

const stmtUpdateTask = db.prepare(`
  UPDATE tasks 
  SET title = COALESCE(@title, title),
      subject = COALESCE(@subject, subject),
      due_date = COALESCE(@dueDate, due_date),
      priority = COALESCE(@priority, priority),
      updated_at = CURRENT_TIMESTAMP
  WHERE id = @id
`);

// Stats queries
const stmtGetStats = db.prepare(`
  SELECT 
    COUNT(*) as total,
    SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) as completed,
    SUM(CASE WHEN completed = 0 THEN 1 ELSE 0 END) as pending
  FROM tasks
  WHERE user_id = ?
`);

// Audit queries
const stmtInsertAudit = db.prepare(`
  INSERT INTO audit_log (user_id, username, action, entity_type, entity_id, details)
  VALUES (@userId, @username, @action, @entityType, @entityId, @details)
`);

const stmtGetRecentLogs = db.prepare(`
  SELECT * FROM audit_log ORDER BY id DESC LIMIT ?
`);

function logAudit({ userId, username, action, entityType = 'task', entityId = null, details = null }) {
  try {
    let resolvedUsername = username;
    if (!resolvedUsername && userId) {
      const u = stmtFindUserById.get(userId);
      if (u) resolvedUsername = u.username;
    }
    const detailsStr = typeof details === 'object' && details !== null ? JSON.stringify(details) : details;
    return stmtInsertAudit.run({
      userId: userId || null,
      username: resolvedUsername || 'Anonymous',
      action,
      entityType,
      entityId: entityId || null,
      details: detailsStr || null
    });
  } catch (err) {
    console.error('Audit logging error:', err);
  }
}

function loginOrCreateUser(rawUsername) {
  const username = rawUsername.trim();
  let user = stmtFindUserByUsername.get(username);
  let isNew = false;
  if (!user) {
    const info = stmtCreateUser.run(username);
    user = stmtFindUserById.get(info.lastInsertRowid);
    isNew = true;
  } else {
    stmtUpdateLastSeen.run(user.id);
  }

  logAudit({
    userId: user.id,
    username: user.username,
    action: isNew ? 'user_registered' : 'login',
    entityType: 'user',
    entityId: user.id,
    details: { isNew }
  });

  return user;
}

function getUserStats(userId) {
  const stats = stmtGetStats.get(userId) || { total: 0, completed: 0, pending: 0 };
  return {
    total: Number(stats.total || 0),
    completed: Number(stats.completed || 0),
    pending: Number(stats.pending || 0)
  };
}

module.exports = {
  db,
  loginOrCreateUser,
  getAllUsers: () => stmtGetAllUsers.all(),
  getUserById: (id) => stmtFindUserById.get(id),
  getUserStats,
  getAllTasks: () => stmtGetAllTasks.all(),
  getTasksByUserId: (userId) => stmtGetTasksByUserId.all(userId),
  getTaskById: (id) => stmtGetTaskById.get(id),
  createTask: ({ userId, title, subject, dueDate, priority }) => {
    const info = stmtCreateTask.run({
      userId,
      title: title.trim(),
      subject: (subject || '').trim() || 'General',
      dueDate: dueDate || null,
      priority: priority || 'medium'
    });
    return stmtGetTaskById.get(info.lastInsertRowid);
  },
  toggleTask: (id) => {
    stmtToggleTask.run(id);
    return stmtGetTaskById.get(id);
  },
  deleteTask: (id) => {
    const existing = stmtGetTaskById.get(id);
    if (!existing) return null;
    stmtDeleteTask.run(id);
    return existing;
  },
  updateTask: ({ id, title, subject, dueDate, priority }) => {
    stmtUpdateTask.run({ id, title, subject, dueDate, priority });
    return stmtGetTaskById.get(id);
  },
  logAudit,
  getRecentLogs: (limit = 50) => stmtGetRecentLogs.all(limit)
};
