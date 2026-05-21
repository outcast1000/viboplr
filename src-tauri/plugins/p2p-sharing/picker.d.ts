export interface RelayPickResult {
  peerId: string;
  multiaddr: string;
}

export interface RelayRow {
  peer_id: string;
  multiaddrs: string[];
}

export function pickRelayFromList(rows: RelayRow[]): RelayPickResult | null;
