const fs = require('fs');
const file = '/opt/salespintar/backend/src/routes/business.routes.ts';
let code = fs.readFileSync(file, 'utf8');

code = code.replace("action_source: 'chat',", "action_source: 'website', event_source_url: 'https://salespintar.com/test',");
fs.writeFileSync(file, code);
