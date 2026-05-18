use std::sync::Arc;
use tokio::sync::RwLock;
use libp2p::Multiaddr;

use super::P2pStatus;

pub struct DiscoveryState {
    pub status: Arc<RwLock<P2pStatus>>,
    pub external_addrs: Arc<RwLock<Vec<Multiaddr>>>,
    pub can_relay: Arc<RwLock<bool>>,
}

impl DiscoveryState {
    pub fn new(status: Arc<RwLock<P2pStatus>>) -> Self {
        Self {
            status,
            external_addrs: Arc::new(RwLock::new(Vec::new())),
            can_relay: Arc::new(RwLock::new(false)),
        }
    }

    pub async fn set_nat_status(&self, is_public: bool) {
        let mut can_relay = self.can_relay.write().await;
        *can_relay = is_public;
        if is_public {
            log::info!("AutoNAT: node is publicly reachable, can act as relay");
        } else {
            log::info!("AutoNAT: node is behind NAT, will use relays");
        }
    }

    pub async fn update_external_addrs(&self, addrs: Vec<Multiaddr>) {
        let mut external = self.external_addrs.write().await;
        *external = addrs;
    }

    pub async fn get_multiaddrs(&self) -> Vec<String> {
        self.external_addrs
            .read()
            .await
            .iter()
            .map(|a| a.to_string())
            .collect()
    }

    pub async fn is_relay_capable(&self) -> bool {
        *self.can_relay.read().await
    }
}
