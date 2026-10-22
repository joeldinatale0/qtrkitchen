const path = require("path");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");

const dbPath = process.env.DB_PATH || path.join(__dirname, "data.sqlite");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('shop', 'kitchen'))
  );

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_custom INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    name TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT 'ea',
    active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    par_level INTEGER
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id INTEGER NOT NULL REFERENCES users(id),
    delivery_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'prepared')),
    is_late INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(shop_id, delivery_date)
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    item_id INTEGER REFERENCES items(id),
    name TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT 'ea',
    quantity REAL NOT NULL,
    current_stock INTEGER,
    note TEXT
  );

  CREATE TABLE IF NOT EXISTS shop_item_pars (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id INTEGER NOT NULL REFERENCES users(id),
    item_id INTEGER NOT NULL REFERENCES items(id),
    par_level INTEGER NOT NULL,
    UNIQUE(shop_id, item_id)
  );

  CREATE TABLE IF NOT EXISTS backup_log (
    backup_date TEXT PRIMARY KEY,
    sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS invoice_log (
    week_start_date TEXT NOT NULL,
    shop_id INTEGER NOT NULL REFERENCES users(id),
    sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(week_start_date, shop_id)
  );
`);

// Idempotent migrations for columns added after initial release — safe to
// run on every boot, including against the existing production database.
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn("items", "par_level", "INTEGER");
ensureColumn("orders", "is_late", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("order_items", "current_stock", "INTEGER");
ensureColumn("shop_item_pars", "par_level_weekend", "INTEGER");

function seedIfEmpty() {
  const userCount = db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
  if (userCount === 0) {
    const insertUser = db.prepare(
      "INSERT INTO users (slug, name, username, password_hash, role) VALUES (?, ?, ?, ?, ?)"
    );
    const shops = [
      ["essendon", "QTR Essendon", "essendon", "QTRESSENDON"],
      ["highpoint", "QTR Highpoint", "highpoint", "QTRHP"],
      ["mooneeponds", "QTR Moonee Ponds", "mooneeponds", "QTRMP"],
      ["melbournecentral", "QTR Melbourne Central", "melbournecentral", "QTRMC"],
    ];
    for (const [slug, name, username, pw] of shops) {
      insertUser.run(slug, name, username, bcrypt.hashSync(pw, 10), "shop");
    }
    insertUser.run(
      "kitchen",
      "Central Kitchen (Moonee Ponds)",
      "kitchenstaff",
      bcrypt.hashSync("kitchen2026", 10),
      "kitchen"
    );
  }

  const catCount = db.prepare("SELECT COUNT(*) AS c FROM categories").get().c;
  if (catCount === 0) {
    const insertCat = db.prepare(
      "INSERT INTO categories (slug, name, sort_order, is_custom) VALUES (?, ?, ?, ?)"
    );
    const categories = [
      ["food", "Food", 1, 0],
      ["cans", "Grab n Go", 2, 0],
      ["juices", "Juices", 3, 0],
      ["pastries", "Pastries / Cakes", 4, 0],
      ["paper", "Paper Goods", 5, 0],
      ["other", "Other (Custom Request)", 6, 1],
    ];
    const catIds = {};
    for (const [slug, name, sort, isCustom] of categories) {
      const { lastInsertRowid } = insertCat.run(slug, name, sort, isCustom);
      catIds[slug] = lastInsertRowid;
    }

    const insertItem = db.prepare(
      "INSERT INTO items (category_id, name, unit, sort_order, par_level) VALUES (?, ?, ?, ?, ?)"
    );
    const starterItems = {
      food: [
        ["Egg & Bacon Muffin", "ea", 20],
        ["Egg & Bacon Wrap", "ea"],
        ["Egg & Spinach Wrap", "ea"],
        ["Ham Cheese Croissant", "ea"],
        ["Ham Cheese Toastie", "ea"],
        ["Cheese Toastie", "ea"],
        ["Cheese & Tomato Toastie", "ea"],
        ["Spanakopita", "tray"],
        ["Halloumi Pie", "ea"],
        ["Lamb Ragu Toastie", "ea"],
        ["Nonnas Meatball Toastie", "ea"],
        ["Chicken Schnitz Toastie", "ea"],
        ["Chicken Caesar Wrap", "ea"],
        ["Sweet Chilli Chicken Wrap", "ea"],
        ["Grilled Chicken & Avo Toastie", "ea"],
        ["Mushroom & Cheese Toastie", "ea"],
        ["Chicken Cheese & Mushroom Boat", "ea"],
        ["Chicken Cheese & BBQ Sauce Boat", "ea"],
        ["Vegetarian Toastie", "ea"],
      ],
      cans: [
        ["Oats - Nutella", "ea"],
        ["Oats - Vanilla", "ea"],
        ["Oats - Biscoff", "ea"],
        ["Berry Chia", "ea"],
        ["Mango Chia", "ea"],
        ["Berry Yoghurt", "ea"],
        ["Mango Yoghurt", "ea"],
      ],
      juices: [
        ["Orange Juice 250ml", "ea"],
        ["Apple Juice 250ml", "ea"],
      ],
      pastries: [
        ["Carrot Cake", "cake"],
        ["Banana Bread Loaf", "loaf"],
        ["M&M Cookie", "ea"],
        ["Choc Chip Cookie", "ea"],
      ],
      paper: [
        ["Coffee Cup 8oz", "sleeve"],
        ["Coffee Cup 12oz", "sleeve"],
        ["Cup Lids 8oz", "sleeve"],
        ["Napkins", "pack"],
        ["Takeaway Bags", "pack"],
      ],
    };
    for (const [catSlug, items] of Object.entries(starterItems)) {
      items.forEach(([name, unit, parLevel], i) => {
        insertItem.run(catIds[catSlug], name, unit, i + 1, parLevel ?? null);
      });
    }
  }
}

// Per-shop par levels — the actual configured values for each store, not
// placeholders. Previously only ever applied via one-off migration scripts
// run against the live database; baked in here so a fresh database (e.g. a
// new hosting provider) comes up fully configured with no manual steps.
function seedParsIfEmpty() {
  const parCount = db.prepare("SELECT COUNT(*) AS c FROM shop_item_pars").get().c;
  if (parCount > 0) return;

  const getItem = db.prepare("SELECT id FROM items WHERE name = ?");
  const getShop = db.prepare("SELECT id FROM users WHERE slug = ? AND role = 'shop'");
  const upsert = db.prepare(
    `INSERT INTO shop_item_pars (shop_id, item_id, par_level, par_level_weekend) VALUES (?, ?, ?, ?)
     ON CONFLICT(shop_id, item_id) DO UPDATE SET par_level = excluded.par_level, par_level_weekend = excluded.par_level_weekend`
  );

  // Highpoint: single shop, weekday-only pars (no weekend variation given).
  const highpointPars = {
    "Egg & Bacon Muffin": 14,
    "Egg & Bacon Wrap": 14,
    "Egg & Spinach Wrap": 7,
    "Ham Cheese Croissant": 12,
    "Ham Cheese Toastie": 14,
    "Cheese Toastie": 6,
    Spanakopita: 1,
    "Halloumi Pie": 6,
    "Lamb Ragu Toastie": 6,
    "Nonnas Meatball Toastie": 6,
    "Chicken Schnitz Toastie": 6,
    "Chicken Caesar Wrap": 7,
    "Sweet Chilli Chicken Wrap": 10,
    "Grilled Chicken & Avo Toastie": 12,
    "Mushroom & Cheese Toastie": 4,
    "Chicken Cheese & Mushroom Boat": 6,
    "Chicken Cheese & BBQ Sauce Boat": 6,
    "Vegetarian Toastie": 5,
    "Carrot Cake": 2,
    "Banana Bread Loaf": 2,
    "M&M Cookie": 15,
    "Choc Chip Cookie": 15,
    "Oats - Nutella": 15,
    "Oats - Vanilla": 15,
    "Oats - Biscoff": 15,
    "Berry Chia": 15,
    "Mango Chia": 15,
    "Berry Yoghurt": 15,
    "Mango Yoghurt": 15,
  };
  const highpoint = getShop.get("highpoint");
  if (highpoint) {
    for (const [name, par] of Object.entries(highpointPars)) {
      const item = getItem.get(name);
      if (item) upsert.run(highpoint.id, item.id, par, null);
    }
  }

  // Essendon, Moonee Ponds, Melbourne Central: same pars, with weekday/weekend split.
  const threeShopPars = [
    ["Egg & Bacon Muffin", 22, 30],
    ["Grilled Chicken & Avo Toastie", 14, 18],
    ["Ham Cheese Croissant", 14, 18],
    ["Ham Cheese Toastie", 16, 20],
    ["Mushroom & Cheese Toastie", 6, null],
    ["Halloumi Pie", 6, null],
    ["Sweet Chilli Chicken Wrap", 10, null],
    ["Spanakopita", 1, null],
    ["Choc Chip Cookie", 10, 15],
    ["M&M Cookie", 10, 15],
    ["Banana Bread Loaf", 2, null],
    ["Carrot Cake", 1, null],
  ];
  for (const slug of ["essendon", "mooneeponds", "melbournecentral"]) {
    const shop = getShop.get(slug);
    if (!shop) continue;
    for (const [name, weekday, weekend] of threeShopPars) {
      const item = getItem.get(name);
      if (item) upsert.run(shop.id, item.id, weekday, weekend);
    }
  }
}

seedIfEmpty();
seedParsIfEmpty();

module.exports = db;
module.exports.dbPath = dbPath;
