use crate::AppState;
use crate::runtime::{spawn_runtime, SpawnParams};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_tungstenite::{client_async, tungstenite::{Message, handshake::client::Request}};

pub async fn run(
    app: AppHandle,
    state: Arc<Mutex<AppState>>,
    cancel: tokio_util::sync::CancellationToken,
) {
    let (server, agent_id, token) = {
        let s = state.lock().await;
        (
            s.config.server.clone(),
            s.config.agent_id.clone(),
            s.config.token.clone(),
        )
    };

    if server.is_empty() || agent_id.is_empty() || token.is_empty() {
        update_status(&app, &state, "error", "Not registered").await;
        return;
    }

    let ws_url = server
        .trim_end_matches('/')
        .replace("https://", "wss://")
        .replace("http://", "ws://")
        + "/ws/remote";

    let mut reconnect_delay = 1u64; // seconds
    let max_delay = 30u64;

    loop {
        if cancel.is_cancelled() { return; }

        app.emit("agent-log", format!("Connecting to {}...", ws_url)).ok();
        update_status(&app, &state, "connecting", "").await;

        match connect_and_run(&app, &state, &ws_url, &agent_id, &token, &cancel).await {
            ConnectionResult::Cancelled => return,
            ConnectionResult::AuthFailed(err) => {
                update_status(&app, &state, "error", &err).await;
                return; // Don't retry auth failures
            }
            ConnectionResult::Disconnected(reason) => {
                app.emit("agent-log", format!("Disconnected: {}. Reconnecting in {}s...", reason, reconnect_delay)).ok();
                update_status(&app, &state, "reconnecting", &format!("Reconnecting in {}s...", reconnect_delay)).await;

                tokio::select! {
                    _ = cancel.cancelled() => return,
                    _ = tokio::time::sleep(tokio::time::Duration::from_secs(reconnect_delay)) => {}
                }

                reconnect_delay = (reconnect_delay * 2).min(max_delay);
            }
        }
    }
}

enum ConnectionResult {
    Cancelled,
    AuthFailed(String),
    Disconnected(String),
}

async fn connect_and_run(
    app: &AppHandle,
    state: &Arc<Mutex<AppState>>,
    ws_url: &str,
    agent_id: &str,
    token: &str,
    cancel: &tokio_util::sync::CancellationToken,
) -> ConnectionResult {
    let parsed = url::Url::parse(ws_url).unwrap();
    let host = parsed.host_str().unwrap_or("127.0.0.1");
    let port = parsed.port().unwrap_or(if parsed.scheme() == "wss" { 443 } else { 80 });
    let addr = format!("{}:{}", host, port);

    let tcp = match TcpStream::connect(&addr).await {
        Ok(s) => s,
        Err(e) => return ConnectionResult::Disconnected(format!("Cannot reach {} — {}", addr, e)),
    };

    let request = Request::builder()
        .uri(ws_url)
        .header("Host", format!("{}:{}", host, port))
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", tokio_tungstenite::tungstenite::handshake::client::generate_key())
        .body(())
        .unwrap();

    let (mut ws, _) = match client_async(request, tcp).await {
        Ok(r) => r,
        Err(e) => return ConnectionResult::Disconnected(format!("WS handshake failed: {}", e)),
    };

    // Collect device info
    let hostname = hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "unknown".into());

    let mut sys = sysinfo::System::new();
    sys.refresh_cpu_all();
    sys.refresh_memory();

    let cpu = sys.cpus().first().map(|c| c.brand().to_string()).unwrap_or_default();
    let cores = sys.cpus().len();
    let ram = format!("{}GB", sys.total_memory() / (1024 * 1024 * 1024));

    let available_runtimes = crate::detect_available_runtimes();
    let runtime_ids: Vec<&str> = available_runtimes.iter().map(|(id, _)| id.as_str()).collect();

    let auth = json!({
        "type": "auth",
        "agent_id": agent_id,
        "token": token,
        "device": {
            "hostname": hostname,
            "platform": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "cpu": cpu,
            "cores": cores,
            "ram": ram,
            "runtime": "tauri-native",
        },
        "available_runtimes": runtime_ids,
    });

    if ws.send(Message::Text(auth.to_string())).await.is_err() {
        return ConnectionResult::Disconnected("Failed to send auth".into());
    }

    // Wait for auth response
    match ws.next().await {
        Some(Ok(Message::Text(text))) => {
            let msg: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
            if msg["type"] == "auth_ok" {
                let name = msg["agent"]["name"].as_str().unwrap_or("unknown").to_string();
                let mut s = state.lock().await;
                s.state.status = "connected".into();
                s.state.agent_name = name;
                s.state.error.clear();
                app.emit("agent-state", &s.state).ok();
                app.emit("agent-log", "Authenticated. Waiting for tasks...").ok();
            } else if msg["type"] == "auth_failed" {
                let err = msg["error"].as_str().unwrap_or("Auth failed").to_string();
                return ConnectionResult::AuthFailed(err);
            }
        }
        _ => return ConnectionResult::Disconnected("No auth response".into()),
    }

    // Heartbeat timer
    let heartbeat_interval = tokio::time::interval(tokio::time::Duration::from_secs(30));
    tokio::pin!(heartbeat_interval);

    // Main loop
    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                app.emit("agent-log", "Disconnecting...").ok();
                ws.close(None).await.ok();
                update_status(app, state, "disconnected", "").await;
                return ConnectionResult::Cancelled;
            }
            _ = heartbeat_interval.tick() => {
                let hb = json!({"type": "heartbeat"});
                if ws.send(Message::Text(hb.to_string())).await.is_err() {
                    return ConnectionResult::Disconnected("Heartbeat send failed".into());
                }
            }
            msg = ws.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
                        match parsed["type"].as_str().unwrap_or("") {
                            "execute" => {
                                let request_id = parsed["request_id"].as_str().unwrap_or("").to_string();
                                let runtime = parsed["runtime"].as_str().unwrap_or("claude-cli").to_string();

                                // Validate runtime is available on this machine
                                if !available_runtimes.iter().any(|(id, _)| id == &runtime) {
                                    let err_msg = format!("Runtime \"{}\" is not installed on this machine", runtime);
                                    app.emit("agent-log", format!("Error: {}", &err_msg)).ok();
                                    let response = json!({"type": "error", "request_id": request_id, "error": err_msg});
                                    if ws.send(Message::Text(response.to_string())).await.is_err() {
                                        return ConnectionResult::Disconnected("Send error failed".into());
                                    }
                                    continue;
                                }

                                let params = SpawnParams {
                                    runtime: runtime.clone(),
                                    prompt: parsed["prompt"].as_str().unwrap_or("").to_string(),
                                    system_prompt: parsed["system_prompt"].as_str().unwrap_or("").to_string(),
                                    session_id: parsed["session_id"].as_str().unwrap_or("").to_string(),
                                    session_initialized: parsed["session_initialized"].as_bool().unwrap_or(false)
                                        || parsed["session_initialized"].as_i64().unwrap_or(0) != 0,
                                    allowed_tools: parsed["allowed_tools"].as_str().unwrap_or("Read,Grep,Glob,WebFetch,Bash").to_string(),
                                    model: parsed["model"].as_str().unwrap_or("claude-sonnet-4-6").to_string(),
                                    max_turns: parsed["max_turns"].as_u64().unwrap_or(10) as u32,
                                    timeout_ms: parsed["timeout_ms"].as_u64().unwrap_or(600000),
                                    skills: parsed["skills"].as_array()
                                        .map(|a| a.to_vec()).unwrap_or_default(),
                                    mcp_servers: parsed["mcp_servers"].as_array()
                                        .map(|a| a.to_vec()).unwrap_or_default(),
                                };

                                app.emit("agent-log", format!("Executing {} [{}]...", &request_id[..8.min(request_id.len())], runtime)).ok();

                                {
                                    let mut s = state.lock().await;
                                    s.state.last_activity = chrono_now();
                                    app.emit("agent-state", &s.state).ok();
                                }

                                // Set up per-execution cancel token
                                let exec_token = tokio_util::sync::CancellationToken::new();
                                {
                                    let mut s = state.lock().await;
                                    s.cancel_token = Some(exec_token.clone());
                                }

                                let result = spawn_runtime(&params, app).await;

                                // Clear cancel token
                                {
                                    let mut s = state.lock().await;
                                    s.cancel_token = None;
                                }

                                let response = match result {
                                    Ok(val) => json!({"type": "result", "request_id": request_id, "result": val}),
                                    Err(err) => json!({"type": "error", "request_id": request_id, "error": err}),
                                };

                                if ws.send(Message::Text(response.to_string())).await.is_err() {
                                    return ConnectionResult::Disconnected("Send result failed".into());
                                }

                                {
                                    let mut s = state.lock().await;
                                    s.state.last_activity = chrono_now();
                                    app.emit("agent-state", &s.state).ok();
                                }
                            }
                            "cancel" => {
                                let token = {
                                    let s = state.lock().await;
                                    s.cancel_token.clone()
                                };
                                if let Some(t) = token {
                                    app.emit("agent-log", "Cancelling execution...").ok();
                                    t.cancel();
                                }
                            }
                            "heartbeat_ack" => {}
                            _ => {}
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        return ConnectionResult::Disconnected("Connection closed".into());
                    }
                    Some(Err(e)) => {
                        return ConnectionResult::Disconnected(format!("WS error: {}", e));
                    }
                    _ => {}
                }
            }
        }
    }
}

async fn update_status(app: &AppHandle, state: &Arc<Mutex<AppState>>, status: &str, error: &str) {
    let mut s = state.lock().await;
    s.state.status = status.into();
    s.state.error = error.into();
    app.emit("agent-state", &s.state).ok();
    app.emit("agent-log", format!("Status: {} {}", status, error)).ok();
}

fn chrono_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    format!("{}", now)
}
