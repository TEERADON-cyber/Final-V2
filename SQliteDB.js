const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const app = express();

app.use(express.json());

const ALLOWED_USER_ROLES = new Set(['admin', 'user']);
const ALLOWED_DELIVERY_STATUSES = new Set(['paid', 'unpaid', 'overdue']);
const ALLOWED_ORDER_STATUSES = new Set(['processing', 'in_transit', 'delivered']);
const ALLOWED_PAYMENT_METHODS = new Set(['online_bank', 'cod', 'credit_card', 'promptpay']);
const ALLOWED_PAYMENT_STATUSES = new Set(['pending_payment', 'pending', 'paid', 'cancelled', 'refunded']);
const SHIPPING_BASE_FEE = Number.parseFloat(process.env.SHIPPING_BASE_FEE || '30');
const SHIPPING_PER_KG = Number.parseFloat(process.env.SHIPPING_PER_KG || '20');
const MIN_PACKAGE_WEIGHT = 0.1;
const MAX_PACKAGE_WEIGHT = 125;
const DEFAULT_SHIPPING_BASE_FEE = Number.isFinite(SHIPPING_BASE_FEE) ? SHIPPING_BASE_FEE : 30;
const DEFAULT_SERVICE_PRICE_RATE = Number.isFinite(SHIPPING_PER_KG) ? SHIPPING_PER_KG : 20;

// [AUTH] Normalize role input to supported values.
function normalizeUserRole(role) {
  const input = String(role || '').toLowerCase().trim();
  return ALLOWED_USER_ROLES.has(input) ? input : 'user';
}

// [PAYMENT] Normalize payment method input and map legacy values.
function normalizePaymentMethod(rawMethod) {
  const value = String(rawMethod || '').toLowerCase().trim();
  if (!value) return null;

  const aliases = {
    bank_transfer: 'online_bank',
    bank: 'online_bank',
    online_bank: 'online_bank',
    'online bank': 'online_bank',
    cash: 'cod',
    cash_on_delivery: 'cod',
    cod: 'cod',
    card: 'credit_card',
    credit_card: 'credit_card',
    'credit card': 'credit_card',
    mobile_wallet: 'promptpay',
    prompt_pay: 'promptpay',
    promptpay: 'promptpay'
  };

  const normalized = aliases[value] || value;
  return ALLOWED_PAYMENT_METHODS.has(normalized) ? normalized : null;
}

// [DELIVERY] Normalize status input.
function normalizeDeliveryStatus(rawStatus, fallback = 'unpaid') {
  const value = String(rawStatus || '').toLowerCase().trim();
  return ALLOWED_DELIVERY_STATUSES.has(value) ? value : fallback;
}

// [DELIVERY] Normalize order status input.
function normalizeOrderStatus(rawStatus, fallback = 'processing') {
  const value = String(rawStatus || '').toLowerCase().trim();
  return ALLOWED_ORDER_STATUSES.has(value) ? value : fallback;
}

// [PAYMENT] Resolve payment status from method-specific business rules.
function resolvePaymentStatusByMethod(method) {
  if (method === 'credit_card') return 'paid';
  if (method === 'cod') return 'pending';
  return 'pending_payment';
}

// [PACKAGE] Normalize package weight value.
function normalizeWeight(rawWeight) {
  const parsedWeight = Number.parseFloat(rawWeight);
  if (!Number.isFinite(parsedWeight)) return null;
  const roundedWeight = Math.round(parsedWeight * 100) / 100;
  return roundedWeight;
}

// [DELIVERY] Calculate shipping amount from package weight.
function calculateShippingAmount(weight, serviceRatePerKg = DEFAULT_SERVICE_PRICE_RATE, additionalCharge = 0) {
  const safeWeight = normalizeWeight(weight);
  if (!Number.isFinite(safeWeight) || safeWeight <= 0) return null;

  const parsedRate = Number.parseFloat(serviceRatePerKg);
  const safeRate = Number.isFinite(parsedRate) && parsedRate > 0
    ? Math.round(parsedRate * 100) / 100
    : DEFAULT_SERVICE_PRICE_RATE;
  const parsedAdditional = Number.parseFloat(additionalCharge);
  const safeAdditionalCharge = Number.isFinite(parsedAdditional) && parsedAdditional > 0
    ? Math.round(parsedAdditional * 100) / 100
    : 0;
  const amount = DEFAULT_SHIPPING_BASE_FEE + (safeRate * safeWeight) + safeAdditionalCharge;
  return Math.round(amount * 100) / 100;
}

// [MIGRATION] Ignore duplicate-column errors for backward compatibility.
function isDuplicateColumnError(err) {
  const message = String(err && err.message ? err.message : '').toLowerCase();
  return message.includes('duplicate column name');
}

// [PACKAGE] Generate tracking number for auto-created package records.
function generateTrackingNumber() {
  const timestamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const randomSuffix = Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0');
  return `PKG${timestamp}${randomSuffix}`;
}

// ==========================
// CONNECT DATABASE
// ==========================
const db = new sqlite3.Database("./Database/postal_delivery.db");

db.serialize(() => {
  db.run("PRAGMA foreign_keys = ON");

  // USERS
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      phone TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Backward compatibility for existing DBs created before role existed.
  db.run(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'`, (alterErr) => {
    const message = String(alterErr && alterErr.message ? alterErr.message : '').toLowerCase();
    const duplicateColumn = message.includes('duplicate column name');
    if (alterErr && !duplicateColumn) {
      console.error('Failed to ensure users.role column:', alterErr.message);
    }

    db.run(
      `INSERT INTO users (name,email,password,phone,role)
       SELECT ?,?,?,?,?
       WHERE NOT EXISTS (SELECT 1 FROM users WHERE lower(email) = lower(?))`,
      ['System Administrator', 'admin@postal.local', 'admin123', null, 'admin', 'admin@postal.local']
    );

    db.run(
      `INSERT INTO users (name,email,password,phone,role)
       SELECT ?,?,?,?,?
       WHERE NOT EXISTS (SELECT 1 FROM users WHERE lower(email) = lower(?))`,
      ['Normal User', 'user@postal.local', 'user123', null, 'user', 'user@postal.local']
    );
  });

  // DELIVERY_SERVICES (formerly utilities)
  db.run(`
    CREATE TABLE IF NOT EXISTS delivery_services (
      service_id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_name TEXT NOT NULL UNIQUE,
      price_rate REAL NOT NULL DEFAULT ${DEFAULT_SERVICE_PRICE_RATE}
    )
  `);

  // PACKAGE_DRAFTS (customer pre-payment stage)
  db.run(`
    CREATE TABLE IF NOT EXISTS package_drafts (
      draft_id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      service_id INTEGER NOT NULL,
      weight REAL NOT NULL,
      receiver_name TEXT NOT NULL,
      receiver_phone TEXT NOT NULL,
      house_number TEXT NOT NULL,
      village_no TEXT,
      soi TEXT,
      road TEXT,
      subdistrict TEXT NOT NULL,
      district TEXT NOT NULL,
      province TEXT NOT NULL,
      postal_code TEXT NOT NULL,
      payment_method TEXT NOT NULL DEFAULT 'online_bank' CHECK(payment_method IN ('online_bank','cod','credit_card','promptpay')),
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending_payment')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
      FOREIGN KEY (service_id) REFERENCES delivery_services(service_id)
    )
  `);

  // PACKAGES (formerly meters)
  db.run(`
    CREATE TABLE IF NOT EXISTS packages (
      package_id INTEGER PRIMARY KEY AUTOINCREMENT,
      tracking_number TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL,
      service_id INTEGER NOT NULL,
      weight REAL NOT NULL DEFAULT 1,
      package_status TEXT NOT NULL DEFAULT 'active' CHECK(package_status IN ('active','cancelled')),
      receiver_name TEXT,
      receiver_phone TEXT,
      house_number TEXT,
      village_no TEXT,
      soi TEXT,
      road TEXT,
      subdistrict TEXT,
      district TEXT,
      province TEXT,
      postal_code TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
      FOREIGN KEY (service_id) REFERENCES delivery_services(service_id)
    )
  `);

  // Backward compatibility for DBs created before receiver-address structure existed.
  const packageColumnMigrations = [
    `ALTER TABLE packages ADD COLUMN weight REAL NOT NULL DEFAULT 1`,
    `ALTER TABLE packages ADD COLUMN receiver_name TEXT`,
    `ALTER TABLE packages ADD COLUMN receiver_phone TEXT`,
    `ALTER TABLE packages ADD COLUMN house_number TEXT`,
    `ALTER TABLE packages ADD COLUMN village_no TEXT`,
    `ALTER TABLE packages ADD COLUMN soi TEXT`,
    `ALTER TABLE packages ADD COLUMN road TEXT`,
    `ALTER TABLE packages ADD COLUMN subdistrict TEXT`,
    `ALTER TABLE packages ADD COLUMN district TEXT`,
    `ALTER TABLE packages ADD COLUMN province TEXT`,
    `ALTER TABLE packages ADD COLUMN postal_code TEXT`,
    `ALTER TABLE packages ADD COLUMN package_status TEXT NOT NULL DEFAULT 'active'`
  ];
  packageColumnMigrations.forEach((statement) => {
    db.run(statement, (alterErr) => {
      if (alterErr && !isDuplicateColumnError(alterErr)) {
        console.error('Failed packages schema migration:', alterErr.message);
      }
    });
  });

  // DELIVERIES (formerly bills)
  db.run(`
    CREATE TABLE IF NOT EXISTS deliveries (
      delivery_id INTEGER PRIMARY KEY AUTOINCREMENT,
      package_id INTEGER NOT NULL,
      delivery_date DATE NOT NULL,
      amount REAL NOT NULL,
      additional_charge REAL NOT NULL DEFAULT 0,
      due_date DATE NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('paid','unpaid','overdue')),
      payment_method TEXT NOT NULL DEFAULT 'online_bank' CHECK(payment_method IN ('online_bank','cod','credit_card','promptpay')),
      order_status TEXT NOT NULL DEFAULT 'processing' CHECK(order_status IN ('processing','in_transit','delivered')),
      delivered_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (package_id) REFERENCES packages(package_id) ON DELETE CASCADE
    )
  `);

  // PAYMENTS
  db.run(`
    CREATE TABLE IF NOT EXISTS payments (
      payment_id INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_id INTEGER NOT NULL UNIQUE,
      user_id INTEGER NOT NULL,
      payment_method TEXT NOT NULL CHECK(payment_method IN ('online_bank','cod','credit_card','promptpay')),
      payment_status TEXT NOT NULL DEFAULT 'paid' CHECK(payment_status IN ('pending_payment','pending','paid','cancelled','refunded')),
      payment_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      paid_at DATETIME,
      transaction_ref TEXT UNIQUE,
      FOREIGN KEY (delivery_id) REFERENCES deliveries(delivery_id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
    )
  `);

  // Backward compatibility for DBs created before payment/order extension.
  db.run(
    `ALTER TABLE delivery_services ADD COLUMN price_rate REAL NOT NULL DEFAULT ${DEFAULT_SERVICE_PRICE_RATE}`,
    (alterErr) => {
      if (alterErr && !isDuplicateColumnError(alterErr)) {
        console.error('Failed to ensure delivery_services.price_rate column:', alterErr.message);
      }
    }
  );
  db.run(
    `ALTER TABLE deliveries ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'online_bank'`,
    (alterErr) => {
      if (alterErr && !isDuplicateColumnError(alterErr)) {
        console.error('Failed to ensure deliveries.payment_method column:', alterErr.message);
      }
    }
  );
  db.run(
    `ALTER TABLE deliveries ADD COLUMN order_status TEXT NOT NULL DEFAULT 'processing'`,
    (alterErr) => {
      if (alterErr && !isDuplicateColumnError(alterErr)) {
        console.error('Failed to ensure deliveries.order_status column:', alterErr.message);
      }
    }
  );
  db.run(
    `ALTER TABLE deliveries ADD COLUMN delivered_at DATETIME`,
    (alterErr) => {
      if (alterErr && !isDuplicateColumnError(alterErr)) {
        console.error('Failed to ensure deliveries.delivered_at column:', alterErr.message);
      }
    }
  );
  db.run(
    `ALTER TABLE deliveries ADD COLUMN additional_charge REAL NOT NULL DEFAULT 0`,
    (alterErr) => {
      if (alterErr && !isDuplicateColumnError(alterErr)) {
        console.error('Failed to ensure deliveries.additional_charge column:', alterErr.message);
      }
    }
  );
  db.run(
    `ALTER TABLE payments ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'paid'`,
    (alterErr) => {
      if (alterErr && !isDuplicateColumnError(alterErr)) {
        console.error('Failed to ensure payments.payment_status column:', alterErr.message);
      }
    }
  );
  db.run(
    `ALTER TABLE payments ADD COLUMN paid_at DATETIME`,
    (alterErr) => {
      if (alterErr && !isDuplicateColumnError(alterErr)) {
        console.error('Failed to ensure payments.paid_at column:', alterErr.message);
      }
    }
  );
  db.run(
    `ALTER TABLE payments ADD COLUMN user_id INTEGER`,
    (alterErr) => {
      if (alterErr && !isDuplicateColumnError(alterErr)) {
        console.error('Failed to ensure payments.user_id column:', alterErr.message);
      }
    }
  );

  // Ensure legacy payments table allows cancellation statuses.
  db.get(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='payments'`,
    [],
    (schemaErr, schemaRow) => {
      if (schemaErr) {
        console.error('Failed to inspect payments schema:', schemaErr.message);
        return;
      }

      const schemaSql = String((schemaRow && schemaRow.sql) || '').toLowerCase();
      const supportsCancellationStatus = schemaSql.includes("'cancelled'") && schemaSql.includes("'refunded'");
      if (supportsCancellationStatus) return;

      db.serialize(() => {
        db.run('PRAGMA foreign_keys = OFF');
        db.run('BEGIN TRANSACTION');
        db.run(`DROP TABLE IF EXISTS payments_v2`);
        db.run(`
          CREATE TABLE payments_v2 (
            payment_id INTEGER PRIMARY KEY AUTOINCREMENT,
            delivery_id INTEGER NOT NULL UNIQUE,
            user_id INTEGER NOT NULL,
            payment_method TEXT NOT NULL CHECK(payment_method IN ('online_bank','cod','credit_card','promptpay')),
            payment_status TEXT NOT NULL DEFAULT 'paid' CHECK(payment_status IN ('pending_payment','pending','paid','cancelled','refunded')),
            payment_date DATETIME DEFAULT CURRENT_TIMESTAMP,
            paid_at DATETIME,
            transaction_ref TEXT UNIQUE,
            FOREIGN KEY (delivery_id) REFERENCES deliveries(delivery_id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
          )
        `, (createErr) => {
          if (createErr) {
            return db.run('ROLLBACK', () => {
              db.run('PRAGMA foreign_keys = ON');
              console.error('Failed to create payments_v2:', createErr.message);
            });
          }

          db.run(`
            INSERT INTO payments_v2 (
              payment_id,delivery_id,user_id,payment_method,payment_status,payment_date,paid_at,transaction_ref
            )
            SELECT
              payment_id,
              delivery_id,
              user_id,
              payment_method,
              CASE lower(trim(payment_status))
                WHEN 'paid' THEN 'paid'
                WHEN 'pending' THEN 'pending'
                WHEN 'pending_payment' THEN 'pending_payment'
                WHEN 'cancelled' THEN 'cancelled'
                WHEN 'refunded' THEN 'refunded'
                ELSE CASE
                  WHEN lower(trim(payment_method)) = 'cod' THEN 'pending'
                  ELSE 'pending_payment'
                END
              END,
              payment_date,
              paid_at,
              transaction_ref
            FROM payments
          `, (copyErr) => {
            if (copyErr) {
              return db.run('ROLLBACK', () => {
                db.run('PRAGMA foreign_keys = ON');
                console.error('Failed to migrate payments into payments_v2:', copyErr.message);
              });
            }

            db.run(`DROP TABLE payments`, (dropErr) => {
              if (dropErr) {
                return db.run('ROLLBACK', () => {
                  db.run('PRAGMA foreign_keys = ON');
                  console.error('Failed to drop old payments table:', dropErr.message);
                });
              }

              db.run(`ALTER TABLE payments_v2 RENAME TO payments`, (renameErr) => {
                if (renameErr) {
                  return db.run('ROLLBACK', () => {
                    db.run('PRAGMA foreign_keys = ON');
                    console.error('Failed to rename payments_v2 table:', renameErr.message);
                  });
                }

                db.run('COMMIT', (commitErr) => {
                  db.run('PRAGMA foreign_keys = ON');
                  if (commitErr) {
                    return db.run('ROLLBACK', () => {
                      console.error('Payments schema migration commit failed:', commitErr.message);
                    });
                  }
                });
              });
            });
          });
        });
      });
    }
  );

  // Normalize legacy payment/delivery values.
  db.run(`
    UPDATE deliveries
    SET payment_method = CASE lower(trim(payment_method))
      WHEN 'bank_transfer' THEN 'online_bank'
      WHEN 'bank' THEN 'online_bank'
      WHEN 'online bank' THEN 'online_bank'
      WHEN 'online_bank' THEN 'online_bank'
      WHEN 'cash' THEN 'cod'
      WHEN 'cash_on_delivery' THEN 'cod'
      WHEN 'cod' THEN 'cod'
      WHEN 'card' THEN 'credit_card'
      WHEN 'credit card' THEN 'credit_card'
      WHEN 'credit_card' THEN 'credit_card'
      WHEN 'mobile_wallet' THEN 'promptpay'
      WHEN 'prompt_pay' THEN 'promptpay'
      WHEN 'promptpay' THEN 'promptpay'
      ELSE 'online_bank'
    END
  `);
  db.run(`
    UPDATE deliveries
    SET order_status = CASE lower(trim(order_status))
      WHEN 'processing' THEN 'processing'
      WHEN 'in_transit' THEN 'in_transit'
      WHEN 'delivered' THEN 'delivered'
      ELSE 'processing'
    END
  `);
  db.run(`
    UPDATE payments
    SET payment_method = CASE lower(trim(payment_method))
      WHEN 'bank_transfer' THEN 'online_bank'
      WHEN 'bank' THEN 'online_bank'
      WHEN 'online bank' THEN 'online_bank'
      WHEN 'online_bank' THEN 'online_bank'
      WHEN 'cash' THEN 'cod'
      WHEN 'cash_on_delivery' THEN 'cod'
      WHEN 'cod' THEN 'cod'
      WHEN 'card' THEN 'credit_card'
      WHEN 'credit card' THEN 'credit_card'
      WHEN 'credit_card' THEN 'credit_card'
      WHEN 'mobile_wallet' THEN 'promptpay'
      WHEN 'prompt_pay' THEN 'promptpay'
      WHEN 'promptpay' THEN 'promptpay'
      ELSE 'online_bank'
    END
  `);
  db.run(`
    UPDATE payments
    SET payment_status = CASE lower(trim(payment_status))
      WHEN 'paid' THEN 'paid'
      WHEN 'pending' THEN 'pending'
      WHEN 'pending_payment' THEN 'pending_payment'
      WHEN 'cancelled' THEN 'cancelled'
      WHEN 'refunded' THEN 'refunded'
      ELSE CASE
        WHEN lower(trim(payment_method)) = 'cod' THEN 'pending'
        ELSE 'pending_payment'
      END
    END
  `);
  db.run(`
    UPDATE payments
    SET user_id = (
      SELECT packages.user_id
      FROM deliveries
      JOIN packages ON packages.package_id = deliveries.package_id
      WHERE deliveries.delivery_id = payments.delivery_id
    )
    WHERE user_id IS NULL
  `);
  db.run(`
    UPDATE packages
    SET weight = 1
    WHERE weight IS NULL OR CAST(weight AS REAL) <= 0
  `);
  db.run(`
    UPDATE packages
    SET package_status = 'active'
    WHERE package_status IS NULL OR trim(package_status) = ''
  `);
  db.run(`
    UPDATE delivery_services
    SET price_rate = ${DEFAULT_SERVICE_PRICE_RATE}
    WHERE price_rate IS NULL OR CAST(price_rate AS REAL) <= 0
  `);
  db.run(`
    UPDATE deliveries
    SET additional_charge = 0
    WHERE additional_charge IS NULL OR CAST(additional_charge AS REAL) < 0
  `);
  db.run(`
    UPDATE deliveries
    SET amount = ROUND(
      ${DEFAULT_SHIPPING_BASE_FEE}
      + (
        COALESCE(
          (
            SELECT CASE
              WHEN ds.price_rate IS NOT NULL AND CAST(ds.price_rate AS REAL) > 0
                THEN CAST(ds.price_rate AS REAL)
              ELSE ${DEFAULT_SERVICE_PRICE_RATE}
            END
            FROM packages p
            LEFT JOIN delivery_services ds ON ds.service_id = p.service_id
            WHERE p.package_id = deliveries.package_id
            LIMIT 1
          ),
          ${DEFAULT_SERVICE_PRICE_RATE}
        )
        * COALESCE(
          (
            SELECT CASE
              WHEN p.weight IS NOT NULL AND CAST(p.weight AS REAL) > 0
                THEN CAST(p.weight AS REAL)
              ELSE 0
            END
            FROM packages p
            WHERE p.package_id = deliveries.package_id
            LIMIT 1
          ),
          0
        )
      )
      + COALESCE(CAST(deliveries.additional_charge AS REAL), 0),
      2
    )
  `);
  db.run(`
    UPDATE payments
    SET paid_at = payment_date
    WHERE paid_at IS NULL AND lower(trim(payment_status)) = 'paid'
  `);
  db.run(`
    UPDATE payments
    SET payment_status = 'paid',
        payment_date = COALESCE(
          (SELECT deliveries.delivered_at FROM deliveries WHERE deliveries.delivery_id = payments.delivery_id),
          payment_date,
          CURRENT_TIMESTAMP
        ),
        paid_at = COALESCE(
          (SELECT deliveries.delivered_at FROM deliveries WHERE deliveries.delivery_id = payments.delivery_id),
          paid_at,
          payment_date,
          CURRENT_TIMESTAMP
        )
    WHERE lower(trim(payment_method)) = 'cod'
      AND EXISTS (
        SELECT 1
        FROM deliveries
        WHERE deliveries.delivery_id = payments.delivery_id
          AND lower(trim(deliveries.order_status)) = 'delivered'
      )
  `);
  db.run(`
    DELETE FROM payments
    WHERE lower(trim(payment_method)) = 'cod'
      AND EXISTS (
        SELECT 1
        FROM deliveries
        WHERE deliveries.delivery_id = payments.delivery_id
          AND lower(trim(deliveries.order_status)) <> 'delivered'
      )
  `);
});

// ==========================
// GENERIC CRUD FUNCTION
// ==========================

// [CRUD] Return all rows from a table.
function getAll(table, res) {
  db.all(`SELECT * FROM ${table}`, [], (err, rows) => {
    if (err) return res.status(500).json(err);
    res.json(rows);
  });
}

// [CRUD] Return one row by id field.
function getById(table, idField, id, res) {
  db.get(`SELECT * FROM ${table} WHERE ${idField} = ?`, [id], (err, row) => {
    if (err) return res.status(500).json(err);
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json(row);
  });
}

// [CRUD] Delete one row by id field.
function deleteById(table, idField, id, res) {
  db.run(`DELETE FROM ${table} WHERE ${idField} = ?`, [id], function (err) {
    if (err) return res.status(500).json(err);
    res.json({ deleted: this.changes });
  });
}

// ==========================
// USERS ROUTES
// ==========================
// [USER] Get all users (safe fields only).
app.get('/users', (req, res) => {
  db.all(
    `SELECT user_id, name, email, phone, role, created_at
     FROM users
     ORDER BY user_id ASC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json(err);
      res.json(rows);
    }
  );
});

// [USER] Get one user by id (safe fields only).
app.get('/users/:id', (req, res) => {
  db.get(
    `SELECT user_id, name, email, phone, role, created_at
     FROM users
     WHERE user_id = ?`,
    [req.params.id],
    (err, row) => {
      if (err) return res.status(500).json(err);
      if (!row) return res.status(404).json({ message: "Not found" });
      res.json(row);
    }
  );
});

// [AUTH] Validate credentials and return login payload.
app.post('/auth/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' });
  }

  db.get(
    `SELECT user_id, name, email, phone, password, role FROM users WHERE lower(email) = lower(?)`,
    [email],
    (err, row) => {
      if (err) return res.status(500).json(err);
      if (!row || row.password !== password) {
        return res.status(401).json({ message: 'Invalid email or password' });
      }

      return res.json({
        user: {
          user_id: row.user_id,
          name: row.name,
          email: row.email,
          phone: row.phone,
          role: normalizeUserRole(row.role)
        }
      });
    }
  );
});

// [USER] Create a user with role normalization and duplicate checks.
app.post('/users', (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const phone = String(req.body.phone || '').trim() || null;
  const role = normalizeUserRole(req.body.role);

  if (!name || !email || !password) {
    return res.status(400).json({ message: 'name, email and password are required' });
  }

  db.run(
    `INSERT INTO users (name,email,password,phone,role) VALUES (?,?,?,?,?)`,
    [name, email, password, phone, role],
    function (err) {
      if (err) {
        const message = String(err.message || '').toLowerCase();
        if (message.includes('unique constraint failed: users.email')) {
          return res.status(409).json({ message: 'Email already exists' });
        }
        return res.status(500).json(err);
      }
      res.json({ user_id: this.lastID, role });
    }
  );
});

// [USER] Update user profile and role.
app.put('/users/:id', (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const phone = String(req.body.phone || '').trim() || null;
  const role = typeof req.body.role === 'undefined' ? null : normalizeUserRole(req.body.role);

  if (!name || !email) {
    return res.status(400).json({ message: 'name and email are required' });
  }

  db.run(
    `UPDATE users SET name=?, email=?, phone=?, role=COALESCE(?, role) WHERE user_id=?`,
    [name, email, phone, role, req.params.id],
    function (err) {
      if (err) return res.status(500).json(err);
      res.json({ updated: this.changes });
    }
  );
});

// [USER] Delete user by id.
app.delete('/users/:id', (req, res) =>
  deleteById('users', 'user_id', req.params.id, res)
);

// ==========================
// DELIVERY SERVICES ROUTES (formerly utilities)
// ==========================
// [SERVICE] Get all delivery services.
app.get('/delivery-services', (req, res) => getAll('delivery_services', res));

// [SERVICE] Create delivery service.
app.post('/delivery-services', (req, res) => {
  const serviceName = String(req.body.service_name || '').trim();
  const parsedPriceRate = Number.parseFloat(req.body.price_rate);
  const priceRate = Number.isFinite(parsedPriceRate)
    ? Math.round(parsedPriceRate * 100) / 100
    : NaN;

  if (!serviceName) {
    return res.status(400).json({ message: 'service_name is required' });
  }
  if (!Number.isFinite(priceRate) || priceRate <= 0) {
    return res.status(400).json({ message: 'price_rate must be a positive number' });
  }

  db.run(
    `INSERT INTO delivery_services (service_name,price_rate) VALUES (?,?)`,
    [serviceName, priceRate],
    function (err) {
      if (err) {
        const message = String(err.message || '').toLowerCase();
        if (message.includes('unique constraint failed: delivery_services.service_name')) {
          return res.status(409).json({ message: 'Delivery service name already exists' });
        }
        return res.status(500).json(err);
      }
      res.json({ service_id: this.lastID, service_name: serviceName, price_rate: priceRate });
    }
  );
});

// [SERVICE] Delete delivery service by id.
app.delete('/delivery-services/:id', (req, res) =>
  deleteById('delivery_services', 'service_id', req.params.id, res)
);

// ==========================
// PACKAGE DRAFTS ROUTES
// ==========================
// [DRAFT] Get all package drafts.
app.get('/package-drafts', (req, res) => getAll('package_drafts', res));

// [DRAFT] Get package draft by id.
app.get('/package-drafts/:id', (req, res) =>
  getById('package_drafts', 'draft_id', req.params.id, res)
);

// [DRAFT] Create package draft (no tracking number, no delivery yet).
app.post('/package-drafts', (req, res) => {
  const userId = Number.parseInt(req.body.user_id, 10);
  const serviceId = Number.parseInt(req.body.service_id, 10);
  const hasServiceInput = typeof req.body.service_id !== 'undefined'
    && String(req.body.service_id || '').trim() !== '';
  const weight = normalizeWeight(req.body.weight);
  const receiverName = String(req.body.receiver_name || "").trim();
  const receiverPhone = String(req.body.receiver_phone || "").trim();
  const houseNumber = String(req.body.house_number || "").trim();
  const villageNo = String(req.body.village_no || "").trim() || null;
  const soi = String(req.body.soi || "").trim() || null;
  const road = String(req.body.road || "").trim() || null;
  const subdistrict = String(req.body.subdistrict || "").trim();
  const district = String(req.body.district || "").trim();
  const province = String(req.body.province || "").trim();
  const postalCode = String(req.body.postal_code || "").trim();
  const paymentMethod = normalizePaymentMethod(req.body.payment_method) || 'online_bank';
  const status = String(req.body.status || 'draft').toLowerCase().trim() === 'pending_payment'
    ? 'pending_payment'
    : 'draft';

  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ message: "user_id must be a positive integer" });
  }
  if (hasServiceInput && (!Number.isFinite(serviceId) || serviceId <= 0)) {
    return res.status(400).json({ message: "service_id must be a positive integer" });
  }
  if (!Number.isFinite(weight) || weight < MIN_PACKAGE_WEIGHT || weight > MAX_PACKAGE_WEIGHT) {
    return res.status(400).json({
      message: `weight must be a number between ${MIN_PACKAGE_WEIGHT} and ${MAX_PACKAGE_WEIGHT} kg`
    });
  }
  if (!receiverName) return res.status(400).json({ message: "receiver_name is required" });
  if (!/^0\d{9}$/.test(receiverPhone)) {
    return res.status(400).json({ message: "receiver_phone must be exactly 10 digits and start with 0" });
  }
  if (!houseNumber) return res.status(400).json({ message: "house_number is required" });
  if (!subdistrict) return res.status(400).json({ message: "subdistrict is required" });
  if (!district) return res.status(400).json({ message: "district is required" });
  if (!province) return res.status(400).json({ message: "province is required" });
  if (!/^\d{5}$/.test(postalCode)) {
    return res.status(400).json({ message: "postal_code must be exactly 5 digits" });
  }

  const resolveServiceId = (done) => {
    if (hasServiceInput) return done(null, serviceId);

    return db.get(
      `SELECT service_id FROM delivery_services ORDER BY service_id ASC LIMIT 1`,
      [],
      (serviceErr, row) => {
        if (serviceErr) return done(serviceErr);
        if (!row || !row.service_id) return done(new Error('NO_DEFAULT_SERVICE'));

        const fallbackServiceId = Number.parseInt(row.service_id, 10);
        if (!Number.isFinite(fallbackServiceId) || fallbackServiceId <= 0) {
          return done(new Error('INVALID_DEFAULT_SERVICE'));
        }
        return done(null, fallbackServiceId);
      }
    );
  };

  return resolveServiceId((serviceResolveErr, resolvedServiceId) => {
    if (serviceResolveErr) {
      if (serviceResolveErr.message === 'NO_DEFAULT_SERVICE' || serviceResolveErr.message === 'INVALID_DEFAULT_SERVICE') {
        return res.status(400).json({ message: "No delivery service available. Please create a delivery service first." });
      }
      return res.status(500).json(serviceResolveErr);
    }

    db.run(
      `INSERT INTO package_drafts (
        user_id,service_id,weight,
        receiver_name,receiver_phone,
        house_number,village_no,soi,road,subdistrict,district,province,postal_code,
        payment_method,status
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        userId,
        resolvedServiceId,
        weight,
        receiverName,
        receiverPhone,
        houseNumber,
        villageNo,
        soi,
        road,
        subdistrict,
        district,
        province,
        postalCode,
        paymentMethod,
        status
      ],
      function (err) {
        if (err) {
          const rawMessage = String(err.message || "").toLowerCase();
          if (rawMessage.includes("foreign key constraint failed")) {
            return res.status(400).json({ message: "Selected user or delivery service does not exist" });
          }
          if (rawMessage.includes("check constraint failed")) {
            return res.status(400).json({ message: "Invalid draft status or payment method" });
          }
          return res.status(500).json(err);
        }

        return res.json({
          draft_id: this.lastID,
          user_id: userId,
          service_id: resolvedServiceId,
          status
        });
      }
    );
  });
});

// [DRAFT] Delete package draft by id.
app.delete('/package-drafts/:id', (req, res) =>
  deleteById('package_drafts', 'draft_id', req.params.id, res)
);

// ==========================
// PACKAGES ROUTES (formerly meters)
// ==========================
// [PACKAGE] Get all packages.
app.get('/packages', (req, res) => getAll('packages', res));

// [PACKAGE] Create package with unique/FK validation.
app.post('/packages', (req, res) => {
  const trackingNumberInput = String(
    req.body.tracking_number || req.body.package_reading || req.body.meter_reading || ''
  ).trim();
  const userId = Number.parseInt(req.body.user_id, 10);
  const serviceId = Number.parseInt(req.body.service_id, 10);
  const weight = normalizeWeight(req.body.weight);
  const hasServiceInput = typeof req.body.service_id !== 'undefined'
    && String(req.body.service_id || '').trim() !== '';
  const receiverName = String(req.body.receiver_name || "").trim();
  const receiverPhone = String(req.body.receiver_phone || "").trim();
  const houseNumber = String(req.body.house_number || "").trim();
  const villageNo = String(req.body.village_no || "").trim() || null;
  const soi = String(req.body.soi || "").trim() || null;
  const road = String(req.body.road || "").trim() || null;
  const subdistrict = String(req.body.subdistrict || "").trim();
  const district = String(req.body.district || "").trim();
  const province = String(req.body.province || "").trim();
  const postalCode = String(req.body.postal_code || "").trim();

  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ message: "user_id must be a positive integer" });
  }
  if (hasServiceInput && (!Number.isFinite(serviceId) || serviceId <= 0)) {
    return res.status(400).json({ message: "service_id must be a positive integer" });
  }
  if (!Number.isFinite(weight) || weight < MIN_PACKAGE_WEIGHT || weight > MAX_PACKAGE_WEIGHT) {
    return res.status(400).json({
      message: `weight must be a number between ${MIN_PACKAGE_WEIGHT} and ${MAX_PACKAGE_WEIGHT} kg`
    });
  }
  if (!receiverName) {
    return res.status(400).json({ message: "receiver_name is required" });
  }
  if (!/^0\d{9}$/.test(receiverPhone)) {
    return res.status(400).json({ message: "receiver_phone must be exactly 10 digits, numeric only, and start with 0" });
  }
  if (!houseNumber) {
    return res.status(400).json({ message: "house_number is required" });
  }
  if (!subdistrict) {
    return res.status(400).json({ message: "subdistrict is required" });
  }
  if (!district) {
    return res.status(400).json({ message: "district is required" });
  }
  if (!province) {
    return res.status(400).json({ message: "province is required" });
  }
  if (!/^\d{5}$/.test(postalCode)) {
    return res.status(400).json({ message: "postal_code must be exactly 5 digits" });
  }

  const resolveServiceId = (done) => {
    if (Number.isFinite(serviceId) && serviceId > 0) {
      return done(null, serviceId);
    }

    return db.get(
      `SELECT service_id FROM delivery_services ORDER BY service_id ASC LIMIT 1`,
      [],
      (serviceErr, row) => {
        if (serviceErr) return done(serviceErr);
        if (!row || !row.service_id) {
          return done(new Error('NO_DEFAULT_SERVICE'));
        }

        const fallbackServiceId = Number.parseInt(row.service_id, 10);
        if (!Number.isFinite(fallbackServiceId) || fallbackServiceId <= 0) {
          return done(new Error('INVALID_DEFAULT_SERVICE'));
        }
        return done(null, fallbackServiceId);
      }
    );
  };

  const autoGeneratedTracking = !trackingNumberInput;
  const maxAutoTrackingRetries = autoGeneratedTracking ? 5 : 0;

  const insertPackage = (trackingNumber, resolvedServiceId, retriesLeft) => {
    db.run(
      `INSERT INTO packages (
        tracking_number,user_id,service_id,
        weight,
        receiver_name,receiver_phone,
        house_number,village_no,soi,road,subdistrict,district,province,postal_code
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        trackingNumber,
        userId,
        resolvedServiceId,
        weight,
        receiverName,
        receiverPhone,
        houseNumber,
        villageNo,
        soi,
        road,
        subdistrict,
        district,
        province,
        postalCode
      ],
      function (err) {
        if (err) {
          const rawMessage = String(err.message || "").toLowerCase();
          if (rawMessage.includes("unique constraint failed: packages.tracking_number")) {
            if (autoGeneratedTracking && retriesLeft > 0) {
              return insertPackage(generateTrackingNumber(), resolvedServiceId, retriesLeft - 1);
            }
            return res.status(409).json({ message: "Tracking number already exists" });
          }
          if (rawMessage.includes("foreign key constraint failed")) {
            return res.status(400).json({ message: "Selected user or delivery service does not exist" });
          }
          if (rawMessage.includes("not null constraint failed")) {
            return res.status(400).json({ message: "Required fields are missing" });
          }
          return res.status(500).json(err);
        }
        return res.json({
          package_id: this.lastID,
          tracking_number: trackingNumber,
          service_id: resolvedServiceId,
          weight
        });
      }
    );
  };

  return resolveServiceId((serviceResolveErr, resolvedServiceId) => {
    if (serviceResolveErr) {
      if (serviceResolveErr.message === 'NO_DEFAULT_SERVICE' || serviceResolveErr.message === 'INVALID_DEFAULT_SERVICE') {
        return res.status(400).json({ message: "No delivery service available. Please create a delivery service first." });
      }
      return res.status(500).json(serviceResolveErr);
    }

    const trackingNumber = trackingNumberInput || generateTrackingNumber();
    return insertPackage(trackingNumber, resolvedServiceId, maxAutoTrackingRetries);
  });
});

// [PACKAGE] Delete package by id.
app.delete('/packages/:id', (req, res) =>
  deleteById('packages', 'package_id', req.params.id, res)
);

// ==========================
// DELIVERIES ROUTES (formerly bills)
// ==========================
// [DELIVERY] Get all deliveries.
app.get('/deliveries', (req, res) => getAll('deliveries', res));

// [DELIVERY] Get delivery by id.
app.get('/deliveries/:id', (req, res) => getById('deliveries', 'delivery_id', req.params.id, res));

// [DELIVERY] Create delivery.
app.post('/deliveries', (req, res) => {
  const packageId = Number.parseInt(req.body.package_id, 10);
  const deliveryDate = String(req.body.delivery_date || '').trim();
  const dueDate = String(req.body.due_date || '').trim();
  const parsedAdditionalCharge = Number.parseFloat(req.body.additional_charge);
  const additionalCharge = Number.isFinite(parsedAdditionalCharge)
    ? Math.round(parsedAdditionalCharge * 100) / 100
    : 0;
  const paymentMethodInput = typeof req.body.payment_method === 'undefined'
    ? 'online_bank'
    : req.body.payment_method;
  const paymentMethod = normalizePaymentMethod(paymentMethodInput);
  const orderStatus = normalizeOrderStatus(req.body.order_status, 'processing');
  let deliveryStatus = normalizeDeliveryStatus(req.body.status, 'unpaid');

  if (!Number.isFinite(packageId) || packageId <= 0) {
    return res.status(400).json({ message: 'package_id must be a positive integer' });
  }
  if (!deliveryDate || !dueDate) {
    return res.status(400).json({ message: 'delivery_date and due_date are required' });
  }
  if (!Number.isFinite(additionalCharge) || additionalCharge < 0) {
    return res.status(400).json({ message: 'additional_charge must be 0 or greater' });
  }

  if (!paymentMethod) {
    return res.status(400).json({
      message: "payment_method must be one of: online_bank, cod, credit_card, promptpay"
    });
  }

  // Credit card simulates immediate successful payment.
  if (paymentMethod === 'credit_card') deliveryStatus = 'paid';
  else if (paymentMethod === 'cod') deliveryStatus = orderStatus === 'delivered' ? 'paid' : 'unpaid';
  else deliveryStatus = 'unpaid';
  const deliveredAt = orderStatus === 'delivered' ? new Date().toISOString() : null;

  db.get(
    `SELECT package_id, user_id, service_id, weight FROM packages WHERE package_id = ?`,
    [packageId],
    (packageErr, packageRow) => {
      if (packageErr) return res.status(500).json(packageErr);
      if (!packageRow) return res.status(400).json({ message: 'Selected package does not exist' });

      db.get(
        `SELECT service_id, price_rate
         FROM delivery_services
         WHERE service_id = ?`,
        [packageRow.service_id],
        (serviceErr, serviceRow) => {
          if (serviceErr) return res.status(500).json(serviceErr);

          const parsedServiceRate = Number.parseFloat(serviceRow && serviceRow.price_rate);
          const serviceRate = Number.isFinite(parsedServiceRate) && parsedServiceRate > 0
            ? Math.round(parsedServiceRate * 100) / 100
            : DEFAULT_SERVICE_PRICE_RATE;
          const resolvedAmount = calculateShippingAmount(packageRow.weight, serviceRate, additionalCharge);
          if (!Number.isFinite(resolvedAmount) || resolvedAmount < 0) {
            return res.status(400).json({
              message: `Unable to calculate delivery amount. Ensure package weight is between ${MIN_PACKAGE_WEIGHT} and ${MAX_PACKAGE_WEIGHT} kg and service pricing is valid.`
            });
          }

          const paymentUserId = Number.parseInt(packageRow.user_id, 10);
          if (!Number.isFinite(paymentUserId) || paymentUserId <= 0) {
            return res.status(500).json({ message: 'Unable to resolve payment user for package' });
          }

          db.serialize(() => {
            db.run('BEGIN TRANSACTION');

            db.run(
              `INSERT INTO deliveries (package_id,delivery_date,amount,additional_charge,due_date,status,payment_method,order_status,delivered_at)
               VALUES (?,?,?,?,?,?,?,?,?)`,
              [packageId, deliveryDate, resolvedAmount, additionalCharge, dueDate, deliveryStatus, paymentMethod, orderStatus, deliveredAt],
              function (insertErr) {
                if (insertErr) {
                  return db.run('ROLLBACK', () => res.status(500).json(insertErr));
                }

                const deliveryId = this.lastID;
                const shouldCreatePaymentRecord = !(paymentMethod === 'cod' && orderStatus !== 'delivered');
                const autoPaymentStatus = paymentMethod === 'cod' && orderStatus === 'delivered'
                  ? 'paid'
                  : resolvePaymentStatusByMethod(paymentMethod);

                if (!shouldCreatePaymentRecord) {
                  return db.run('COMMIT', (commitErr) => {
                    if (commitErr) {
                      return db.run('ROLLBACK', () => res.status(500).json(commitErr));
                    }
                    return res.json({
                      delivery_id: deliveryId,
                      status: deliveryStatus,
                      order_status: orderStatus,
                      amount: resolvedAmount,
                      additional_charge: additionalCharge,
                      payment_method: paymentMethod,
                      payment_id: null,
                      payment_status: 'pending',
                      user_id: paymentUserId,
                      message: 'COD payment will be created automatically when delivery is marked delivered.'
                    });
                  });
                }

                const paymentTimestamp = autoPaymentStatus === 'paid'
                  ? (paymentMethod === 'cod' && deliveredAt ? deliveredAt : new Date().toISOString())
                  : new Date().toISOString();
                const paidAt = autoPaymentStatus === 'paid' ? paymentTimestamp : null;
                db.run(
                  `INSERT INTO payments (delivery_id,user_id,payment_method,payment_status,transaction_ref,payment_date,paid_at)
                   VALUES (?,?,?,?,?,?,?)`,
                  [deliveryId, paymentUserId, paymentMethod, autoPaymentStatus, null, paymentTimestamp, paidAt],
                  function (paymentErr) {
                    if (paymentErr) {
                      return db.run('ROLLBACK', () => res.status(500).json(paymentErr));
                    }

                    const paymentId = this.lastID;
                    db.run('COMMIT', (commitErr) => {
                      if (commitErr) {
                        return db.run('ROLLBACK', () => res.status(500).json(commitErr));
                      }
                      return res.json({
                        delivery_id: deliveryId,
                        status: deliveryStatus,
                        order_status: orderStatus,
                        amount: resolvedAmount,
                        additional_charge: additionalCharge,
                        payment_method: paymentMethod,
                        payment_id: paymentId,
                        payment_status: autoPaymentStatus,
                        user_id: paymentUserId
                      });
                    });
                  }
                );
              }
            );
          });
        }
      );
    }
  );
});

// [DELIVERY] Update order status and auto-complete COD payments on delivery.
app.put('/deliveries/:id/order-status', (req, res) => {
  const deliveryId = Number.parseInt(req.params.id, 10);
  const rawOrderStatus = String(req.body.order_status || '').toLowerCase().trim();
  const deliveredAt = rawOrderStatus === 'delivered' ? new Date().toISOString() : null;

  if (!Number.isFinite(deliveryId) || deliveryId <= 0) {
    return res.status(400).json({ message: 'Invalid delivery id' });
  }
  if (!ALLOWED_ORDER_STATUSES.has(rawOrderStatus)) {
    return res.status(400).json({ message: "order_status must be one of: processing, in_transit, delivered" });
  }

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');

    db.get(
      `SELECT deliveries.delivery_id,
              deliveries.status,
              deliveries.payment_method,
              packages.user_id,
              packages.package_status
       FROM deliveries
       JOIN packages ON packages.package_id = deliveries.package_id
       WHERE deliveries.delivery_id = ?`,
      [deliveryId],
      (deliveryErr, delivery) => {
        if (deliveryErr) {
          return db.run('ROLLBACK', () => res.status(500).json(deliveryErr));
        }
        if (!delivery) {
          return db.run('ROLLBACK', () => res.status(404).json({ message: 'Delivery not found' }));
        }
        if (String(delivery.package_status || '').toLowerCase().trim() === 'cancelled') {
          return db.run('ROLLBACK', () => res.status(409).json({
            message: 'Shipping is blocked because this package is cancelled.'
          }));
        }

        db.run(
          `UPDATE deliveries
           SET order_status = ?,
               delivered_at = CASE
                 WHEN ? = 'delivered' THEN COALESCE(delivered_at, ?)
                 ELSE delivered_at
               END
           WHERE delivery_id = ?`,
          [rawOrderStatus, rawOrderStatus, deliveredAt, deliveryId],
          (updateOrderErr) => {
            if (updateOrderErr) {
              return db.run('ROLLBACK', () => res.status(500).json(updateOrderErr));
            }

            const method = normalizePaymentMethod(delivery.payment_method);
            const shouldAutoPayCod = rawOrderStatus === 'delivered' && method === 'cod';
            if (!shouldAutoPayCod) {
              return db.run('COMMIT', (commitErr) => {
                if (commitErr) {
                  return db.run('ROLLBACK', () => res.status(500).json(commitErr));
                }
                return res.json({
                  delivery_id: deliveryId,
                  order_status: rawOrderStatus
                });
              });
            }

            db.get(
              `SELECT payment_id FROM payments WHERE delivery_id = ?`,
              [deliveryId],
              (paymentErr, payment) => {
                if (paymentErr) {
                  return db.run('ROLLBACK', () => res.status(500).json(paymentErr));
                }

                const finalizeDeliveryAsPaid = () => {
                  db.run(
                    `UPDATE deliveries
                     SET status = 'paid',
                         delivered_at = COALESCE(delivered_at, ?)
                     WHERE delivery_id = ?`,
                    [deliveredAt, deliveryId],
                    (markPaidErr) => {
                      if (markPaidErr) {
                        return db.run('ROLLBACK', () => res.status(500).json(markPaidErr));
                      }

                      db.run('COMMIT', (commitErr) => {
                        if (commitErr) {
                          return db.run('ROLLBACK', () => res.status(500).json(commitErr));
                        }
                        return res.json({
                          delivery_id: deliveryId,
                          order_status: rawOrderStatus,
                          payment_method: 'cod',
                          payment_status: 'paid',
                          paid_at: deliveredAt,
                          delivery_status: 'paid'
                        });
                      });
                    }
                  );
                };

                if (!payment) {
                  return db.run(
                    `INSERT INTO payments (delivery_id,user_id,payment_method,payment_status,transaction_ref,payment_date,paid_at)
                     VALUES (?,?,?,?,?,?,?)`,
                    [deliveryId, delivery.user_id, 'cod', 'paid', null, deliveredAt, deliveredAt],
                    (insertPaymentErr) => {
                      if (insertPaymentErr) {
                        return db.run('ROLLBACK', () => res.status(500).json(insertPaymentErr));
                      }
                      return finalizeDeliveryAsPaid();
                    }
                  );
                }

                return db.run(
                  `UPDATE payments
                   SET user_id = ?,
                       payment_method = 'cod',
                       payment_status = 'paid',
                       payment_date = ?,
                       paid_at = ?
                   WHERE delivery_id = ?`,
                  [delivery.user_id, deliveredAt, deliveredAt, deliveryId],
                  (updatePaymentErr) => {
                    if (updatePaymentErr) {
                      return db.run('ROLLBACK', () => res.status(500).json(updatePaymentErr));
                    }
                    return finalizeDeliveryAsPaid();
                  }
                );
              }
            );
          }
        );
      }
    );
  });
});

// [DELIVERY] Customer cancellation after payment confirmation (non-COD, pending delivery only).
app.post('/deliveries/:id/cancel', (req, res) => {
  const deliveryId = Number.parseInt(req.params.id, 10);
  const actorUserId = Number.parseInt(req.body.user_id, 10);

  if (!Number.isFinite(deliveryId) || deliveryId <= 0) {
    return res.status(400).json({ message: 'Invalid delivery id' });
  }

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');

    db.get(
      `SELECT deliveries.delivery_id,
              deliveries.order_status,
              deliveries.payment_method,
              deliveries.status AS delivery_status,
              packages.package_id,
              packages.user_id,
              packages.package_status
       FROM deliveries
       JOIN packages ON packages.package_id = deliveries.package_id
       WHERE deliveries.delivery_id = ?`,
      [deliveryId],
      (deliveryErr, delivery) => {
        if (deliveryErr) {
          return db.run('ROLLBACK', () => res.status(500).json(deliveryErr));
        }
        if (!delivery) {
          return db.run('ROLLBACK', () => res.status(404).json({ message: 'Delivery not found' }));
        }

        if (Number.isFinite(actorUserId) && actorUserId > 0 && Number.parseInt(delivery.user_id, 10) !== actorUserId) {
          return db.run('ROLLBACK', () => res.status(403).json({ message: 'You can only cancel your own delivery.' }));
        }

        const packageStatus = String(delivery.package_status || 'active').toLowerCase().trim();
        if (packageStatus === 'cancelled') {
          return db.run('ROLLBACK', () => res.status(409).json({ message: 'Package is already cancelled.' }));
        }

        const method = normalizePaymentMethod(delivery.payment_method) || 'online_bank';
        if (method === 'cod') {
          return db.run('ROLLBACK', () => res.status(400).json({
            message: 'COD deliveries cannot be cancelled through this flow.'
          }));
        }

        const orderStatus = normalizeOrderStatus(delivery.order_status, 'processing');
        if (orderStatus !== 'processing') {
          return db.run('ROLLBACK', () => res.status(400).json({
            message: 'Cancellation is allowed only when delivery status is Pending.'
          }));
        }

        db.get(
          `SELECT payment_id, payment_status FROM payments WHERE delivery_id = ?`,
          [deliveryId],
          (paymentErr, payment) => {
            if (paymentErr) {
              return db.run('ROLLBACK', () => res.status(500).json(paymentErr));
            }
            if (!payment) {
              return db.run('ROLLBACK', () => res.status(400).json({
                message: 'Payment is not confirmed yet. Please complete payment first.'
              }));
            }

            const currentPaymentStatus = String(payment.payment_status || '').toLowerCase().trim();
            if (currentPaymentStatus !== 'paid') {
              return db.run('ROLLBACK', () => res.status(400).json({
                message: 'Only paid deliveries can be cancelled in this stage.'
              }));
            }

            db.run(
              `UPDATE packages
               SET package_status = 'cancelled'
               WHERE package_id = ?`,
              [delivery.package_id],
              (updatePackageErr) => {
                if (updatePackageErr) {
                  return db.run('ROLLBACK', () => res.status(500).json(updatePackageErr));
                }

                db.run(
                  `UPDATE deliveries
                   SET status = 'paid'
                   WHERE delivery_id = ?`,
                  [deliveryId],
                  (updateDeliveryErr) => {
                    if (updateDeliveryErr) {
                      return db.run('ROLLBACK', () => res.status(500).json(updateDeliveryErr));
                    }

                    db.run(
                      `UPDATE payments
                       SET payment_status = 'cancelled'
                       WHERE payment_id = ?`,
                      [payment.payment_id],
                      (updatePaymentErr) => {
                        if (updatePaymentErr) {
                          return db.run('ROLLBACK', () => res.status(500).json(updatePaymentErr));
                        }

                        db.run('COMMIT', (commitErr) => {
                          if (commitErr) {
                            return db.run('ROLLBACK', () => res.status(500).json(commitErr));
                          }
                          return res.json({
                            delivery_id: deliveryId,
                            package_id: delivery.package_id,
                            package_status: 'cancelled',
                            payment_status: 'cancelled',
                            order_status: orderStatus,
                            message: 'Delivery cancelled. Package marked as cancelled and payment marked as cancelled.'
                          });
                        });
                      }
                    );
                  }
                );
              }
            );
          }
        );
      }
    );
  });
});

// [DELIVERY] Delete delivery by id.
app.delete('/deliveries/:id', (req, res) =>
  deleteById('deliveries', 'delivery_id', req.params.id, res)
);

// ==========================
// PAYMENTS ROUTES
// ==========================
// [PAYMENT] Get all payments.
app.get('/payments', (req, res) => getAll('payments', res));

// [PAYMENT] Create payment transaction with method-specific status rules.
app.post('/payments', (req, res) => {
  const { delivery_id, payment_method, transaction_ref } = req.body;
  const normalizedDeliveryId = Number.parseInt(delivery_id, 10);
  const rawRef = String(transaction_ref || "").trim();
  let normalizedRef = rawRef || null;

  if (!Number.isFinite(normalizedDeliveryId) || normalizedDeliveryId <= 0) {
    return res.status(400).json({ message: "Invalid delivery_id" });
  }

  db.get(
    `SELECT deliveries.delivery_id,
            deliveries.status,
            deliveries.payment_method,
            deliveries.order_status,
            packages.user_id,
            packages.package_status
     FROM deliveries
     JOIN packages ON packages.package_id = deliveries.package_id
     WHERE deliveries.delivery_id = ?`,
    [normalizedDeliveryId],
    (deliveryErr, delivery) => {
      if (deliveryErr) return res.status(500).json(deliveryErr);
      if (!delivery) return res.status(404).json({ message: "Delivery not found" });
      if (String(delivery.package_status || '').toLowerCase().trim() === 'cancelled') {
        return res.status(409).json({ message: "Cancelled packages cannot be paid." });
      }

      const fallbackMethod = normalizePaymentMethod(delivery.payment_method);
      const normalizedMethod = normalizePaymentMethod(payment_method) || fallbackMethod;
      if (!normalizedMethod) {
        return res.status(400).json({
          message: "payment_method must be one of: online_bank, cod, credit_card, promptpay"
        });
      }
      if (normalizedMethod === 'cod') {
        return res.status(400).json({
          message: "COD cannot be paid online. It is processed automatically when delivery is marked delivered."
        });
      }

      if (normalizedMethod === 'credit_card' && !normalizedRef) {
        normalizedRef = `CC-${normalizedDeliveryId}-${Date.now()}`;
      }

      const paymentStatus = 'paid';
      const shouldMarkDeliveryPaid = paymentStatus === 'paid';
      const paidAt = new Date().toISOString();
      const normalizedUserId = Number.parseInt(delivery.user_id, 10);
      if (!Number.isFinite(normalizedUserId) || normalizedUserId <= 0) {
        return res.status(500).json({ message: "Unable to resolve user_id for payment" });
      }

      db.serialize(() => {
        db.run("BEGIN TRANSACTION");

        const commitPendingResult = (paymentId, message) => {
          return db.run("COMMIT", (commitErr) => {
            if (commitErr) {
              return db.run("ROLLBACK", () => res.status(500).json(commitErr));
            }
            return res.json({
              payment_id: paymentId,
              delivery_id: normalizedDeliveryId,
              user_id: normalizedUserId,
              payment_method: normalizedMethod,
              payment_status: paymentStatus,
              delivery_status: normalizeDeliveryStatus(delivery.status, 'unpaid'),
              message
            });
          });
        };

        const markDeliveryPaidAndCommit = (paymentId, message) => {
          return db.run(
            `UPDATE deliveries SET status = 'paid' WHERE delivery_id = ?`,
            [normalizedDeliveryId],
            (updateErr) => {
              if (updateErr) {
                return db.run("ROLLBACK", () => res.status(500).json(updateErr));
              }

              return db.run("COMMIT", (commitErr) => {
                if (commitErr) {
                  return db.run("ROLLBACK", () => res.status(500).json(commitErr));
                }
                return res.json({
                  payment_id: paymentId,
                  delivery_id: normalizedDeliveryId,
                  user_id: normalizedUserId,
                  payment_method: normalizedMethod,
                  payment_status: paymentStatus,
                  delivery_status: "paid",
                  message
                });
              });
            }
          );
        };

        db.get(
          `SELECT payment_id FROM payments WHERE delivery_id = ?`,
          [normalizedDeliveryId],
          (existingErr, existingPayment) => {
            if (existingErr) {
              return db.run("ROLLBACK", () => res.status(500).json(existingErr));
            }

            if (existingPayment) {
              return db.run(
                `UPDATE payments
                 SET user_id = ?,
                     payment_method = ?,
                     payment_status = ?,
                     transaction_ref = COALESCE(?, transaction_ref),
                     payment_date = ?,
                     paid_at = ?
                 WHERE payment_id = ?`,
                [normalizedUserId, normalizedMethod, paymentStatus, normalizedRef, paidAt, paidAt, existingPayment.payment_id],
                (updateExistingErr) => {
                  if (updateExistingErr) {
                    const status = String(updateExistingErr.code || "").includes("CONSTRAINT") ? 409 : 500;
                    const payload = status === 409
                      ? { message: "Transaction reference is duplicated" }
                      : updateExistingErr;
                    return db.run("ROLLBACK", () => res.status(status).json(payload));
                  }

                  if (!shouldMarkDeliveryPaid) {
                    const message = paymentStatus === 'pending'
                      ? "COD payment is pending and will auto-complete when order is delivered."
                      : "Payment updated successfully.";
                    return commitPendingResult(existingPayment.payment_id, message);
                  }

                  return markDeliveryPaidAndCommit(existingPayment.payment_id, "Payment completed successfully.");
                }
              );
            }

            return db.run(
              `INSERT INTO payments (delivery_id,user_id,payment_method,payment_status,transaction_ref,payment_date,paid_at)
               VALUES (?,?,?,?,?,?,?)`,
              [normalizedDeliveryId, normalizedUserId, normalizedMethod, paymentStatus, normalizedRef, paidAt, paidAt],
              function (insertErr) {
                if (insertErr) {
                  const status = String(insertErr.code || "").includes("CONSTRAINT") ? 409 : 500;
                  const payload = status === 409
                    ? { message: "Payment already exists or transaction reference is duplicated" }
                    : insertErr;
                  return db.run("ROLLBACK", () => res.status(status).json(payload));
                }

                const paymentId = this.lastID;
                if (!shouldMarkDeliveryPaid) {
                  const message = paymentStatus === 'pending'
                    ? "COD payment is pending and will auto-complete when order is delivered."
                    : "Payment submitted successfully.";
                  return commitPendingResult(paymentId, message);
                }

                return markDeliveryPaidAndCommit(paymentId, "Payment completed successfully.");
              }
            );
          }
        );
      });
    }
  );
});

// [PAYMENT] Approve pending online-bank/promptpay payments.
app.put('/payments/:id/approve', (req, res) => {
  const paymentId = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(paymentId) || paymentId <= 0) {
    return res.status(400).json({ message: 'Invalid payment id' });
  }

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');

    db.get(
      `SELECT payment_id, delivery_id, payment_status, payment_method
       FROM payments
       WHERE payment_id = ?`,
      [paymentId],
      (paymentErr, payment) => {
        if (paymentErr) {
          return db.run('ROLLBACK', () => res.status(500).json(paymentErr));
        }
        if (!payment) {
          return db.run('ROLLBACK', () => res.status(404).json({ message: 'Payment not found' }));
        }

        const currentStatus = String(payment.payment_status || '').toLowerCase().trim();
        if (currentStatus === 'paid') {
          return db.run('COMMIT', (commitErr) => {
            if (commitErr) return db.run('ROLLBACK', () => res.status(500).json(commitErr));
            return res.json({
              payment_id: payment.payment_id,
              delivery_id: payment.delivery_id,
              payment_status: 'paid',
              delivery_status: 'paid',
              message: 'Payment is already approved.'
            });
          });
        }
        if (currentStatus === 'pending') {
          return db.run('ROLLBACK', () => res.status(400).json({
            message: 'COD payments are approved automatically when delivery is marked delivered.'
          }));
        }

        db.run(
          `UPDATE payments
           SET payment_status = 'paid',
               payment_date = CURRENT_TIMESTAMP,
               paid_at = CURRENT_TIMESTAMP
           WHERE payment_id = ?`,
          [paymentId],
          (updatePaymentErr) => {
            if (updatePaymentErr) {
              return db.run('ROLLBACK', () => res.status(500).json(updatePaymentErr));
            }

            db.run(
              `UPDATE deliveries SET status = 'paid' WHERE delivery_id = ?`,
              [payment.delivery_id],
              (updateDeliveryErr) => {
                if (updateDeliveryErr) {
                  return db.run('ROLLBACK', () => res.status(500).json(updateDeliveryErr));
                }

                db.run('COMMIT', (commitErr) => {
                  if (commitErr) {
                    return db.run('ROLLBACK', () => res.status(500).json(commitErr));
                  }
                  return res.json({
                    payment_id: payment.payment_id,
                    delivery_id: payment.delivery_id,
                    payment_method: normalizePaymentMethod(payment.payment_method),
                    payment_status: 'paid',
                    delivery_status: 'paid',
                    message: 'Payment approved and delivery marked as paid.'
                  });
                });
              }
            );
          }
        );
      }
    );
  });
});

// [PAYMENT] Delete payment by id.
app.delete('/payments/:id', (req, res) =>
  deleteById('payments', 'payment_id', req.params.id, res)
);

// ==========================
// START SERVER
// ==========================
const PORT = Number.parseInt(process.env.PORT, 10) || 4000;
const HOST = process.env.HOST || '0.0.0.0';

const server = app.listen(PORT, HOST, () => {
  console.log(`Postal Delivery System API running on http://localhost:${PORT} (pid: ${process.pid})`);
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the existing process or choose another port.`);
  } else {
    console.error('Failed to start server:', err);
  }
  process.exit(1);
});
