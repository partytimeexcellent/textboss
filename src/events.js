// Server-sent events: each signed-in browser tab holds one stream, and the
// server pushes message/conversation updates to the users who can see them.

const clients = new Map(); // userId -> Set<res>

export function subscribe(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  const userId = req.user.id;
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);

  // A real event (not a comment) so the browser can tell the stream is still alive
  const ping = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    clients.get(userId)?.delete(res);
  });
}

export function publish(userIds, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const id of userIds) {
    for (const res of clients.get(id) ?? []) res.write(payload);
  }
}
