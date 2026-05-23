pub mod protocols;
pub mod swarm;
pub mod handler;
pub mod discovery;

use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use libp2p::{Multiaddr, PeerId};
use futures::StreamExt;

use crate::db::Database;
use self::handler::RequestHandler;
use self::swarm::ViboplrBehaviourEvent;
use libp2p::{autonat, identify};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "status")]
pub enum P2pStatus {
    #[serde(rename = "stopped")]
    Stopped,
    #[serde(rename = "starting")]
    Starting,
    #[serde(rename = "online")]
    Online {
        peer_id: String,
        multiaddrs: Vec<String>,
        can_relay: bool,
    },
    #[serde(rename = "degraded")]
    Degraded { reason: String },
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SharedCollectionInfo {
    pub id: i64,
    pub name: String,
    pub track_count: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct P2pDiagnostics {
    pub peer_id: String,
    pub listen_addrs: Vec<String>,
    pub nat_status: String,
    pub can_relay: bool,
    pub connected_peers: usize,
    pub protocol_version: String,
    pub search_protocol: String,
    pub transfer_protocol: String,
    pub shared_collections: Vec<SharedCollectionInfo>,
    pub uptime_secs: u64,
    pub transfers_completed: u64,
    pub bytes_sent: u64,
    pub bytes_received: u64,
    pub pending_dials: usize,
    pub pending_searches: usize,
    pub pending_transfers: usize,
}

pub enum P2pCommand {
    SearchPeer {
        peer_id: PeerId,
        multiaddr: Multiaddr,
        query: String,
        limit: u32,
        response_tx: tokio::sync::oneshot::Sender<Result<protocols::SearchResponse, String>>,
    },
    StreamFromPeer {
        peer_id: PeerId,
        multiaddr: Multiaddr,
        track_id: String,
        response_tx: tokio::sync::oneshot::Sender<Result<StreamSession, String>>,
    },
    DownloadFromPeer {
        peer_id: PeerId,
        multiaddr: Multiaddr,
        track_id: String,
        dest_collection_id: i64,
        dest_collection_path: String,
        response_tx: tokio::sync::oneshot::Sender<Result<(), String>>,
    },
    ReserveRelay {
        multiaddr: Multiaddr,
        response_tx: tokio::sync::oneshot::Sender<Result<(), String>>,
    },
    GetMultiaddrs {
        response_tx: tokio::sync::oneshot::Sender<Vec<String>>,
    },
    GetDiagnostics {
        response_tx: tokio::sync::oneshot::Sender<P2pDiagnostics>,
    },
    Stop,
}

#[derive(Debug, Clone)]
pub struct StreamSession {
    pub url: String,
    pub session_id: String,
}

pub struct P2pNode {
    pub cmd_tx: mpsc::Sender<P2pCommand>,
    pub status: Arc<RwLock<P2pStatus>>,
    pub peer_id: PeerId,
    pub keypair_path: PathBuf,
    pub shared_collection_ids: Arc<RwLock<Vec<i64>>>,
}

impl P2pNode {
    pub async fn get_status(&self) -> P2pStatus {
        self.status.read().await.clone()
    }
}

pub struct P2pConfig {
    pub app_dir: PathBuf,
    pub db: Arc<Database>,
    pub relay_multiaddr: Option<Multiaddr>,
    pub app_handle: tauri::AppHandle,
}

enum PendingTransfer {
    Stream {
        tx: tokio::sync::oneshot::Sender<Result<StreamSession, String>>,
        app_dir: PathBuf,
    },
    Download {
        tx: tokio::sync::oneshot::Sender<Result<(), String>>,
        dest_collection_id: i64,
        dest_collection_path: String,
        db: Arc<Database>,
    },
}

pub async fn start_node(config: P2pConfig) -> Result<P2pNode, String> {
    let keypair_path = config.app_dir.join("p2p_keypair");
    log::info!("P2P: Loading keypair from {:?}", keypair_path);
    let keypair = swarm::load_or_generate_keypair(&keypair_path)?;
    let peer_id = PeerId::from(keypair.public());
    log::info!("P2P: Local peer ID: {}", peer_id);

    let status = Arc::new(RwLock::new(P2pStatus::Starting));
    let shared_collection_ids = Arc::new(RwLock::new(Vec::<i64>::new()));

    let (cmd_tx, cmd_rx) = mpsc::channel::<P2pCommand>(64);

    log::info!("P2P: Building swarm...");
    let mut swarm = swarm::build_swarm(keypair)
        .map_err(|e| format!("Failed to build swarm: {}", e))?;
    log::info!("P2P: Swarm built successfully");

    // Listen on a random QUIC port
    let quic_listen: Multiaddr = "/ip4/0.0.0.0/udp/0/quic-v1"
        .parse()
        .map_err(|e| format!("Failed to parse QUIC listen addr: {}", e))?;
    swarm.listen_on(quic_listen)
        .map_err(|e| format!("Failed to listen on QUIC: {}", e))?;
    // Also listen on a random TCP port so we can dial TCP relays and accept
    // direct TCP connections from peers on UDP-blocked networks.
    let tcp_listen: Multiaddr = "/ip4/0.0.0.0/tcp/0"
        .parse()
        .map_err(|e| format!("Failed to parse TCP listen addr: {}", e))?;
    if let Err(e) = swarm.listen_on(tcp_listen) {
        log::warn!("P2P: Failed to listen on TCP: {}", e);
    }
    log::info!("P2P: Listening started");

    // If a relay was configured, dial it. We register the /p2p-circuit listener
    // *after* the connection is established and identify confirms the relay
    // supports /libp2p/circuit/relay/0.2.0/hop — registering it before the
    // connection is up means libp2p never issues a RESERVE.
    let pending_relay_circuit: Option<(PeerId, Multiaddr)> = if let Some(relay_addr) = config.relay_multiaddr.clone() {
        match relay_peer_id_from_multiaddr(&relay_addr) {
            Some(rpid) => {
                log::info!("P2P: Dialing relay {}", relay_addr);
                if let Err(e) = swarm.dial(relay_addr.clone()) {
                    log::warn!("P2P: Failed to dial relay: {}", e);
                }
                let circuit_addr = relay_addr.with(libp2p::multiaddr::Protocol::P2pCircuit);
                Some((rpid, circuit_addr))
            }
            None => {
                log::warn!("P2P: relay multiaddr missing /p2p/<peer-id>; skipping circuit listener");
                None
            }
        }
    } else {
        log::info!("P2P: No relay configured; running without circuit listener");
        None
    };

    let event_loop_status = Arc::clone(&status);
    let event_loop_db = Arc::clone(&config.db);
    let event_loop_shared_ids = Arc::clone(&shared_collection_ids);
    let event_loop_peer_id = peer_id;
    let event_loop_app_dir = config.app_dir.clone();
    let event_loop_app_handle = config.app_handle.clone();

    tokio::spawn(async move {
        run_event_loop(
            swarm,
            cmd_rx,
            event_loop_status,
            event_loop_db,
            event_loop_shared_ids,
            event_loop_peer_id,
            event_loop_app_dir,
            event_loop_app_handle,
            pending_relay_circuit,
        ).await;
    });

    Ok(P2pNode {
        cmd_tx,
        status,
        peer_id,
        keypair_path,
        shared_collection_ids,
    })
}

fn relay_peer_id_from_multiaddr(addr: &Multiaddr) -> Option<PeerId> {
    addr.iter().find_map(|p| match p {
        libp2p::multiaddr::Protocol::P2p(pid) => Some(pid),
        _ => None,
    })
}

async fn run_event_loop(
    mut swarm: libp2p::Swarm<swarm::ViboplrBehaviour>,
    mut cmd_rx: mpsc::Receiver<P2pCommand>,
    status: Arc<RwLock<P2pStatus>>,
    db: Arc<Database>,
    shared_collection_ids: Arc<RwLock<Vec<i64>>>,
    local_peer_id: PeerId,
    app_dir: PathBuf,
    app_handle: tauri::AppHandle,
    mut pending_relay_circuit: Option<(PeerId, Multiaddr)>,
) {
    use libp2p::swarm::SwarmEvent;
    use libp2p::request_response;
    use std::collections::HashMap;

    let handler = RequestHandler::new(
        Arc::clone(&db),
        Arc::clone(&shared_collection_ids),
        local_peer_id.to_string(),
    );

    // Pending requests waiting for connection to be established
    enum PendingDial {
        Search { query: String, limit: u32, response_tx: tokio::sync::oneshot::Sender<Result<protocols::SearchResponse, String>> },
        Stream { track_id: String, response_tx: tokio::sync::oneshot::Sender<Result<StreamSession, String>> },
        Download { track_id: String, dest_collection_id: i64, dest_collection_path: String, response_tx: tokio::sync::oneshot::Sender<Result<(), String>> },
    }

    // Track pending outgoing search requests
    let mut pending_searches: HashMap<
        request_response::OutboundRequestId,
        tokio::sync::oneshot::Sender<Result<protocols::SearchResponse, String>>,
    > = HashMap::new();

    let mut pending_transfers: HashMap<
        request_response::OutboundRequestId,
        PendingTransfer,
    > = HashMap::new();

    // Requests waiting for a connection to be established
    let mut pending_dials: HashMap<PeerId, Vec<PendingDial>> = HashMap::new();

    let mut listening_addrs: Vec<Multiaddr> = Vec::new();

    // Diagnostics counters (session-scoped)
    let start_time = std::time::Instant::now();
    let mut connected_peers: std::collections::HashSet<PeerId> = std::collections::HashSet::new();
    let mut transfers_completed: u64 = 0;
    let mut bytes_sent: u64 = 0;
    let mut bytes_received: u64 = 0;
    let mut nat_status = "unknown".to_string();

    loop {
        tokio::select! {
            event = swarm.select_next_some() => {
                match event {
                    SwarmEvent::NewListenAddr { address, .. } => {
                        let full_addr = format!("{}/p2p/{}", address, local_peer_id);
                        log::info!("P2P listening on: {}", full_addr);
                        listening_addrs.push(address.clone());
                        let mut s = status.write().await;
                        *s = P2pStatus::Online {
                            peer_id: local_peer_id.to_string(),
                            multiaddrs: listening_addrs.iter()
                                .map(|a| format!("{}/p2p/{}", a, local_peer_id))
                                .collect(),
                            can_relay: false,
                        };
                    }
                    SwarmEvent::ConnectionEstablished { peer_id, .. } => {
                        log::info!("P2P connected to: {}", peer_id);
                        connected_peers.insert(peer_id);
                        // If this is the relay we configured, register the
                        // /p2p-circuit listener now so libp2p issues a RESERVE
                        // over the just-established connection.
                        if let Some((relay_peer, _)) = pending_relay_circuit.as_ref() {
                            if relay_peer == &peer_id {
                                let (_, circuit_addr) = pending_relay_circuit.take().unwrap();
                                log::info!("P2P: Listening on circuit {}", circuit_addr);
                                if let Err(e) = swarm.listen_on(circuit_addr) {
                                    log::warn!("P2P: Failed to listen on circuit: {}", e);
                                }
                            }
                        }
                        // Flush any pending requests for this peer
                        if let Some(pending) = pending_dials.remove(&peer_id) {
                            for dial in pending {
                                match dial {
                                    PendingDial::Search { query, limit, response_tx } => {
                                        let request_id = swarm.behaviour_mut().search.send_request(
                                            &peer_id,
                                            protocols::SearchRequest { query, limit },
                                        );
                                        pending_searches.insert(request_id, response_tx);
                                    }
                                    PendingDial::Stream { track_id, response_tx } => {
                                        let request_id = swarm.behaviour_mut().transfer.send_request(
                                            &peer_id,
                                            protocols::TransferRequest { track_id, mode: protocols::TransferMode::Stream, offset: None },
                                        );
                                        pending_transfers.insert(request_id, PendingTransfer::Stream {
                                            tx: response_tx,
                                            app_dir: app_dir.clone(),
                                        });
                                    }
                                    PendingDial::Download { track_id, dest_collection_id, dest_collection_path, response_tx } => {
                                        let request_id = swarm.behaviour_mut().transfer.send_request(
                                            &peer_id,
                                            protocols::TransferRequest { track_id, mode: protocols::TransferMode::Download, offset: None },
                                        );
                                        pending_transfers.insert(request_id, PendingTransfer::Download {
                                            tx: response_tx,
                                            dest_collection_id,
                                            dest_collection_path,
                                            db: Arc::clone(&db),
                                        });
                                    }
                                }
                            }
                        }
                    }
                    SwarmEvent::ConnectionClosed { peer_id, .. } => {
                        log::info!("P2P disconnected from: {}", peer_id);
                        if !swarm.is_connected(&peer_id) {
                            connected_peers.remove(&peer_id);
                        }
                    }
                    SwarmEvent::OutgoingConnectionError { peer_id, error, .. } => {
                        if let Some(pid) = peer_id {
                            log::warn!("P2P dial failed to {}: {}", pid, error);
                            // Fail any pending requests for this peer
                            if let Some(pending) = pending_dials.remove(&pid) {
                                let err_msg = format!("Failed to dial peer: {}", error);
                                for dial in pending {
                                    match dial {
                                        PendingDial::Search { response_tx, .. } => {
                                            let _ = response_tx.send(Err(err_msg.clone()));
                                        }
                                        PendingDial::Stream { response_tx, .. } => {
                                            let _ = response_tx.send(Err(err_msg.clone()));
                                        }
                                        PendingDial::Download { response_tx, .. } => {
                                            let _ = response_tx.send(Err(err_msg.clone()));
                                        }
                                    }
                                }
                            }
                        }
                    }
                    SwarmEvent::Behaviour(event) => {
                        match event {
                            ViboplrBehaviourEvent::Search(
                                request_response::Event::Message { peer, message }
                            ) => {
                                match message {
                                    request_response::Message::Request { request, channel, .. } => {
                                        let response = handler.handle_search(request, &peer.to_string()).await;
                                        let _ = swarm.behaviour_mut().search.send_response(channel, response);
                                    }
                                    request_response::Message::Response { request_id, response } => {
                                        if let Some(tx) = pending_searches.remove(&request_id) {
                                            let _ = tx.send(Ok(response));
                                        }
                                    }
                                }
                            }
                            ViboplrBehaviourEvent::Search(
                                request_response::Event::OutboundFailure { request_id, error, .. }
                            ) => {
                                if let Some(tx) = pending_searches.remove(&request_id) {
                                    let _ = tx.send(Err(format!("Search failed: {}", error)));
                                }
                            }
                            ViboplrBehaviourEvent::Transfer(
                                request_response::Event::Message { message, .. }
                            ) => {
                                match message {
                                    request_response::Message::Request { request, channel, .. } => {
                                        let response = handler.handle_transfer(request).await;
                                        bytes_sent += response.1.len() as u64;
                                        let _ = swarm.behaviour_mut().transfer.send_response(channel, response);
                                    }
                                    request_response::Message::Response { request_id, response } => {
                                        if let Some(pending) = pending_transfers.remove(&request_id) {
                                            bytes_received += response.1.len() as u64;
                                            transfers_completed += 1;
                                            handle_transfer_response(pending, response, &app_handle).await;
                                        }
                                    }
                                }
                            }
                            ViboplrBehaviourEvent::Transfer(
                                request_response::Event::OutboundFailure { request_id, error, .. }
                            ) => {
                                log::error!("P2P transfer outbound failure: {}", error);
                                if let Some(pending) = pending_transfers.remove(&request_id) {
                                    match pending {
                                        PendingTransfer::Stream { tx, .. } => {
                                            let _ = tx.send(Err(format!("Transfer failed: {}", error)));
                                        }
                                        PendingTransfer::Download { tx, .. } => {
                                            let _ = tx.send(Err(format!("Transfer failed: {}", error)));
                                        }
                                    }
                                }
                            }
                            ViboplrBehaviourEvent::Autonat(autonat::Event::StatusChanged { old, new }) => {
                                log::info!("AutoNAT status changed: {:?} -> {:?}", old, new);
                                nat_status = match new {
                                    autonat::NatStatus::Public(_) => "public".to_string(),
                                    autonat::NatStatus::Private => "private".to_string(),
                                    autonat::NatStatus::Unknown => "unknown".to_string(),
                                };
                            }
                            ViboplrBehaviourEvent::Identify(identify::Event::Received { peer_id, info, .. }) => {
                                log::debug!("Identified peer {}: {:?}", peer_id, info.protocols);
                            }
                            ViboplrBehaviourEvent::RelayClient(
                                libp2p::relay::client::Event::ReservationReqAccepted { relay_peer_id, .. }
                            ) => {
                                log::info!("P2P: reservation accepted by relay {}", relay_peer_id);
                            }
                            _ => {}
                        }
                    }
                    _ => {}
                }
            }
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(P2pCommand::SearchPeer { peer_id, multiaddr, query, limit, response_tx }) => {
                        if swarm.is_connected(&peer_id) {
                            let request_id = swarm.behaviour_mut().search.send_request(
                                &peer_id,
                                protocols::SearchRequest { query, limit },
                            );
                            pending_searches.insert(request_id, response_tx);
                        } else {
                            let _ = swarm.dial(multiaddr);
                            pending_dials.entry(peer_id).or_default().push(
                                PendingDial::Search { query, limit, response_tx }
                            );
                        }
                    }
                    Some(P2pCommand::StreamFromPeer { peer_id, multiaddr, track_id, response_tx }) => {
                        log::info!("P2P StreamFromPeer: peer={}, track={}, connected={}", peer_id, track_id, swarm.is_connected(&peer_id));
                        if swarm.is_connected(&peer_id) {
                            let request_id = swarm.behaviour_mut().transfer.send_request(
                                &peer_id,
                                protocols::TransferRequest { track_id, mode: protocols::TransferMode::Stream, offset: None },
                            );
                            pending_transfers.insert(request_id, PendingTransfer::Stream {
                                tx: response_tx, app_dir: app_dir.clone(),
                            });
                        } else {
                            log::info!("P2P StreamFromPeer: dialing peer {}", peer_id);
                            let _ = swarm.dial(multiaddr);
                            pending_dials.entry(peer_id).or_default().push(
                                PendingDial::Stream { track_id, response_tx }
                            );
                        }
                    }
                    Some(P2pCommand::DownloadFromPeer { peer_id, multiaddr, track_id, dest_collection_id, dest_collection_path, response_tx }) => {
                        if swarm.is_connected(&peer_id) {
                            let request_id = swarm.behaviour_mut().transfer.send_request(
                                &peer_id,
                                protocols::TransferRequest { track_id, mode: protocols::TransferMode::Download, offset: None },
                            );
                            pending_transfers.insert(request_id, PendingTransfer::Download {
                                tx: response_tx, dest_collection_id, dest_collection_path, db: Arc::clone(&db),
                            });
                        } else {
                            let _ = swarm.dial(multiaddr);
                            pending_dials.entry(peer_id).or_default().push(
                                PendingDial::Download { track_id, dest_collection_id, dest_collection_path, response_tx }
                            );
                        }
                    }
                    Some(P2pCommand::ReserveRelay { multiaddr, response_tx }) => {
                        match swarm.listen_on(multiaddr.clone()) {
                            Ok(_) => { let _ = response_tx.send(Ok(())); }
                            Err(e) => { let _ = response_tx.send(Err(format!("Relay reservation failed: {}", e))); }
                        }
                    }
                    Some(P2pCommand::GetMultiaddrs { response_tx }) => {
                        let addrs: Vec<String> = listening_addrs.iter()
                            .map(|a| format!("{}/p2p/{}", a, local_peer_id))
                            .collect();
                        let _ = response_tx.send(addrs);
                    }
                    Some(P2pCommand::GetDiagnostics { response_tx }) => {
                        let shared_ids = shared_collection_ids.read().await;
                        let shared_info: Vec<SharedCollectionInfo> = shared_ids.iter().filter_map(|&id| {
                            let name = db.get_collection_by_id(id).ok().map(|c| c.name).unwrap_or_default();
                            let track_count = db.get_collection_stats().ok()
                                .and_then(|stats| stats.iter().find(|s| s.collection_id == id).map(|s| s.track_count))
                                .unwrap_or(0);
                            Some(SharedCollectionInfo { id, name, track_count })
                        }).collect();

                        let diag = P2pDiagnostics {
                            peer_id: local_peer_id.to_string(),
                            listen_addrs: listening_addrs.iter()
                                .map(|a| format!("{}/p2p/{}", a, local_peer_id))
                                .collect(),
                            nat_status: nat_status.clone(),
                            can_relay: nat_status == "public",
                            connected_peers: connected_peers.len(),
                            protocol_version: "/viboplr/0.1.0".to_string(),
                            search_protocol: swarm::SEARCH_PROTOCOL.to_string(),
                            transfer_protocol: swarm::TRANSFER_PROTOCOL.to_string(),
                            shared_collections: shared_info,
                            uptime_secs: start_time.elapsed().as_secs(),
                            transfers_completed,
                            bytes_sent,
                            bytes_received,
                            pending_dials: pending_dials.len(),
                            pending_searches: pending_searches.len(),
                            pending_transfers: pending_transfers.len(),
                        };
                        let _ = response_tx.send(diag);
                    }
                    Some(P2pCommand::Stop) | None => {
                        log::info!("P2P event loop stopping");
                        let mut s = status.write().await;
                        *s = P2pStatus::Stopped;
                        break;
                    }
                }
            }
        }
    }
}

async fn handle_transfer_response(
    pending: PendingTransfer,
    response: swarm::binary_transfer_codec::TransferResponse,
    app_handle: &tauri::AppHandle,
) {
    use tauri::Emitter;
    let (header, data) = response;

    if let Some(error) = &header.error {
        log::error!("P2P transfer error from peer: {}", error);
        match pending {
            PendingTransfer::Stream { tx, .. } => {
                let _ = tx.send(Err(error.clone()));
            }
            PendingTransfer::Download { tx, .. } => {
                let _ = tx.send(Err(error.clone()));
            }
        }
        return;
    }

    let title = header.title.clone().unwrap_or_default();
    let total = header.file_size.unwrap_or(data.len() as u64);
    log::info!("P2P transfer response received: data_len={}", data.len());

    // Emit progress: transfer complete, verifying
    let _ = app_handle.emit("p2p-transfer-progress", serde_json::json!({
        "title": title,
        "bytes_received": data.len(),
        "total_bytes": total,
        "stage": "received"
    }));

    // Verify checksum
    if let Some(expected) = &header.checksum {
        use sha2::{Sha256, Digest};
        let mut hasher = Sha256::new();
        hasher.update(&data);
        let actual = format!("{:x}", hasher.finalize());
        if &actual != expected {
            let err = format!("Checksum mismatch: expected {}, got {}", expected, actual);
            log::error!("P2P: {}", err);
            match pending {
                PendingTransfer::Stream { tx, .. } => { let _ = tx.send(Err(err)); }
                PendingTransfer::Download { tx, .. } => { let _ = tx.send(Err(err)); }
            }
            return;
        }
    }

    match pending {
        PendingTransfer::Stream { tx, app_dir, .. } => {
            let ext = header.format.as_deref().unwrap_or("bin");
            let session_id = format!("p2p-{}", std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis());
            let cache_dir = app_dir.join("plugin-cache").join("p2p-sharing").join("stream");
            let _ = std::fs::create_dir_all(&cache_dir);
            let temp_path = cache_dir.join(format!("{}.{}", session_id, ext));

            if let Err(e) = std::fs::write(&temp_path, &data) {
                let _ = tx.send(Err(format!("Failed to write temp file: {}", e)));
                return;
            }

            let url = format!("file://{}", temp_path.to_string_lossy());
            let _ = app_handle.emit("p2p-transfer-progress", serde_json::json!({
                "title": title,
                "bytes_received": data.len(),
                "total_bytes": total,
                "stage": "complete"
            }));
            let _ = tx.send(Ok(StreamSession { url, session_id }));
        }
        PendingTransfer::Download { tx, dest_collection_id, dest_collection_path, db } => {
            let ext = header.format.as_deref().unwrap_or("bin");
            let artist = header.artist_name.as_deref().unwrap_or("Unknown Artist");
            let title = header.title.as_deref().unwrap_or("Unknown");
            let filename = format!("{} - {}.{}", artist, title, ext);
            let dest_path = std::path::Path::new(&dest_collection_path).join(&filename);

            // Ensure parent directory exists
            if let Some(parent) = dest_path.parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    let _ = tx.send(Err(format!("Failed to create dir: {}", e)));
                    return;
                }
            }

            // Write file
            if let Err(e) = std::fs::write(&dest_path, &data) {
                let _ = tx.send(Err(format!("Failed to write file: {}", e)));
                return;
            }

            // Index into library
            crate::scanner::process_media_file(
                &db,
                &dest_path,
                Some(dest_collection_id),
                Some(&dest_collection_path),
            );

            let _ = app_handle.emit("p2p-transfer-progress", serde_json::json!({
                "title": title,
                "bytes_received": data.len(),
                "total_bytes": total,
                "stage": "complete"
            }));
            let _ = tx.send(Ok(()));
        }
    }
}

