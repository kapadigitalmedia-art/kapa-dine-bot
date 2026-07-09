// KAPA ONE Dine - WhatsApp Bot for Restaurant Industry
const express = require("express");
const axios = require("axios");
const mongoose = require("mongoose");
const cron = require("node-cron");
require("dotenv").config();

const app = express();
app.use(express.json());
const hubRouter = require("./hub");
app.use("/hub", hubRouter);
app.use(require("express").static(__dirname));

// ── CONSTANTS ──────────────────────────────────────────────────────
const WHATSAPP_TOKEN  = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;
const ZOHO_CREATOR    = "https://creatorapp.zoho.in/api/v2";
const ZOHO_OWNER      = process.env.ZOHO_OWNER;
const ZOHO_APP        = process.env.ZOHO_APP;
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

var sessions = {};

// ── MONGODB ────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI).then(function() {
  console.log("MongoDB connected");
}).catch(function(err) {
  console.error("MongoDB error:", err.message);
});

// ── ZOHO TOKEN ─────────────────────────────────────────────────────
var zohoToken = null;
var zohoTokenTime = 0;
async function getZohoToken() {
  if (zohoToken && Date.now() < zohoTokenTime) return zohoToken;
  var r = await axios.post("https://accounts.zoho.in/oauth/v2/token", null, {
    params: {
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type: "refresh_token"
    }
  });
  zohoToken = r.data.access_token;
  zohoTokenTime = Date.now() + (55 * 60 * 1000);
  console.log("Zoho token refreshed");
  return zohoToken;
}

// ── HELPERS ────────────────────────────────────────────────────────
function formatZohoDate(d) {
  var dt = new Date(d);
  return String(dt.getDate()).padStart(2,"0") + "-" + MONTHS[dt.getMonth()] + "-" + dt.getFullYear();
}

function formatTime(t) {
  if (!t) return "-";
  var parts = String(t).split(":");
  var h = parseInt(parts[0]||0), m = parseInt(parts[1]||0);
  var ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return String(h).padStart(2,"0") + ":" + String(m).padStart(2,"0") + " " + ap;
}

async function sendMessage(to, text) {
  try {
    await axios.post("https://graph.facebook.com/v18.0/" + PHONE_NUMBER_ID + "/messages",
      { messaging_product: "whatsapp", to: to, type: "text", text: { body: String(text) } },
      { headers: { Authorization: "Bearer " + WHATSAPP_TOKEN, "Content-Type": "application/json" } }
    );
  } catch (err) { console.error("sendMessage error:", err.message); }
}

// ── STAFF FUNCTIONS ────────────────────────────────────────────────
var staffCache = null;
var staffCacheTime = 0;

async function getAllStaff() {
  if (staffCache && Date.now() < staffCacheTime) return staffCache;
  try {
    var token = await getZohoToken();
    var res = await axios.get(ZOHO_CREATOR + "/" + ZOHO_OWNER + "/" + ZOHO_APP + "/report/All_Staff", {
      headers: { Authorization: "Zoho-oauthtoken " + token }
    });
    staffCache = res.data.data || [];
    staffCacheTime = Date.now() + (30 * 60 * 1000);
    console.log("Staff fetched:", staffCache.length);
    return staffCache;
  } catch (err) {
    if (err.response && err.response.status === 404) return [];
    console.error("getAllStaff:", err.message);
    return staffCache || [];
  }
}

async function findStaff(number) {
  var staff = await getAllStaff();
  var clean = String(number).replace(/[\s\+\-]/g, "");
  return staff.find(function(s) {
    var sc = String(s.whatsapp_number || "").replace(/[\s\+\-]/g, "");
    return sc === clean || sc.endsWith(clean) || clean.endsWith(sc);
  }) || null;
}

function getStaffName(s) {
  var n = s.staff_name;
  if (typeof n === "object") return ((n.first_name || "") + " " + (n.last_name || "")).trim() || n.display_value || "Staff";
  return n || "Staff";
}

function isOwnerOrManager(s) {
  var des = String(s.designation || "").toLowerCase();
  return des === "owner" || des === "manager";
}

// ── ATTENDANCE FUNCTIONS ───────────────────────────────────────────
async function getTodayAttendance(staffId) {
  try {
    var token = await getZohoToken();
    var today = formatZohoDate(new Date());
    var res = await axios.get(ZOHO_CREATOR + "/" + ZOHO_OWNER + "/" + ZOHO_APP + "/report/All_Attendances", {
      headers: { Authorization: "Zoho-oauthtoken " + token },
      params: { criteria: "attendance_date == \"" + today + "\"" }
    });
    var records = res.data.data || [];
    return records.find(function(r) {
      var sid = typeof r.staff_name === "object" ? r.staff_name.ID : "";
      return sid === staffId;
    }) || null;
  } catch (err) {
    if (err.response && err.response.status === 404) return null;
    console.error("getTodayAttendance:", err.message);
    return null;
  }
}

async function createAttendance(staff, checkInTime) {
  try {
    var token = await getZohoToken();
    var today = formatZohoDate(new Date());
    var now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur" }));
    var lateMinutes = 0;
    var shiftParts = String(staff.shift_start || "08:00").split(":");
    var shiftMins = (parseInt(shiftParts[0]||8) * 60) + parseInt(shiftParts[1]||0);
    var nowMins = (now.getHours() * 60) + now.getMinutes();
    if (nowMins > shiftMins) lateMinutes = nowMins - shiftMins;
    var status = lateMinutes > 0 ? "Late" : "Present";
    await axios.post(ZOHO_CREATOR + "/" + ZOHO_OWNER + "/" + ZOHO_APP + "/form/Attendance",
      { data: { staff_name: staff.ID, whatsapp_number: staff.whatsapp_number, attendance_date: today, check_in_time: checkInTime, attendance_status: status, late_minutes: lateMinutes } },
      { headers: { Authorization: "Zoho-oauthtoken " + token, "Content-Type": "application/json" } }
    );
    console.log("Attendance created:", getStaffName(staff), "Status:", status);
    return { status: status, lateMinutes: lateMinutes };
  } catch (err) { console.error("createAttendance:", err.message); return null; }
}

async function updateCheckout(recordId) {
  try {
    var token = await getZohoToken();
    var now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur" }));
    var timeStr = String(now.getHours()).padStart(2,"0") + ":" + String(now.getMinutes()).padStart(2,"0");
    await axios.patch(ZOHO_CREATOR + "/" + ZOHO_OWNER + "/" + ZOHO_APP + "/report/All_Attendances/" + recordId,
      { data: { check_out_time: timeStr, attendance_status: "Present" } },
      { headers: { Authorization: "Zoho-oauthtoken " + token, "Content-Type": "application/json" } }
    );
    return timeStr;
  } catch (err) { console.error("updateCheckout:", err.message); return null; }
}

// ── INVENTORY FUNCTIONS ────────────────────────────────────────────
async function getLowStockItems() {
  try {
    var token = await getZohoToken();
    var res = await axios.get(ZOHO_CREATOR + "/" + ZOHO_OWNER + "/" + ZOHO_APP + "/report/All_Inventory", {
      headers: { Authorization: "Zoho-oauthtoken " + token }
    });
    var items = res.data.data || [];
    return items.filter(function(i) {
      return parseFloat(i.current_stock || 0) <= parseFloat(i.minimum_stock || 0);
    });
  } catch (err) {
    if (err.response && err.response.status === 404) return [];
    console.error("getLowStockItems:", err.message);
    return [];
  }
}

async function savePurchase(data) {
  try {
    var token = await getZohoToken();
    var today = formatZohoDate(new Date());
    await axios.post(ZOHO_CREATOR + "/" + ZOHO_OWNER + "/" + ZOHO_APP + "/form/Purchase",
      { data: { purchase_date: today, supplier_name: data.supplier, item_name: data.item, quantity: data.qty, unit: data.unit, unit_price: data.price, total_amount: data.total, submitted_by: data.submittedBy, category: data.category || "Other", status: "Pending" } },
      { headers: { Authorization: "Zoho-oauthtoken " + token, "Content-Type": "application/json" } }
    );
    console.log("Purchase saved:", data.item);
    return true;
  } catch (err) { console.error("savePurchase:", err.message); return false; }
}

// ── DAILY SALES FUNCTIONS ──────────────────────────────────────────
async function saveDailySales(data) {
  try {
    var token = await getZohoToken();
    var today = formatZohoDate(new Date());
    await axios.post(ZOHO_CREATOR + "/" + ZOHO_OWNER + "/" + ZOHO_APP + "/form/Daily_Sales",
      { data: { sale_date: today, total_sales: data.totalSales, total_bills: data.totalBills, cash_amount: data.cashAmount, card_amount: data.cardAmount, online_amount: data.onlineAmount, grabfood_amount: data.grabfoodAmount || 0, notes: data.notes || "", submitted_by: data.submittedBy } },
      { headers: { Authorization: "Zoho-oauthtoken " + token, "Content-Type": "application/json" } }
    );
    console.log("Daily sales saved");
    return true;
  } catch (err) { console.error("saveDailySales:", err.message); return false; }
}

async function getTodaySales() {
  try {
    var token = await getZohoToken();
    var today = formatZohoDate(new Date());
    var res = await axios.get(ZOHO_CREATOR + "/" + ZOHO_OWNER + "/" + ZOHO_APP + "/report/All_Daily_Sales", {
      headers: { Authorization: "Zoho-oauthtoken " + token },
      params: { criteria: "sale_date == \"" + today + "\"" }
    });
    var data = res.data.data || [];
    return data[0] || null;
  } catch (err) {
    if (err.response && err.response.status === 404) return null;
    console.error("getTodaySales:", err.message);
    return null;
  }
}

// ── MENU FUNCTIONS ─────────────────────────────────────────────────
async function sendMainMenu(to) {
  try {
    var staff = await findStaff(to);
    var name = staff ? getStaffName(staff) : "there";
    var now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur" }));
    var hr = now.getHours();
    var greeting = hr < 12 ? "Good Morning" : hr < 17 ? "Good Afternoon" : "Good Evening";
    var isManager = staff && isOwnerOrManager(staff);
    var btn3 = isManager
      ? { type: "reply", reply: { id: "dine_mgr_menu", title: "Management" } }
      : { type: "reply", reply: { id: "dine_more", title: "More Options" } };
    await axios.post("https://graph.facebook.com/v18.0/" + PHONE_NUMBER_ID + "/messages",
      { messaging_product: "whatsapp", to: to, type: "interactive", interactive: {
        type: "button",
        body: { text: "Welcome to KAPA ONE Dine\n\n" + greeting + ", " + name + "!\n\nPlease select an option:" },
        action: { buttons: [
          { type: "reply", reply: { id: "dine_checkin", title: "Check In" } },
          { type: "reply", reply: { id: "dine_checkout", title: "Check Out" } },
          btn3
        ]}
      }},
      { headers: { Authorization: "Bearer " + WHATSAPP_TOKEN, "Content-Type": "application/json" } }
    );
  } catch (err) { console.error("sendMainMenu:", err.message); }
}

async function sendManagerMenu(to) {
  try {
    await axios.post("https://graph.facebook.com/v18.0/" + PHONE_NUMBER_ID + "/messages",
      { messaging_product: "whatsapp", to: to, type: "interactive", interactive: {
        type: "list",
        body: { text: "Management Menu - Select an option:" },
        action: { button: "Select", sections: [{ title: "Management", rows: [
          { id: "dine_daily_sales", title: "Enter Daily Sales", description: "Submit today sales figures" },
          { id: "dine_inventory_check", title: "Inventory Check", description: "View low stock items" },
          { id: "dine_staff_status", title: "Staff Status", description: "View today attendance" },
          { id: "dine_purchase", title: "Record Purchase", description: "Submit purchase bill" }
        ]}]}
      }},
      { headers: { Authorization: "Bearer " + WHATSAPP_TOKEN, "Content-Type": "application/json" } }
    );
  } catch (err) { console.error("sendManagerMenu:", err.message); }
}

async function sendStaffMenu(to) {
  try {
    await axios.post("https://graph.facebook.com/v18.0/" + PHONE_NUMBER_ID + "/messages",
      { messaging_product: "whatsapp", to: to, type: "interactive", interactive: {
        type: "list",
        body: { text: "More Options - Select:" },
        action: { button: "Select", sections: [{ title: "Staff Options", rows: [
          { id: "dine_leave", title: "Apply Leave", description: "Request time off" },
          { id: "dine_report_stock", title: "Report Low Stock", description: "Report item running low" }
        ]}]}
      }},
      { headers: { Authorization: "Bearer " + WHATSAPP_TOKEN, "Content-Type": "application/json" } }
    );
  } catch (err) { console.error("sendStaffMenu:", err.message); }
}

// ── BUTTON HANDLER ─────────────────────────────────────────────────
async function handleButton(from, buttonId) {
  var staff = await findStaff(from);
  if (!staff) { sendMessage(from, "Your number is not registered. Please contact your manager."); return; }
  var staffName = getStaffName(staff);

  if (buttonId === "dine_checkin") {
    var existing = await getTodayAttendance(staff.ID);
    if (existing && existing.check_in_time) {
      sendMessage(from, "Already checked in today at " + formatTime(existing.check_in_time));
      return;
    }
    var now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur" }));
    var timeStr = String(now.getHours()).padStart(2,"0") + ":" + String(now.getMinutes()).padStart(2,"0");
    var result = await createAttendance(staff, timeStr);
    if (result) {
      var msg = "Check-In Successful!\n\nName: " + staffName + "\nTime: " + formatTime(timeStr);
      if (result.lateMinutes > 0) msg += "\nLate by: " + result.lateMinutes + " minutes";
      msg += "\n\nHave a great shift!";
      sendMessage(from, msg);
    } else {
      sendMessage(from, "Check-in failed. Please try again.");
    }
    return;
  }

  if (buttonId === "dine_checkout") {
    var existing2 = await getTodayAttendance(staff.ID);
    if (!existing2 || !existing2.check_in_time) {
      sendMessage(from, "You have not checked in today. Please check in first.");
      return;
    }
    if (existing2.check_out_time) {
      sendMessage(from, "Already checked out today at " + formatTime(existing2.check_out_time));
      return;
    }
    var checkoutTime = await updateCheckout(existing2.ID);
    if (checkoutTime) {
      sendMessage(from, "Check-Out Successful!\n\nName: " + staffName + "\nCheck-in: " + formatTime(existing2.check_in_time) + "\nCheck-out: " + formatTime(checkoutTime) + "\n\nThank you for your work today!");
    } else {
      sendMessage(from, "Check-out failed. Please try again.");
    }
    return;
  }

  if (buttonId === "dine_mgr_menu") { sendManagerMenu(from); return; }
  if (buttonId === "dine_more") { sendStaffMenu(from); return; }

  sendMainMenu(from);
}

// ── LIST HANDLER ───────────────────────────────────────────────────
async function handleList(from, listId) {
  var staff = await findStaff(from);
  var staffName = staff ? getStaffName(staff) : from;

  if (listId === "dine_daily_sales") {
    sessions[from] = { action: "dine_sales_total", staffName: staffName };
    sendMessage(from, "Daily Sales Entry\n\nEnter today total sales amount (RM):\n\nExample: 4250.50");
    return;
  }

  if (listId === "dine_staff_status") {
    var allStaff = await getAllStaff();
    var active = allStaff.filter(function(s) { return String(s.status || "").toLowerCase() === "active"; });
    var msg = "Active Staff: " + active.length + "\n\n";
    msg += active.map(function(s, i) { return (i+1) + ". " + getStaffName(s) + " (" + (s.designation || "") + ")"; }).join("\n");
    sendMessage(from, msg);
    return;
  }

  if (listId === "dine_inventory_check") {
    var lowStock = await getLowStockItems();
    if (!lowStock.length) {
      sendMessage(from, "All items are well stocked. No low stock alerts.");
    } else {
      var msg2 = "Low Stock Alert! " + lowStock.length + " items need restocking:\n\n";
      lowStock.forEach(function(item, i) {
        msg2 += (i+1) + ". " + (item.item_name || "Item") + " - Current: " + (item.current_stock || 0) + " " + (item.unit || "") + " (Min: " + (item.minimum_stock || 0) + ")\n";
      });
      sendMessage(from, msg2);
    }
    return;
  }

  if (listId === "dine_purchase") {
    sessions[from] = { action: "dine_purchase_item", staffName: staffName };
    sendMessage(from, "Record Purchase\n\nEnter item name:");
    return;
  }

  if (listId === "dine_report_stock") {
    sessions[from] = { action: "dine_stock_report", staffName: staffName };
    sendMessage(from, "Report Low Stock\n\nEnter item name and current quantity:\n\nExample: Rice - 5kg remaining");
    return;
  }

  if (listId === "dine_leave") {
    sessions[from] = { action: "dine_leave_type", staffName: staffName };
    sendMessage(from, "Apply Leave\n\nEnter leave type:\n1. Annual Leave\n2. Medical Leave\n3. Emergency Leave\n4. Unpaid Leave\n\nReply with the number:");
    return;
  }

  sendMainMenu(from);
}

// ── TEXT HANDLER ───────────────────────────────────────────────────
async function handleText(from, text) {
  var lower = text.toLowerCase().trim();
  if (["hi", "hello", "start"].indexOf(lower) !== -1) {
    delete sessions[from];
    sendMainMenu(from);
    return;
  }

  var session = sessions[from];

  // Daily Sales Flow
  if (session && session.action === "dine_sales_total") {
    var amount = parseFloat(text.trim());
    if (isNaN(amount)) { sendMessage(from, "Invalid amount. Enter a number like 4250.50"); return; }
    sessions[from] = { action: "dine_sales_bills", totalSales: amount, staffName: session.staffName };
    sendMessage(from, "Total Sales: RM " + amount.toFixed(2) + "\n\nHow many bills/receipts today?");
    return;
  }
  if (session && session.action === "dine_sales_bills") {
    var bills = parseInt(text.trim());
    if (isNaN(bills)) { sendMessage(from, "Invalid. Enter number of bills."); return; }
    sessions[from].totalBills = bills;
    sessions[from].action = "dine_sales_cash";
    sendMessage(from, "Bills: " + bills + "\n\nEnter cash amount (RM):");
    return;
  }
  if (session && session.action === "dine_sales_cash") {
    var cash = parseFloat(text.trim());
    if (isNaN(cash)) { sendMessage(from, "Invalid. Enter cash amount."); return; }
    sessions[from].cashAmount = cash;
    sessions[from].action = "dine_sales_card";
    sendMessage(from, "Cash: RM " + cash.toFixed(2) + "\n\nEnter card/online banking amount (RM):");
    return;
  }
  if (session && session.action === "dine_sales_card") {
    var card = parseFloat(text.trim());
    if (isNaN(card)) { sendMessage(from, "Invalid. Enter card amount."); return; }
    sessions[from].cardAmount = card;
    sessions[from].action = "dine_sales_online";
    sendMessage(from, "Card: RM " + card.toFixed(2) + "\n\nEnter QR/online payment amount (RM):");
    return;
  }
  if (session && session.action === "dine_sales_online") {
    var online = parseFloat(text.trim());
    if (isNaN(online)) { sendMessage(from, "Invalid. Enter online amount."); return; }
    sessions[from].onlineAmount = online;
    sessions[from].action = "dine_sales_grabfood";
    sendMessage(from, "Online: RM " + online.toFixed(2) + "\n\nEnter GrabFood/FoodPanda amount (RM):\n\nType 0 if none.");
    return;
  }
  if (session && session.action === "dine_sales_grabfood") {
    var grab = parseFloat(text.trim());
    if (isNaN(grab)) { sendMessage(from, "Invalid. Enter GrabFood amount or 0."); return; }
    sessions[from].grabfoodAmount = grab;
    sessions[from].action = "dine_sales_confirm";
    var s = sessions[from];
    var summary = "Daily Sales Summary:\n\n";
    summary += "Total Sales: RM " + s.totalSales.toFixed(2) + "\n";
    summary += "Total Bills: " + s.totalBills + "\n";
    summary += "Cash: RM " + s.cashAmount.toFixed(2) + "\n";
    summary += "Card: RM " + s.cardAmount.toFixed(2) + "\n";
    summary += "Online/QR: RM " + s.onlineAmount.toFixed(2) + "\n";
    summary += "GrabFood: RM " + grab.toFixed(2) + "\n";
    summary += "\nReply YES to confirm or NO to cancel.";
    sendMessage(from, summary);
    return;
  }
  if (session && session.action === "dine_sales_confirm") {
    if (text.trim().toUpperCase() === "YES") {
      var saved = await saveDailySales(sessions[from]);
      if (saved) {
        sendMessage(from, "Daily sales saved successfully!\n\nTotal: RM " + sessions[from].totalSales.toFixed(2) + "\n\nThank you!");
      } else {
        sendMessage(from, "Failed to save sales. Please try again.");
      }
    } else {
      sendMessage(from, "Sales entry cancelled.");
    }
    delete sessions[from];
    return;
  }

  // Purchase Flow
  if (session && session.action === "dine_purchase_item") {
    sessions[from].item = text.trim();
    sessions[from].action = "dine_purchase_supplier";
    sendMessage(from, "Item: " + text.trim() + "\n\nEnter supplier name:");
    return;
  }
  if (session && session.action === "dine_purchase_supplier") {
    sessions[from].supplier = text.trim();
    sessions[from].action = "dine_purchase_qty";
    sendMessage(from, "Supplier: " + text.trim() + "\n\nEnter quantity and unit:\n\nExample: 10 kg");
    return;
  }
  if (session && session.action === "dine_purchase_qty") {
    var parts2 = text.trim().split(" ");
    sessions[from].qty = parseFloat(parts2[0]) || 0;
    sessions[from].unit = parts2[1] || "pcs";
    sessions[from].action = "dine_purchase_price";
    sendMessage(from, "Quantity: " + sessions[from].qty + " " + sessions[from].unit + "\n\nEnter unit price (RM):");
    return;
  }
  if (session && session.action === "dine_purchase_price") {
    var price = parseFloat(text.trim());
    if (isNaN(price)) { sendMessage(from, "Invalid price. Enter a number."); return; }
    sessions[from].price = price;
    sessions[from].total = sessions[from].qty * price;
    sessions[from].action = "dine_purchase_confirm";
    var ps = sessions[from];
    sendMessage(from, "Purchase Summary:\n\nItem: " + ps.item + "\nSupplier: " + ps.supplier + "\nQty: " + ps.qty + " " + ps.unit + "\nUnit Price: RM " + price.toFixed(2) + "\nTotal: RM " + ps.total.toFixed(2) + "\n\nReply YES to confirm or NO to cancel.");
    return;
  }
  if (session && session.action === "dine_purchase_confirm") {
    if (text.trim().toUpperCase() === "YES") {
      var saved2 = await savePurchase(sessions[from]);
      if (saved2) {
        sendMessage(from, "Purchase recorded!\n\nItem: " + sessions[from].item + "\nTotal: RM " + sessions[from].total.toFixed(2) + "\n\nSent for approval.");
      } else {
        sendMessage(from, "Failed to save purchase. Please try again.");
      }
    } else {
      sendMessage(from, "Purchase entry cancelled.");
    }
    delete sessions[from];
    return;
  }

  // Stock Report Flow
  if (session && session.action === "dine_stock_report") {
    var staffObj = await findStaff(from);
    var mgrMsg = "Low Stock Report from " + (staffObj ? getStaffName(staffObj) : from) + ":\n\n" + text.trim();
    var allStaff2 = await getAllStaff();
    var managers = allStaff2.filter(function(s) { return isOwnerOrManager(s); });
    for (var i = 0; i < managers.length; i++) {
      var mgrNum = String(managers[i].whatsapp_number || "").replace(/[\s\+\-]/g, "");
      if (mgrNum) await sendMessage(mgrNum, mgrMsg);
    }
    sendMessage(from, "Low stock report sent to management. Thank you!");
    delete sessions[from];
    return;
  }

  // Leave Flow
  if (session && session.action === "dine_leave_type") {
    var leaveTypes = { "1": "Annual Leave", "2": "Medical Leave", "3": "Emergency Leave", "4": "Unpaid Leave" };
    var leaveType = leaveTypes[text.trim()];
    if (!leaveType) { sendMessage(from, "Invalid option. Enter 1, 2, 3 or 4."); return; }
    sessions[from].leaveType = leaveType;
    sessions[from].action = "dine_leave_date";
    sendMessage(from, "Leave type: " + leaveType + "\n\nEnter start date:\n\nFormat: DD-Mon-YYYY\nExample: 10-Jul-2026");
    return;
  }
  if (session && session.action === "dine_leave_date") {
    sessions[from].startDate = text.trim();
    sessions[from].action = "dine_leave_enddate";
    sendMessage(from, "Start date: " + text.trim() + "\n\nEnter end date:");
    return;
  }
  if (session && session.action === "dine_leave_enddate") {
    sessions[from].endDate = text.trim();
    sessions[from].action = "dine_leave_reason";
    sendMessage(from, "Enter reason for leave:");
    return;
  }
  if (session && session.action === "dine_leave_reason") {
    sessions[from].reason = text.trim();
    var ls = sessions[from];
    var allStaff3 = await getAllStaff();
    var managers2 = allStaff3.filter(function(s) { return isOwnerOrManager(s); });
    var leaveMsg = "Leave Request!\n\nStaff: " + ls.staffName + "\nType: " + ls.leaveType + "\nFrom: " + ls.startDate + "\nTo: " + ls.endDate + "\nReason: " + ls.reason;
    for (var j = 0; j < managers2.length; j++) {
      var mNum = String(managers2[j].whatsapp_number || "").replace(/[\s\+\-]/g, "");
      if (mNum) await sendMessage(mNum, leaveMsg);
    }
    sendMessage(from, "Leave request submitted!\n\nType: " + ls.leaveType + "\nFrom: " + ls.startDate + "\nTo: " + ls.endDate + "\n\nWaiting for manager approval.");
    delete sessions[from];
    return;
  }

  sendMainMenu(from);
}

// ── WEBHOOK ────────────────────────────────────────────────────────
app.get("/webhook", function(req, res) {
  if (req.query["hub.verify_token"] === VERIFY_TOKEN) {
    res.send(req.query["hub.challenge"]);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async function(req, res) {
  try {
    var entry = req.body.entry && req.body.entry[0];
    var changes = entry && entry.changes && entry.changes[0];
    var value = changes && changes.value;
    var messages = value && value.messages;
    if (!messages || !messages.length) { res.sendStatus(200); return; }
    var message = messages[0];
    var from = message.from;
    var type = message.type;
    console.log("From:", from, "| Type:", type);
    if (type === "text") await handleText(from, message.text.body.trim());
    if (type === "interactive") {
      var intType = message.interactive.type;
      if (intType === "button_reply") await handleButton(from, message.interactive.button_reply.id);
      if (intType === "list_reply") await handleList(from, message.interactive.list_reply.id);
    }
    if (type === "button") await handleButton(from, message.button.payload);
  } catch (err) { console.error("Webhook error:", err.message); }
  res.sendStatus(200);
});

// ── HEALTH ─────────────────────────────────────────────────────────
app.get("/health", function(req, res) {
  res.json({ status: "ok", service: "KAPA ONE Dine", uptime: process.uptime() });
});

// ── CRON: MORNING SHIFT REMINDER ───────────────────────────────────
cron.schedule("0 0 * * 1-7", async function() {
  console.log("8:00 AM Dine shift reminder...");
  try {
    var staff = await getAllStaff();
    var active = staff.filter(function(s) { return String(s.status || "").toLowerCase() === "active"; });
    for (var i = 0; i < active.length; i++) {
      var s = active[i];
      var num = String(s.whatsapp_number || "").replace(/[\s\+\-]/g, "");
      if (!num) continue;
      await sendMessage(num, "Good morning " + getStaffName(s) + "! Please check in for your shift. Type Hi to start.");
    }
  } catch (err) { console.error("Morning reminder:", err.message); }
});

// ── CRON: NIGHT SALES REMINDER ─────────────────────────────────────
cron.schedule("30 14 * * 1-7", async function() {
  console.log("10:30 PM Daily sales night reminder...");
  try {
    var staff = await getAllStaff();
    var owners = staff.filter(function(s) { return String(s.designation || "").toLowerCase() === "owner"; });
    if (!owners.length) return;
    var todaySales = await getTodaySales();
    var today = formatZohoDate(new Date());
    var msg = "Daily Sales Report - " + today + "\n\n";
    if (todaySales) {
      msg += "Total Sales: RM " + (todaySales.total_sales || 0) + "\n";
      msg += "Total Bills: " + (todaySales.total_bills || 0) + "\n";
      msg += "Cash: RM " + (todaySales.cash_amount || 0) + "\n";
      msg += "Card: RM " + (todaySales.card_amount || 0) + "\n";
      msg += "Online/QR: RM " + (todaySales.online_amount || 0) + "\n";
      msg += "GrabFood: RM " + (todaySales.grabfood_amount || 0);
    } else {
      msg += "No sales data submitted today.\nPlease ask manager to submit daily sales.";
    }
    for (var i = 0; i < owners.length; i++) {
      var num = String(owners[i].whatsapp_number || "").replace(/[\s\+\-]/g, "");
      if (num) await sendMessage(num, msg);
    }
  } catch (err) { console.error("Night sales reminder:", err.message); }
});

// ── CRON: LOW STOCK MORNING CHECK ──────────────────────────────────
cron.schedule("0 1 * * 1-7", async function() {
  console.log("9:00 AM Low stock check...");
  try {
    var lowStock = await getLowStockItems();
    if (!lowStock.length) return;
    var staff = await getAllStaff();
    var managers = staff.filter(function(s) { return isOwnerOrManager(s); });
    var msg = "Low Stock Alert!\n\n" + lowStock.length + " items need restocking:\n\n";
    lowStock.forEach(function(item, i) {
      msg += (i+1) + ". " + (item.item_name || "Item") + " - " + (item.current_stock || 0) + " " + (item.unit || "") + " remaining\n";
    });
    for (var i = 0; i < managers.length; i++) {
      var num = String(managers[i].whatsapp_number || "").replace(/[\s\+\-]/g, "");
      if (num) await sendMessage(num, msg);
    }
  } catch (err) { console.error("Low stock check:", err.message); }
});

// ── KEEP ALIVE ─────────────────────────────────────────────────────
cron.schedule("*/10 * * * *", function() {
  axios.get("https://kapa-dine-bot.onrender.com/health").catch(function() {});
});

// ── SERVER ─────────────────────────────────────────────────────────
app.listen(process.env.PORT || 3001, function() {
  console.log("KAPA ONE Dine Bot running on port " + (process.env.PORT || 3001));
});
