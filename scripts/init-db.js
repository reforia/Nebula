// Standalone script to initialize the database
// Usage: DATA_DIR=./data node scripts/init-db.js

process.env.DATA_DIR = process.env.DATA_DIR || './data';

import('../src/db.js').then(() => {
  console.log('Database initialized successfully');
  process.exit(0);
}).catch((err) => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
