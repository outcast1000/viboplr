// pickRelayFromList(rows): pick one healthy relay at random.
// `rows` is an array of { peer_id: string, multiaddrs: string[] }.
// Returns { peerId, multiaddr } or null if no usable row.
function pickRelayFromList(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  var candidates = rows.filter(function (r) {
    return r && Array.isArray(r.multiaddrs) && r.multiaddrs.length > 0;
  });
  if (candidates.length === 0) return null;
  var row = candidates[Math.floor(Math.random() * candidates.length)];
  var addr = row.multiaddrs[Math.floor(Math.random() * row.multiaddrs.length)];
  return { peerId: row.peer_id, multiaddr: addr };
}

export { pickRelayFromList };
