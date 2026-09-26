const db = require('./db');

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('数据库初始化完成:', db.DB_PATH);
console.log('数据表:', tables.map((t) => t.name).join(', '));
db.close();
