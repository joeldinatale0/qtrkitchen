const db = require("../db");

const newItems = {
  food: [
    ["Egg & Bacon Muffin", "ea"],
    ["Egg & Bacon Wrap", "ea"],
    ["Egg & Spinach Wrap", "ea"],
    ["Ham Cheese Croissant", "ea"],
    ["Ham Cheese Toastie", "ea"],
    ["Cheese Toastie", "ea"],
    ["Cheese & Tomato Toastie", "ea"],
    ["Spanakopita", "ea"],
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
  pastries: [
    ["Carrot Cake", "ea"],
    ["Banana Bread Loaf", "ea"],
    ["M&M Cookie", "ea"],
    ["Choc Chip Cookie", "ea"],
  ],
};

db.prepare("UPDATE categories SET name = 'Grab n Go' WHERE slug = 'cans'").run();

const deleteOldItems = db.prepare("DELETE FROM items WHERE category_id = ?");
const insertItem = db.prepare(
  "INSERT INTO items (category_id, name, unit, sort_order) VALUES (?, ?, ?, ?)"
);

for (const [catSlug, items] of Object.entries(newItems)) {
  const cat = db.prepare("SELECT id FROM categories WHERE slug = ?").get(catSlug);
  if (!cat) {
    console.error(`Category not found: ${catSlug}`);
    continue;
  }
  deleteOldItems.run(cat.id);
  items.forEach(([name, unit], i) => {
    insertItem.run(cat.id, name, unit, i + 1);
  });
  console.log(`Updated category "${catSlug}" with ${items.length} items.`);
}

console.log("Catalog update complete.");
