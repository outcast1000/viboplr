use libp2p::{
    autonat, dcutr, identify, noise,
    request_response::{self, json, ProtocolSupport},
    swarm::NetworkBehaviour,
    yamux, PeerId, StreamProtocol, Swarm, SwarmBuilder,
};
use std::time::Duration;

use super::protocols::{SearchRequest, SearchResponse, TransferRequest, TransferResponse};

pub const SEARCH_PROTOCOL: &str = "/viboplr/search/1.0.0";
pub const TRANSFER_PROTOCOL: &str = "/viboplr/transfer/1.0.0";

#[derive(NetworkBehaviour)]
pub struct ViboplrBehaviour {
    pub identify: identify::Behaviour,
    pub autonat: autonat::Behaviour,
    pub relay_client: libp2p::relay::client::Behaviour,
    pub dcutr: dcutr::Behaviour,
    pub search: json::Behaviour<SearchRequest, SearchResponse>,
    pub transfer: json::Behaviour<TransferRequest, TransferResponse>,
}

pub fn build_swarm(
    keypair: libp2p::identity::Keypair,
) -> Result<Swarm<ViboplrBehaviour>, Box<dyn std::error::Error>> {
    let local_peer_id = PeerId::from(keypair.public());

    let swarm = SwarmBuilder::with_existing_identity(keypair)
        .with_tokio()
        .with_quic()
        .with_relay_client(noise::Config::new, yamux::Config::default)?
        .with_behaviour(|key, relay_client| {
            let local_peer_id = PeerId::from(key.public());

            let identify = identify::Behaviour::new(identify::Config::new(
                "/viboplr/0.1.0".to_string(),
                key.public(),
            ));

            let autonat = autonat::Behaviour::new(
                local_peer_id,
                autonat::Config {
                    boot_delay: Duration::from_secs(10),
                    refresh_interval: Duration::from_secs(60),
                    ..Default::default()
                },
            );

            let dcutr = dcutr::Behaviour::new(local_peer_id);

            let search = json::Behaviour::<SearchRequest, SearchResponse>::new(
                [(StreamProtocol::new(SEARCH_PROTOCOL), ProtocolSupport::Full)],
                request_response::Config::default()
                    .with_request_timeout(Duration::from_secs(10)),
            );

            let transfer = json::Behaviour::<TransferRequest, TransferResponse>::new(
                [(StreamProtocol::new(TRANSFER_PROTOCOL), ProtocolSupport::Full)],
                request_response::Config::default()
                    .with_request_timeout(Duration::from_secs(300)),
            );

            ViboplrBehaviour {
                identify,
                autonat,
                relay_client,
                dcutr,
                search,
                transfer,
            }
        })?
        .with_swarm_config(|c| {
            c.with_idle_connection_timeout(Duration::from_secs(60))
        })
        .build();

    log::info!("Built P2P swarm with peer_id: {}", local_peer_id);
    Ok(swarm)
}

pub fn load_or_generate_keypair(
    path: &std::path::Path,
) -> Result<libp2p::identity::Keypair, String> {
    if path.exists() {
        let bytes = std::fs::read(path)
            .map_err(|e| format!("Failed to read keypair: {}", e))?;
        libp2p::identity::Keypair::from_protobuf_encoding(&bytes)
            .map_err(|e| format!("Failed to decode keypair: {}", e))
    } else {
        let keypair = libp2p::identity::Keypair::generate_ed25519();
        let bytes = keypair.to_protobuf_encoding()
            .map_err(|e| format!("Failed to encode keypair: {}", e))?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create keypair directory: {}", e))?;
        }
        std::fs::write(path, &bytes)
            .map_err(|e| format!("Failed to write keypair: {}", e))?;
        Ok(keypair)
    }
}
