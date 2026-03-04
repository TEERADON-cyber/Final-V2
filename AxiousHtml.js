// Description: Node.js HTML client (Users)
// requires: npm install express ejs axios body-parser

const express = require('express');
const axios = require('axios');
var bodyParser = require('body-parser');
const path = require("path");
const app = express();

// Base URL for API
const base_url = "http://localhost:4000";
const thbCurrencyFormatter = new Intl.NumberFormat("th-TH", {
  style: "currency",
  currency: "THB",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});
const monthLabelFormatter = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric"
});
const allowedNoticeTypes = new Set(["info", "success", "warning", "error"]);
const paymentMethodLabels = {
  online_bank: "Online Bank",
  credit_card: "Credit Card",
  promptpay: "PromptPay"
};
const paymentStatusLabels = {
  pending_payment: "Pending Payment",
  pending: "Pending",
  paid: "Paid",
  unpaid: "Unpaid",
  cancelled: "Cancelled",
  refunded: "Refunded"
};
const orderStatusLabels = {
  processing: "Processing",
  in_transit: "In Transit",
  delivered: "Delivered",
  cancelled: "Cancelled"
};
const paymentMethodOrder = ["online_bank", "credit_card", "promptpay"];
const orderStatusOrder = ["processing", "in_transit", "delivered"];
const defaultCustomerDeliveryDueDaysInput = Number.parseInt(
  process.env.CUSTOMER_DEFAULT_DELIVERY_DUE_DAYS || "7",
  10
);
const defaultCustomerDeliveryDueDays = Number.isFinite(defaultCustomerDeliveryDueDaysInput)
  && defaultCustomerDeliveryDueDaysInput >= 0
  ? defaultCustomerDeliveryDueDaysInput
  : 7;
const shippingBaseFeeInput = Number.parseFloat(process.env.SHIPPING_BASE_FEE || "30");
const shippingPerKgInput = Number.parseFloat(process.env.SHIPPING_PER_KG || "20");
const expressDeliveryAdditionalChargeInput = Number.parseFloat(
  process.env.EXPRESS_DELIVERY_ADDITIONAL_CHARGE || "40"
);
const shippingBaseFee = Number.isFinite(shippingBaseFeeInput) ? shippingBaseFeeInput : 30;
const shippingPerKg = Number.isFinite(shippingPerKgInput) ? shippingPerKgInput : 20;
const expressDeliveryAdditionalCharge = Number.isFinite(expressDeliveryAdditionalChargeInput)
  && expressDeliveryAdditionalChargeInput > 0
  ? Math.round(expressDeliveryAdditionalChargeInput * 100) / 100
  : 40;
const standardDeliveryServiceName = "standard delivery";
const minPackageWeight = 0.1;
const maxPackageWeight = 125;

// [PAYMENT] Normalize payment method and map legacy aliases.
function normalizePaymentMethod(rawMethod) {
  const value = String(rawMethod || "").toLowerCase().trim();
  if (!value) return null;

  const aliases = {
    bank_transfer: "online_bank",
    bank: "online_bank",
    "online bank": "online_bank",
    online_bank: "online_bank",
    cash: "online_bank",
    cash_on_delivery: "online_bank",
    cod: "online_bank",
    card: "credit_card",
    "credit card": "credit_card",
    credit_card: "credit_card",
    mobile_wallet: "promptpay",
    prompt_pay: "promptpay",
    promptpay: "promptpay"
  };

  const normalized = aliases[value] || value;
  return paymentMethodLabels[normalized] ? normalized : null;
}

// [PAYMENT] Human-friendly payment method label.
function formatPaymentMethod(rawMethod) {
  const normalized = normalizePaymentMethod(rawMethod);
  return normalized ? paymentMethodLabels[normalized] : (String(rawMethod || "").trim() || "-");
}

// [PAYMENT] Human-friendly payment status label.
function formatPaymentStatus(rawStatus) {
  const value = String(rawStatus || "").toLowerCase().trim();
  return paymentStatusLabels[value] || (value ? value.replace(/_/g, " ") : "-");
}

// [DELIVERY] Normalize order status and map legacy aliases.
function normalizeOrderStatus(rawStatus) {
  const value = String(rawStatus || "").toLowerCase().trim();
  if (!value) return null;

  const aliases = {
    pending: "processing",
    "ready to ship": "processing",
    ready_to_ship: "processing",
    shipped: "in_transit",
    "out for delivery": "in_transit",
    out_for_delivery: "in_transit",
    "in transit": "in_transit",
    in_transit: "in_transit",
    delivered: "delivered",
    processing: "processing",
    cancelled: "cancelled"
  };

  const normalized = aliases[value] || value;
  return orderStatusLabels[normalized] ? normalized : null;
}

// [DELIVERY] Human-friendly order status label.
function formatOrderStatus(rawStatus) {
  const normalized = normalizeOrderStatus(rawStatus);
  return normalized ? orderStatusLabels[normalized] : (String(rawStatus || "").trim() || "-");
}

// [FORM] Keep only digits from an input.
function digitsOnly(rawValue) {
  return String(rawValue || "").replace(/\D+/g, "");
}

// [PACKAGE] Normalize package weight.
function normalizeWeight(rawWeight) {
  const value = Number.parseFloat(rawWeight);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

// [DELIVERY] Calculate shipping amount from package weight.
function calculateShippingAmountByWeight(weight) {
  const normalizedWeight = normalizeWeight(weight);
  if (!Number.isFinite(normalizedWeight) || normalizedWeight <= 0) return null;
  return Math.round((shippingBaseFee + (shippingPerKg * normalizedWeight)) * 100) / 100;
}

// [PACKAGE] Pick default delivery service id from a service list.
function getDefaultServiceId(services) {
  const list = Array.isArray(services) ? services : [];
  const standardService = list.find((service) => {
    return String(service && service.service_name ? service.service_name : "")
      .toLowerCase()
      .trim() === standardDeliveryServiceName;
  });
  const standardId = Number.parseInt(standardService && standardService.service_id, 10);
  if (Number.isFinite(standardId) && standardId > 0) {
    return standardId;
  }

  const ids = list
    .map((service) => Number.parseInt(service && service.service_id, 10))
    .filter((id) => Number.isFinite(id) && id > 0);
  if (!ids.length) return null;
  return Math.min(...ids);
}

// [DATE] Format Date object as YYYY-MM-DD.
function toIsoDateOnly(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// [DELIVERY] Build default delivery payload for customer self-service flow.
function buildCustomerAutoDeliveryPayload(packageId, packageWeight) {
  const today = new Date();
  const due = new Date(today);
  due.setDate(due.getDate() + defaultCustomerDeliveryDueDays);
  const shippingAmount = calculateShippingAmountByWeight(packageWeight);

  return {
    package_id: Number(packageId),
    delivery_date: toIsoDateOnly(today),
    due_date: toIsoDateOnly(due),
    amount: Number.isFinite(shippingAmount) ? shippingAmount : undefined,
    payment_method: "online_bank",
    order_status: "processing"
  };
}

// [DELIVERY] Normalize delivery rows and attach package/payment derived fields.
function enrichDeliveriesWithPaymentState(deliveries, packages, payments) {
  const deliveryList = Array.isArray(deliveries) ? deliveries : [];
  const packageList = Array.isArray(packages) ? packages : [];
  const paymentList = Array.isArray(payments) ? payments : [];

  const packageById = new Map(
    packageList.map((pack) => [String(pack.package_id), pack])
  );
  const paymentByDeliveryId = new Map(
    paymentList.map((payment) => [String(payment.delivery_id), payment])
  );

  return deliveryList.map((delivery) => {
    const pack = packageById.get(String(delivery.package_id)) || null;
    const payment = paymentByDeliveryId.get(String(delivery.delivery_id)) || null;
    const method = normalizePaymentMethod(
      (payment && payment.payment_method) || delivery.payment_method
    ) || "online_bank";
    const packageStatus = String(pack && pack.package_status ? pack.package_status : "active")
      .toLowerCase()
      .trim() || "active";
    const orderStatus = packageStatus === "cancelled"
      ? "cancelled"
      : (normalizeOrderStatus(delivery.order_status) || "processing");
    const deliveryStatus = String(delivery.status || "").toLowerCase().trim();
    const rawPaymentStatus = String(payment && payment.payment_status ? payment.payment_status : "")
      .toLowerCase()
      .trim();
    let effectivePaymentStatus = rawPaymentStatus;

    if (!effectivePaymentStatus) {
      if (method === "cod" && orderStatus !== "delivered") {
        effectivePaymentStatus = "pending";
      } else {
        effectivePaymentStatus = deliveryStatus === "paid" ? "paid" : "unpaid";
      }
    }
    if (method === "cod" && orderStatus !== "delivered" && effectivePaymentStatus !== "paid") {
      effectivePaymentStatus = "pending";
    }
    if (packageStatus === "cancelled") {
      effectivePaymentStatus = "cancelled";
    }
    if (effectivePaymentStatus === "pending_payment") {
      effectivePaymentStatus = "unpaid";
    }

    return {
      ...delivery,
      tracking_number: pack ? (pack.tracking_number || pack.package_reading || null) : null,
      receiver_name: pack ? (pack.receiver_name || null) : null,
      package_status: packageStatus,
      order_status: orderStatus,
      order_status_label: formatOrderStatus(orderStatus),
      payment_method: method,
      payment_status: effectivePaymentStatus,
      payment_status_label: formatPaymentStatus(effectivePaymentStatus)
    };
  });
}

// [FORMAT] Convert numeric values into THB currency format.
function formatTHB(value, fallback = "-") {
  const numericValue = Number.parseFloat(value);
  if (!Number.isFinite(numericValue)) return fallback;
  return thbCurrencyFormatter.format(numericValue);
}

// [FORMAT] Normalize different delivery date inputs into YYYY-MM keys.
function toDeliveryDateKey(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) return "unknown";

  const isoMatch = value.match(/^(\d{4})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}`;

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    const year = parsed.getUTCFullYear();
    const month = String(parsed.getUTCMonth() + 1).padStart(2, "0");
    return `${year}-${month}`;
  }

  return "unknown";
}

// [FORMAT] Convert normalized delivery date keys into readable labels.
function toDeliveryDateLabel(monthKey) {
  if (!/^\d{4}-\d{2}$/.test(monthKey)) return "Unknown";
  const [year, month] = monthKey.split("-").map((part) => Number.parseInt(part, 10));
  const utcDate = new Date(Date.UTC(year, month - 1, 1));
  return monthLabelFormatter.format(utcDate);
}

// [REPORT] Aggregate deliveries/payments into per-month report rows.
function buildMonthlyDeliveryReport(deliveries, payments) {
  const safeDeliveries = Array.isArray(deliveries) ? deliveries : [];
  const safePayments = Array.isArray(payments) ? payments : [];
  const paymentsByDeliveryId = {};

  safePayments.forEach((payment) => {
    const deliveryId = String(payment.delivery_id || "").trim();
    if (!deliveryId) return;
    paymentsByDeliveryId[deliveryId] = paymentsByDeliveryId[deliveryId] || [];
    paymentsByDeliveryId[deliveryId].push(payment);
  });

  const monthlyReportMap = {};
  safeDeliveries.forEach((delivery) => {
    const monthKey = toDeliveryDateKey(delivery.delivery_date);
    const status = String(delivery.status || "").toLowerCase().trim();
    const deliveryId = String(delivery.delivery_id || delivery.id || "").trim();
    const amount = Number.parseFloat(delivery.amount);
    const normalizedAmount = Number.isFinite(amount) ? amount : 0;
    const linkedPayments = deliveryId ? (paymentsByDeliveryId[deliveryId] || []) : [];
    const dueDate = String(delivery.due_date || "").trim();
    const dueDateTs = dueDate ? new Date(dueDate).getTime() : NaN;

    if (!monthlyReportMap[monthKey]) {
      monthlyReportMap[monthKey] = {
        monthKey,
        monthLabel: toDeliveryDateLabel(monthKey),
        deliveriesCount: 0,
        paidDeliveriesCount: 0,
        unpaidDeliveriesCount: 0,
        overdueDeliveriesCount: 0,
        paymentsCount: 0,
        totalAmount: 0,
        paidAmount: 0,
        outstandingAmount: 0,
        minDeliveryAmount: null,
        maxDeliveryAmount: null,
        dueWindowStart: null,
        dueWindowEnd: null,
        dueWindowStartTs: null,
        dueWindowEndTs: null
      };
    }

    const monthSummary = monthlyReportMap[monthKey];
    monthSummary.deliveriesCount += 1;
    monthSummary.paymentsCount += linkedPayments.length;
    monthSummary.totalAmount += normalizedAmount;
    if (monthSummary.minDeliveryAmount === null || normalizedAmount < monthSummary.minDeliveryAmount) {
      monthSummary.minDeliveryAmount = normalizedAmount;
    }
    if (monthSummary.maxDeliveryAmount === null || normalizedAmount > monthSummary.maxDeliveryAmount) {
      monthSummary.maxDeliveryAmount = normalizedAmount;
    }
    if (Number.isFinite(dueDateTs)) {
      if (monthSummary.dueWindowStartTs === null || dueDateTs < monthSummary.dueWindowStartTs) {
        monthSummary.dueWindowStartTs = dueDateTs;
        monthSummary.dueWindowStart = dueDate;
      }
      if (monthSummary.dueWindowEndTs === null || dueDateTs > monthSummary.dueWindowEndTs) {
        monthSummary.dueWindowEndTs = dueDateTs;
        monthSummary.dueWindowEnd = dueDate;
      }
    }

    if (status === "paid") {
      monthSummary.paidDeliveriesCount += 1;
      monthSummary.paidAmount += normalizedAmount;
      return;
    }

    if (status === "overdue") {
      monthSummary.overdueDeliveriesCount += 1;
    } else {
      monthSummary.unpaidDeliveriesCount += 1;
    }
    monthSummary.outstandingAmount += normalizedAmount;
  });

  return Object.values(monthlyReportMap).map((summary) => {
    const deliveriesCount = summary.deliveriesCount || 0;
    const totalAmount = summary.totalAmount || 0;
    const paidAmount = summary.paidAmount || 0;

    return {
      monthKey: summary.monthKey,
      monthLabel: summary.monthLabel,
      deliveriesCount: summary.deliveriesCount,
      paidDeliveriesCount: summary.paidDeliveriesCount,
      unpaidDeliveriesCount: summary.unpaidDeliveriesCount,
      overdueDeliveriesCount: summary.overdueDeliveriesCount,
      paymentsCount: summary.paymentsCount,
      totalAmount: summary.totalAmount,
      paidAmount: summary.paidAmount,
      outstandingAmount: summary.outstandingAmount,
      minDeliveryAmount: summary.minDeliveryAmount === null ? 0 : summary.minDeliveryAmount,
      maxDeliveryAmount: summary.maxDeliveryAmount === null ? 0 : summary.maxDeliveryAmount,
      avgDeliveryAmount: deliveriesCount ? (totalAmount / deliveriesCount) : 0,
      paidRate: deliveriesCount ? ((summary.paidDeliveriesCount / deliveriesCount) * 100) : 0,
      collectionRate: totalAmount ? ((paidAmount / totalAmount) * 100) : 0,
      dueWindowStart: summary.dueWindowStart,
      dueWindowEnd: summary.dueWindowEnd
    };
  }).sort((left, right) => {
    const leftIsDated = /^\d{4}-\d{2}$/.test(left.monthKey);
    const rightIsDated = /^\d{4}-\d{2}$/.test(right.monthKey);

    if (leftIsDated && rightIsDated) {
      return right.monthKey.localeCompare(left.monthKey);
    }
    if (leftIsDated) return -1;
    if (rightIsDated) return 1;
    return left.monthKey.localeCompare(right.monthKey);
  });
}

// [AUTH] Restrict incoming roles to admin/user.
function normalizeRole(role) {
  return role === "admin" ? "admin" : "user";
}

// [SESSION] Parse cookie header into an object map.
function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;

  cookieHeader.split(";").forEach((part) => {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex < 0) return;

    const key = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (!key) return;

    cookies[key] = decodeURIComponent(value);
  });

  return cookies;
}

// [AUTH] Prevent unsafe external redirects.
function safeRedirectPath(rawPath) {
  const path = String(rawPath || "").trim();
  if (!path.startsWith("/") || path.startsWith("//")) return "/";
  return path;
}

// [NOTICE] Normalize notice type to supported values.
function normalizeNoticeType(rawType, fallback = "warning") {
  const type = String(rawType || "").trim().toLowerCase();
  return allowedNoticeTypes.has(type) ? type : fallback;
}

// [NOTICE] Trim and clamp notice text length.
function sanitizeNoticeText(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return null;
  if (text.length <= 220) return text;
  return `${text.slice(0, 217)}...`;
}

// [NOTICE] Append notice message/type query params to a path.
function withNotice(rawPath, message, type = "warning") {
  const path = safeRedirectPath(rawPath);
  const text = sanitizeNoticeText(message);
  if (!text) return path;

  const separator = path.includes("?") ? "&" : "?";
  const noticeType = normalizeNoticeType(type, "warning");
  return `${path}${separator}notice=${encodeURIComponent(text)}&noticeType=${encodeURIComponent(noticeType)}`;
}

// [USER] Build a fallback username from user data.
function deriveUsername(user) {
  const explicitUsername = String(user && user.username ? user.username : "").trim();
  if (explicitUsername) return explicitUsername;

  const email = String(user && user.email ? user.email : "").trim().toLowerCase();
  if (email.includes("@")) {
    const localPart = email.split("@")[0];
    const normalized = localPart.replace(/[^a-z0-9._-]/gi, "_").trim();
    if (normalized) return normalized;
  }

  const name = String(user && user.name ? user.name : "").trim().toLowerCase();
  if (name) {
    const normalized = name.replace(/\s+/g, ".").replace(/[^a-z0-9._-]/gi, "");
    if (normalized) return normalized;
  }

  const userId = String(user && (user.user_id || user.id) ? (user.user_id || user.id) : "").trim();
  if (userId) return `user${userId}`;
  return "unknown";
}

// [SESSION] Set auth cookies after successful login.
function setAuthCookies(res, user) {
  const maxAge = 60 * 60 * 24 * 30;
  const role = normalizeRole(user.role);
  const name = String(user.name || "").trim();
  const email = String(user.email || "").trim();
  const userId = String(user.user_id || "").trim();

  res.setHeader("Set-Cookie", [
    `auth_uid=${encodeURIComponent(userId)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`,
    `auth_role=${encodeURIComponent(role)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`,
    `auth_name=${encodeURIComponent(name)}; Path=/; Max-Age=${maxAge}; SameSite=Lax`,
    `auth_email=${encodeURIComponent(email)}; Path=/; Max-Age=${maxAge}; SameSite=Lax`
  ]);
}

// [SESSION] Clear all auth cookies on logout.
function clearAuthCookies(res) {
  res.setHeader("Set-Cookie", [
    "auth_uid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
    "auth_role=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
    "auth_name=; Path=/; Max-Age=0; SameSite=Lax",
    "auth_email=; Path=/; Max-Age=0; SameSite=Lax"
  ]);
}

// [AUTH] Middleware: allow admin users only.
function requireAdmin(req, res, next) {
  if (!req.currentUser) {
    const nextPath = encodeURIComponent(req.originalUrl || "/");
    return res.redirect(
      withNotice(`/login?next=${nextPath}`, "Please log in to continue.", "warning")
    );
  }

  if (req.currentRole === "admin") return next();

  const message = "Administrator access is required for this page.";
  const accepts = (req.get("accept") || "").toLowerCase();

  if (accepts.includes("application/json")) {
    return res.status(403).json({ message });
  }

  res.locals.notice = {
    type: "warning",
    text: message
  };
  return res.status(403).render("access-denied", { message });
}

// [AUTH] Middleware: require authenticated user.
function requireAuth(req, res, next) {
  if (req.currentUser) return next();

  const accepts = (req.get("accept") || "").toLowerCase();
  if (accepts.includes("application/json")) {
    return res.status(401).json({ message: "Authentication required" });
  }

  const nextPath = encodeURIComponent(req.originalUrl || "/");
  return res.redirect(
    withNotice(`/login?next=${nextPath}`, "Please log in to continue.", "warning")
  );
}

// Set template engine
app.set("views", path.join(__dirname, "/public/views"));
app.set('view engine', 'ejs');

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

app.use((req, res, next) => {
  const cookies = parseCookies(req.headers.cookie || "");
  const userId = Number.parseInt(cookies.auth_uid, 10);
  const role = normalizeRole(cookies.auth_role);
  const userName = String(cookies.auth_name || "").trim();
  const userEmail = String(cookies.auth_email || "").trim();
  const isAuthenticated = Number.isFinite(userId) && userId > 0 && !!userName;

  const currentUser = isAuthenticated
    ? {
      user_id: userId,
      name: userName,
      email: userEmail || null,
      role
    }
    : null;

  req.currentUser = currentUser;
  req.currentRole = currentUser ? role : "guest";

  res.locals.currentUser = currentUser;
  res.locals.isAuthenticated = !!currentUser;
  res.locals.role = req.currentRole;
  res.locals.isAdmin = !!currentUser && role === "admin";
  res.locals.roleLabel = !currentUser
    ? "Guest"
    : role === "admin"
      ? "Administrator"
      : "General User";
  const noticeText = sanitizeNoticeText(req.query.notice);
  const noticeType = normalizeNoticeType(req.query.noticeType, "warning");
  res.locals.notice = noticeText
    ? {
      type: noticeType,
      text: noticeText
    }
    : null;
  res.locals.rolePath = (targetPath) => targetPath;
  res.locals.formatTHB = formatTHB;
  res.locals.normalizePaymentMethod = normalizePaymentMethod;
  res.locals.formatPaymentMethod = formatPaymentMethod;
  res.locals.formatPaymentStatus = formatPaymentStatus;
  res.locals.normalizeOrderStatus = normalizeOrderStatus;
  res.locals.formatOrderStatus = formatOrderStatus;
  res.locals.paymentMethodOptions = paymentMethodOrder.map((method) => ({
    value: method,
    label: paymentMethodLabels[method]
  }));
  res.locals.orderStatusOptions = orderStatusOrder.map((status) => ({
    value: status,
    label: orderStatusLabels[status]
  }));
  res.locals.expressDeliveryAdditionalCharge = expressDeliveryAdditionalCharge;
  next();
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// ================= ROUTES =================

// [AUTH] Render login page.
app.get('/login', (req, res) => {
  if (req.currentUser) return res.redirect('/');
  res.render('login', {
    error: req.query.error || null,
    next: safeRedirectPath(req.query.next)
  });
});

// [AUTH] Authenticate and start user session.
app.post('/login', async (req, res) => {
  if (req.currentUser) return res.redirect('/');

  const email = String(req.body.email || '').trim();
  const password = String(req.body.password || '');
  const nextPath = safeRedirectPath(req.body.next || req.query.next);

  try {
    const loginResp = await axios.post(`${base_url}/auth/login`, {
      email,
      password
    });
    const user = loginResp.data && loginResp.data.user;
    if (!user || !user.user_id) {
      throw new Error('Invalid login response');
    }

    setAuthCookies(res, user);
    return res.redirect(nextPath);
  } catch (err) {
    const apiMessage = err.response && err.response.data && err.response.data.message;
    const backendOffline = err.code === 'ECONNREFUSED';
    const message = backendOffline
      ? 'Backend API is offline on http://localhost:4000. Start it with: npm run backend'
      : apiMessage || 'Login failed';
    return res.status(401).render('login', {
      error: message,
      next: nextPath
    });
  }
});

// [USER] Render registration page.
app.get('/register', (req, res) => {
  if (req.currentUser) return res.redirect('/');

  res.render('register', {
    error: req.query.error || null,
    values: {
      name: req.query.name || '',
      email: req.query.email || '',
      phone: req.query.phone || ''
    }
  });
});

// [USER] Register a new user and log in immediately.
app.post('/register', async (req, res) => {
  if (req.currentUser) return res.redirect('/');

  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const phone = String(req.body.phone || '').trim();

  if (!name || !email || !password) {
    return res.status(400).render('register', {
      error: 'Name, email and password are required.',
      values: { name, email, phone }
    });
  }

  try {
    await axios.post(`${base_url}/users`, {
      name,
      email,
      password,
      phone: phone || null,
      role: 'user'
    });

    const loginResp = await axios.post(`${base_url}/auth/login`, { email, password });
    const user = loginResp.data && loginResp.data.user;
    if (!user || !user.user_id) {
      throw new Error('Invalid login response');
    }

    setAuthCookies(res, user);
    return res.redirect('/');
  } catch (err) {
    const apiMessage = err.response && err.response.data && err.response.data.message;
    const fallback = 'Registration failed';
    const message = apiMessage || fallback;
    return res.status(400).render('register', {
      error: message,
      values: { name, email, phone }
    });
  }
});

// [AUTH] Log out and clear auth cookies.
app.get('/logout', (req, res) => {
  clearAuthCookies(res);
  res.redirect('/login');
});

// [DASHBOARD] Render role-based landing dashboard.
app.get('/', async (req, res) => {
  if (!req.currentUser) {
    return res.redirect('/register');
  }

  if (req.currentRole === "admin") {
    try {
      const [usersResp, packagesResp, deliveriesResp, paymentsResp, deliveryServicesResp] = await Promise.all([
        axios.get(`${base_url}/users`),
        axios.get(`${base_url}/packages`),
        axios.get(`${base_url}/deliveries`),
        axios.get(`${base_url}/payments`),
        axios.get(`${base_url}/delivery-services`)
      ]);

      const users = usersResp.data || [];
      const packages = packagesResp.data || [];
      const deliveries = deliveriesResp.data || [];
      const payments = paymentsResp.data || [];
      const deliveryServices = deliveryServicesResp.data || [];

      const openDeliveries = deliveries.filter((d) => {
        const status = String(d.status || "").toLowerCase();
        return status === "unpaid" || status === "overdue";
      });
      const outstandingAmount = openDeliveries.reduce((sum, delivery) => {
        const amount = Number.parseFloat(delivery.amount);
        return sum + (Number.isFinite(amount) ? amount : 0);
      }, 0);
      const urgentDeliveries = [...openDeliveries].sort((a, b) => {
        const left = new Date(a.due_date || 0).getTime();
        const right = new Date(b.due_date || 0).getTime();
        return left - right;
      }).slice(0, 5);
      const recentPayments = [...payments].sort((a, b) => {
        const left = new Date(a.payment_date || 0).getTime();
        const right = new Date(b.payment_date || 0).getTime();
        return right - left;
      }).slice(0, 5);

      return res.render('index', {
        home: {
          mode: "admin",
          error: null,
          summary: {
            usersCount: users.length,
            packagesCount: packages.length,
            deliveryServicesCount: deliveryServices.length,
            openDeliveriesCount: openDeliveries.length,
            outstandingAmount
          },
          urgentDeliveries,
          recentPayments
        }
      });
    } catch (err) {
      console.error('Home dashboard (admin) load failed:', err.message);
      return res.render('index', {
        home: {
          mode: "admin",
          error: "Unable to load latest admin metrics right now.",
          summary: {
            usersCount: 0,
            packagesCount: 0,
            deliveryServicesCount: 0,
            openDeliveriesCount: 0,
            outstandingAmount: 0
          },
          urgentDeliveries: [],
          recentPayments: []
        }
      });
    }
  }

  try {
    const [packagesResp, deliveriesResp, paymentsResp] = await Promise.all([
      axios.get(`${base_url}/packages`),
      axios.get(`${base_url}/deliveries`),
      axios.get(`${base_url}/payments`)
    ]);

    const allPackages = packagesResp.data || [];
    const allDeliveries = deliveriesResp.data || [];
    const allPayments = paymentsResp.data || [];

    const myPackages = allPackages.filter((p) => String(p.user_id) === String(req.currentUser.user_id));
    const packageIds = new Set(myPackages.map((p) => String(p.package_id)));
    const myDeliveries = allDeliveries.filter((d) => packageIds.has(String(d.package_id)));
    const deliveryIds = new Set(myDeliveries.map((d) => String(d.delivery_id)));
    const myPayments = allPayments.filter((p) => deliveryIds.has(String(p.delivery_id)));
    const deliveries = enrichDeliveriesWithPaymentState(myDeliveries, myPackages, myPayments);

    const openDeliveries = deliveries.filter((d) => {
      const paymentStatus = String(d.payment_status || "").toLowerCase().trim();
      const deliveryStatus = String(d.status || "").toLowerCase().trim();
      return paymentStatus === "unpaid"
        || paymentStatus === "pending_payment"
        || deliveryStatus === "overdue";
    });
    const dueAmount = openDeliveries.reduce((sum, delivery) => {
      const amount = Number.parseFloat(delivery.amount);
      return sum + (Number.isFinite(amount) ? amount : 0);
    }, 0);

    const recentDeliveries = [...deliveries].sort((a, b) => {
      const left = new Date(a.due_date || a.created_at || 0).getTime();
      const right = new Date(b.due_date || b.created_at || 0).getTime();
      return left - right;
    }).slice(0, 5);
    const recentPayments = [...myPayments].sort((a, b) => {
      const left = new Date(a.payment_date || 0).getTime();
      const right = new Date(b.payment_date || 0).getTime();
      return right - left;
    }).slice(0, 5);

    return res.render('index', {
      home: {
        mode: "user",
        error: null,
        summary: {
          packagesCount: myPackages.length,
          deliveriesCount: deliveries.length,
          openDeliveriesCount: openDeliveries.length,
          paymentsCount: myPayments.length,
          dueAmount
        },
        recentDeliveries,
        recentPayments
      }
    });
  } catch (err) {
    console.error('Home dashboard (user) load failed:', err.message);
    return res.render('index', {
      home: {
        mode: "user",
        error: "Unable to load your latest dashboard data right now.",
        summary: {
          packagesCount: 0,
          deliveriesCount: 0,
          openDeliveriesCount: 0,
          paymentsCount: 0,
          dueAmount: 0
        },
        recentDeliveries: [],
        recentPayments: []
      }
    });
  }
});

// [DASHBOARD] Render full admin operational metrics.
app.get('/admin-dashboard', requireAdmin, async (req, res) => {
  try {
    const [usersResp, packagesResp, deliveriesResp, paymentsResp, deliveryServicesResp] = await Promise.all([
      axios.get(`${base_url}/users`),
      axios.get(`${base_url}/packages`),
      axios.get(`${base_url}/deliveries`),
      axios.get(`${base_url}/payments`),
      axios.get(`${base_url}/delivery-services`)
    ]);

    const users = usersResp.data || [];
    const packages = packagesResp.data || [];
    const deliveries = deliveriesResp.data || [];
    const payments = paymentsResp.data || [];
    const deliveryServices = deliveryServicesResp.data || [];
    const deliveryById = new Map(
      deliveries.map((delivery) => [String(delivery.delivery_id), delivery])
    );

    const selectedPaymentMethod = (() => {
      const raw = String(req.query.paymentMethod || "").trim();
      if (!raw || raw.toLowerCase() === "all") return "all";
      return normalizePaymentMethod(raw) || "all";
    })();

    const normalizedPayments = payments.map((payment) => {
      const delivery = deliveryById.get(String(payment.delivery_id));
      const normalizedMethod = normalizePaymentMethod(payment.payment_method) || "online_bank";
      const deliveryStatus = String(delivery && delivery.status ? delivery.status : "").toLowerCase().trim();
      let paymentStatus = String(payment.payment_status || "").toLowerCase().trim();

      if (!paymentStatus) {
        if (deliveryStatus === "paid") paymentStatus = "paid";
        else if (normalizedMethod === "cod") paymentStatus = "pending";
        else paymentStatus = "pending_payment";
      }

      return {
        ...payment,
        payment_method: normalizedMethod,
        payment_method_label: formatPaymentMethod(normalizedMethod),
        payment_status: paymentStatus,
        payment_status_label: formatPaymentStatus(paymentStatus)
      };
    });

    const overdueDeliveries = deliveries.filter((d) => String(d.status || "").toLowerCase() === "overdue");
    const unpaidDeliveries = deliveries.filter((d) => String(d.status || "").toLowerCase() === "unpaid");
    const paidDeliveries = deliveries.filter((d) => String(d.status || "").toLowerCase() === "paid");

    const totalDeliveredAmount = deliveries.reduce((sum, delivery) => {
      const amount = Number.parseFloat(delivery.amount);
      return sum + (Number.isFinite(amount) ? amount : 0);
    }, 0);

    const recentUsers = [...users].sort((a, b) => {
      const left = new Date(a.created_at || 0).getTime();
      const right = new Date(b.created_at || 0).getTime();
      return right - left;
    }).slice(0, 8);

    const recentPayments = normalizedPayments.filter((payment) => {
      if (selectedPaymentMethod === "all") return true;
      return payment.payment_method === selectedPaymentMethod;
    }).sort((a, b) => {
      const left = new Date(a.payment_date || 0).getTime();
      const right = new Date(b.payment_date || 0).getTime();
      return right - left;
    }).slice(0, 8);

    const urgentDeliveries = [...deliveries].filter((delivery) => {
      const status = String(delivery.status || "").toLowerCase();
      return status === "unpaid" || status === "overdue";
    }).sort((a, b) => {
      const left = new Date(a.due_date || 0).getTime();
      const right = new Date(b.due_date || 0).getTime();
      return left - right;
    }).slice(0, 10);

    res.render('admin-dashboard', {
      summary: {
        usersCount: users.length,
        packagesCount: packages.length,
        deliveryServicesCount: deliveryServices.length,
        deliveriesCount: deliveries.length,
        paymentsCount: normalizedPayments.length,
        paidDeliveriesCount: paidDeliveries.length,
        unpaidDeliveriesCount: unpaidDeliveries.length,
        overdueDeliveriesCount: overdueDeliveries.length,
        totalDeliveredAmount
      },
      recentUsers,
      recentPayments,
      urgentDeliveries,
      selectedPaymentMethod
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error loading admin dashboard');
  }
});

// [DASHBOARD] Render user dashboard and monthly report.
app.get('/user-dashboard', requireAuth, async (req, res) => {
  try {
    const [packagesResp, deliveriesResp, paymentsResp] = await Promise.all([
      axios.get(`${base_url}/packages`),
      axios.get(`${base_url}/deliveries`),
      axios.get(`${base_url}/payments`)
    ]);

    const allPackages = packagesResp.data || [];
    const allDeliveries = deliveriesResp.data || [];
    const allPayments = paymentsResp.data || [];
    const isAdmin = req.currentRole === "admin";

    const packages = isAdmin
      ? allPackages
      : allPackages.filter((p) => String(p.user_id) === String(req.currentUser.user_id));

    const packageIds = new Set(packages.map((p) => String(p.package_id)));
    const ownedDeliveries = allDeliveries.filter((d) => packageIds.has(String(d.package_id)));
    const deliveryIds = new Set(ownedDeliveries.map((d) => String(d.delivery_id)));
    const payments = allPayments.filter((p) => deliveryIds.has(String(p.delivery_id)));
    const deliveries = enrichDeliveriesWithPaymentState(ownedDeliveries, packages, payments);

    const paidDeliveriesCount = deliveries.filter((d) => String(d.status || "").toLowerCase() === "paid").length;
    const overdueDeliveriesCount = deliveries.filter((d) => String(d.status || "").toLowerCase() === "overdue").length;
    const unpaidDeliveries = deliveries.filter((d) => {
      const status = String(d.status || "").toLowerCase();
      return status === "unpaid" || status === "overdue";
    });
    const totalDue = unpaidDeliveries.reduce((sum, delivery) => {
      const amount = Number.parseFloat(delivery.amount);
      return sum + (Number.isFinite(amount) ? amount : 0);
    }, 0);

    const recentDeliveries = [...deliveries].sort((a, b) => {
      const left = new Date(a.due_date || a.created_at || 0).getTime();
      const right = new Date(b.due_date || b.created_at || 0).getTime();
      return right - left;
    }).slice(0, 8);

    const recentPayments = [...payments].sort((a, b) => {
      const left = new Date(a.payment_date || 0).getTime();
      const right = new Date(b.payment_date || 0).getTime();
      return right - left;
    }).slice(0, 8);
    const monthlyReport = buildMonthlyDeliveryReport(deliveries, payments);

    res.render('user-dashboard', {
      summary: {
        packagesCount: packages.length,
        deliveriesCount: deliveries.length,
        paidDeliveriesCount,
        overdueDeliveriesCount,
        unpaidDeliveriesCount: unpaidDeliveries.length,
        totalDue
      },
      recentDeliveries,
      recentPayments,
      monthlyReport,
      error: null
    });
  } catch (err) {
    const apiMessage = err.response && err.response.data && err.response.data.message;
    const backendOffline = err.code === 'ECONNREFUSED';
    const message = backendOffline
      ? 'Cannot reach backend API on http://localhost:4000. Start it with: npm run backend'
      : apiMessage
        ? `Unable to load dashboard data: ${apiMessage}`
        : 'Unable to load dashboard data right now.';

    console.error('User dashboard load failed:', err.message);
    return res.render('user-dashboard', {
      summary: {
        packagesCount: 0,
        deliveriesCount: 0,
        paidDeliveriesCount: 0,
        overdueDeliveriesCount: 0,
        unpaidDeliveriesCount: 0,
        totalDue: 0
      },
      recentDeliveries: [],
      recentPayments: [],
      monthlyReport: [],
      error: message
    });
  }
});

// [USER] List all users for admin management.
app.get('/users', requireAdmin, async (req, res) => {
  try {
    const response = await axios.get(base_url + '/users');
    res.render('users', { users: response.data });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error loading users');
  }
});

// [USER][REPORT] Show one user with deliveries, payments, and monthly report.
app.get('/user/:id', requireAdmin, async (req, res) => {
  try {
    const printMode = String(req.query.print || "").trim() === "1";

    // Fetch user
    const userResp = await axios.get(`${base_url}/users/${req.params.id}`);
    const user = userResp.data;

    // Fetch all packages and filter for this user
    const packagesResp = await axios.get(`${base_url}/packages`);
    const allPackages = packagesResp.data || [];
    const userPackages = allPackages.filter(p => String(p.user_id) === String(user.id || user.user_id));

    // Fetch delivery services to map service_id to name
    const servicesResp = await axios.get(`${base_url}/delivery-services`);
    const deliveryServices = servicesResp.data || [];
    const serviceMap = {};
    deliveryServices.forEach(s => { serviceMap[s.service_id] = s.service_name; });

    // Attach service_name to each package
    userPackages.forEach(p => { p.service_name = serviceMap[p.service_id] || null; });

    // Fetch deliveries and link to packages
    const deliveriesResp = await axios.get(`${base_url}/deliveries`);
    const allDeliveries = deliveriesResp.data || [];
    // deliveries by package id
    const deliveriesByPackage = {};
    allDeliveries.forEach(d => {
      const pid = String(d.package_id);
      deliveriesByPackage[pid] = deliveriesByPackage[pid] || [];
      deliveriesByPackage[pid].push(d);
    });

    // Attach deliveries to each user package
    userPackages.forEach(p => { p.deliveries = deliveriesByPackage[String(p.package_id)] || []; });

    // Fetch payments
    const paymentsResp = await axios.get(`${base_url}/payments`);
    const allPayments = paymentsResp.data || [];
    const userDeliveries = [];
    userPackages.forEach((pack) => {
      const packageDeliveries = Array.isArray(pack.deliveries) ? pack.deliveries : [];
      packageDeliveries.forEach((delivery) => {
        userDeliveries.push(delivery);
      });
    });
    const userDeliveryIdSet = new Set(
      userDeliveries
        .map((delivery) => String(delivery.delivery_id || delivery.id || "").trim())
        .filter((deliveryId) => !!deliveryId)
    );
    const userPayments = allPayments.filter((payment) =>
      userDeliveryIdSet.has(String(payment.delivery_id || "").trim())
    );
    const monthlyReport = buildMonthlyDeliveryReport(userDeliveries, userPayments);
    const generatedAt = new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date());

    res.render('user', {
      user,
      packages: userPackages,
      payments: userPayments,
      monthlyReport,
      printMode,
      generatedAt
    });
  } catch (err) {
    console.error(err && err.message ? err.message : err);
    res.status(500).send('Error loading user');
  }
});

// [DELIVERY][PAYMENT] Print open shipping invoices for one user.
app.get('/user/:id/invoices', requireAdmin, async (req, res) => {
  const printMode = String(req.query.print || "").trim() === "1";

  try {
    const [userResp, packagesResp, deliveriesResp, deliveryServicesResp] = await Promise.all([
      axios.get(`${base_url}/users/${req.params.id}`),
      axios.get(`${base_url}/packages`),
      axios.get(`${base_url}/deliveries`),
      axios.get(`${base_url}/delivery-services`)
    ]);

    const user = userResp.data || {};
    const userId = String(user.user_id || user.id || "").trim();
    const packages = (packagesResp.data || []).filter(
      (pack) => String(pack.user_id) === userId
    );
    const packageById = {};
    packages.forEach((pack) => {
      packageById[String(pack.package_id)] = pack;
    });
    const packageIds = new Set(Object.keys(packageById));

    const serviceNameById = {};
    (deliveryServicesResp.data || []).forEach((service) => {
      serviceNameById[String(service.service_id)] = service.service_name;
    });

    const openDeliveries = (deliveriesResp.data || [])
      .filter((delivery) => {
        const packageId = String(delivery.package_id || "").trim();
        const status = String(delivery.status || "").toLowerCase().trim();
        return packageIds.has(packageId) && (status === "unpaid" || status === "overdue");
      })
      .map((delivery) => {
        const packageId = String(delivery.package_id || "").trim();
        const pack = packageById[packageId] || null;
        const serviceName = pack ? serviceNameById[String(pack.service_id)] || null : null;
        return {
          ...delivery,
          tracking_number: pack ? (pack.tracking_number || pack.meter_reading || null) : null,
          service_name: serviceName
        };
      })
      .sort((left, right) => {
        const leftTime = new Date(left.due_date || 0).getTime();
        const rightTime = new Date(right.due_date || 0).getTime();
        return leftTime - rightTime;
      });

    const totalDue = openDeliveries.reduce((sum, delivery) => {
      const amount = Number.parseFloat(delivery.amount);
      return sum + (Number.isFinite(amount) ? amount : 0);
    }, 0);
    const generatedAt = new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date());

    return res.render('user-invoices', {
      user,
      deliveries: openDeliveries,
      totalDue,
      generatedAt,
      printMode
    });
  } catch (err) {
    const status = err.response && err.response.status;
    if (status === 404) {
      return res.status(404).send('User not found');
    }

    console.error('User shipping invoice collection load failed:', err.message);
    return res.status(500).send('Error loading user shipping invoices');
  }
});

// [PACKAGE] List all packages with delivery service labels.
app.get('/packages', requireAdmin, async (req, res) => {
  try {
    const resp = await axios.get(`${base_url}/packages`);
    const packages = resp.data || [];
    const servicesResp = await axios.get(`${base_url}/delivery-services`);
    const deliveryServices = servicesResp.data || [];
    const serviceMap = {};
    deliveryServices.forEach(s => { serviceMap[s.service_id] = s.service_name; });
    packages.forEach(p => { p.service_name = serviceMap[p.service_id] || null; });
    res.render('packages', { packages });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error loading packages');
  }
});

// [DELIVERY] List deliveries (filtered by ownership for non-admins).
app.get('/deliveries', requireAuth, async (req, res) => {
  try {
    const [deliveriesResp, packagesResp, paymentsResp] = await Promise.all([
      axios.get(`${base_url}/deliveries`),
      axios.get(`${base_url}/packages`),
      axios.get(`${base_url}/payments`)
    ]);
    const allDeliveries = deliveriesResp.data || [];
    const allPackages = packagesResp.data || [];
    const allPayments = paymentsResp.data || [];
    let deliveryPool = allDeliveries;
    let paymentPool = allPayments;
    const nameFilterRaw = String(req.query.name || "").trim();
    const nameFilter = nameFilterRaw.toLowerCase();
    const paymentMethodQuery = String(req.query.payment_method || "").trim();
    const selectedPaymentMethod = !paymentMethodQuery || paymentMethodQuery.toLowerCase() === "all"
      ? "all"
      : (normalizePaymentMethod(paymentMethodQuery) || "all");
    const paymentStatusQuery = String(req.query.payment_status || "all").toLowerCase().trim();
    const selectedPaymentStatus = paymentStatusQuery === "paid" || paymentStatusQuery === "unpaid"
      ? paymentStatusQuery
      : "all";
    const isAdmin = req.currentRole === "admin";
    const myPackages = isAdmin
      ? []
      : allPackages.filter((pack) => String(pack.user_id) === String(req.currentUser.user_id));

    if (!isAdmin) {
      const packageIdsWithDelivery = new Set(
        deliveryPool.map((delivery) => String(delivery.package_id))
      );
      const missingPackages = myPackages
        .map((pack) => ({
          packageId: Number.parseInt(pack.package_id, 10),
          weight: pack.weight,
          packageStatus: String(pack.package_status || "active").toLowerCase().trim()
        }))
        .filter((item) => Number.isFinite(item.packageId) && item.packageId > 0)
        .filter((item) => item.packageStatus !== "cancelled")
        .filter((item) => !packageIdsWithDelivery.has(String(item.packageId)));

      if (missingPackages.length) {
        await Promise.all(
          missingPackages.map(async ({ packageId, weight }) => {
            try {
              await axios.post(
                `${base_url}/deliveries`,
                buildCustomerAutoDeliveryPayload(packageId, weight)
              );
            } catch (autoCreateErr) {
              console.error(
                `Auto-create delivery failed for package ${packageId}:`,
                autoCreateErr.message
              );
            }
          })
        );

        const [refreshDeliveriesResp, refreshPaymentsResp] = await Promise.all([
          axios.get(`${base_url}/deliveries`),
          axios.get(`${base_url}/payments`)
        ]);
        deliveryPool = refreshDeliveriesResp.data || [];
        paymentPool = refreshPaymentsResp.data || [];
      }
    }

    const packageById = new Map(
      allPackages.map((pack) => [String(pack.package_id), pack])
    );
    const paymentByDeliveryId = new Map(
      paymentPool.map((payment) => [String(payment.delivery_id), payment])
    );
    const myPackageIds = new Set(
      myPackages.map((pack) => String(pack.package_id))
    );

    let deliveries = isAdmin
      ? deliveryPool
      : deliveryPool.filter((delivery) => myPackageIds.has(String(delivery.package_id)));

    deliveries = deliveries.map((delivery) => {
      const pack = packageById.get(String(delivery.package_id)) || null;
      const payment = paymentByDeliveryId.get(String(delivery.delivery_id)) || null;
      const method = normalizePaymentMethod(
        (payment && payment.payment_method) || delivery.payment_method
      ) || "online_bank";
      const packageStatus = String(pack && pack.package_status ? pack.package_status : "active")
        .toLowerCase()
        .trim() || "active";
      const orderStatus = packageStatus === "cancelled"
        ? "cancelled"
        : (normalizeOrderStatus(delivery.order_status) || "processing");
      const deliveryStatus = String(delivery.status || "").toLowerCase().trim();
      const rawPaymentStatus = String(payment && payment.payment_status ? payment.payment_status : "")
        .toLowerCase()
        .trim();
      let effectivePaymentStatus = rawPaymentStatus;

      if (!effectivePaymentStatus) {
        if (method === "cod" && orderStatus !== "delivered") {
          effectivePaymentStatus = "pending";
        } else {
          effectivePaymentStatus = deliveryStatus === "paid" ? "paid" : "unpaid";
        }
      }
      if (method === "cod" && orderStatus !== "delivered" && effectivePaymentStatus !== "paid") {
        effectivePaymentStatus = "pending";
      }
      if (packageStatus === "cancelled") {
        effectivePaymentStatus = "cancelled";
      }
      if (effectivePaymentStatus === "pending_payment") {
        // Pending bank/promptpay still behaves as unpaid for customer "Pay Now" action.
        effectivePaymentStatus = "unpaid";
      }

      return {
        ...delivery,
        tracking_number: pack ? (pack.tracking_number || pack.package_reading || null) : null,
        receiver_name: pack ? (pack.receiver_name || null) : null,
        package_status: packageStatus,
        order_status: orderStatus,
        order_status_label: formatOrderStatus(orderStatus),
        payment_method: method,
        payment_status: effectivePaymentStatus,
        payment_status_label: formatPaymentStatus(effectivePaymentStatus)
      };
    });

    if (nameFilter) {
      deliveries = deliveries.filter((delivery) => {
        const receiverName = String(delivery.receiver_name || "").toLowerCase();
        const trackingNumber = String(delivery.tracking_number || "").toLowerCase();
        const deliveryId = String(delivery.delivery_id || "").toLowerCase();
        return receiverName.includes(nameFilter)
          || trackingNumber.includes(nameFilter)
          || deliveryId.includes(nameFilter);
      });
    }

    if (selectedPaymentMethod !== "all") {
      deliveries = deliveries.filter((delivery) => {
        return (normalizePaymentMethod(delivery.payment_method) || "online_bank") === selectedPaymentMethod;
      });
    }

    if (selectedPaymentStatus !== "all") {
      deliveries = deliveries.filter((delivery) => {
        const statusKey = String(delivery.payment_status || "").toLowerCase().trim();
        if (selectedPaymentStatus === "paid") return statusKey === "paid";
        return statusKey === "unpaid" || statusKey === "pending" || statusKey === "pending_payment" || statusKey === "overdue";
      });
    }

    const returnToParams = new URLSearchParams();
    if (nameFilterRaw) returnToParams.set("name", nameFilterRaw);
    if (selectedPaymentMethod !== "all") returnToParams.set("payment_method", selectedPaymentMethod);
    if (selectedPaymentStatus !== "all") returnToParams.set("payment_status", selectedPaymentStatus);
    const returnTo = returnToParams.toString()
      ? `/deliveries?${returnToParams.toString()}`
      : "/deliveries";

    res.render('deliveries', {
      deliveries,
      message: req.query.message || null,
      filters: {
        name: nameFilterRaw,
        paymentMethod: selectedPaymentMethod,
        paymentStatus: selectedPaymentStatus
      },
      returnTo
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error loading deliveries');
  }
});

// [DELIVERY] Admin updates order status directly from deliveries list.
app.post('/deliveries/:id/order-status', requireAdmin, async (req, res) => {
  const deliveryId = Number.parseInt(req.params.id, 10);
  const orderStatus = normalizeOrderStatus(req.body.order_status);
  const returnTo = safeRedirectPath(req.body.return_to || '/deliveries');

  if (!Number.isFinite(deliveryId) || deliveryId <= 0) {
    return res.redirect(withNotice(returnTo, 'Invalid delivery id.', 'error'));
  }
  if (!orderStatus) {
    return res.redirect(
      withNotice(
        returnTo,
        'Order status must be one of: Processing, In Transit, Delivered.',
        'error'
      )
    );
  }

  try {
    const response = await axios.put(
      `${base_url}/deliveries/${deliveryId}/order-status`,
      { order_status: orderStatus }
    );
    const data = response.data || {};
    const message = data.message || `Order status updated to ${formatOrderStatus(orderStatus)}.`;
    return res.redirect(withNotice(returnTo, message, 'success'));
  } catch (err) {
    const apiMessage = err.response && err.response.data && err.response.data.message;
    const message = apiMessage || 'Failed to update order status.';
    return res.redirect(withNotice(returnTo, message, 'error'));
  }
});

// [DELIVERY] Customer cancellation for paid non-COD deliveries in pending/processing stage.
app.post('/deliveries/:id/cancel', requireAuth, async (req, res) => {
  const deliveryId = Number.parseInt(req.params.id, 10);
  const returnTo = safeRedirectPath(req.body.return_to || '/deliveries');

  if (!Number.isFinite(deliveryId) || deliveryId <= 0) {
    return res.redirect(withNotice(returnTo, 'Invalid delivery id.', 'error'));
  }
  if (req.currentRole === "admin") {
    return res.redirect(withNotice(returnTo, 'Customer cancellation is only available for customer accounts.', 'error'));
  }

  try {
    const [deliveryResp, packagesResp] = await Promise.all([
      axios.get(`${base_url}/deliveries/${deliveryId}`),
      axios.get(`${base_url}/packages`)
    ]);
    const delivery = deliveryResp.data || null;
    if (!delivery) {
      return res.redirect(withNotice(returnTo, 'Delivery not found.', 'error'));
    }

    const pack = (packagesResp.data || []).find(
      (item) => String(item.package_id) === String(delivery.package_id)
    ) || null;
    if (!pack || String(pack.user_id) !== String(req.currentUser.user_id)) {
      return res.status(403).render('access-denied', {
        message: "You can only cancel your own deliveries."
      });
    }

    const response = await axios.post(
      `${base_url}/deliveries/${deliveryId}/cancel`,
      { user_id: req.currentUser.user_id }
    );
    const data = response.data || {};
    const message = data.message || 'Delivery cancelled successfully.';
    return res.redirect(withNotice(returnTo, message, 'success'));
  } catch (err) {
    const apiMessage = err.response && err.response.data && err.response.data.message;
    const message = apiMessage || 'Failed to cancel delivery.';
    return res.redirect(withNotice(returnTo, message, 'error'));
  }
});

// [PAYMENT] Render customer payment page for one delivery.
app.get('/payments/:deliveryId', requireAuth, async (req, res) => {
  try {
    const deliveryResp = await axios.get(`${base_url}/deliveries/${req.params.deliveryId}`);
    const delivery = deliveryResp.data || {};
    const [packagesResp, paymentsResp] = await Promise.all([
      axios.get(`${base_url}/packages`),
      axios.get(`${base_url}/payments`)
    ]);
    const pack = (packagesResp.data || []).find(
      (item) => String(item.package_id) === String(delivery.package_id)
    ) || null;
    const deliveryMethod = normalizePaymentMethod(delivery.payment_method) || "online_bank";
    const orderStatus = normalizeOrderStatus(delivery.order_status) || "processing";

    if (req.currentRole !== "admin") {
      const ownsDelivery = pack && String(pack.user_id) === String(req.currentUser.user_id);
      if (!ownsDelivery) {
        return res.status(403).render('access-denied', {
          message: "You can only pay your own deliveries."
        });
      }
    }

    const paymentRaw = (paymentsResp.data || [])
      .filter((payment) => String(payment.delivery_id) === String(delivery.delivery_id))
      .sort((left, right) => {
        const leftTime = new Date(left.payment_date || left.paid_at || 0).getTime();
        const rightTime = new Date(right.payment_date || right.paid_at || 0).getTime();
        if (rightTime !== leftTime) return rightTime - leftTime;
        const leftId = Number.parseInt(left.payment_id, 10);
        const rightId = Number.parseInt(right.payment_id, 10);
        if (Number.isFinite(leftId) && Number.isFinite(rightId)) return rightId - leftId;
        return 0;
      })[0] || null;
    const payment = paymentRaw
      ? (() => {
        const method = normalizePaymentMethod(paymentRaw.payment_method) || "online_bank";
        const rawStatus = String(paymentRaw.payment_status || "").toLowerCase().trim();
        const fallbackStatus = method === "cod" && orderStatus !== "delivered"
          ? "pending"
          : (String(delivery.status || "").toLowerCase().trim() === "paid" ? "paid" : "unpaid");
        const status = rawStatus || fallbackStatus;
        return {
          ...paymentRaw,
          payment_method: method,
          payment_method_label: formatPaymentMethod(method),
          payment_status: status,
          payment_status_label: formatPaymentStatus(status)
        };
      })()
      : null;

    return res.render('payment-checkout', {
      delivery: {
        ...delivery,
        payment_method: deliveryMethod,
        order_status: orderStatus,
        package_status: pack ? (pack.package_status || "active") : "active",
        tracking_number: pack ? (pack.tracking_number || pack.package_reading || null) : null,
        receiver_name: pack ? (pack.receiver_name || null) : null
      },
      existingPayment: payment,
      error: req.query.error || null
    });
  } catch (err) {
    const status = err.response && err.response.status;
    if (status === 404) {
      return res.status(404).send('Delivery not found');
    }
    console.error(err.message);
    return res.status(500).send('Error loading payment page');
  }
});

// [PAYMENT] Submit customer payment and redirect to deliveries.
app.post('/payments/:deliveryId', requireAuth, async (req, res) => {
  try {
    const deliveryResp = await axios.get(`${base_url}/deliveries/${req.params.deliveryId}`);
    const delivery = deliveryResp.data || {};
    const packagesResp = await axios.get(`${base_url}/packages`);
    const pack = (packagesResp.data || []).find(
      (item) => String(item.package_id) === String(delivery.package_id)
    ) || null;

    if (req.currentRole !== "admin") {
      const ownsDelivery = pack && String(pack.user_id) === String(req.currentUser.user_id);
      if (!ownsDelivery) {
        return res.status(403).render('access-denied', {
          message: "You can only pay your own deliveries."
        });
      }
    }

    const selectedMethod = normalizePaymentMethod(req.body.payment_method)
      || normalizePaymentMethod(delivery.payment_method)
      || "online_bank";
    const deliveryMethod = normalizePaymentMethod(delivery.payment_method) || "online_bank";
    if (deliveryMethod === "cod" || selectedMethod === "cod") {
      await axios.put(`${base_url}/deliveries/${req.params.deliveryId}/payment-method`, {
        payment_method: "cod"
      });
      return res.redirect('/deliveries');
    }
    const payload = {
      delivery_id: req.params.deliveryId,
      payment_method: selectedMethod
    };
    const payResp = await axios.post(`${base_url}/payments`, payload);
    const payData = payResp.data || {};
    const noticeMessage = payData.message || (
      String(payData.payment_status || "").toLowerCase() === "paid"
        ? "Payment completed successfully."
        : "Payment submitted successfully."
    );
    const noticeType = String(payData.payment_status || "").toLowerCase() === "paid"
      ? "success"
      : "warning";
    return res.redirect(withNotice('/deliveries', noticeMessage, noticeType));
  } catch (err) {
    const apiMessage = err.response && err.response.data && err.response.data.message;
    const message = apiMessage || 'Payment failed';
    return res.redirect(withNotice(`/payments/${req.params.deliveryId}`, message, "error"));
  }
});

// [DELIVERY][REPORT] Render single shipping invoice (with print mode).
app.get('/invoice/:deliveryId', requireAuth, async (req, res) => {
  const printMode = String(req.query.print || "").trim() === "1";

  try {
    const deliveryResp = await axios.get(`${base_url}/deliveries/${req.params.deliveryId}`);
    const delivery = deliveryResp.data || null;
    if (!delivery) {
      return res.status(404).send('Shipping Invoice not found');
    }

    const [packagesResp, deliveryServicesResp, paymentsResp] = await Promise.all([
      axios.get(`${base_url}/packages`),
      axios.get(`${base_url}/delivery-services`),
      axios.get(`${base_url}/payments`)
    ]);

    const pack = (packagesResp.data || []).find(
      (p) => String(p.package_id) === String(delivery.package_id)
    ) || null;

    if (req.currentUser.role !== "admin") {
      const ownsDelivery = pack && String(pack.user_id) === String(req.currentUser.user_id);
      if (!ownsDelivery) {
        return res.status(403).render('access-denied', {
          message: "You can only print shipping invoices for your own deliveries."
        });
      }
    }

    const service = (deliveryServicesResp.data || []).find(
      (s) => String(s.service_id) === String(pack && pack.service_id)
    ) || null;
    const payment = (paymentsResp.data || [])
      .filter((p) => String(p.delivery_id) === String(delivery.delivery_id))
      .sort((left, right) => {
        const leftTime = new Date(left.payment_date || left.paid_at || 0).getTime();
        const rightTime = new Date(right.payment_date || right.paid_at || 0).getTime();
        if (rightTime !== leftTime) return rightTime - leftTime;
        const leftId = Number.parseInt(left.payment_id, 10);
        const rightId = Number.parseInt(right.payment_id, 10);
        if (Number.isFinite(leftId) && Number.isFinite(rightId)) return rightId - leftId;
        return 0;
      })[0] || null;

    let accountUser = null;
    if (pack && pack.user_id) {
      try {
        const userResp = await axios.get(`${base_url}/users/${pack.user_id}`);
        accountUser = userResp.data || null;
      } catch (userErr) {
        accountUser = null;
      }
    }

    if (!accountUser && req.currentUser) {
      accountUser = req.currentUser;
    }

    const accountUsername = deriveUsername(accountUser || {});
    const generatedAt = new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date());

    return res.render('invoice', {
      delivery,
      package: pack,
      deliveryService: service,
      payment,
      accountUser,
      accountUsername,
      generatedAt,
      printMode
    });
  } catch (err) {
    const status = err.response && err.response.status;
    if (status === 404) {
      return res.status(404).send('Shipping Invoice not found');
    }
    console.error('Shipping Invoice load failed:', err.message);
    return res.status(500).send('Error loading shipping invoice');
  }
});

// [DELIVERY SERVICE] List delivery service types.
app.get('/delivery-services', requireAdmin, async (req, res) => {
  try {
    const resp = await axios.get(`${base_url}/delivery-services`);
    res.render('delivery-services', { deliveryServices: resp.data || [] });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error loading delivery services');
  }
});

// [DELIVERY SERVICE] Render create-delivery-service form.
app.get("/create-delivery-service", requireAdmin, (req, res) => {
  res.render("create-delivery-service");
});

// [DELIVERY SERVICE] Create a delivery service record.
app.post("/create-delivery-service", requireAdmin, async (req, res) => {
  try {
    const parsedPriceRate = Number.parseFloat(req.body.price_rate);
    const priceRate = Number.isFinite(parsedPriceRate)
      ? Math.round(parsedPriceRate * 100) / 100
      : null;
    const data = {
      service_name: req.body.service_name,
      price_rate: priceRate
    };
    await axios.post(base_url + '/delivery-services', data);
    res.redirect("/delivery-services");
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error creating delivery service');
  }
});

// [PAYMENT] List payments (filtered for non-admin users).
app.get('/payments', requireAuth, async (req, res) => {
  try {
    const [paymentsResp, deliveriesResp] = await Promise.all([
      axios.get(`${base_url}/payments`),
      axios.get(`${base_url}/deliveries`)
    ]);
    let payments = paymentsResp.data || [];
    const deliveries = deliveriesResp.data || [];
    const deliveryAmountById = new Map(
      deliveries.map((delivery) => [
        String(delivery.delivery_id),
        Number.parseFloat(delivery.amount)
      ])
    );

    if (!req.currentUser.role || req.currentUser.role !== "admin") {
      const currentUserId = String(req.currentUser.user_id);
      const directPayments = payments.filter(
        (payment) => String(payment.user_id || "").trim() === currentUserId
      );
      const needsFallbackFilter = payments.some(
        (payment) => String(payment.user_id || "").trim() === ""
      );

      if (!needsFallbackFilter) {
        payments = directPayments;
      } else {
        const packagesResp = await axios.get(`${base_url}/packages`);
        const myPackageIds = new Set(
          (packagesResp.data || [])
            .filter((p) => String(p.user_id) === currentUserId)
            .map((p) => String(p.package_id))
        );
        const myDeliveryIds = new Set(
          deliveries
            .filter((d) => myPackageIds.has(String(d.package_id)))
            .map((d) => String(d.delivery_id))
        );
        const fallbackPayments = payments.filter((payment) => {
          if (String(payment.user_id || "").trim() !== "") return false;
          return myDeliveryIds.has(String(payment.delivery_id));
        });

        const mergedByKey = new Map();
        [...directPayments, ...fallbackPayments].forEach((payment) => {
          const key = String(payment.payment_id || payment.delivery_id || "");
          if (!key) return;
          mergedByKey.set(key, payment);
        });
        payments = Array.from(mergedByKey.values());
      }
    }

    payments = payments.map((payment) => {
      const method = normalizePaymentMethod(payment.payment_method) || "online_bank";
      const statusRaw = String(payment.payment_status || "").toLowerCase().trim();
      const status = statusRaw || (method === "cod" ? "pending" : "pending_payment");
      const rawAmount = deliveryAmountById.get(String(payment.delivery_id));
      const costAmount = Number.isFinite(rawAmount)
        ? Math.round(rawAmount * 100) / 100
        : null;
      return {
        ...payment,
        payment_method: method,
        payment_method_label: formatPaymentMethod(method),
        payment_status: status,
        payment_status_label: formatPaymentStatus(status),
        cost_amount: costAmount
      };
    });

    const successMessage = req.query.paid === "1"
      ? "Payment completed successfully."
      : null;
    res.render('payments', {
      payments,
      message: req.query.message || successMessage
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error loading payments');
  }
});

// [PAYMENT] Admin approval for pending online-bank/promptpay payments.
app.post('/payments/:id/approve', requireAdmin, async (req, res) => {
  const paymentId = String(req.params.id || "").trim();
  const returnTo = req.body.return_to && String(req.body.return_to).trim()
    ? String(req.body.return_to).trim()
    : '/admin-dashboard';

  try {
    const response = await axios.put(`${base_url}/payments/${paymentId}/approve`);
    const message = response.data && response.data.message
      ? response.data.message
      : 'Payment approved.';
    return res.redirect(withNotice(returnTo, message, "success"));
  } catch (err) {
    const apiMessage = err.response && err.response.data && err.response.data.message;
    const message = apiMessage || "Failed to approve payment";
    return res.redirect(withNotice(returnTo, message, "error"));
  }
});

// [PAYMENT] Render pay-delivery page with ownership validation.
app.get('/pay-delivery/:deliveryId', requireAuth, async (req, res) => {
  try {
    const deliveryResp = await axios.get(`${base_url}/deliveries/${req.params.deliveryId}`);
    const delivery = deliveryResp.data;
    delivery.payment_method = normalizePaymentMethod(delivery.payment_method) || "online_bank";
    delivery.order_status = normalizeOrderStatus(delivery.order_status) || "processing";

    if (req.currentUser.role !== "admin") {
      const packagesResp = await axios.get(`${base_url}/packages`);
      const ownsDelivery = (packagesResp.data || []).some(
        (p) =>
          String(p.package_id) === String(delivery.package_id) &&
          String(p.user_id) === String(req.currentUser.user_id)
      );

      if (!ownsDelivery) {
        return res.status(403).render('access-denied', {
          message: "You can only pay your own deliveries."
        });
      }
    }

    const paymentsResp = await axios.get(`${base_url}/payments`);
    const existingPaymentRaw = (paymentsResp.data || [])
      .filter((p) => String(p.delivery_id) === String(delivery.delivery_id))
      .sort((left, right) => {
        const leftTime = new Date(left.payment_date || left.paid_at || 0).getTime();
        const rightTime = new Date(right.payment_date || right.paid_at || 0).getTime();
        if (rightTime !== leftTime) return rightTime - leftTime;
        const leftId = Number.parseInt(left.payment_id, 10);
        const rightId = Number.parseInt(right.payment_id, 10);
        if (Number.isFinite(leftId) && Number.isFinite(rightId)) return rightId - leftId;
        return 0;
      })[0] || null;
    const existingPayment = existingPaymentRaw
      ? (() => {
        const method = normalizePaymentMethod(existingPaymentRaw.payment_method) || "online_bank";
        const statusRaw = String(existingPaymentRaw.payment_status || "").toLowerCase().trim();
        const fallbackStatus = method === "cod" && delivery.order_status !== "delivered"
          ? "pending"
          : (String(delivery.status || "").toLowerCase().trim() === "paid" ? "paid" : "pending_payment");
        const status = statusRaw || fallbackStatus;
        return {
          ...existingPaymentRaw,
          payment_method: method,
          payment_method_label: formatPaymentMethod(method),
          payment_status: status,
          payment_status_label: formatPaymentStatus(status)
        };
      })()
      : null;

    res.render('pay-delivery', {
      delivery,
      existingPayment,
      error: req.query.error || null
    });
  } catch (err) {
    const status = err.response && err.response.status;
    if (status === 404) {
      return res.status(404).send('Delivery not found');
    }
    console.error(err.message);
    res.status(500).send('Error loading payment page');
  }
});

// [PAYMENT] Submit payment and update delivery status.
app.post('/pay-delivery/:deliveryId', requireAuth, async (req, res) => {
  try {
    const deliveryResp = await axios.get(`${base_url}/deliveries/${req.params.deliveryId}`);
    const delivery = deliveryResp.data || {};

    if (req.currentUser.role !== "admin") {
      const packagesResp = await axios.get(`${base_url}/packages`);
      const ownsDelivery = (packagesResp.data || []).some(
        (p) =>
          String(p.package_id) === String(delivery.package_id) &&
          String(p.user_id) === String(req.currentUser.user_id)
      );

      if (!ownsDelivery) {
        return res.status(403).render('access-denied', {
          message: "You can only pay your own deliveries."
        });
      }
    }

    const preferredMethod = normalizePaymentMethod(delivery.payment_method) || "online_bank";
    const selectedMethod = normalizePaymentMethod(req.body.payment_method) || preferredMethod;
    if (preferredMethod === "cod" || selectedMethod === "cod") {
      await axios.put(`${base_url}/deliveries/${req.params.deliveryId}/payment-method`, {
        payment_method: "cod"
      });
      return res.redirect('/deliveries');
    }
    const payload = {
      delivery_id: req.params.deliveryId,
      payment_method: selectedMethod
    };
    const payResp = await axios.post(`${base_url}/payments`, payload);
    const payData = payResp.data || {};
    const noticeMessage = payData.message || (
      String(payData.payment_status || "").toLowerCase() === "paid"
        ? "Payment completed successfully."
        : "Payment submitted successfully."
    );
    const noticeType = String(payData.payment_status || "").toLowerCase() === "paid"
      ? "success"
      : "warning";
    res.redirect(withNotice(
      '/payments',
      noticeMessage,
      noticeType
    ));
  } catch (err) {
    const apiMessage = err.response && err.response.data && err.response.data.message;
    const message = apiMessage || 'Payment failed';
    res.redirect(withNotice(`/pay-delivery/${req.params.deliveryId}`, message, "error"));
  }
});

// [USER] Render create-user form.
app.get("/create", requireAdmin, (req, res) => {
  res.render("create");
});

// [USER] Create a new user account.
app.post("/create", requireAdmin, async (req, res) => {
  try {
    const data = {
      name: req.body.name,
      email: req.body.email,
      password: req.body.password,
      phone: req.body.phone,
      role: normalizeRole(req.body.role)
    };
    await axios.post(base_url + '/users', data);
    res.redirect("/");
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error creating user');
  }
});

// [USER] Render update-user form.
app.get("/update/:id", requireAdmin, async (req, res) => {
  try {
    const response = await axios.get(base_url + '/users/' + req.params.id);
    res.render("update", { user: response.data });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error loading update page');
  }
});

// [USER] Update existing user fields and role.
app.post("/update/:id", requireAdmin, async (req, res) => {
  try {
    const data = {
      name: req.body.name,
      email: req.body.email,
      phone: req.body.phone,
      role: normalizeRole(req.body.role)
    };
    await axios.put(base_url + '/users/' + req.params.id, data);
    res.redirect("/");
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error updating user');
  }
});

// [USER] Delete user by id.
app.get("/delete/:id", requireAdmin, async (req, res) => {
  try {
    await axios.delete(base_url + '/users/' + req.params.id);
    res.redirect("/");
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error deleting user');
  }
});

// [PACKAGE] Render create-package form with role-based field visibility.
app.get("/create-package", requireAuth, async (req, res) => {
  try {
    const servicesResp = await axios.get(base_url + '/delivery-services');
    const deliveryServices = servicesResp.data || [];
    const isAdmin = req.currentRole === "admin";
    const usersResp = isAdmin ? await axios.get(base_url + '/users') : { data: [] };
    const users = usersResp.data || [];
    const defaultServiceId = getDefaultServiceId(deliveryServices);
    res.render("create-package", {
      users,
      deliveryServices,
      canManualPackageConfig: isAdmin,
      defaultServiceId,
      defaultServiceName: (
        deliveryServices.find((service) => Number.parseInt(service.service_id, 10) === defaultServiceId) || {}
      ).service_name || null,
      backPath: isAdmin ? "/packages" : "/user-dashboard",
      error: null,
      values: {
        tracking_number: "",
        user_id: isAdmin ? "" : String(req.currentUser.user_id || ""),
        service_id: defaultServiceId ? String(defaultServiceId) : "",
        weight: "",
        receiver_name: "",
        receiver_phone: "",
        house_number: "",
        village_no: "",
        soi: "",
        road: "",
        subdistrict: "",
        district: "",
        province: "",
        postal_code: ""
      }
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error loading create package page');
  }
});

// [PACKAGE] Validate and create a package record with role-based restrictions.
app.post("/create-package", requireAuth, async (req, res) => {
  const isAdmin = req.currentRole === "admin";
  const trackingNumber = isAdmin
    ? String(req.body.tracking_number || req.body.meter_reading || "").trim()
    : "";
  const userId = isAdmin
    ? String(req.body.user_id || "").trim()
    : String(req.currentUser.user_id || "").trim();
  const serviceId = String(req.body.service_id || "").trim();
  const rawWeight = String(req.body.weight || "").trim();
  const weight = normalizeWeight(rawWeight);
  const receiverName = String(req.body.receiver_name || "").trim();
  const receiverPhone = digitsOnly(req.body.receiver_phone);
  const houseNumber = String(req.body.house_number || "").trim();
  const villageNo = String(req.body.village_no || "").trim();
  const soi = String(req.body.soi || "").trim();
  const road = String(req.body.road || "").trim();
  const subdistrict = String(req.body.subdistrict || "").trim();
  const district = String(req.body.district || "").trim();
  const province = String(req.body.province || "").trim();
  const postalCode = digitsOnly(req.body.postal_code);
  const data = {
    tracking_number: trackingNumber || undefined,
    user_id: userId,
    service_id: serviceId || undefined,
    weight: rawWeight,
    receiver_name: receiverName,
    receiver_phone: receiverPhone,
    house_number: houseNumber,
    village_no: villageNo,
    soi,
    road,
    subdistrict,
    district,
    province,
    postal_code: postalCode
  };

  const validationMessage = (() => {
    if (!userId) return "User is required.";
    if (isAdmin && !trackingNumber) return "Tracking number is required.";
    if (!serviceId) return "Delivery service is required.";
    if (!Number.isFinite(weight) || weight < minPackageWeight || weight > maxPackageWeight) {
      return `Weight must be between ${minPackageWeight} and ${maxPackageWeight} kg.`;
    }
    if (!receiverName) return "Receiver name is required.";
    if (!/^0\d{9}$/.test(receiverPhone)) return "Receiver phone number must be exactly 10 digits, numeric only, and start with 0.";
    if (!houseNumber) return "House number is required.";
    if (!subdistrict) return "Subdistrict is required.";
    if (!district) return "District is required.";
    if (!province) return "Province is required.";
    if (!/^\d{5}$/.test(postalCode)) return "Postal code must be exactly 5 digits.";
    return null;
  })();

  if (validationMessage) {
    try {
      const servicesResp = await axios.get(base_url + '/delivery-services');
      const deliveryServices = servicesResp.data || [];
      const usersResp = isAdmin ? await axios.get(base_url + '/users') : { data: [] };
      const users = usersResp.data || [];
      const defaultServiceId = getDefaultServiceId(deliveryServices);
      return res.status(400).render("create-package", {
        users,
        deliveryServices,
        canManualPackageConfig: isAdmin,
        defaultServiceId,
        defaultServiceName: (
          deliveryServices.find((service) => Number.parseInt(service.service_id, 10) === defaultServiceId) || {}
        ).service_name || null,
        backPath: isAdmin ? "/packages" : "/user-dashboard",
        error: validationMessage,
        values: data
      });
    } catch (loadErr) {
      console.error('Create package validation fallback load failed:', loadErr.message);
      return res.status(500).send(validationMessage);
    }
  }

  try {
    const packageResp = await axios.post(base_url + '/packages', {
      ...data,
      weight
    });
    if (isAdmin) {
      return res.redirect("/packages");
    }

    const createdPackageId = Number.parseInt(
      packageResp && packageResp.data && packageResp.data.package_id,
      10
    );
    if (!Number.isFinite(createdPackageId) || createdPackageId <= 0) {
      return res.redirect(withNotice(
        "/deliveries",
        "Package created. Please open Deliveries to continue payment.",
        "info"
      ));
    }

    try {
      const deliveryResp = await axios.post(
        `${base_url}/deliveries`,
        buildCustomerAutoDeliveryPayload(createdPackageId, weight)
      );
      const createdDeliveryId = Number.parseInt(
        deliveryResp && deliveryResp.data && deliveryResp.data.delivery_id,
        10
      );

      if (Number.isFinite(createdDeliveryId) && createdDeliveryId > 0) {
        return res.redirect(withNotice(
          `/payments/${createdDeliveryId}`,
          "Package created. You can complete payment now.",
          "info"
        ));
      }
    } catch (deliveryErr) {
      console.error('Auto-create delivery failed after package creation:', deliveryErr.message);
    }

    return res.redirect(withNotice(
      "/deliveries",
      "Package created. Please continue from Deliveries.",
      "info"
    ));
  } catch (err) {
    const apiMessage = err.response && err.response.data && err.response.data.message;
    const message = apiMessage || "Error creating package";
    console.error('Create package failed:', message);

    try {
      const servicesResp = await axios.get(base_url + '/delivery-services');
      const deliveryServices = servicesResp.data || [];
      const usersResp = isAdmin ? await axios.get(base_url + '/users') : { data: [] };
      const users = usersResp.data || [];
      const defaultServiceId = getDefaultServiceId(deliveryServices);
      return res.status(400).render("create-package", {
        users,
        deliveryServices,
        canManualPackageConfig: isAdmin,
        defaultServiceId,
        defaultServiceName: (
          deliveryServices.find((service) => Number.parseInt(service.service_id, 10) === defaultServiceId) || {}
        ).service_name || null,
        backPath: isAdmin ? "/packages" : "/user-dashboard",
        error: message,
        values: data
      });
    } catch (loadErr) {
      console.error('Create package fallback load failed:', loadErr.message);
      return res.status(500).send(message);
    }
  }
});

// [DELIVERY] Render create-delivery form.
app.get("/create-delivery", requireAdmin, async (req, res) => {
  try {
    const packagesResp = await axios.get(base_url + '/packages');
    res.render("create-delivery", { packages: packagesResp.data });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error loading create delivery page');
  }
});

// [DELIVERY] Create delivery record for a package.
app.post("/create-delivery", requireAdmin, async (req, res) => {
  try {
    const paymentMethod = normalizePaymentMethod(req.body.payment_method) || "online_bank";
    const parsedAdditionalCharge = Number.parseFloat(req.body.additional_charge);
    const additionalCharge = Number.isFinite(parsedAdditionalCharge)
      ? Math.round(parsedAdditionalCharge * 100) / 100
      : 0;
    const data = {
      package_id: req.body.package_id,
      delivery_date: req.body.delivery_date,
      due_date: req.body.due_date,
      status: req.body.status || 'unpaid',
      payment_method: paymentMethod,
      order_status: req.body.order_status || 'processing',
      additional_charge: additionalCharge
    };
    await axios.post(base_url + '/deliveries', data);
    res.redirect("/deliveries");
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error creating delivery');
  }
});

app.listen(5500, () => {
  console.log(`Client running at http://localhost:5500`);
});
