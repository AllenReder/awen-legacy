//! Disposable native browser-host proof for #158. This is deliberately outside
//! the daemon/provider/preview protocol and is compiled only for debug builds
//! with `browser-host-proof` enabled.

use serde::Serialize;
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Url, WebviewBuilder, WebviewUrl};

fn proof_url(path: &str) -> Result<Url, String> {
    let origin = std::env::var("AWEN_PROOF_WEB_ORIGIN")
        .map_err(|_| "AWEN_PROOF_WEB_ORIGIN is missing; use the desktop dev runner".to_string())?;
    checked_url(&format!("{origin}/{path}"))
}

fn label(tab: &str) -> Result<&'static str, String> {
    match tab {
        "a" => Ok("browser-proof-a"),
        "b" => Ok("browser-proof-b"),
        _ => Err("The proof has only tabs a and b".into()),
    }
}

fn checked_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|error| error.to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Only HTTP(S) pages can be opened in this proof".into());
    }
    Ok(url)
}

fn webview(app: &AppHandle, tab: &str) -> Result<tauri::Webview, String> {
    app.get_webview(label(tab)?)
        .ok_or_else(|| format!("Tab {tab} is closed"))
}

pub fn start(app: &mut tauri::App) -> tauri::Result<()> {
    if std::env::var_os("AWEN_BROWSER_HOST_PROOF").is_none() {
        return Ok(());
    }
    if let Some(main) = app.get_webview_window("main") {
        // The controller must retain the bundled app origin so its Tauri
        // commands pass the normal capability check in a registered .app.
        let mut url = main.url()?.join("browser-host-proof.html")?;
        let guest_page = proof_url("browser-host-proof-page.html")
            .map_err(|error| tauri::Error::Anyhow(std::io::Error::other(error).into()))?;
        url.query_pairs_mut()
            .append_pair("guestPage", guest_page.as_str());
        main.navigate(url)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn open(app: AppHandle, tab: String) -> Result<String, String> {
    let tab_label = label(&tab)?;
    if app.get_webview(tab_label).is_some() {
        return Err(format!("Tab {tab} is already open"));
    }
    let window = app
        .get_window("main")
        .ok_or_else(|| "Main window is unavailable".to_string())?;
    let url = proof_url("browser-host-proof-page.html")?;
    let mut builder = WebviewBuilder::new(tab_label, WebviewUrl::External(url));
    #[cfg(target_os = "macos")]
    {
        // WKWebView ignores data_directory. Separate persistent stores require
        // macOS 14+; the runtime demonstration must confirm the actual result.
        builder = builder.data_store_identifier(if tab == "a" { [0xA1; 16] } else { [0xB2; 16] });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let base = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        builder = builder.data_directory(base.join(format!("browser-proof-{tab}")));
    }
    let x = if tab == "a" { 350.0 } else { 810.0 };
    window
        .add_child(
            builder,
            LogicalPosition::new(x, 90.0),
            LogicalSize::new(430.0, 510.0),
        )
        .map_err(|error| error.to_string())?;
    Ok(tab_label.into())
}

#[tauri::command]
pub async fn navigate(app: AppHandle, tab: String, url: String) -> Result<(), String> {
    webview(&app, &tab)?
        .navigate(checked_url(&url)?)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn evaluate(app: AppHandle, tab: String, script: String) -> Result<Value, String> {
    let guest = webview(&app, &tab)?;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    // eval_with_callback observes the exact native guest displayed in the
    // child slot. A production adapter must add request IDs and cancellation.
    guest
        .eval_with_callback(script, move |result| {
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    let result =
        tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(5)))
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| error.to_string())?;
    serde_json::from_str(&result).map_err(|error| error.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeometryResult {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    zoom: f64,
    measured_x: f64,
    measured_y: f64,
    measured_width: f64,
    measured_height: f64,
}

#[tauri::command]
pub async fn geometry(
    app: AppHandle,
    tab: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    zoom: f64,
) -> Result<GeometryResult, String> {
    if ![x, y, width, height, zoom]
        .iter()
        .all(|value| value.is_finite())
        || x < 0.0
        || y < 0.0
        || width < 100.0
        || height < 100.0
        || !(0.5..=2.0).contains(&zoom)
    {
        return Err("Invalid geometry or zoom".into());
    }
    let guest = webview(&app, &tab)?;
    guest
        .set_position(LogicalPosition::new(x, y))
        .map_err(|error| error.to_string())?;
    guest
        .set_size(LogicalSize::new(width, height))
        .map_err(|error| error.to_string())?;
    guest.set_zoom(zoom).map_err(|error| error.to_string())?;
    guest.set_focus().map_err(|error| error.to_string())?;
    let position = guest.position().map_err(|error| error.to_string())?;
    let size = guest.size().map_err(|error| error.to_string())?;
    let scale = app
        .get_window("main")
        .ok_or_else(|| "Main window is unavailable".to_string())?
        .scale_factor()
        .map_err(|error| error.to_string())?;
    Ok(GeometryResult {
        x,
        y,
        width,
        height,
        zoom,
        measured_x: f64::from(position.x) / scale,
        measured_y: f64::from(position.y) / scale,
        measured_width: f64::from(size.width) / scale,
        measured_height: f64::from(size.height) / scale,
    })
}

#[tauri::command]
pub async fn close(app: AppHandle, tab: String) -> Result<(), String> {
    webview(&app, &tab)?
        .close()
        .map_err(|error| error.to_string())
}
