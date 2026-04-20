use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{
    AppHandle, Emitter, Manager,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};
use tokio::sync::Mutex;

mod runtime;
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
    pub exec_cancel_token: Option<tokio_util::sync::CancellationToken>,
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

pub(crate) fn load_proxy_url() -> String {
    load_config().proxy
}

/// Find a CLI binary by checking candidate paths then falling back to PATH.
pub(crate) fn find_cli_binary(bin_name: &str, candidates: &[PathBuf]) -> Option<String> {
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

pub(crate) fn find_claude_binary(home: &std::path::Path) -> Option<String> {
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

pub(crate) fn find_opencode_binary(home: &std::path::Path) -> Option<String> {
    let candidates = vec![
        home.join(".opencode/bin/opencode"),
        PathBuf::from("/usr/local/bin/opencode"),
        PathBuf::from("/opt/homebrew/bin/opencode"),
        home.join(".npm-global/bin/opencode"),
        home.join(".bun/bin/opencode"),
        home.join("AppData/Roaming/npm/opencode.cmd"),
        home.join("AppData/Roaming/npm/opencode"),
    ];
    find_cli_binary("opencode", &candidates)
}

pub(crate) fn find_codex_binary(home: &std::path::Path) -> Option<String> {
    let candidates = vec![
        home.join(".local/bin/codex"),
        PathBuf::from("/usr/local/bin/codex"),
        PathBuf::from("/opt/homebrew/bin/codex"),
        home.join("AppData/Roaming/npm/codex.cmd"),
    ];
    find_cli_binary("codex", &candidates)
}

pub(crate) fn find_gemini_binary(home: &std::path::Path) -> Option<String> {
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
        exec_cancel_token: None,
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
