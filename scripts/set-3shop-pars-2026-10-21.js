const db = require("../db");

const shopSlugs = ["essendon", "mooneeponds", "melbournecentral"];

// [name, weekday par, weekend par or null if same as weekday]
const pars = [
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

const getItem = db.prepare("SELECT id FROM items WHERE name = ?");
const getShop = db.prepare("SELECT id, name FROM users WHERE slug = ? AND role = 'shop'");
const upsert = db.prepare(
  `INSERT INTO shop_item_pars (shop_id, item_id, par_level, par_level_weekend) VALUES (?, ?, ?, ?)
   ON CONFLICT(shop_id, item_id) DO UPDATE SET par_level = excluded.par_level, par_level_weekend = excluded.par_level_weekend`
);

for (const slug of shopSlugs) {
  const shop = getShop.get(slug);
  if (!shop) {
    console.error(`NOT FOUND shop: ${slug}`);
    continue;
  }
  let count = 0;
  for (const [name, weekday, weekend] of pars) {
    const item = getItem.get(name);
    if (!item) {
      console.error(`NOT FOUND item: ${name}`);
      continue;
    }
    upsert.run(shop.id, item.id, weekday, weekend);
    count++;
  }
  console.log(`${shop.name}: set ${count} par levels`);
}
