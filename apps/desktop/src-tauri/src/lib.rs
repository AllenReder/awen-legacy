#[cfg(all(debug_assertions, feature = "browser-host-proof"))]
mod browser_host_proof;
#[cfg(target_os = "macos")]
mod macos;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::env;
use std::fs;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::{Runtime, Url};

const PRIMARY_LOCAL_ENVIRONMENT_ID: &str = "primary";
const DEFAULT_ENVIRONMENT_LABEL: &str = "Awen local daemon";
const LOCAL_DAEMON_PROTOCOL_VERSION: u8 = 1;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedServerRuntimeState {
    version: u8,
    pid: i64,
    origin: String,
    #[serde(default)]
    daemon_id: Option<String>,
    #[serde(default)]
    daemon_protocol_version: Option<u8>,
    #[serde(default)]
    daemon_managed: bool,
}

struct PersistedRuntime {
    state: PersistedServerRuntimeState,
    path: PathBuf,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopEnvironmentBootstrap {
    id: String,
    label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    http_base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ws_base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bootstrap_token: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRuntimeConfig {
    bootstraps: Vec<DesktopEnvironmentBootstrap>,
    #[serde(skip_serializing_if = "Option::is_none")]
    bearer_token: Option<String>,
    client_platform: String,
}

fn read_non_empty_env(names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        env::var(name)
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    })
}

fn push_unique(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.iter().any(|existing| existing == &path) {
        paths.push(path);
    }
}

fn runtime_state_candidates() -> Vec<PathBuf> {
    if let Some(path) = read_non_empty_env(&["AWEN_DESKTOP_RUNTIME_PATH"]) {
        return vec![PathBuf::from(path)];
    }

    let mut bases = Vec::new();
    if let Some(base) = read_non_empty_env(&["AWEN_HOME"]) {
        push_unique(&mut bases, PathBuf::from(base));
    }

    if let Ok(mut current) = env::current_dir() {
        // The wrapper normally provides AWEN_HOME. These ancestors keep the
        // shell usable when the Tauri CLI is invoked directly from this repo.
        for _ in 0..=3 {
            push_unique(&mut bases, current.join(".awen"));
            if !current.pop() {
                break;
            }
        }
    }

    if let Some(home) = read_non_empty_env(&["HOME", "USERPROFILE"]) {
        push_unique(&mut bases, PathBuf::from(home).join(".awen"));
    }

    bases
        .into_iter()
        .flat_map(|base| {
            [
                base.join("userdata/server-runtime.json"),
                base.join("dev/server-runtime.json"),
            ]
        })
        .collect()
}

fn is_process_alive(pid: i64) -> bool {
    if pid <= 0 {
        return false;
    }

    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
        result == 0
            || (result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM))
    }

    #[cfg(not(unix))]
    {
        // Advisory only: a Windows pid check cannot be trusted here (a reused
        // pid would look alive), so `endpoint_reachable` below is the authority
        // that keeps a dead descriptor from sending the shell to a dead port.
        let _ = pid;
        true
    }
}

/// Whether something is actually listening at the daemon's recorded origin.
///
/// A descriptor is not proof the daemon is up: the process may have exited
/// while its `server-runtime.json` survived, and a pid check alone is unreliable
/// on Windows. A short TCP connect is enough to reject a dead endpoint before
/// its origin is handed to the client; daemon ownership is still verified
/// separately by `require_managed_runtime`.
fn endpoint_reachable(origin: &str) -> bool {
    const ENDPOINT_PROBE_TIMEOUT: Duration = Duration::from_millis(300);

    let Ok(url) = Url::parse(origin) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    let Some(port) = url.port_or_known_default() else {
        return false;
    };
    let Ok(addresses) = (host, port).to_socket_addrs() else {
        return false;
    };
    addresses
        .into_iter()
        .any(|address| TcpStream::connect_timeout(&address, ENDPOINT_PROBE_TIMEOUT).is_ok())
}

fn read_runtime_state() -> Result<Option<PersistedRuntime>, String> {
    for path in runtime_state_candidates() {
        let contents = match fs::read_to_string(&path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!("Unable to read {}: {error}", path.display()));
            }
        };

        let state: PersistedServerRuntimeState = serde_json::from_str(&contents)
            .map_err(|error| format!("Unable to decode {}: {error}", path.display()))?;
        if state.version != 1 {
            return Err(format!(
                "Unsupported server runtime state version {} in {}.",
                state.version,
                path.display()
            ));
        }
        if is_process_alive(state.pid) && endpoint_reachable(&state.origin) {
            return Ok(Some(PersistedRuntime { state, path }));
        }
    }

    Ok(None)
}

fn local_daemon_base_dir() -> PathBuf {
    if let Some(base) = read_non_empty_env(&["AWEN_HOME"]) {
        return PathBuf::from(base);
    }

    if let Ok(mut current) = env::current_dir() {
        for _ in 0..=3 {
            let candidate = current.join(".awen");
            if candidate.exists() {
                return candidate;
            }
            if !current.pop() {
                break;
            }
        }
    }

    read_non_empty_env(&["HOME", "USERPROFILE"])
        .map(|home| PathBuf::from(home).join(".awen"))
        .unwrap_or_else(|| PathBuf::from(".awen"))
}

fn daemon_entry_candidates() -> Vec<PathBuf> {
    let manifest_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repository_root = manifest_root.join("../../..");
    let mut candidates = Vec::new();

    if let Ok(executable) = env::current_exe() {
        if let Some(parent) = executable.parent() {
            candidates.push(parent.join("runtime/dist/bin.mjs"));
            candidates.push(parent.join("../Resources/runtime/dist/bin.mjs"));
            candidates.push(parent.join("resources/awen"));
            candidates.push(parent.join("resources/server/bin.mjs"));
        }
    }
    candidates.push(repository_root.join("apps/server/src/bin.ts"));
    candidates.push(repository_root.join("apps/server/dist/bin.mjs"));
    candidates
}

struct DaemonInvocation {
    command: String,
    entry_args: Vec<String>,
    current_dir: Option<PathBuf>,
}

fn resolve_daemon_invocation() -> Result<DaemonInvocation, String> {
    if let Some(command) = read_non_empty_env(&["AWEN_DAEMON_COMMAND"]) {
        return Ok(DaemonInvocation {
            command,
            entry_args: Vec::new(),
            current_dir: None,
        });
    }

    if let Some(entry) = read_non_empty_env(&["AWEN_DAEMON_ENTRY"]) {
        return Ok(DaemonInvocation {
            command: read_non_empty_env(&["AWEN_NODE_COMMAND"]).unwrap_or_else(|| "node".into()),
            entry_args: vec![entry],
            current_dir: None,
        });
    }

    for candidate in daemon_entry_candidates() {
        if !candidate.is_file() {
            continue;
        }
        if candidate
            .extension()
            .and_then(|extension| extension.to_str())
            == Some("mjs")
        {
            let bundled_node = candidate
                .parent()
                .and_then(Path::parent)
                .map(|runtime| runtime.join(if cfg!(windows) { "node.exe" } else { "node" }));
            return Ok(DaemonInvocation {
                command: read_non_empty_env(&["AWEN_NODE_COMMAND"])
                    .or_else(|| {
                        bundled_node
                            .filter(|path| path.is_file())
                            .map(|path| path.to_string_lossy().into_owned())
                    })
                    .unwrap_or_else(|| "node".into()),
                entry_args: vec![candidate.to_string_lossy().into_owned()],
                current_dir: candidate.parent().map(Path::to_path_buf),
            });
        }
        return Ok(DaemonInvocation {
            command: read_non_empty_env(&["AWEN_NODE_COMMAND"]).unwrap_or_else(|| "node".into()),
            entry_args: vec![candidate.to_string_lossy().into_owned()],
            current_dir: candidate
                .parent()
                .and_then(Path::parent)
                .and_then(Path::parent)
                .and_then(Path::parent)
                .map(Path::to_path_buf),
        });
    }

    Err("The Awen local daemon launcher is unavailable. Configure AWEN_DAEMON_COMMAND or AWEN_DAEMON_ENTRY.".into())
}

fn invoke_local_daemon(action: &str, base_dir: &Path, confirm: bool) -> Result<Value, String> {
    let invocation = resolve_daemon_invocation()?;
    let mut args = invocation.entry_args;
    args.extend([
        "daemon".into(),
        action.into(),
        "--json".into(),
        "--base-dir".into(),
        base_dir.to_string_lossy().into_owned(),
    ]);
    if confirm {
        args.push("--confirm".into());
    }

    let mut command = Command::new(invocation.command);
    command.args(args);
    if let Some(current_dir) = invocation.current_dir {
        command.current_dir(current_dir);
    }
    let output = command
        .output()
        .map_err(|_| "Could not start the Awen local daemon launcher.".to_owned())?;

    // The launcher reports a failed operation as
    // `{"ok":false,"error":{code,message}}` on stdout *and* exits non-zero.
    // Reading that payload instead of replacing it with a generic sentence is
    // what keeps a failed daemon launch diagnosable: the code names the
    // mechanism (`launch-lock-timeout`, `daemon-port-unavailable`, ...), and
    // the message carries the operator's next step. Losing it turned every
    // launch failure into an unexplained dead proxy port in the web client.
    if let Ok(value) = serde_json::from_slice::<Value>(&output.stdout) {
        if value.get("ok").and_then(Value::as_bool) == Some(false) {
            return Err(describe_daemon_launcher_failure(&value));
        }
        if output.status.success() {
            return Ok(value);
        }
    }

    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(if detail.is_empty() {
            "The Awen local daemon launcher failed.".to_owned()
        } else {
            format!("The Awen local daemon launcher failed: {detail}")
        });
    }

    Err("The Awen local daemon launcher returned an invalid response.".to_owned())
}

fn describe_daemon_launcher_failure(value: &Value) -> String {
    let error = value.get("error").and_then(Value::as_object);
    let code = error
        .and_then(|error| error.get("code"))
        .and_then(Value::as_str)
        .unwrap_or("daemon-launch-failed");
    let message = error
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("The local daemon launcher rejected the request.");
    format!("The Awen local daemon launcher failed ({code}): {message}")
}

fn normalize_local_origin(raw: &str, expected_schemes: &[&str]) -> Result<String, String> {
    let mut url = Url::parse(raw).map_err(|error| format!("Invalid daemon URL: {error}"))?;
    if !expected_schemes.contains(&url.scheme()) {
        return Err(format!("Unsupported daemon URL scheme: {}", url.scheme()));
    }
    if url.username() != "" || url.password().is_some() {
        return Err("Daemon URLs cannot contain credentials.".to_owned());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Daemon URL must include a host.".to_owned())?;
    let is_loopback = matches!(host, "localhost" | "127.0.0.1" | "::1");
    if !is_loopback {
        return Err(format!(
            "The Tauri shell only accepts loopback daemons; got {host}."
        ));
    }
    url.set_path("");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string())
}

fn websocket_origin_from_http(http_origin: &str) -> Result<String, String> {
    let mut url = Url::parse(http_origin).map_err(|error| error.to_string())?;
    let scheme = match url.scheme() {
        "http" => "ws",
        "https" => "wss",
        other => return Err(format!("Cannot derive a WebSocket URL from {other}.")),
    };
    url.set_scheme(scheme)
        .map_err(|_| "Unable to set the WebSocket URL scheme.".to_owned())?;
    Ok(url.to_string())
}

fn http_origin_from_websocket(ws_origin: &str) -> Result<String, String> {
    let mut url = Url::parse(ws_origin).map_err(|error| error.to_string())?;
    let scheme = match url.scheme() {
        "ws" => "http",
        "wss" => "https",
        other => return Err(format!("Cannot derive an HTTP URL from {other}.")),
    };
    url.set_scheme(scheme)
        .map_err(|_| "Unable to set the HTTP URL scheme.".to_owned())?;
    Ok(url.to_string())
}

fn resolve_daemon_origins(
    runtime: Option<&PersistedRuntime>,
) -> Result<Option<(String, String)>, String> {
    let explicit_http = read_non_empty_env(&["AWEN_DESKTOP_HTTP_URL"]);
    let explicit_ws = read_non_empty_env(&["AWEN_DESKTOP_WS_URL"]);

    let http_raw = explicit_http.or_else(|| runtime.map(|runtime| runtime.state.origin.clone()));
    let ws_raw = explicit_ws;
    if http_raw.is_none() && ws_raw.is_none() {
        return Ok(None);
    }

    let http_origin = match http_raw {
        Some(raw) => normalize_local_origin(&raw, &["http", "https"])?,
        None => {
            let raw = ws_raw
                .as_deref()
                .ok_or_else(|| "Missing the daemon HTTP URL.".to_owned())?;
            let derived = http_origin_from_websocket(raw)?;
            normalize_local_origin(&derived, &["http", "https"])?
        }
    };
    let ws_origin = match ws_raw {
        Some(raw) => normalize_local_origin(&raw, &["ws", "wss"])?,
        None => websocket_origin_from_http(&http_origin)?,
    };

    Ok(Some((http_origin, ws_origin)))
}

fn read_local_bootstrap_token(
    runtime: Option<&PersistedRuntime>,
) -> Result<Option<String>, String> {
    if let Some(token) = read_non_empty_env(&[
        "AWEN_DESKTOP_BOOTSTRAP_TOKEN",
        "AWEN_DESKTOP_BOOTSTRAP_TOKEN",
    ]) {
        return Ok(Some(token));
    }
    let Some(runtime) = runtime else {
        return Ok(None);
    };
    let Some(state_dir) = runtime.path.parent() else {
        return Ok(None);
    };
    let credential_path = state_dir.join("secrets/desktop-bootstrap.token");
    match fs::read_to_string(&credential_path) {
        Ok(contents) => {
            let token = contents.trim().to_owned();
            Ok((!token.is_empty()).then_some(token))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "Unable to read the local daemon credential at {}: {error}",
            credential_path.display()
        )),
    }
}

fn require_managed_runtime(runtime: Option<&PersistedRuntime>) -> Result<(), String> {
    let Some(runtime) = runtime else {
        return Err("The local daemon did not publish a runtime descriptor.".to_owned());
    };
    let state = &runtime.state;
    if !state.daemon_managed
        || state.daemon_id.as_deref().unwrap_or_default().is_empty()
        || state.daemon_protocol_version != Some(LOCAL_DAEMON_PROTOCOL_VERSION)
    {
        return Err(
            "The local runtime descriptor is not an Awen-managed daemon; refusing to connect."
                .to_owned(),
        );
    }
    Ok(())
}

fn client_platform() -> String {
    #[cfg(target_os = "macos")]
    return "darwin".to_owned();
    #[cfg(target_os = "windows")]
    return "win32".to_owned();
    #[cfg(target_os = "linux")]
    return "linux".to_owned();
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    return "other".to_owned();
}

#[tauri::command]
fn read_desktop_runtime_config() -> Result<DesktopRuntimeConfig, String> {
    let explicit_endpoint = read_non_empty_env(&[
        "AWEN_DESKTOP_HTTP_URL",
        "AWEN_DESKTOP_HTTP_URL",
        "AWEN_DESKTOP_WS_URL",
        "AWEN_DESKTOP_WS_URL",
    ])
    .is_some();
    let base_dir = local_daemon_base_dir();
    if !explicit_endpoint {
        invoke_local_daemon("start", &base_dir, false)?;
    }
    let runtime = read_runtime_state()?;
    if !explicit_endpoint {
        require_managed_runtime(runtime.as_ref())?;
    }
    let origins = resolve_daemon_origins(runtime.as_ref())?;
    let bearer_token = read_non_empty_env(&["AWEN_DESKTOP_BEARER_TOKEN"]);
    let bootstrap_token = if bearer_token.is_none() {
        read_local_bootstrap_token(runtime.as_ref())?
    } else {
        None
    };

    let bootstraps = origins
        .map(|(http_base_url, ws_base_url)| {
            vec![DesktopEnvironmentBootstrap {
                id: PRIMARY_LOCAL_ENVIRONMENT_ID.to_owned(),
                label: read_non_empty_env(&["AWEN_DESKTOP_LABEL"])
                    .unwrap_or_else(|| DEFAULT_ENVIRONMENT_LABEL.to_owned()),
                http_base_url: Some(http_base_url),
                ws_base_url: Some(ws_base_url),
                bootstrap_token,
            }]
        })
        .unwrap_or_default();

    Ok(DesktopRuntimeConfig {
        bootstraps,
        bearer_token,
        client_platform: client_platform(),
    })
}

#[tauri::command]
fn stop_desktop_daemon(confirm: bool) -> Result<Value, String> {
    invoke_local_daemon("stop", &local_daemon_base_dir(), confirm)
}

fn allow_app_navigation(url: &Url) -> bool {
    if (url.scheme() == "http" || url.scheme() == "https")
        && url.host_str() == Some("tauri.localhost")
    {
        return true;
    }
    if url.scheme() == "tauri" && url.host_str() == Some("localhost") {
        return true;
    }

    cfg!(debug_assertions)
        && (url.scheme() == "http" || url.scheme() == "https")
        && url.host_str() == Some("localhost")
}

fn navigation_guard<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::new("awen-navigation-guard")
        .on_navigation(|_, url| allow_app_navigation(url))
        .build()
}

#[tauri::command]
fn set_window_glass_enabled(window: tauri::WebviewWindow, enabled: bool) {
    #[cfg(target_os = "macos")]
    {
        if enabled {
            let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 3)));
            macos::enable_glass(&window);
        } else {
            macos::disable_glass(&window);
        }
    }
    #[cfg(target_os = "windows")]
    {
        if enabled {
            let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
            let _ = window.set_effects(
                tauri::window::EffectsBuilder::new()
                    .effect(tauri::window::Effect::Acrylic)
                    .build(),
            );
        } else {
            let _ = window.set_effects(None);
            let _ = window.set_background_color(Some(tauri::window::Color(24, 24, 27, 255)));
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (window, enabled);
    }
}

#[tauri::command]
fn set_window_background_blur(window: tauri::WebviewWindow, radius: u8) {
    #[cfg(target_os = "macos")]
    macos::set_background_blur_radius(&window, radius);
    #[cfg(not(target_os = "macos"))]
    let _ = (window, radius);
}

pub fn run() {
    #[cfg(all(debug_assertions, feature = "browser-host-proof"))]
    let commands = tauri::generate_handler![
        read_desktop_runtime_config,
        stop_desktop_daemon,
        set_window_glass_enabled,
        set_window_background_blur,
        browser_host_proof::open,
        browser_host_proof::navigate,
        browser_host_proof::evaluate,
        browser_host_proof::geometry,
        browser_host_proof::close
    ];
    #[cfg(not(all(debug_assertions, feature = "browser-host-proof")))]
    let commands = tauri::generate_handler![
        read_desktop_runtime_config,
        stop_desktop_daemon,
        set_window_glass_enabled,
        set_window_background_blur
    ];
    tauri::Builder::default()
        .plugin(navigation_guard())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            #[cfg(all(debug_assertions, feature = "browser-host-proof"))]
            browser_host_proof::start(app)?;
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    macos::install(&window);
                }
            }
            // Wayland otherwise falls back to GTK client-side decorations, which duplicate the
            // Awen topbar while XWayland uses KWin's server-side titlebar.
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_decorations(false);
                }
            }
            let _ = app;
            Ok(())
        })
        .invoke_handler(commands)
        .run(tauri::generate_context!())
        .expect("error while running Awen desktop");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_loopback_http_origins_and_drops_paths() {
        assert_eq!(
            normalize_local_origin("http://localhost:13773/api?debug=1", &["http"])
                .expect("valid loopback origin"),
            "http://localhost:13773/"
        );
    }

    #[test]
    fn rejects_non_loopback_daemons() {
        let error = normalize_local_origin("http://example.test:13773", &["http"])
            .expect_err("remote origin must not be accepted by this shell");
        assert!(error.contains("loopback"));
    }

    #[test]
    fn derives_websocket_origin_from_http_origin() {
        assert_eq!(
            websocket_origin_from_http("http://127.0.0.1:3773/").expect("valid HTTP origin"),
            "ws://127.0.0.1:3773/"
        );
    }

    #[test]
    fn keeps_the_launcher_failure_code_and_message() {
        let value: Value = serde_json::from_str(
            r#"{"ok":false,"error":{"code":"launch-lock-timeout","message":"Another local daemon operation did not finish before the launch lock expired."}}"#,
        )
        .expect("launcher failure envelope");
        let message = describe_daemon_launcher_failure(&value);
        assert!(message.contains("launch-lock-timeout"), "{message}");
        assert!(message.contains("launch lock expired"), "{message}");
    }

    #[test]
    fn describes_a_launcher_failure_without_an_error_payload() {
        let value: Value = serde_json::from_str(r#"{"ok":false}"#).expect("empty failure");
        assert_eq!(
            describe_daemon_launcher_failure(&value),
            "The Awen local daemon launcher failed (daemon-launch-failed): The local daemon launcher rejected the request."
        );
    }

    #[test]
    fn navigation_guard_only_allows_app_and_debug_localhost_origins() {
        assert!(allow_app_navigation(
            &Url::parse("http://tauri.localhost/").expect("app origin")
        ));
        assert!(!allow_app_navigation(
            &Url::parse("https://example.test/").expect("external origin")
        ));
    }
}
