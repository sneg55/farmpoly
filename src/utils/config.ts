import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

dotenv.config();

export interface EnvConfig {
  polygonPrivateKey: string;
  polygonRpcUrl: string;
  clobApiUrl: string;
  gammaApiUrl: string;
  dataApiUrl: string;
}

function isGitTracked(filePath: string): boolean {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", filePath], {
      stdio: "pipe",
      cwd: path.dirname(filePath),
    });
    return true;
  } catch {
    return false;
  }
}

function validatePrivateKey(key: string): string {
  const cleaned = key.startsWith("0x") ? key.slice(2) : key;
  if (!/^[0-9a-fA-F]{64}$/.test(cleaned)) {
    throw new Error("POLYGON_PRIVATE_KEY must be a 64-character hex string");
  }
  return cleaned;
}

function validateUrl(url: string, name: string): string {
  if (!url.startsWith("https://") && !url.startsWith("wss://")) {
    throw new Error(`${name} must use https:// or wss:// scheme (got: ${url})`);
  }
  return url;
}

export function loadEnv(): EnvConfig {
  const envPath = path.resolve(process.cwd(), ".env");

  if (existsSync(envPath) && isGitTracked(envPath)) {
    throw new Error(
      "SECURITY: .env file is tracked by git! Run: git rm --cached .env",
    );
  }

  const rawKey = process.env.POLYGON_PRIVATE_KEY;
  if (!rawKey) {
    throw new Error("POLYGON_PRIVATE_KEY is required in .env");
  }

  const rpcUrl = process.env.POLYGON_RPC_URL || "https://polygon-rpc.com";
  const clobUrl = process.env.CLOB_API_URL || "https://clob.polymarket.com";
  const gammaUrl = process.env.GAMMA_API_URL || "https://gamma-api.polymarket.com";
  const dataApiUrl = process.env.POLYMARKET_DATA_API_URL || "https://data-api.polymarket.com";

  // Validate secure schemes for custom URLs
  if (process.env.POLYGON_RPC_URL) validateUrl(rpcUrl, "POLYGON_RPC_URL");
  if (process.env.CLOB_API_URL) validateUrl(clobUrl, "CLOB_API_URL");
  if (process.env.GAMMA_API_URL) validateUrl(gammaUrl, "GAMMA_API_URL");
  if (process.env.POLYMARKET_DATA_API_URL) validateUrl(dataApiUrl, "POLYMARKET_DATA_API_URL");

  return {
    polygonPrivateKey: validatePrivateKey(rawKey),
    polygonRpcUrl: rpcUrl,
    clobApiUrl: clobUrl,
    gammaApiUrl: gammaUrl,
    dataApiUrl,
  };
}
