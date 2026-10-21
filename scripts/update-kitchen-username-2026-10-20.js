const db = require("../db");

const result = db
  .prepare("UPDATE users SET username = 'kitchenstaff' WHERE slug = 'kitchen'")
  .run();

console.log(result.changes ? "Kitchen username updated to 'kitchenstaff'." : "Kitchen user not found.");
