import { randomBytes, scrypt as nodeScrypt, timingSafeEqual, createHash } from "node:crypto";
const COST = 1 << 15;

function derive(password: string, salt: Buffer, length: number, cost: number): Promise<Buffer> {
  return new Promise((resolve, reject) => nodeScrypt(password, salt, length, { N: cost, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await derive(password, salt, 64, COST);
  return `scrypt$${COST}$8$1$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  try {
    const [algorithm, costText, rText, pText, saltText, hashText] = encoded.split("$");
    if (algorithm !== "scrypt" || !costText || !rText || !pText || !saltText || !hashText) return false;
    const cost = Number(costText); const r = Number(rText); const p = Number(pText);
    if (![1 << 14, 1 << 15].includes(cost) || r !== 8 || p !== 1) return false;
    const expected = Buffer.from(hashText, "base64url");
    const actual = await derive(password, Buffer.from(saltText, "base64url"), expected.length, cost);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch { return false; }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newOpaqueToken(): string {
  return randomBytes(32).toString("hex");
}
