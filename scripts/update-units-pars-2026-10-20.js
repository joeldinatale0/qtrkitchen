const db = require("../db");

const updates = [
  { name: "Carrot Cake", unit: "cake" },
  { name: "Banana Bread Loaf", unit: "loaf" },
  { name: "Spanakopita", unit: "tray" },
];

const updateUnit = db.prepare("UPDATE items SET unit = ? WHERE name = ?");
for (const u of updates) {
  const r = updateUnit.run(u.unit, u.name);
  console.log(`${u.name}: unit -> ${u.unit} (${r.changes ? "updated" : "NOT FOUND"})`);
}

const parResult = db
  .prepare("UPDATE items SET par_level = 20 WHERE name = 'Egg & Bacon Muffin'")
  .run();
console.log(`Egg & Bacon Muffin: par_level -> 20 (${parResult.changes ? "updated" : "NOT FOUND"})`);
