const bcrypt = require("bcryptjs");
const db = require("../db");

const newPasswords = {
  essendon: "QTRESSENDON",
  highpoint: "QTRHP",
  mooneeponds: "QTRMP",
  melbournecentral: "QTRMC",
};

const update = db.prepare("UPDATE users SET password_hash = ? WHERE slug = ?");

for (const [slug, pw] of Object.entries(newPasswords)) {
  const hash = bcrypt.hashSync(pw, 10);
  const result = update.run(hash, slug);
  console.log(`${slug}: ${result.changes ? "updated" : "NOT FOUND"}`);
}

console.log("Password update complete.");
