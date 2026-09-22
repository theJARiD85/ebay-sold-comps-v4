import crypto from 'node:crypto';

// Copy this small guard into independently deployed provider packages, including
// the remotely maintained item identifier. Gateway execution uses a server key;
// user identity is forwarded under non-reserved headers and reverified below.
export function requireQuotaGateway(headers = {}, secret = process.env.SELLER_QUOTA_INTERNAL_SECRET) {
  const get = name => Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  // v2 stays gateway-protected by default. Set this only for local/temporary
  // authenticated testing when the subscription police Function is unavailable.
  const configured = typeof process.env.KEEPFLIP_REQUIRE_QUOTA_GATEWAY === 'string'
    ? process.env.KEEPFLIP_REQUIRE_QUOTA_GATEWAY.trim().toLowerCase()
    : '';
  const gatewayRequired = !['0', 'false', 'no', 'off'].includes(configured);
  const jwt = gatewayRequired
    ? get('x-keepflip-user-jwt')
    : (get('x-keepflip-user-jwt') ?? get('x-appwrite-user-jwt'));
  const userId = gatewayRequired
    ? get('x-keepflip-user-id')
    : (get('x-keepflip-user-id') ?? get('x-appwrite-user-id'));
  if (!jwt || !userId) { const error = new Error('Gateway user authentication is missing.'); error.statusCode = 401; throw error; }

  if (gatewayRequired) {
    const actual = get('x-keepflip-provider-secret');
    const expected = typeof secret === 'string' ? secret.trim() : '';
    const a = Buffer.from(typeof actual === 'string' ? actual : '');
    const b = Buffer.from(expected);
    if (!b.length || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      const error = new Error('Use the authenticated KeepFlip AI gateway.');
      error.statusCode = 401;
      throw error;
    }
  }

  // Remove case-insensitive duplicates before inserting the verified forwarding
  // headers. authenticateCaller still verifies the JWT against /account.
  return { ...Object.fromEntries(Object.entries(headers).filter(([key]) => !['x-appwrite-user-id','x-appwrite-user-jwt'].includes(key.toLowerCase()))), 'x-appwrite-user-id': userId, 'x-appwrite-user-jwt': jwt };
}
