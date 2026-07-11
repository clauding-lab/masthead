const DEV_ORIGINS = ['http://localhost:5173', 'http://localhost:4173', 'http://localhost:3001'];

export function resolveCorsOrigin(requestOrigin) {
  const configured = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allowed = [...configured, ...DEV_ORIGINS];
  if (requestOrigin && allowed.includes(requestOrigin)) return requestOrigin;
  return allowed[0];
}

export function applyCors(req, res, methods = 'POST, OPTIONS') {
  res.setHeader('Access-Control-Allow-Origin', resolveCorsOrigin(req.headers?.origin));
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

export function clientIp(req) {
  const xff = req.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}
