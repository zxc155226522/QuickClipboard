pub mod chunk_manager;
pub mod cloud_files;
pub mod crypto;
pub mod downloader;
pub mod groups_sync;
pub mod index_manager;
pub mod local_state;
pub mod sync_scheduler;
pub mod tombstones_sync;
pub mod types;
pub mod uploader;
pub mod webdav_client;

pub use types::{SyncReport, WebdavStatus};

use types::WebdavConfig;
use webdav_client::WebdavClient;
use crate::services::settings::AppSettings;

pub async fn test_connection() -> Result<(), String> {
    let client = build_client().await?;
    client.test_connection().await
}

pub async fn upload_settings() -> Result<(), String> {
    let client = build_client().await?;
    let _ = client.mkcol("").await; // 确保根目录存在
    let settings = crate::services::get_settings();
    let settings_json = serde_json::to_value(&settings)
        .map_err(|e| format!("序列化配置失败: {}", e))?;
    client.put_json("settings.json", &settings_json).await?;
    Ok(())
}

pub async fn download_settings() -> Result<(), String> {
    let client = build_client().await?;
    let remote_settings: serde_json::Value = client.get_json("settings.json")
        .await?
        .ok_or_else(|| "云端暂无配置文件".to_string())?;
    // 用远程配置覆盖本地配置（排除 webdav 相关字段以保持当前连接配置）
    let mut local_settings = crate::services::get_settings();
    let remote_obj = remote_settings.as_object()
        .ok_or_else(|| "云端配置格式无效".to_string())?;
    let local_json = serde_json::to_value(&local_settings)
        .map_err(|e| format!("序列化本地配置失败: {}", e))?;
    let local_obj = local_json.as_object()
        .ok_or_else(|| "本地配置格式无效".to_string())?;
    // 保留的 webdav 相关字段（不覆盖）
    let preserve_keys = [
        "webdavEnabled", "webdavUrl", "webdavUsername", "webdavRootPath",
        "webdavSyncClipboard", "webdavSyncFavorites", "webdavSyncImages",
        "webdavAutoPullOnWindowShow", "webdavAutoPush", "webdavPushDelaySecs",
        "webdavAutoPull", "webdavPullIntervalSecs",
    ];
    let preserve_set: std::collections::HashSet<&str> = preserve_keys.iter().copied().collect();
    let mut merged = remote_obj.clone();
    for key in local_obj.keys() {
        if preserve_set.contains(key.as_str()) {
            merged.insert(key.clone(), local_obj[key].clone());
        }
    }
    let merged_settings: AppSettings = serde_json::from_value(serde_json::Value::Object(merged))
        .map_err(|e| format!("解析合并后的配置失败: {}", e))?;
    crate::services::settings::update_settings(merged_settings)?;
    Ok(())
}

pub async fn upload() -> Result<SyncReport, String> {
    let report = sync_scheduler::upload_selected_parts(false)
        .await?
        .unwrap_or_default();
    Ok(sync_scheduler::store_manual_report("push", report))
}

pub(super) async fn download_raw(force_download: bool) -> Result<SyncReport, String> {
    let client = build_client().await?;
    let device_id = crate::services::sync_transfer::device_id();
    downloader::download_all(&client, &device_id, force_download).await
}

pub async fn download(force_download: bool) -> Result<SyncReport, String> {
    let report = download_raw(force_download).await?;
    Ok(sync_scheduler::store_manual_report("pull", report))
}

pub async fn upload_parts(
    upload_clipboard: bool,
    upload_favorites: bool,
    upload_groups: bool,
    upload_tombstones: bool,
) -> Result<SyncReport, String> {
    let client = build_client().await?;
    let device_id = crate::services::sync_transfer::device_id();
    uploader::upload_parts(
        &client,
        &device_id,
        upload_clipboard,
        upload_favorites,
        upload_groups,
        upload_tombstones,
    ).await
}

pub async fn upload_cloud_files_with_progress(
    requests: Vec<cloud_files::CloudFileUploadRequest>,
) -> Result<Vec<cloud_files::CloudFileUploadBatchItem>, String> {
    let client = build_client().await?;
    cloud_files::upload_files_with_progress(&client, requests).await
}

pub async fn list_cloud_files() -> Result<Vec<cloud_files::CloudFileListItem>, String> {
    let client = build_client().await?;
    cloud_files::list_files(&client).await
}

pub async fn download_cloud_file(file_id: &str) -> Result<cloud_files::CloudFileDownloadResult, String> {
    let client = build_client().await?;
    cloud_files::download_file(&client, file_id).await
}

pub async fn delete_cloud_file(file_id: &str) -> Result<(), String> {
    let client = build_client().await?;
    cloud_files::delete_file(&client, file_id).await
}

pub fn status() -> WebdavStatus {
    sync_scheduler::status()
}

pub fn start_scheduler() {
    sync_scheduler::start();
}

pub fn stop_scheduler() {
    sync_scheduler::stop();
}

pub fn notify_local_change(app: tauri::AppHandle, reason: &'static str) {
    sync_scheduler::notify_local_change(app, reason);
}

pub fn notify_main_window_shown(app: tauri::AppHandle) {
    sync_scheduler::notify_main_window_shown(app);
}

async fn build_client() -> Result<WebdavClient, String> {
    let settings = crate::services::get_settings();
    let webdav_url = settings.webdav_url.trim().to_string();
    let webdav_username = settings.webdav_username.trim().to_string();
    let webdav_root_path = if settings.webdav_root_path.trim().is_empty() {
        "quickclipboard".to_string()
    } else {
        settings.webdav_root_path.clone()
    };
    let password = if settings.webdav_username.trim().is_empty() {
        String::new()
    } else {
        crate::services::secure_credentials::get_webdav_password(
            &webdav_url,
            &webdav_username,
        )?
        .unwrap_or_default() // 允许空密码，未保存则默认空字符串
    };
    let encryption_password = crate::services::secure_credentials::get_webdav_encryption_password(
        &webdav_url,
        &webdav_username,
        &webdav_root_path,
    )?;
    let config = WebdavConfig {
        url: webdav_url,
        username: webdav_username,
        password,
        root_path: webdav_root_path,
    };
    let mut client = WebdavClient::new(config)?;
    if let Some(ref ep) = encryption_password {
        client.enable_encryption(ep).await?;
    }
    Ok(client)
}
