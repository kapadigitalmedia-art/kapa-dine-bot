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
      "INSERT INTO dine_menu_items (company_id, item_name, category, price, is_available) VALUES (?,?,?,?,?)",
      [data.company_id, data.item_name, data.category || null, data.price || 0, data.is_available === false ? 0 : 1]
    );
    return result.insertId;
  } catch(err) { console.error("createMenuItem:", err.message); return null; }
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
  getMenu,
  createMenuItem,
  createOrder,
  getOrderById,
  getTodayOrders,
  updateOrderStatus,
  getOccupiedTables,
};
