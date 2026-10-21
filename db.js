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

seedIfEmpty();

module.exports = db;
module.exports.dbPath = dbPath;
