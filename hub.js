// KAPA ONE Dine - Hub API
const express = require("express");
const router = express.Router();
const axios = require("axios");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const ZOHO_CREATOR = "https://creatorapp.zoho.in/api/v2";
const ZOHO_OWNER   = process.env.ZOHO_OWNER;
const ZOHO_APP     = process.env.ZOHO_APP;
const JWT_SECRET   = process.env.JWT_SECRET || "kapa_dine_secret_2026";
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

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

// ── ZOHO TOKEN ─────────────────────────────────────────────────────
var zohoToken = null;
var zohoTokenTime = 0;
async function getZohoToken() {
  if (zohoToken && Date.now() < zohoTokenTime) return zohoToken;
  var r = await axios.post("https://accounts.zoho.in/oauth/v2/token", null, {
    params: {
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id:     process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type:    "refresh_token"
    }
  });
  zohoToken = r.data.access_token;
  zohoTokenTime = Date.now() + (55 * 60 * 1000);
  console.log("Hub Zoho token refreshed");
  return zohoToken;
}

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
function formatZohoDate(d) {
  var dt = new Date(d);
  return String(dt.getDate()).padStart(2,"0") + "-" + MONTHS[dt.getMonth()] + "-" + dt.getFullYear();
}

async function zohoGet(report, params) {
  var token = await getZohoToken();
  var res = await axios.get(ZOHO_CREATOR + "/" + ZOHO_OWNER + "/" + ZOHO_APP + "/report/" + report, {
    headers: { Authorization: "Zoho-oauthtoken " + token },
    params: params || {}
  });
  return res.data.data || [];
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
    var data = await zohoGet("All_Staff");
    res.json({ success: true, data: data });
  } catch(err) {
    if (err.response && err.response.status === 404) return res.json({ success: true, data: [] });
    res.status(500).json({ error: err.message });
  }
});

// ── ATTENDANCE ─────────────────────────────────────────────────────
router.get("/companies/:company_id/attendance", authMiddleware, async function(req, res) {
  try {
    var date = req.query.date || formatZohoDate(new Date());
    var data = await zohoGet("All_Attendances", { criteria: "attendance_date == \"" + date + "\"" });
    res.json({ success: true, data: data });
  } catch(err) {
    if (err.response && err.response.status === 404) return res.json({ success: true, data: [] });
    res.status(500).json({ error: err.message });
  }
});

// ── DAILY SALES ────────────────────────────────────────────────────
router.get("/companies/:company_id/daily-sales", authMiddleware, async function(req, res) {
  try {
    var date = req.query.date || formatZohoDate(new Date());
    var data = await zohoGet("All_Daily_Sales", { criteria: "sale_date == \"" + date + "\"" });
    res.json({ success: true, data: data });
  } catch(err) {
    if (err.response && err.response.status === 404) return res.json({ success: true, data: [] });
    res.status(500).json({ error: err.message });
  }
});

// ── INVENTORY ──────────────────────────────────────────────────────
router.get("/companies/:company_id/inventory", authMiddleware, async function(req, res) {
  try {
    var data = await zohoGet("All_Inventory");
    res.json({ success: true, data: data });
  } catch(err) {
    if (err.response && err.response.status === 404) return res.json({ success: true, data: [] });
    res.status(500).json({ error: err.message });
  }
});

// ── PURCHASES ──────────────────────────────────────────────────────
router.get("/companies/:company_id/purchases", authMiddleware, async function(req, res) {
  try {
    var date = req.query.date || formatZohoDate(new Date());
    var data = await zohoGet("All_Purchases", { criteria: "purchase_date == \"" + date + "\"" });
    res.json({ success: true, data: data });
  } catch(err) {
    if (err.response && err.response.status === 404) return res.json({ success: true, data: [] });
    res.status(500).json({ error: err.message });
  }
});

// ── LEAVE REQUESTS ─────────────────────────────────────────────────
router.get("/companies/:company_id/leave-requests", authMiddleware, async function(req, res) {
  try {
    var data = await zohoGet("All_Leave_Requests");
    res.json({ success: true, data: data });
  } catch(err) {
    if (err.response && err.response.status === 404) return res.json({ success: true, data: [] });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
