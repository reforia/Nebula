use std::fs;
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use std::process::Stdio;
use tokio::sync::Mutex;

use crate::{AppState, find_claude_binary, find_opencode_binary, find_codex_binary, find_gemini_binary, load_proxy_url};

pub struct SpawnParams {
    pub runtime: String,
    pub prompt: String,
    pub system_prompt: String,
    pub session_id: String,
    pub session_initialized: bool,
    pub allowed_tools: String,
    pub model: String,
    pub max_turns: u32,
    pub timeout_ms: u64,
    pub skills: Vec<serde_json::Value>,
    pub mcp_servers: Vec<serde_json::Value>,
}

/// Dispatch execution to the appropriate runtime.
pub async fn spawn_runtime(
    params: &SpawnParams,
    app: &AppHandle,
) -> Result<serde_json::Value, String> {
    match params.runtime.as_str() {
        "claude-cli" => spawn_claude_cli(params, app).await,
        "opencode" => spawn_opencode(params, app).await,
        "codex" => spawn_codex(params, app).await,
        "gemini" => spawn_gemini(params, app).await,
        _ => Err(format!("Unknown runtime: {}", params.runtime)),
    }
}

// ---- Claude Code CLI ----

async fn spawn_claude_cli(
    params: &SpawnParams,
    app: &AppHandle,
) -> Result<serde_json::Value, String> {
    let home = dirs::home_dir().unwrap_or_default();
    let work_dir = home.join(".nebula-agents").join(&params.session_id);
    fs::create_dir_all(&work_dir).ok();

    // Write skill files to .claude/skills/
    write_skill_files(&work_dir, &params.skills);

    // Write MCP config
    write_mcp_config(&work_dir, &params.mcp_servers, "claude");

    let mut args = vec![
        "-p".to_string(),
        params.prompt.clone(),
        "--allowedTools".to_string(),
        params.allowed_tools.clone(),
        "--model".to_string(),
        params.model.clone(),
        "--max-turns".to_string(),
        params.max_turns.to_string(),
        "--output-format".to_string(),
        "json".to_string(),
        "--dangerously-skip-permissions".to_string(),
    ];

    let mcp_config_path = work_dir.join(".nebula-mcp-config.json");
    if mcp_config_path.exists() {
        args.push("--mcp-config".to_string());
        args.push(mcp_config_path.to_string_lossy().to_string());
    }

    if !params.system_prompt.is_empty() {
        args.push("--append-system-prompt".to_string());
        args.push(params.system_prompt.clone());
    }

    if params.session_initialized {
        args.push("--resume".to_string());
        args.push(params.session_id.clone());
    } else {
        args.push("--session-id".to_string());
        args.push(params.session_id.clone());
    }

    // Clear stale session lock
    let lock_path = home.join(".claude").join("tasks").join(&params.session_id).join(".lock");
    let _ = fs::remove_file(&lock_path);

    let binary = find_claude_binary(&home)
        .ok_or_else(|| "Claude Code not found. Install: npm install -g @anthropic-ai/claude-code".to_string())?;

    app.emit("agent-log", format!("CC: {}", binary)).ok();

    let output = collect_output(&binary, &args, &work_dir, params.timeout_ms, app).await?;

    // Parse Claude CLI output
    if !output.success {
        if output.exit_code == 2 {
            return Err("Claude Code auth expired — run 'claude login'".to_string());
        }
        // Try to extract error from JSON in output
        if let Some(start) = output.stdout.find('{') {
            if let Some(end) = output.stdout.rfind('}') {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&output.stdout[start..=end]) {
                    if let Some(msg) = json.get("result").and_then(|v| v.as_str()) {
                        return Err(format!("CC error: {}", msg));
                    }
                    if let Some(msg) = json.get("error").and_then(|v| v.as_str()) {
                        return Err(format!("CC error: {}", msg));
                    }
                }
            }
        }
        return Err(format!("CC exit code {}: stdout={} stderr={}",
            output.exit_code,
            &output.stdout[..output.stdout.len().min(500)],
            &output.stderr[..output.stderr.len().min(500)],
        ));
    }

    // Find JSON object in output
    let json_start = output.stdout.find('{').ok_or("No JSON in CC output")?;
    let json_end = output.stdout.rfind('}').ok_or("No JSON end in CC output")?;
    let result: serde_json::Value = serde_json::from_str(&output.stdout[json_start..=json_end])
        .map_err(|e| format!("JSON parse: {}", e))?;

    if result.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false) {
        let msg = result.get("result").and_then(|v| v.as_str()).unwrap_or("Unknown CC error");
        return Err(format!("CC error: {}", msg));
    }

    Ok(result)
}

// ---- OpenCode ----

async fn spawn_opencode(
    params: &SpawnParams,
    app: &AppHandle,
) -> Result<serde_json::Value, String> {
    let home = dirs::home_dir().unwrap_or_default();
    let work_dir = home.join(".nebula-agents").join(&params.session_id);
    fs::create_dir_all(&work_dir).ok();
    let start_time = std::time::Instant::now();

    // Write system prompt + skills to .opencode/rules.md
    let combined_prompt = inline_skills(&params.system_prompt, &params.skills);
    let rules_dir = work_dir.join(".opencode");
    fs::create_dir_all(&rules_dir).ok();
    fs::write(rules_dir.join("rules.md"), &combined_prompt).ok();

    // Write MCP config as opencode.json
    write_mcp_config(&work_dir, &params.mcp_servers, "opencode");

    // Map model ID to provider/model format
    let oc_model = map_model_for_opencode(&params.model);

    let mut args = vec![
        "run".to_string(),
        "--format".to_string(),
        "json".to_string(),
        "--model".to_string(),
        oc_model,
    ];

    // Server tracks the CLI-generated session ID after first run.
    // First run: session_id is a Nebula UUID → --title (new session)
    // Subsequent runs: session_id is the CLI-generated ID → --session (resume)
    if params.session_initialized {
        args.push("--session".to_string());
        args.push(params.session_id.clone());
    } else {
        args.push("--title".to_string());
        args.push(params.session_id.clone());
    }

    args.push(params.prompt.clone());

    let binary = find_opencode_binary(&home)
        .ok_or_else(|| "OpenCode not found. Install it first.".to_string())?;

    app.emit("agent-log", format!("OpenCode: {}", binary)).ok();

    let output = collect_output(&binary, &args, &work_dir, params.timeout_ms, app).await?;

    if !output.success && output.exit_code != 0 {
        return Err(format!("OpenCode exit code {}: {}", output.exit_code, &output.stdout[output.stdout.len().saturating_sub(500)..]));
    }

    // Parse NDJSON output
    let events = parse_ndjson(&output.stdout);
    let mut result_text = String::new();
    let mut input_tokens: u64 = 0;
    let mut output_tokens: u64 = 0;
    let mut cost: f64 = 0.0;
    let mut cli_session_id: Option<String> = None;

    for event in &events {
        // Capture CLI-generated session ID from any event
        if cli_session_id.is_none() {
            if let Some(sid) = event.get("sessionID").or(event.get("session_id")).and_then(|v| v.as_str()) {
                cli_session_id = Some(sid.to_string());
            }
        }
        let etype = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match etype {
            "text" => {
                // OpenCode format: {"type":"text", "part":{"text":"..."}}
                if let Some(t) = event.get("part").and_then(|p| p.get("text")).and_then(|v| v.as_str()) {
                    result_text = t.to_string();
                }
                // Also check top-level content (older format)
                if let Some(c) = event.get("content").and_then(|v| v.as_str()) {
                    if result_text.is_empty() { result_text = c.to_string(); }
                }
            }
            "message" if event.get("role").and_then(|v| v.as_str()) == Some("assistant") => {
                if let Some(s) = event.get("content").and_then(|v| v.as_str()) {
                    result_text = s.to_string();
                } else if let Some(arr) = event.get("content").and_then(|v| v.as_array()) {
                    for b in arr {
                        if b.get("type").and_then(|v| v.as_str()) == Some("text") {
                            if let Some(t) = b.get("text").and_then(|v| v.as_str()) {
                                result_text = t.to_string();
                            }
                        }
                    }
                }
            }
            "step_finish" => {
                // OpenCode format: {"type":"step_finish", "part":{"tokens":{...}, "cost":0.003}}
                if let Some(part) = event.get("part") {
                    if let Some(tokens) = part.get("tokens") {
                        input_tokens += tokens.get("input").and_then(|v| v.as_u64()).unwrap_or(0);
                        output_tokens += tokens.get("output").and_then(|v| v.as_u64()).unwrap_or(0);
                    }
                    if let Some(c) = part.get("cost").and_then(|v| v.as_f64()) {
                        cost = c;
                    }
                }
            }
            _ => {}
        }
        // Also check top-level usage/cost (generic format)
        if let Some(usage) = event.get("usage") {
            input_tokens += usage.get("input_tokens").or(usage.get("prompt_tokens"))
                .and_then(|v| v.as_u64()).unwrap_or(0);
            output_tokens += usage.get("output_tokens").or(usage.get("completion_tokens"))
                .and_then(|v| v.as_u64()).unwrap_or(0);
        }
        if let Some(c) = event.get("cost").and_then(|v| v.as_f64()) {
            cost = c;
        }
    }

    if result_text.is_empty() {
        result_text = output.stdout.trim().to_string();
    }

    let mut result = serde_json::json!({
        "result": result_text,
        "duration_ms": start_time.elapsed().as_millis() as u64,
        "total_cost_usd": cost,
        "usage": { "input_tokens": input_tokens, "output_tokens": output_tokens },
    });
    if let Some(sid) = cli_session_id {
        result["cli_session_id"] = serde_json::Value::String(sid);
    }
    Ok(result)
}

// ---- Codex CLI ----

async fn spawn_codex(
    params: &SpawnParams,
    app: &AppHandle,
) -> Result<serde_json::Value, String> {
    let home = dirs::home_dir().unwrap_or_default();
    let work_dir = home.join(".nebula-agents").join(&params.session_id);
    fs::create_dir_all(&work_dir).ok();
    let start_time = std::time::Instant::now();

    let combined_prompt = inline_skills(&params.system_prompt, &params.skills);

    let mut args = vec![
        "exec".to_string(),
        "--json".to_string(),
        "--model".to_string(),
        params.model.clone(),
        "--dangerously-bypass-approvals-and-sandbox".to_string(),
    ];

    if !combined_prompt.is_empty() {
        args.push("--append-system-prompt".to_string());
        args.push(combined_prompt);
    }

    if params.session_initialized {
        args.push("resume".to_string());
        args.push(params.session_id.clone());
    } else {
        args.push("--ephemeral".to_string());
    }

    args.push(params.prompt.clone());

    let binary = find_codex_binary(&home)
        .ok_or_else(|| "Codex CLI not found. Install it first.".to_string())?;

    app.emit("agent-log", format!("Codex: {}", binary)).ok();

    let output = collect_output(&binary, &args, &work_dir, params.timeout_ms, app).await?;

    if !output.success && output.exit_code != 0 {
        return Err(format!("Codex exit code {}: {}", output.exit_code, &output.stdout[output.stdout.len().saturating_sub(500)..]));
    }

    // Parse NDJSON output
    let events = parse_ndjson(&output.stdout);
    let mut result_text = String::new();
    let mut cli_session_id: Option<String> = None;

    for event in &events {
        // Capture CLI-generated session ID
        if cli_session_id.is_none() {
            if let Some(sid) = event.get("thread_id").or(event.get("session_id")).and_then(|v| v.as_str()) {
                cli_session_id = Some(sid.to_string());
            }
        }
        let etype = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if etype.starts_with("item.") {
            if let Some(content) = event.get("item").and_then(|v| v.get("content")).and_then(|v| v.as_array()) {
                for b in content {
                    let btype = b.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    if btype == "text" || btype == "output_text" {
                        if let Some(t) = b.get("text").or(b.get("content")).and_then(|v| v.as_str()) {
                            result_text = t.to_string();
                        }
                    }
                }
            }
        }
    }

    if result_text.is_empty() {
        result_text = output.stdout.trim().to_string();
    }

    let mut result = serde_json::json!({
        "result": result_text,
        "duration_ms": start_time.elapsed().as_millis() as u64,
        "total_cost_usd": 0,
        "usage": {},
    });
    if let Some(sid) = cli_session_id {
        result["cli_session_id"] = serde_json::Value::String(sid);
    }
    Ok(result)
}

// ---- Gemini CLI ----

async fn spawn_gemini(
    params: &SpawnParams,
    app: &AppHandle,
) -> Result<serde_json::Value, String> {
    let home = dirs::home_dir().unwrap_or_default();
    let work_dir = home.join(".nebula-agents").join(&params.session_id);
    fs::create_dir_all(&work_dir).ok();
    let start_time = std::time::Instant::now();

    // Write system prompt + skills to .gemini/system.md
    let combined_prompt = inline_skills(&params.system_prompt, &params.skills);
    let gemini_dir = work_dir.join(".gemini");
    fs::create_dir_all(&gemini_dir).ok();
    let system_file = gemini_dir.join("system.md");
    fs::write(&system_file, &combined_prompt).ok();

    let mut args = vec![
        "--output-format".to_string(),
        "stream-json".to_string(),
        "-m".to_string(),
        params.model.clone(),
        "-y".to_string(),
        "--system-instruction".to_string(),
        system_file.to_string_lossy().to_string(),
    ];

    if params.session_initialized {
        args.push("--resume".to_string());
        args.push(params.session_id.clone());
    }

    args.push("-p".to_string());
    args.push(params.prompt.clone());

    let binary = find_gemini_binary(&home)
        .ok_or_else(|| "Gemini CLI not found. Install it first.".to_string())?;

    app.emit("agent-log", format!("Gemini: {}", binary)).ok();

    let output = collect_output(&binary, &args, &work_dir, params.timeout_ms, app).await?;

    if !output.success && output.exit_code != 0 {
        let label = match output.exit_code {
            42 => "Input error".to_string(),
            53 => "Turn limit".to_string(),
            _ => format!("Exit {}", output.exit_code),
        };
        return Err(format!("Gemini {}: {}", label, &output.stdout[output.stdout.len().saturating_sub(500)..]));
    }

    // Parse NDJSON output
    let events = parse_ndjson(&output.stdout);
    let mut result_text = String::new();
    let mut input_tokens: u64 = 0;
    let mut output_tokens: u64 = 0;
    let mut cli_session_id: Option<String> = None;

    for event in &events {
        // Capture CLI-generated session ID
        if cli_session_id.is_none() {
            if let Some(sid) = event.get("session_id").and_then(|v| v.as_str()) {
                cli_session_id = Some(sid.to_string());
            }
        }
        let etype = event.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if etype == "result" {
            if let Some(r) = event.get("response").and_then(|v| v.as_str()) {
                result_text = r.to_string();
            }
        }
        if etype == "message" && event.get("role").and_then(|v| v.as_str()) == Some("assistant") {
            if let Some(s) = event.get("content").and_then(|v| v.as_str()) {
                result_text = s.to_string();
            } else if let Some(arr) = event.get("content").and_then(|v| v.as_array()) {
                for b in arr {
                    if b.get("type").and_then(|v| v.as_str()) == Some("text") {
                        if let Some(t) = b.get("text").and_then(|v| v.as_str()) {
                            result_text = t.to_string();
                        }
                    }
                }
            }
        }
        if let Some(u) = event.get("usage").or(event.get("stats")) {
            input_tokens += u.get("input_tokens").or(u.get("input")).and_then(|v| v.as_u64()).unwrap_or(0);
            output_tokens += u.get("output_tokens").or(u.get("output")).and_then(|v| v.as_u64()).unwrap_or(0);
        }
    }

    if result_text.is_empty() {
        result_text = output.stdout.trim().to_string();
    }

    let mut result = serde_json::json!({
        "result": result_text,
        "duration_ms": start_time.elapsed().as_millis() as u64,
        "total_cost_usd": 0,
        "usage": { "input_tokens": input_tokens, "output_tokens": output_tokens },
    });
    if let Some(sid) = cli_session_id {
        result["cli_session_id"] = serde_json::Value::String(sid);
    }
    Ok(result)
}

// ---- Shared helpers ----

struct CommandOutput {
    success: bool,
    exit_code: i32,
    stdout: String,
    stderr: String,
}

/// Run a binary with args, handling timeout and cancellation. Logs to ~/.nebula-agent-cc.log.
async fn collect_output(
    binary: &str,
    args: &[String],
    work_dir: &std::path::Path,
    timeout_ms: u64,
    app: &AppHandle,
) -> Result<CommandOutput, String> {
    let home = dirs::home_dir().unwrap_or_default();
    let proxy_url = load_proxy_url();

    // Debug log
    let debug_log = home.join(".nebula-agent-cc.log");
    std::fs::write(&debug_log, format!(
        "BIN: {}\nHOME: {}\nCWD: {}\nArgs: {:?}\n---\n",
        binary, home.display(), work_dir.display(), args
    )).ok();

    app.emit("agent-log", format!("Spawning {}...", binary)).ok();

    let mut cmd = Command::new(binary);
    cmd.args(args)
        .current_dir(work_dir)
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if !proxy_url.is_empty() {
        cmd.env("HTTP_PROXY", &proxy_url)
            .env("HTTPS_PROXY", &proxy_url)
            .env("http_proxy", &proxy_url)
            .env("https_proxy", &proxy_url);
    }

    let mut child = cmd.spawn()
        .map_err(|e| format!("Failed to spawn {}: {}", binary, e))?;

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

        // Append to debug log
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

        Ok(CommandOutput {
            success: status.success(),
            exit_code: status.code().unwrap_or(-1),
            stdout: output,
            stderr: err_output,
        })
    })
    .await
    .map_err(|_| format!("{} execution timed out", binary))??;

    app.emit("agent-log", format!("{} completed (exit {})", binary, result.exit_code)).ok();
    Ok(result)
}

/// Write skill files to .claude/skills/{name}/SKILL.md (Claude CLI only).
fn write_skill_files(work_dir: &Path, skills: &[serde_json::Value]) {
    for skill in skills {
        if let (Some(name), Some(content)) = (skill["name"].as_str(), skill["content"].as_str()) {
            let skill_dir = work_dir.join(".claude").join("skills").join(name);
            fs::create_dir_all(&skill_dir).ok();
            fs::write(skill_dir.join("SKILL.md"), content).ok();
        }
    }
}

/// Inline skills into system prompt (for runtimes that don't read .claude/skills/).
fn inline_skills(system_prompt: &str, skills: &[serde_json::Value]) -> String {
    let contents: Vec<&str> = skills.iter()
        .filter_map(|s| s["content"].as_str())
        .collect();
    if contents.is_empty() {
        return system_prompt.to_string();
    }
    format!("{}\n\n## Skills\n\n{}", system_prompt, contents.join("\n\n---\n\n"))
}

/// Write MCP config in the format expected by the given runtime.
fn write_mcp_config(work_dir: &Path, mcp_servers: &[serde_json::Value], format: &str) {
    if mcp_servers.is_empty() { return; }

    match format {
        "claude" => {
            let mut config = serde_json::json!({"mcpServers": {}});
            for server in mcp_servers {
                let name = server["name"].as_str().unwrap_or("unknown");
                let transport = server["transport"].as_str().unwrap_or("stdio");
                if transport == "stdio" {
                    config["mcpServers"][name] = serde_json::json!({
                        "type": "stdio",
                        "command": server["config"]["command"],
                        "args": server["config"]["args"],
                        "env": server["config"]["env"],
                    });
                } else {
                    let mut entry = serde_json::json!({"url": server["config"]["url"]});
                    if server["config"]["headers"].is_object() {
                        entry["headers"] = server["config"]["headers"].clone();
                    }
                    config["mcpServers"][name] = entry;
                }
            }
            fs::write(work_dir.join(".nebula-mcp-config.json"),
                serde_json::to_string_pretty(&config).unwrap_or_default()).ok();
        }
        "opencode" => {
            let mut config = serde_json::json!({
                "$schema": "https://opencode.ai/config.json",
                "mcp": {}
            });
            for server in mcp_servers {
                let name = server["name"].as_str().unwrap_or("unknown");
                let transport = server["transport"].as_str().unwrap_or("stdio");
                if transport == "stdio" {
                    let command_str = server["config"]["command"].as_str().unwrap_or("");
                    let mut cmd_arr = vec![serde_json::Value::String(command_str.to_string())];
                    if let Some(args) = server["config"]["args"].as_array() {
                        cmd_arr.extend(args.clone());
                    }
                    let mut entry = serde_json::json!({
                        "type": "local",
                        "command": cmd_arr,
                        "enabled": true,
                    });
                    if server["config"]["env"].is_object() {
                        let env = server["config"]["env"].as_object().unwrap();
                        if !env.is_empty() {
                            entry["environment"] = server["config"]["env"].clone();
                        }
                    }
                    config["mcp"][name] = entry;
                } else {
                    let mut entry = serde_json::json!({
                        "type": "remote",
                        "url": server["config"]["url"],
                        "enabled": true,
                    });
                    if server["config"]["headers"].is_object() {
                        let headers = server["config"]["headers"].as_object().unwrap();
                        if !headers.is_empty() {
                            entry["headers"] = server["config"]["headers"].clone();
                        }
                    }
                    config["mcp"][name] = entry;
                }
            }
            fs::write(work_dir.join("opencode.json"),
                serde_json::to_string_pretty(&config).unwrap_or_default()).ok();
        }
        _ => {}
    }
}

/// Parse NDJSON output into a vec of JSON events.
fn parse_ndjson(output: &str) -> Vec<serde_json::Value> {
    output.lines()
        .filter(|l| l.trim_start().starts_with('{'))
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

/// Map model ID to OpenCode's provider/model format.
/// Only maps bare model names (no slash) to common providers.
/// Models with slashes are passed through as-is — the user should specify
/// the full OpenCode model ID (e.g. `openrouter/deepseek/deepseek-v3.2`).
fn map_model_for_opencode(model: &str) -> String {
    if model.contains('/') { return model.to_string(); }
    if model.starts_with("claude-") {
        format!("anthropic/{}", model)
    } else if model.starts_with("gpt-") || model.starts_with("o3-") || model.starts_with("o4-") {
        format!("openai/{}", model)
    } else {
        model.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_inline_skills_empty() {
        assert_eq!(inline_skills("base prompt", &[]), "base prompt");
    }

    #[test]
    fn test_inline_skills_appends() {
        let skills = vec![
            serde_json::json!({"name": "s1", "content": "skill one"}),
            serde_json::json!({"name": "s2", "content": "skill two"}),
        ];
        let result = inline_skills("base", &skills);
        assert!(result.starts_with("base\n\n## Skills\n\n"));
        assert!(result.contains("skill one\n\n---\n\nskill two"));
    }

    #[test]
    fn test_parse_ndjson() {
        let input = "some text\n{\"type\":\"message\"}\nnot json\n{\"type\":\"result\"}";
        let events = parse_ndjson(input);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["type"], "message");
        assert_eq!(events[1]["type"], "result");
    }

    #[test]
    fn test_map_model_for_opencode() {
        // Bare model names get provider prefix
        assert_eq!(map_model_for_opencode("claude-sonnet-4-6"), "anthropic/claude-sonnet-4-6");
        assert_eq!(map_model_for_opencode("gpt-5.4"), "openai/gpt-5.4");
        assert_eq!(map_model_for_opencode("o3-mini"), "openai/o3-mini");
        assert_eq!(map_model_for_opencode("some-model"), "some-model");
        // Models with slashes pass through — user specifies full OpenCode model ID
        assert_eq!(map_model_for_opencode("openrouter/deepseek/deepseek-v3.2"), "openrouter/deepseek/deepseek-v3.2");
        assert_eq!(map_model_for_opencode("anthropic/claude-3.5"), "anthropic/claude-3.5");
        assert_eq!(map_model_for_opencode("deepseek/deepseek-v3.2"), "deepseek/deepseek-v3.2");
    }
}
