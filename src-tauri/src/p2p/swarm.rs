use libp2p::{
    autonat, dcutr, identify, noise, ping,
    request_response::{self, json, ProtocolSupport},
    swarm::NetworkBehaviour,
    tcp, yamux, PeerId, StreamProtocol, Swarm, SwarmBuilder,
};
use std::time::Duration;

use super::protocols::{SearchRequest, SearchResponse, TransferRequest, TransferResponseHeader};

pub mod binary_transfer_codec {
    use async_trait::async_trait;
    use futures::prelude::*;
    use libp2p::request_response;
    use libp2p::StreamProtocol;
    use std::io;

    use super::super::protocols::{TransferRequest, TransferResponseHeader};

    const REQUEST_SIZE_MAXIMUM: u64 = 1024 * 1024; // 1MB
    const HEADER_SIZE_MAXIMUM: u64 = 64 * 1024; // 64KB

    pub type TransferResponse = (TransferResponseHeader, Vec<u8>);

    #[derive(Debug, Clone, Default)]
    pub struct Codec;

    #[async_trait]
    impl request_response::Codec for Codec {
        type Protocol = StreamProtocol;
        type Request = TransferRequest;
        type Response = TransferResponse;

        async fn read_request<T>(&mut self, _: &Self::Protocol, io: &mut T) -> io::Result<TransferRequest>
        where
            T: AsyncRead + Unpin + Send,
        {
            let mut len_buf = [0u8; 4];
            io.read_exact(&mut len_buf).await?;
            let len = u32::from_be_bytes(len_buf) as u64;
            if len > REQUEST_SIZE_MAXIMUM {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "request too large"));
            }
            let mut buf = vec![0u8; len as usize];
            io.read_exact(&mut buf).await?;
            serde_json::from_slice(&buf).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
        }

        async fn read_response<T>(&mut self, _: &Self::Protocol, io: &mut T) -> io::Result<TransferResponse>
        where
            T: AsyncRead + Unpin + Send,
        {
            // Read header length
            let mut len_buf = [0u8; 4];
            io.read_exact(&mut len_buf).await?;
            let header_len = u32::from_be_bytes(len_buf) as u64;
            if header_len > HEADER_SIZE_MAXIMUM {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "header too large"));
            }

            // Read header JSON
            let mut header_buf = vec![0u8; header_len as usize];
            io.read_exact(&mut header_buf).await?;
            let header: TransferResponseHeader = serde_json::from_slice(&header_buf)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

            // If error, no file data follows
            if header.error.is_some() {
                return Ok((header, vec![]));
            }

            // Read raw file data
            let file_size = header.file_size.unwrap_or(0) as usize;
            let mut data = vec![0u8; file_size];
            io.read_exact(&mut data).await?;

            Ok((header, data))
        }

        async fn write_request<T>(&mut self, _: &Self::Protocol, io: &mut T, req: TransferRequest) -> io::Result<()>
        where
            T: AsyncWrite + Unpin + Send,
        {
            let json = serde_json::to_vec(&req)?;
            let len = (json.len() as u32).to_be_bytes();
            io.write_all(&len).await?;
            io.write_all(&json).await?;
            Ok(())
        }

        async fn write_response<T>(&mut self, _: &Self::Protocol, io: &mut T, resp: TransferResponse) -> io::Result<()>
        where
            T: AsyncWrite + Unpin + Send,
        {
            let (header, data) = resp;
            let header_json = serde_json::to_vec(&header)?;
            let header_len = (header_json.len() as u32).to_be_bytes();
            io.write_all(&header_len).await?;
            io.write_all(&header_json).await?;

            // Write raw file data (only if no error)
            if header.error.is_none() && !data.is_empty() {
                io.write_all(&data).await?;
            }
            Ok(())
        }
    }
}

pub const SEARCH_PROTOCOL: &str = "/viboplr/search/1.0.0";
pub const TRANSFER_PROTOCOL: &str = "/viboplr/transfer/2.0.0";

#[derive(NetworkBehaviour)]
pub struct ViboplrBehaviour {
    pub identify: identify::Behaviour,
    pub ping: ping::Behaviour,
    pub autonat: autonat::Behaviour,
    pub relay_client: libp2p::relay::client::Behaviour,
    pub dcutr: dcutr::Behaviour,
    pub search: json::Behaviour<SearchRequest, SearchResponse>,
    pub transfer: request_response::Behaviour<binary_transfer_codec::Codec>,
}

pub fn build_swarm(
    keypair: libp2p::identity::Keypair,
) -> Result<Swarm<ViboplrBehaviour>, Box<dyn std::error::Error>> {
    let local_peer_id = PeerId::from(keypair.public());

    let swarm = SwarmBuilder::with_existing_identity(keypair)
        .with_tokio()
        .with_tcp(
            tcp::Config::default().nodelay(true),
            noise::Config::new,
            yamux::Config::default,
        )?
        .with_quic()
        .with_dns()?
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

            let ping = ping::Behaviour::new(
                ping::Config::new().with_interval(Duration::from_secs(15)),
            );

            let search = json::Behaviour::<SearchRequest, SearchResponse>::new(
                [(StreamProtocol::new(SEARCH_PROTOCOL), ProtocolSupport::Full)],
                request_response::Config::default()
                    .with_request_timeout(Duration::from_secs(10)),
            );

            let transfer = request_response::Behaviour::new(
                [(StreamProtocol::new(TRANSFER_PROTOCOL), ProtocolSupport::Full)],
                request_response::Config::default()
                    .with_request_timeout(Duration::from_secs(300)),
            );

            ViboplrBehaviour {
                identify,
                ping,
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
