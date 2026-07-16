// KAPA ONE Dine - WhatsApp Bot for Restaurant Industry
const express = require("express");
const axios = require("axios");
const mongoose = require("mongoose");
const cron = require("node-cron");
require("dotenv").config();
const DB = require("./db");

const app = express();
app.use(express.json());
const hubRouter = require("./hub");
app.use("/hub", hubRouter);
app.use(require("express").static(__dirname));

// ── CONSTANTS ──────────────────────────────────────────────────────
const WHATSAPP_TOKEN  = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
// This bot instance serves Ritz Restaurant only (Plan 2 - dedicated number), matching
// hub.js's hardcoded DINE_COMPANY_ID until this bot supports multiple tenants.
const DINE_COMPANY_ID = "dine_ritz_001";

var sessions = {};

// ── MONGODB ────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI).then(function() {
  console.log("MongoDB connected");
}).catch(function(err) {
  console.error("MongoDB error:", err.message);
});

// ── HELPERS ────────────────────────────────────────────────────────
function formatZohoDate(d) {
  var dt = new Date(d);
  return String(dt.getDate()).padStart(2,"0") + "-" + MONTHS[dt.getMonth()] + "-" + dt.getFullYear();
}

function todayDate() {
  var now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur" }));
  return now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
}

function formatTime(t) {
  if (!t) return "-";
  var parts = String(t).split(":");
  var h = parseInt(parts[0]||0), m = parseInt(parts[1]||0);
  var ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return String(h).padStart(2,"0") + ":" + String(m).padStart(2,"0") + " " + ap;
}

function parseDateInput(str) {
  var s = String(str || "").trim();
  var m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (m) {
    var monIdx = MONTHS.indexOf(m[2].charAt(0).toUpperCase() + m[2].slice(1, 3).toLowerCase());
    if (monIdx === -1) return null;
    return m[3] + "-" + String(monIdx + 1).padStart(2, "0") + "-" + String(parseInt(m[1], 10)).padStart(2, "0");
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

async function sendMessage(to, text) {
  try {
    if (!to) return;
    await axios.post("https://graph.facebook.com/v18.0/" + PHONE_NUMBER_ID + "/messages",
      { messaging_product: "whatsapp", to: to, type: "text", text: { body: String(text) } },
      { headers: { Authorization: "Bearer " + WHATSAPP_TOKEN, "Content-Type": "application/json" } }
    );
  } catch (err) { console.error("sendMessage error:", err.response ? JSON.stringify(err.response.data) : err.message); }
}

// ── STAFF FUNCTIONS (MySQL dine_employees) ─────────────────────────
async function getAllStaff() {
  return await DB.getAllEmployees(DINE_COMPANY_ID);
}

async function findStaff(number) {
  var staff = await getAllStaff();
  var clean = String(number).replace(/[\s\+\-]/g, "");
  return staff.find(function(s) {
    var sc = String(s.whatsapp_number || "").replace(/[\s\+\-]/g, "");
    return sc === clean || sc.endsWith(clean) || clean.endsWith(sc);
  }) || null;
}

function getStaffName(s) { return s.employee_name || "Staff"; }

function isOwnerOrManager(s) {
  var des = String(s.designation || "").toLowerCase();
  return des === "owner" || des === "manager";
}

async function getCompany() {
  return await DB.getCompany(DINE_COMPANY_ID);
}

// ── ATTENDANCE FUNCTIONS (MySQL dine_attendance) ───────────────────
async function getTodayAttendanceRow(whatsappNumber) {
  var clean = String(whatsappNumber || "").replace(/[\s\+\-]/g, "");
  var rows = await DB.getAttendanceByDate(DINE_COMPANY_ID, todayDate());
  return rows.find(function(r) {
    var rc = String(r.whatsapp_number || "").replace(/[\s\+\-]/g, "");
    return rc === clean || rc.endsWith(clean) || clean.endsWith(rc);
  }) || null;
}

async function notifyManagerLate(staff, timeStr, lateMinutes) {
  try {
    var company = await getCompany();
    var managerNumber = company && company.manager_whatsapp;
    if (!managerNumber) return;
    await sendMessage(managerNumber, "⚠️ *Late Check-In*\n\n👤 " + getStaffName(staff) + " checked in at " + formatTime(timeStr) + " (" + lateMinutes + " min late).");
  } catch (err) { console.error("notifyManagerLate:", err.message); }
}

async function doCheckIn(staff) {
  var now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur" }));
  var timeStr = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
  var cutoffMins = 9 * 60; // 9:00 AM
  var nowMins = now.getHours() * 60 + now.getMinutes();
  var lateMinutes = Math.max(0, nowMins - cutoffMins);
  var status = lateMinutes > 0 ? "Late" : "Present";
  var ok = await DB.createAttendance({
    company_id: DINE_COMPANY_ID,
    employee_name: getStaffName(staff),
    whatsapp_number: staff.whatsapp_number,
    date: todayDate(),
    check_in_time: timeStr,
    status: status,
  });
  if (!ok) return null;
  if (lateMinutes > 0) await notifyManagerLate(staff, timeStr, lateMinutes);
  return { time: timeStr, status: status, lateMinutes: lateMinutes };
}

async function doCheckOut(staff, existing) {
  var now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur" }));
  var timeStr = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
  var ok = await DB.createAttendance({
    company_id: DINE_COMPANY_ID,
    employee_name: getStaffName(staff),
    whatsapp_number: staff.whatsapp_number,
    date: todayDate(),
    check_in_time: existing.check_in_time,
    check_out_time: timeStr,
    status: existing.status,
  });
  return ok ? timeStr : null;
}

// ── INVENTORY FUNCTIONS (MySQL dine_inventory) ─────────────────────
async function getLowStockItems() {
  var items = await DB.getInventory(DINE_COMPANY_ID);
  return items.filter(function(i) {
    return parseFloat(i.current_stock || 0) <= parseFloat(i.minimum_stock || 0);
  });
}

// ── DAILY SALES FUNCTIONS (MySQL dine_daily_sales) ─────────────────
async function saveDailySales(data) {
  return await DB.createDailySales({
    company_id: DINE_COMPANY_ID,
    date: todayDate(),
    total_sales: data.totalSales,
    total_bills: data.totalBills,
    cash_amount: data.cashAmount,
    card_amount: data.cardAmount,
    online_amount: data.onlineAmount,
    grabfood_amount: data.grabfoodAmount || 0,
    submitted_by: data.staffName,
  });
}

async function getTodaySalesRow() {
  var rows = await DB.getDailySalesByDate(DINE_COMPANY_ID, todayDate());
  return rows[0] || null;
}

async function sendTodaySalesView(to) {
  var row = await getTodaySalesRow();
  if (!row) { sendMessage(to, "📊 No sales data submitted yet today."); return; }
  var msg = "📊 *Today's Sales*\n\n";
  msg += "Total Sales: RM " + parseFloat(row.total_sales || 0).toFixed(2) + "\n";
  msg += "Total Bills: " + (row.total_bills || 0) + "\n";
  msg += "Cash: RM " + parseFloat(row.cash_amount || 0).toFixed(2) + "\n";
  msg += "Card: RM " + parseFloat(row.card_amount || 0).toFixed(2) + "\n";
  msg += "Online: RM " + parseFloat(row.online_amount || 0).toFixed(2) + "\n";
  msg += "GrabFood: RM " + parseFloat(row.grabfood_amount || 0).toFixed(2);
  sendMessage(to, msg);
}

// ── ORDERS (MySQL dine_orders) ──────────────────────────────────────
async function sendTodayOrders(to) {
  var orders = await DB.getTodayOrders(DINE_COMPANY_ID);
  if (!orders.length) { sendMessage(to, "🍽️ No orders yet today."); return; }
  var msg = "🍽️ *Today's Orders* (" + orders.length + ")\n\n";
  orders.slice(0, 15).forEach(function(o, i) {
    msg += (i + 1) + ". Table " + (o.table_number || "Takeaway") + " - RM " + parseFloat(o.total || 0).toFixed(2) + " (" + o.status + ")\n";
  });
  sendMessage(to, msg);
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
          { type: "reply", reply: { id: "dine_checkin", title: "✅ Check In" } },
          { type: "reply", reply: { id: "dine_checkout", title: "🚪 Check Out" } },
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

// Staff-facing "More" menu — 4 items per spec: Today's Sales, Update Inventory, View Orders, Apply Leave
async function sendStaffMenu(to) {
  try {
    await axios.post("https://graph.facebook.com/v18.0/" + PHONE_NUMBER_ID + "/messages",
      { messaging_product: "whatsapp", to: to, type: "interactive", interactive: {
        type: "list",
        body: { text: "More Options - Select:" },
        action: { button: "Select", sections: [{ title: "Staff Options", rows: [
          { id: "dine_today_sales", title: "📊 Today's Sales", description: "View today's sales summary" },
          { id: "dine_update_inventory", title: "📦 Update Inventory", description: "Update stock for an item" },
          { id: "dine_view_orders", title: "🍽️ View Orders", description: "See today's orders" },
          { id: "dine_leave", title: "🌴 Apply Leave", description: "Request time off" }
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
    var existing = await getTodayAttendanceRow(staff.whatsapp_number);
    if (existing && existing.check_in_time) {
      sendMessage(from, "Already checked in today at " + formatTime(existing.check_in_time));
      return;
    }
    var result = await doCheckIn(staff);
    if (result) {
      var msg = "Check-In Successful!\n\nName: " + staffName + "\nTime: " + formatTime(result.time);
      if (result.lateMinutes > 0) msg += "\nLate by: " + result.lateMinutes + " minutes";
      msg += "\n\nHave a great shift!";
      sendMessage(from, msg);
    } else {
      sendMessage(from, "Check-in failed. Please try again.");
    }
    return;
  }

  if (buttonId === "dine_checkout") {
    var existing2 = await getTodayAttendanceRow(staff.whatsapp_number);
    if (!existing2 || !existing2.check_in_time) {
      sendMessage(from, "You have not checked in today. Please check in first.");
      return;
    }
    if (existing2.check_out_time) {
      sendMessage(from, "Already checked out today at " + formatTime(existing2.check_out_time));
      return;
    }
    var checkoutTime = await doCheckOut(staff, existing2);
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

  if (listId === "dine_today_sales") { await sendTodaySalesView(from); return; }

  if (listId === "dine_update_inventory") {
    sessions[from] = { action: "dine_inv_item", staffName: staffName };
    sendMessage(from, "Update Inventory\n\nEnter item name:");
    return;
  }

  if (listId === "dine_view_orders") { await sendTodayOrders(from); return; }

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
      var ps2 = sessions[from];
      var saved2 = await DB.createPurchase({
        company_id: DINE_COMPANY_ID,
        item_name: ps2.item,
        supplier_name: ps2.supplier,
        quantity: ps2.qty,
        unit: ps2.unit,
        unit_price: ps2.price,
        total_amount: ps2.total,
        date: todayDate(),
        submitted_by: ps2.staffName,
        status: "Pending",
      });
      if (saved2) {
        sendMessage(from, "Purchase recorded!\n\nItem: " + ps2.item + "\nTotal: RM " + ps2.total.toFixed(2) + "\n\nSent for approval.");
      } else {
        sendMessage(from, "Failed to save purchase. Please try again.");
      }
    } else {
      sendMessage(from, "Purchase entry cancelled.");
    }
    delete sessions[from];
    return;
  }

  // Update Inventory Flow
  if (session && session.action === "dine_inv_item") {
    sessions[from].itemName = text.trim();
    sessions[from].action = "dine_inv_qty";
    sendMessage(from, "Item: " + text.trim() + "\n\nEnter new stock quantity:");
    return;
  }
  if (session && session.action === "dine_inv_qty") {
    var qty2 = parseFloat(text.trim());
    if (isNaN(qty2) || qty2 < 0) { sendMessage(from, "Invalid quantity. Enter a number."); return; }
    var updated = await DB.updateInventoryStock(DINE_COMPANY_ID, sessions[from].itemName, qty2);
    if (updated) {
      sendMessage(from, "Inventory updated!\n\n" + sessions[from].itemName + ": " + qty2 + "\n\nThank you!");
    } else {
      sendMessage(from, "Item not found: " + sessions[from].itemName + "\n\nPlease check the item name and try again.");
    }
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
    var startDb = parseDateInput(ls.startDate);
    var endDb = parseDateInput(ls.endDate);
    if (startDb && endDb) {
      await DB.createLeaveRequest({
        company_id: DINE_COMPANY_ID,
        employee_name: ls.staffName,
        whatsapp_number: from,
        leave_type: ls.leaveType,
        start_date: startDb,
        end_date: endDb,
        reason: ls.reason,
        status: "Pending",
      });
    } else {
      console.error("dine_leave_reason: could not parse dates", ls.startDate, ls.endDate);
    }
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

app.get("/", function(req, res) {
  res.sendFile(__dirname + "/kapa-dine-hub.html");
});
app.get("/hub-ui", function(req, res) {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.sendFile(__dirname + "/kapa-dine-hub.html");
});

// ── CRON: 9:00 AM STAFF ATTENDANCE REMINDER ────────────────────────
cron.schedule("0 1 * * *", async function() {
  console.log("9:00 AM Dine attendance reminder...");
  try {
    var staff = await getAllStaff();
    var active = staff.filter(function(s) { return String(s.status || "").toLowerCase() === "active"; });
    for (var i = 0; i < active.length; i++) {
      var s = active[i];
      var num = String(s.whatsapp_number || "").replace(/[\s\+\-]/g, "");
      if (!num) continue;
      await sendMessage(num, "Good morning " + getStaffName(s) + "! Please check in for your shift. Type Hi to start.");
    }
  } catch (err) { console.error("Attendance reminder:", err.message); }
});

// ── CRON: 10:00 PM DAILY SALES REPORT TO OWNER ─────────────────────
cron.schedule("0 16 * * *", async function() {
  console.log("10:00 PM Daily sales report...");
  try {
    var company = await getCompany();
    var ownerNumber = company && company.owner_whatsapp;
    if (!ownerNumber) return;
    var companyName = (company && company.company_name) || "Restaurant";
    var row = await getTodaySalesRow();
    var todayStr = formatZohoDate(new Date());
    var msg;
    if (row) {
      var totalSales = parseFloat(row.total_sales || 0);
      var totalBills = parseInt(row.total_bills || 0, 10);
      var avgBill = totalBills > 0 ? (totalSales / totalBills) : 0;
      msg = "📊 *Daily Sales Report - " + companyName + "*\n🗓️ " + todayStr + "\n\n" +
        "💰 *Total Sales:* RM " + totalSales.toFixed(2) + "\n" +
        "🧾 *Total Bills:* " + totalBills + "\n" +
        "💵 *Cash:* RM " + parseFloat(row.cash_amount || 0).toFixed(2) + "\n" +
        "💳 *Card:* RM " + parseFloat(row.card_amount || 0).toFixed(2) + "\n" +
        "📱 *Online:* RM " + parseFloat(row.online_amount || 0).toFixed(2) + "\n" +
        "🥡 *GrabFood:* RM " + parseFloat(row.grabfood_amount || 0).toFixed(2) + "\n\n" +
        "📈 *Average Bill:* RM " + avgBill.toFixed(2) + "\n\n" +
        "View details: kapa-dine-bot.onrender.com/hub-ui";
    } else {
      msg = "📊 *Daily Sales Report - " + companyName + "*\n🗓️ " + todayStr + "\n\nNo sales data submitted today.\n\nView details: kapa-dine-bot.onrender.com/hub-ui";
    }
    await sendMessage(ownerNumber, msg);
  } catch (err) { console.error("Daily sales report:", err.message); }
});

// ── CRON: 8:00 AM LOW STOCK ALERT TO OWNER ─────────────────────────
cron.schedule("0 0 * * *", async function() {
  console.log("8:00 AM Low stock check...");
  try {
    var lowStock = await getLowStockItems();
    if (!lowStock.length) return;
    var company = await getCompany();
    var ownerNumber = company && company.owner_whatsapp;
    if (!ownerNumber) return;
    var companyName = (company && company.company_name) || "Restaurant";
    var msg = "⚠️ *Low Stock Alert - " + companyName + "*\n\nThe following items need restocking:\n\n";
    lowStock.forEach(function(item) {
      msg += "📦 " + (item.item_name || "Item") + " - " + parseFloat(item.current_stock || 0) + " " + (item.unit || "") + " remaining (min: " + parseFloat(item.minimum_stock || 0) + ")\n";
    });
    msg += "\nPlease arrange restocking immediately.";
    await sendMessage(ownerNumber, msg);
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
