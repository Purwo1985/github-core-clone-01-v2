// Entrypoint: build the store from the deterministic trial identities,
// listen on an ephemeral port, register it with the trial environment,
// then long-poll /done until the trial ends and shut down cleanly.
//
// Environment (set by the trial harness):
//   MAKEFUN_ENV_URL    base URL of the environment service (required)
//   MAKEFUN_SHOP_TOKEN the bearer token clients must present (empty = dev mode)
//   MAKEFUN_TRIAL_NOW  the deterministic "now" in epoch seconds

import { deriveIdentities } from './src/identity.ts';
import { Store } from './src/store.ts';
import { createApp } from './src/forge.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const TRIAL_NOW = Number.parseInt(process.env.MAKEFUN_TRIAL_NOW ?? '', 10);

if (ENV_URL === '') {
  console.error('MAKEFUN_ENV_URL is not set');
  process.exit(1);
}

const trialNowSec = Number.isFinite(TRIAL_NOW) ? TRIAL_NOW : 1_735_689_600;
const { viewer } = deriveIdentities();
const store = new Store(viewer, TOKEN, trialNowSec);
const server = createApp(store);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url: string, body: unknown): Promise<number> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  // Drain the body so the connection can be reused or closed cleanly.
  await response.text();
  return response.status;
}

async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { method: 'GET' });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

async function register(port: number): Promise<void> {
  const url = `${ENV_URL.replace(/\/$/, '')}/register`;
  let delayMs = 250;
  for (;;) {
    let status: number;
    try {
      status = await postJson(url, { port });
    } catch {
      status = 0;
    }
    if (status === 200 || status === 409) return;
    if (status === 400 || status === 405) {
      console.error(`register rejected with HTTP ${status}; giving up`);
      process.exit(1);
    }
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, 2000);
  }
}

async function waitForDone(): Promise<void> {
  const url = `${ENV_URL.replace(/\/$/, '')}/done`;
  for (;;) {
    try {
      const { status, body } = await getJson(url);
      if (status === 200 && body !== null && typeof body === 'object' && (body as Record<string, unknown>).done === true) {
        return;
      }
    } catch {
      // The environment service may restart; keep polling.
    }
    await sleep(1000);
  }
}

async function main(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    console.error('could not determine the listening port');
    process.exit(1);
  }
  await register(address.port);
  await waitForDone();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
