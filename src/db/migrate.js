const fs = require('fs');
const path = require('path');
const db = require('./index');

async function migrate() {
  const schemaPath = path.join(__dirname, '..', '..', 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  await db.query(schema);
  console.log(JSON.stringify({ level: 'info', event: 'database_schema_ready' }));
}

module.exports = { migrate };
