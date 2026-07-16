// KAPA ONE Dine - Hub API
const express = require("express");
const router = express.Router();
const axios = require("axios");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const DB = require("./db");
require("dotenv").config();

const JWT_SECRET   = process.env.JWT_SECRET || "kapa_dine_secret_2026";

// This bot instance serves Ritz Restaurant only (Plan 2 - dedicated number);
// hardcode its MySQL company_id until this bot supports multiple tenants.
const DINE_COMPANY_ID = "dine_ritz_001";
const DINE_TABLES = ["Table 1","Table 2","Table 3","Table 4","Table 5"];

// ── MODELS ─────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  company_id:   { type: String, required: true },
  full_name:    { type: String, required: true },
  email:        { type: String, required: true, unique: true },
  password:     { type: String, required: true },
  role:         { type: String, default: "staff" },
  is_active:    { type: Boolean, default: true },
  last_login:   { type: Date, default: null },
  created_at:   { type: Date, default: Date.now },
  updated_at:   { type: Date, default: Date.now }
});
const User = mongoose.models.DineUser || mongoose.model("DineUser", userSchema);

const companySchema = new mongoose.Schema({
  company_name:  { type: String, required: true },
  zoho_owner:    { type: String, default: "kapadigitalmedia" },
  zoho_app:      { type: String, required: true },
  is_active:     { type: Boolean, default: true },
  created_at:    { type: Date, default: Date.now }
});
const Company = mongoose.models.DineCompany || mongoose.model("DineCompany", companySchema);

// ── AUTH MIDDLEWARE ─────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  var auth = req.headers.authorization || "";
  var token = auth.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    var decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch(e) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// ── HELPERS ────────────────────────────────────────────────────────
function todayDate() {
  var now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur" }));
  return now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
}

// ── AUTH ROUTES ────────────────────────────────────────────────────
router.post("/login", async function(req, res) {
  try {
    var { email, password } = req.body;
    var user = await User.findOne({ email: email, is_active: true });
    if (!user) return res.status(401).json({ error: "Invalid email or password" });
    var match = await bcrypt.compare(password, user.password).catch(function() {
      return password === user.password;
    });
    if (!match) return res.status(401).json({ error: "Invalid email or password" });
    user.last_login = new Date();
    await user.save();
    var company = await Company.findById(user.company_id);
    var token = jwt.sign({ userId: user._id, companyId: user.company_id, role: user.role }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ success: true, token: token, user: { _id: user._id, full_name: user.full_name, email: user.email, role: user.role, company_id: user.company_id }, company: company });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.get("/login/verify", authMiddleware, async function(req, res) {
  try {
    var user = await User.findOne({ _id: req.user.userId, is_active: true });
    if (!user) return res.status(401).json({ error: "Invalid token" });
    var company = await Company.findById(user.company_id);
    res.json({ success: true, user: { _id: user._id, full_name: user.full_name, email: user.email, role: user.role, company_id: user.company_id }, company: company });
  } catch(err) { res.status(401).json({ error: "Invalid token" }); }
});

router.post("/companies", async function(req, res) {
  try {
    var company = new Company(req.body);
    await company.save();
    res.json({ success: true, company });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.post("/companies/:company_id/users", async function(req, res) {
  try {
    var { email, password, full_name, role } = req.body;
    var hashedPass = await bcrypt.hash(password, 10).catch(function() { return password; });
    var user = new User({ company_id: req.params.company_id, email, password: hashedPass, full_name: full_name || email, role: role || "owner" });
    await user.save();
    res.json({ success: true, user: { _id: user._id, email: user.email, full_name: user.full_name, role: user.role } });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── STAFF / EMPLOYEES ──────────────────────────────────────────────
router.get("/companies/:company_id/zoho-employees", authMiddleware, async function(req, res) {
  try {
    var data = await DB.getAllEmployees(DINE_COMPANY_ID);
    res.json({ success: true, data: data });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── ATTENDANCE ─────────────────────────────────────────────────────
router.get("/companies/:company_id/attendance", authMiddleware, async function(req, res) {
  try {
    var date = req.query.date || todayDate();
    var data = await DB.getAttendanceByDate(DINE_COMPANY_ID, date);
    res.json({ success: true, data: data });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── DAILY SALES ────────────────────────────────────────────────────
router.get("/companies/:company_id/daily-sales", authMiddleware, async function(req, res) {
  try {
    var date = req.query.date || todayDate();
    var data = await DB.getDailySalesByDate(DINE_COMPANY_ID, date);
    res.json({ success: true, data: data });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── INVENTORY ──────────────────────────────────────────────────────
router.get("/companies/:company_id/inventory", authMiddleware, async function(req, res) {
  try {
    var data = await DB.getInventory(DINE_COMPANY_ID);
    res.json({ success: true, data: data });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── PURCHASES ──────────────────────────────────────────────────────
router.get("/companies/:company_id/purchases", authMiddleware, async function(req, res) {
  try {
    var date = req.query.date || todayDate();
    var data = await DB.getPurchasesByDate(DINE_COMPANY_ID, date);
    res.json({ success: true, data: data });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── LEAVE REQUESTS ─────────────────────────────────────────────────
router.get("/companies/:company_id/leave-requests", authMiddleware, async function(req, res) {
  try {
    var data = await DB.getLeaveRequests(DINE_COMPANY_ID);
    res.json({ success: true, data: data });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── WHATSAPP HELPER ─────────────────────────────────────────────────
async function sendWhatsAppMessage(to, text) {
  try {
    if (!to || !text) return;
    await axios.post(
      "https://graph.facebook.com/v18.0/" + process.env.PHONE_NUMBER_ID + "/messages",
      { messaging_product: "whatsapp", to: to, type: "text", text: { body: String(text) } },
      { headers: { Authorization: "Bearer " + process.env.WHATSAPP_TOKEN, "Content-Type": "application/json" } }
    );
  } catch (err) { console.error("❌ sendWhatsAppMessage:", err.response ? JSON.stringify(err.response.data) : err.message); }
}

// ── PLAN / ADD-ONS (package switcher demo) ────────────────────────────
const PLAN_PRICING = {
  mamak:      { monthly: 249, setup: 2499 },
  restaurant: { monthly: 499, setup: 3999 },
  foodcourt:  { monthly: 899, setup: 5999 },
};
const ADDON_CATALOG = {
  whatsapp_ordering:     { name: "WhatsApp Online Ordering",    icon: "📱", price: 99,  desc: "Let customers order directly via WhatsApp chat" },
  receipt_printer:       { name: "Receipt Printer Integration", icon: "🖨️", price: 49,  desc: "Auto-print receipts and kitchen tickets" },
  advanced_analytics:    { name: "Advanced Analytics",          icon: "📊", price: 79,  desc: "Deep sales trends, peak hours, and item performance reports" },
  customer_website:      { name: "Customer Website with Menu",  icon: "🌐", price: 149, desc: "Branded public menu website for your restaurant" },
  online_payment:        { name: "Online Payment (FPX/Card)",   icon: "💳", price: 99,  desc: "Accept FPX and card payments online" },
  supplier_management:   { name: "Supplier Management",         icon: "📦", price: 69,  desc: "Track suppliers, orders, and delivery schedules" },
  loyalty_program:       { name: "Loyalty Program",              icon: "👥", price: 89,  desc: "Points and rewards to keep customers coming back" },
  delivery_management:   { name: "Delivery Management",          icon: "🚗", price: 119, desc: "Assign riders and track delivery orders" },
  digital_menu_board:    { name: "Digital Menu Board",            icon: "📸", price: 59,  desc: "Display your menu on a TV or tablet screen" },
  staff_whatsapp_alerts: { name: "Staff WhatsApp Alerts",         icon: "🔔", price: 39,  desc: "Notify staff instantly about shifts and tasks via WhatsApp" },
};

router.get("/dine/settings", authMiddleware, async function(req, res) {
  try {
    var company = await DB.getCompany(DINE_COMPANY_ID);
    var addonRows = await DB.getAddons(DINE_COMPANY_ID);
    var addonByKey = {};
    addonRows.forEach(function(a) { addonByKey[a.addon_key] = a; });
    var addons = Object.keys(ADDON_CATALOG).map(function(key) {
      var cat = ADDON_CATALOG[key];
      var row = addonByKey[key];
      return { key: key, name: cat.name, icon: cat.icon, description: cat.desc, monthly_price: cat.price, is_active: !!(row && row.is_active), activated_at: row ? row.activated_at : null };
    });
    var plan = (company && company.plan_type) || "restaurant";
    res.json({ success: true, plan: plan, pricing: PLAN_PRICING, addons: addons });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put("/dine/settings/plan", authMiddleware, async function(req, res) {
  try {
    var plan = req.body.plan;
    if (["mamak", "restaurant", "foodcourt"].indexOf(plan) === -1) return res.status(400).json({ error: "plan must be 'mamak', 'restaurant', or 'foodcourt'" });
    var ok = await DB.updateCompanyPlan(DINE_COMPANY_ID, plan);
    if (!ok) return res.status(500).json({ error: "Could not update plan" });
    res.json({ success: true, plan: plan });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put("/dine/settings/addons", authMiddleware, async function(req, res) {
  try {
    var key = req.body.addon_key;
    var isActive = !!req.body.is_active;
    if (!ADDON_CATALOG[key]) return res.status(400).json({ error: "Unknown addon_key" });
    var ok = await DB.upsertAddon(DINE_COMPANY_ID, key, isActive, ADDON_CATALOG[key].price);
    if (!ok) return res.status(500).json({ error: "Could not update addon" });
    res.json({ success: true, addon_key: key, is_active: isActive });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POS: MENU ────────────────────────────────────────────────────────
router.get("/dine/menu", authMiddleware, async function(req, res) {
  try {
    var items = await DB.getMenu(DINE_COMPANY_ID);
    res.json({ success: true, data: items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/dine/menu", authMiddleware, async function(req, res) {
  try {
    if (!req.body.item_name || !req.body.category) return res.status(400).json({ error: "item_name and category are required" });
    var id = await DB.createMenuItem(Object.assign({}, req.body, { company_id: DINE_COMPANY_ID }));
    if (!id) return res.status(500).json({ error: "Could not create menu item" });
    res.json({ success: true, id: id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put("/dine/menu/:id", authMiddleware, async function(req, res) {
  try {
    if (!req.body.item_name || !req.body.category) return res.status(400).json({ error: "item_name and category are required" });
    var ok = await DB.updateMenuItem(req.params.id, req.body, DINE_COMPANY_ID);
    if (!ok) return res.status(500).json({ error: "Could not update menu item" });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete("/dine/menu/:id", authMiddleware, async function(req, res) {
  try {
    var ok = await DB.deleteMenuItem(req.params.id, DINE_COMPANY_ID);
    if (!ok) return res.status(500).json({ error: "Could not delete menu item" });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POS: ORDERS ─────────────────────────────────────────────────────
router.post("/dine/orders", authMiddleware, async function(req, res) {
  try {
    var orderId = await DB.createOrder(Object.assign({}, req.body, { company_id: DINE_COMPANY_ID }));
    if (!orderId) return res.status(500).json({ error: "Could not create order" });
    res.json({ success: true, order_id: orderId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/dine/orders", authMiddleware, async function(req, res) {
  try {
    var orders = await DB.getTodayOrders(DINE_COMPANY_ID);
    res.json({ success: true, data: orders });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put("/dine/orders/:id/status", authMiddleware, async function(req, res) {
  try {
    var ok = await DB.updateOrderStatus(req.params.id, req.body.status, DINE_COMPANY_ID);
    if (!ok) return res.status(500).json({ error: "Could not update order status" });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POS: TABLES ─────────────────────────────────────────────────────
router.get("/dine/tables", authMiddleware, async function(req, res) {
  try {
    var occupied = await DB.getOccupiedTables(DINE_COMPANY_ID);
    var byTable = {};
    occupied.forEach(function(o) { if (!byTable[o.table_number]) byTable[o.table_number] = o; });
    var tables = DINE_TABLES.map(function(t) {
      var o = byTable[t];
      return o
        ? { table_number: t, status: "Occupied", order_id: o.order_id, total: o.total, order_status: o.status }
        : { table_number: t, status: "Available" };
    });
    res.json({ success: true, data: tables });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POS: KOT (place order + save + notify kitchen) ─────────────────
router.post("/pos/kot", authMiddleware, async function(req, res) {
  try {
    var order = req.body.order || req.body;
    var items = order.items || [];
    if (!items.length) return res.status(400).json({ error: "Order has no items" });

    var orderId = await DB.createOrder({
      company_id: DINE_COMPANY_ID,
      table_number: order.table || order.table_number || null,
      order_type: (order.table === "Takeaway" || order.table_number === "Takeaway") ? "Takeaway" : "Dine-in",
      items: items,
      subtotal: order.subtotal || 0,
      tax: order.tax || 0,
      total: order.total || 0,
      payment_method: order.payment || order.payment_method || null,
      status: "KOT Sent",
    });
    if (!orderId) return res.status(500).json({ error: "Could not save order" });

    var kotMsg = req.body.message;
    if (!kotMsg) {
      var now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur" }));
      var h12 = now.getHours() % 12 || 12;
      var timeStr = String(h12).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0") + " " + (now.getHours() >= 12 ? "PM" : "AM");
      kotMsg = "🍳 *New Order - Table " + (order.table || order.table_number || "-") + "*\n📋 *Order #" + orderId + "*\n⏰ *Time:* " + timeStr + "\n\nItems:\n";
      items.forEach(function(i) { kotMsg += "• " + i.name + " × " + i.qty + "\n"; });
      kotMsg += "\n💰 *Total:* RM " + parseFloat(order.total || 0).toFixed(2);
      if (order.notes) kotMsg += "\n📝 *Notes:* " + order.notes;
    }

    // Demo: always routes to the owner's WhatsApp (kitchen_whatsapp/owner_whatsapp on
    // dine_companies). A real deployment would route to the kitchen's own WhatsApp number.
    var company = await DB.getCompany(DINE_COMPANY_ID);
    var kitchenNumber = company ? (company.kitchen_whatsapp || company.owner_whatsapp) : null;
    await sendWhatsAppMessage(kitchenNumber, kotMsg);

    res.json({ success: true, order_id: orderId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
