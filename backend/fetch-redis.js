const Redis = require('ioredis');
const redis = new Redis('redis://127.0.0.1:6379');
async function run() {
  const keys = await redis.keys('hl:full_history:*:*:6285379374006@s.whatsapp.net');
  if (keys.length > 0) {
    const list = await redis.lrange(keys[0], 0, -1);
    console.log(list.join('\n'));
  } else {
    console.log('Not found');
  }
}
run().finally(() => redis.quit());
