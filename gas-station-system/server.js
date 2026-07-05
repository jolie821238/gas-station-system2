/**
 * 加油站儲值管理系統 - 後端伺服器
 * Node.js + Express + better-sqlite3 + express-session
 * 所有時間一律使用 Asia/Taipei
 */

const express = require('express');
const session = require('express-session');
const path = require('path');
const Database = require('better-sqlite3');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;

const LOW_BALANCE_THRESHOLD = 20000; // 餘額警示門檻
const ADMIN_PASSWORD = '8899';
const INITIAL_BALANCE = 100000;

// ---------------------------------------------------------------------------
// 資料庫初始化
// ---------------------------------------------------------------------------
const db = new Database(path.join(__dirname, 'gas_station.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS vendors (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    name    TEXT UNIQUE NOT NULL,
    balance REAL NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id  INTEGER NOT NULL,
    amount     REAL NOT NULL,
    type       TEXT NOT NULL CHECK(type IN ('deduct','admin_adjust')),
    created_at TEXT NOT NULL,
    FOREIGN KEY (vendor_id) REFERENCES vendors(id)
  );

  CREATE TABLE IF NOT EXISTS admin_users (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL
  );
`);

// 初始種子資料：廠商 A B C D，各 100000 元
const vendorCount = db.prepare('SELECT COUNT(*) AS c FROM vendors').get().c;
if (vendorCount === 0) {
  const insertVendor = db.prepare('INSERT INTO vendors (name, balance) VALUES (?, ?)');
  const seedVendors = db.transaction((names) => {
    names.forEach((name) => insertVendor.run(name, INITIAL_BALANCE));
  });
  seedVendors(['A', 'B', 'C', 'D']);
}

// 初始管理員帳號
const adminCount = db.prepare('SELECT COUNT(*) AS c FROM admin_users').get().c;
if (adminCount === 0) {
  db.prepare('INSERT INTO admin_users (username, password) VALUES (?, ?)').run('admin', ADMIN_PASSWORD);
}

// ---------------------------------------------------------------------------
// 時間工具（Asia/Taipei，不使用 UTC）
// ---------------------------------------------------------------------------
function nowTaipei() {
  // sv-SE locale 會產生 'YYYY-MM-DD HH:mm:ss' 格式，方便字串排序與比對
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' });
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(express.json());
app.use(
  session({
    name: 'gas.sid',
    secret: 'gas-station-admin-secret-please-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 8 // 8 小時
    }
  })
);

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: '請先登入後台' });
}

// ---------------------------------------------------------------------------
// 🟩 前台 API（無需登入）
// ---------------------------------------------------------------------------

// 取得所有廠商即時餘額
app.get('/api/vendors', (req, res) => {
  const vendors = db.prepare('SELECT id, name, balance FROM vendors ORDER BY id').all();
  res.json(vendors);
});

// 扣款（唯一操作）
app.post('/api/deduct', (req, res) => {
  const { vendor_id, amount } = req.body;
  const amt = Number(amount);

  if (!vendor_id) {
    return res.status(400).json({ error: '請選擇廠商' });
  }
  if (!Number.isFinite(amt) || amt <= 0) {
    return res.status(400).json({ error: '扣款金額必須大於 0' });
  }

  const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(vendor_id);
  if (!vendor) {
    return res.status(404).json({ error: '廠商不存在' });
  }
  if (amt > vendor.balance) {
    return res.status(400).json({ error: '扣款金額不可超過餘額' });
  }

  const newBalance = vendor.balance - amt;
  const runDeduct = db.transaction(() => {
    db.prepare('UPDATE vendors SET balance = ? WHERE id = ?').run(newBalance, vendor.id);
    db.prepare(
      'INSERT INTO transactions (vendor_id, amount, type, created_at) VALUES (?, ?, ?, ?)'
    ).run(vendor.id, amt, 'deduct', nowTaipei());
  });
  runDeduct();

  const updated = db.prepare('SELECT id, name, balance FROM vendors WHERE id = ?').get(vendor.id);
  res.json({ success: true, vendor: updated });
});

// ---------------------------------------------------------------------------
// 🟨 後台 - 登入 / 登出 / Session 狀態
// ---------------------------------------------------------------------------

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  const admin = db.prepare('SELECT * FROM admin_users WHERE username = ?').get('admin');

  if (admin && password === admin.password) {
    req.session.isAdmin = true;
    return res.json({ success: true });
  }
  res.status(401).json({ error: '密碼錯誤' });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('gas.sid');
    res.json({ success: true });
  });
});

app.get('/api/admin/session', (req, res) => {
  res.json({ loggedIn: !!(req.session && req.session.isAdmin) });
});

// ---------------------------------------------------------------------------
// 🟨 後台 - 廠商管理（皆需 session 驗證）
// ---------------------------------------------------------------------------

app.get('/api/admin/vendors', requireAdmin, (req, res) => {
  const vendors = db.prepare('SELECT id, name, balance FROM vendors ORDER BY id').all();
  res.json(vendors);
});

// 新增廠商
app.post('/api/admin/vendors', requireAdmin, (req, res) => {
  const { name, initial_balance } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: '請輸入廠商名稱' });
  }
  const balance = Number.isFinite(Number(initial_balance)) ? Number(initial_balance) : 0;
  try {
    const info = db
      .prepare('INSERT INTO vendors (name, balance) VALUES (?, ?)')
      .run(name.trim(), balance);
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: '廠商名稱重複或無效' });
  }
});

// 修改廠商名稱
app.put('/api/admin/vendors/:id', requireAdmin, (req, res) => {
  const { name } = req.body;
  const { id } = req.params;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: '請輸入廠商名稱' });
  }
  const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(id);
  if (!vendor) {
    return res.status(404).json({ error: '廠商不存在' });
  }
  try {
    db.prepare('UPDATE vendors SET name = ? WHERE id = ?').run(name.trim(), id);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: '廠商名稱重複或無效' });
  }
});

// 刪除廠商（有扣款紀錄則不可刪除）
app.delete('/api/admin/vendors/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(id);
  if (!vendor) {
    return res.status(404).json({ error: '廠商不存在' });
  }
  const txCount = db.prepare('SELECT COUNT(*) AS c FROM transactions WHERE vendor_id = ?').get(id).c;
  if (txCount > 0) {
    return res.status(400).json({ error: '此廠商已有交易紀錄，無法刪除' });
  }
  db.prepare('DELETE FROM vendors WHERE id = ?').run(id);
  res.json({ success: true });
});

// 調整廠商餘額（可加可減，不受前台限制）
app.post('/api/admin/vendors/:id/adjust', requireAdmin, (req, res) => {
  const { id } = req.params;
  const { amount } = req.body;
  const amt = Number(amount);

  if (!Number.isFinite(amt) || amt === 0) {
    return res.status(400).json({ error: '調整金額不可為 0 或無效數字' });
  }
  const vendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(id);
  if (!vendor) {
    return res.status(404).json({ error: '廠商不存在' });
  }

  const newBalance = vendor.balance + amt;
  const runAdjust = db.transaction(() => {
    db.prepare('UPDATE vendors SET balance = ? WHERE id = ?').run(newBalance, id);
    db.prepare(
      'INSERT INTO transactions (vendor_id, amount, type, created_at) VALUES (?, ?, ?, ?)'
    ).run(id, amt, 'admin_adjust', nowTaipei());
  });
  runAdjust();

  const updated = db.prepare('SELECT id, name, balance FROM vendors WHERE id = ?').get(id);
  res.json({ success: true, vendor: updated });
});

// ---------------------------------------------------------------------------
// 🟨 後台 - 扣款紀錄（純表格）
// ---------------------------------------------------------------------------
app.get('/api/admin/transactions', requireAdmin, (req, res) => {
  const rows = db
    .prepare(
      `SELECT t.id, v.name AS vendor_name, t.amount, t.type, t.created_at
       FROM transactions t
       JOIN vendors v ON v.id = t.vendor_id
       ORDER BY t.id DESC`
    )
    .all();
  res.json(rows);
});

// ---------------------------------------------------------------------------
// 🟨 後台 - 每日統計（Asia/Taipei 分日，僅計算 deduct 類型）
// ---------------------------------------------------------------------------
app.get('/api/admin/daily-stats', requireAdmin, (req, res) => {
  const rows = db
    .prepare(
      `SELECT substr(t.created_at, 1, 10) AS date, v.name AS vendor_name, SUM(t.amount) AS total
       FROM transactions t
       JOIN vendors v ON v.id = t.vendor_id
       WHERE t.type = 'deduct'
       GROUP BY date, v.name
       ORDER BY date DESC, v.name ASC`
    )
    .all();
  res.json(rows);
});

// ---------------------------------------------------------------------------
// 🟨 後台 - Excel 匯出（.xlsx，兩種資料各自獨立檔案）
// ---------------------------------------------------------------------------
app.get('/api/admin/export/transactions', requireAdmin, (req, res) => {
  const rows = db
    .prepare(
      `SELECT v.name AS 廠商名稱, t.amount AS 金額,
              CASE t.type WHEN 'deduct' THEN '扣款' ELSE '後台調整' END AS 類型,
              t.created_at AS 時間
       FROM transactions t
       JOIN vendors v ON v.id = t.vendor_id
       ORDER BY t.id DESC`
    )
    .all();

  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '扣款紀錄');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="transactions.xlsx"');
  res.send(buffer);
});

app.get('/api/admin/export/daily-stats', requireAdmin, (req, res) => {
  const rows = db
    .prepare(
      `SELECT substr(t.created_at, 1, 10) AS 日期, v.name AS 廠商名稱, SUM(t.amount) AS 扣款總額
       FROM transactions t
       JOIN vendors v ON v.id = t.vendor_id
       WHERE t.type = 'deduct'
       GROUP BY 日期, v.name
       ORDER BY 日期 DESC, v.name ASC`
    )
    .all();

  const worksheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '每日統計');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="daily_stats.xlsx"');
  res.send(buffer);
});

// ---------------------------------------------------------------------------
// 靜態檔案（前台 / 後台頁面）
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`🚀 加油站儲值管理系統已啟動`);
  console.log(`   前台: http://localhost:${PORT}/`);
  console.log(`   後台: http://localhost:${PORT}/admin.html (密碼: ${ADMIN_PASSWORD})`);
});
