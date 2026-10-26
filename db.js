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

  -- Del Re is a separate wholesale supplier, entirely independent of the
  -- central kitchen catalog/order flow above. Shops fill in a par/stock
  -- checklist and get back a plain-text list to copy and text the supplier;
  -- the kitchen can browse every past submission across all shops.
  CREATE TABLE IF NOT EXISTS delre_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS delre_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL REFERENCES delre_categories(id),
    name TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT 'ea',
    par_level INTEGER,
    active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS delre_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS delre_order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES delre_orders(id) ON DELETE CASCADE,
    item_id INTEGER REFERENCES delre_items(id),
    name TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT 'ea',
    current_stock INTEGER,
    quantity INTEGER NOT NULL
  );

  -- Daily sales targets per shop, by weekday (0 = Sunday .. 6 = Saturday),
  -- used by the daily shop report email's "sales vs target" line.
  CREATE TABLE IF NOT EXISTS shop_sales_targets (
    shop_slug TEXT NOT NULL,
    weekday INTEGER NOT NULL,
    target_cents INTEGER NOT NULL,
    PRIMARY KEY (shop_slug, weekday)
  );

  CREATE TABLE IF NOT EXISTS daily_report_log (
    report_date TEXT NOT NULL,
    shop_slug TEXT NOT NULL,
    sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(report_date, shop_slug)
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
ensureColumn("items", "price", "REAL");
ensureColumn("items", "shop_id", "INTEGER REFERENCES users(id)"); // NULL = visible to all shops; set = that shop only

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
      "INSERT INTO items (category_id, name, unit, sort_order, par_level, price, shop_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    const starterItems = {
      food: [
        ["Egg & Bacon Muffin", "ea", 20, 3.8],
        ["Egg & Bacon Wrap", "ea", null, 4.5],
        ["Egg & Bacon Toastie", "ea", null, 4.5],
        ["Egg & Spinach Wrap", "ea", null, 3.8],
        ["Ham Cheese Croissant", "ea", null, 4.0],
        ["Ham Cheese Toastie", "ea", null, 4.0],
        ["Cheese Toastie", "ea", null, 3.5],
        ["Cheese & Tomato Toastie", "ea"],
        ["Spanakopita", "tray"],
        ["Halloumi Pie", "ea"],
        ["Lamb Ragu Toastie", "ea", null, 7.0],
        ["Nonnas Meatball Toastie", "ea", null, 4.5],
        ["Chicken Schnitz Toastie", "ea", null, 5.0],
        ["Chicken Caesar Wrap", "ea", null, 4.0],
        ["Sweet Chilli Chicken Wrap", "ea", null, 4.8],
        ["Grilled Chicken & Avo Toastie", "ea", null, 5.0],
        ["Mushroom & Cheese Toastie", "ea", null, 4.0],
        ["Chicken Cheese & Mushroom Boat", "ea"],
        ["Chicken Cheese & BBQ Sauce Boat", "ea"],
        ["Vegetarian Toastie", "ea", null, 4.0],
        ["Ruben Bagel", "ea", null, 6.5],
        ["Salmon Bagel", "ea", null, 6.5],
        ["Bacon & Egg Bagel", "ea", null, 5.0],
        ["Birria Toastie", "ea"],
        // Essendon-only ingredient components
        ["Grilled Chicken Pieces", "ea", null, null, "essendon"],
        ["Chicken Schnitzel Pieces", "ea", null, null, "essendon"],
        ["Avocado", "ea", null, null, "essendon"],
        ["Ham", "bundle", null, null, "essendon"],
        ["Walnuts", "container", null, null, "essendon"],
        ["Scroll Icing", "container", null, null, "essendon"],
        ["Granola", "container", null, null, "essendon"],
        ["Mushrooms", "container", null, null, "essendon"],
      ],
      cans: [
        ["Oats - Nutella", "ea", null, 3.0],
        ["Oats - Vanilla", "ea", null, 3.0],
        ["Oats - Biscoff", "ea", null, 3.0],
        ["Berry Chia", "ea", null, 3.0],
        ["Mango Chia", "ea", null, 3.0],
        ["Berry Yoghurt", "ea", null, 3.0],
        ["Mango Yoghurt", "ea", null, 3.0],
      ],
      juices: [
        ["Watermelon Juice", "2L"],
      ],
      pastries: [
        ["Carrot Cake", "cake", null, 45.0],
        ["Banana Bread Loaf", "loaf", null, 14.0],
        ["M&M Cookie", "ea"],
        ["Choc Chip Cookie", "ea"],
        ["Sweet Muffins", "ea", null, 2.5],
      ],
      paper: [
        ["4oz Cups (2,000/box)", "box", null, 66.88],
        ["6oz Cups (1,000/box)", "box", null, 41.26],
        ["8oz Cups (2,000/box)", "box", null, 65.72],
        ["12oz Cups (2,000/box)", "box", null, 72.32],
        ["16oz Cups (1,000/box)", "box", null, 54.33],
        ["63mm Lids (1,000/box)", "box", null, 18.38],
        ["80mm Lids (1,000/box)", "box", null, 25.20],
        ["90mm Lids (1,000/box)", "box", null, 31.71],
        ["BG001 Handled Bags (400/box)", "box", null, 79.26],
        ["BG002 Large Handled Bags (250/box)", "box", null, 67.77],
        ["Burger Boxes (600/box)", "box", null, 84.86],
        ["Small Lunchboxes (600/box)", "box", null, 88.38],
        ["Large Lunchboxes (300/box)", "box", null, 53.88],
        ["G1 Greaseproof Sheets (5,000/box)", "box", null, 118.51],
        ["G2 240x240 Greaseproof (2,000/box)", "box", null, 116.10],
        ["4-Cup Carry Trays (100/box)", "box", null, 17.26],
        ["C1 Containers + Matching Lids (300 sets/box)", "box", null, 35.08],
        ["Straws (10,000/box)", "box", null, 156.57],
        ["500ml Cans + Caps (100/box)", "box", null, 27.81],
        ["Napkins (3,000/box)", "box", null, 75.71],
      ],
    };
    const getShopForSeed = db.prepare("SELECT id FROM users WHERE slug = ? AND role = 'shop'");
    for (const [catSlug, items] of Object.entries(starterItems)) {
      items.forEach(([name, unit, parLevel, price, shopOnlySlug], i) => {
        const shopId = shopOnlySlug ? getShopForSeed.get(shopOnlySlug)?.id ?? null : null;
        insertItem.run(catIds[catSlug], name, unit, i + 1, parLevel ?? null, price ?? null, shopId);
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
    "Egg & Bacon Toastie": 6,
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
    "Ruben Bagel": 6,
    "Salmon Bagel": 6,
    "Bacon & Egg Bagel": 6,
    "Sweet Muffins": 6,
    "Birria Toastie": 6,
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
    ["Egg & Bacon Toastie", 6, null],
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
    ["Ruben Bagel", 6, null],
    ["Salmon Bagel", 6, null],
    ["Bacon & Egg Bagel", 6, null],
    ["Sweet Muffins", 6, null],
    ["Birria Toastie", 6, null],
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

function seedDelReIfEmpty() {
  const catCount = db.prepare("SELECT COUNT(*) AS c FROM delre_categories").get().c;
  if (catCount > 0) return;

  const insertCat = db.prepare(
    "INSERT INTO delre_categories (name, sort_order) VALUES (?, ?)"
  );
  const insertItem = db.prepare(
    "INSERT INTO delre_items (category_id, name, unit, par_level, sort_order) VALUES (?, ?, ?, ?, ?)"
  );

  const sections = [
    ["Dairy & Creams", [["Vanilla Ice Cream", "tub", 2]]],
    [
      "Frozen Fruits",
      [
        ["Frozen Strawberries", "bag", 4],
        ["Frozen Mango", "bag", 4],
        ["Frozen Blueberries", "bag", 4],
      ],
    ],
    [
      "Sweeteners & Syrups",
      [
        ["Maple Syrup", "bottle", 6],
        ["Honey", "bottle", 3],
      ],
    ],
    [
      "Other Essentials",
      [
        ["Marshmallows", "bag", 2],
        ["Veg Oil", "2L", 4],
      ],
    ],
    [
      "Dry Goods & Baking",
      [
        ["Muffin Mix", "bag", 2],
        ["Self Raising Flour", "bag", 2],
        ["Plain Flour", "bag", 2],
        ["Brown Sugar", "bag", 2],
        ["Caster Sugar", "bag", 2],
        ["Cinnamon", "bag", 1],
        ["Vanilla Extract", "bottle", 2],
        ["Nutella", "tub", 1],
        ["Biscoff", "tub", 1],
        ["Milk Choc Chips Callebaut", "bag", 3],
        ["Dark Choc Chips Callebaut", "bag", 1],
        ["Chia Seeds", "kg", 2],
        ['10" Flour Tortilla', "box", 2],
      ],
    ],
  ];

  sections.forEach(([catName, items], ci) => {
    const { lastInsertRowid: catId } = insertCat.run(catName, ci + 1);
    items.forEach(([name, unit, par], i) => {
      insertItem.run(catId, name, unit, par, i + 1);
    });
  });
}

// Weekday: 0 = Sunday .. 6 = Saturday, matching JS Date#getDay(). Seeds each
// shop independently (not gated on the table being empty overall) so a new
// shop's targets still get inserted even after earlier shops are already seeded.
function seedSalesTargetsIfEmpty() {
  const insert = db.prepare(
    "INSERT INTO shop_sales_targets (shop_slug, weekday, target_cents) VALUES (?, ?, ?)"
  );
  const hasTargets = (slug) =>
    db.prepare("SELECT 1 FROM shop_sales_targets WHERE shop_slug = ?").get(slug);

  const targetsByShop = {
    essendon: {
      0: 550000, // Sunday $5.5k
      1: 450000, // Monday $4.5k
      2: 450000, // Tuesday $4.5k
      3: 450000, // Wednesday $4.5k
      4: 450000, // Thursday $4.5k
      5: 470000, // Friday $4.7k
      6: 600000, // Saturday $6k
    },
    highpoint: {
      0: 800000, // Sunday $8k
      1: 500000, // Monday $5k
      2: 500000, // Tuesday $5k
      3: 500000, // Wednesday $5k
      4: 600000, // Thursday $6k
      5: 700000, // Friday $7k
      6: 900000, // Saturday $9k
    },
  };

  for (const [slug, targets] of Object.entries(targetsByShop)) {
    if (hasTargets(slug)) continue;
    for (const [weekday, targetCents] of Object.entries(targets)) {
      insert.run(slug, Number(weekday), targetCents);
    }
  }
}

seedIfEmpty();
seedParsIfEmpty();
seedDelReIfEmpty();
seedSalesTargetsIfEmpty();

module.exports = db;
module.exports.dbPath = dbPath;
