import 'dotenv/config';
import { createClient } from 'redis';

const client = createClient({
    url: process.env.REDIS_URL
});

client.on('connect', () => console.log('CONNECT'));
client.on('ready', () => console.log('READY'));
client.on('reconnecting', () => console.log('RECONNECTING'));
client.on('end', () => console.log('END'));
client.on('error', (err) => console.error('ERROR:', err));

try {
    console.log('REDIS_URL:', process.env.REDIS_URL);

    await client.connect();

    const pong = await client.ping();
    console.log('PING:', pong);

    await client.quit();
}
catch (err) {
    console.error('FAILED:', err);
}