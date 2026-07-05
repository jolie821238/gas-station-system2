# ⛽ 加油站儲值管理系統

Node.js + Express + SQLite（better-sqlite3）+ Session 登入的完整全端專案。

## 功能總覽

- **前台**（`/`）：即時顯示 A、B、C、D 四家廠商餘額（卡片式），低於 NT$20,000 紅色警示 + 晃動動畫；唯一操作為扣款，並有完整金額檢核（不可為 0、不可負數、不可超過餘額）。
- **後台**（`/admin.html`，密碼 `8899`）：
  - Session 登入保護所有後台 API
  - 廠商管理：新增 / 改名 / 刪除（有交易紀錄不可刪除）/ 調整餘額（可加可減，不受前台限制）
  - 扣款紀錄表格
  - 每日統計表格（依 Asia/Taipei 分日）
  - 兩顆「匯出 Excel」按鈕，各自下載獨立 `.xlsx` 檔案

## 安裝與啟動

> ⚠️ 這個專案需要在**你自己有網路連線的電腦**上執行 `npm install`（本沙盒環境沒有對外網路，所以只完成了程式碼撰寫與語法檢查，尚未實際安裝套件執行測試）。

```bash
# 1. 進入專案資料夾
cd gas-station-system

# 2. 安裝套件
npm install

# 3. 啟動伺服器
npm start
```

啟動後：

- 前台：http://localhost:3000/
- 後台：http://localhost:3000/admin.html （密碼：`8899`）

第一次啟動時會自動建立 `gas_station.db`（SQLite 檔案），並自動建立廠商 A、B、C、D（各 NT$100,000）與管理員帳號。

## 專案結構

```
gas-station-system/
├── server.js              # Express 後端主程式（所有 API + 資料庫邏輯）
├── package.json
├── gas_station.db         # 執行後自動產生（SQLite 資料庫）
└── public/
    ├── index.html          # 前台頁面
    ├── style.css
    ├── app.js
    ├── admin.html          # 後台頁面（含登入畫面）
    ├── admin.css
    └── admin.js
```

## API 一覽

### 前台（無需登入）
| Method | Path | 說明 |
|---|---|---|
| GET | `/api/vendors` | 取得所有廠商餘額 |
| POST | `/api/deduct` | 扣款 `{ vendor_id, amount }` |

### 後台（需先登入，session 驗證）
| Method | Path | 說明 |
|---|---|---|
| POST | `/api/admin/login` | 登入 `{ password: "8899" }` |
| POST | `/api/admin/logout` | 登出 |
| GET | `/api/admin/session` | 檢查登入狀態 |
| GET | `/api/admin/vendors` | 廠商列表 |
| POST | `/api/admin/vendors` | 新增廠商 `{ name, initial_balance? }` |
| PUT | `/api/admin/vendors/:id` | 改名 `{ name }` |
| DELETE | `/api/admin/vendors/:id` | 刪除（有交易紀錄則拒絕） |
| POST | `/api/admin/vendors/:id/adjust` | 調整餘額 `{ amount }`（正負皆可） |
| GET | `/api/admin/transactions` | 扣款紀錄列表 |
| GET | `/api/admin/daily-stats` | 每日統計（依 Asia/Taipei） |
| GET | `/api/admin/export/transactions` | 下載扣款紀錄 `.xlsx` |
| GET | `/api/admin/export/daily-stats` | 下載每日統計 `.xlsx` |

## 業務規則實作重點

- 所有金額檢查（`amount <= 0`、`amount > balance`）都在後端 `server.js` 中強制執行，前端只是輔助提示。
- 時間一律使用 `Asia/Taipei`（透過 `Intl`/`toLocaleString('sv-SE', {timeZone:'Asia/Taipei'})`，未使用 UTC 或任何第三方時區套件）。
- 每日統計以 `created_at` 字串前 10 碼（`YYYY-MM-DD`）分組，僅計算 `type = 'deduct'` 的扣款金額。
- 廠商刪除前會檢查 `transactions` 表是否有該廠商的任何紀錄（扣款或後台調整皆算），有紀錄則拒絕刪除。
- 兩個匯出功能各自產生獨立的 `.xlsx` 檔案（不是同一個活頁簿裡的兩個分頁）。

## 可自行調整的設定（`server.js` 最上方）

```js
const LOW_BALANCE_THRESHOLD = 20000; // 餘額警示門檻
const ADMIN_PASSWORD = '8899';       // 後台密碼
const INITIAL_BALANCE = 100000;      // 廠商初始餘額
```

## 部署備註

- `express-session` 目前使用預設的記憶體 session store，僅適合單機開發/展示用途。若要正式上線多人使用，建議改用 `connect-sqlite3` 或 Redis 作為 session store。
- `session.secret` 請在正式環境中換成隨機且保密的字串。
