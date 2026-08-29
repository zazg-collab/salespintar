import { redisCache } from '../config/redis';

async function main() {
  const keys = await redisCache.keys('hl:full_history:*:*:6285379374006@s.whatsapp.net');
  if (keys.length > 0) {
    const history = await redisCache.lrange(keys[0], 0, -1);
    console.log(history.join('\n'));
  } else {
    console.log('No keys found');
  }
}

main().catch(console.error).finally(() => {
  redisCache.disconnect();
  process.exit(0);
});
