import { default as worker } from './src/worker.js';

const env = {
  DISCORD_CLIENT_ID: '123456789012345678',
  DISCORD_CLIENT_SECRET: 'dummy-secret',
  DISCORD_REDIRECT_URI: 'https://127.0.0.1'
};

const r = await worker.fetch(new Request('https://test.workers.dev/api/token', {
  method: 'POST',
  body: JSON.stringify({ code: 'dummy-code' }),
  headers: { 'Content-Type': 'application/json' }
}), env);

console.log('status:', r.status);
console.log('body:', await r.text());
