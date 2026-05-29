// Auto-split from commands.rs. See commands/mod.rs for shared types & helpers.
use super::*;

// --- P2P Commands ---

#[tauri::command]
pub async fn p2p_start(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    relay_multiaddr: Option<String>,
) -> Result<crate::p2p::P2pStatus, String> {
    use crate::p2p;

    let mut node_guard = state.p2p_node.write().await;
    if node_guard.is_some() {
        return Err("P2P node already running".to_string());
    }

    let relay = relay_multiaddr
        .map(|s| s.parse::<libp2p::Multiaddr>())
        .transpose()
        .map_err(|e| format!("Invalid relay multiaddr: {}", e))?;

    let config = p2p::P2pConfig {
        app_dir: state.app_dir.clone(),
        db: Arc::clone(&state.db),
        relay_multiaddr: relay,
        app_handle,
    };

    let node = p2p::start_node(config).await?;
    let status = node.get_status().await;
    *node_guard = Some(node);
    Ok(status)
}

#[tauri::command]
pub async fn p2p_stop(state: State<'_, AppState>) -> Result<(), String> {
    let mut node_guard = state.p2p_node.write().await;
    if let Some(node) = node_guard.take() {
        let _ = node.cmd_tx.send(crate::p2p::P2pCommand::Stop).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn p2p_get_status(state: State<'_, AppState>) -> Result<crate::p2p::P2pStatus, String> {
    let node_guard = state.p2p_node.read().await;
    match node_guard.as_ref() {
        Some(node) => Ok(node.get_status().await),
        None => Ok(crate::p2p::P2pStatus::Stopped),
    }
}

#[tauri::command]
pub async fn p2p_get_multiaddrs(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let node_guard = state.p2p_node.read().await;
    let node = node_guard.as_ref().ok_or("P2P not running")?;

    let (tx, rx) = tokio::sync::oneshot::channel();
    node.cmd_tx
        .send(crate::p2p::P2pCommand::GetMultiaddrs { response_tx: tx })
        .await
        .map_err(|_| "Failed to send command".to_string())?;
    rx.await.map_err(|_| "Failed to get response".to_string())
}

#[tauri::command]
pub async fn p2p_search_peer(
    state: State<'_, AppState>,
    peer_id: String,
    multiaddr: String,
    query: String,
    limit: Option<u32>,
) -> Result<crate::p2p::protocols::SearchResponse, String> {
    let node_guard = state.p2p_node.read().await;
    let node = node_guard.as_ref().ok_or("P2P not running")?;

    let peer: libp2p::PeerId = peer_id.parse().map_err(|e| format!("Invalid peer_id: {}", e))?;
    let addr: libp2p::Multiaddr = multiaddr.parse().map_err(|e| format!("Invalid multiaddr: {}", e))?;

    let (tx, rx) = tokio::sync::oneshot::channel();
    node.cmd_tx
        .send(crate::p2p::P2pCommand::SearchPeer {
            peer_id: peer,
            multiaddr: addr,
            query,
            limit: limit.unwrap_or(20),
            response_tx: tx,
        })
        .await
        .map_err(|_| "Failed to send command".to_string())?;

    rx.await.map_err(|_| "Search timed out".to_string())?
}

#[tauri::command]
pub async fn p2p_stream_from_peer(
    state: State<'_, AppState>,
    peer_id: String,
    multiaddr: String,
    track_id: String,
) -> Result<String, String> {
    let node_guard = state.p2p_node.read().await;
    let node = node_guard.as_ref().ok_or("P2P not running")?;

    let peer: libp2p::PeerId = peer_id.parse().map_err(|e| format!("Invalid peer_id: {}", e))?;
    let addr: libp2p::Multiaddr = multiaddr.parse().map_err(|e| format!("Invalid multiaddr: {}", e))?;

    let (tx, rx) = tokio::sync::oneshot::channel();
    node.cmd_tx
        .send(crate::p2p::P2pCommand::StreamFromPeer {
            peer_id: peer,
            multiaddr: addr,
            track_id,
            response_tx: tx,
        })
        .await
        .map_err(|_| "Failed to send command".to_string())?;

    let session = rx.await.map_err(|_| "Stream request timed out".to_string())??;
    Ok(session.url)
}

#[tauri::command]
pub async fn p2p_download_from_peer(
    state: State<'_, AppState>,
    peer_id: String,
    multiaddr: String,
    track_id: String,
    dest_collection_id: i64,
) -> Result<(), String> {
    let node_guard = state.p2p_node.read().await;
    let node = node_guard.as_ref().ok_or("P2P not running")?;

    let peer: libp2p::PeerId = peer_id.parse().map_err(|e| format!("Invalid peer_id: {}", e))?;
    let addr: libp2p::Multiaddr = multiaddr.parse().map_err(|e| format!("Invalid multiaddr: {}", e))?;

    // Look up destination collection path
    let collection = state.db.get_collections()
        .map_err(|e| format!("DB error: {}", e))?
        .into_iter()
        .find(|c| c.id == dest_collection_id)
        .ok_or("Destination collection not found")?;
    let dest_path = collection.path.ok_or("Collection has no path")?;

    let (tx, rx) = tokio::sync::oneshot::channel();
    node.cmd_tx
        .send(crate::p2p::P2pCommand::DownloadFromPeer {
            peer_id: peer,
            multiaddr: addr,
            track_id,
            dest_collection_id,
            dest_collection_path: dest_path,
            response_tx: tx,
        })
        .await
        .map_err(|_| "Failed to send command".to_string())?;

    rx.await.map_err(|_| "Download request timed out".to_string())?
}

#[tauri::command]
pub async fn p2p_get_shared_collections(
    state: State<'_, AppState>,
) -> Result<Vec<i64>, String> {
    let node_guard = state.p2p_node.read().await;
    match node_guard.as_ref() {
        Some(node) => Ok(node.shared_collection_ids.read().await.clone()),
        None => Ok(vec![]),
    }
}

#[tauri::command]
pub async fn p2p_set_shared_collections(
    state: State<'_, AppState>,
    collection_ids: Vec<i64>,
) -> Result<(), String> {
    let node_guard = state.p2p_node.read().await;
    let node = node_guard.as_ref().ok_or("P2P not running")?;
    let mut ids = node.shared_collection_ids.write().await;
    *ids = collection_ids;
    Ok(())
}

#[tauri::command]
pub async fn p2p_reserve_relay(
    state: State<'_, AppState>,
    multiaddr: String,
) -> Result<(), String> {
    let node_guard = state.p2p_node.read().await;
    let node = node_guard.as_ref().ok_or("P2P not running")?;

    let addr: libp2p::Multiaddr = multiaddr.parse().map_err(|e| format!("Invalid multiaddr: {}", e))?;

    let (tx, rx) = tokio::sync::oneshot::channel();
    node.cmd_tx
        .send(crate::p2p::P2pCommand::ReserveRelay {
            multiaddr: addr,
            response_tx: tx,
        })
        .await
        .map_err(|_| "Failed to send command".to_string())?;

    rx.await.map_err(|_| "Relay reservation timed out".to_string())?
}

#[tauri::command]
pub async fn p2p_get_diagnostics(
    state: State<'_, AppState>,
) -> Result<crate::p2p::P2pDiagnostics, String> {
    let node_guard = state.p2p_node.read().await;
    let node = node_guard.as_ref().ok_or("P2P not running")?;

    let (tx, rx) = tokio::sync::oneshot::channel();
    node.cmd_tx
        .send(crate::p2p::P2pCommand::GetDiagnostics {
            response_tx: tx,
        })
        .await
        .map_err(|_| "Failed to send command".to_string())?;

    rx.await.map_err(|_| "Failed to get diagnostics".to_string())
}
