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
    pub transcode_port: u16,
}

enum PendingTransfer {
    Stream {
        tx: tokio::sync::oneshot::Sender<Result<StreamSession, String>>,
        transcode_port: u16,
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
    let listen_addr: Multiaddr = "/ip4/0.0.0.0/udp/0/quic-v1"
        .parse()
        .map_err(|e| format!("Failed to parse listen addr: {}", e))?;
    swarm.listen_on(listen_addr)
        .map_err(|e| format!("Failed to listen: {}", e))?;
    log::info!("P2P: Listening started");

    let event_loop_status = Arc::clone(&status);
    let event_loop_db = Arc::clone(&config.db);
    let event_loop_shared_ids = Arc::clone(&shared_collection_ids);
    let event_loop_peer_id = peer_id;
    let event_loop_transcode_port = config.transcode_port;
    let event_loop_app_dir = config.app_dir.clone();

    tokio::spawn(async move {
        run_event_loop(
            swarm,
            cmd_rx,
            event_loop_status,
            event_loop_db,
            event_loop_shared_ids,
            event_loop_peer_id,
            event_loop_transcode_port,
            event_loop_app_dir,
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

async fn run_event_loop(
    mut swarm: libp2p::Swarm<swarm::ViboplrBehaviour>,
    mut cmd_rx: mpsc::Receiver<P2pCommand>,
    status: Arc<RwLock<P2pStatus>>,
    db: Arc<Database>,
    shared_collection_ids: Arc<RwLock<Vec<i64>>>,
    local_peer_id: PeerId,
    transcode_port: u16,
    app_dir: PathBuf,
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
                                            protocols::TransferRequest { track_id, mode: protocols::TransferMode::Stream },
                                        );
                                        pending_transfers.insert(request_id, PendingTransfer::Stream {
                                            tx: response_tx,
                                            transcode_port,
                                            app_dir: app_dir.clone(),
                                        });
                                    }
                                    PendingDial::Download { track_id, dest_collection_id, dest_collection_path, response_tx } => {
                                        let request_id = swarm.behaviour_mut().transfer.send_request(
                                            &peer_id,
                                            protocols::TransferRequest { track_id, mode: protocols::TransferMode::Download },
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
                                        let _ = swarm.behaviour_mut().transfer.send_response(channel, response);
                                    }
                                    request_response::Message::Response { request_id, response } => {
                                        if let Some(pending) = pending_transfers.remove(&request_id) {
                                            handle_transfer_response(pending, response).await;
                                        }
                                    }
                                }
                            }
                            ViboplrBehaviourEvent::Transfer(
                                request_response::Event::OutboundFailure { request_id, error, .. }
                            ) => {
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
                            }
                            ViboplrBehaviourEvent::Identify(identify::Event::Received { peer_id, info, .. }) => {
                                log::debug!("Identified peer {}: {:?}", peer_id, info.protocols);
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
                        if swarm.is_connected(&peer_id) {
                            let request_id = swarm.behaviour_mut().transfer.send_request(
                                &peer_id,
                                protocols::TransferRequest { track_id, mode: protocols::TransferMode::Stream },
                            );
                            pending_transfers.insert(request_id, PendingTransfer::Stream {
                                tx: response_tx, transcode_port, app_dir: app_dir.clone(),
                            });
                        } else {
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
                                protocols::TransferRequest { track_id, mode: protocols::TransferMode::Download },
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
                    Some(P2pCommand::Stop) | None => {
                        log::info!("P2P event loop stopping");
                        let mut s = status.write().await;
                        *s = P2pStatus::Stopped;
                        break;
                    }
                    _ => {}
                }
            }
        }
    }
}

async fn handle_transfer_response(
    pending: PendingTransfer,
    response: protocols::TransferResponse,
) {
    if let Some(error) = &response.error {
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

    match pending {
        PendingTransfer::Stream { tx, transcode_port, app_dir } => {
            let header = match response.header {
                Some(h) => h,
                None => {
                    let _ = tx.send(Err("No transfer header".to_string()));
                    return;
                }
            };

            // Write data to temp file
            let ext = &header.format;
            let session_id = format!("p2p-{}", std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis());
            let temp_path = app_dir.join(format!(".p2p-stream-{}.{}", session_id, ext));

            if let Err(e) = std::fs::write(&temp_path, &response.data) {
                let _ = tx.send(Err(format!("Failed to write temp file: {}", e)));
                return;
            }

            // Return a URL that the frontend can use to play the file directly
            let url = format!(
                "http://127.0.0.1:{}/stream/{}",
                transcode_port, session_id
            );

            let _ = tx.send(Ok(StreamSession { url, session_id }));
        }
        PendingTransfer::Download { tx, dest_collection_id, dest_collection_path, db } => {
            let header = match response.header {
                Some(h) => h,
                None => {
                    let _ = tx.send(Err("No transfer header".to_string()));
                    return;
                }
            };

            // Build destination path
            let ext = &header.format;
            let artist = header.artist_name.as_deref().unwrap_or("Unknown Artist");
            let title = &header.title;
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
            if let Err(e) = std::fs::write(&dest_path, &response.data) {
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

            let _ = tx.send(Ok(()));
        }
    }
}

