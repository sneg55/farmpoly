import { Wallet } from "ethers";
import { ClobClient } from "@polymarket/clob-client";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import type { PolyfarmDb } from "../db/database.js";
import type { EnvConfig } from "../utils/config.js";

const CHAIN_ID = 137; // Polygon mainnet

export interface AuthContext {
  wallet: Wallet;
  clobClient: ClobClient;
  creds: ApiKeyCreds;
}

export async function deriveOrLoadCreds(
  env: EnvConfig,
  db: PolyfarmDb,
): Promise<AuthContext> {
  const wallet = new Wallet(`0x${env.polygonPrivateKey}`);

  // Check for cached creds in SQLite
  const cachedKey = db.getConfig("api_key");
  const cachedSecret = db.getConfig("api_secret");
  const cachedPassphrase = db.getConfig("api_passphrase");

  if (cachedKey && cachedSecret && cachedPassphrase) {
    const creds: ApiKeyCreds = {
      key: cachedKey,
      secret: cachedSecret,
      passphrase: cachedPassphrase,
    };

    const client = new ClobClient(env.clobApiUrl, CHAIN_ID, wallet, creds);

    // Verify creds are still valid
    try {
      await client.getApiKeys();
      return { wallet, clobClient: client, creds };
    } catch {
      // Creds expired, re-derive below
    }
  }

  // Derive new creds via L1 signature
  const tempClient = new ClobClient(env.clobApiUrl, CHAIN_ID, wallet);
  const derivedCreds = await tempClient.deriveApiKey();

  const creds: ApiKeyCreds = {
    key: derivedCreds.key,
    secret: derivedCreds.secret,
    passphrase: derivedCreds.passphrase,
  };

  // Cache in SQLite
  db.setConfig("api_key", creds.key);
  db.setConfig("api_secret", creds.secret);
  db.setConfig("api_passphrase", creds.passphrase);

  const client = new ClobClient(env.clobApiUrl, CHAIN_ID, wallet, creds);
  return { wallet, clobClient: client, creds };
}
