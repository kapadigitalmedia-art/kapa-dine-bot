// KAPA ONE Dine - MySQL Database Module (Railway, shared instance, dine_ prefixed tables)
const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || "hayabusa.proxy.rlwy.net",
  port: process.env.MYSQL_PORT || 42047,
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD || "xtbFTXXxbRkKXdOOpNnwXBvkFHaBShjr",
  database: process.env.MYSQL_DATABASE || "railway",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 10000,
  timezone: "+08:00"
});

pool.getConnection().then(conn => {
  console.log("✅ MySQL connected (Dine)");
  conn.release();
}).catch(err => {
  console.error("❌ MySQL connection error (Dine):", err.message);
});

// ── COMPANY ─────────────────────────────────────────────────────────
async function getCompany(company_id) {
  try {
    var [rows] = await pool.execute("SELECT * FROM dine_companies WHERE company_id=?", [company_id]);
    return rows[0] || null;
  } catch(err) { console.error("getCompany:", err.message); return null; }
}

async function upsertCompany(data) {
  try {
    await pool.execute(
      "INSERT INTO dine_companies (company_name, plan_type, whatsapp_number, owner_whatsapp, company_id) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE company_name=VALUES(company_name), plan_type=VALUES(plan_type), whatsapp_number=VALUES(whatsapp_number), owner_whatsapp=VALUES(owner_whatsapp)",
      [data.company_name, data.plan_type || "restaurant", data.whatsapp_number || null, data.owner_whatsapp || null, data.company_id]
    );
    return true;
  } catch(err) { console.error("upsertCompany:", err.message); return false; }
}

async function updateCompanyPlan(company_id, plan_type) {
  try {
    await pool.execute("UPDATE dine_companies SET plan_type=? WHERE company_id=?", [plan_type, company_id]);
    return true;
  } catch(err) { console.error("updateCompanyPlan:", err.message); return false; }
}

// ── ADD-ONS ─────────────────────────────────────────────────────────
async function getAddons(company_id) {
  try {
    var [rows] = await pool.execute("SELECT * FROM dine_addons WHERE company_id=?", [company_id]);
    return rows;
  } catch(err) { console.error("getAddons:", err.message); return []; }
}

async function upsertAddon(company_id, addon_key, is_active, monthly_price) {
  try {
    await pool.execute(
      "INSERT INTO dine_addons (company_id, addon_key, is_active, activated_at, monthly_price) VALUES (?,?,?,?,?) " +
      "ON DUPLICATE KEY UPDATE is_active=VALUES(is_active), activated_at=IF(VALUES(is_active)=1, NOW(), activated_at), monthly_price=VALUES(monthly_price)",
      [company_id, addon_key, is_active ? 1 : 0, is_active ? new Date() : null, monthly_price]
    );
    return true;
  } catch(err) { console.error("upsertAddon:", err.message); return false; }
}

// ── EMPLOYEES ───────────────────────────────────────────────────────
async function getAllActiveEmployees(company_id) {
  try {
    var [rows] = await pool.execute("SELECT * FROM dine_employees WHERE status='Active' AND company_id=? ORDER BY employee_name", [company_id]);
    return rows;
  } catch(err) { console.error("getAllActiveEmployees:", err.message); return []; }
}

async function upsertEmployee(data) {
  try {
    await pool.execute(
      "INSERT INTO dine_employees (company_id, employee_name, whatsapp_number, designation, status) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE employee_name=VALUES(employee_name), designation=VALUES(designation), status=VALUES(status)",
      [data.company_id, data.employee_name, data.whatsapp_number, data.designation || null, data.status || "Active"]
    );
    return true;
  } catch(err) { console.error("upsertEmployee:", err.message); return false; }
}

async function getAllEmployees(company_id) {
  try {
    var [rows] = await pool.execute("SELECT * FROM dine_employees WHERE company_id=? ORDER BY employee_name", [company_id]);
    return rows;
  } catch(err) { console.error("getAllEmployees:", err.message); return []; }
}

// ── ATTENDANCE ──────────────────────────────────────────────────────
async function getAttendanceByDate(company_id, date) {
  try {
    var [rows] = await pool.execute(
      "SELECT a.*, e.designation FROM dine_attendance a LEFT JOIN dine_employees e ON a.whatsapp_number = e.whatsapp_number WHERE a.company_id=? AND a.date=? ORDER BY a.check_in_time",
      [company_id, date]
    );
    return rows;
  } catch(err) { console.error("getAttendanceByDate:", err.message); return []; }
}

async function createAttendance(data) {
  try {
    await pool.execute(
      "INSERT INTO dine_attendance (company_id, employee_name, whatsapp_number, date, check_in_time, check_out_time, status) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE check_in_time=VALUES(check_in_time), check_out_time=VALUES(check_out_time), status=VALUES(status)",
      [data.company_id, data.employee_name, data.whatsapp_number, data.date, data.check_in_time || null, data.check_out_time || null, data.status || "Present"]
    );
    return true;
  } catch(err) { console.error("createAttendance:", err.message); return false; }
}

// ── DAILY SALES ─────────────────────────────────────────────────────
async function getDailySalesByDate(company_id, date) {
  try {
    var [rows] = await pool.execute("SELECT *, DATE_FORMAT(date,'%Y-%m-%d') as date FROM dine_daily_sales WHERE company_id=? AND date=?", [company_id, date]);
    return rows;
  } catch(err) { console.error("getDailySalesByDate:", err.message); return []; }
}

async function createDailySales(data) {
  try {
    await pool.execute(
      "INSERT INTO dine_daily_sales (company_id, date, total_sales, cash_amount, card_amount, online_amount, grabfood_amount, total_bills, submitted_by) VALUES (?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE total_sales=VALUES(total_sales), cash_amount=VALUES(cash_amount), card_amount=VALUES(card_amount), online_amount=VALUES(online_amount), grabfood_amount=VALUES(grabfood_amount), total_bills=VALUES(total_bills), submitted_by=VALUES(submitted_by)",
      [data.company_id, data.date, data.total_sales || 0, data.cash_amount || 0, data.card_amount || 0, data.online_amount || 0, data.grabfood_amount || 0, data.total_bills || 0, data.submitted_by || null]
    );
    return true;
  } catch(err) { console.error("createDailySales:", err.message); return false; }
}

// ── INVENTORY ───────────────────────────────────────────────────────
async function getInventory(company_id) {
  try {
    var [rows] = await pool.execute("SELECT * FROM dine_inventory WHERE company_id=? ORDER BY category, item_name", [company_id]);
    return rows;
  } catch(err) { console.error("getInventory:", err.message); return []; }
}

async function createInventoryItem(data) {
  try {
    var [result] = await pool.execute(
      "INSERT INTO dine_inventory (company_id, item_name, category, current_stock, minimum_stock, unit) VALUES (?,?,?,?,?,?)",
      [data.company_id, data.item_name, data.category || null, data.current_stock || 0, data.minimum_stock || 0, data.unit || null]
    );
    return result.insertId;
  } catch(err) { console.error("createInventoryItem:", err.message); return null; }
}

// ── PURCHASES ───────────────────────────────────────────────────────
async function getPurchasesByDate(company_id, date) {
  try {
    var [rows] = await pool.execute("SELECT *, DATE_FORMAT(date,'%Y-%m-%d') as date FROM dine_purchases WHERE company_id=? AND date=? ORDER BY created_at DESC", [company_id, date]);
    return rows;
  } catch(err) { console.error("getPurchasesByDate:", err.message); return []; }
}

async function createPurchase(data) {
  try {
    var [result] = await pool.execute(
      "INSERT INTO dine_purchases (company_id, item_name, supplier_name, quantity, unit, unit_price, total_amount, date, submitted_by, status) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [data.company_id, data.item_name, data.supplier_name || null, data.quantity || 0, data.unit || null, data.unit_price || 0, data.total_amount || 0, data.date, data.submitted_by || null, data.status || "Pending"]
    );
    return result.insertId;
  } catch(err) { console.error("createPurchase:", err.message); return null; }
}

// ── LEAVE REQUESTS ──────────────────────────────────────────────────
async function getLeaveRequests(company_id) {
  try {
    var [rows] = await pool.execute(
      "SELECT *, DATE_FORMAT(start_date,'%Y-%m-%d') as start_date, DATE_FORMAT(end_date,'%Y-%m-%d') as end_date FROM dine_leave_requests WHERE company_id=? ORDER BY start_date DESC",
      [company_id]
    );
    return rows;
  } catch(err) { console.error("getLeaveRequests:", err.message); return []; }
}

async function createLeaveRequest(data) {
  try {
    var [result] = await pool.execute(
      "INSERT INTO dine_leave_requests (company_id, employee_name, whatsapp_number, leave_type, start_date, end_date, reason, status) VALUES (?,?,?,?,?,?,?,?)",
      [data.company_id, data.employee_name, data.whatsapp_number, data.leave_type || null, data.start_date, data.end_date, data.reason || null, data.status || "Pending"]
    );
    return result.insertId;
  } catch(err) { console.error("createLeaveRequest:", err.message); return null; }
}

// ── MENU ────────────────────────────────────────────────────────────
async function getMenu(company_id) {
  try {
    var [rows] = await pool.execute("SELECT * FROM dine_menu_items WHERE company_id=? ORDER BY category, item_name", [company_id]);
    return rows;
  } catch(err) { console.error("getMenu:", err.message); return []; }
}

async function createMenuItem(data) {
  try {
    var [result] = await pool.execute(
      "INSERT INTO dine_menu_items (company_id, item_name, category, price, is_available, image_url) VALUES (?,?,?,?,?,?)",
      [data.company_id, data.item_name, data.category || null, data.price || 0, data.is_available === false ? 0 : 1, data.image_url || null]
    );
    return result.insertId;
  } catch(err) { console.error("createMenuItem:", err.message); return null; }
}

async function updateMenuItem(id, data, company_id) {
  try {
    await pool.execute(
      "UPDATE dine_menu_items SET item_name=?, category=?, price=?, is_available=?, image_url=? WHERE id=? AND company_id=?",
      [data.item_name, data.category || null, data.price || 0, data.is_available === false ? 0 : 1, data.image_url || null, id, company_id]
    );
    return true;
  } catch(err) { console.error("updateMenuItem:", err.message); return false; }
}

async function deleteMenuItem(id, company_id) {
  try {
    await pool.execute("DELETE FROM dine_menu_items WHERE id=? AND company_id=?", [id, company_id]);
    return true;
  } catch(err) { console.error("deleteMenuItem:", err.message); return false; }
}

// ── ORDERS ──────────────────────────────────────────────────────────
async function createOrder(data) {
  try {
    var [result] = await pool.execute(
      "INSERT INTO dine_orders (company_id, table_number, order_type, items, subtotal, tax, total, payment_method, status) VALUES (?,?,?,?,?,?,?,?,?)",
      [
        data.company_id,
        data.table_number || null,
        data.order_type || "Dine-in",
        JSON.stringify(data.items || []),
        data.subtotal || 0,
        data.tax || 0,
        data.total || 0,
        data.payment_method || null,
        data.status || "Open",
      ]
    );
    var orderId = result.insertId;
    var items = data.items || [];
    for (var i = 0; i < items.length; i++) {
      await pool.execute(
        "INSERT INTO dine_order_items (order_id, item_name, quantity, price, notes) VALUES (?,?,?,?,?)",
        [orderId, items[i].name, items[i].qty || 1, items[i].price || 0, items[i].notes || null]
      );
    }
    return orderId;
  } catch(err) { console.error("createOrder:", err.message); return null; }
}

async function getOrderById(id, company_id) {
  try {
    var [rows] = await pool.execute("SELECT * FROM dine_orders WHERE id=? AND company_id=?", [id, company_id]);
    return rows[0] || null;
  } catch(err) { console.error("getOrderById:", err.message); return null; }
}

async function getTodayOrders(company_id) {
  try {
    var [rows] = await pool.execute(
      "SELECT * FROM dine_orders WHERE company_id=? AND DATE(created_at)=CURDATE() ORDER BY created_at DESC",
      [company_id]
    );
    return rows;
  } catch(err) { console.error("getTodayOrders:", err.message); return []; }
}

async function updateOrderStatus(id, status, company_id) {
  try {
    await pool.execute("UPDATE dine_orders SET status=? WHERE id=? AND company_id=?", [status, id, company_id]);
    return true;
  } catch(err) { console.error("updateOrderStatus:", err.message); return false; }
}

async function getOccupiedTables(company_id) {
  try {
    var [rows] = await pool.execute(
      "SELECT table_number, id as order_id, status, total, created_at FROM dine_orders WHERE company_id=? AND table_number IS NOT NULL AND status NOT IN ('Paid','Cancelled') ORDER BY table_number",
      [company_id]
    );
    return rows;
  } catch(err) { console.error("getOccupiedTables:", err.message); return []; }
}

module.exports = {
  pool,
  getCompany,
  upsertCompany,
  getAllActiveEmployees,
  upsertEmployee,
  getAllEmployees,
  getAttendanceByDate,
  createAttendance,
  getDailySalesByDate,
  createDailySales,
  getInventory,
  createInventoryItem,
  getPurchasesByDate,
  createPurchase,
  getLeaveRequests,
  createLeaveRequest,
  getMenu,
  createMenuItem,
  updateMenuItem,
  deleteMenuItem,
  createOrder,
  getOrderById,
  getTodayOrders,
  updateOrderStatus,
  getOccupiedTables,
  updateCompanyPlan,
  getAddons,
  upsertAddon,
};
