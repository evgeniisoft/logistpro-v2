const bcrypt = require('bcryptjs');
const { query } = require('./_lib/db');
const { requireAuth } = require('./_lib/auth');
const { logChange } = require('./_lib/journal');

// ============ ХЕЛПЕРЫ ============

// Разрешённые роли
const ROLES = ['admin', 'senior_logist', 'logist', 'manager', 'viewer'];

// Русские названия таблиц для журнала
const TABLE_LABELS = {
  trips: 'Рейсы',
  orders: 'Заказы',
  costs: 'Затраты',
  vehicles: 'Машины',
  drivers: 'Водители',
  routes: 'Маршруты',
  incoming_orders: 'Входящие заказы',
  settings: 'Настройки',
  users: 'Пользователи',
  bitrix_integrations: 'Битрикс24',
  journal: 'Журнал',
};

// Проверка: пользователь — админ
function requireAdmin(req, res) {
  if (req.user.role !== 'admin') {
    res.status(403).json({ error: 'Только администратор' });
    return false;
  }
  return true;
}

// Проверка: пользователь — админ или ст. логист (для чтения журнала)
function canViewAllJournal(req) {
  return req.user.role === 'admin' || req.user.role === 'senior_logist';
}

async function handler(req, res) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const action = req.query.action;

  // ============ USERS LIST ============
  if (action === 'users-list') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    if (!requireAdmin(req, res)) return;

    try {
      const result = await query(
        `SELECT id, login, full_name, role, is_active, created_at, last_login
         FROM users
         ORDER BY 
           CASE WHEN is_active THEN 0 ELSE 1 END,
           role DESC,
           full_name ASC`
      );

      return res.json({ users: result.rows });
    } catch (e) {
      console.error('users-list error:', e);
      return res.status(500).json({ error: 'Ошибка сервера', details: e.message });
    }
  }

  // ============ USERS CREATE ============
  if (action === 'users-create') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!requireAdmin(req, res)) return;

    const { login, password, full_name, role } = req.body || {};

    if (!login || !password || !full_name || !role) {
      return res.status(400).json({ error: 'Заполните все поля' });
    }
    if (String(login).length < 3) {
      return res.status(400).json({ error: 'Логин — минимум 3 символа' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'Пароль — минимум 6 символов' });
    }
    if (!ROLES.includes(role)) {
      return res.status(400).json({ error: 'Неверная роль' });
    }

    try {
      // Проверка уникальности логина
      const existing = await query('SELECT id FROM users WHERE login = $1', [login]);
      if (existing.rows.length > 0) {
        return res.status(400).json({ error: 'Логин уже занят' });
      }

      const hash = await bcrypt.hash(String(password), 10);

      const result = await query(
        `INSERT INTO users (login, password_hash, full_name, role, is_active)
         VALUES ($1, $2, $3, $4, true)
         RETURNING id, login, full_name, role, is_active, created_at, last_login`,
        [login, hash, full_name, role]
      );

      const newUser = result.rows[0];

      await logChange(req.user.id, 'users', newUser.id, 'Создание',
        '', `Создан: ${login} (${full_name}, ${role})`, ip);

      return res.json({ success: true, user: newUser });
    } catch (e) {
      console.error('users-create error:', e);
      return res.status(500).json({ error: 'Ошибка сервера', details: e.message });
    }
  }

  // ============ USERS UPDATE ============
  if (action === 'users-update') {
    if (req.method !== 'PUT' && req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }
    if (!requireAdmin(req, res)) return;

    const id = parseInt(req.query.id, 10);
    if (!id) return res.status(400).json({ error: 'Не указан ID' });

    const { full_name, role, is_active } = req.body || {};

    try {
      const current = await query('SELECT * FROM users WHERE id = $1', [id]);
      if (current.rows.length === 0) {
        return res.status(404).json({ error: 'Пользователь не найден' });
      }
      const user = current.rows[0];

      // Защита: нельзя деактивировать себя
      if (id === req.user.id && is_active === false) {
        return res.status(400).json({ error: 'Нельзя деактивировать себя' });
      }

      // Защита: нельзя убрать роль admin у последнего активного админа
      if (user.role === 'admin' && role && role !== 'admin') {
        const admins = await query(
          "SELECT COUNT(*)::int AS cnt FROM users WHERE role = 'admin' AND is_active = true"
        );
        if (admins.rows[0].cnt <= 1) {
          return res.status(400).json({ error: 'Нельзя убрать роль у последнего администратора' });
        }
      }
      if (user.role === 'admin' && is_active === false) {
        const admins = await query(
          "SELECT COUNT(*)::int AS cnt FROM users WHERE role = 'admin' AND is_active = true"
        );
        if (admins.rows[0].cnt <= 1) {
          return res.status(400).json({ error: 'Нельзя деактивировать последнего администратора' });
        }
      }

      // Проверка роли
      if (role && !ROLES.includes(role)) {
        return res.status(400).json({ error: 'Неверная роль' });
      }

      // Собираем поля для обновления
      const updates = [];
      const params = [];
      let idx = 1;

      if (full_name !== undefined && full_name !== user.full_name) {
        updates.push(`full_name = $${idx++}`);
        params.push(full_name);
        await logChange(req.user.id, 'users', id, 'full_name', user.full_name, full_name, ip);
      }
      if (role !== undefined && role !== user.role) {
        updates.push(`role = $${idx++}`);
        params.push(role);
        await logChange(req.user.id, 'users', id, 'role', user.role, role, ip);
      }
      if (is_active !== undefined && is_active !== user.is_active) {
        updates.push(`is_active = $${idx++}`);
        params.push(is_active);
        await logChange(req.user.id, 'users', id, 'is_active', String(user.is_active), String(is_active), ip);
      }

      if (updates.length === 0) {
        return res.json({ success: true, message: 'Нечего обновлять' });
      }

      params.push(id);
      const result = await query(
        `UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}
         RETURNING id, login, full_name, role, is_active, created_at, last_login`,
        params
      );

      return res.json({ success: true, user: result.rows[0] });
    } catch (e) {
      console.error('users-update error:', e);
      return res.status(500).json({ error: 'Ошибка сервера', details: e.message });
    }
  }

  // ============ USERS RESET PASSWORD (админ сбрасывает другому) ============
  if (action === 'users-reset-password') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!requireAdmin(req, res)) return;

    const id = parseInt(req.query.id, 10);
    if (!id) return res.status(400).json({ error: 'Не указан ID' });

    const { password } = req.body || {};
    if (!password || String(password).length < 6) {
      return res.status(400).json({ error: 'Пароль — минимум 6 символов' });
    }

    try {
      const current = await query('SELECT login FROM users WHERE id = $1', [id]);
      if (current.rows.length === 0) {
        return res.status(404).json({ error: 'Пользователь не найден' });
      }

      const hash = await bcrypt.hash(String(password), 10);
      await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, id]);

      await logChange(req.user.id, 'users', id, 'Сброс пароля',
        '', `Пароль сброшен для ${current.rows[0].login}`, ip);

      return res.json({ success: true });
    } catch (e) {
      console.error('users-reset-password error:', e);
      return res.status(500).json({ error: 'Ошибка сервера', details: e.message });
    }
  }

  // ============ USERS CHANGE PASSWORD (смена своего пароля) ============
  if (action === 'users-change-password') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { old_password, new_password } = req.body || {};

    if (!old_password || !new_password) {
      return res.status(400).json({ error: 'Заполните оба поля' });
    }
    if (String(new_password).length < 6) {
      return res.status(400).json({ error: 'Новый пароль — минимум 6 символов' });
    }

    try {
      const result = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Пользователь не найден' });
      }

      const match = await bcrypt.compare(String(old_password), result.rows[0].password_hash);
      if (!match) {
        return res.status(400).json({ error: 'Неверный текущий пароль' });
      }

      const hash = await bcrypt.hash(String(new_password), 10);
      await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);

      await logChange(req.user.id, 'users', req.user.id, 'Смена пароля',
        '', 'Пользователь сменил свой пароль', ip);

      return res.json({ success: true });
    } catch (e) {
      console.error('users-change-password error:', e);
      return res.status(500).json({ error: 'Ошибка сервера', details: e.message });
    }
  }

  // ============ JOURNAL FILTERS (список пользователей для дропдауна) ============
  if (action === 'journal-filters') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    try {
      let usersList = [];

      if (canViewAllJournal(req)) {
        // Все пользователи, у которых есть записи в журнале
        const usersResult = await query(
          `SELECT DISTINCT u.id, u.full_name, u.login
           FROM users u
           INNER JOIN journal j ON j.user_id = u.id
           ORDER BY u.full_name ASC`
        );
        usersList = usersResult.rows;
      } else {
        // Только себя
        const meResult = await query(
          'SELECT id, full_name, login FROM users WHERE id = $1',
          [req.user.id]
        );
        usersList = meResult.rows;
      }

      // Список таблиц, которые реально есть в журнале
      const tablesResult = await query(
        `SELECT table_name, COUNT(*)::int AS cnt
         FROM journal
         GROUP BY table_name
         ORDER BY cnt DESC`
      );

      const tables = tablesResult.rows.map((r) => ({
        value: r.table_name,
        label: TABLE_LABELS[r.table_name] || r.table_name,
        count: r.cnt,
      }));

      return res.json({
        users: usersList,
        tables,
        can_view_all: canViewAllJournal(req),
      });
    } catch (e) {
      console.error('journal-filters error:', e);
      return res.status(500).json({ error: 'Ошибка сервера', details: e.message });
    }
  }

  // ============ JOURNAL LIST ============
  if (action === 'journal-list') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const { user_id, table_name, field_name, date_from, date_to } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = 50;
    const offset = (page - 1) * perPage;

    try {
      const filters = [];
      const params = [];
      let idx = 1;

      // Ограничение по роли
      if (!canViewAllJournal(req)) {
        filters.push(`j.user_id = $${idx++}`);
        params.push(req.user.id);
      } else if (user_id) {
        filters.push(`j.user_id = $${idx++}`);
        params.push(parseInt(user_id, 10));
      }

      if (table_name) {
        filters.push(`j.table_name = $${idx++}`);
        params.push(table_name);
      }
      if (field_name) {
        filters.push(`j.field_name ILIKE $${idx++}`);
        params.push('%' + field_name + '%');
      }
      if (date_from) {
        filters.push(`j.created_at >= $${idx++}`);
        params.push(date_from);
      }
      if (date_to) {
        filters.push(`j.created_at <= $${idx++}`);
        params.push(date_to + ' 23:59:59');
      }

      const where = filters.length > 0 ? 'WHERE ' + filters.join(' AND ') : '';

      // Общее количество
      const countResult = await query(
        `SELECT COUNT(*)::int AS total FROM journal j ${where}`,
        params
      );
      const total = countResult.rows[0].total;

      // Записи
      const entriesResult = await query(
        `SELECT 
            j.id,
            j.user_id,
            j.table_name,
            j.record_id,
            j.field_name,
            j.old_value,
            j.new_value,
            j.ip,
            j.created_at,
            u.full_name AS user_name,
            u.login AS user_login
         FROM journal j
         LEFT JOIN users u ON u.id = j.user_id
         ${where}
         ORDER BY j.created_at DESC, j.id DESC
         LIMIT ${perPage} OFFSET ${offset}`,
        params
      );

      const entries = entriesResult.rows.map((r) => ({
        ...r,
        table_label: TABLE_LABELS[r.table_name] || r.table_name,
      }));

      return res.json({
        entries,
        total,
        page,
        per_page: perPage,
        pages: Math.ceil(total / perPage) || 1,
      });
    } catch (e) {
      console.error('journal-list error:', e);
      return res.status(500).json({ error: 'Ошибка сервера', details: e.message });
    }
  }

  return res.status(400).json({ error: 'Unknown action: ' + action });
}

module.exports = requireAuth(handler);
