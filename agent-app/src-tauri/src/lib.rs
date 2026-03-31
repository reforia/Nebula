use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tauri::{
    AppHandle, Emitter, Manager,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::Mutex;

mod ws_client;
#[cfg(test)]
mod tests;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentConfig {
    pub server: String,
    pub agent_id: String,
    pub token: String,
    #[serde(default)]
    pub proxy: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentState {
    pub status: String,
    pub server: String,
    pub agent_id: String,
    pub agent_name: String,
    pub error: String,
    pub device: String,
    pub last_activity: String,
}

impl Default for AgentState {
    fn default() -> Self {
        Self {
            status: "disconnected".into(),
            server: String::new(),
            agent_id: String::new(),
            agent_name: String::new(),
            error: String::new(),
            device: format!(
                "{}/{}",
                std::env::consts::OS,
                std::env::consts::ARCH
            ),
            last_activity: String::new(),
        }
    }
}

pub struct AppState {
    pub config: AgentConfig,
    pub state: AgentState,
    pub cancel_token: Option<tokio_util::sync::CancellationToken>,
}

fn config_path() -> PathBuf {
    let dir = dirs::config_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap().join(".config"))
        .join("nebula-agent");
    fs::create_dir_all(&dir).ok();
    dir.join("config.json")
}

fn load_config() -> AgentConfig {
    let path = config_path();
    if path.exists() {
        let data = fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        AgentConfig::default()
    }
}

fn save_config(config: &AgentConfig) {
    let path = config_path();
    let data = serde_json::to_string_pretty(config).unwrap();
    fs::write(path, data).ok();
}

#[tauri::command]
async fn get_state(
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<AgentState, String> {
    let s = state.lock().await;
    Ok(s.state.clone())
}

#[tauri::command]
async fn register(
    server: String,
    agent_id: String,
    token: String,
    proxy: Option<String>,
    app: AppHandle,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<(), String> {
    let config = AgentConfig {
        server: server.clone(),
        agent_id: agent_id.clone(),
        token,
        proxy: proxy.unwrap_or_default(),
    };
    save_config(&config);

    {
        let mut s = state.lock().await;
        s.config = config.clone();
        s.state.server = server;
        s.state.agent_id = agent_id;
    }

    // Auto-connect after registration
    connect_agent_inner(app, state.inner().clone()).await;
    Ok(())
}

#[tauri::command]
async fn connect_agent(
    app: AppHandle,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<(), String> {
    connect_agent_inner(app, state.inner().clone()).await;
    Ok(())
}

async fn connect_agent_inner(app: AppHandle, state: Arc<Mutex<AppState>>) {
    // Cancel any existing connection
    {
        let mut s = state.lock().await;
        if let Some(token) = s.cancel_token.take() {
            token.cancel();
        }
        s.state.status = "connecting".into();
        s.state.error.clear();
        app.emit("agent-state", &s.state).ok();
    }

    let cancel_token = tokio_util::sync::CancellationToken::new();
    {
        let mut s = state.lock().await;
        s.cancel_token = Some(cancel_token.clone());
    }

    let app_clone = app.clone();
    let state_clone = state.clone();

    tokio::spawn(async move {
        ws_client::run(app_clone, state_clone, cancel_token).await;
    });
}

#[tauri::command]
async fn disconnect_agent(
    app: AppHandle,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<(), String> {
    let mut s = state.lock().await;
    if let Some(token) = s.cancel_token.take() {
        token.cancel();
    }
    s.state.status = "disconnected".into();
    app.emit("agent-state", &s.state).ok();
    Ok(())
}

#[tauri::command]
async fn unregister(
    app: AppHandle,
    state: tauri::State<'_, Arc<Mutex<AppState>>>,
) -> Result<(), String> {
    let mut s = state.lock().await;
    if let Some(token) = s.cancel_token.take() {
        token.cancel();
    }
    s.config = AgentConfig::default();
    s.state = AgentState::default();
    let path = config_path();
    fs::remove_file(path).ok();
    app.emit("agent-state", &s.state).ok();
    Ok(())
}

#[tauri::command]
fn detect_runtimes() -> Vec<(String, String)> {
    detect_available_runtimes()
}

/// Spawn CC and return JSON result
pub async fn spawn_cc(
    prompt: &str,
    system_prompt: &str,
    session_id: &str,
    session_initialized: bool,
    allowed_tools: &str,
    model: &str,
    max_turns: u32,
    timeout_ms: u64,
    skills: &[serde_json::Value],
    mcp_servers: &[serde_json::Value],
    app: &AppHandle,
) -> Result<serde_json::Value, String> {
    let work_dir = dirs::home_dir()
        .unwrap_or_default()
        .join(".nebula-agents")
        .join(session_id);
    fs::create_dir_all(&work_dir).ok();

    // Write skill files from server (org-wide + agent-specific + built-in)
    for skill in skills {
        if let (Some(name), Some(content)) = (skill["name"].as_str(), skill["content"].as_str()) {
            let skill_dir = work_dir.join(".claude").join("skills").join(name);
            fs::create_dir_all(&skill_dir).ok();
            fs::write(skill_dir.join("SKILL.md"), content).ok();
        }
    }

    // Write MCP config from server
    let mcp_config_path = work_dir.join(".nebula-mcp-config.json");
    if !mcp_servers.is_empty() {
        let mut mcp_config = serde_json::json!({"mcpServers": {}});
        for server in mcp_servers {
            let name = server["name"].as_str().unwrap_or("unknown");
            let transport = server["transport"].as_str().unwrap_or("stdio");
            if transport == "stdio" {
                mcp_config["mcpServers"][name] = serde_json::json!({
                    "command": server["config"]["command"],
                    "args": server["config"]["args"],
                    "env": server["config"]["env"],
                });
            } else {
                let mut entry = serde_json::json!({"url": server["config"]["url"]});
                if server["config"]["headers"].is_object() {
                    entry["headers"] = server["config"]["headers"].clone();
                }
                mcp_config["mcpServers"][name] = entry;
            }
        }
        fs::write(&mcp_config_path, serde_json::to_string_pretty(&mcp_config).unwrap_or_default()).ok();
    }

    let mut args = vec![
        "-p".to_string(),
        prompt.to_string(),
        "--allowedTools".to_string(),
        allowed_tools.to_string(),
        "--model".to_string(),
        model.to_string(),
        "--max-turns".to_string(),
        max_turns.to_string(),
        "--output-format".to_string(),
        "json".to_string(),
        "--dangerously-skip-permissions".to_string(),
    ];

    // MCP config flag
    if mcp_config_path.exists() {
        args.push("--mcp-config".to_string());
        args.push(mcp_config_path.to_string_lossy().to_string());
    }

    if !system_prompt.is_empty() {
        args.push("--append-system-prompt".to_string());
        args.push(system_prompt.to_string());
    }

    if session_initialized {
        args.push("--resume".to_string());
        args.push(session_id.to_string());
    } else {
        args.push("--session-id".to_string());
        args.push(session_id.to_string());
    }

    // Clear stale session lock from previous runs
    let lock_path = dirs::home_dir()
        .unwrap_or_default()
        .join(".claude")
        .join("tasks")
        .join(session_id)
        .join(".lock");
    let _ = fs::remove_file(&lock_path);

    app.emit("agent-log", "Spawning CC...").ok();

    let home = dirs::home_dir().unwrap_or_default();

    // Find claude binary — GUI apps don't inherit shell PATH
    let claude_bin = find_claude_binary(&home)
        .ok_or_else(|| "Claude Code not found. Install it: npm install -g @anthropic-ai/claude-code".to_string())?;

    app.emit("agent-log", format!("CC: {}", claude_bin)).ok();

    // Build shell command for macOS (inherits keychain), direct exec on Windows
    let use_shell = !cfg!(windows);

    let shell_cmd = if use_shell {
        std::iter::once(format!("\"{}\"", claude_bin))
            .chain(args.iter().map(|a| {
                if a.contains(' ') || a.contains('"') || a.contains('\'') || a.contains('\n') {
                    format!("\"{}\"", a.replace('\\', "\\\\").replace('"', "\\\""))
                } else {
                    a.clone()
                }
            }))
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        String::new()
    };

    // Log full command + env for debugging
    let debug_log = home.join(".nebula-agent-cc.log");
    let proxy_vars = format!(
        "HTTP_PROXY={}\nHTTPS_PROXY={}\nhttp_proxy={}\nhttps_proxy={}",
        std::env::var("HTTP_PROXY").unwrap_or_default(),
        std::env::var("HTTPS_PROXY").unwrap_or_default(),
        std::env::var("http_proxy").unwrap_or_default(),
        std::env::var("https_proxy").unwrap_or_default(),
    );
    std::fs::write(&debug_log, format!(
        "CC: {}\nHOME: {}\nCWD: {}\n{}\nArgs: {:?}\nShell cmd len: {}\n---\n",
        claude_bin, home.display(), work_dir.display(), proxy_vars, &args, shell_cmd.len()
    )).ok();

    // Read proxy config from saved settings or defaults
    let proxy_url = load_proxy_url();

    let mut cmd = if use_shell {
        let mut c = Command::new("sh");
        c.arg("-c").arg(&shell_cmd);
        c
    } else {
        let mut c = Command::new(&claude_bin);
        c.args(&args);
        c
    };
    cmd.current_dir(&work_dir)
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // GUI apps don't inherit shell env vars — set proxy explicitly if configured
    if !proxy_url.is_empty() {
        cmd.env("HTTP_PROXY", &proxy_url)
            .env("HTTPS_PROXY", &proxy_url)
            .env("http_proxy", &proxy_url)
            .env("https_proxy", &proxy_url);
    }

    let mut child = cmd.spawn()
        .map_err(|e| format!("Failed to spawn claude: {}", e))?;

    let timeout = tokio::time::Duration::from_millis(timeout_ms);

    let result = tokio::time::timeout(timeout, async {
        let mut stdout_handle = child.stdout.take().unwrap();
        let mut stderr_handle = child.stderr.take().unwrap();
        let mut output = String::new();
        let mut err_output = String::new();
        stdout_handle.read_to_string(&mut output).await.ok();
        stderr_handle.read_to_string(&mut err_output).await.ok();

        // Race process completion against cancellation
        let status = tokio::select! {
            s = child.wait() => s.map_err(|e| e.to_string())?,
            _ = async {
                // Wait for cancel token if we have one in app state
                let token = {
                    let s = app.state::<Arc<Mutex<AppState>>>();
                    let guard = s.lock().await;
                    guard.cancel_token.clone()
                };
                if let Some(t) = token { t.cancelled().await; } else { std::future::pending::<()>().await; }
            } => {
                child.kill().await.ok();
                return Err("Cancelled by user".to_string());
            }
        };

        // Dump raw output for debugging
        {
            use std::io::Write;
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(
                dirs::home_dir().unwrap_or_default().join(".nebula-agent-cc.log")
            ) {
                writeln!(f, "EXIT: {}\nSTDOUT[{}]: {}\nSTDERR[{}]: {}\n---",
                    status.code().unwrap_or(-1),
                    output.len(), &output[..output.len().min(1000)],
                    err_output.len(), &err_output[..err_output.len().min(500)],
                ).ok();
            }
        }

        if !status.success() {
            let code = status.code().unwrap_or(-1);
            if code == 2 {
                return Err("Claude Code auth expired — run 'claude login'".to_string());
            }
            // Try to extract error from JSON output
            if let Some(start) = output.find('{') {
                if let Some(end) = output.rfind('}') {
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&output[start..=end]) {
                        if let Some(err_msg) = json.get("result").and_then(|v| v.as_str()) {
                            return Err(format!("CC error: {}", err_msg));
                        }
                        if let Some(err_msg) = json.get("error").and_then(|v| v.as_str()) {
                            return Err(format!("CC error: {}", err_msg));
                        }
                    }
                }
            }
            let err_msg = format!("CC exit code {}: stdout={} stderr={}", code, &output[..output.len().min(500)], &err_output[..err_output.len().min(500)]);
            // Append to debug log
            use std::io::Write;
            if let Ok(mut f) = std::fs::OpenOptions::new().append(true).open(home.join(".nebula-agent-cc.log")) {
                writeln!(f, "ERROR: {}\n---", &err_msg).ok();
            }
            return Err(err_msg);
        }

        // Find JSON in output
        let json_start = output.find('{').ok_or("No JSON in output")?;
        let json_end = output.rfind('}').ok_or("No JSON end in output")?;
        let json_str = &output[json_start..=json_end];
        let result: serde_json::Value =
            serde_json::from_str(json_str).map_err(|e| format!("JSON parse: {}", e))?;

        // Log full result for debugging
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(home.join(".nebula-agent-cc.log")) {
            writeln!(f, "RESULT: is_error={} result={}\n---",
                result.get("is_error").unwrap_or(&serde_json::Value::Null),
                result.get("result").and_then(|v| v.as_str()).unwrap_or("(none)").chars().take(200).collect::<String>(),
            ).ok();
        }

        // Check if CC reported an error in the result
        if result.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false) {
            let err_msg = result.get("result").and_then(|v| v.as_str()).unwrap_or("Unknown CC error");
            return Err(format!("CC error: {}", err_msg));
        }

        Ok(result)
    })
    .await
    .map_err(|_| "CC execution timed out".to_string())??;

    app.emit("agent-log", "CC completed").ok();
    Ok(result)
}

fn load_proxy_url() -> String {
    load_config().proxy
}

/// Find a CLI binary by checking candidate paths then falling back to PATH.
fn find_cli_binary(bin_name: &str, candidates: &[PathBuf]) -> Option<String> {
    for p in candidates {
        if p.exists() {
            return Some(p.to_string_lossy().to_string());
        }
    }

    // Try PATH as fallback
    let which_cmd = if cfg!(windows) { "where" } else { "which" };
    if let Ok(output) = std::process::Command::new(which_cmd)
        .arg(bin_name)
        .output()
    {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Some(path);
            }
        }
    }

    None
}

fn find_claude_binary(home: &std::path::Path) -> Option<String> {
    let candidates = vec![
        home.join(".local/bin/claude"),
        home.join(".npm-global/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
        PathBuf::from("/opt/homebrew/bin/claude"),
        home.join("AppData/Roaming/npm/claude.cmd"),
        home.join("AppData/Roaming/npm/claude"),
        home.join(".local/bin/claude.exe"),
        PathBuf::from("C:/Program Files/nodejs/claude.cmd"),
    ];
    find_cli_binary("claude", &candidates)
}

fn find_opencode_binary(home: &std::path::Path) -> Option<String> {
    let candidates = vec![
        PathBuf::from("/usr/local/bin/opencode"),
        home.join(".npm-global/bin/opencode"),
        home.join(".bun/bin/opencode"),
        home.join("AppData/Roaming/npm/opencode.cmd"),
        home.join("AppData/Roaming/npm/opencode"),
    ];
    find_cli_binary("opencode", &candidates)
}

fn find_codex_binary(home: &std::path::Path) -> Option<String> {
    let candidates = vec![
        home.join(".local/bin/codex"),
        PathBuf::from("/usr/local/bin/codex"),
        PathBuf::from("/opt/homebrew/bin/codex"),
        home.join("AppData/Roaming/npm/codex.cmd"),
    ];
    find_cli_binary("codex", &candidates)
}

fn find_gemini_binary(home: &std::path::Path) -> Option<String> {
    let candidates = vec![
        home.join(".local/bin/gemini"),
        PathBuf::from("/usr/local/bin/gemini"),
        PathBuf::from("/opt/homebrew/bin/gemini"),
        home.join("AppData/Roaming/npm/gemini.cmd"),
    ];
    find_cli_binary("gemini", &candidates)
}

/// Detect all available CLI runtimes. Returns Vec of (id, path).
pub fn detect_available_runtimes() -> Vec<(String, String)> {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let mut runtimes = Vec::new();
    if let Some(p) = find_claude_binary(&home) {
        runtimes.push(("claude-cli".to_string(), p));
    }
    if let Some(p) = find_opencode_binary(&home) {
        runtimes.push(("opencode".to_string(), p));
    }
    if let Some(p) = find_codex_binary(&home) {
        runtimes.push(("codex".to_string(), p));
    }
    if let Some(p) = find_gemini_binary(&home) {
        runtimes.push(("gemini".to_string(), p));
    }
    runtimes
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let config = load_config();
    let initial_state = AgentState {
        server: config.server.clone(),
        agent_id: config.agent_id.clone(),
        ..Default::default()
    };

    let app_state = Arc::new(Mutex::new(AppState {
        config,
        state: initial_state,
        cancel_token: None,
    }));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(app_state.clone())
        .setup(move |app| {
            // Hide dock icon on macOS — menu bar only app
            #[cfg(target_os = "macos")]
            {
                use tauri::ActivationPolicy;
                app.set_activation_policy(ActivationPolicy::Accessory);
            }

            // System tray
            let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .icon_as_template(false)
                .menu(&menu)
                .tooltip("Nebula Agent")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            w.show().ok();
                            w.set_focus().ok();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .show_menu_on_left_click(cfg!(target_os = "windows"))
                .on_tray_icon_event(|tray, event| {
                    match event {
                        tauri::tray::TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, .. } => {
                            if !cfg!(target_os = "windows") {
                                let app = tray.app_handle();
                                if let Some(w) = app.get_webview_window("main") {
                                    w.show().ok();
                                    w.set_focus().ok();
                                }
                            }
                        }
                        tauri::tray::TrayIconEvent::DoubleClick { .. } => {
                            let app = tray.app_handle();
                            if let Some(w) = app.get_webview_window("main") {
                                w.show().ok();
                                w.set_focus().ok();
                            }
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // Intercept window close — hide instead of quit
            let main_window = app.get_webview_window("main").unwrap();
            let win_clone = main_window.clone();
            main_window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    win_clone.hide().ok();
                }
            });

            // Auto-connect if registered
            let state = app_state.clone();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let has_config = {
                    let s = state.lock().await;
                    !s.config.server.is_empty() && !s.config.agent_id.is_empty()
                };
                if has_config {
                    connect_agent_inner(handle, state).await;
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            register,
            connect_agent,
            disconnect_agent,
            unregister,
            detect_runtimes,
        ])
        .run(tauri::generate_context!())
        .expect("error running tauri application");
}
