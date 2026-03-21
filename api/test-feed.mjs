export default async function handler(req, res) {
  const start = Date.now();
  try {
    const response = await fetch('https://hnrss.org/frontpage', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Masthead/1.0)' },
      signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    res.status(200).json({
      ok: true,
      status: response.status,
      length: text.length,
      ms: Date.now() - start,
      preview: text.substring(0, 200),
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
      ms: Date.now() - start,
    });
  }
}
