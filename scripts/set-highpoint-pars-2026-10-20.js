const db = require("../db");

const shop = db.prepare("SELECT id FROM users WHERE slug = 'highpoint'").get();
if (!shop) {
  console.error("Highpoint shop not found");
  process.exit(1);
}

const pars = {
  "Egg & Bacon Muffin": 14,
  "Egg & Bacon Wrap": 14,
  "Egg & Spinach Wrap": 7,
  "Ham Cheese Croissant": 12,
  "Ham Cheese Toastie": 14,
  "Cheese Toastie": 6,
  // Cheese & Tomato Toastie: NA — intentionally no par level for this shop
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

const getItem = db.prepare("SELECT id FROM items WHERE name = ?");
const upsert = db.prepare(
  `INSERT INTO shop_item_pars (shop_id, item_id, par_level) VALUES (?, ?, ?)
   ON CONFLICT(shop_id, item_id) DO UPDATE SET par_level = excluded.par_level`
);

let count = 0;
for (const [name, par] of Object.entries(pars)) {
  const item = getItem.get(name);
  if (!item) {
    console.error(`NOT FOUND: ${name}`);
    continue;
  }
  upsert.run(shop.id, item.id, par);
  count++;
}

console.log(`Set ${count} par levels for Highpoint.`);
